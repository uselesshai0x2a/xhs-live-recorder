export type RecordingTaskState =
  | "starting"
  | "recording"
  | "retry_wait"
  | "stopping"
  | "merging"
  | "completed"
  | "stopped"
  | "failed";

export interface RecordingSegmentationConfig {
  readonly enabled: boolean;
  readonly durationSeconds: number;
  readonly autoMerge: boolean;
  readonly keepSegments: boolean;
}

export interface RecordingConfig {
  readonly enabled: boolean;
  readonly outputDirectory: string;
  readonly segmentation: RecordingSegmentationConfig;
  readonly videoBitrate: "source" | string;
  readonly retryDelaysMs: readonly number[];
  readonly gracefulStopTimeoutMs: number;
}

export interface RecordingOptionsOverride {
  readonly segmentation?: Partial<RecordingSegmentationConfig>;
  readonly videoBitrate?: "source" | string;
  readonly retryDelaysMs?: readonly number[];
  readonly gracefulStopTimeoutMs?: number;
}

export interface StartRecordingCommand {
  readonly taskId?: string;
  readonly taskIdentity?: RecordingTaskIdentity;
  readonly sourceUrl: string;
  readonly outputName: string;
  readonly signal?: AbortSignal;
  readonly options?: RecordingOptionsOverride;
}

export interface RecordingTaskIdentity {
  readonly platform: string;
  readonly targetKey: string;
  readonly roomKey: string;
  readonly firstObservedAt: Date;
}

export interface RecordingResult {
  readonly taskId: string;
  readonly sourceUrl: string;
  readonly state: "completed" | "stopped" | "failed";
  readonly outputPath: string | null;
  readonly segmentPaths: readonly string[];
  readonly startedAt: Date;
  readonly endedAt: Date;
}

export interface RecordingHandle {
  readonly taskId: string;
  readonly sourceUrl: string;
  readonly status: RecordingTaskStatus;
  readonly outputPath: string;
  readonly segmentPaths: readonly string[];
  readonly completion: Promise<RecordingResult>;
}

export type RecordingSelector =
  | { readonly taskId: string }
  | { readonly sourceUrl: string };

export type RecordingTaskStatus = "nonexistent" | "stopped" | "running";

export interface RecordingTaskSnapshot {
  readonly taskId: string;
  readonly status: RecordingTaskStatus;
}

export interface RecordingEvent {
  readonly kind:
    | "started"
    | "segment_created"
    | "interrupted"
    | "retrying"
    | "merge_started"
    | "merge_completed"
    | "completed"
    | "stopped"
    | "failed"
    | "skipped";
  readonly taskId?: string;
  readonly outputName: string;
  readonly occurredAt: Date;
  readonly path?: string;
  readonly attempt?: number;
  readonly message?: string;
}

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly taskId: string,
    readonly partialPath: string | null = null,
    options: { cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RecordingError";
  }
}
