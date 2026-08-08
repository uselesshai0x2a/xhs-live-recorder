import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonXhsAuthStore } from "./json-xhs-auth-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonXhsAuthStore", () => {
  it("rewrites xhs headers while preserving other fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "xhs-auth-store-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "auth.json");
    await writeFile(
      filePath,
      JSON.stringify({
        xhs: {
          headers: { "x-s": "old", "x-s-common": "old", cookie: "old" },
          note: "keep me",
        },
        other: true,
      }),
    );

    await new JsonXhsAuthStore(filePath).save({
      cookie: "new-cookie",
      xS: "new-x-s",
      xSCommon: "new-common",
    });

    const written = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    expect(written).toEqual({
      xhs: {
        headers: {
          cookie: "new-cookie",
          "x-s": "new-x-s",
          "x-s-common": "new-common",
        },
        note: "keep me",
      },
      other: true,
    });
  });

  it("writes an empty x-s-common when none is provided", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "xhs-auth-store-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "auth.json");
    await writeFile(filePath, JSON.stringify({ xhs: { headers: {} } }));

    await new JsonXhsAuthStore(filePath).save({
      cookie: "c",
      xS: "x",
    });

    const written = JSON.parse(await readFile(filePath, "utf8")) as {
      xhs: { headers: Record<string, string> };
    };
    expect(written.xhs.headers["x-s-common"]).toBe("");
  });
});
