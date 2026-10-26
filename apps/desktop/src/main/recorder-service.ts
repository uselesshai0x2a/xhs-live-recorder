import {
  delay,
  FileSystemDisk,
  RecordingEngine,
  type Candidate,
  type DiskStatus,
  type RecordingRun,
  type Target
} from '@xhs-live-recorder/core'
import type { XhsBrowserService } from './browser/browser-service'
import { BrowserQueryError } from './browser/protocol'
import type { SqliteStore } from './store'
import type { AppSnapshot } from '../shared/app'
import { FfmpegRunner } from './media-runner'
import { isTargetDue, randomRequestGap } from './scheduling'
import type { QueryBlockKind, QueryIssue } from '@xhs-live-recorder/core'
import { toQueryIssue } from '../shared/query-error'

const blockKinds: QueryBlockKind[] = [
  'AUTH',
  'VERIFICATION',
  'RESTRICTED',
  'RATE_LIMITED',
  'SIGNATURE',
  'SIGNER',
  'SCHEMA'
]

class SkippedQuery extends Error {}

function matchingCandidates(candidates: Candidate[], userId?: string | null): Candidate[] {
  return userId === undefined
    ? candidates
    : candidates.filter((candidate) => candidate.userId === userId)
}

export class RecorderService {
  readonly engine: RecordingEngine
  readonly disk = new FileSystemDisk()
  paused = false
  queryBlockKind: AppSnapshot['queryBlockKind'] = null
  queryError: QueryIssue | null = null
  private lastKeyword: string | null = null
  private candidateSearch: AppSnapshot['candidateSearch'] = null
  private candidateSearchId = 0
  private pendingCandidateSearch: { id: number; keyword: string; userId?: string | null } | null =
    null
  get authBlocked(): boolean {
    return this.queryBlockKind !== null
  }
  private abort = new AbortController()
  private loop: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined
  private diskChecking = false
  private disks: DiskStatus[] = []
  private diskLevels = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private lastRequest = 0
  private rateUntil = 0
  private candidates = new Map<string, Candidate>()
  private authVersion = 0
  private authRecoveryRequested = false
  private blockVersion = 0
  private pendingConfirmations = new Map<string, { runId: string; generation: number }>()
  private seenEndEvents = new Set<string>()
  private removing = new Map<string, Promise<void>>()
  constructor(
    readonly store: SqliteStore,
    readonly browser: XhsBrowserService,
    binary: string,
    private changed: () => void,
    private notify: (title: string, message: string, targetId: string | null) => void,
    private random: () => number = Math.random
  ) {
    const status = store.accountStatus()
    this.queryBlockKind = blockKinds.includes(status as QueryBlockKind)
      ? (status as QueryBlockKind)
      : status === 'verification_required'
        ? 'AUTH'
        : null
    this.queryError =
      store.queryIssue() ??
      (this.queryBlockKind
        ? new BrowserQueryError('上次查询尚未恢复，请按提示处理后重试。', this.queryBlockKind).issue
        : null)
    if (this.queryBlockKind === 'RATE_LIMITED')
      this.rateUntil = this.queryError?.retryAt
        ? Date.parse(this.queryError.retryAt)
        : Date.now() + 60000
    this.authVersion = browser.snapshot().authVersion ?? 0
    this.engine = new RecordingEngine(
      store,
      new FfmpegRunner(binary),
      this.disk,
      changed,
      undefined,
      (run) => this.streamEnded(run)
    )
  }

  snapshot(): AppSnapshot {
    return {
      targets: this.store.targets(),
      runs: this.store.runs(),
      settings: this.store.settings(),
      notices: this.store.notices(),
      disks: this.disks,
      paused: this.paused,
      authBlocked: this.authBlocked,
      queryBlockKind: this.queryBlockKind,
      queryError: this.queryError,
      pendingConfirmations: [...this.pendingConfirmations.keys()],
      candidateSearch: this.candidateSearch,
      browser: this.browser.snapshot()
    }
  }

