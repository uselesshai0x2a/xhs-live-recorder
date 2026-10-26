import { BrowserWindow, session, WebContentsView, type Session, type WebContents } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserCandidate, BrowserEvidence, BrowserSnapshot } from '../../shared/browser'
import {
  BrowserQueryError,
  isVerificationPage,
  officialUrl,
  parseCandidates,
  responseError
} from './protocol'
import { abortable, SignerRuntime } from './signer-runtime'
import { ONEBOX_API as API, queryTransport } from './query-transport'

const HOME = 'https://www.xiaohongshu.com/explore'
const credentialNames = new Set(['web_session', 'a1', 'webId'])

export class XhsBrowserService {
  readonly session: Session
  readonly foreground: WebContentsView
  private readonly signingView: WebContentsView
  private readonly signer: SignerRuntime
  private pending: AbortController | null = null
  private visible = true
  private hiddenMute = false
  private hidden = false
  private htmlFullscreen = false
  private cookieTimer: ReturnType<typeof setInterval>
  private cookieDebounce?: ReturnType<typeof setTimeout>
  private cookieRead: Promise<void> = Promise.resolve()
  private disposed = false
  private credentialVersion = 0
  private lastCredentials: string | undefined
  private verificationUrl: string | null = null
  private wasVerifying = false
  private logQueue: Promise<void> = Promise.resolve()
  private state: BrowserSnapshot = {
    authVersion: 0,
    cookieAvailable: false,
    cookieExpiresAt: null,
    queryReady: false,
    signerStatus: 'idle',
    queryRunning: false,
    foregroundUrl: '',
    candidates: [],
    evidence: [],
    lastError: null,
    focusMode: false
  }

