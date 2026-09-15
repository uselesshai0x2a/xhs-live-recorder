import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { GiB } from "./disk";
import { delay, safeName, streamUrl, taskId } from "./identity";
import type {
  DiskPort,
  MediaProcess,
  MediaRunner,
  RecorderRepository,
  RecordingFile,
  RecordingRun,
  Settings,
  Target,
} from "./models";

interface Active {
  run: RecordingRun;
  config: Settings;
  process: MediaProcess | null;
  abort: AbortController;
  done: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopReason: RecordingRun["stopReason"];
  streamEnded?: boolean;
}

export class RecordingEngine {
  private active = new Map<string, Active>();
  private closing = false;
  constructor(
    private repo: RecorderRepository,
    private runner: MediaRunner,
    private disk: DiskPort,
    private changed: () => void,
    private retryDelays = [5000, 15000, 30000],
    private onStreamEnded: (run: RecordingRun) => void = () => {},
  ) {}

  get activeRuns(): RecordingRun[] {
    return [...this.active.values()].map((a) => ({ ...a.run }));
  }
  isActive(targetId: string): boolean {
    return this.active.has(targetId);
  }

  start(target: Target): RecordingRun {
    if (this.closing) throw new Error("应用正在退出");
    const existing = this.active.get(target.id);
    if (existing) return existing.run;
    if (!target.userId || !target.roomId || target.state !== "live")
      throw new Error("尚未确认直播房间");
    const config = this.repo.settings();
    if (!config.outputConfigured) throw new Error("请先在设置中确认录制目录");
    const id = randomUUID();
    const stableId = taskId(target.userId, target.roomId);
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const directory = this.repo.taskDirectory(
      stableId,
      path.join(
        config.outputDir,
        `${date}_${safeName(target.keyWord)}_${safeName(target.roomId)}`,
      ),
    );
    const run: RecordingRun = {
      id,
      taskId: stableId,
      targetId: target.id,
      name: target.name,
      sourceUrl: streamUrl(target.roomId),
      directory,
      workDirectory: path.join(directory, ".work", id),
      state: "starting",
      mergeState: "none",
      outputPath: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      stopReason: null,
    };
    const active: Active = {
      run,
      config,
      process: null,
      abort: new AbortController(),
      done: Promise.resolve(),
      stopReason: null,
    };
    // Reserve before the first asynchronous operation, including directory and disk checks.
    this.repo.saveRun(run);
    this.active.set(target.id, active);
    active.done = this.execute(active)
      .catch((error) => this.failed(active, error))
      .finally(() => {
        if (active.timer) clearTimeout(active.timer);
        active.process?.kill();
        this.active.delete(target.id);
        this.changed();
      });
    this.changed();
    return run;
  }

  async stop(
    targetId: string,
    reason: RecordingRun["stopReason"],
  ): Promise<void> {
    const active = this.active.get(targetId);
    if (!active) return;
    active.stopReason = reason;
    if (reason === "removed") active.config.keepSegments = true;
    active.run.stopReason = reason;
    active.abort.abort();
    this.update(active, "stopping");
    this.stopProcess(active);
    await active.done;
  }

  async stopAll(reason: RecordingRun["stopReason"] = "manual"): Promise<void> {
    if (reason === "exit") this.closing = true;
    await Promise.allSettled(
      [...this.active.keys()].map((id) => this.stop(id, reason)),
    );
  }

  async checkDisks(): Promise<void> {
    await Promise.all(
      [...this.active.values()].map(async (active) => {
        const status = await this.disk.probe(
          active.config.outputDir,
          this.repo.settings(),
        );
        if (status.level === "stop" || status.level === "unavailable") {
          this.block(active.run.targetId, "disk");
          await this.stop(active.run.targetId, "disk");
        }
      }),
    );
  }

