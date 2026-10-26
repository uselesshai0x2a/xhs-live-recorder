import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { EventEmitter } from 'node:events'
import type { SignedRequest } from './signer-runtime'
type FakeContents = EventEmitter & {
  url: string
  muted: boolean
  loadURL: ReturnType<typeof vi.fn>
}
type FakeView = { webContents: FakeContents; visible: boolean; bounds: unknown; options: unknown }
type FakeSession = {
  cookies: EventEmitter & {
    get: () => Promise<Partial<Electron.Cookie>[]>
    flushStore: ReturnType<typeof vi.fn>
  }
  fetch: ReturnType<typeof vi.fn>
  webRequest: unknown
  flushStorageData: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
}
const f = vi.hoisted(() => ({
  views: [] as FakeView[],
  cookies: [] as Partial<Electron.Cookie>[],
  fetch: vi.fn(),
  sign: vi.fn(),
  reset: vi.fn(),
  session: null as unknown as FakeSession
}))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), appendFile: vi.fn() }))
vi.mock('./query-transport', () => ({
  ONEBOX_API: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox',
  queryTransport: (_session: unknown, signed: SignedRequest, signal: AbortSignal) =>
    f.fetch('https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox', {
      method: 'POST',
      credentials: 'include',
      ...signed,
      signal
    })
}))
vi.mock('./signer-runtime', async (original) => ({
  ...(await original<typeof import('./signer-runtime')>()),
  SignerRuntime: class {
    constructor(
      _view: unknown,
      private changed: (s: string) => void
    ) {}
    async sign(keyword: string): Promise<SignedRequest> {
      this.changed('ready')
      return f.sign(keyword)
    }
    reset(): void {
      f.reset()
      this.changed('idle')
    }
  }
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    debugger = Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      sendCommand: vi.fn(async () => ({}))
    })
    url = 'https://www.xiaohongshu.com/explore'
    muted = false
    loadURL = vi.fn(async (url: string) => {
      this.url = url
    })
    getURL = (): string => this.url
    setAudioMuted = (value: boolean): void => {
      this.muted = value
    }
    isAudioMuted = (): boolean => this.muted
    setWindowOpenHandler = vi.fn()
    close = vi.fn()
    stop = vi.fn()
  }
  f.session = {
    cookies: Object.assign(new EventEmitter(), { get: async () => f.cookies, flushStore: vi.fn() }),
    fetch: f.fetch,
    webRequest: { onBeforeSendHeaders: vi.fn() },
    flushStorageData: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn()
  }
  return {
    session: { fromPartition: vi.fn(() => f.session) },
    WebContentsView: class {
      webContents = new Contents()
      visible = false
      bounds: unknown
      setBounds(b: unknown): void {
        this.bounds = b
      }
      setVisible(v: boolean): void {
        this.visible = v
      }
      constructor(readonly options: unknown) {
        f.views.push(this)
      }
    }
  }
})
import { XhsBrowserService } from './browser-service'
import { RecorderService } from '../recorder-service'
import type { SqliteStore } from '../store'
import { defaultSettings } from '@xhs-live-recorder/core'
let service: XhsBrowserService
beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  f.views.length = 0
  f.cookies = [{ name: 'web_session', value: 'secret-session', expirationDate: 2000000000 }]
  f.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ success: true, data: { onebox_list: [] } }), { status: 200 })
  )
  f.sign.mockImplementation(async (keyword: string) => ({
    body: JSON.stringify({ keyword }),
    headers: { 'x-s': 'secret-signature', 'x-t': '123', 'x-s-common': 'secret-common' }
  }))
  const { EventEmitter } = await import('node:events')
  const win = {
    contentView: { addChildView: vi.fn() },
    getContentSize: () => [1200, 800],
    webContents: new EventEmitter()
  }
  service = new XhsBrowserService(win as unknown as BrowserWindow, 'test/browser.log', vi.fn())
  await service.initialize()
})
afterEach(async () => {
  await service.dispose()
  vi.useRealTimers()
  f.session.cookies.removeAllListeners()
})
describe('direct browser-session queries', () => {
  it('treats the first cookie read as a baseline rather than a login change', async () => {
    expect(service.snapshot().cookieAvailable).toBe(true)
    expect(service.snapshot().authVersion).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(service.snapshot().authVersion).toBe(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each(['RESTRICTED', 'SIGNER', 'SCHEMA'])(
    'keeps persisted %s blocked on startup, then validates an actual login change once',
    async (kind) => {
      await service.dispose()
      const { EventEmitter } = await import('node:events')
      const win = {
        contentView: { addChildView: vi.fn() },
        getContentSize: () => [1200, 800],
        webContents: new EventEmitter()
      }
      service = new XhsBrowserService(win as unknown as BrowserWindow, 'test/browser.log', vi.fn())
      const store = {
        accountStatus: () => kind,
        queryIssue: () => null,
        targets: () => [{ id: 'target', keyWord: 'alice', enabled: true }],
        settings: () => defaultSettings('unused'),
        clearAccountErrors: vi.fn(),
        account: vi.fn()
      } as unknown as SqliteStore
      const coordinator = new RecorderService(store, service, 'unused', vi.fn(), vi.fn())
      coordinator.setPaused(true)
      const recording = vi.spyOn(coordinator.engine, 'start')
      vi.spyOn(coordinator.disk, 'probe').mockResolvedValue({
        directory: 'unused',
        totalBytes: 100,
        freeBytes: 100,
        level: 'ok',
        message: null
      })
      try {
        await service.initialize()
        coordinator.start()
        await vi.advanceTimersByTimeAsync(12000)
        expect(f.fetch).not.toHaveBeenCalled()
        expect(coordinator.queryBlockKind).toBe(kind)
        f.cookies[0].expirationDate = 2000000300
        f.session.cookies.emit(
          'changed',
          {},
          { name: 'web_session', domain: '.xiaohongshu.com' },
          'explicit',
          false
        )
        await vi.advanceTimersByTimeAsync(12000)
        expect(f.fetch).toHaveBeenCalledOnce()
        expect(coordinator.queryBlockKind).toBeNull()
        expect(recording).not.toHaveBeenCalled()
      } finally {
        const closing = coordinator.close()
        await vi.advanceTimersByTimeAsync(2000)
        await closing
      }
    }
  )
  it('detects cookie renewal without changing its value and retains diagnostic IDs', async () => {
    const previous = service.snapshot().authVersion
    f.cookies[0].expirationDate = 2000000300
    f.session.cookies.emit(
      'changed',
      {},
      { name: 'web_session', domain: '.xiaohongshu.com' },
      'explicit',
      false
    )
    await vi.advanceTimersByTimeAsync(400)
    expect(service.snapshot().authVersion).toBeGreaterThan(previous ?? 0)
    f.fetch.mockResolvedValue(new Response('denied', { status: 461 }))
    await service.search('alice').catch(() => {})
    const snapshot = service.snapshot()
    expect(snapshot.evidence.some((e) => e.message.includes(snapshot.lastError!.id))).toBe(true)
  })
  it('sends signed bytes with the shared session without navigating either page', async () => {
    f.views[0].webContents.loadURL.mockClear()
    await expect(service.search('alice')).resolves.toEqual([])
    expect(f.fetch).toHaveBeenCalledWith(
      'https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: '{"keyword":"alice"}'
      })
    )
    expect(f.views[0].webContents.loadURL).not.toHaveBeenCalled()
    expect(f.views[1].webContents.loadURL).not.toHaveBeenCalled()
    expect(service.snapshot().queryReady).toBe(true)
  })
  it('does not permanently gate queries on a stale hidden verification URL', async () => {
    f.views[1].webContents.url = 'https://www.xiaohongshu.com/website-login/captcha'
    f.cookies = [{ name: 'web_session', value: 'new-session' }]
    f.session.cookies.emit(
      'changed',
      {},
      { name: 'web_session', domain: '.xiaohongshu.com' },
      'explicit',
      false
    )
    await vi.advanceTimersByTimeAsync(400)
    await expect(service.search('alice')).resolves.toEqual([])
    expect(f.reset).toHaveBeenCalled()
  })
  it('rejects an in-flight response after the account changes without declaring it ready', async () => {
    let resolve!: (r: Response) => void
    f.fetch.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const result = service.search('alice')
    const rejected = expect(result).rejects.toMatchObject({ kind: 'SESSION_CHANGED' })
    await vi.advanceTimersByTimeAsync(0)
    f.session.cookies.emit(
      'changed',
      {},
      { name: 'web_session', domain: '.xiaohongshu.com' },
      'overwrite',
      true
    )
    resolve(new Response('{"success":true,"data":{"onebox_list":[]}}'))
    await rejected
    expect(service.snapshot().queryReady).toBe(false)
    expect(service.snapshot().candidates).toEqual([])
  })
  it('never marks HTTP restrictions as a successful or offline query', async () => {
    f.fetch.mockResolvedValue(new Response('denied', { status: 461 }))
    await expect(service.search('alice')).rejects.toMatchObject({
      kind: 'RESTRICTED',
      issue: { httpStatus: 461, action: 'verify' }
    })
    expect(service.snapshot().queryReady).toBe(false)
  })
  it('bounds even a transport that ignores abort and releases the query slot', async () => {
    f.fetch.mockReturnValue(new Promise(() => {}))
    const result = service.search('alice')
    const rejected = expect(result).rejects.toMatchObject({ kind: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(45001)
    await rejected
    expect(service.snapshot().queryRunning).toBe(false)
  })
  it('reinitializes the signer only once on a signature rejection', async () => {
    f.fetch.mockImplementation(
      async () => new Response('{"success":false,"msg":"invalid signature"}')
    )
    await expect(service.search('alice')).rejects.toMatchObject({ kind: 'SIGNATURE' })
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.reset).toHaveBeenCalledTimes(1)
  })
  it('does not expose credential values or search identity in diagnostics', async () => {
    await service.search('private-search')
    const state = JSON.stringify(service.snapshot())
    expect(state).not.toContain('secret-')
    expect(state).not.toContain('private-search')
    expect(service.snapshot().cookieExpiresAt).toBe(new Date(2000000000000).toISOString())
  })
  it('preserves playback mute state and query operation when hidden', async () => {
    service.setHidden(true)
    expect(f.views[0].webContents.muted).toBe(true)
    await expect(service.search('alice')).resolves.toEqual([])
    service.setHidden(false)
    expect(f.views[0].webContents.muted).toBe(false)
  })
  it('restores focus mode from remote Escape but gives video fullscreen the first Escape', () => {
    service.setFocusMode(true)
    f.views[0].webContents.emit('enter-html-full-screen')
    f.views[0].webContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      { type: 'keyDown', key: 'Escape' }
    )
    expect(service.snapshot().focusMode).toBe(true)
    f.views[0].webContents.emit('leave-html-full-screen')
    f.views[0].webContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      { type: 'keyDown', key: 'Escape' }
    )
    expect(service.snapshot().focusMode).toBe(false)
  })
  it('exits focus when leaving the browser and keeps the signing surface hidden', () => {
    service.setFocusMode(true)
    service.setVisible(false)
    expect(service.snapshot().focusMode).toBe(false)
    service.setVisible(true)
    expect(f.views[1].visible).toBe(false)
  })
})
