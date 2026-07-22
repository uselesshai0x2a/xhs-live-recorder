import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TargetDefinition } from "../domain/live";
import type { RecordingConfig } from "../domain/recording";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_INTERVAL_MS = 5_000;

export interface RecorderConfig {
  readonly pollIntervalMs: number;
  readonly requestIntervalMs: number;
  readonly targets: readonly TargetDefinition[];
  readonly platformAuth: Readonly<Record<string, unknown>>;
  readonly recording: RecordingConfig;
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
  const [targetInput, authInput, recordingInput] = await Promise.all([
    readJson(path.join(directory, "target.json")),
    readJson(path.join(directory, "auth.json")),
    readOptionalJson(path.join(directory, "recording.json"), {}),
  ]);

  return {
    pollIntervalMs: parsePollInterval(targetInput),
    requestIntervalMs: parseRequestInterval(targetInput),
    targets: parseTargets(targetInput),
    platformAuth: parsePlatformAuth(authInput),
    recording: parseRecordingConfig(recordingInput),
  };
}

async function readOptionalJson(
  filePath: string,
  fallback: unknown,
): Promise<unknown> {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (
      error instanceof ConfigError &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "ENOENT"
    ) {
      return fallback;
    }
    throw error;
  }
}

function parseRecordingConfig(input: unknown): RecordingConfig {
  const root = requireRecord(input, "recording.json root");
  const segmentation =
    root.segmentation === undefined
      ? {}
      : requireRecord(root.segmentation, "recording.segmentation");
  const outputDirectory =
    root.output_dir === undefined
      ? "recordings"
      : requireNonEmptyString(root.output_dir, "recording.output_dir");
  const bitrate = root.video_bitrate ?? "source";
  if (typeof bitrate !== "string" || bitrate.trim() === "") {
    throw new ConfigError("recording.video_bitrate must be a non-empty string");
  }
  const retryDelays = root.retry_delays_ms ?? [5_000, 15_000, 30_000];
  if (
    !Array.isArray(retryDelays) ||
    !retryDelays.every((value) => Number.isInteger(value) && value >= 0)
  ) {
    throw new ConfigError(
      "recording.retry_delays_ms must be an array of non-negative integers",
    );
  }

  return {
    enabled: parseBoolean(root.enabled, true, "recording.enabled"),
    outputDirectory,
    segmentation: {
      enabled: parseBoolean(
        segmentation.enabled,
        true,
        "recording.segmentation.enabled",
      ),
      durationSeconds: parsePositiveInteger(
        segmentation.duration_seconds,
        1_800,
        "recording.segmentation.duration_seconds",
      ),
      autoMerge: parseBoolean(
        segmentation.auto_merge,
        true,
        "recording.segmentation.auto_merge",
      ),
      keepSegments: parseBoolean(
        segmentation.keep_segments,
        false,
        "recording.segmentation.keep_segments",
      ),
    },
    videoBitrate: bitrate.trim() === "source" ? "source" : bitrate.trim(),
    retryDelaysMs: retryDelays as number[],
    gracefulStopTimeoutMs: parsePositiveInteger(
      root.graceful_stop_timeout_ms,
      10_000,
      "recording.graceful_stop_timeout_ms",
    ),
  };
}

function parseBoolean(
  value: unknown,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${label} must be a boolean`);
  }
  return value;
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
  return value as number;
}

function parseRequestInterval(input: unknown): number {
  const root = requireRecord(input, "target.json root");
  if (root.polling === undefined) {
    return DEFAULT_REQUEST_INTERVAL_MS;
  }
  const polling = requireRecord(root.polling, "polling");
  if (polling.request_interval_ms === undefined) {
    return DEFAULT_REQUEST_INTERVAL_MS;
  }
  const interval = polling.request_interval_ms;
  if (!Number.isInteger(interval) || (interval as number) < 0) {
    throw new ConfigError(
      "polling.request_interval_ms must be a non-negative integer",
    );
  }
  return interval as number;
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
