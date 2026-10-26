import type { QueryErrorKind, QueryIssue, QueryRecoveryAction } from '@xhs-live-recorder/core'

const explanations: Record<QueryErrorKind, [string, string, QueryRecoveryAction]> = {
  AUTH: ['登录已失效', '请在内嵌浏览器重新登录，登录后会验证查询是否恢复。', 'login'],
  VERIFICATION: ['需要完成账号验证', '请在内嵌浏览器完成官方安全验证，再重试查询。', 'verify'],
  RESTRICTED: [
    '网站限制了查询',
    '自动查询已暂停。可前往浏览器检查验证提示，处理后重试。',
    'verify'
  ],
  RATE_LIMITED: ['查询过于频繁', '冷却结束后自动重试；正在录制的任务会继续。', 'wait'],
  SIGNATURE: [
    '接口签名未通过验证',
    '查询组件已尝试重新初始化，可修复后重试；不需要因此退出登录。',
    'repair'
  ],
  SIGNER: [
    '查询组件初始化失败',
    '请修复查询组件后重试；若仍失败，请复制诊断信息以便适配网站变化。',
    'repair'
  ],
  NETWORK: ['网络连接失败', '请检查网络或代理连接后重试；此错误不表示登录过期。', 'retry'],
  TIMEOUT: ['查询超时', '网站未及时响应，请检查网络后重试。', 'retry'],
  SCHEMA: ['网站接口数据发生变化', '自动查询已暂停，请复制诊断信息；需要更新接口适配。', 'details'],
  MATCH: ['未找到匹配的主播', '请核对主播的小红书号，再重新查询。', 'retry'],
  SESSION_CHANGED: ['登录会话已更新', '旧查询已取消，等待使用当前会话重新查询。', 'retry'],
  UNKNOWN: ['操作未完成', '原因尚未确认，请查看诊断详情后重试。', 'retry']
}

// Restrict diagnostics to small messages; never serialize payloads or request headers.
const diagnosticMarkers = new Set([
  'SIGNER_NOT_READY',
  'SIGNER_RUNTIME_CHANGED',
  'SIGNER_MODULE_CHANGED',
  'SIGNER_EXPORT_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_FAILED',
  'ERR_ABORTED',
  'ERR_BLOCKED_BY_CLIENT'
])
export function redactDiagnostic(value: string, secrets: string[] = []): string {
  let text = value
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[已隐藏]')
  return (
    text
      .replace(
        /(?:cookie|authorization|x-s(?:-common)?|x-t|sc-t|web_session|a1|b1|(?:access[_-]?|refresh[_-]?|session[_-]?)?token)\s*["']?\s*[:=]\s*[^\r\n]+/gi,
        '[凭据已隐藏]'
      )
      .replace(/\bBearer\s+\S+/gi, '[凭据已隐藏]')
      .replace(/(?:https?:\/\/|xhsdiscover:\/\/)[^\s"'<>]+/gi, '[网址已隐藏]')
      .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"<>]+/gi, '[路径已隐藏]')
      .replace(/\/(?:Users|home|tmp|mnt)\/[^\s"'<>]+/g, '[路径已隐藏]')
      .replace(
        /(?:user_?id|red_?id|room_?id|device_?id|web_?id|account(?:_?id)?|nickname|用户名|小红书号)\s*["']?\s*[:=]\s*[^\s,;]+/gi,
        '[账号已隐藏]'
      )
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[地址已隐藏]')
      .replace(/\b[A-Za-z0-9_+=/-]{20,}\b/g, (value) =>
        diagnosticMarkers.has(value) ? value : '[标识已隐藏]'
      )
      // eslint-disable-next-line no-control-regex -- Strip control characters from untrusted website text.
      .replace(/[\r\n\u0000-\u001f]/g, ' ')
      .slice(0, 500)
  )
}

export class BrowserQueryError extends Error {
  readonly issue: QueryIssue
  constructor(
    message: string,
    readonly kind: QueryErrorKind = 'NETWORK',
    details: Partial<
      Pick<QueryIssue, 'httpStatus' | 'businessCode' | 'diagnostic' | 'retryAt'>
    > = {},
    secrets: string[] = []
  ) {
    super(redactDiagnostic(message, secrets))
    const [title, help, action] = explanations[kind]
    this.issue = {
      id: crypto.randomUUID(),
      kind,
      title,
      message: this.message,
      help,
      action,
      occurredAt: new Date().toISOString(),
      ...details,
      ...(typeof details.businessCode === 'string'
        ? { businessCode: redactDiagnostic(details.businessCode, secrets) }
        : {}),
      ...(details.diagnostic ? { diagnostic: redactDiagnostic(details.diagnostic, secrets) } : {})
    }
  }
}

export function toQueryIssue(error: unknown): QueryIssue {
  if (error instanceof BrowserQueryError) return error.issue
  return {
    ...new BrowserQueryError(
      error instanceof Error ? error.message : '操作未完成，请重试',
      'UNKNOWN'
    ).issue,
    action: 'details',
    help: '请处理上述问题后，重新执行刚才的操作。'
  }
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: QueryIssue }
export type TransportApi<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<IpcResult<R>>
    : T[K]
}
// Errors must be reconstructed in the renderer, AFTER contextBridge has cloned
// the envelope. Throwing custom Error properties inside preload loses metadata.
export function unwrapApi<T extends object>(transport: TransportApi<T>): T {
  if (!transport) return transport as T
  return new Proxy(
    {},
    {
      get(_target, key) {
        const method = Reflect.get(transport, key)
        if (typeof method !== 'function' || key === 'subscribe' || key === 'onWatch') return method
        return async (...args: unknown[]) =>
          unwrapResult((await Reflect.apply(method, transport, args)) as IpcResult<unknown>)
      }
    }
  ) as T
}
export class RemoteQueryError extends Error {
  constructor(readonly issue: QueryIssue) {
    super(issue.message)
  }
}
export function unwrapResult<T>(result: IpcResult<T>): T {
  if (!result || typeof result.ok !== 'boolean')
    throw new Error('应用接口已更新，请重启应用后继续。')
  if (!result.ok) throw new RemoteQueryError(result.error)
  return result.value
}
export function formatDiagnostic(issue: QueryIssue): string {
  return [
    `诊断编号：${issue.id}`,
    `时间：${issue.occurredAt}`,
    `类别：${issue.kind}`,
    `说明：${redactDiagnostic(issue.message)}`,
    ...(issue.httpStatus === undefined ? [] : [`HTTP：${issue.httpStatus}`]),
    ...(issue.businessCode === undefined
      ? []
      : [`业务码：${redactDiagnostic(String(issue.businessCode))}`]),
    ...(issue.diagnostic ? [`网站消息：${redactDiagnostic(issue.diagnostic)}`] : []),
    ...(issue.retryAt ? [`重试时间：${issue.retryAt}`] : [])
  ].join('\n')
}
