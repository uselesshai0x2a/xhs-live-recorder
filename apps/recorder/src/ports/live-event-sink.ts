import type { LiveEvent } from "../domain/live";

export interface LiveEventSink {
  deliver(event: LiveEvent): Promise<void>;
}
