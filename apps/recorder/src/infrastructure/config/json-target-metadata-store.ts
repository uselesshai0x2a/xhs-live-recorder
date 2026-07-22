import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TargetMetadataStore } from "../../ports/target-metadata-store";

export class JsonTargetMetadataStore implements TargetMetadataStore {
  constructor(private readonly filePath: string) {}

  async updateName(targetId: string, name: string): Promise<void> {
    const source = await readFile(this.filePath, "utf8");
    const config = JSON.parse(source) as unknown;
    if (!isRecord(config) || !Array.isArray(config.targets)) {
      throw new Error("target.json does not contain a targets array");
    }

    let found = false;
    let changed = false;
    const targets = config.targets.map((value) => {
      if (!isRecord(value) || value.id !== targetId) {
        return value;
      }
      found = true;
      if (value.name === name) {
        return value;
      }
      changed = true;
      return { ...value, name };
    });

    if (!found) {
      throw new Error(`Cannot update unknown target id: ${targetId}`);
    }
    if (!changed) {
      return;
    }

    const temporaryPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ ...config, targets }, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