  start(): void {
    this.loop = this.poll()
    this.timer = setInterval(() => {
      void this.checkDisks()
    }, 10000)
    void this.checkDisks()
  }
  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const authorization = this.browser.snapshot()
      const version = authorization.authVersion ?? 0
      if (version !== this.authVersion) {
        this.authVersion = version
        if (
          !authorization.queryReady &&
          (this.pendingCandidateSearch || this.lastKeyword || this.store.targets().length)
        )
          this.authRecoveryRequested = true
      }
      // Login validation is a read-only probe, including before the first target
      // is added or while monitoring is paused. It cannot start a recording.
      if (this.authRecoveryRequested && Date.now() >= this.rateUntil) {
        const keyword =
          this.pendingCandidateSearch?.keyword ??
          this.lastKeyword ??
          this.store.targets()[0]?.keyWord
        this.authRecoveryRequested = false
        if (keyword) await this.search(keyword, { authorizationProbe: true }).catch(() => undefined)
      }
      if (this.canQueryAutomatically()) {
        for (const target of this.store.targets()) {
          if (this.abort.signal.aborted || !this.canQueryAutomatically()) break
          const current = this.store.target(target.id)
          const recording = this.engine.activeRuns.some(
            (run) =>
              run.targetId === target.id &&
              ['starting', 'recording', 'retry_wait'].includes(run.state)
          )
          const pending = this.pendingConfirmations.get(target.id)
          const needsConfirmation =
            pending?.generation === current?.generation && !this.engine.isActive(target.id)
          if (
            current &&
            current.enabled &&
            (this.authRecoveryRequested ||
              needsConfirmation ||
              isTargetDue(current, this.store.settings(), Date.now(), recording))
          )
            await this.check(target.id, true).catch(() => undefined)
        }
      }
      // Each target owns its deadline; a long round does not reset all targets' clocks.
      await delay(1000, this.abort.signal)
    }
  }
  private canQueryAutomatically(): boolean {
    return (
      !this.abort.signal.aborted &&
      !this.paused &&
      Date.now() >= this.rateUntil &&
      (!this.queryBlockKind ||
        this.queryBlockKind === 'RATE_LIMITED' ||
        ((this.queryBlockKind === 'AUTH' || this.queryBlockKind === 'VERIFICATION') &&
          this.authRecoveryRequested))
    )
  }
  private streamEnded(run: RecordingRun): void {
    if (this.abort.signal.aborted || this.seenEndEvents.has(run.id)) return
    this.seenEndEvents.add(run.id)
    const target = this.store.target(run.targetId)
    if (target?.enabled)
      this.pendingConfirmations.set(target.id, { runId: run.id, generation: target.generation })
    this.changed()
  }
  search(
    keyword: string,
    options: {
      automatic?: boolean
      authorizationProbe?: boolean
      valid?: () => boolean
      interactive?: boolean
      profileUserId?: string | null
      candidateSearchId?: number
    } = {}
  ): Promise<Candidate[]> {
    const candidateSearchId = options.interactive
      ? ++this.candidateSearchId
      : (options.candidateSearchId ??
        (options.authorizationProbe ? this.pendingCandidateSearch?.id : undefined))
    if (options.interactive) {
      const id = candidateSearchId!
      this.pendingCandidateSearch = { id, keyword, userId: options.profileUserId }
      this.candidateSearch = { id, candidates: null }
      this.changed()
    }
    const blockVersion = this.blockVersion
    const validate = (): void => {
      if (this.abort.signal.aborted) throw new SkippedQuery('应用正在退出')
      if (
        options.authorizationProbe &&
        this.browser.snapshot().queryReady &&
        (candidateSearchId === undefined || this.pendingCandidateSearch?.id !== candidateSearchId)
      )
        throw new SkippedQuery('当前会话已验证，取消重复查询')
      if (options.valid && !options.valid()) throw new SkippedQuery('目标已移除或已更新')
      if (options.automatic && !this.canQueryAutomatically())
        throw new SkippedQuery('自动查询已暂停')
      if (this.queryBlockKind && blockVersion !== this.blockVersion)
        throw new SkippedQuery('网站限制后取消排队查询')
    }
    const job = this.queue.then(async () => {
      validate()
      if (Date.now() < this.rateUntil)
        throw new BrowserQueryError('网站仍处于查询冷却期。', 'RATE_LIMITED', {
          retryAt: new Date(this.rateUntil).toISOString()
        })
      const gap = randomRequestGap(this.store.settings().requestIntervalMs, this.random)
      await delay(
        this.lastRequest ? Math.max(0, gap - (Date.now() - this.lastRequest)) : 0,
        this.abort.signal
      )
      validate()
      if (options.automatic) this.authRecoveryRequested = false
      this.lastRequest = Date.now()
      this.lastKeyword = keyword
      try {
        const result = await this.browser.search(keyword)
        if (options.valid && !options.valid()) throw new SkippedQuery('目标已移除或已更新')
        this.queryBlockKind = null
        this.authRecoveryRequested = false
        this.authVersion = this.browser.snapshot().authVersion ?? this.authVersion
        this.queryError = null
        this.rateUntil = 0
        this.store.clearAccountErrors()
        this.store.account('ready')
        for (const candidate of result)
          if (candidate.userId) this.candidates.set(candidate.userId, candidate)
        while (this.candidates.size > 100)
          this.candidates.delete(this.candidates.keys().next().value!)
        const pending = this.pendingCandidateSearch
        if (pending && pending.id === candidateSearchId && pending.keyword === keyword) {
          this.candidateSearch = {
            id: pending.id,
            candidates: matchingCandidates(result, pending.userId)
          }
          this.pendingCandidateSearch = null
        }
        return matchingCandidates(result, options.profileUserId)
      } catch (error) {
        if (options.valid && !options.valid()) throw new SkippedQuery('目标已移除或已更新')
        if (error instanceof BrowserQueryError && error.kind === 'SESSION_CHANGED')
          throw new SkippedQuery('会话变化，等待重新查询')
        this.queryError = toQueryIssue(error)
        if (
          error instanceof BrowserQueryError &&
          blockKinds.includes(error.kind as QueryBlockKind)
        ) {
          if (this.queryBlockKind !== error.kind)
            this.sendNotice(error.issue.title, error.issue.help, null)
          this.queryBlockKind = error.kind as AppSnapshot['queryBlockKind']
          this.authRecoveryRequested = false
          this.blockVersion++
        }
        if (error instanceof BrowserQueryError && error.kind === 'RATE_LIMITED')
          this.rateUntil = Math.max(Date.now() + 60000, Date.parse(error.issue.retryAt ?? '') || 0)
        this.store.account(this.queryBlockKind ?? 'ready', this.queryError)
        throw error
      } finally {
        this.lastRequest = Date.now()
        this.changed()
      }
    })
    this.queue = job.catch(() => undefined)
    return job
  }
  async retryQuery(targetId?: string): Promise<Candidate[] | void> {
    if (targetId) {
      await this.check(targetId)
      return
    }
    const pending = this.pendingCandidateSearch
    if (pending)
      return matchingCandidates(
        await this.search(pending.keyword, { candidateSearchId: pending.id }),
        pending.userId
      )
    const target =
      this.store.targets().find((t) => t.enabled && t.errorKind) ??
      this.store.targets().find((t) => t.enabled)
    if (target) {
      await this.check(target.id)
      return
    }
    if (this.lastKeyword) {
      return this.search(this.lastKeyword, { interactive: true })
    }
    throw new Error('请先输入小红书号或选择一个主播进行查询')
  }
  async profile(): Promise<Candidate[]> {
    const profile = await this.browser.currentProfile()
    return this.search(profile.keyWord, { interactive: true, profileUserId: profile.userId })
  }
  add(userId: string): Target {
    const candidate = this.candidates.get(userId)
    if (!candidate) throw new Error('搜索结果已更新，请重新搜索后确认主播')
    const existing = this.store.findAccount(userId)
    if (existing && this.removing.has(existing.id)) {
      throw new Error('该主播正在收尾，请稍后重新添加')
    }
    const target = this.store.add(candidate)
    this.changed()
    void this.check(target.id, true).catch(() => undefined)
    return target
  }
  async check(id: string, automatic = false): Promise<void> {
    const original = this.requireTarget(id)
    const valid = (): boolean => {
      const current = this.store.target(id)
      return current?.generation === original.generation && (!automatic || current.enabled)
    }
    try {
      const candidates = await this.search(original.keyWord, {
        automatic,
        valid
      })
      if (!valid()) return
      this.pendingConfirmations.delete(id)
      const match = candidates.find((candidate) => candidate.userId === original.userId)
      if (!match)
        throw new BrowserQueryError('搜索结果未匹配已添加的主播，保留上次明确状态', 'MATCH')
      const current = this.requireTarget(id)
      const next: Target = {
        ...current,
        ...match,
        state: match.state === 'unknown' ? current.state : match.state,
        checkedAt: new Date().toISOString(),
        error: match.state === 'unknown' ? '网站未返回明确直播状态' : null,
        errorKind: match.state === 'unknown' ? 'UNKNOWN' : null,
        queryError:
          match.state === 'unknown'
            ? new BrowserQueryError('网站未返回明确直播状态。', 'UNKNOWN').issue
            : null,
        lastConfirmedAt:
          match.state === 'unknown' ? current.lastConfirmedAt : new Date().toISOString()
      }
      if (match.state === 'unknown') {
        next.roomId = current.roomId
        this.store.saveTarget(next)
        return
      }
      if (
        match.state === 'live' &&
        next.blockedReason === 'manual' &&
        next.blockedRoomId !== next.roomId
      ) {
        next.blockedReason = null
        next.blockedRoomId = null
      }
      this.store.saveTarget(next)
      if (match.state === 'offline') {
        await this.engine.stop(id, 'offline')
        return
      }
      if (this.store.observeSession(next))
        this.sendNotice(`${next.name} 开播了`, '点击观看原直播网页', id)
      const active = this.engine.activeRuns.find((run) => run.targetId === id)
      if (
        active &&
        active.sourceUrl !==
          `https://live-source-play-hw.xhscdn.com/live/${encodeURIComponent(next.roomId ?? '')}.flv`
      )
        await this.engine.stop(id, 'offline')
      if (!valid()) return
      const latest = this.requireTarget(id)
      if (
        !this.paused &&
        (!automatic || this.canQueryAutomatically()) &&
        latest.enabled &&
        latest.autoRecord &&
        !latest.blockedReason &&
        latest.retryAt <= Date.now() &&
        this.store.settings().outputConfigured
      )
        this.engine.start(latest)
    } catch (error) {
      if (error instanceof SkippedQuery || !valid()) return
      this.pendingConfirmations.delete(id)
      const current = this.requireTarget(id)
      this.store.saveTarget({
        ...current,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : '查询失败',
        errorKind: error instanceof BrowserQueryError ? error.kind : 'UNKNOWN',
        queryError: toQueryIssue(error)
      })
      throw error
    } finally {
      this.changed()
    }
  }
  update(id: string, patch: { enabled?: boolean; notify?: boolean; autoRecord?: boolean }): void {
    const target = this.requireTarget(id)
    this.store.saveTarget({ ...target, ...patch })
    this.changed()
  }
  remove(id: string): Promise<void> {
    const existing = this.removing.get(id)
    if (existing) return existing
    if (!this.store.target(id)) return Promise.resolve()
    this.store.remove(id)
    this.pendingConfirmations.delete(id)
    this.changed()
    const job = this.engine.stop(id, 'removed').finally(() => {
      this.removing.delete(id)
      this.changed()
    })
    this.removing.set(id, job)
    return job
  }
  async record(id: string): Promise<void> {
    const target = this.requireTarget(id)
    this.store.saveTarget({ ...target, blockedReason: null, blockedRoomId: null, retryAt: 0 })
    await this.check(id)
    const latest = this.requireTarget(id)
    if (latest.generation !== target.generation || latest.error)
      throw new Error('未能确认当前直播，请重新检查')
    this.engine.start(latest)
  }
  async stop(id: string): Promise<void> {
    const target = this.requireTarget(id)
    this.store.saveTarget({ ...target, blockedReason: 'manual', blockedRoomId: target.roomId })
    await this.engine.stop(id, 'manual')
    this.changed()
  }
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.engine.activeRuns.map((run) => this.stop(run.targetId)))
  }
  async resume(id: string): Promise<void> {
    await this.record(id)
  }
  setPaused(value: boolean): void {
    this.paused = value
    this.changed()
  }
  async checkDisks(): Promise<void> {
    if (this.diskChecking || this.abort.signal.aborted) return
    this.diskChecking = true
    try {
      const settings = this.store.settings()
      const directories = new Set([
        settings.outputDir,
        ...this.engine.activeRuns.map((run) => run.directory)
      ])
      this.disks = await Promise.all(
        [...directories].map((directory) => this.disk.probe(directory, settings))
      )
      for (const disk of this.disks) {
        if (
          settings.outputConfigured &&
          disk.level !== 'ok' &&
          this.diskLevels.get(disk.directory) !== disk.level
        ) {
          this.sendNotice(
            '录制磁盘提醒',
            `${disk.directory}：${disk.level === 'warning' ? '可用空间低于告警阈值' : '空间不足或不可写，请处理后恢复录制'}`,
            null
          )
        }
        this.diskLevels.set(disk.directory, disk.level)
      }
      await this.engine.checkDisks()
      for (const run of this.engine.activeRuns)
        if (run.state !== 'merging') await this.engine.indexFiles(run)
    } finally {
      this.diskChecking = false
      this.changed()
    }
  }
  settingsChanged(): void {
    void this.checkDisks()
    this.changed()
  }
  private sendNotice(title: string, message: string, targetId: string | null): void {
    this.store.notice(title, message, targetId)
    this.notify(title, message, targetId)
  }
  private requireTarget(id: string): Target {
    const target = this.store.target(id)
    if (!target) throw new Error('找不到监听对象')
    return target
  }
  async close(): Promise<void> {
    this.abort.abort()
    if (this.timer) clearInterval(this.timer)
    await this.engine.stopAll('exit')
    await this.browser.dispose()
    await this.queue
    await this.loop
    while (this.diskChecking) await delay(20)
  }
}
