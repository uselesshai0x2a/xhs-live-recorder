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

class SkippedQuery extends Error {}

export class RecorderService {
  readonly engine: RecordingEngine
  readonly disk = new FileSystemDisk()
  paused = false
  queryBlockKind: AppSnapshot['queryBlockKind'] = null
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
    this.queryBlockKind =
      status === 'RESTRICTED' || status === 'AUTH' || status === 'RATE_LIMITED'
        ? status
        : status === 'verification_required'
          ? 'AUTH'
          : null
    if (this.queryBlockKind === 'RATE_LIMITED') this.rateUntil = Date.now() + 60000
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
      pendingConfirmations: [...this.pendingConfirmations.keys()],
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
      const version = this.browser.snapshot().authVersion ?? 0
      if (version !== this.authVersion) {
        this.authVersion = version
        if (this.queryBlockKind === 'AUTH') this.authRecoveryRequested = true
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
            (needsConfirmation ||
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
        (this.queryBlockKind === 'AUTH' && this.authRecoveryRequested))
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
    options: { automatic?: boolean; valid?: () => boolean } = {}
  ): Promise<Candidate[]> {
    const blockVersion = this.blockVersion
    const validate = (): void => {
      if (this.abort.signal.aborted) throw new SkippedQuery('应用正在退出')
      if (options.valid && !options.valid()) throw new SkippedQuery('目标已移除或已更新')
      if (options.automatic && !this.canQueryAutomatically())
        throw new SkippedQuery('自动查询已暂停')
      if (this.queryBlockKind && blockVersion !== this.blockVersion)
        throw new SkippedQuery('网站限制后取消排队查询')
    }
    const job = this.queue.then(async () => {
      validate()
      if (Date.now() < this.rateUntil) throw new Error('网站请求过于频繁，稍后自动恢复')
      const gap = randomRequestGap(this.store.settings().requestIntervalMs, this.random)
      await delay(
        this.lastRequest ? Math.max(0, gap - (Date.now() - this.lastRequest)) : 0,
        this.abort.signal
      )
      validate()
      if (options.automatic) this.authRecoveryRequested = false
      this.lastRequest = Date.now()
      try {
        const result = await this.browser.search(keyword)
        if (options.valid && !options.valid()) throw new SkippedQuery('目标已移除或已更新')
        this.queryBlockKind = null
        this.rateUntil = 0
        this.store.clearAccountErrors()
        this.store.account('ready')
        for (const candidate of result)
          if (candidate.userId) this.candidates.set(candidate.userId, candidate)
        while (this.candidates.size > 100)
          this.candidates.delete(this.candidates.keys().next().value!)
        return result
      } catch (error) {
        if (options.valid && !options.valid()) throw new SkippedQuery('目标已移除或已更新')
        if (
          error instanceof BrowserQueryError &&
          ['AUTH', 'RESTRICTED', 'RATE_LIMITED'].includes(error.kind)
        ) {
          if (this.queryBlockKind !== error.kind)
            this.sendNotice(
              error.kind === 'AUTH' ? '小红书需要重新验证' : '网站限制了查询',
              error.kind === 'AUTH'
                ? '请打开后台查询页完成验证，正在录制的任务会继续'
                : '已暂停自动查询，请稍后手动检查一个目标，成功后恢复监听',
              null
            )
          this.queryBlockKind = error.kind as AppSnapshot['queryBlockKind']
          this.authRecoveryRequested = false
          this.blockVersion++
          this.store.account(error.kind)
        }
        if (error instanceof BrowserQueryError && error.kind === 'RATE_LIMITED')
          this.rateUntil = Date.now() + 60000
        throw error
      } finally {
        this.lastRequest = Date.now()
        this.changed()
      }
    })
    this.queue = job.catch(() => undefined)
    return job
  }
  async profile(): Promise<Candidate[]> {
    const profile = await this.browser.currentProfile()
    const candidates = await this.search(profile.keyWord)
    return candidates.filter((candidate) => candidate.userId === profile.userId)
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
        errorKind: error instanceof BrowserQueryError ? error.kind : 'NETWORK'
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
