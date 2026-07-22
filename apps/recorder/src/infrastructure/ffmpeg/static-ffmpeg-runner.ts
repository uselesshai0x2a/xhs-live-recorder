import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import ffmpegPath from "ffmpeg-static";
import type {
  FfmpegExit,
  FfmpegRunner,
  RunningFfmpegProcess,
} from "../../ports/recording";

export interface FfmpegBinaryProvider {
  getPath(): string;
}

export class StaticFfmpegBinaryProvider implements FfmpegBinaryProvider {
  constructor(private readonly injectedPath: string | null = ffmpegPath) {}

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