  constructor(
    private readonly window: BrowserWindow,
    private readonly logPath: string,
    private readonly changed: (snapshot: BrowserSnapshot) => void
  ) {
    this.session = session.fromPartition('persist:xhs-account')
    this.session.setPermissionRequestHandler((contents, permission, callback) =>
      callback(contents === this.foreground?.webContents && permission === 'fullscreen')
    )
    this.session.setPermissionCheckHandler(
      (contents, permission) =>
        contents === this.foreground?.webContents && permission === 'fullscreen'
    )
    const create = (): WebContentsView =>
      new WebContentsView({
        webPreferences: {
          session: this.session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          webSecurity: true,
          disableHtmlFullscreenWindowResize: true
        }
      })
    this.foreground = create()
    this.signingView = create()
    this.signingView.webContents.setAudioMuted(true)
    this.signingView.setVisible(false)
    this.secure(this.foreground.webContents)
    this.secure(this.signingView.webContents)
    window.contentView.addChildView(this.foreground)
    // The signing WebContents is never attached to a visible window.
    this.signer = new SignerRuntime(this.signingView.webContents, (status) => {
      this.state.signerStatus = status
      if (!this.disposed) this.changed(this.snapshot())
    })
    this.foreground.webContents.on('did-navigate', () => this.foregroundNavigated())
    this.foreground.webContents.on('did-navigate-in-page', () => this.foregroundNavigated())
    this.foreground.webContents.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true
    })
    this.foreground.webContents.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false
    })
    this.foreground.webContents.on('before-input-event', this.escape)
    window.webContents.on('before-input-event', this.escape)
    this.signingView.webContents.on('render-process-gone', () => {
      this.signer.reset()
      this.pending?.abort(new BrowserQueryError('查询组件进程已退出，请修复后重试。', 'SIGNER'))
    })
    this.session.cookies.on('changed', this.cookieChanged)
    this.cookieTimer = setInterval(() => {
      void this.refreshCookies('periodic-check')
    }, 5000)
    this.cookieTimer.unref()
  }

  private escape = (event: Electron.Event, input: Electron.Input): void => {
    if (
      input.type === 'keyDown' &&
      input.key === 'Escape' &&
      this.state.focusMode &&
      !this.htmlFullscreen
    ) {
      event.preventDefault()
      this.setFocusMode(false)
    }
  }
  private cookieChanged = (
    _event: Electron.Event,
    cookie: Electron.Cookie,
    cause: string,
    removed: boolean
  ): void => {
    if (
      this.disposed ||
      !credentialNames.has(cookie.name) ||
      !/(^|\.)xiaohongshu\.com$/.test(cookie.domain ?? '')
    )
      return
    this.invalidateSession()
    if (this.cookieDebounce) clearTimeout(this.cookieDebounce)
    this.cookieDebounce = setTimeout(() => {
      void this.refreshCookies(`${cookie.name}:${cause}:${removed ? 'removed' : 'updated'}`)
    }, 300)
  }
  private invalidateSession(): void {
    this.credentialVersion++
    this.state.queryReady = false
    this.state.candidates = []
    this.signer.reset()
    this.pending?.abort(new BrowserQueryError('登录会话已更新，旧查询已取消。', 'SESSION_CHANGED'))
  }

  async initialize(): Promise<void> {
    await this.refreshCookies('startup')
    this.record('ready', '观看与接口查询共用持久化登录会话；签名环境按需初始化')
    await this.open(HOME)
  }
  snapshot(): BrowserSnapshot {
    return structuredClone(this.state)
  }
  async open(url: string): Promise<void> {
    await this.foreground.webContents.loadURL(officialUrl(url))
  }
  async openRecoveryPage(): Promise<void> {
    this.setFocusMode(false)
    await this.open(this.verificationUrl ?? HOME)
  }
  resetSigner(): void {
    this.signer.reset()
    this.state.queryReady = false
    this.changed(this.snapshot())
  }
  setFocusMode(focused: boolean): void {
    this.state.focusMode = focused && this.visible
    this.changed(this.snapshot())
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    this.foreground.setVisible(visible)
    if (!visible) this.setFocusMode(false)
  }
  async currentProfile(): Promise<{ keyWord: string; userId: string | null; name: string }> {
    const url = this.foreground.webContents.getURL()
    officialUrl(url)
    const userId = new URL(url).pathname.match(/^\/user\/profile\/([a-zA-Z0-9]+)\/?$/)?.[1] ?? null
    if (!userId) throw new Error('请先在网页中打开需要监听的主播主页')
    const data = await this.foreground.webContents.executeJavaScript(`(() => {
      const keyWord = document.body.innerText.match(/小红书号[：:\\s]+([a-zA-Z0-9_-]+)/)?.[1] || '';
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
    this.foreground.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(bounds.width))),
      height: Math.max(0, Math.min(height - y, Math.round(bounds.height)))
    })
  }
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) {
      this.hiddenMute = this.foreground.webContents.isAudioMuted()
      this.foreground.webContents.setAudioMuted(true)
    } else this.foreground.webContents.setAudioMuted(this.hiddenMute)
    this.record('visibility', hidden ? '窗口已隐藏，接口查询继续，观看页静音' : '主窗口已恢复')
  }

  async search(value: string): Promise<BrowserCandidate[]> {
    const keyword = value.trim()
    if (!keyword || keyword.length > 100) throw new Error('请输入 1–100 个字符的小红书号或用户名')
    if (this.disposed) throw new Error('应用正在退出')
    if (this.pending) throw new Error('正在查询，请等待当前查询完成')
    const controller = new AbortController()
    this.pending = controller
    const version = this.credentialVersion
    const timer = setTimeout(
      () =>
        controller.abort(new BrowserQueryError('等待接口响应超时，请检查网络后重试。', 'TIMEOUT')),
      45000
    )
    this.state.queryRunning = true
    this.record('query', '开始接口查询')
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const signed = await abortable(
            this.signer.sign(keyword, controller.signal),
            controller.signal
          )
          const response = await abortable(
            queryTransport(this.session, signed, controller.signal),
            controller.signal
          )
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            if (location) {
              try {
                const url = officialUrl(new URL(location, API).href)
                if (isVerificationPage(url)) {
                  this.verificationUrl = url
                  throw new BrowserQueryError('网站要求完成安全验证。', 'VERIFICATION', {
                    httpStatus: response.status
                  })
                }
              } catch (e) {
                if (e instanceof BrowserQueryError) throw e
              }
            }
            throw new BrowserQueryError('接口返回了未预期的跳转，已停止查询。', 'RESTRICTED', {
              httpStatus: response.status
            })
          }
          const raw = await abortable(response.text(), controller.signal)
          let payload: unknown = null
          try {
            payload = JSON.parse(raw)
          } catch {
            /* HTTP errors may be HTML. */
          }
          const failure = responseError(
            response.status,
            payload,
            response.headers.get('retry-after'),
            Date.now(),
            [keyword]
          )
          if (failure) throw failure
          const candidates = parseCandidates(payload, keyword)
          if (controller.signal.aborted) throw controller.signal.reason
          if (version !== this.credentialVersion)
            throw new BrowserQueryError('登录会话已更新，旧响应已丢弃。', 'SESSION_CHANGED')
          this.state.candidates = candidates
          this.state.queryReady = true
          this.state.lastError = null
          this.verificationUrl = null
          this.record('response', `接口查询成功：${candidates.length} 个用户结果`)
          return candidates
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason
          if (
            attempt === 0 &&
            error instanceof BrowserQueryError &&
            ['SIGNATURE', 'SIGNER'].includes(error.kind)
          ) {
            this.signer.reset()
            continue
          }
          throw error
        }
      }
      throw new BrowserQueryError('查询组件未返回结果。', 'SIGNER')
    } catch (error) {
      const failure = controller.signal.aborted
        ? controller.signal.reason
        : error instanceof BrowserQueryError
          ? error
          : new BrowserQueryError('无法连接查询接口，请检查网络或代理设置。', 'NETWORK', {
              diagnostic:
                error instanceof Error
                  ? error.message.match(/(?:net::)?ERR_[A-Z_]+/)?.[0]
                  : undefined
            })
      this.state.queryReady = false
      if (failure instanceof BrowserQueryError && failure.kind !== 'SESSION_CHANGED') {
        this.state.lastError = failure.issue
        if (
          failure.kind === 'VERIFICATION' &&
          isVerificationPage(this.signingView.webContents.getURL())
        )
          this.verificationUrl = this.signingView.webContents.getURL()
        this.record('error', `${failure.issue.id} ${failure.issue.title}：${failure.message}`)
      }
      throw failure
    } finally {
      clearTimeout(timer)
      if (this.pending === controller) this.pending = null
      this.state.queryRunning = false
      if (!this.disposed) this.changed(this.snapshot())
    }
  }

  private refreshCookies(reason: string): Promise<void> {
    this.cookieRead = this.cookieRead
      .then(async () => {
        if (this.disposed) return
        const cookies = await this.session.cookies.get({ url: 'https://www.xiaohongshu.com' })
        const token = cookies
          .filter((c) => credentialNames.has(c.name))
          .map((c) => `${c.name}:${c.domain}:${c.path}:${c.value}:${c.expirationDate ?? ''}`)
          .sort()
          .join('\n')
        const login = cookies.find((c) => c.name === 'web_session' && c.value)
        this.state.cookieAvailable = Boolean(login)
        this.state.cookieExpiresAt = login?.expirationDate
          ? new Date(login.expirationDate * 1000).toISOString()
          : null
        if (token !== this.lastCredentials) {
          if (this.lastCredentials !== undefined) this.invalidateSession()
          this.lastCredentials = token
          this.state.authVersion = (this.state.authVersion ?? 0) + 1
          this.record(
            'session',
            `会话状态变化：${reason}；Cookie ${login ? '存在' : '缺失'}；到期时间 ${this.state.cookieExpiresAt ?? '会话级或未知'}`
          )
          await this.session.cookies.flushStore()
          this.session.flushStorageData()
        }
      })
      .catch(() => {
        /* Shutdown or storage unavailability must not become an unhandled rejection. */
      })
    return this.cookieRead
  }
  private secure(contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        void contents.loadURL(officialUrl(url)).catch(() => undefined)
      } catch {
        /* Reject non-official pages. */
      }
      return { action: 'deny' }
    })
    const guard = (event: Electron.Event, url: string): void => {
      try {
        officialUrl(url)
      } catch {
        event.preventDefault()
      }
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-attach-webview', (event) => event.preventDefault())
  }
  private foregroundNavigated(): void {
    this.state.foregroundUrl = this.foreground.webContents.getURL()
    const verifying = isVerificationPage(this.state.foregroundUrl)
    if (verifying) this.verificationUrl = this.state.foregroundUrl
    else if (this.wasVerifying) {
      this.invalidateSession()
      this.state.authVersion = (this.state.authVersion ?? 0) + 1
      this.verificationUrl = null
    }
    this.wasVerifying = verifying
    this.changed(this.snapshot())
  }
  private record(kind: BrowserEvidence['kind'], message: string): void {
    // Callers supply fixed application text or an already-redacted QueryIssue.
    // Preserve the generated diagnostic UUID so the user can correlate records.
    const evidence = { at: new Date().toISOString(), kind, message }
    this.state.evidence = [...this.state.evidence.slice(-79), evidence]
    this.logQueue = this.logQueue
      .then(async () => {
        await mkdir(dirname(this.logPath), { recursive: true })
        await appendFile(this.logPath, `${evidence.at} [${kind}] ${evidence.message}\n`, 'utf8')
      })
      .catch(() => undefined)
    if (!this.disposed) this.changed(this.snapshot())
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.cookieTimer)
    clearTimeout(this.cookieDebounce)
    this.session.cookies.removeListener('changed', this.cookieChanged)
    this.window.webContents.removeListener('before-input-event', this.escape)
    this.pending?.abort(new BrowserQueryError('应用正在退出，查询已取消。', 'SESSION_CHANGED'))
    this.foreground.webContents.close()
    this.signingView.webContents.close()
    await this.cookieRead
    await this.session.cookies.flushStore()
    this.session.flushStorageData()
    await this.logQueue
  }
}