  private stopProcess(active: Active): void {
    const child = active.process;
    if (!child) return;
    child.quit();
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => child.kill(), 10000);
    active.timer.unref();
  }

  private async execute(active: Active): Promise<void> {
    const { run, config } = active;
    const disk = await this.disk.probe(config.outputDir, config);
    if (disk.level === "stop" || disk.level === "unavailable") {
      this.block(run.targetId, "disk");
      active.stopReason = "disk";
      throw new Error("录制盘空间不足或不可写，请处理后点击恢复录制");
    }
    try {
      await mkdir(run.workDirectory, { recursive: true });
    } catch {
      this.block(run.targetId, "output");
      active.stopReason = "output";
      throw new Error("无法创建录制文件夹，请修正目录权限后点击恢复录制");
    }
    for (let attempt = 0; !active.abort.signal.aborted; attempt++) {
      this.update(active, "recording");
      const args = [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "warning",
        "-rw_timeout",
        "15000000",
        "-i",
        run.sourceUrl,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
        "-dn",
      ];
      if (config.videoBitrate === "source") args.push("-c", "copy");
      else
        args.push(
          "-c:v",
          "libx264",
          "-b:v",
          config.videoBitrate,
          "-c:a",
          "aac",
        );
      args.push(
        "-f",
        "segment",
        "-segment_time",
        String(config.segmentSeconds),
        "-reset_timestamps",
        "1",
        path.join(
          run.workDirectory,
          `attempt-${String(attempt).padStart(3, "0")}-part-%05d.flv`,
        ),
      );
      active.process = this.runner.start(args);
      if (active.abort.signal.aborted) this.stopProcess(active);
      const exit = await active.process.completion;
      active.process = null;
      if (active.timer) clearTimeout(active.timer);
      await this.indexFiles(run);
      if (active.abort.signal.aborted) break;
      if (exit.code === 0) {
        this.streamEnded(active);
        break;
      }
      const diskNow = await this.disk.probe(config.outputDir, config);
      if (diskNow.level === "stop" || diskNow.level === "unavailable") {
        this.block(run.targetId, "disk");
        active.stopReason = "disk";
        throw new Error("录制盘空间不足或不可写，已保留分片");
      }
      if (
        /error opening output|could not write header|permission denied|invalid argument|no space left|read-only file system|unknown encoder/i.test(
          exit.stderr,
        )
      ) {
        this.block(run.targetId, "output");
        active.stopReason = "output";
        throw new Error("输出文件或编码配置错误，请修正设置后点击恢复录制");
      }
      if (this.retryDelays[attempt] === undefined) {
        this.streamEnded(active);
        throw new Error("断流重试已耗尽，将在冷却后重新检查直播");
      }
      this.update(active, "retry_wait", `连接中断，第 ${attempt + 1} 次重试`);
      await delay(this.retryDelays[attempt], active.abort.signal);
    }
    const files = await this.indexFiles(run);
    if (!files.length && !active.abort.signal.aborted)
      throw new Error("直播流结束但没有生成录制内容");
    if (files.length) {
      run.mergeState = config.autoMerge ? "pending" : "none";
      if (
        config.autoMerge &&
        !["disk", "exit", "output"].includes(active.stopReason ?? "")
      ) {
        await this.mergeActive(active, files);
      }
    }
    run.stopReason = active.stopReason;
    run.endedAt = new Date().toISOString();
    this.update(active, active.abort.signal.aborted ? "stopped" : "completed");
  }

  private async failed(active: Active, error: unknown): Promise<void> {
    // Always settle the run even if indexing fails because the disk disappeared.
    try {
      await this.indexFiles(active.run);
    } catch {
      /* Known file indexes remain in the database. */
    }
    active.run.mergeState = "pending";
    active.run.endedAt = new Date().toISOString();
    active.run.stopReason = active.stopReason;
    const target = this.repo.target(active.run.targetId);
    if (target)
      this.repo.saveTarget({ ...target, retryAt: Date.now() + 60000 });
    this.update(
      active,
      "failed",
      error instanceof Error ? error.message : "录制失败，已保留现有文件",
    );
  }

  private streamEnded(active: Active): void {
    if (active.streamEnded || active.stopReason) return;
    active.streamEnded = true;
    this.onStreamEnded({ ...active.run });
  }

  private block(targetId: string, reason: "disk" | "output"): void {
    const target = this.repo.target(targetId);
    if (target)
      this.repo.saveTarget({
        ...target,
        blockedReason: reason,
        blockedRoomId: target.roomId,
      });
  }

  private update(
    active: Active,
    state: RecordingRun["state"],
    message: string | null = null,
  ): void {
    active.run.state = state;
    if (message) active.run.message = message;
    this.repo.saveRun(active.run);
    this.changed();
  }

  async indexFiles(run: RecordingRun): Promise<RecordingFile[]> {
    let names: string[];
    try {
      names = await readdir(run.workDirectory);
    } catch {
      return this.repo.files(run.id).filter((file) => file.kind === "segment");
    }
    const files: RecordingFile[] = [];
    for (const name of names
      .filter((name) => /^attempt-\d+-part-\d+\.flv$/.test(name))
      .sort()) {
      const filePath = path.join(run.workDirectory, name);
      try {
        const info = await stat(filePath);
        if (info.size > 0)
          files.push({
            path: filePath,
            bytes: info.size,
            kind: "segment",
            exists: true,
          });
      } catch {
        const known = this.repo
          .files(run.id)
          .find((file) => file.path === filePath);
        if (known) files.push({ ...known, exists: false });
      }
    }
    if (run.outputPath) {
      try {
        const info = await stat(run.outputPath);
        files.push({
          path: run.outputPath,
          bytes: info.size,
          kind: "output",
          exists: true,
        });
      } catch {
        /* Missing output is represented by its run record. */
      }
    }
    this.repo.replaceFiles(run.id, files);
    return files.filter((file) => file.kind === "segment");
  }

  private async mergeActive(
    active: Active,
    segments: RecordingFile[],
  ): Promise<void> {
    const { run, config } = active;
    const disk = await this.disk.probe(run.directory, this.repo.settings());
    const needed =
      segments.reduce((sum, file) => sum + file.bytes, 0) +
      this.repo.settings().stopGiB * GiB;
    if (disk.level === "unavailable" || disk.freeBytes < needed) {
      run.message = "合并空间不足，分片已保留，可稍后手动合并";
      this.repo.saveRun(run);
      return;
    }
    if (active.stopReason === "exit" || active.stopReason === "disk") return;
    this.update(active, "merging");
    const destination = path.join(
      run.directory,
      `${safeName(run.name)}-${run.startedAt.slice(0, 19).replace(/[:T]/g, "-")}-${run.id.slice(0, 8)}.flv`,
    );
    const temporary = path.join(run.workDirectory, "merged.tmp.flv");
    if (segments.length === 1) await copyFile(segments[0].path, temporary);
    else {
      const manifest = path.join(run.workDirectory, "concat.txt");
      await writeFile(
        manifest,
        segments
          .map(
            (file) =>
              `file '${file.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`,
          )
          .join("\n"),
        "utf8",
      );
      active.process = this.runner.start([
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
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
      const exit = await active.process.completion;
      active.process = null;
      if (active.timer) clearTimeout(active.timer);
      if (
        exit.code !== 0 ||
        ["exit", "disk", "removed"].includes(active.stopReason ?? "")
      ) {
        run.message = "合并未完成，原分片已保留";
        return;
      }
    }
    await rename(temporary, destination);
    run.outputPath = destination;
    run.mergeState = "completed";
    if (!config.keepSegments) {
      // Delete only the indexed fragments of this run, never a user-selected directory.
      for (const file of segments) {
        try {
          await rm(file.path);
        } catch {
          run.message = "合并已完成，部分分片未能清理，原文件已保留";
        }
      }
    }
    await this.indexFiles(run);
  }

  async merge(runId: string): Promise<void> {
    if (this.closing) throw new Error("应用正在退出");
    const run = this.repo.run(runId);
    if (!run) throw new Error("找不到录制记录");
    if (this.isActive(run.targetId))
      throw new Error("该主播仍有任务运行，请等待结束");
    if (run.mergeState === "completed") return;
    const originalState = run.state;
    const active: Active = {
      run,
      config: { ...this.repo.settings(), outputDir: run.directory },
      abort: new AbortController(),
      process: null,
      done: Promise.resolve(),
      stopReason: null,
    };
    this.active.set(run.targetId, active);
    active.done = (async () => {
      const files = await this.indexFiles(run);
      if (!files.length)
        throw new Error("没有可合并的分片，请确认录制磁盘在线");
      await this.mergeActive(active, files);
      run.state = originalState;
      this.repo.saveRun(run);
    })()
      .catch((error) => {
        run.state = originalState;
        run.mergeState = "pending";
        run.message =
          error instanceof Error ? error.message : "合并失败，分片已保留";
        this.repo.saveRun(run);
        throw error;
      })
      .finally(() => {
        if (active.timer) clearTimeout(active.timer);
        active.process?.kill();
        this.active.delete(run.targetId);
        this.changed();
      });
    return active.done;
  }
}
