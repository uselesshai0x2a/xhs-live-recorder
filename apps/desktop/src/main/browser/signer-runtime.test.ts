import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import type { WebContents } from 'electron'
import { SignerRuntime, signingScript } from './signer-runtime'

const signed = (keyword: string): object => ({
  url: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox',
  body: JSON.stringify({ keyword, biz_type: 'web_search_user' }),
  headers: { 'x-s': 'fresh', 'x-t': '123', 'x-s-common': 'common' }
})
function fixture(): {
  contents: WebContents
  load: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  signer: SignerRuntime
} {
  const load = vi.fn(async () => undefined)
  const execute = vi.fn(async (script: string) =>
    script.startsWith('typeof') ? true : signed('alice')
  )
  const contents = {
    loadURL: load,
    executeJavaScript: execute,
    getURL: () => 'https://www.xiaohongshu.com/explore'
  } as unknown as WebContents
  return { contents, load, execute, signer: new SignerRuntime(contents, vi.fn()) }
}
describe('website signing runtime', () => {
  it('captures the website interceptor output without sending its adapter request', async () => {
    const adapterCalls: unknown[] = []
    const api = async function postApiSnsWebV1SearchOnebox(
      input: { keyword: string; bizType: string },
      options: { adapter: (config: object) => Promise<unknown> }
    ): Promise<unknown> {
      const config = {
        url: '//edith.xiaohongshu.com/api/sns/web/v1/search/onebox',
        data: JSON.stringify({ keyword: input.keyword, biz_type: input.bizType }),
        headers: { 'X-s': 'fresh', 'X-t': 123, 'X-S-Common': 'common' }
      }
      adapterCalls.push(config)
      return options.adapter(config)
    }
    const runtime = Object.assign(() => ({ api }), { m: { onebox: api } })
    const chunks: unknown[] = []
    chunks.push = (chunk: unknown): number => {
      ;(chunk as [unknown, unknown, (runtime: unknown) => void])[2](runtime)
      return Array.prototype.push.call(chunks, chunk)
    }
    const result = await runInNewContext(signingScript('alice'), {
      window: { _webmsxyw: () => {}, webpackChunkxhs_pc_web: chunks },
      location: { href: 'https://www.xiaohongshu.com/explore' },
      URL
    })
    expect(result.body).toBe('{"keyword":"alice","biz_type":"web_search_user"}')
    expect(result.headers).toMatchObject({ 'x-s': 'fresh', 'x-t': '123', 'x-s-common': 'common' })
    expect(adapterCalls).toHaveLength(1)
    expect(chunks).toHaveLength(0)
  })
  it('reuses the initialized page and regenerates every signature; reset reloads once', async () => {
    const f = fixture(),
      signal = new AbortController().signal
    await f.signer.sign('alice', signal)
    await f.signer.sign('alice', signal)
    expect(f.load).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls.filter(([code]) => !code.startsWith('typeof'))).toHaveLength(2)
    f.signer.reset()
    await f.signer.sign('alice', signal)
    expect(f.load).toHaveBeenCalledTimes(2)
  })
  it('rejects mismatched signed bytes and incomplete headers as adaptation errors', async () => {
    const f = fixture()
    f.execute.mockImplementation(async (script) =>
      script.startsWith('typeof') ? true : signed('someone-else')
    )
    await expect(f.signer.sign('alice', new AbortController().signal)).rejects.toMatchObject({
      kind: 'SIGNER'
    })
  })
  it('classifies disconnected signer initialization as a network error', async () => {
    const f = fixture()
    f.load.mockRejectedValue(
      new Error('net::ERR_INTERNET_DISCONNECTED at https://private.example/token')
    )
    await expect(f.signer.sign('alice', new AbortController().signal)).rejects.toMatchObject({
      kind: 'NETWORK',
      issue: { diagnostic: 'ERR_INTERNET_DISCONNECTED' }
    })
  })
  it('does not leak website exceptions as login failures', async () => {
    const f = fixture()
    f.execute.mockRejectedValue(new Error('private-cookie SIGNER_MODULE_CHANGED'))
    await expect(f.signer.sign('alice', new AbortController().signal)).rejects.toMatchObject({
      kind: 'SIGNER',
      issue: { diagnostic: 'SIGNER_MODULE_CHANGED' }
    })
  })
})
