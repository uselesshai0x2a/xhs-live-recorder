import type { LiveMonitorService } from "./live-monitor-service";

export class PollingService {
  constructor(
    private readonly monitor: LiveMonitorService,
    private readonly intervalMs: number,
  ) {}

  runOnce(signal: AbortSignal): Promise<void> {
    return this.monitor.runPollingCycle(signal);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runOnce(signal);
      await waitForNextCycle(this.intervalMs, signal);
    }
  }
}

function waitForNextCycle(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
