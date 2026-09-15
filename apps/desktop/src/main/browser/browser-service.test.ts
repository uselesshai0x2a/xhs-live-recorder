import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

interface FakeView {
  options: { webPreferences: Record<string, unknown> }
  webContents: {
    getURL: Mock
    emit: EventEmitter['emit']
    debugger: EventEmitter & { sendCommand: Mock }
    loadURL: Mock
    setAudioMuted: Mock
  }
}

const fakes = vi.hoisted(() => ({
  views: [] as FakeView[],
  partition: vi.fn(),
  cookieGet: vi.fn(),
  headerHook: vi.fn()
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    debugger = Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue({ body: '{"success":true,"data":{"onebox_list":[]}}' })
    })
    loadURL = vi.fn().mockResolvedValue(undefined)
    setAudioMuted = vi.fn()
    isAudioMuted = vi.fn().mockReturnValue(false)
    setWindowOpenHandler = vi.fn()
    getURL = vi.fn().mockReturnValue('https://www.xiaohongshu.com/explore')
    close = vi.fn()
  }
  const sharedSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    cookies: { get: fakes.cookieGet, flushStore: vi.fn().mockResolvedValue(undefined) },
    webRequest: { onBeforeSendHeaders: fakes.headerHook }
  }
  fakes.partition.mockReturnValue(sharedSession)
  return {
    session: { fromPartition: fakes.partition },
    WebContentsView: class {
      webContents = new Contents()
      setVisible = vi.fn()
      setBounds = vi.fn()
      constructor(readonly options: FakeView['options']) {
        fakes.views.push(this)
      }
    }
  }
})

import { XhsBrowserService } from './browser-service'
import type { BrowserWindow } from 'electron'

let service: XhsBrowserService
beforeEach(() => {
  vi.useFakeTimers()
  fakes.views.length = 0
  fakes.cookieGet.mockResolvedValue([])
  const window = { contentView: { addChildView: vi.fn() }, getContentSize: () => [1200, 800] }
  service = new XhsBrowserService(window as unknown as BrowserWindow, 'test/browser.log', vi.fn())
})
afterEach(async () => {
  await service.dispose()
  vi.useRealTimers()
})

describe('browser query lifecycle', () => {
  it('classifies HTTP 461 as a website restriction without accepting a response body', async () => {
    const result = service.search('alice')
    const rejected = expect(result).rejects.toMatchObject({ kind: 'RESTRICTED' })
    const cdp = fakes.views[1].webContents.debugger
    cdp.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'restricted',
      request: {
        url: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox',
        postData: '{"keyword":"alice"}'
      }
    })
    cdp.emit('message', {}, 'Network.responseReceived', {
      requestId: 'restricted',
      response: { status: 461 }
    })
    cdp.emit('message', {}, 'Network.loadingFinished', { requestId: 'restricted' })
    await rejected
    expect(cdp.sendCommand).not.toHaveBeenCalled()
  })
  it('recognizes verification immediately, preserves its page and signals recovery', async () => {
    const worker = fakes.views[1].webContents
    const result = service.search('alice')
    const rejected = expect(result).rejects.toMatchObject({ kind: 'AUTH' })
    worker.getURL.mockReturnValue('https://www.xiaohongshu.com/website-login/captcha')
    worker.emit('did-navigate')
    await rejected
    await expect(service.search('bob')).rejects.toThrow('扫码')
    expect(worker.loadURL).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(45000)
    expect(service.snapshot().evidence.some((e) => e.message.includes('超时'))).toBe(false)
    const version = service.snapshot().authVersion ?? 0
    worker.getURL.mockReturnValue('https://www.xiaohongshu.com/search_result?keyword=alice')
    worker.emit('did-navigate-in-page')
    expect(service.snapshot().authVersion).toBe(version + 1)
  })
  it('isolates remote pages from Node and shares only the account session', () => {
    expect(fakes.partition).toHaveBeenCalledWith('persist:xhs-account')
    const [foreground, worker] = fakes.views
    expect(foreground.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    expect(worker.options.webPreferences.session).toBe(foreground.options.webPreferences.session)
    expect(worker.webContents.setAudioMuted).toHaveBeenCalledWith(true)
  })

  it('queries only the worker and rejects concurrent searches', async () => {
    const result = service.search('alice')
    const rejection = expect(result).rejects.toThrow('超时')
    await expect(service.search('bob')).rejects.toThrow('正在查询')
    expect(fakes.views[0].webContents.loadURL).not.toHaveBeenCalled()
    expect(fakes.views[1].webContents.loadURL).toHaveBeenCalledWith(
      expect.stringContaining('keyword=alice')
    )
    await vi.advanceTimersByTimeAsync(45000)
    await rejection
    expect(service.snapshot().queryRunning).toBe(false)
  })

  it('correlates response bodies with the active keyword and request id', async () => {
    const result = service.search('alice')
    const cdp = fakes.views[1].webContents.debugger
    const url = 'https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox'
    cdp.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'wrong',
      request: { url, postData: '{"keyword":"bob"}' }
    })
    cdp.emit('message', {}, 'Network.loadingFinished', { requestId: 'wrong' })
    expect(cdp.sendCommand).not.toHaveBeenCalled()
    cdp.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'match',
      request: { url, postData: '{"keyword":"alice"}' }
    })
    cdp.emit('message', {}, 'Network.responseReceived', {
      requestId: 'match',
      response: { status: 200 }
    })
    cdp.emit('message', {}, 'Network.loadingFinished', { requestId: 'match' })
    await expect(result).resolves.toEqual([])
    expect(cdp.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'match' })
  })

  it('continues an active query while hidden and restores the previous mute setting', async () => {
    const result = service.search('alice')
    const rejection = expect(result).rejects.toThrow('应用已退出')
    service.setHidden(true)
    expect(service.snapshot().queryRunning).toBe(true)
    expect(fakes.views[0].webContents.setAudioMuted).toHaveBeenLastCalledWith(true)
    service.setHidden(false)
    expect(fakes.views[0].webContents.setAudioMuted).toHaveBeenLastCalledWith(false)
    await service.dispose()
    await rejection
  })

  it('does not expose captured credential values in snapshots or evidence', () => {
    const callback = fakes.headerHook.mock.calls.at(-1)![1]
    callback({ requestHeaders: { 'X-S': 'secret-signature', Cookie: 'secret-cookie' } }, vi.fn())
    expect(service.snapshot().signedRequestObserved).toBe(true)
    expect(JSON.stringify(service.snapshot())).not.toContain('secret-')
  })
})
