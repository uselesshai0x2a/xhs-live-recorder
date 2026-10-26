import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
const f = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: f.request } }))
import { queryTransport } from './query-transport'
function setup(): {
  request: EventEmitter & {
    setHeader: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
  }
  controller: AbortController
  result: Promise<Response>
} {
  const request = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    end: vi.fn(),
    abort: vi.fn()
  })
  f.request.mockReturnValue(request)
  const controller = new AbortController()
  return {
    request,
    controller,
    result: queryTransport(
      {} as Session,
      { body: 'exact-signed-bytes', headers: { 'x-s': 'fresh' } },
      controller.signal
    )
  }
}
describe('Chromium Session API transport', () => {
  it('keeps malformed response metadata inside the query failure boundary', async () => {
    const f = setup(),
      response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { 'retry-after': ['中文'] }
      })
    f.request.emit('response', response)
    expect(() => response.emit('end')).not.toThrow()
    await expect(f.result).rejects.toMatchObject({ kind: 'SCHEMA' })
  })
  it('sends exact bytes with session cookies and a referrer consistent with Chromium policy', async () => {
    const f = setup()
    expect(f.request.setHeader).toHaveBeenCalledWith('Referer', 'https://www.xiaohongshu.com/')
    expect(f.request.end).toHaveBeenCalledWith('exact-signed-bytes')
    const response = Object.assign(new EventEmitter(), {
      statusCode: 429,
      headers: { 'retry-after': ['180'] }
    })
    f.request.emit('response', response)
    response.emit('data', Buffer.from('{}'))
    response.emit('end')
    const result = await f.result
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).toBe('180')
  })
  it('exposes redirects without following them and ignores cancellation afterward', async () => {
    const f = setup()
    f.request.emit('redirect', 302, 'GET', 'https://www.xiaohongshu.com/website-login/captcha')
    f.request.emit('error', new Error('Redirect was cancelled'))
    const result = await f.result
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toContain('/website-login/captcha')
    expect(f.request.abort).toHaveBeenCalledOnce()
  })
  it('cancels promptly when authorization changes', async () => {
    const f = setup()
    const reason = new Error('session changed')
    f.controller.abort(reason)
    await expect(f.result).rejects.toBe(reason)
    expect(f.request.abort).toHaveBeenCalledOnce()
  })
  it('handles a response stream failure without waiting for the query timeout', async () => {
    const f = setup(),
      response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
    f.request.emit('response', response)
    response.emit('aborted')
    await expect(f.result).rejects.toMatchObject({ kind: 'NETWORK' })
  })
})
