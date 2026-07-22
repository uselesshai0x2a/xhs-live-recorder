import { abortableDelay } from "./abortable-delay";
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
      await abortableDelay(this.intervalMs, signal);
    }
  }
}
