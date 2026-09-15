import { BrowserWindow, session, WebContentsView, type Session, type WebContents } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserCandidate, BrowserEvidence, BrowserSnapshot } from '../../shared/browser'
import {
  BrowserQueryError,
  isOnebox,
  isVerificationPage,
  officialUrl,
  parseCandidates,
  requestKeyword
} from './protocol'

interface TrackedRequest {
  keyword: string
  status: number
  signed: boolean
  query: PendingQuery
}
interface NetworkEvent {
  requestId: string
  request?: { url: string; postData?: string; headers?: Record<string, string> }
  response?: { status: number }
}
interface PendingQuery {
  keyword: string
  resolve: (candidates: BrowserCandidate[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class XhsBrowserService {
  readonly session: Session
  readonly foreground: WebContentsView
  readonly worker: WebContentsView
  private readonly requests = new Map<string, TrackedRequest>()
  private pending: PendingQuery | null = null
  private showingWorker = false
  private visible = true
  private hiddenMute = false
  private hidden = false
  private cookieTimer: ReturnType<typeof setInterval>
  private disposed = false
  private verificationRequired = false
  private lastSessionValue = ''
  private logQueue: Promise<void> = Promise.resolve()
  private state: BrowserSnapshot = {
    cookieAvailable: false,
    signedRequestObserved: false,
    queryRunning: false,
    foregroundUrl: '',
    candidates: [],
    evidence: []
  }

  constructor(
    private readonly window: BrowserWindow,
    private readonly logPath: string,
    private readonly changed: (snapshot: BrowserSnapshot) => void
  ) {
    this.session = session.fromPartition('persist:xhs-account')
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.session.setPermissionCheckHandler(() => false)
    const create = (): WebContentsView =>
      new WebContentsView({
        webPreferences: {
          session: this.session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          webSecurity: true
        }
      })
    this.foreground = create()
    this.worker = create()
    this.worker.webContents.setAudioMuted(true)
    this.secure(this.foreground.webContents)
    this.secure(this.worker.webContents)
    window.contentView.addChildView(this.foreground)
    window.contentView.addChildView(this.worker)
    this.worker.setVisible(false)
    this.foreground.webContents.on('did-navigate', () => this.foregroundNavigated())
    this.foreground.webContents.on('did-navigate-in-page', () => this.foregroundNavigated())
    const inspectVerification = (): void => {
      const required = isVerificationPage(this.worker.webContents.getURL())
      if (required) {
        if (!this.verificationRequired || this.pending)
          this.fail(
            '小红书要求账号安全验证，请打开后台查询页，用已登录的小红书 APP 扫码验证身份',
            'AUTH'
          )
        this.verificationRequired = true
      } else if (this.verificationRequired) {
        this.verificationRequired = false
        this.state.authVersion = (this.state.authVersion ?? 0) + 1
        this.record('session', '后台已离开账号验证页，将重新检查授权状态')
      }
    }
    this.worker.webContents.on('did-navigate', inspectVerification)
    this.worker.webContents.on('did-navigate-in-page', inspectVerification)
    this.worker.webContents.on('render-process-gone', () =>
      this.fail('后台网页进程已退出，请重启应用')
    )
    this.worker.webContents.debugger.attach('1.3')
    this.worker.webContents.debugger.on('message', (_event, method, params) => {
      const query = this.pending
      void this.networkEvent(method, params).catch((error: unknown) => {
        if (query === this.pending)
          this.fail(
            error instanceof BrowserQueryError ? error.message : '无法读取网站响应，请重试查询',
            error instanceof BrowserQueryError ? error.kind : 'SCHEMA'
          )
      })
    })
    this.worker.webContents.debugger.on('detach', () => {
      if (!this.disposed) this.fail('后台请求观察已断开，请重启应用')
    })
    this.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox*'] },
      (details, callback) => {
        // Inspect the presence of current credentials. Never persist or replay their values.
        const signed = Object.entries(details.requestHeaders).some(
          ([key, value]) => key.toLowerCase() === 'x-s' && Boolean(value)
        )
        if (signed && !this.state.signedRequestObserved) {
          this.state.signedRequestObserved = true
          this.record('session', '已观察到网站生成的签名请求（签名内容不保存）')
        }
        callback({ requestHeaders: details.requestHeaders })
      }
    )
    this.cookieTimer = setInterval(() => {
      void this.refreshCookies()
    }, 5000)
    this.cookieTimer.unref()
  }

  async initialize(): Promise<void> {
    await this.worker.webContents.loadURL('about:blank')
    await this.worker.webContents.debugger.sendCommand('Network.enable', {
      maxResourceBufferSize: 4 * 1024 * 1024,
      maxTotalBufferSize: 8 * 1024 * 1024
    })
    await this.refreshCookies()
    this.record('ready', '独立观看页与后台查询页已创建，共享持久化登录会话')
    await this.open('https://www.xiaohongshu.com/explore')
  }

  snapshot(): BrowserSnapshot {
    return structuredClone(this.state)
  }

  async open(url: string): Promise<void> {
    await this.foreground.webContents.loadURL(officialUrl(url))
    this.showQueryPage(false)
  }

  showQueryPage(show: boolean): void {
    this.showingWorker = show
    this.worker.setVisible(this.visible && show)
    this.foreground.setVisible(this.visible && !show)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.foreground.setVisible(visible && !this.showingWorker)
    this.worker.setVisible(visible && this.showingWorker)
  }

  async currentProfile(): Promise<{ keyWord: string; userId: string | null; name: string }> {
    const url = this.foreground.webContents.getURL()
    officialUrl(url)
    const userId = new URL(url).pathname.match(/^\/user\/profile\/([a-zA-Z0-9]+)\/?$/)?.[1] ?? null
    if (!userId) throw new Error('请先在网页中打开需要监听的主播主页')
    const data = await this.foreground.webContents.executeJavaScript(`(() => {
      const text = document.body.innerText;
      const keyWord = text.match(/小红书号[：:\\s]+([a-zA-Z0-9_-]+)/)?.[1] || '';
      return {keyWord, name: document.querySelector('.user-name')?.textContent?.trim() || document.title.split(' - ')[0]};
    })()`)
    if (typeof data.keyWord !== 'string' || !data.keyWord)
      throw new Error('网页未显示小红书号，请手动输入后确认用户')
    return { keyWord: data.keyWord, userId, name: String(data.name ?? '') }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    const [width, height] = this.window.getContentSize()
    const x = Math.max(0, Math.min(width, Math.round(bounds.x)))
    const y = Math.max(0, Math.min(height, Math.round(bounds.y)))
    const safe = {
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(bounds.width))),
      height: Math.max(0, Math.min(height - y, Math.round(bounds.height)))
    }
    this.foreground.setBounds(safe)
    this.worker.setBounds(safe)
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) {
      this.hiddenMute = this.foreground.webContents.isAudioMuted()
      this.foreground.webContents.setAudioMuted(true)
    } else this.foreground.webContents.setAudioMuted(this.hiddenMute)
    this.record('visibility', hidden ? '主窗口已隐藏，后台查询继续，观看页静音' : '主窗口已恢复')
  }

  async search(value: string): Promise<BrowserCandidate[]> {
    const keyword = value.trim()
    if (!keyword || keyword.length > 100) throw new Error('请输入 1–100 个字符的小红书号或用户名')
    if (this.pending) throw new Error('正在查询，请等待当前查询完成')
    if (isVerificationPage(this.worker.webContents.getURL()))
      throw new BrowserQueryError(
        '小红书要求账号安全验证，请打开后台查询页，用已登录的小红书 APP 扫码验证身份',
        'AUTH'
      )
    this.requests.clear()
    this.state.queryRunning = true
    this.record('query', `后台查询：${keyword}`)
    const completion = new Promise<BrowserCandidate[]>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail('等待网站搜索响应超时，请查看后台查询页是否需要登录或验证'),
        45000
      )
      this.pending = { keyword, resolve, reject, timer }
    })
    // A navigation invokes the site's real search flow; no fabricated signatures or raw API replay.
    const searchUrl = `https://www.xiaohongshu.com/search_result/?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`
    const query = this.pending
    void this.worker.webContents.loadURL(searchUrl).catch(() => {
      if (query === this.pending) this.fail('后台搜索页面加载失败，请检查网络或查看后台查询页')
    })
    return completion
  }

  private async refreshCookies(): Promise<void> {
    if (this.disposed) return
    try {
      const cookies = await this.session.cookies.get({ url: 'https://www.xiaohongshu.com' })
      const available = cookies.some(
        (cookie) => cookie.name === 'web_session' && cookie.value.length > 0
      )
      const sessionValue = cookies.find((cookie) => cookie.name === 'web_session')?.value ?? ''
      if (sessionValue !== this.lastSessionValue) {
        this.lastSessionValue = sessionValue
        this.state.authVersion = (this.state.authVersion ?? 0) + 1
        this.changed(this.snapshot())
      }
      if (available !== this.state.cookieAvailable) {
        this.state.cookieAvailable = available
        this.record(
          'session',
          available
            ? '浏览器会话 Cookie 已存在；有效登录仍需真实查询确认'
            : '未检测到登录会话，请在网页内登录'
        )
      }
    } catch {
      /* A closing session cannot be queried. */
    }
  }

  private secure(contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        void contents.loadURL(officialUrl(url)).catch(() => undefined)
      } catch {
        /* Reject unrelated sites and protocols. */
      }
      return { action: 'deny' }
    })
    const guard = (navigation: Electron.Event, url: string): void => {
      try {
        officialUrl(url)
      } catch {
        navigation.preventDefault()
      }
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-attach-webview', (event) => event.preventDefault())
  }

  private foregroundNavigated(): void {
    this.state.foregroundUrl = this.foreground.webContents.getURL()
    this.changed(this.snapshot())
  }

  // CDP is scoped to the worker WebContents. Bodies never leave the main process.
  private async networkEvent(method: string, params: NetworkEvent): Promise<void> {
    if (
      method === 'Network.requestWillBeSent' &&
      params.request &&
      isOnebox(params.request.url) &&
      this.pending
    ) {
      const keyword = requestKeyword(params.request.postData)
      if (keyword !== this.pending.keyword) return
      const signed = Object.keys(params.request.headers ?? {}).some(
        (key) => key.toLowerCase() === 'x-s'
      )
      this.requests.set(params.requestId, { keyword, status: 0, signed, query: this.pending })
    }
    const tracked = this.requests.get(params.requestId)
    if (!tracked) return
    if (tracked.query !== this.pending) return
    if (method === 'Network.responseReceived' && params.response)
      tracked.status = params.response.status
    if (method === 'Network.loadingFailed') {
      this.requests.delete(params.requestId)
      this.fail('网站搜索请求未完成，请检查登录和网络')
    }
    if (method !== 'Network.loadingFinished') return
    this.requests.delete(params.requestId)
    const pending = this.pending
    if (!pending || pending.keyword !== tracked.keyword) return
    if (tracked.status !== 200) {
      this.fail(
        `网站搜索返回 HTTP ${tracked.status}，请查看后台查询页`,
        tracked.status === 461
          ? 'RESTRICTED'
          : tracked.status === 429
            ? 'RATE_LIMITED'
            : [401, 403, 406].includes(tracked.status)
              ? 'AUTH'
              : 'NETWORK'
      )
      return
    }
    const response = await this.worker.webContents.debugger.sendCommand('Network.getResponseBody', {
      requestId: params.requestId
    })
    if (this.pending !== pending) return
    const body = response.base64Encoded
      ? Buffer.from(response.body, 'base64').toString('utf8')
      : response.body
    const candidates = parseCandidates(JSON.parse(body), tracked.keyword)
    clearTimeout(pending.timer)
    this.pending = null
    this.state.queryRunning = false
    this.state.candidates = candidates
    this.record(
      'response',
      `真实查询完成：${tracked.keyword}；${candidates.length} 个用户结果；窗口${this.hidden ? '隐藏' : '可见'}`
    )
    pending.resolve(candidates)
  }

  private fail(message: string, kind: BrowserQueryError['kind'] = 'NETWORK'): void {
    const pending = this.pending
    if (pending) clearTimeout(pending.timer)
    this.pending = null
    this.state.queryRunning = false
    this.record('error', message)
    pending?.reject(new BrowserQueryError(message, kind))
  }

  private record(kind: BrowserEvidence['kind'], message: string): void {
    const evidence = { at: new Date().toISOString(), kind, message }
    this.state.evidence = [...this.state.evidence.slice(-79), evidence]
    this.logQueue = this.logQueue
      .then(async () => {
        await mkdir(dirname(this.logPath), { recursive: true })
        await appendFile(
          this.logPath,
          `${evidence.at} [${kind}] ${message.replace(/[\r\n]/g, ' ')}\n`,
          'utf8'
        )
      })
      .catch(() => undefined)
    if (!this.disposed) this.changed(this.snapshot())
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.cookieTimer)
    this.fail('应用已退出')
    this.session.webRequest.onBeforeSendHeaders(null)
    this.foreground.webContents.close()
    this.worker.webContents.close()
    await this.session.cookies.flushStore()
    await this.logQueue
  }
}
