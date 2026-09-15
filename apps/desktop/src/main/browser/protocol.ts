import type { BrowserCandidate } from '../../shared/browser'

export const ONEBOX_PATH = '/api/sns/web/v1/search/onebox'
export function isVerificationPage(value: string): boolean {
  try {
    const url = new URL(officialUrl(value))
    return /^\/website-login(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}
export class BrowserQueryError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'AUTH'
      | 'RESTRICTED'
      | 'RATE_LIMITED'
      | 'NETWORK'
      | 'SCHEMA'
      | 'MATCH'
      | 'UNKNOWN' = 'NETWORK'
  ) {
    super(message)
  }
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
  if (!isRecord(payload)) throw new Error('网站返回了无法识别的数据')
  if (payload.success === false) {
    const diagnostic = String(payload.msg ?? payload.message ?? '')
    throw new BrowserQueryError(
      '网站拒绝查询，请在后台查询页检查登录或验证提示',
      /频繁|频率|rate/i.test(diagnostic) ? 'RATE_LIMITED' : 'AUTH'
    )
  }
  if (payload.success !== true)
    throw new BrowserQueryError('网站未确认查询成功，请稍后重新检查', 'SCHEMA')
  if (!isRecord(payload.data) || !Array.isArray(payload.data.onebox_list)) {
    throw new Error('网站响应缺少用户搜索结果，请检查网页是否需要登录或验证')
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
