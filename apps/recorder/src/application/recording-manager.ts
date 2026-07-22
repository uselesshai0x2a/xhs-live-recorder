import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type RecordingConfig,
  RecordingError,
  type RecordingEvent,
  type RecordingHandle,
  type RecordingOptionsOverride,
  type RecordingResult,
  type RecordingSelector,
  type RecordingTaskIdentity,
  type RecordingTaskSnapshot,
  type RecordingTaskState,
  type StartRecordingCommand,
} from "../domain/recording";
import type {
  FfmpegExit,
  FfmpegRunner,
  RecordingEventSink,
  RecordingManagerPort,
  RunningFfmpegProcess,
} from "../ports/recording";
import { abortableDelay } from "./abortable-delay";

const RECORDING_EXTENSION = ".flv";

interface MutableTask {
  readonly taskId: string;
  readonly sourceUrl: string;
  readonly outputName: string;
  readonly baseName: string;
  readonly outputPath: string;
  readonly partialPath: string;
  readonly workDirectory: string;
  readonly startedAt: Date;
  readonly config: RecordingConfig;
  state: RecordingTaskState;
  segmentPaths: string[];
  emittedSegments: Set<string>;
  refreshPromise: Promise<void>;
  process: RunningFfmpegProcess | null;
  stopRequested: boolean;
  stopDelayController: AbortController;
  completion: Promise<RecordingResult>;
  resolve: (result: RecordingResult) => void;
  reject: (error: unknown) => void;
  detachSignal?: () => void;
}

class ManagedRecordingHandle implements RecordingHandle {
  constructor(private readonly task: MutableTask) {}
  get taskId(): string {
    return this.task.taskId;
  }
  get sourceUrl(): string {
    return this.task.sourceUrl;
  }
  get status(): "running" | "stopped" {
    return this.task.state === "completed" ||
      this.task.state === "stopped" ||
      this.task.state === "failed"
      ? "stopped"
      : "running";
  }
  get outputPath(): string {
    return this.task.outputPath;
  }
  get segmentPaths(): readonly string[] {
    return [...this.task.segmentPaths];
  }
  get completion(): Promise<RecordingResult> {
    return this.task.completion;
  }
}

export class RecordingManager implements RecordingManagerPort {
  readonly #tasksById = new Map<string, MutableTask>();
  readonly #tasksBySource = new Map<string, MutableTask>();
  readonly #lastResults = new Map<string, RecordingResult>();

  constructor(
    private readonly config: RecordingConfig,
    private readonly runner: FfmpegRunner,
    private readonly sink: RecordingEventSink,
  ) {}

  get activeCount(): number {
    return this.#tasksById.size;
  }

