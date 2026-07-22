import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordingConfig, RecordingEvent } from "../domain/recording";
import type {
  FfmpegExit,
  FfmpegRunner,
  RecordingEventSink,
  RunningFfmpegProcess,
} from "../ports/recording";
import { RecordingManager, sanitizeOutputName } from "./recording-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RecordingManager", () => {
  it("records with source codecs and merges to a safe final filename", async () => {
    const directory = await createTemporaryDirectory();
    const runner = new FileCreatingRunner([
      { code: 0, signal: null, stderr: "" },
    ]);
    const manager = new RecordingManager(
      config(directory),
      runner,
      new MemorySink(),
    );

    const handle = await manager.start({
      sourceUrl: "https://example.com/live.flv",
      outputName: "主播:<测试>?-20260722-120000",
    });
    const result = await handle.completion;

    expect(runner.calls[0]).toContain("copy");
    expect(runner.calls[0]).toContain("1800");
    expect(runner.calls[0]).toEqual(
      expect.arrayContaining(["-map", "0:v:0", "-map", "0:a?", "-sn", "-dn"]),
    );
    expect(result.state).toBe("completed");
    expect(result.outputPath).toContain("主播__测试__-20260722-120000.flv");
    expect(existsSync(result.outputPath as string)).toBe(true);
  });

  it("uses H.264 and AAC when a video bitrate is configured", async () => {
    const directory = await createTemporaryDirectory();
    const runner = new FileCreatingRunner([
      { code: 0, signal: null, stderr: "" },
    ]);
    const manager = new RecordingManager(
      { ...config(directory), videoBitrate: "4M" },
      runner,
      new MemorySink(),
    );

    const handle = await manager.start({
      sourceUrl: "https://example.com/live.flv",
      outputName: "bitrate-test",
    });
    await handle.completion;

    expect(runner.calls[0]).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-b:v", "4M", "-c:a", "aac"]),
    );
  });

  it("retries three times and rejects with a partial recording", async () => {
    const directory = await createTemporaryDirectory();
    const failures = Array.from(
      { length: 4 },
      () =>
        ({
          code: 1,
          signal: null,
          stderr: "connection reset",
        }) satisfies FfmpegExit,
    );
    const runner = new FileCreatingRunner(failures);
    const sink = new MemorySink();
    const manager = new RecordingManager(
      { ...config(directory), retryDelaysMs: [0, 0, 0] },
      runner,
      sink,
    );

    const handle = await manager.start({
      sourceUrl: "https://example.com/live.flv",
      outputName: "retry-test",
    });

    await expect(handle.completion).rejects.toMatchObject({
      taskId: handle.taskId,
      partialPath: expect.stringContaining("retry-test.partial.flv"),
    });
    expect(runner.recordingCalls).toHaveLength(4);
    expect(
      sink.events.filter((event) => event.kind === "retrying"),
    ).toHaveLength(3);
  });

  it("does not retry deterministic output configuration failures", async () => {
    const directory = await createTemporaryDirectory();
    const runner = new FileCreatingRunner([
      {
        code: 1,
        signal: null,
        stderr:
          "Could not write header: Invalid argument\nError opening output files: Invalid argument",
      },
    ]);
    const manager = new RecordingManager(
      config(directory),
      runner,
      new MemorySink(),
    );

    const handle = await manager.start({
      sourceUrl: "https://example.com/signed.flv?token=secret",
      outputName: "fatal-test",
    });

    await expect(handle.completion).rejects.toThrow(
      "Error opening output files",
    );
    expect(runner.recordingCalls).toHaveLength(1);
  });

  it("deduplicates a source and stops it by URL", async () => {
    const directory = await createTemporaryDirectory();
    const runner = new QuitControlledRunner();
    const manager = new RecordingManager(
      config(directory),
      runner,
      new MemorySink(),
    );
    const sourceUrl = "https://example.com/live.flv";

    const first = await manager.start({ sourceUrl, outputName: "first" });
    const second = await manager.start({ sourceUrl, outputName: "second" });
    const result = await manager.stop({ sourceUrl });

    expect(second.taskId).toBe(first.taskId);
    expect(result.state).toBe("stopped");
    expect(runner.requestedQuit).toBe(true);
    expect(manager.activeCount).toBe(0);
  });

  it("stops a task when its AbortSignal is aborted", async () => {
    const directory = await createTemporaryDirectory();
    const runner = new QuitControlledRunner();
    const manager = new RecordingManager(
      config(directory),
      runner,
      new MemorySink(),
    );
    const controller = new AbortController();
    const handle = await manager.start({
      sourceUrl: "https://example.com/abort.flv",
      outputName: "abort-test",
      signal: controller.signal,
    });

    controller.abort();

    await expect(handle.completion).resolves.toMatchObject({
      state: "stopped",
    });
    expect(manager.activeCount).toBe(0);
  });

  it("reuses a provided taskId and exposes three-state status", async () => {
    const directory = await createTemporaryDirectory();
    const runner = new QuitControlledRunner();
    const manager = new RecordingManager(
      config(directory),
      runner,
      new MemorySink(),
    );
    const taskId = "rec-stable-target";

    await expect(manager.getTask(taskId)).resolves.toEqual({
      taskId,
      status: "nonexistent",
    });
    const first = await manager.start({
      taskId,
      sourceUrl: "https://example.com/first.flv",
      outputName: "first-session",
    });
    expect(first.taskId).toBe(taskId);
    expect((await manager.getTask(taskId)).status).toBe("running");

    await manager.stop({ taskId });
    expect((await manager.getTask(taskId)).status).toBe("stopped");
    await expect(manager.stop({ taskId })).resolves.toMatchObject({ taskId });

    const second = await manager.start({
      taskId,
      sourceUrl: "https://example.com/second.flv",
      outputName: "second-session",
    });
    expect(second.taskId).toBe(taskId);
    expect((await manager.getTask(taskId)).status).toBe("running");
    await manager.stop({ taskId });
  });

  it("reuses a room task folder across manager instances and separates runs", async () => {
    const directory = await createTemporaryDirectory();
    const taskId = "xhs-6866618356-570374231565031072-deadbeef";
    const firstIdentity = {
      platform: "xhs",
      targetKey: "6866618356",
      roomKey: "570374231565031072",
      firstObservedAt: new Date(2026, 6, 22, 23, 59, 0),
    };
    const firstManager = new RecordingManager(
      config(directory),
      new FileCreatingRunner([{ code: 0, signal: null, stderr: "" }]),
      new MemorySink(),
    );
    const first = await firstManager.start({
      taskId,
      taskIdentity: firstIdentity,
      sourceUrl: "https://example.com/first.flv",
      outputName: "anchor-first-run",
    });
    const firstResult = await first.completion;
    const taskDirectory = path.dirname(firstResult.outputPath as string);

    expect(path.basename(taskDirectory)).toBe(
      "20260722_6866618356_570374231565031072",
    );
    expect(
      JSON.parse(await readFile(path.join(taskDirectory, "task.json"), "utf8")),
    ).toMatchObject({
      task_id: taskId,
      target_key: "6866618356",
      room_key: "570374231565031072",
    });

    const secondManager = new RecordingManager(
      config(directory),
      new FileCreatingRunner([{ code: 0, signal: null, stderr: "" }]),
      new MemorySink(),
    );
    await expect(secondManager.getTask(taskId)).resolves.toEqual({
      taskId,
      status: "stopped",
    });
    const second = await secondManager.start({
      taskId,
      taskIdentity: {
        ...firstIdentity,
        firstObservedAt: new Date(2026, 6, 23, 0, 1, 0),
      },
      sourceUrl: "https://example.com/second.flv",
      outputName: "anchor-second-run",
    });
    const secondResult = await second.completion;

    expect(path.dirname(secondResult.outputPath as string)).toBe(taskDirectory);
    expect(secondResult.outputPath).not.toBe(firstResult.outputPath);
    expect(existsSync(firstResult.outputPath as string)).toBe(true);
    expect(existsSync(secondResult.outputPath as string)).toBe(true);
  });

  it("sanitizes empty and invalid output names", () => {
    expect(sanitizeOutputName("<>.flv")).toBe("__");
    expect(sanitizeOutputName("   .mkv")).toBe("recording");
  });
});

