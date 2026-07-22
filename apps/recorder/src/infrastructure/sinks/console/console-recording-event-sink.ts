import type { RecordingEvent } from "../../../domain/recording";
import type { RecordingEventSink } from "../../../ports/recording";

export class ConsoleRecordingEventSink implements RecordingEventSink {
  deliver(event: RecordingEvent): Promise<void> {
    const task = event.taskId === undefined ? "" : ` task=${event.taskId}`;
    const path = event.path === undefined ? "" : ` path=${event.path}`;
    const attempt =
      event.attempt === undefined ? "" : ` attempt=${event.attempt}`;
    const message = event.message === undefined ? "" : ` ${event.message}`;
    const line = `${event.occurredAt.toISOString()} [recording:${event.outputName}] ${event.kind.toUpperCase()}${task}${attempt}${path}${message}`;
    if (event.kind === "failed" || event.kind === "skipped") {
      console.error(line);
    } else {
      console.log(line);
    }
    return Promise.resolve();
  }
}
