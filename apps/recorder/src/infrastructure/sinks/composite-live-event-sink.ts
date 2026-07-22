import type { LiveEvent } from "../../domain/live";
import type { LiveEventSink } from "../../ports/live-event-sink";

export class CompositeLiveEventSink implements LiveEventSink {
  constructor(private readonly sinks: readonly LiveEventSink[]) {}

  async deliver(event: LiveEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.deliver(event);
    }
  }
}
