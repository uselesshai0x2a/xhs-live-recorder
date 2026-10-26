import { describe, expect, it } from 'vitest'
import * as errors from './query-error'

describe('query diagnostics across the preload boundary', () => {
  it('redacts short credentials and account or device identifiers', () => {
    const text = errors.formatDiagnostic(
      new errors.BrowserQueryError('查询失败', 'UNKNOWN', {
        diagnostic:
          'room_id=12345678901 device_id=short-device webId=short-web sc-t=short-token access_token=short-access token=short-bearer userId=short-user'
      }).issue
    )
    for (const value of [
      '12345678901',
      'short-device',
      'short-web',
      'short-token',
      'short-access',
      'short-bearer',
      'short-user'
    ])
      expect(text).not.toContain(value)
  })
  it('does not offer query recovery for an unrelated operation error', () => {
    expect(errors.toQueryIssue(new Error('录制目录无法写入'))).toMatchObject({ action: 'details' })
  })
  it('reconstructs the structured error after IPC and contextBridge value cloning', async () => {
    const issue = new errors.BrowserQueryError('网络错误', 'NETWORK', {
      httpStatus: 503,
      businessCode: 42
    }).issue
    const wire = Object.freeze({
      check: async () => JSON.parse(JSON.stringify({ ok: false, error: issue }))
    })
    const client = errors.unwrapApi<{ check(): Promise<void> }>(wire)
    await expect(client.check()).rejects.toMatchObject({
      issue: { id: issue.id, httpStatus: 503, businessCode: 42, action: 'retry' }
    })
  })
  it('returns successful values and leaves subscriptions synchronous', async () => {
    const dispose = (): void => {}
    const client = errors.unwrapApi<{ snapshot(): Promise<number>; subscribe(): () => void }>({
      snapshot: async () => ({ ok: true, value: 7 }),
      subscribe: () => dispose
    })
    expect(await client.snapshot()).toBe(7)
    expect(client.subscribe()).toBe(dispose)
  })
  it('removes credentials, identifiers, URLs and private paths from copied diagnostics', () => {
    const raw =
      'user_id=privateUser email=alice@example.test https://example.test/?token=abc\nC:\\Users\\private\\rec\nCookie: web_session=secret; a1=secret2'
    const issue = new errors.BrowserQueryError('查询失败', 'UNKNOWN', { diagnostic: raw }).issue
    const text = errors.formatDiagnostic(issue)
    for (const secret of ['privateUser', 'alice@example.test', 'token=abc', 'private', 'secret2'])
      expect(text).not.toContain(secret)
    expect(text).toContain(issue.id)
  })
})
