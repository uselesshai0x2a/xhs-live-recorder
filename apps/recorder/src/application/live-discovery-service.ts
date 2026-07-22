import type { LiveDiscoveryResult, TargetDefinition } from "../domain/live";
import type { PlatformAdapterRegistry } from "../ports/platform-adapter";

export class LiveDiscoveryService {
  constructor(private readonly registry: PlatformAdapterRegistry) {}

  validateTarget(target: TargetDefinition): void {
    this.registry.get(target.platform).validateTarget(target);
  }

  async checkTarget(
    target: TargetDefinition,
    signal: AbortSignal,
  ): Promise<LiveDiscoveryResult> {
    const adapter = this.registry.get(target.platform);
    const platformTarget = adapter.validateTarget(target);
    const checkResult = await adapter.checkLiveStatus(platformTarget, signal);
    const checkedAt = new Date();

    if (checkResult.state === "live") {
      const addressResolution = await adapter.resolveLiveAddress(
        checkResult.session,
        signal,
      );
      return {
        target,
        state: "live",
        session: checkResult.session,
        addressResolution,
        reason: null,
        checkedAt,
      };
    }
    if (checkResult.state === "unknown") {
      return {
        target,
        state: "unknown",
        session: null,
        addressResolution: null,
        reason: checkResult.reason,
        checkedAt,
      };
    }
    return {
      target,
      state: "offline",
      session: null,
      addressResolution: null,
      reason: null,
      checkedAt,
    };
  }
}
