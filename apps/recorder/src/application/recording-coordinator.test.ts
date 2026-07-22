import { describe, expect, it } from "vitest";
import type { LiveEvent, LiveSession } from "../domain/live";
import type {
  RecordingEvent,
  RecordingHandle,
  RecordingResult,
  RecordingSelector,
  RecordingTaskSnapshot,
  StartRecordingCommand,
} from "../domain/recording";
import type {
  RecordingEventSink,
  RecordingManagerPort,
} from "../ports/recording";
import {
  deriveRecordingTaskId,
  RecordingCoordinator,
} from "./recording-coordinator";

describe("RecordingCoordinator", () => {
  it("starts manual live discoveries and deduplicates target events", async () => {
    const manager = new FakeManager();
    const coordinator = new RecordingCoordinator(manager, new FakeSink());
    const event = liveEvent("manual");

    await coordinator.deliver(event);
    await coordinator.deliver({ ...event, kind: "checked" });

    expect(manager.commands).toHaveLength(1);
    expect(manager.commands[0]?.sourceUrl).toBe("https://example.com/live.flv");
    expect(manager.commands[0]?.taskId).toBe("xhs-keyword-1-room-1-33c80097");
    expect(manager.commands[0]?.outputName).toBe("测试主播-20260722-123456");
  });

  it("stops the target task on a stopped event", async () => {
    const manager = new FakeManager();
    const coordinator = new RecordingCoordinator(manager, new FakeSink());
    await coordinator.deliver(liveEvent("started"));

    await coordinator.deliver({
      ...liveEvent("stopped"),
      result: { ...liveEvent("stopped").result, state: "offline" },
    });

    expect(manager.stopped).toEqual([
      { taskId: "xhs-keyword-1-room-1-33c80097" },
    ]);
  });

  it("starts a new task when a checked live target moves to a new room", async () => {
    const manager = new FakeManager();
    const coordinator = new RecordingCoordinator(manager, new FakeSink());
    const first = liveEvent("started");
    await coordinator.deliver(first);

    const second = liveEvent("checked");
    const session: LiveSession | null = second.result.session;
    if (session === null) throw new Error("Expected a live session");
    await coordinator.deliver({
      ...second,
      result: {
        ...second.result,
        session: {
          ...session,
          roomId: "room-2",
          recordingIdentity: {
            platform: "xhs",
            targetKey: "keyword-1",
            roomKey: "room-2",
          },
        },
      },
    });

    expect(manager.commands).toHaveLength(2);
    expect(manager.commands[0]?.taskId).not.toBe(manager.commands[1]?.taskId);
    expect(manager.stopped).toEqual([
      { taskId: "xhs-keyword-1-room-1-33c80097" },
    ]);
  });

  it("reports unavailable addresses without starting a task", async () => {
    const manager = new FakeManager();
    const sink = new FakeSink();
    const coordinator = new RecordingCoordinator(manager, sink);
    const event = liveEvent("initial");

    await coordinator.deliver({
      ...event,
      result: {
        ...event.result,
        addressResolution: { status: "unavailable", reason: "not implemented" },
      },
    });

    expect(manager.commands).toHaveLength(0);
    expect(sink.events[0]).toMatchObject({
      kind: "skipped",
      message: "not implemented",
    });
  });

  it("keeps taskId stable for the same keyword and room", async () => {
    const first = {
      platform: "xhs",
      targetKey: "94121806516",
      roomKey: "570374231565031072",
    };
    const same = { ...first };

    expect(deriveRecordingTaskId(same)).toBe(deriveRecordingTaskId(first));
    expect(
      deriveRecordingTaskId({
        ...first,
        roomKey: "different-room",
      }),
    ).not.toBe(deriveRecordingTaskId(first));

    const coordinator = new RecordingCoordinator(
      new FakeManager(),
      new FakeSink(),
    );
    await expect(coordinator.getTask(first)).resolves.toEqual({
      taskId: deriveRecordingTaskId(first),
      status: "nonexistent",
    });
  });
});

class FakeManager implements RecordingManagerPort {
  readonly commands: StartRecordingCommand[] = [];
  readonly stopped: RecordingSelector[] = [];
  get activeCount(): number {
    return this.commands.length;
  }

  start(command: StartRecordingCommand): Promise<RecordingHandle> {
    this.commands.push(command);
    return Promise.resolve({
      taskId: command.taskId ?? "task-1",
      sourceUrl: command.sourceUrl,
      status: "running",
      outputPath: "output.flv",
      segmentPaths: [],
      completion: new Promise<RecordingResult>(() => undefined),
    });
  }
  stop(selector: RecordingSelector): Promise<RecordingResult> {
    this.stopped.push(selector);
    return Promise.resolve(result("stopped"));
  }
  stopAll(): Promise<RecordingResult[]> {
    return Promise.resolve([]);
  }
  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }
  getTask(taskId: string): Promise<RecordingTaskSnapshot> {
    return Promise.resolve({ taskId, status: "nonexistent" });
  }
}

class FakeSink implements RecordingEventSink {
  readonly events: RecordingEvent[] = [];
  deliver(event: RecordingEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

type StatusLiveEvent = Exclude<LiveEvent, { readonly kind: "error" }>;

function liveEvent(
  kind: "initial" | "checked" | "started" | "stopped" | "manual",
): StatusLiveEvent {
  const checkedAt = new Date(2026, 6, 22, 12, 34, 56);
  return {
    kind,
    target: { id: "xhs:one", platform: "xhs", name: "测试主播", params: {} },
    result: {
      target: { id: "xhs:one", platform: "xhs", name: "测试主播", params: {} },
      state: "live",
      session: {
        platform: "xhs",
        targetId: "xhs:one",
        roomId: "room-1",
        recordingIdentity: {
          platform: "xhs",
          targetKey: "keyword-1",
          roomKey: "room-1",
        },
        metadata: {},
      },
      addressResolution: {
        status: "resolved",
        address: "https://example.com/live.flv",
      },
      reason: null,
      checkedAt,
    },
  };
}

function result(state: "completed" | "stopped" | "failed"): RecordingResult {
  return {
    taskId: "task-1",
    sourceUrl: "https://example.com/live.flv",
    state,
    outputPath: "output.flv",
    segmentPaths: [],
    startedAt: new Date(),
    endedAt: new Date(),
  };
}
