import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { XhsAuthHeaders } from "../platforms/xhs/xhs-auth-refresher";

export class JsonXhsAuthStore {
  constructor(private readonly filePath: string) {}

  async save(headers: XhsAuthHeaders): Promise<void> {
    const source = await readFile(this.filePath, "utf8");
    const config = JSON.parse(source) as unknown;
    if (!isRecord(config)) {
      throw new Error("auth.json root must be an object");
    }

    const xhs = isRecord(config.xhs) ? config.xhs : {};
    const nextHeaders: Record<string, string> = {
      cookie: headers.cookie,
      "x-s": headers.xS,
      "x-s-common": headers.xSCommon ?? "",
    };
    const next = {
      ...config,
      xhs: { ...xhs, headers: nextHeaders },
    };

    const temporaryPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
