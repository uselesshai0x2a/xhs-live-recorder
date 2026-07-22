import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isSea } from "node:sea";
import type {
  FfmpegExit,
  FfmpegRunner,
  RunningFfmpegProcess,
} from "../../ports/recording";

export interface FfmpegBinaryProvider {
  getPath(): string;
}

export class StaticFfmpegBinaryProvider implements FfmpegBinaryProvider {
  constructor(
    private readonly injectedPath: string | null = resolveProjectFfmpegPath(),
  ) {}

  getPath(): string {
    if (this.injectedPath === null || this.injectedPath.trim() === "") {
      throw new Error("Project-owned FFmpeg binary is unavailable");
    }
    try {
      accessSync(this.injectedPath, constants.X_OK);
    } catch (error) {
      throw new Error(
        `Project-owned FFmpeg binary is not executable: ${this.injectedPath}`,
        { cause: error },
      );
    }
    return this.injectedPath;
  }
}

function resolveProjectFfmpegPath(): string | null {
  const configuredPath = process.env.LIVE_RECORDER_FFMPEG_PATH?.trim();
  if (configuredPath !== undefined && configuredPath !== "") {
    return path.resolve(configuredPath);
  }
  if (isSea()) {
    return path.join(
      path.dirname(process.execPath),
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
  }
  try {
    const require = createRequire(import.meta.url);
    const moduleEntry = require.resolve("ffmpeg-static");
    return path.join(
      path.dirname(moduleEntry),
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
  } catch {
    return null;
  }
}

export class StaticFfmpegRunner implements FfmpegRunner {
  constructor(private readonly provider: FfmpegBinaryProvider) {}

  start(args: readonly string[]): RunningFfmpegProcess {
    const child = spawn(this.provider.getPath(), [...args], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });

    const completion = new Promise<FfmpegExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stderr }));
    });

    return {
      completion,
      requestQuit: () => {
        if (!child.killed && child.stdin?.writable) {
          child.stdin.write("q\n");
        }
      },
      terminate: () => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      },
    };
  }
}
