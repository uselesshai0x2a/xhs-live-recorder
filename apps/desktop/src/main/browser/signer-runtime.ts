import type { WebContents } from 'electron'
import { randomInt } from 'node:crypto'
import { BrowserQueryError, isOnebox, isRecord, isVerificationPage } from './protocol'

export type SignerStatus = 'idle' | 'loading' | 'ready' | 'error'
export interface SignedRequest {
  body: string
  headers: Record<string, string>
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

// Use the site's current request/dispatch interceptors, including X-S-Common.
// The per-request axios adapter captures bytes AFTER signing and serialization.
// It returns locally; only the main process sends the actual onebox request.
export function signingScript(keyword: string): string {
  const input = {
    keyword,
    searchId: `${Date.now()}${randomInt(10000000, 99999999)}`,
    bizType: 'web_search_user',
    requestId: `${randomInt(100000, 999999)}-${Date.now()}`
  }
  return `(async () => {
    const chunks = window.webpackChunkxhs_pc_web;
    if (!Array.isArray(chunks) || typeof window._webmsxyw !== 'function') throw new Error('SIGNER_NOT_READY');
    let runtime;
    chunks.push([['recorder-sign-' + ${JSON.stringify(input.requestId)}], {}, r => { runtime = r; }]);
    chunks.pop();
    if (!runtime?.m) throw new Error('SIGNER_RUNTIME_CHANGED');
    const moduleId = Object.keys(runtime.m).find(id => {
      const source = runtime.m[id].toString();
      return source.includes('function postApiSnsWebV1SearchOnebox') && source.includes('/api/sns/web/v1/search/onebox');
    });
    if (!moduleId) throw new Error('SIGNER_MODULE_CHANGED');
    const api = Object.values(runtime(moduleId)).find(value => typeof value === 'function' && value.toString().includes('/api/sns/web/v1/search/onebox'));
    if (!api) throw new Error('SIGNER_EXPORT_CHANGED');
    let captured;
    await api(${JSON.stringify(input)}, { adapter: async config => {
      captured = { url: new URL(config.url, config.baseURL || location.href).href, body: config.data, headers: Object.fromEntries(Object.entries(config.headers).filter(([,v]) => typeof v === 'string' || typeof v === 'number').map(([k,v]) => [k.toLowerCase(),String(v)])) };
      return { data: { success: true, data: { onebox_list: [] } }, status: 200, statusText: 'OK', headers: {}, config };
    }});
    return captured;
  })()`
}

export class SignerRuntime {
  private ready = false
  private version = 0
  constructor(
    private readonly contents: WebContents,
    private readonly changed: (state: SignerStatus) => void
  ) {}
  reset(): void {
    this.version++
    this.ready = false
    this.changed('idle')
  }

  async sign(keyword: string, signal: AbortSignal): Promise<SignedRequest> {
    const version = this.version
    try {
      if (!this.ready) {
        this.changed('loading')
        await abortable(this.contents.loadURL('https://www.xiaohongshu.com/explore'), signal)
        for (let attempt = 0; attempt < 40; attempt++) {
          if (isVerificationPage(this.contents.getURL()))
            throw new BrowserQueryError('网站要求在浏览器完成安全验证。', 'VERIFICATION')
          if (
            await abortable(
              this.contents.executeJavaScript(
                "typeof window._webmsxyw === 'function' && Array.isArray(window.webpackChunkxhs_pc_web)"
              ),
              signal
            )
          )
            break
          await abortable(new Promise((resolve) => setTimeout(resolve, 250)), signal)
          if (attempt === 39)
            throw new BrowserQueryError('未能加载网站签名组件，请修复后重试。', 'SIGNER')
        }
      }
      const value: unknown = await abortable(
        this.contents.executeJavaScript(signingScript(keyword)),
        signal
      )
      if (version !== this.version)
        throw new BrowserQueryError('会话已更新，旧签名已丢弃。', 'SESSION_CHANGED')
      if (
        !isRecord(value) ||
        typeof value.url !== 'string' ||
        !isOnebox(value.url) ||
        typeof value.body !== 'string' ||
        !isRecord(value.headers)
      )
        throw new BrowserQueryError('网站签名组件返回了无法识别的请求，需要更新适配。', 'SIGNER')
      const body: unknown = JSON.parse(value.body)
      if (!isRecord(body) || body.keyword !== keyword || body.biz_type !== 'web_search_user')
        throw new BrowserQueryError('签名请求与查询内容不一致，已取消请求。', 'SIGNER')
      const headers: Record<string, string> = {}
      for (const key of [
        'accept',
        'content-type',
        'x-s',
        'x-t',
        'x-s-common',
        'x-b3-traceid',
        'x-xray-traceid',
        'x-mns',
        'sc-t'
      ]) {
        const item = value.headers[key]
        if (typeof item === 'string' && !/[\r\n]/.test(item)) headers[key] = item
      }
      if (!headers['x-s'] || !headers['x-t'] || !headers['x-s-common'])
        throw new BrowserQueryError('网站尚未生成完整签名，请修复查询组件后重试。', 'SIGNER')
      this.ready = true
      this.changed('ready')
      return { body: value.body, headers }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      this.ready = false
      this.changed('error')
      if (error instanceof BrowserQueryError) throw error
      const network = error instanceof Error ? error.message.match(/\bERR_[A-Z_]+/)?.[0] : undefined
      if (network)
        throw new BrowserQueryError(
          '无法加载查询组件，请检查网络或代理连接后重试。',
          network.includes('TIMED_OUT') ? 'TIMEOUT' : 'NETWORK',
          { diagnostic: network }
        )
      // Website execution exceptions may contain credentials. Keep only our marker.
      const marker = error instanceof Error ? error.message.match(/SIGNER_[A-Z_]+/)?.[0] : undefined
      throw new BrowserQueryError('网站签名组件初始化失败或已发生变化。', 'SIGNER', {
        diagnostic: marker
      })
    }
  }
}
