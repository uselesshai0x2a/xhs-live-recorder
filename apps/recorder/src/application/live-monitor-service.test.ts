import { describe, expect, it } from "vitest";
import {
  type LiveAddressResolution,
  type LiveCheckResult,
  LiveDiscoveryError,
  type LiveEvent,
  type LiveSession,
  type PlatformTarget,
  type TargetDefinition,
} from "../domain/live";
import type { LiveEventSink } from "../ports/live-event-sink";
import {
  type LivePlatformAdapter,
  PlatformAdapterRegistry,
} from "../ports/platform-adapter";
import type { TargetMetadataStore } from "../ports/target-metadata-store";
import { LiveDiscoveryService } from "./live-discovery-service";
import { LiveMonitorService } from "./live-monitor-service";

describe("LiveMonitorService", () => {
  it("delivers a checked event when a clear state is unchanged", async () => {
    const adapter = new FakeAdapter("fake", [
      offline(),
      offline(),
      live(),
      offline(),
    ]);
    const { monitor, sink } = createMonitor([target("one", "fake")], [adapter]);
    const signal = new AbortController().signal;

    await monitor.runPollingCycle(signal);
    await monitor.runPollingCycle(signal);
    await monitor.runPollingCycle(signal);
    await monitor.runPollingCycle(signal);

    expect(sink.events.map((event) => event.kind)).toEqual([
      "initial",
      "checked",
      "started",
      "stopped",
    ]);
    expect(adapter.resolveCalls).toBe(1);
  });

  it("keeps the previous state on unknown and emits recovery", async () => {
    const adapter = new FakeAdapter("fake", [
      offline(),
      { state: "unknown", reason: "missing live_info" },
      offline(),
    ]);
    const { monitor, sink } = createMonitor([target("one", "fake")], [adapter]);
    const signal = new AbortController().signal;

    await monitor.runPollingCycle(signal);
    await monitor.runPollingCycle(signal);
    await monitor.runPollingCycle(signal);

    expect(sink.events.map((event) => event.kind)).toEqual([
      "initial",
      "error",
      "recovered",
    ]);
  });

  it("disables only the platform with invalid authentication", async () => {
    const broken = new FakeAdapter("broken", [
      new LiveDiscoveryError("AUTH_EXPIRED", "broken", "expired", {
        disablesPlatform: true,
      }),
    ]);
    const healthy = new FakeAdapter("healthy", [offline(), offline()]);
    const { monitor, sink } = createMonitor(
      [target("broken-target", "broken"), target("healthy-target", "healthy")],
      [broken, healthy],
    );
    const signal = new AbortController().signal;

    await monitor.runPollingCycle(signal);
    await monitor.runPollingCycle(signal);

    expect(broken.checkCalls).toBe(1);
    expect(healthy.checkCalls).toBe(2);
    expect(sink.events.map((event) => event.kind)).toEqual([
      "error",
      "initial",
      "checked",
    ]);
  });

  it("manual checks deliver results without changing polling state", async () => {
    const adapter = new FakeAdapter("fake", [offline(), offline()]);
    const { monitor, sink } = createMonitor([target("one", "fake")], [adapter]);
    const signal = new AbortController().signal;

    const manualResult = await monitor.checkTarget("one", signal);
    await monitor.runPollingCycle(signal);

    expect(manualResult?.state).toBe("offline");
    expect(sink.events.map((event) => event.kind)).toEqual([
      "manual",
      "initial",
    ]);
  });

  it("ends the current cycle after a rate limit response", async () => {
    const limited = new FakeAdapter("limited", [
      new LiveDiscoveryError("RATE_LIMITED", "limited", "slow down"),
      offline(),
    ]);
    const healthy = new FakeAdapter("healthy", [offline()]);
    const { monitor } = createMonitor(
      [target("first", "limited"), target("second", "healthy")],
      [limited, healthy],
    );

    await monitor.runPollingCycle(new AbortController().signal);

    expect(limited.checkCalls).toBe(1);
    expect(healthy.checkCalls).toBe(0);
  });

  it("waits between requests but not before the first request", async () => {
    const first = new FakeAdapter("first", [offline()]);
    const second = new FakeAdapter("second", [offline()]);
    const sink = new MemorySink();
    const delays: number[] = [];
    const monitor = new LiveMonitorService(
      [target("one", "first"), target("two", "second")],
      new LiveDiscoveryService(new PlatformAdapterRegistry([first, second])),
      sink,
      undefined,
      5_000,
      (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    );

    await monitor.runPollingCycle(new AbortController().signal);

    expect(delays).toEqual([5_000]);
    expect(first.checkCalls).toBe(1);
    expect(second.checkCalls).toBe(1);
  });

  it("updates observed target names without coupling the monitor to a platform", async () => {
    const adapter = new FakeAdapter("fake", [offline("Updated Name")]);
    const sink = new MemorySink();
    const metadataStore = new MemoryTargetMetadataStore();
    const monitor = new LiveMonitorService(
      [target("one", "fake")],
      new LiveDiscoveryService(new PlatformAdapterRegistry([adapter])),
      sink,
      metadataStore,
    );

    await monitor.runPollingCycle(new AbortController().signal);

    expect(metadataStore.updates).toEqual([
      { targetId: "one", name: "Updated Name" },
    ]);
    expect(monitor.targets[0]?.name).toBe("Updated Name");
    expect(sink.events[0]?.target.name).toBe("Updated Name");
  });
});

class FakeAdapter implements LivePlatformAdapter {
  checkCalls = 0;
  resolveCalls = 0;

  constructor(
    readonly platform: string,
    private readonly results: Array<LiveCheckResult | Error>,
  ) {}

  validateTarget(definition: TargetDefinition): PlatformTarget {
    return { definition, data: definition.params };
  }

  checkLiveStatus(): Promise<LiveCheckResult> {
    this.checkCalls += 1;
    const result = this.results.shift();
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    if (result === undefined) {
      return Promise.resolve(offline());
    }
    return Promise.resolve(result);
  }

  resolveLiveAddress(
    _session: LiveSession,
    _signal: AbortSignal,
  ): Promise<LiveAddressResolution> {
    this.resolveCalls += 1;
    return Promise.resolve({
      status: "unavailable",
      reason: "not_implemented",
    });
  }
}

class MemorySink implements LiveEventSink {
  readonly events: LiveEvent[] = [];

  deliver(event: LiveEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class MemoryTargetMetadataStore implements TargetMetadataStore {
  readonly updates: Array<{ targetId: string; name: string }> = [];

  updateName(targetId: string, name: string): Promise<void> {
    this.updates.push({ targetId, name });
    return Promise.resolve();
  }
}

function createMonitor(
  targets: readonly TargetDefinition[],
  adapters: readonly LivePlatformAdapter[],
): { monitor: LiveMonitorService; sink: MemorySink } {
  const sink = new MemorySink();
  const discovery = new LiveDiscoveryService(
    new PlatformAdapterRegistry(adapters),
  );
  return {
    monitor: new LiveMonitorService(targets, discovery, sink),
    sink,
  };
}

function target(id: string, platform: string): TargetDefinition {
  return { id, platform, name: id, params: {} };
}

function offline(observedName?: string): LiveCheckResult {
  return {
    state: "offline",
    ...(observedName === undefined ? {} : { observedName }),
  };
}

function live(): LiveCheckResult {
  return {
    state: "live",
    session: {
      platform: "fake",
      targetId: "one",
      roomId: "room-1",
      metadata: {},
    },
  };
}
