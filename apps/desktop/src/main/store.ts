import Database from 'better-sqlite3'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  defaultSettings,
  type Candidate,
  type Notice,
  type RecorderRepository,
  type RecordingFile,
  type RecordingRun,
  type Settings,
  type Target,
  validateSettings
} from '@xhs-live-recorder/core'

export class SqliteStore implements RecorderRepository {
  readonly db: Database.Database
  constructor(file: string, defaultDirectory: string) {
    this.db = new Database(file)
    try {
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('busy_timeout = 5000')
      this.db.transaction(() => {
        const version = this.db.pragma('user_version', { simple: true }) as number
        if (version > 2) throw new Error('数据库由更新版本创建，请使用对应版本应用')
        if (version === 0) {
          this.db.exec(`
          CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), outputDir TEXT NOT NULL, outputConfigured INTEGER NOT NULL, intervalMs INTEGER NOT NULL, requestIntervalMs INTEGER NOT NULL, warningGiB REAL NOT NULL, stopGiB REAL NOT NULL, segmentSeconds INTEGER NOT NULL, autoMerge INTEGER NOT NULL, keepSegments INTEGER NOT NULL, videoBitrate TEXT NOT NULL, startAtLogin INTEGER NOT NULL);
          CREATE TABLE targets (id TEXT PRIMARY KEY, keyWord TEXT UNIQUE NOT NULL, userId TEXT, name TEXT NOT NULL, state TEXT NOT NULL, roomId TEXT, pageUrl TEXT, enabled INTEGER NOT NULL, notify INTEGER NOT NULL, autoRecord INTEGER NOT NULL, checkedAt TEXT, error TEXT, blockedRoomId TEXT, blockedReason TEXT, retryAt INTEGER NOT NULL);
          CREATE TABLE tasks (taskId TEXT NOT NULL, root TEXT NOT NULL, directory TEXT NOT NULL, PRIMARY KEY(taskId, root));
          CREATE TABLE runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, targetId TEXT NOT NULL REFERENCES targets(id), name TEXT NOT NULL, sourceUrl TEXT NOT NULL, directory TEXT NOT NULL, workDirectory TEXT NOT NULL, state TEXT NOT NULL, mergeState TEXT NOT NULL, outputPath TEXT, startedAt TEXT NOT NULL, endedAt TEXT, message TEXT, stopReason TEXT);
          CREATE TABLE files (runId TEXT NOT NULL REFERENCES runs(id), path TEXT NOT NULL, bytes INTEGER NOT NULL, kind TEXT NOT NULL, present INTEGER NOT NULL, PRIMARY KEY(runId,path));
          CREATE TABLE notices (id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, targetId TEXT, createdAt TEXT NOT NULL);
          CREATE TABLE live_sessions (targetId TEXT NOT NULL REFERENCES targets(id), roomId TEXT NOT NULL, firstSeen TEXT NOT NULL, lastSeen TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(targetId,roomId));
          CREATE TABLE account (id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL, updatedAt TEXT NOT NULL);
          CREATE INDEX runs_started ON runs(startedAt DESC);
          PRAGMA user_version=1;
        `)
          this.saveSettings(defaultSettings(defaultDirectory))
        }
        if (version < 2) {
          this.db.exec(`
          ALTER TABLE targets ADD COLUMN archivedAt TEXT;
          ALTER TABLE targets ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE targets ADD COLUMN errorKind TEXT;
          ALTER TABLE targets ADD COLUMN lastConfirmedAt TEXT;
          UPDATE targets SET errorKind='NETWORK' WHERE error IS NOT NULL;
          UPDATE targets SET lastConfirmedAt=checkedAt WHERE error IS NULL AND state IN ('live','offline');
          PRAGMA user_version=2;
        `)
        }
      })()
      this.recover()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  settings(): Settings {
    const row = this.db.prepare('SELECT * FROM settings WHERE id=1').get() as Settings
    return {
      ...row,
      outputConfigured: Boolean(row.outputConfigured),
      autoMerge: Boolean(row.autoMerge),
      keepSegments: Boolean(row.keepSegments),
      startAtLogin: Boolean(row.startAtLogin)
    }
  }
  saveSettings(settings: Settings): void {
    const s = validateSettings(settings)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settings VALUES(1,@outputDir,@outputConfigured,@intervalMs,@requestIntervalMs,@warningGiB,@stopGiB,@segmentSeconds,@autoMerge,@keepSegments,@videoBitrate,@startAtLogin)`
      )
      .run({
        ...s,
        outputConfigured: +s.outputConfigured,
        autoMerge: +s.autoMerge,
        keepSegments: +s.keepSegments,
        startAtLogin: +s.startAtLogin
      })
  }
  private decode(row: Target | undefined): Target | undefined {
    return row
      ? {
          ...row,
          enabled: Boolean(row.enabled),
          notify: Boolean(row.notify),
          autoRecord: Boolean(row.autoRecord)
        }
      : undefined
  }
  targets(): Target[] {
    return (
      this.db
        .prepare('SELECT * FROM targets WHERE archivedAt IS NULL ORDER BY name')
        .all() as Target[]
    ).map((row) => this.decode(row)!)
  }
  target(id: string): Target | undefined {
    return this.decode(
      this.db.prepare('SELECT * FROM targets WHERE id=? AND archivedAt IS NULL').get(id) as
        Target | undefined
    )
  }
  add(candidate: Candidate): Target {
    return this.db.transaction(() => this.addAccount(candidate))()
  }
  findAccount(userId: string): Target | undefined {
    return this.decode(
      this.db.prepare('SELECT * FROM targets WHERE userId=? LIMIT 1').get(userId) as
        Target | undefined
    )
  }
  private addAccount(candidate: Candidate): Target {
    const existing = this.db
      .prepare('SELECT * FROM targets WHERE userId=? OR keyWord=? ORDER BY userId=? DESC LIMIT 1')
      .get(candidate.userId, candidate.keyWord, candidate.userId) as Target | undefined
    if (existing && existing.userId !== candidate.userId)
      throw new Error('该小红书号已关联其他账号，请核对身份')
    if (existing && !existing.archivedAt) return this.decode(existing)!
    if (existing) {
      this.db
        .prepare('UPDATE targets SET archivedAt=NULL,generation=generation+1 WHERE id=?')
        .run(existing.id)
    }
    const target: Target = {
      ...candidate,
      id: existing?.id ?? randomUUID(),
      enabled: true,
      notify: true,
      autoRecord: true,
      checkedAt: null,
      error: null,
      blockedRoomId: null,
      blockedReason: null,
      retryAt: 0,
      archivedAt: null,
      generation: existing ? existing.generation + 1 : 0,
      errorKind: null,
      lastConfirmedAt: candidate.state === 'unknown' ? null : new Date().toISOString()
    }
    this.saveTarget(target)
    return target
  }
  saveTarget(t: Target): void {
    this.db
      .prepare(
        `INSERT INTO targets VALUES(@id,@keyWord,@userId,@name,@state,@roomId,@pageUrl,@enabled,@notify,@autoRecord,@checkedAt,@error,@blockedRoomId,@blockedReason,@retryAt,@archivedAt,@generation,@errorKind,@lastConfirmedAt)
      ON CONFLICT(id) DO UPDATE SET keyWord=excluded.keyWord,userId=excluded.userId,name=excluded.name,state=excluded.state,roomId=excluded.roomId,pageUrl=excluded.pageUrl,enabled=excluded.enabled,notify=excluded.notify,autoRecord=excluded.autoRecord,checkedAt=excluded.checkedAt,error=excluded.error,blockedRoomId=excluded.blockedRoomId,blockedReason=excluded.blockedReason,retryAt=excluded.retryAt,errorKind=excluded.errorKind,lastConfirmedAt=excluded.lastConfirmedAt
      WHERE targets.generation=excluded.generation AND targets.archivedAt IS excluded.archivedAt`
      )
      .run({ ...t, enabled: +t.enabled, notify: +t.notify, autoRecord: +t.autoRecord })
  }
  remove(id: string): void {
    // Historical runs retain their owning target; removal archives the listener.
    this.db
      .prepare(
        'UPDATE targets SET archivedAt=?,generation=generation+1,enabled=0,notify=0,autoRecord=0 WHERE id=? AND archivedAt IS NULL'
      )
      .run(new Date().toISOString(), id)
  }
  clearAccountErrors(): void {
    this.db
      .prepare(
        "UPDATE targets SET error=NULL,errorKind=NULL WHERE errorKind IN ('AUTH','RESTRICTED','RATE_LIMITED')"
      )
      .run()
  }
  accountStatus(): string | null {
    return (
      (
        this.db.prepare('SELECT status FROM account WHERE id=1').get() as
          { status: string } | undefined
      )?.status ?? null
    )
  }
  taskDirectory(taskId: string, proposed: string): string {
    const root = path.dirname(proposed)
    this.db.prepare('INSERT OR IGNORE INTO tasks VALUES(?,?,?)').run(taskId, root, proposed)
    return (
      this.db
        .prepare('SELECT directory FROM tasks WHERE taskId=? AND root=?')
        .get(taskId, root) as { directory: string }
    ).directory
  }
  saveRun(run: RecordingRun): void {
    this.db
      .prepare(
        `INSERT INTO runs VALUES(@id,@taskId,@targetId,@name,@sourceUrl,@directory,@workDirectory,@state,@mergeState,@outputPath,@startedAt,@endedAt,@message,@stopReason)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,mergeState=excluded.mergeState,outputPath=excluded.outputPath,endedAt=excluded.endedAt,message=excluded.message,stopReason=excluded.stopReason`
      )
      .run(run)
  }
  run(id: string): RecordingRun | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RecordingRun | undefined
  }
  runs(): RecordingRun[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT 500')
      .all() as RecordingRun[]
  }
  files(runId: string): RecordingFile[] {
    return (
      this.db
        .prepare('SELECT path,bytes,kind,present FROM files WHERE runId=? ORDER BY path')
        .all(runId) as (RecordingFile & { present: number })[]
    ).map((row) => ({
      path: row.path,
      bytes: row.bytes,
      kind: row.kind,
      exists: Boolean(row.present)
    }))
  }
  replaceFiles(runId: string, files: RecordingFile[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE runId=?').run(runId)
      const insert = this.db.prepare('INSERT INTO files VALUES(?,?,?,?,?)')
      for (const file of files) insert.run(runId, file.path, file.bytes, file.kind, +file.exists)
    })()
  }
  observeSession(target: Target): boolean {
    if (!target.roomId) return false
    const now = new Date().toISOString()
    return this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO live_sessions VALUES(?,?,?,?,0) ON CONFLICT(targetId,roomId) DO UPDATE SET lastSeen=excluded.lastSeen'
        )
        .run(target.id, target.roomId, now, now)
      if (!target.notify) return false
      return (
        this.db
          .prepare(
            'UPDATE live_sessions SET notified=1 WHERE targetId=? AND roomId=? AND notified=0'
          )
          .run(target.id, target.roomId).changes > 0
      )
    })()
  }
  notice(title: string, message: string, targetId: string | null = null): Notice {
    const notice = {
      id: randomUUID(),
      title,
      message,
      targetId,
      createdAt: new Date().toISOString()
    }
    this.db
      .prepare('INSERT INTO notices VALUES(@id,@title,@message,@targetId,@createdAt)')
      .run(notice)
    this.db
      .prepare(
        'DELETE FROM notices WHERE id NOT IN (SELECT id FROM notices ORDER BY createdAt DESC LIMIT 200)'
      )
      .run()
    return notice
  }
  notices(): Notice[] {
    return this.db
      .prepare('SELECT * FROM notices ORDER BY createdAt DESC LIMIT 50')
      .all() as Notice[]
  }
  account(status: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO account VALUES(1,?,?)')
      .run(status, new Date().toISOString())
  }
  private recover(): void {
    this.db
      .prepare(
        "UPDATE runs SET state='interrupted',mergeState='pending',endedAt=?,message='上次运行未正常结束，已保留分片' WHERE state IN ('starting','recording','retry_wait','stopping','merging')"
      )
      .run(new Date().toISOString())
    const insert = this.db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)')
    for (const run of this.runs()) {
      try {
        for (const name of readdirSync(run.workDirectory).filter((name) =>
          /^attempt-\d+-part-\d+\.flv$/.test(name)
        )) {
          const file = path.join(run.workDirectory, name)
          insert.run(run.id, file, statSync(file).size, 'segment', 1)
        }
      } catch {
        /* Removable recording disks may be offline at startup. */
      }
    }
    const rows = this.db.prepare('SELECT runId,path FROM files').all() as {
      runId: string
      path: string
    }[]
    const update = this.db.prepare('UPDATE files SET present=? WHERE runId=? AND path=?')
    for (const row of rows) update.run(+existsSync(row.path), row.runId, row.path)
  }
  close(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.close()
  }
}
