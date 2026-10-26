import { net, type Session } from 'electron'
import type { SignedRequest } from './signer-runtime'
import { BrowserQueryError } from './protocol'

export const ONEBOX_API = 'https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox'
const ORIGIN = 'https://www.xiaohongshu.com'

// Electron 39 fetch(manual) rejects redirects instead of exposing the status and
// Location. ClientRequest retains the same Session/Chromium stack and lets us
// classify a redirect without following it or sending credentials elsewhere.
export function queryTransport(
  session: Session,
  signed: SignedRequest,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const request = net.request({
      url: ONEBOX_API,
      method: 'POST',
      session,
      credentials: 'include',
      origin: ORIGIN,
      referrerPolicy: 'strict-origin-when-cross-origin',
      redirect: 'manual'
    })
    let settled = false
    const finish = (error?: unknown, response?: Response): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(response!)
    }
    const aborted = (): void => {
      finish(signal.reason)
      request.abort()
    }
    signal.addEventListener('abort', aborted, { once: true })
    request.on('error', (error) => finish(error))
    request.on('abort', () => finish(new BrowserQueryError('接口请求已中断，请重试。', 'NETWORK')))
    request.on('redirect', (status, _method, url) => {
      try {
        finish(undefined, new Response(null, { status, headers: { location: url } }))
      } catch {
        finish(new BrowserQueryError('网站返回了无法识别的跳转信息。', 'SCHEMA'))
      }
      request.abort()
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > 4 * 1024 * 1024) {
          finish(new BrowserQueryError('网站返回的数据过大，需要检查接口变化。', 'SCHEMA'))
          request.abort()
          return
        }
        chunks.push(chunk)
      })
      response.on('error', (error) => finish(error))
      response.on('aborted', () =>
        finish(new BrowserQueryError('网站中断了响应，请检查网络后重试。', 'NETWORK'))
      )
      response.on('end', () => {
        if (settled) return
        try {
          const headers = new Headers()
          for (const key of ['retry-after', 'location']) {
            const value = response.headers[key]
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
          }
          finish(
            undefined,
            new Response(
              [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks),
              { status: response.statusCode, headers }
            )
          )
        } catch {
          finish(new BrowserQueryError('网站返回了无法识别的响应信息。', 'SCHEMA'))
        }
      })
    })
    try {
      for (const [key, value] of Object.entries(signed.headers)) request.setHeader(key, value)
      request.setHeader('Origin', ORIGIN)
      // Cross-origin requests use the origin only. A path conflicts with the
      // Chromium referrer policy and is locally blocked before any network I/O.
      request.setHeader('Referer', `${ORIGIN}/`)
      request.end(signed.body)
    } catch (error) {
      finish(error)
      request.abort()
    }
  })
}
