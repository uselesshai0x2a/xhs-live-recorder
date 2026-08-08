import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { LiveDiscoveryService } from "./application/live-discovery-service";
import { LiveMonitorService } from "./application/live-monitor-service";
import { PollingService } from "./application/polling-service";
import { RecordingCoordinator } from "./application/recording-coordinator";
import { RecordingManager } from "./application/recording-manager";
import { ConfigError, loadConfig } from "./config/load-config";
import { JsonTargetMetadataStore } from "./infrastructure/config/json-target-metadata-store";
import { JsonXhsAuthStore } from "./infrastructure/config/json-xhs-auth-store";
import {
  StaticFfmpegBinaryProvider,
  StaticFfmpegRunner,
} from "./infrastructure/ffmpeg/static-ffmpeg-runner";
import { StartupLog } from "./infrastructure/logging/startup-log";
import { XhsAdapter } from "./infrastructure/platforms/xhs/xhs-adapter";
import { PuppeteerXhsAuthRefresher } from "./infrastructure/platforms/xhs/xhs-auth-refresher";
import { CompositeLiveEventSink } from "./infrastructure/sinks/composite-live-event-sink";
import { ConsoleLiveEventSink } from "./infrastructure/sinks/console/console-live-event-sink";
import { ConsoleRecordingEventSink } from "./infrastructure/sinks/console/console-recording-event-sink";
import { PlatformAdapterRegistry } from "./ports/platform-adapter";

interface CliOptions {
  readonly once: boolean;
  readonly targetId?: string;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseCliOptions(args);
  const runtimeDirectory = getRuntimeDirectory();
  const configDirectory =
    process.env.LIVE_RECORDER_CONFIG_DIR ??
    path.join(runtimeDirectory, isSea() ? "config" : "src/config");
  const config = await loadConfig(configDirectory);
  const xhsAuth = config.platformAuth.xhs;
  if (xhsAuth === undefined) {
    throw new ConfigError(
      "auth.json is missing the xhs platform configuration",
    );
  }

  const authStore = new JsonXhsAuthStore(
    path.join(configDirectory, "auth.json"),
  );
  const probeKeyword = resolveProbeKeyword(config.targets);
  const authRefresher = new PuppeteerXhsAuthRefresher({
    ...(probeKeyword === undefined ? {} : { probeKeyword }),
    headless: process.env.XHS_BROWSER_HEADLESS === "1",
    logger: (message) =>
      console.log(`${new Date().toISOString()} ${message}`),
  });
  const xhsAdapter = new XhsAdapter(xhsAuth, {
    authRefresher,
    onHeadersUpdated: (headers) => authStore.save(headers),
    logger: (message) =>
      console.log(`${new Date().toISOString()} ${message}`),
  });
  const registry = new PlatformAdapterRegistry([xhsAdapter]);
  const discovery = new LiveDiscoveryService(registry);
  for (const target of config.targets) {
    discovery.validateTarget(target);
  }

  const recordingSink = new ConsoleRecordingEventSink();
  const recordingManager = config.recording.enabled
    ? new RecordingManager(
        config.recording,
        new StaticFfmpegRunner(new StaticFfmpegBinaryProvider()),
        recordingSink,
      )
    : null;
  // Validate the bundled binary during startup, before a live event arrives.
  if (recordingManager !== null) {
    new StaticFfmpegBinaryProvider().getPath();
  }

  const abortController = new AbortController();
  const stop = (): void => {
    abortController.abort();
    void recordingManager?.stopAll().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `${new Date().toISOString()} Unable to stop recordings: ${message}`,
      );
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const liveSinks = [new ConsoleLiveEventSink()];
    if (recordingManager !== null) {
      liveSinks.push(new RecordingCoordinator(recordingManager, recordingSink));
    }
    const monitor = new LiveMonitorService(
      config.targets,
      discovery,
      new CompositeLiveEventSink(liveSinks),
      new JsonTargetMetadataStore(path.join(configDirectory, "target.json")),
      config.requestIntervalMs,
    );
    if (options.targetId !== undefined) {
      await monitor.checkTarget(options.targetId, abortController.signal);
      await recordingManager?.waitForIdle();
      return;
    }

    const polling = new PollingService(monitor, config.pollIntervalMs);
    if (options.once) {
      await polling.runOnce(abortController.signal);
      await recordingManager?.waitForIdle();
      return;
    }

    console.log(
      `${new Date().toISOString()} Live polling started: ${config.targets.length} target(s), interval=${config.pollIntervalMs}ms`,
    );
    await polling.run(abortController.signal);
  } finally {
    await recordingManager?.stopAll();
    await authRefresher.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function resolveProbeKeyword(
  targets: readonly { readonly params: unknown }[],
): string | undefined {
  for (const target of targets) {
    if (
      target.params !== null &&
      typeof target.params === "object" &&
      "key_word" in target.params
    ) {
      const keyWord = (target.params as { key_word: unknown }).key_word;
      if (typeof keyWord === "string" && keyWord.trim() !== "") {
        return keyWord.trim();
      }
    }
  }
  return undefined;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let once = false;
  let targetId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--once") {
      once = true;
      continue;
    }
    if (argument === "--target") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ConfigError("--target requires a target id");
      }
      targetId = value;
      index += 1;
      continue;
    }
    throw new ConfigError(`Unknown command line option: ${argument}`);
  }

  return {
    once,
    ...(targetId === undefined ? {} : { targetId }),
  };
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (isSea() || path.resolve(currentFile) === entryFile) {
  void runCli();
}

async function runCli(): Promise<void> {
  let startupLog: StartupLog | undefined;
  try {
    if (isSea()) process.chdir(getRuntimeDirectory());
    const logDirectory =
      process.env.LIVE_RECORDER_LOG_DIR ?? path.resolve(process.cwd(), "logs");
    startupLog = await StartupLog.start(logDirectory);
    console.log(
      `${new Date().toISOString()} Startup log: ${startupLog.filePath}`,
    );
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${new Date().toISOString()} Recorder startup failed: ${message}`,
    );
    process.exitCode = 1;
  } finally {
    await startupLog?.close();
  }
}

function getRuntimeDirectory(): string {
  return isSea() ? path.dirname(process.execPath) : process.cwd();
}
