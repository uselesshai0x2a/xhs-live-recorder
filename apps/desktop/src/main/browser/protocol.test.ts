import { describe, expect, it } from 'vitest'
import { isOnebox, officialUrl, parseCandidates, requestKeyword } from './protocol'

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
