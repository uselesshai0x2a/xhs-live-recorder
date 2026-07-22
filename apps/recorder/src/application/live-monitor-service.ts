import {
  LiveDiscoveryError,
  type LiveDiscoveryResult,
  type LiveErrorKind,
  type LiveState,
  type TargetDefinition,
} from "../domain/live";
import type { LiveEventSink } from "../ports/live-event-sink";
import type { LiveDiscoveryService } from "./live-discovery-service";

interface TargetState {
  readonly state?: Exclude<LiveState, "unknown">;
  readonly hadError: boolean;
}

export class LiveMonitorService {
  readonly #targetStates = new Map<string, TargetState>();
  readonly #disabledPlatforms = new Set<string>();

  constructor(
    readonly targets: readonly TargetDefinition[],
    private readonly discovery: LiveDiscoveryService,
    private readonly sink: LiveEventSink,
  ) {}

  async runPollingCycle(signal: AbortSignal): Promise<void> {
    for (const target of this.targets) {
      if (signal.aborted) {
        return;
      }
      if (this.#disabledPlatforms.has(target.platform)) {
        continue;
      }
      const outcome = await this.#checkForPolling(target, signal);
      if (outcome === "stop-cycle") {
        return;
      }
    }
  }

  async checkTarget(
    targetId: string,
    signal: AbortSignal,
  ): Promise<LiveDiscoveryResult | null> {
    const target = this.targets.find((candidate) => candidate.id === targetId);
    if (target === undefined) {
      throw new Error(`Unknown target id: ${targetId}`);
    }
    if (this.#disabledPlatforms.has(target.platform)) {
      await this.#deliverError(
        target,
        "PLATFORM_DISABLED",
        `Platform ${target.platform} is disabled until restart`,
      );
      return null;
    }

    try {
      const result = await this.discovery.checkTarget(target, signal);
      if (result.state === "unknown") {
        await this.#deliverError(
          target,
          "UNKNOWN_RESPONSE",
          result.reason ?? "Unknown response",
        );
        return result;
      }
      await this.sink.deliver({ kind: "manual", target, result });
      return result;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      await this.#handleError(target, error);
      return null;
    }
  }

  async #checkForPolling(
    target: TargetDefinition,
    signal: AbortSignal,
  ): Promise<"continue" | "stop-cycle"> {
    try {
      const result = await this.discovery.checkTarget(target, signal);
      if (result.state === "unknown") {
        this.#targetStates.set(target.id, {
          ...this.#targetStates.get(target.id),
          hadError: true,
        });
        await this.#deliverError(
          target,
          "UNKNOWN_RESPONSE",
          result.reason ?? "Unknown response",
        );
        return "continue";
      }
      await this.#deliverStatusChange(target, result);
      return "continue";
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      this.#targetStates.set(target.id, {
        ...this.#targetStates.get(target.id),
        hadError: true,
      });
      await this.#handleError(target, error);
      return error instanceof LiveDiscoveryError &&
        error.kind === "RATE_LIMITED"
        ? "stop-cycle"
        : "continue";
    }
  }

  async #deliverStatusChange(
    target: TargetDefinition,
    result: LiveDiscoveryResult,
  ): Promise<void> {
    const nextState = result.state as Exclude<LiveState, "unknown">;
    const previous = this.#targetStates.get(target.id);
    this.#targetStates.set(target.id, { state: nextState, hadError: false });

    if (previous?.state === undefined) {
      await this.sink.deliver({ kind: "initial", target, result });
      return;
    }
    if (previous.state !== nextState) {
      await this.sink.deliver({
        kind: nextState === "live" ? "started" : "stopped",
        target,
        result,
      });
      return;
    }
    if (previous.hadError) {
      await this.sink.deliver({ kind: "recovered", target, result });
    }
  }

  async #handleError(target: TargetDefinition, error: unknown): Promise<void> {
    const discoveryError =
      error instanceof LiveDiscoveryError
        ? error
        : new LiveDiscoveryError(
            "UNEXPECTED_ERROR",
            target.platform,
            error instanceof Error ? error.message : "Unexpected error",
            { cause: error },
          );

    await this.#deliverError(
      target,
      discoveryError.kind,
      discoveryError.message,
    );
    if (discoveryError.disablesPlatform) {
      this.#disabledPlatforms.add(target.platform);
    }
  }

  async #deliverError(
    target: TargetDefinition,
    errorKind: LiveErrorKind,
    message: string,
  ): Promise<void> {
    await this.sink.deliver({
      kind: "error",
      target,
      checkedAt: new Date(),
      errorKind,
      message,
    });
  }
}