  async getTask(taskId: string): Promise<RecordingTaskSnapshot> {
    if (this.#tasksById.has(taskId)) return { taskId, status: "running" };
    if (this.#lastResults.has(taskId)) return { taskId, status: "stopped" };
    const outputDirectory = path.resolve(this.config.outputDirectory);
    const taskDirectory = await findTaskDirectory(outputDirectory, taskId);
    return {
      taskId,
      status: taskDirectory === null ? "nonexistent" : "stopped",
    };
  }

  async start(command: StartRecordingCommand): Promise<RecordingHandle> {
    const sourceUrl = validateSourceUrl(command.sourceUrl);
    const existing = this.#tasksBySource.get(sourceUrl);
    if (existing !== undefined) return new ManagedRecordingHandle(existing);

    const taskId = normalizeTaskId(command.taskId ?? randomUUID());
    if (command.taskIdentity !== undefined && command.taskId === undefined) {
      throw new Error("A persistent recording task identity requires taskId");
    }
    const existingById = this.#tasksById.get(taskId);
    if (existingById !== undefined) {
      return new ManagedRecordingHandle(existingById);
    }
    const baseName = sanitizeOutputName(command.outputName);
    const taskConfig = mergeOptions(this.config, command.options);
    const outputDirectory = path.resolve(taskConfig.outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    const taskDirectory =
      command.taskIdentity === undefined
        ? outputDirectory
        : await resolveTaskDirectory(
            outputDirectory,
            taskId,
            command.taskIdentity,
          );
    const uniqueBase = await chooseUniqueBase(taskDirectory, baseName);
    // A stable task folder contains separate run workspaces. Only fragments
    // from this run can be merged together.
    const workDirectory = path.join(taskDirectory, ".work", randomUUID());
    await mkdir(workDirectory, { recursive: true });

    let resolve!: (result: RecordingResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<RecordingResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: MutableTask = {
      taskId,
      sourceUrl,
      outputName: uniqueBase,
      baseName: uniqueBase,
      outputPath: path.join(
        taskDirectory,
        `${uniqueBase}${RECORDING_EXTENSION}`,
      ),
      partialPath: path.join(
        taskDirectory,
        `${uniqueBase}.partial${RECORDING_EXTENSION}`,
      ),
      workDirectory,
      startedAt: new Date(),
      config: taskConfig,
      state: "starting",
      segmentPaths: [],
      emittedSegments: new Set(),
      refreshPromise: Promise.resolve(),
      process: null,
      stopRequested: false,
      stopDelayController: new AbortController(),
      completion,
      resolve,
      reject,
    };
    this.#tasksById.set(taskId, task);
    this.#tasksBySource.set(sourceUrl, task);

    if (command.signal !== undefined) {
      const stop = (): void => {
        this.#requestStop(task);
      };
      command.signal.addEventListener("abort", stop, { once: true });
      task.detachSignal = () =>
        command.signal?.removeEventListener("abort", stop);
      if (command.signal.aborted) stop();
    }

    void this.#runTask(task);
    return new ManagedRecordingHandle(task);
  }

  async stop(
    selector: RecordingSelector,
    signal?: AbortSignal,
  ): Promise<RecordingResult> {
    const task =
      "taskId" in selector
        ? this.#tasksById.get(selector.taskId)
        : this.#tasksBySource.get(validateSourceUrl(selector.sourceUrl));
    if (task === undefined) {
      if ("taskId" in selector) {
        const previous = this.#lastResults.get(selector.taskId);
        if (previous !== undefined) return previous;
      }
      throw new Error("Recording task was not found");
    }
    if (signal?.aborted) throw signal.reason;
    this.#requestStop(task);
    return await waitWithSignal(task.completion, signal);
  }

  async stopAll(signal?: AbortSignal): Promise<RecordingResult[]> {
    const tasks = [...this.#tasksById.values()];
    for (const task of tasks) this.#requestStop(task);
    return await Promise.all(
      tasks.map((task) => waitWithSignal(task.completion, signal)),
    );
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(
      [...this.#tasksById.values()].map((task) => task.completion),
    );
  }

  #requestStop(task: MutableTask): void {
    if (task.stopRequested) return;
    task.stopRequested = true;
    task.state = "stopping";
    task.stopDelayController.abort();
    const process = task.process;
    if (process === null) return;
    process.requestQuit();
    setTimeout(
      () => process.terminate(),
      task.config.gracefulStopTimeoutMs,
    ).unref();
  }

  async #runTask(task: MutableTask): Promise<void> {
    try {
      await this.#emit(task, { kind: "started" });
      let exit: FfmpegExit | null = null;
      for (let attempt = 0; ; attempt += 1) {
        if (task.stopRequested) break;
        task.state = "recording";
        const startNumber = task.segmentPaths.length + 1;
        task.process = this.runner.start(
          buildRecordingArgs(task, attempt, startNumber),
        );
        const segmentMonitor = setInterval(() => {
          void this.#queueSegmentRefresh(task, false).catch(() => undefined);
        }, 1_000);
        segmentMonitor.unref();
        try {
          exit = await task.process.completion;
        } finally {
          clearInterval(segmentMonitor);
        }
        task.process = null;
        await this.#queueSegmentRefresh(task, true);

        if (task.stopRequested || exit.code === 0) break;
        const diagnostic = summarizeFfmpegError(exit.stderr, task.sourceUrl);
        await this.#emit(task, {
          kind: "interrupted",
          attempt: attempt + 1,
          ...(diagnostic === "" ? {} : { message: diagnostic }),
        });
        if (isNonRetryableFfmpegError(exit.stderr)) {
          await this.#finishFailed(task, exit);
          return;
        }
        const retryDelay = task.config.retryDelaysMs[attempt];
        if (retryDelay === undefined) {
          await this.#finishFailed(task, exit);
          return;
        }
        task.state = "retry_wait";
        await this.#emit(task, { kind: "retrying", attempt: attempt + 1 });
        try {
          await abortableDelay(retryDelay, task.stopDelayController.signal);
        } catch {
          if (!task.stopRequested)
            throw new Error("Recording retry wait aborted");
        }
      }

      const finalState = task.stopRequested ? "stopped" : "completed";
      const finalPath = await this.#finalizeMedia(task, task.outputPath);
      if (
        finalState === "completed" &&
        finalPath === null &&
        task.segmentPaths.length === 0
      ) {
        throw new RecordingError(
          "FFmpeg exited without producing a recording",
          task.taskId,
        );
      }
      task.state = finalState;
      const result = makeResult(task, finalState, finalPath);
      this.#lastResults.set(task.taskId, result);
      await this.#emit(task, {
        kind: finalState,
        ...(finalPath === null ? {} : { path: finalPath }),
      });
      task.resolve(result);
    } catch (error) {
      task.state = "failed";
      const wrapped =
        error instanceof RecordingError
          ? error
          : new RecordingError(
              error instanceof Error ? error.message : "Recording failed",
              task.taskId,
              null,
              { cause: error },
            );
      if (!this.#lastResults.has(task.taskId)) {
        this.#lastResults.set(task.taskId, {
          taskId: task.taskId,
          sourceUrl: task.sourceUrl,
          state: "failed",
          outputPath: wrapped.partialPath,
          segmentPaths: [...task.segmentPaths],
          startedAt: task.startedAt,
          endedAt: new Date(),
        });
      }
      await this.#emit(task, { kind: "failed", message: wrapped.message });
      task.reject(wrapped);
    } finally {
      task.detachSignal?.();
      this.#tasksById.delete(task.taskId);
      this.#tasksBySource.delete(task.sourceUrl);
    }
  }

  async #finishFailed(task: MutableTask, exit: FfmpegExit): Promise<void> {
    let partialPath: string | null = null;
    try {
      partialPath = await this.#finalizeMedia(task, task.partialPath);
    } catch {
      // Preserve the source fragments if partial merging itself fails.
    }
    task.state = "failed";
    const detail =
      summarizeFfmpegError(exit.stderr, task.sourceUrl) ||
      "unknown FFmpeg error";
    const error = new RecordingError(
      `FFmpeg exited unexpectedly after all retries: ${detail}`,
      task.taskId,
      partialPath,
    );
    this.#lastResults.set(task.taskId, {
      taskId: task.taskId,
      sourceUrl: task.sourceUrl,
      state: "failed",
      outputPath: partialPath,
      segmentPaths: [...task.segmentPaths],
      startedAt: task.startedAt,
      endedAt: new Date(),
    });
    await this.#emit(task, {
      kind: "failed",
      message: error.message,
      ...(partialPath === null ? {} : { path: partialPath }),
    });
    task.reject(error);
  }

  #queueSegmentRefresh(
    task: MutableTask,
    includeActive: boolean,
  ): Promise<void> {
    task.refreshPromise = task.refreshPromise.then(() =>
      this.#refreshSegments(task, includeActive),
    );
    return task.refreshPromise;
  }

  async #refreshSegments(
    task: MutableTask,
    includeActive: boolean,
  ): Promise<void> {
    const names = (await readdir(task.workDirectory))
      .filter((name) => name.endsWith(RECORDING_EXTENSION))
      .sort();
    task.segmentPaths = names.map((name) =>
      path.join(task.workDirectory, name),
    );
    const completedSegments = includeActive
      ? task.segmentPaths
      : task.segmentPaths.slice(0, -1);
    for (const segmentPath of completedSegments) {
      if (task.emittedSegments.has(segmentPath)) continue;
      task.emittedSegments.add(segmentPath);
      await this.#emit(task, { kind: "segment_created", path: segmentPath });
    }
  }

  async #finalizeMedia(
    task: MutableTask,
    destination: string,
  ): Promise<string | null> {
    await this.#queueSegmentRefresh(task, true);
    if (task.segmentPaths.length === 0) {
      await rm(task.workDirectory, { recursive: true, force: true });
      return null;
    }
    if (
      task.config.segmentation.enabled &&
      !task.config.segmentation.autoMerge
    ) {
      task.segmentPaths = await promoteSegments(
        task,
        path.dirname(destination),
      );
      await rm(task.workDirectory, { recursive: true, force: true });
      return null;
    }

    task.state = "merging";
    await this.#emit(task, { kind: "merge_started" });
    const temporary = `${destination}.${task.taskId}.tmp${RECORDING_EXTENSION}`;
    if (task.segmentPaths.length === 1) {
      if (task.config.segmentation.keepSegments) {
        await copyFile(task.segmentPaths[0] as string, temporary);
      } else {
        await rename(task.segmentPaths[0] as string, temporary);
      }
    } else {
      const manifest = path.join(task.workDirectory, "concat.txt");
      await writeFile(
        manifest,
        task.segmentPaths
          .map((item) => `file '${escapeConcatPath(item)}'`)
          .join("\n"),
        "utf8",
      );
      const process = this.runner.start([
        "-hide_banner",
        "-loglevel",
        "warning",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        manifest,
        "-map",
        "0",
        "-c",
        "copy",
        temporary,
      ]);
      const exit = await process.completion;
      if (exit.code !== 0) {
        throw new RecordingError(
          `Unable to merge recording fragments: ${exit.stderr}`,
          task.taskId,
        );
      }
    }
    await rename(temporary, destination);
    await this.#emit(task, { kind: "merge_completed", path: destination });
    if (task.config.segmentation.keepSegments) {
      task.segmentPaths = await promoteSegments(
        task,
        path.dirname(destination),
      );
      await rm(task.workDirectory, { recursive: true, force: true });
    } else {
      await rm(task.workDirectory, { recursive: true, force: true });
      task.segmentPaths = [];
    }
    return destination;
  }

  async #emit(
    task: MutableTask,
    event: Omit<RecordingEvent, "taskId" | "outputName" | "occurredAt">,
  ): Promise<void> {
    await this.sink.deliver({
      ...event,
      taskId: task.taskId,
      outputName: task.outputName,
      occurredAt: new Date(),
    } as RecordingEvent);
  }
}

