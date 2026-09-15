export type LiveState = "live" | "offline" | "unknown";
export type BlockReason = "manual" | "disk" | "output" | null;
export type QueryErrorKind =
  | "AUTH"
  | "RESTRICTED"
  | "RATE_LIMITED"
  | "NETWORK"
  | "SCHEMA"
  | "MATCH"
  | "UNKNOWN";
export interface Candidate {
  keyWord: string;
  userId: string | null;
  name: string;
  state: LiveState;
  roomId: string | null;
  pageUrl: string | null;
}
export interface Target extends Candidate {
  id: string;
  enabled: boolean;
  notify: boolean;
  autoRecord: boolean;
  checkedAt: string | null;
  error: string | null;
  blockedRoomId: string | null;
  blockedReason: BlockReason;
  retryAt: number;
  archivedAt: string | null;
  generation: number;
  errorKind: QueryErrorKind | null;
  lastConfirmedAt: string | null;
}
export interface Settings {
  outputDir: string;
  outputConfigured: boolean;
  intervalMs: number;
  requestIntervalMs: number;
  warningGiB: number;
  stopGiB: number;
  segmentSeconds: number;
  autoMerge: boolean;
  keepSegments: boolean;
  videoBitrate: string;
  startAtLogin: boolean;
}
export const defaultSettings = (outputDir: string): Settings => ({
  outputDir,
  outputConfigured: false,
  intervalMs: 120000,
  requestIntervalMs: 5000,
  warningGiB: 10,
  stopGiB: 2,
  segmentSeconds: 1800,
  autoMerge: true,
  keepSegments: false,
  videoBitrate: "source",
  startAtLogin: false,
});
export type RunState =
  | "starting"
  | "recording"
  | "retry_wait"
  | "stopping"
  | "merging"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";
export interface RecordingRun {
  id: string;
  taskId: string;
  targetId: string;
  name: string;
  sourceUrl: string;
  directory: string;
  workDirectory: string;
  state: RunState;
  mergeState: "none" | "pending" | "completed";
  outputPath: string | null;
  startedAt: string;
  endedAt: string | null;
  message: string | null;
  stopReason: BlockReason | "offline" | "exit" | "removed";
}
export interface RecordingFile {
  path: string;
  bytes: number;
  kind: "segment" | "output";
  exists: boolean;
}
export interface DiskStatus {
  directory: string;
  totalBytes: number;
  freeBytes: number;
  level: "ok" | "warning" | "stop" | "unavailable";
  message: string | null;
}
export interface Notice {
  id: string;
  title: string;
  message: string;
  targetId: string | null;
  createdAt: string;
}
export interface RecorderRepository {
  settings(): Settings;
  targets(): Target[];
  target(id: string): Target | undefined;
  saveTarget(target: Target): void;
  taskDirectory(taskId: string, proposed: string): string;
  saveRun(run: RecordingRun): void;
  run(id: string): RecordingRun | undefined;
  runs(): RecordingRun[];
  files(runId: string): RecordingFile[];
  replaceFiles(runId: string, files: RecordingFile[]): void;
}
export interface BrowserQueryPort {
  search(keyword: string): Promise<Candidate[]>;
}
export interface DiskPort {
  probe(directory: string, settings: Settings): Promise<DiskStatus>;
}
export interface ProcessExit {
  code: number | null;
  stderr: string;
}
export interface MediaProcess {
  completion: Promise<ProcessExit>;
  quit(): void;
  kill(): void;
}
export interface MediaRunner {
  start(args: string[]): MediaProcess;
}

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效设置");
  const input = value as Settings;
  if (
    typeof input.outputDir !== "string" ||
    !input.outputDir.trim() ||
    input.outputDir.length > 240
  )
    throw new Error("请选择有效的录制目录");
  for (const key of [
    "outputConfigured",
    "autoMerge",
    "keepSegments",
    "startAtLogin",
  ] as const) {
    if (typeof input[key] !== "boolean") throw new Error("无效设置开关");
  }
  for (const key of [
    "intervalMs",
    "requestIntervalMs",
    "warningGiB",
    "stopGiB",
    "segmentSeconds",
  ] as const) {
    if (!Number.isFinite(input[key]) || input[key] <= 0)
      throw new Error("时间和空间阈值必须为正数");
  }
  if (
    input.intervalMs < 1000 ||
    input.requestIntervalMs < 5000 ||
    input.segmentSeconds < 10 ||
    !Number.isInteger(input.segmentSeconds)
  )
    throw new Error("请求间隔至少 5 秒，分片至少 10 秒");
  if (input.warningGiB <= input.stopGiB)
    throw new Error("告警空间必须大于停止空间");
  if (
    typeof input.videoBitrate !== "string" ||
    !/^(source|[1-9]\d{0,5}[kKmM])$/.test(input.videoBitrate)
  )
    throw new Error("视频码率填写 source 或 4000k 等格式");
  return {
    outputDir: input.outputDir.trim(),
    outputConfigured: input.outputConfigured,
    intervalMs: Math.round(input.intervalMs),
    requestIntervalMs: Math.round(input.requestIntervalMs),
    warningGiB: input.warningGiB,
    stopGiB: input.stopGiB,
    segmentSeconds: input.segmentSeconds,
    autoMerge: input.autoMerge,
    keepSegments: input.keepSegments,
    videoBitrate: input.videoBitrate,
    startAtLogin: input.startAtLogin,
  };
}
