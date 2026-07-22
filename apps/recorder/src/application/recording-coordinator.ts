import { createHash } from "node:crypto";
import type { LiveEvent, RecordingSessionIdentity } from "../domain/live";
import type {
  RecordingTaskIdentity,
  RecordingTaskSnapshot,
} from "../domain/recording";
import type { LiveEventSink } from "../ports/live-event-sink";
import type {
  RecordingEventSink,
  RecordingManagerPort,
} from "../ports/recording";

export class RecordingCoordinator implements LiveEventSink {
  readonly #taskByTarget = new Map<string, string>();
  readonly #lastTaskByTarget = new Map<string, string>();

  constructor(
    private readonly manager: RecordingManagerPort,
    private readonly recordingSink: RecordingEventSink,
  ) {}

  getTask(identity: RecordingSessionIdentity): Promise<RecordingTaskSnapshot> {
    return this.manager.getTask(deriveRecordingTaskId(identity));
  }

  async deliver(event: LiveEvent): Promise<void> {
    if (event.kind === "error" || event.kind === "recovered") {
      return;
    }

    if (event.kind === "stopped") {
      const taskId = this.#taskByTarget.get(event.target.id);
      if (taskId === undefined) return;
      void this.manager
        .stop({ taskId })
        .catch(() => undefined)
        .finally(() => {
          if (this.#taskByTarget.get(event.target.id) === taskId) {
            this.#taskByTarget.delete(event.target.id);
          }
        });
      return;
    }

    if (event.result.state !== "live") return;
    const identity = event.result.session?.recordingIdentity;
    if (identity === undefined) {
      if (event.kind === "checked") return;
      await this.recordingSink.deliver({
        kind: "skipped",
        outputName: event.target.name,
        occurredAt: new Date(),
        message: "Live session is missing a recording identity",
      });
      return;
    }
    const desiredTaskId = deriveRecordingTaskId(identity);
    const activeTaskId = this.#taskByTarget.get(event.target.id);
    const lastTaskId = this.#lastTaskByTarget.get(event.target.id);
    if (event.kind === "checked") {
      if (lastTaskId === undefined || lastTaskId === desiredTaskId) return;
      if (activeTaskId !== undefined) {
        void this.manager.stop({ taskId: activeTaskId }).catch(() => undefined);
      }
    } else if (
      event.kind !== "initial" &&
      event.kind !== "started" &&
      event.kind !== "manual"
    ) {
      return;
    } else if (activeTaskId !== undefined) {
      return;
    }

    const resolution = event.result.addressResolution;
    if (resolution?.status !== "resolved") {
      await this.recordingSink.deliver({
        kind: "skipped",
        outputName: event.target.name,
        occurredAt: new Date(),
        message:
          resolution?.status === "unavailable"
            ? resolution.reason
            : "Live address is unavailable",
      });
      return;
    }
    try {
      const taskIdentity: RecordingTaskIdentity = {
        ...identity,
        firstObservedAt: event.result.checkedAt,
      };
      const handle = await this.manager.start({
        taskId: desiredTaskId,
        taskIdentity,
        sourceUrl: resolution.address,
        outputName: buildAutomaticOutputName(
          event.target.name,
          event.result.checkedAt,
        ),
      });
      this.#taskByTarget.set(event.target.id, handle.taskId);
      this.#lastTaskByTarget.set(event.target.id, handle.taskId);
      void handle.completion
        .catch(() => undefined)
        .finally(() => {
          if (this.#taskByTarget.get(event.target.id) === handle.taskId) {
            this.#taskByTarget.delete(event.target.id);
          }
        });
    } catch (error) {
      await this.recordingSink.deliver({
        kind: "skipped",
        outputName: event.target.name,
        occurredAt: new Date(),
        message:
          error instanceof Error ? error.message : "Unable to start recording",
      });
    }
  }
}

export function deriveRecordingTaskId(
  identity: RecordingSessionIdentity,
): string {
  const platform = safeIdentityPart(identity.platform, "platform", 16);
  const target = safeIdentityPart(identity.targetKey, "target", 32);
  const room = safeIdentityPart(identity.roomKey, "room", 40);
  const hash = createHash("sha256")
    .update(
      `${identity.platform.toLowerCase()}\0${identity.targetKey}\0${identity.roomKey}`,
    )
    .digest("hex")
    .slice(0, 8);
  return `${platform}-${target}-${room}-${hash}`;
}

function safeIdentityPart(
  value: string,
  fallback: string,
  maximumLength: number,
): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, maximumLength);
  return safe === "" ? fallback : safe;
}

export function buildAutomaticOutputName(name: string, at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${name}-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}
