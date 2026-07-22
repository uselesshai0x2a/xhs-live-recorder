import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonTargetMetadataStore } from "./json-target-metadata-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonTargetMetadataStore", () => {
  it("updates only the matching target name", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "target-store-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "target.json");
    await writeFile(
      filePath,
      JSON.stringify({
        polling: { interval_ms: 60_000, request_interval_ms: 5_000 },
        targets: [
          {
            id: "one",
            platform: "fake",
            name: "Old",
            params: { key: "value" },
          },
          { id: "two", platform: "fake", name: "Keep", params: {} },
        ],
      }),
    );

    await new JsonTargetMetadataStore(filePath).updateName("one", "New");

    const config = JSON.parse(await readFile(filePath, "utf8")) as {
      polling: { request_interval_ms: number };
      targets: Array<{ id: string; name: string; params: unknown }>;
    };
    expect(config.polling.request_interval_ms).toBe(5_000);
    expect(config.targets).toEqual([
      { id: "one", platform: "fake", name: "New", params: { key: "value" } },
      { id: "two", platform: "fake", name: "Keep", params: {} },
    ]);
  });
});
