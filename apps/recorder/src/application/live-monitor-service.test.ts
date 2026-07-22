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
import { LiveDiscoveryService } from "./live-discovery-service";
import { LiveMonitorService } from "./live-monitor-service";

describe("LiveMonitorService", () => {
  it("delivers initial and changed states but suppresses duplicates", async () => {
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

function offline(): LiveCheckResult {
  return { state: "offline" };
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
