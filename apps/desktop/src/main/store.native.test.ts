import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candidate, RecordingRun, Target } from '@xhs-live-recorder/core'
import { SqliteStore } from './store'
import { RecorderService } from './recorder-service'
import type { XhsBrowserService } from './browser/browser-service'
import { BrowserQueryError } from './browser/protocol'
import Database from 'better-sqlite3'
const resources: { store: SqliteStore; root: string }[] = []
const candidate: Candidate = {
  keyWord: 'alice',
  userId: 'user-1',
  name: 'Alice',
  state: 'live',
  roomId: 'room-1',
  pageUrl: 'https://www.xiaohongshu.com/user/profile/user-1'
}
function fixture(): { root: string; store: SqliteStore } {
  const root = mkdtempSync(path.join(tmpdir(), 'xhs-sqlite-'))
  const store = new SqliteStore(path.join(root, 'recorder.db'), root)
  resources.push({ store, root })
  return { root, store }
}
afterEach(() => {
  for (const item of resources.splice(0)) {
    if (item.store.db.open) item.store.close()
    rmSync(item.root, { recursive: true, force: true })
  }
})
describe('SQLite persistence and recovery', () => {
  it('rolls back all migration changes when an incompatible column is found', () => {
    const f = fixture()
    f.store.db.exec(
      'ALTER TABLE targets DROP COLUMN archivedAt; ALTER TABLE targets DROP COLUMN generation; ALTER TABLE targets DROP COLUMN errorKind; PRAGMA user_version=1'
    )
    f.store.close()
    expect(() => new SqliteStore(path.join(f.root, 'recorder.db'), f.root)).toThrow()
    const inspect = new Database(path.join(f.root, 'recorder.db'))
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(1)
      const columns = inspect.prepare('PRAGMA table_info(targets)').all() as { name: string }[]
      expect(
        columns.some(
          (c) => c.name === 'archivedAt' || c.name === 'generation' || c.name === 'errorKind'
        )
      ).toBe(false)
    } finally {
      inspect.close()
    }
  })
  it('migrates version 1 without losing targets, settings or confirmation times', () => {
    const f = fixture()
    const target = f.store.add(candidate)
    const at = new Date().toISOString()
    f.store.saveTarget({ ...target, checkedAt: at })
    f.store.db.exec(
      'ALTER TABLE targets DROP COLUMN archivedAt; ALTER TABLE targets DROP COLUMN generation; ALTER TABLE targets DROP COLUMN errorKind; ALTER TABLE targets DROP COLUMN lastConfirmedAt; PRAGMA user_version=1'
    )
    f.store.close()
    const reopened = new SqliteStore(path.join(f.root, 'recorder.db'), f.root)
    resources[0].store = reopened
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(2)
    expect(reopened.target(target.id)).toMatchObject({
      archivedAt: null,
      generation: 0,
      lastConfirmedAt: at
    })
    expect(reopened.settings().outputDir).toBe(f.root)
  })
  it('archives without deleting history and restores the same identity with a new generation', () => {
    const f = fixture()
    const target = f.store.add(candidate)
    f.store.observeSession(target)
    f.store.remove(target.id)
    f.store.remove(target.id)
    expect(f.store.targets()).toEqual([])
    expect(f.store.findAccount(candidate.userId!)?.generation).toBe(1)
    f.store.saveTarget({ ...target, name: 'late response' })
    expect(f.store.targets()).toEqual([])
    f.store.close()
    const reopened = new SqliteStore(path.join(f.root, 'recorder.db'), f.root)
    resources[0].store = reopened
    expect(reopened.targets()).toEqual([])
    const restored = reopened.add(candidate)
    expect(restored).toMatchObject({
      id: target.id,
      generation: 2,
      enabled: true,
      notify: true,
      autoRecord: true
    })
    expect(reopened.observeSession(restored)).toBe(false)
    reopened.saveTarget(target)
    expect(reopened.target(target.id)?.generation).toBe(2)
  })
  it('initializes schema and retains settings and target policies on reopening', () => {
    const f = fixture()
    const target = f.store.add(candidate)
    f.store.saveTarget({ ...target, notify: false, autoRecord: false })
    f.store.saveSettings({ ...f.store.settings(), warningGiB: 20 })
    f.store.close()
    const reopened = new SqliteStore(path.join(f.root, 'recorder.db'), f.root)
    resources[0].store = reopened
    expect(reopened.settings().warningGiB).toBe(20)
    expect(reopened.targets()[0]).toMatchObject({
      notify: false,
      autoRecord: false,
      userId: 'user-1'
    })
    expect(reopened.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(reopened.db.pragma('foreign_keys', { simple: true })).toBe(1)
  })
  it('deduplicates live notifications across process restarts', () => {
    const f = fixture()
    const target = f.store.add(candidate)
    expect(f.store.observeSession(target)).toBe(true)
    expect(f.store.observeSession(target)).toBe(false)
    f.store.close()
    const reopened = new SqliteStore(path.join(f.root, 'recorder.db'), f.root)
    resources[0].store = reopened
    expect(reopened.observeSession(target)).toBe(false)
    expect(reopened.observeSession({ ...target, roomId: 'room-2' })).toBe(true)
  })
  it('recovers interrupted runs and discovers their surviving fragments', () => {
    const f = fixture()
    const target = f.store.add(candidate)
    const work = path.join(f.root, '.work', 'run')
    mkdirSync(work, { recursive: true })
    writeFileSync(path.join(work, 'attempt-000-part-00000.flv'), 'fragment')
    const run: RecordingRun = {
      id: 'run',
      taskId: 'task',
      targetId: target.id,
      name: 'Alice',
      sourceUrl: 'https://example.test/live',
      directory: f.root,
      workDirectory: work,
      state: 'recording',
      mergeState: 'none',
      outputPath: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      stopReason: null
    }
    f.store.saveRun(run)
    f.store.close()
    const reopened = new SqliteStore(path.join(f.root, 'recorder.db'), f.root)
    resources[0].store = reopened
    expect(reopened.run('run')).toMatchObject({ state: 'interrupted', mergeState: 'pending' })
    expect(reopened.files('run')[0]).toMatchObject({ kind: 'segment', bytes: 8, exists: true })
  })
  it('uses the selected root for new runs while reusing existing room folders within a root', () => {
    const f = fixture()
    expect(f.store.taskDirectory('task', path.join(f.root, 'day1'))).toBe(
      f.store.taskDirectory('task', path.join(f.root, 'day2'))
    )
    const changed = path.join(f.root, 'another-disk', 'day2')
    expect(f.store.taskDirectory('task', changed)).toBe(changed)
  })
  it('does not write auth secrets to its account metadata', () => {
    const f = fixture()
    f.store.account('ready')
    const columns = f.store.db.prepare('PRAGMA table_info(account)').all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(['id', 'status', 'updatedAt'])
  })
})
describe('recording coordination', () => {
  function setup(): {
    root: string
    store: SqliteStore
    target: Target
    browser: XhsBrowserService
    service: RecorderService
    start: unknown
    notify: unknown
  } {
    const f = fixture()
    f.store.saveSettings({ ...f.store.settings(), outputConfigured: true, requestIntervalMs: 5000 })
    const target = f.store.add(candidate)
    const browser = {
      search: vi.fn(async () => [candidate]),
      snapshot: () => ({ authVersion: 0 }),
      dispose: vi.fn(async () => {})
    } as unknown as XhsBrowserService
    const notify = vi.fn()
    const service = new RecorderService(
      f.store,
      browser,
      'unused',
      () => {},
      notify,
      () => 0
    )
    const start = vi.spyOn(service.engine, 'start').mockReturnValue({} as RecordingRun)
    return { ...f, target, browser, service, start, notify }
  }
  it('starts recording on a first live result and emits one notice', async () => {
    const f = setup()
    await f.service.check(f.target.id)
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.store.notices()).toHaveLength(1)
  })
  it('ignores a response after removal and re-addition of the same account', async () => {
    const f = setup()
    let finish!: (value: Candidate[]) => void
    vi.mocked(f.browser.search).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const checking = f.service.check(f.target.id)
    await vi.waitFor(() => expect(f.browser.search).toHaveBeenCalledOnce())
    await f.service.remove(f.target.id)
    const restored = f.store.add({ ...candidate, name: 'Restored' })
    finish([candidate])
    await checking
    expect(f.start).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.store.target(restored.id)?.name).toBe('Restored')
  })
  it('cancels a queued target before it reaches the browser', async () => {
    const f = setup()
    const second = f.store.add({ ...candidate, keyWord: 'bob', userId: 'user-2' })
    let finish!: (value: Candidate[]) => void
    vi.mocked(f.browser.search).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const first = f.service.check(f.target.id)
    const queued = f.service.check(second.id)
    await vi.waitFor(() => expect(f.browser.search).toHaveBeenCalledOnce())
    await f.service.remove(second.id)
    finish([candidate])
    await Promise.all([first, queued])
    expect(f.browser.search).toHaveBeenCalledOnce()
  })
  it('does not start a new recording when monitoring is paused during an automatic query', async () => {
    const f = setup()
    let finish!: (value: Candidate[]) => void
    vi.mocked(f.browser.search).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const checking = f.service.check(f.target.id, true)
    await vi.waitFor(() => expect(f.browser.search).toHaveBeenCalledOnce())
    f.service.setPaused(true)
    finish([candidate])
    await checking
    expect(f.start).not.toHaveBeenCalled()
  })
  it('archives before waiting for an active recorder to stop, and coalesces duplicate removals', async () => {
    const f = setup()
    let finish!: () => void
    const stop = vi.spyOn(f.service.engine, 'stop').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const first = f.service.remove(f.target.id)
    const second = f.service.remove(f.target.id)
    expect(first).toBe(second)
    expect(f.store.target(f.target.id)).toBeUndefined()
    expect(stop).toHaveBeenCalledExactlyOnceWith(f.target.id, 'removed')
    finish()
    await first
  })
  it('clears shared auth warnings after valid success but keeps disk and other-target errors', async () => {
    const f = setup()
    const other = f.store.add({ ...candidate, keyWord: 'bob', userId: 'user-2' })
    const third = f.store.add({ ...candidate, keyWord: 'carol', userId: 'user-3' })
    f.store.saveTarget({ ...f.target, error: 'old auth', errorKind: 'AUTH', blockedReason: 'disk' })
    f.store.saveTarget({ ...other, error: 'old auth', errorKind: 'AUTH' })
    f.store.saveTarget({ ...third, error: 'network', errorKind: 'NETWORK' })
    f.service.queryBlockKind = 'AUTH'
    await f.service.check(f.target.id)
    expect(f.store.target(f.target.id)).toMatchObject({
      error: null,
      errorKind: null,
      blockedReason: 'disk'
    })
    expect(f.store.target(other.id)?.error).toBeNull()
    expect(f.store.target(third.id)?.error).toBe('network')
    expect(f.service.authBlocked).toBe(false)
    expect(f.store.target(f.target.id)?.lastConfirmedAt).toBeTruthy()
  })
  it('keeps an unknown-state warning and does not invent a new confirmation time', async () => {
    const f = setup()
    const at = f.target.lastConfirmedAt
    vi.mocked(f.browser.search).mockResolvedValue([
      { ...candidate, state: 'unknown', roomId: null }
    ])
    await f.service.check(f.target.id)
    expect(f.store.target(f.target.id)).toMatchObject({
      state: 'live',
      errorKind: 'UNKNOWN',
      lastConfirmedAt: at
    })
  })
  it('latches HTTP 461 restrictions, cancels queued requests, and requires a fresh manual success', async () => {
    const f = setup()
    const second = f.store.add({ ...candidate, keyWord: 'bob', userId: 'user-2' })
    vi.mocked(f.browser.search).mockRejectedValue(new BrowserQueryError('461', 'RESTRICTED'))
    const first = f.service.check(f.target.id)
    const queued = f.service.check(second.id)
    await expect(first).rejects.toThrow('461')
    await queued
    expect(f.browser.search).toHaveBeenCalledOnce()
    expect(f.service.snapshot().queryBlockKind).toBe('RESTRICTED')
    await f.service.check(second.id, true)
    expect(f.browser.search).toHaveBeenCalledOnce()
    expect(f.store.accountStatus()).toBe('RESTRICTED')
    vi.mocked(f.browser.search).mockResolvedValue([candidate])
    vi.useFakeTimers()
    try {
      const recovery = f.service.check(f.target.id)
      await vi.advanceTimersByTimeAsync(5000)
      await recovery
      expect(f.service.authBlocked).toBe(false)
      expect(f.store.target(f.target.id)?.error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not clear auth warnings merely when the browser auth version changes', async () => {
    const f = setup()
    f.service.setPaused(true)
    f.service.queryBlockKind = 'AUTH'
    vi.spyOn(f.browser, 'snapshot').mockReturnValue({ authVersion: 5 } as ReturnType<
      XhsBrowserService['snapshot']
    >)
    f.service.start()
    expect(f.service.authBlocked).toBe(true)
    expect(f.browser.search).not.toHaveBeenCalled()
    await f.service.close()
  })
  it('keeps one early confirmation while paused, then refreshes offline state automatically', async () => {
    const f = setup()
    f.store.saveTarget({ ...f.target, checkedAt: new Date().toISOString() })
    f.service.setPaused(true)
    const run = { id: 'run-ended', targetId: f.target.id } as RecordingRun
    const event = f.service.engine as unknown as { onStreamEnded(run: RecordingRun): void }
    event.onStreamEnded(run)
    event.onStreamEnded(run)
    expect(f.service.snapshot().pendingConfirmations).toEqual([f.target.id])
    vi.mocked(f.browser.search).mockResolvedValue([
      { ...candidate, state: 'offline', roomId: null }
    ])
    vi.useFakeTimers()
    try {
      f.service.start()
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.browser.search).not.toHaveBeenCalled()
      f.service.setPaused(false)
      await vi.advanceTimersByTimeAsync(1001)
      expect(f.browser.search).toHaveBeenCalledOnce()
      expect(f.service.snapshot().targets[0].state).toBe('offline')
      expect(f.service.snapshot().pendingConfirmations).toEqual([])
      event.onStreamEnded(run)
      expect(f.service.snapshot().pendingConfirmations).toEqual([])
    } finally {
      const closing = f.service.close()
      await vi.advanceTimersByTimeAsync(2000)
      await closing
      vi.useRealTimers()
    }
  })
  it('honors a manual stop for the same room and permits a new room', async () => {
    const f = setup()
    await f.service.stop(f.target.id)
    await f.service.check(f.target.id)
    expect(f.start).not.toHaveBeenCalled()
    vi.mocked(f.browser.search).mockResolvedValue([{ ...candidate, roomId: 'room-2' }])
    // Advance the per-request throttle without weakening the configured production interval.
    vi.useFakeTimers()
    const next = f.service.check(f.target.id)
    await vi.advanceTimersByTimeAsync(5000)
    await next
    vi.useRealTimers()
    expect(f.start).toHaveBeenCalledOnce()
  })
  it('keeps the previous live state after an unknown response', async () => {
    const f = setup()
    vi.mocked(f.browser.search).mockResolvedValue([
      { ...candidate, state: 'unknown', roomId: null }
    ])
    await f.service.check(f.target.id)
    expect(f.store.target(f.target.id)?.state).toBe('live')
    expect(f.start).not.toHaveBeenCalled()
  })
  it('retains manual suppression through an offline result until the room changes', async () => {
    const f = setup()
    await f.service.stop(f.target.id)
    vi.mocked(f.browser.search).mockResolvedValue([
      { ...candidate, state: 'offline', roomId: null }
    ])
    await f.service.check(f.target.id)
    vi.mocked(f.browser.search).mockResolvedValue([candidate])
    vi.useFakeTimers()
    try {
      const next = f.service.check(f.target.id)
      await vi.advanceTimersByTimeAsync(5000)
      await next
      expect(f.start).not.toHaveBeenCalled()
      expect(f.store.target(f.target.id)?.blockedReason).toBe('manual')
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not restart a blocked disk task even when the room changes', async () => {
    const f = setup()
    f.store.saveTarget({ ...f.target, blockedReason: 'disk', blockedRoomId: 'room-1' })
    vi.mocked(f.browser.search).mockResolvedValue([{ ...candidate, roomId: 'room-2' }])
    await f.service.check(f.target.id)
    expect(f.start).not.toHaveBeenCalled()
  })
  it('pauses authentication failures without stopping a working recorder', async () => {
    const f = setup()
    vi.mocked(f.browser.search).mockRejectedValue(new BrowserQueryError('重新登录', 'AUTH'))
    const stop = vi.spyOn(f.service.engine, 'stop')
    await expect(f.service.check(f.target.id)).rejects.toThrow('重新登录')
    expect(f.service.authBlocked).toBe(true)
    expect(stop).not.toHaveBeenCalled()
  })
})
