import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { formatWithOptions } from "node:util";

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";
type ConsoleWriter = (...data: unknown[]) => void;

export interface ConsoleOutput {
  debug: ConsoleWriter;
  error: ConsoleWriter;
  info: ConsoleWriter;
  log: ConsoleWriter;
  warn: ConsoleWriter;
}

const CONSOLE_METHODS: readonly ConsoleMethod[] = [
  "debug",
  "error",
  "info",
  "log",
  "warn",
];

export class StartupLog {
  readonly #originals = new Map<ConsoleMethod, ConsoleWriter>();
  #pendingWrite: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    readonly filePath: string,
    private readonly file: FileHandle,
    private readonly output: ConsoleOutput,
  ) {
    for (const method of CONSOLE_METHODS) {
      const original = output[method].bind(output);
      this.#originals.set(method, original);
      output[method] = (...data: unknown[]): void => {
        original(...data);
        this.#write(data);
      };
    }
  }

  static async start(
    directory: string,
    output: ConsoleOutput = console,
    now = new Date(),
  ): Promise<StartupLog> {
    const absoluteDirectory = path.resolve(directory);
    await mkdir(absoluteDirectory, { recursive: true });
    const baseName = `recorder-${formatLocalTimestamp(now)}-${process.pid}`;
    for (let attempt = 0; ; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${randomUUID().slice(0, 8)}`;
      const filePath = path.join(absoluteDirectory, `${baseName}${suffix}.log`);
      try {
        const file = await open(filePath, "wx");
        return new StartupLog(filePath, file, output);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) continue;
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const method of CONSOLE_METHODS) {
      const original = this.#originals.get(method);
      if (original !== undefined) this.output[method] = original;
    }
    await this.#pendingWrite;
    await this.file.close();
  }

  #write(data: readonly unknown[]): void {
    if (this.#closed) return;
    const line = `${formatWithOptions({ colors: false }, ...data)}\n`;
    const reportError = this.#originals.get("error");
    this.#pendingWrite = this.#pendingWrite
      .then(() => this.file.appendFile(line, "utf8"))
      .catch((error: unknown) => {
        reportError?.("Unable to write startup log:", error);
      });
  }
}

function formatLocalTimestamp(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
