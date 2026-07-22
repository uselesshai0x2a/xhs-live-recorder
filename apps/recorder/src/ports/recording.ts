import type {
  RecordingEvent,
  RecordingHandle,
  RecordingResult,
  RecordingSelector,
  RecordingTaskSnapshot,
  StartRecordingCommand,
} from "../domain/recording";

export interface RecordingManagerPort {
  start(command: StartRecordingCommand): Promise<RecordingHandle>;
  stop(
    selector: RecordingSelector,
    signal?: AbortSignal,
  ): Promise<RecordingResult>;
  stopAll(signal?: AbortSignal): Promise<RecordingResult[]>;
  readonly activeCount: number;
  waitForIdle(): Promise<void>;
  getTask(taskId: string): Promise<RecordingTaskSnapshot>;
}

export interface RecordingEventSink {
  deliver(event: RecordingEvent): Promise<void>;
}

export interface RunningFfmpegProcess {
  readonly completion: Promise<FfmpegExit>;
  requestQuit(): void;
  terminate(): void;
}

export interface FfmpegExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export interface FfmpegRunner {
  start(args: readonly string[]): RunningFfmpegProcess;
}
