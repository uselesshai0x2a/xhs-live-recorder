import type {
  Candidate,
  DiskStatus,
  Notice,
  RecordingFile,
  RecordingRun,
  Settings,
  Target
} from '@xhs-live-recorder/core'
import type { QueryIssue, QueryBlockKind, QueryRecoveryAction } from '@xhs-live-recorder/core'
import type { BrowserSnapshot } from './browser'
export interface AppSnapshot {
  targets: Target[]
  runs: RecordingRun[]
  settings: Settings
  disks: DiskStatus[]
  notices: Notice[]
  paused: boolean
  authBlocked: boolean
  queryBlockKind: QueryBlockKind | null
  queryError: QueryIssue | null
  pendingConfirmations: string[]
  candidateSearch: { id: number; candidates: Candidate[] | null } | null
  browser: BrowserSnapshot
}
export interface AppApi {
  recoverQuery(action: QueryRecoveryAction, targetId?: string): Promise<Candidate[] | void>
  copyDiagnostic(id: string): Promise<void>
  snapshot(): Promise<AppSnapshot>
  search(keyword: string): Promise<Candidate[]>
  profile(): Promise<Candidate[]>
  add(userId: string): Promise<Target>
  removeTarget(id: string): Promise<void>
  updateTarget(
    id: string,
    patch: { enabled?: boolean; notify?: boolean; autoRecord?: boolean }
  ): Promise<void>
  check(id: string): Promise<void>
  record(id: string): Promise<void>
  stop(id: string): Promise<void>
  resume(id: string): Promise<void>
  pause(paused: boolean): Promise<void>
  watch(id: string): Promise<void>
  page(page: 'targets' | 'browser' | 'recordings' | 'settings'): Promise<void>
  chooseDirectory(): Promise<string | null>
  saveSettings(settings: Settings): Promise<void>
  merge(id: string): Promise<void>
  files(id: string): Promise<RecordingFile[]>
  reveal(id: string): Promise<void>
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void
  onWatch(listener: () => void): () => void
}
