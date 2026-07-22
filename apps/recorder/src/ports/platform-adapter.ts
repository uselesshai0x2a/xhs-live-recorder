import type {
  LiveAddressResolution,
  LiveCheckResult,
  LiveSession,
  PlatformTarget,
  TargetDefinition,
} from "../domain/live";

export interface LivePlatformAdapter {
  readonly platform: string;

  validateTarget(target: TargetDefinition): PlatformTarget;

  checkLiveStatus(
    target: PlatformTarget,
    signal: AbortSignal,
  ): Promise<LiveCheckResult>;

  resolveLiveAddress(
    session: LiveSession,
    signal: AbortSignal,
  ): Promise<LiveAddressResolution>;
}

export class PlatformAdapterRegistry {
  readonly #adapters = new Map<string, LivePlatformAdapter>();

  constructor(adapters: readonly LivePlatformAdapter[]) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.platform)) {
        throw new Error(`Duplicate platform adapter: ${adapter.platform}`);
      }
      this.#adapters.set(adapter.platform, adapter);
    }
  }

  get(platform: string): LivePlatformAdapter {
    const adapter = this.#adapters.get(platform);
    if (adapter === undefined) {
      throw new Error(`No platform adapter registered for: ${platform}`);
    }
    return adapter;
  }
}
