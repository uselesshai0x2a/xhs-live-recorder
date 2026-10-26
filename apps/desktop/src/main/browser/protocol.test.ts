import { describe, expect, it } from 'vitest'
import {
  BrowserQueryError,
  isOnebox,
  officialUrl,
  parseCandidates,
  requestKeyword
} from './protocol'
import * as protocol from './protocol'

describe('official browser boundary', () => {
  it.each([
    'https://xiaohongshu.com.evil.test/',
    'javascript:alert(1)',
    'file:///C:/secrets',
    'http://www.xiaohongshu.com',
    'https://user:password@www.xiaohongshu.com',
    'https://www.xiaohongshu.com:8443/'
  ])('rejects an unrelated or unsafe URL: %s', (url) => {
    expect(() => officialUrl(url)).toThrow()
  })
  it('accepts official HTTPS pages and matches only the intended API', () => {
    expect(officialUrl('https://www.xiaohongshu.com/user/profile/123')).toContain(
      '/user/profile/123'
    )
    expect(isOnebox('https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox')).toBe(true)
    expect(isOnebox('https://evil.test/api/sns/web/v1/search/onebox')).toBe(false)
    expect(isOnebox('https://edith.xiaohongshu.com/api/sns/web/v1/search/other')).toBe(false)
  })
  it('extracts the exact originating search keyword without interpreting arbitrary values', () => {
    expect(requestKeyword('{"keyword":"alice"}')).toBe('alice')
    expect(requestKeyword('{"keyword":3}')).toBeNull()
    expect(requestKeyword('invalid')).toBeNull()
  })
})

describe('onebox response interpretation', () => {
  it('treats an explicit access denial as restriction rather than expired login', () => {
    expect(
      protocol.responseError(200, {
        success: false,
        code: -104,
        msg: '您当前登录的账号没有权限访问'
      })
    ).toMatchObject({ kind: 'RESTRICTED', issue: { action: 'verify' } })
  })
  it('rejects nonzero business codes even when the success flag is absent', () => {
    expect(protocol.responseError(200, { code: 300013 })).toMatchObject({ kind: 'RATE_LIMITED' })
    expect(protocol.responseError(200, { code: 987654 })).toMatchObject({ kind: 'UNKNOWN' })
  })
  it('does not diagnose an undocumented business rejection as expired login', () => {
    try {
      parseCandidates({ success: false, code: 876543, msg: 'unexpected rejection' }, 'alice')
      expect.fail('query must reject')
    } catch (error) {
      expect(error).toMatchObject({ kind: 'UNKNOWN' })
    }
  })
  it('retains actionable structured diagnostics instead of only an error number', () => {
    const error = new BrowserQueryError('连接超时', 'NETWORK')
    expect(error).toMatchObject({
      issue: { kind: 'NETWORK', action: 'retry', title: '网络连接失败' }
    })
  })
  it.each([403, 406])('does not label bare HTTP %s as logged out', (status) => {
    expect(protocol.responseError(status, null)).toMatchObject({ kind: 'RESTRICTED' })
  })
  it('honors a longer Retry-After without shortening it to one minute', () => {
    const error = protocol.responseError(429, { success: false }, '180', 1000000)
    expect(error?.issue.retryAt).toBe(new Date(1180000).toISOString())
  })
  it('separates explicit authentication, verification and signature failures', () => {
    expect(protocol.responseError(200, { success: false, code: -101 })).toMatchObject({
      kind: 'AUTH'
    })
    expect(protocol.responseError(200, { success: false, msg: '请完成安全验证' })).toMatchObject({
      kind: 'VERIFICATION'
    })
    expect(protocol.responseError(200, { success: false, msg: 'invalid signature' })).toMatchObject(
      { kind: 'SIGNATURE' }
    )
  })
  const response = (live_info: unknown): unknown => ({
    success: true,
    data: {
      onebox_list: [
        { user_one_box: { title: 'Alice', red_id: 'alice', user_id: '123', live_info } }
      ]
    }
  })
  it('retains explicit live, offline and unknown states', () => {
    expect(parseCandidates(response({ status: 2, room_id: 'room' }), 'alice')[0]).toMatchObject({
      state: 'live',
      roomId: 'room',
      userId: '123',
      pageUrl: 'https://www.xiaohongshu.com/user/profile/123'
    })
    expect(parseCandidates(response({ status: 0 }), 'alice')[0].state).toBe('offline')
    expect(parseCandidates(response({ status: 8 }), 'alice')[0].state).toBe('unknown')
    expect(parseCandidates(response(null), 'alice')[0].state).toBe('unknown')
  })
  it('does not treat authentication failures or missing schema as offline', () => {
    expect(() => parseCandidates({ success: false }, 'alice')).toThrow()
    expect(() => parseCandidates({ data: {} }, 'alice')).toThrow()
    expect(() => parseCandidates({ data: { onebox_list: [] } }, 'alice')).toThrow('未确认查询成功')
  })
  it('does not open app protocols or third-party links as official live pages', () => {
    for (const link of ['xhsdiscover://live/123', 'https://evil.test/']) {
      expect(parseCandidates(response({ status: 2, link }), 'alice')[0].pageUrl).toBe(
        'https://www.xiaohongshu.com/user/profile/123'
      )
    }
  })
})