function buildRecordingArgs(
  task: MutableTask,
  attempt: number,
  startNumber: number,
): string[] {
  const args = [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    task.sourceUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-sn",
    "-dn",
  ];
  if (task.config.videoBitrate === "source") {
    args.push("-c", "copy");
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-b:v",
      task.config.videoBitrate,
      "-c:a",
      "aac",
    );
  }
  if (task.config.segmentation.enabled) {
    args.push(
      "-f",
      "segment",
      "-segment_time",
      String(task.config.segmentation.durationSeconds),
      "-reset_timestamps",
      "1",
      "-segment_start_number",
      String(startNumber),
      path.join(
        task.workDirectory,
        `${task.baseName}-part-%04d${RECORDING_EXTENSION}`,
      ),
    );
  } else {
    args.push(
      path.join(
        task.workDirectory,
        `${task.baseName}-attempt-${String(attempt + 1).padStart(4, "0")}${RECORDING_EXTENSION}`,
      ),
    );
  }
  return args;
}

function mergeOptions(
  base: RecordingConfig,
  override?: RecordingOptionsOverride,
): RecordingConfig {
  return {
    ...base,
    segmentation: { ...base.segmentation, ...override?.segmentation },
    videoBitrate: override?.videoBitrate ?? base.videoBitrate,
    retryDelaysMs: override?.retryDelaysMs ?? base.retryDelaysMs,
    gracefulStopTimeoutMs:
      override?.gracefulStopTimeoutMs ?? base.gracefulStopTimeoutMs,
  };
}

function validateSourceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Recording source URL must use http or https");
  }
  return url.toString();
}

function normalizeTaskId(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 128) {
    throw new Error("Recording taskId must contain 1 to 128 characters");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error("Recording taskId contains unsupported characters");
  }
  return normalized;
}

export function sanitizeOutputName(value: string): string {
  const withoutExtension = value.replace(/\.(?:flv|mkv)$/i, "");
  const sanitized = [...withoutExtension]
    .map((character) =>
      character.charCodeAt(0) <= 31 || '<>:"/\\|?*'.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 160);
  return sanitized === "" ? "recording" : sanitized;
}

async function promoteSegments(
  task: MutableTask,
  outputDirectory: string,
): Promise<string[]> {
  const promoted: string[] = [];
  for (const segment of task.segmentPaths) {
    const destination = path.join(outputDirectory, path.basename(segment));
    await rename(segment, destination);
    promoted.push(destination);
  }
  return promoted;
}

async function chooseUniqueBase(
  directory: string,
  base: string,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const candidate =
      attempt === 0 ? base : `${base}-${randomUUID().slice(0, 8)}`;
    const finalPath = path.join(
      directory,
      `${candidate}${RECORDING_EXTENSION}`,
    );
    const partialPath = path.join(
      directory,
      `${candidate}.partial${RECORDING_EXTENSION}`,
    );
    if (!(await pathExists(finalPath)) && !(await pathExists(partialPath))) {
      return candidate;
    }
  }
}

