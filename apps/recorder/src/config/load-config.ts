import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TargetDefinition } from "../domain/live";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface RecorderConfig {
  readonly pollIntervalMs: number;
  readonly targets: readonly TargetDefinition[];
  readonly platformAuth: Readonly<Record<string, unknown>>;
}

export class ConfigError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ConfigError";
  }
}

export async function loadConfig(configDir?: string): Promise<RecorderConfig> {
  const directory = configDir ?? path.resolve(process.cwd(), "src/config");
  const [targetInput, authInput] = await Promise.all([
    readJson(path.join(directory, "target.json")),
    readJson(path.join(directory, "auth.json")),
  ]);

  return {
    pollIntervalMs: parsePollInterval(targetInput),
    targets: parseTargets(targetInput),
    platformAuth: parsePlatformAuth(authInput),
  };
}

async function readJson(filePath: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Unable to read configuration file: ${filePath}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigError(`Invalid JSON configuration: ${filePath}`, {
      cause: error,
    });
  }
}

function parsePollInterval(input: unknown): number {
  const root = requireRecord(input, "target.json root");
  if (root.polling === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const polling = requireRecord(root.polling, "polling");
  const interval = polling.interval_ms;
  if (!Number.isInteger(interval) || (interval as number) < 1_000) {
    throw new ConfigError(
      "polling.interval_ms must be an integer of at least 1000",
    );
  }
  return interval as number;
}

function parseTargets(input: unknown): readonly TargetDefinition[] {
  const root = requireRecord(input, "target.json root");
  if (!Array.isArray(root.targets) || root.targets.length === 0) {
    throw new ConfigError("target.json targets must be a non-empty array");
  }

  const ids = new Set<string>();
  return root.targets.map((item, index) => {
    const target = requireRecord(item, `targets[${index}]`);
    const id = requireNonEmptyString(target.id, `targets[${index}].id`);
    const platform = requireNonEmptyString(
      target.platform,
      `targets[${index}].platform`,
    ).toLowerCase();
    const name =
      target.name === undefined
        ? id
        : requireNonEmptyString(target.name, `targets[${index}].name`);

    if (ids.has(id)) {
      throw new ConfigError(`Duplicate target id: ${id}`);
    }
    ids.add(id);

    if (!("params" in target)) {
      throw new ConfigError(`targets[${index}].params is required`);
    }

    return { id, platform, name, params: target.params };
  });
}

function parsePlatformAuth(input: unknown): Readonly<Record<string, unknown>> {
  return requireRecord(input, "auth.json root");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
