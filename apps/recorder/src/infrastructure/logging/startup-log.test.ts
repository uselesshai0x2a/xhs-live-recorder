import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ConsoleOutput, StartupLog } from "./startup-log";

describe("StartupLog", () => {
  it("mirrors every console method into one unique startup file", async () => {
    const output = new FakeConsole();
    const directory = path.join(
      process.cwd(),
      ".test-output",
      `startup-log-${crypto.randomUUID()}`,
    );
    const log = await StartupLog.start(
      directory,
      output,
      new Date(2026, 6, 22, 12, 34, 56),
    );

    output.log("live", { room: 1 });
    output.info("info");
    output.warn("warning");
    output.error("failure");
    output.debug("debug");
    await log.close();

    expect(path.basename(log.filePath)).toMatch(
      /^recorder-20260722-123456-\d+\.log$/,
    );
    await expect(readFile(log.filePath, "utf8")).resolves.toBe(
      "live { room: 1 }\ninfo\nwarning\nfailure\ndebug\n",
    );
    expect(output.lines).toEqual([
      "live [object Object]",
      "info",
      "warning",
      "failure",
      "debug",
    ]);
  });
});

class FakeConsole implements ConsoleOutput {
  readonly lines: string[] = [];
  debug = (...data: unknown[]): void => this.capture(data);
  error = (...data: unknown[]): void => this.capture(data);
  info = (...data: unknown[]): void => this.capture(data);
  log = (...data: unknown[]): void => this.capture(data);
  warn = (...data: unknown[]): void => this.capture(data);

  private capture(data: readonly unknown[]): void {
    this.lines.push(data.map(String).join(" "));
  }
}
