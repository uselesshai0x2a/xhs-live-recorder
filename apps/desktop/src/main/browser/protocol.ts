import type { BrowserCandidate } from '../../shared/browser'
import type { QueryErrorKind } from '@xhs-live-recorder/core'
import { BrowserQueryError } from '../../shared/query-error'
export { BrowserQueryError } from '../../shared/query-error'

export const ONEBOX_PATH = '/api/sns/web/v1/search/onebox'
export function isVerificationPage(value: string): boolean {
  try {
    const url = new URL(officialUrl(value))
    return /^\/website-login(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}
export function responseError(
  status: number,
  payload: unknown,
  retryAfter?: string | null,
  now = Date.now(),
  secrets: string[] = []
): BrowserQueryError | null {
  const body = isRecord(payload) ? payload : {}
  if (
    status >= 200 &&
    status < 300 &&
    body.success !== false &&
    (body.code === undefined || body.code === 0 || body.code === '0')
  )
    return null
  const diagnostic =
    typeof body.msg === 'string' ? body.msg : typeof body.message === 'string' ? body.message : ''
  const code =
    typeof body.code === 'number' || typeof body.code === 'string' ? body.code : undefined
  let kind: QueryErrorKind = 'UNKNOWN'
  // -101 and 30001x meanings were verified against the current website client.
  if (status === 429 || Number(code) === 300013 || /频繁|频率|rate.?limit/i.test(diagnostic))
    kind = 'RATE_LIMITED'
  else if (/安全验证|身份验证|验证码|captcha|verification required/i.test(diagnostic))
    kind = 'VERIFICATION'
  else if (
    status === 401 ||
    Number(code) === -101 ||
    /未登录|登录.*(?:失效|过期)|login required|session expired/i.test(diagnostic)
  )
    kind = 'AUTH'
  else if (
    /签名.*(?:错误|无效|失效)|invalid signature|signature.*(?:invalid|expired)/i.test(diagnostic)
  )
    kind = 'SIGNATURE'
  else if (Number(code) === 300015) kind = 'SIGNER'
  else if (Number(code) === 300012) kind = 'NETWORK'
  else if (
    [403, 406, 461].includes(status) ||
    Number(code) === 300011 ||
    /没有权限访问|无权访问|access denied|access restricted/i.test(diagnostic)
  )
    kind = 'RESTRICTED'
  else if (status >= 500 || status === 0) kind = 'NETWORK'
  const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN
  const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter ?? '')
  const retryAt =
    kind === 'RATE_LIMITED'
      ? new Date(
          Math.min(
            8640000000000000,
            Math.max(now + 60000, Number.isFinite(deadline) ? deadline : 0)
          )
        ).toISOString()
      : undefined
  const messages: Partial<Record<QueryErrorKind, string>> = {
    AUTH: '网站确认登录已失效，请前往浏览器登录。',
    VERIFICATION: '网站要求完成安全验证。',
    RESTRICTED: '网站拒绝了本次查询，尚不能确认是登录问题。',
    RATE_LIMITED: '网站要求降低查询频率。',
    SIGNATURE: '网站未接受本次接口签名。',
    SIGNER: '网站检测到浏览器环境异常，查询组件需要重新初始化。',
    NETWORK:
      Number(code) === 300012
        ? '网站报告网络环境异常，请检查网络或代理设置。'
        : '网站暂时无法响应，请检查网络后重试。'
  }
  return new BrowserQueryError(
    messages[kind] ?? '网站拒绝了本次查询，原因尚未确认。',
    kind,
    { httpStatus: status, businessCode: code, diagnostic, ...(retryAt ? { retryAt } : {}) },
    secrets
  )
}

export function isOnebox(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'edith.xiaohongshu.com' &&
      parsed.pathname === ONEBOX_PATH
    )
  } catch {
    return false
  }
}

export function officialUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com'))
  ) {
    throw new Error('只能打开小红书官方 HTTPS 网页')
  }
  return url.toString()
}

export function requestKeyword(postData?: string): string | null {
  try {
    const body: unknown = JSON.parse(postData ?? '')
    return isRecord(body) && typeof body.keyword === 'string' ? body.keyword.trim() : null
  } catch {
    return null
  }
}

export function parseCandidates(payload: unknown, keyWord: string): BrowserCandidate[] {
  if (!isRecord(payload)) throw new BrowserQueryError('网站返回了无法识别的数据', 'SCHEMA')
  const failure = responseError(200, payload, undefined, Date.now(), [keyWord])
  if (failure) throw failure
  if (payload.success !== true)
    throw new BrowserQueryError('网站未确认查询成功，请稍后重新检查', 'SCHEMA')
  if (!isRecord(payload.data) || !Array.isArray(payload.data.onebox_list)) {
    throw new BrowserQueryError('网站响应缺少用户搜索结果，需要更新接口适配。', 'SCHEMA')
  }
  return payload.data.onebox_list.flatMap((entry: unknown): BrowserCandidate[] => {
    if (!isRecord(entry) || !isRecord(entry.user_one_box)) return []
    const box = entry.user_one_box
    const user = isRecord(box.user) ? box.user : box
    const live = isRecord(box.live_info) ? box.live_info : {}
    const userId = text(user.user_id) ?? text(user.id)
    let pageUrl: string | null = null
    const link = text(live.link)
    if (link) {
      try {
        pageUrl = officialUrl(link)
      } catch {
        /* App-only links are not web pages. */
      }
    }
    if (!pageUrl && userId)
      pageUrl = `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(userId)}`
    return [
      {
        keyWord: text(user.red_id) ?? keyWord,
        userId,
        name: text(box.title) ?? text(user.nickname) ?? keyWord,
        state: live.status === 2 ? 'live' : live.status === 0 ? 'offline' : 'unknown',
        roomId: text(live.room_id),
        pageUrl
      }
    ]
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return (typeof value === 'string' || typeof value === 'number') && String(value).trim()
    ? String(value).trim()
    : null
}