class MemorySink implements RecordingEventSink {
  readonly events: RecordingEvent[] = [];
  deliver(event: RecordingEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class FileCreatingRunner implements FfmpegRunner {
  readonly calls: string[][] = [];
  readonly recordingCalls: string[][] = [];
  constructor(private readonly exits: FfmpegExit[]) {}

  start(args: readonly string[]): RunningFfmpegProcess {
    const call = [...args];
    this.calls.push(call);
    const isMerge = call.includes("concat");
    const output = call.at(-1) as string;
    mkdirSync(path.dirname(output), { recursive: true });
    if (isMerge) {
      writeFileSync(output, "merged");
    } else {
      this.recordingCalls.push(call);
      const startIndex = call.indexOf("-segment_start_number");
      const number = startIndex < 0 ? 1 : Number(call[startIndex + 1]);
      writeFileSync(
        output.replace("%04d", String(number).padStart(4, "0")),
        "part",
      );
    }
    const exit = isMerge
      ? { code: 0, signal: null, stderr: "" }
      : (this.exits.shift() ?? { code: 0, signal: null, stderr: "" });
    return inertProcess(exit);
  }
}

class QuitControlledRunner implements FfmpegRunner {
  requestedQuit = false;
  start(args: readonly string[]): RunningFfmpegProcess {
    const output = args.at(-1) as string;
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output.replace("%04d", "0001"), "part");
    let resolve!: (exit: FfmpegExit) => void;
    const completion = new Promise<FfmpegExit>((done) => {
      resolve = done;
    });
    return {
      completion,
      requestQuit: () => {
        this.requestedQuit = true;
        resolve({ code: 0, signal: null, stderr: "" });
      },
      terminate: () => resolve({ code: null, signal: "SIGTERM", stderr: "" }),
    };
  }
}

function inertProcess(exit: FfmpegExit): RunningFfmpegProcess {
  return {
    completion: Promise.resolve(exit),
    requestQuit: () => undefined,
    terminate: () => undefined,
  };
}

function config(outputDirectory: string): RecordingConfig {
  return {
    enabled: true,
    outputDirectory,
    segmentation: {
      enabled: true,
      durationSeconds: 1_800,
      autoMerge: true,
      keepSegments: false,
    },
    videoBitrate: "source",
    retryDelaysMs: [5_000, 15_000, 30_000],
    gracefulStopTimeoutMs: 10,
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recorder-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
