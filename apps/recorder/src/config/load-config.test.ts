import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./load-config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("loadConfig", () => {
  it("loads the platform-neutral target format", async () => {
    const directory = await writeConfig({
      polling: { interval_ms: 30_000, request_interval_ms: 5_000 },
      targets: [
        {
          id: "xhs:alice",
          platform: "XHS",
          name: "Alice",
          params: { key_word: "alice" },
        },
      ],
    });

    const config = await loadConfig(directory);

    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.requestIntervalMs).toBe(5_000);
    expect(config.targets).toEqual([
      {
        id: "xhs:alice",
        platform: "xhs",
        name: "Alice",
        params: { key_word: "alice" },
      },
    ]);
    expect(config.platformAuth).toHaveProperty("xhs");
  });

  it("rejects duplicate stable target ids", async () => {
    const target = {
      id: "duplicate",
      platform: "xhs",
      params: { key_word: "alice" },
    };
    const directory = await writeConfig({ targets: [target, target] });

    await expect(loadConfig(directory)).rejects.toThrowError(
      new ConfigError("Duplicate target id: duplicate"),
    );
  });

  it("rejects legacy grouped target configuration", async () => {
    const directory = await writeConfig({
      xhs: { targets: [{ key_word: "alice" }] },
    });

    await expect(loadConfig(directory)).rejects.toThrow(
      "target.json targets must be a non-empty array",
    );
  });
});

async function writeConfig(targetConfig: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-recorder-config-"));
  temporaryDirectories.push(directory);
  await Promise.all([
    writeFile(
      path.join(directory, "target.json"),
      JSON.stringify(targetConfig),
    ),
    writeFile(
      path.join(directory, "auth.json"),
      JSON.stringify({
        xhs: { headers: { cookie: "cookie", "x-s": "signature" } },
      }),
    ),
  ]);
  return directory;
}