interface PersistedTaskManifest {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly platform: string;
  readonly target_key: string;
  readonly room_key: string;
  readonly created_at: string;
  readonly folder: string;
}

async function resolveTaskDirectory(
  outputDirectory: string,
  taskId: string,
  identity: RecordingTaskIdentity,
): Promise<string> {
  const existing = await findTaskDirectory(outputDirectory, taskId);
  if (existing !== null) return existing;

  const date = formatLocalDate(identity.firstObservedAt);
  const readableName = `${date}_${sanitizeDirectoryPart(identity.targetKey, "target")}_${sanitizeDirectoryPart(identity.roomKey, "room")}`;
  let taskDirectory: string;
  for (let attempt = 0; ; attempt += 1) {
    const folderName =
      attempt === 0
        ? readableName
        : attempt === 1
          ? `${readableName}-${taskId.slice(-8)}`
          : `${readableName}-${taskId.slice(-8)}-${randomUUID().slice(0, 8)}`;
    taskDirectory = path.join(outputDirectory, folderName);
    try {
      await mkdir(taskDirectory);
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      const afterRace = await findTaskDirectory(outputDirectory, taskId);
      if (afterRace !== null) return afterRace;
    }
  }

  const manifest: PersistedTaskManifest = {
    schema_version: 1,
    task_id: taskId,
    platform: identity.platform,
    target_key: identity.targetKey,
    room_key: identity.roomKey,
    created_at: identity.firstObservedAt.toISOString(),
    folder: path.basename(taskDirectory),
  };
  await writeFile(
    path.join(taskDirectory, "task.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return taskDirectory;
}

async function findTaskDirectory(
  outputDirectory: string,
  taskId: string,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(outputDirectory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(outputDirectory, entry.name);
    const manifestPath = path.join(directory, "task.json");
    let source: string;
    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`Invalid recording task manifest: ${manifestPath}`, {
        cause: error,
      });
    }
    if (
      manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      (manifest as Record<string, unknown>).task_id === taskId
    ) {
      return directory;
    }
  }
  return null;
}

function sanitizeDirectoryPart(value: string, fallback: string): string {
  const safe = [...value.normalize("NFKC")]
    .map((character) =>
      character.charCodeAt(0) <= 31 || '<>:"/\\|?*'.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 64);
  return safe === "" ? fallback : safe;
}

function formatLocalDate(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function escapeConcatPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function isNonRetryableFfmpegError(stderr: string): boolean {
  return [
    "error opening output",
    "could not write header",
    "unable to choose an output format",
    "invalid stream specifier",
    "requested output format",
    "video codec (c) is not implemented",
  ].some((marker) => stderr.toLowerCase().includes(marker));
}

function summarizeFfmpegError(stderr: string, sourceUrl: string): string {
  return stderr
    .replaceAll(sourceUrl, "<source>")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-6)
    .join(" | ");
}

function makeResult(
  task: MutableTask,
  state: "completed" | "stopped",
  outputPath: string | null,
): RecordingResult {
  return {
    taskId: task.taskId,
    sourceUrl: task.sourceUrl,
    state,
    outputPath,
    segmentPaths: [...task.segmentPaths],
    startedAt: task.startedAt,
    endedAt: new Date(),
  };
}

async function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return await promise;
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    }),
  ]);
}
