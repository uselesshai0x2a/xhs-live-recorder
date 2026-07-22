import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDiscoveryService } from "./application/live-discovery-service";
import { LiveMonitorService } from "./application/live-monitor-service";
import { PollingService } from "./application/polling-service";
import { ConfigError, loadConfig } from "./config/load-config";
import { JsonTargetMetadataStore } from "./infrastructure/config/json-target-metadata-store";
import { XhsAdapter } from "./infrastructure/platforms/xhs/xhs-adapter";
import { ConsoleLiveEventSink } from "./infrastructure/sinks/console/console-live-event-sink";
import { PlatformAdapterRegistry } from "./ports/platform-adapter";

interface CliOptions {
  readonly once: boolean;
  readonly targetId?: string;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseCliOptions(args);
  const configDirectory =
    process.env.LIVE_RECORDER_CONFIG_DIR ??
    path.resolve(process.cwd(), "src/config");
  const config = await loadConfig(configDirectory);
  const xhsAuth = config.platformAuth.xhs;
  if (xhsAuth === undefined) {
    throw new ConfigError(
      "auth.json is missing the xhs platform configuration",
    );
  }

  const registry = new PlatformAdapterRegistry([new XhsAdapter(xhsAuth)]);
  const discovery = new LiveDiscoveryService(registry);
  for (const target of config.targets) {
    discovery.validateTarget(target);
  }

  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const monitor = new LiveMonitorService(
      config.targets,
      discovery,
      new ConsoleLiveEventSink(),
      new JsonTargetMetadataStore(path.join(configDirectory, "target.json")),
      config.requestIntervalMs,
    );
    if (options.targetId !== undefined) {
      await monitor.checkTarget(options.targetId, abortController.signal);
      return;
    }

    const polling = new PollingService(monitor, config.pollIntervalMs);
    if (options.once) {
      await polling.runOnce(abortController.signal);
      return;
    }

    console.log(
      `${new Date().toISOString()} Live polling started: ${config.targets.length} target(s), interval=${config.pollIntervalMs}ms`,
    );
    await polling.run(abortController.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
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
if (path.resolve(currentFile) === entryFile) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${new Date().toISOString()} Recorder startup failed: ${message}`,
    );
    process.exitCode = 1;
  });
}
