import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GiB, spaceLevel } from "./disk";
import { safeName, taskId } from "./identity";
import {
  type DiskPort,
  defaultSettings,
  type MediaRunner,
  type RecorderRepository,
  type RecordingFile,
  type RecordingRun,
  type Target,
} from "./models";
import { RecordingEngine } from "./recording-engine";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "xhs-core-"));
  directories.push(root);
  const settings = { ...defaultSettings(root), outputConfigured: true };
  const target: Target = {
    id: "alice",
    keyWord: "alice",
    userId: "user",
    name: "Alice",
    state: "live",
    roomId: "room",
    pageUrl: null,
    enabled: true,
    notify: true,
    autoRecord: true,
    checkedAt: null,
    error: null,
    blockedRoomId: null,
    blockedReason: null,
    retryAt: 0,
    archivedAt: null,
    generation: 0,
    errorKind: null,
    lastConfirmedAt: null,
  };
  const runs = new Map<string, RecordingRun>();
  const fileMap = new Map<string, RecordingFile[]>();
  const repo: RecorderRepository = {
    settings: () => settings,
    targets: () => [target],
    target: () => target,
    saveTarget: (t) => Object.assign(target, t),
    taskDirectory: (_id, p) => p,
    saveRun: (r) => {
      runs.set(r.id, { ...r });
    },
    run: (id) => runs.get(id),
    runs: () => [...runs.values()],
    files: (id) => fileMap.get(id) ?? [],
    replaceFiles: (id, files) => {
      fileMap.set(id, files);
    },
  };
  const disk: DiskPort = {
    probe: vi.fn<DiskPort["probe"]>(async (directory) => ({
      directory,
      totalBytes: 100 * GiB,
      freeBytes: 50 * GiB,
      level: "ok",
      message: null,
    })),
  };
  return { root, settings, target, repo, disk, runs, fileMap };
}
describe("recording safeguards", () => {
  it("emits a natural stream end once before finishing the run", async () => {
    const f = await fixture();
    f.settings.autoMerge = false;
    const ended = vi.fn();
    const runner: MediaRunner = {
      start: (args) => ({
        completion: writeFile(
          args[args.length - 1].replace("%05d", "00000"),
          "fragment",
        ).then(() => ({ code: 0, stderr: "" })),
        quit: () => {},
        kill: () => {},
      }),
    };
    const engine = new RecordingEngine(
      f.repo,
      runner,
      f.disk,
      () => {},
      [],
      ended,
    );
    const run = engine.start(f.target);
    await vi.waitFor(() => expect(engine.activeRuns).toHaveLength(0));
    expect(ended).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: run.id, targetId: f.target.id }),
    );
    expect(f.repo.run(run.id)?.state).toBe("completed");
  });
  it.each(["manual", "removed", "exit", "disk"] as const)(
    "does not emit a stream-end query for %s stops",
    async (reason) => {
      const f = await fixture();
      const ended = vi.fn();
      let finish!: (value: { code: number; stderr: string }) => void;
      const runner: MediaRunner = {
        start: vi.fn<MediaRunner["start"]>((args) => {
          const completion = new Promise<{ code: number; stderr: string }>(
            (resolve) => {
              finish = resolve;
            },
          );
          return {
            completion: Promise.all([
              writeFile(
                args[args.length - 1].replace("%05d", "00000"),
                "fragment",
              ),
              completion,
            ]).then(([, exit]) => exit),
            quit: () => finish({ code: 0, stderr: "" }),
            kill: () => finish({ code: 0, stderr: "" }),
          };
        }),
      };
      const engine = new RecordingEngine(
        f.repo,
        runner,
        f.disk,
        () => {},
        [],
        ended,
      );
      const run = engine.start(f.target);
      await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce());
      await engine.stop(f.target.id, reason);
      expect(ended).not.toHaveBeenCalled();
      if (reason === "removed") {
        expect(
          f.repo.files(run.id).some((file) => file.kind === "segment"),
        ).toBe(true);
        expect(f.repo.run(run.id)?.mergeState).toBe("completed");
      }
    },
  );
  it("removes a starting task before a media process can be created", async () => {
    const f = await fixture();
    const runner: MediaRunner = { start: vi.fn() };
    const ended = vi.fn();
    const engine = new RecordingEngine(
      f.repo,
      runner,
      f.disk,
      () => {},
      [],
      ended,
    );
    engine.start(f.target);
    await engine.stop(f.target.id, "removed");
    expect(runner.start).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });
  it("keeps every fragment when removal interrupts a merge", async () => {
    const f = await fixture();
    let finish!: (value: { code: number; stderr: string }) => void;
    const runner: MediaRunner = {
      start: vi.fn<MediaRunner["start"]>((args) => {
        if (args.includes("concat"))
          return {
            completion: new Promise((resolve) => {
              finish = resolve;
            }),
            quit: () => finish({ code: 0, stderr: "" }),
            kill: () => finish({ code: 0, stderr: "" }),
          };
        const output = args[args.length - 1];
        return {
          completion: Promise.all([
            writeFile(output.replace("%05d", "00000"), "one"),
            writeFile(output.replace("%05d", "00001"), "two"),
          ]).then(() => ({ code: 0, stderr: "" })),
          quit: () => {},
          kill: () => {},
        };
      }),
    };
    const engine = new RecordingEngine(f.repo, runner, f.disk, () => {});
    const run = engine.start(f.target);
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(2));
    await engine.stop(f.target.id, "removed");
    expect(
      f.repo.files(run.id).filter((file) => file.kind === "segment"),
    ).toHaveLength(2);
    expect(f.repo.run(run.id)?.mergeState).toBe("pending");
  });
  it("reserves starts synchronously and keeps the original stream codecs", async () => {
    const f = await fixture();
    let quit = () => {};
    const runner: MediaRunner = {
      start: vi.fn<MediaRunner["start"]>((args) => ({
        completion: new Promise((resolve) => {
          quit = () => resolve({ code: 0, stderr: "" });
          void writeFile(
            args[args.length - 1].replace("%05d", "00000"),
            "fragment",
          );
        }),
        quit: () => quit(),
        kill: () => quit(),
      })),
    };
    const engine = new RecordingEngine(f.repo, runner, f.disk, () => {});
    const first = engine.start(f.target);
    const second = engine.start(f.target);
    expect(first.id).toBe(second.id);
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce());
    expect(vi.mocked(runner.start).mock.calls[0][0]).toContain("copy");
    await engine.stop(f.target.id, "manual");
    expect(engine.activeRuns).toHaveLength(0);
    expect(f.repo.run(first.id)?.state).toBe("stopped");
  });
  it("blocks disk failures before spawning FFmpeg and preserves the reason", async () => {
    const f = await fixture();
    vi.mocked(f.disk.probe).mockResolvedValue({
      directory: f.root,
      totalBytes: 100 * GiB,
      freeBytes: GiB,
      level: "stop",
      message: null,
    });
    const runner: MediaRunner = { start: vi.fn() };
    const engine = new RecordingEngine(f.repo, runner, f.disk, () => {});
    const run = engine.start(f.target);
    await vi.waitFor(() => expect(engine.activeRuns).toHaveLength(0));
    expect(runner.start).not.toHaveBeenCalled();
    expect(f.target.blockedReason).toBe("disk");
    expect(f.repo.run(run.id)?.stopReason).toBe("disk");
  });
  it("bounds retries and imposes a cooldown after a failed stream", async () => {
    const f = await fixture();
    const runner: MediaRunner = {
      start: vi.fn(() => ({
        completion: Promise.resolve({ code: 1, stderr: "connection reset" }),
        quit: () => {},
        kill: () => {},
      })),
    };
    const ended = vi.fn();
    const engine = new RecordingEngine(
      f.repo,
      runner,
      f.disk,
      () => {},
      [0, 0, 0],
      ended,
    );
    engine.start(f.target);
    await vi.waitFor(() => expect(engine.activeRuns).toHaveLength(0));
    expect(runner.start).toHaveBeenCalledTimes(4);
    expect(f.target.retryAt).toBeGreaterThan(Date.now() + 59000);
    expect(f.target.blockedReason).toBeNull();
    expect(ended).toHaveBeenCalledOnce();
  });
  it("does not retry deterministic output errors", async () => {
    const f = await fixture();
    const runner: MediaRunner = {
      start: vi.fn(() => ({
        completion: Promise.resolve({
          code: 1,
          stderr: "Could not write header",
        }),
        quit: () => {},
        kill: () => {},
      })),
    };
    const engine = new RecordingEngine(f.repo, runner, f.disk, () => {}, [0]);
    engine.start(f.target);
    await vi.waitFor(() => expect(engine.activeRuns).toHaveLength(0));
    expect(runner.start).toHaveBeenCalledOnce();
    expect(f.target.blockedReason).toBe("output");
  });
  it("retains segments when the merge needs more free space than the disk has", async () => {
    const f = await fixture();
    let call = 0;
    vi.mocked(f.disk.probe).mockImplementation(async (directory) => ({
      directory,
      totalBytes: 100 * GiB,
      freeBytes: ++call === 1 ? 50 * GiB : 2 * GiB,
      level: "ok",
      message: null,
    }));
    const runner: MediaRunner = {
      start: vi.fn((args) => ({
        completion: writeFile(
          args[args.length - 1].replace("%05d", "00000"),
          "fragment",
        ).then(() => ({ code: 0, stderr: "" })),
        quit: () => {},
        kill: () => {},
      })),
    };
    const engine = new RecordingEngine(f.repo, runner, f.disk, () => {});
    const run = engine.start(f.target);
    await vi.waitFor(() => expect(engine.activeRuns).toHaveLength(0));
    expect(f.repo.run(run.id)?.mergeState).toBe("pending");
    expect(f.repo.files(run.id)).toHaveLength(1);
    expect((await stat(f.repo.files(run.id)[0].path)).size).toBeGreaterThan(0);
  });
  it("does not erase the file index when a recording disk disappears", async () => {
    const f = await fixture();
    const run: RecordingRun = {
      id: "run",
      taskId: "task",
      targetId: "alice",
      name: "Alice",
      sourceUrl: "https://example.test/live",
      directory: f.root,
      workDirectory: path.join(f.root, "missing"),
      state: "interrupted",
      mergeState: "pending",
      outputPath: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      stopReason: null,
    };
    f.repo.replaceFiles(run.id, [
      {
        path: path.join(run.workDirectory, "attempt-000-part-00000.flv"),
        bytes: 10,
        kind: "segment",
        exists: false,
      },
    ]);
    const engine = new RecordingEngine(
      f.repo,
      { start: vi.fn() },
      f.disk,
      () => {},
    );
    await engine.indexFiles(run);
    expect(f.repo.files(run.id)).toHaveLength(1);
  });
  it("requires a configured output directory and stable room identity", async () => {
    const f = await fixture();
    f.settings.outputConfigured = false;
    const engine = new RecordingEngine(
      f.repo,
      { start: vi.fn() },
      f.disk,
      () => {},
    );
    expect(() => engine.start(f.target)).toThrow("录制目录");
    expect(taskId("alice", "room")).toBe(taskId("alice", "room"));
    expect(taskId("alice", "room")).not.toBe(taskId("alice", "other"));
    expect(safeName("CON")).not.toBe("CON");
    expect(safeName("a/b:*")).toBe("a_b__");
  });
  it("distinguishes both disk thresholds", async () => {
    const f = await fixture();
    expect(spaceLevel(GiB, f.settings)).toBe("stop");
    expect(spaceLevel(5 * GiB, f.settings)).toBe("warning");
    expect(spaceLevel(20 * GiB, f.settings)).toBe("ok");
  });
  it("stops only tasks whose output disk becomes unavailable", async () => {
    const f = await fixture();
    const secondRoot = await mkdtemp(path.join(tmpdir(), "xhs-other-disk-"));
    directories.push(secondRoot);
    const roots: string[] = [];
    const runner: MediaRunner = {
      start: vi.fn<MediaRunner["start"]>((args) => {
        roots.push(args[args.length - 1]);
        let finish!: (value: { code: number; stderr: string }) => void;
        const completion = new Promise<{ code: number; stderr: string }>(
          (resolve) => {
            finish = resolve;
          },
        );
        return {
          completion,
          quit: () => finish({ code: 0, stderr: "" }),
          kill: () => finish({ code: 0, stderr: "" }),
        };
      }),
    };
    f.repo.settings = () => ({ ...f.settings });
    const engine = new RecordingEngine(f.repo, runner, f.disk, () => {});
    engine.start(f.target);
    f.settings.outputDir = secondRoot;
    engine.start({ ...f.target, id: "bob", userId: "bob" });
    await vi.waitFor(() => expect(roots).toHaveLength(2));
    vi.mocked(f.disk.probe).mockImplementation(async (directory) => ({
      directory,
      totalBytes: 100 * GiB,
      freeBytes: directory === f.root ? GiB : 50 * GiB,
      level: directory === f.root ? "stop" : "ok",
      message: null,
    }));
    await engine.checkDisks();
    expect(engine.isActive("alice")).toBe(false);
    expect(engine.isActive("bob")).toBe(true);
    await engine.stopAll("exit");
  });
});
