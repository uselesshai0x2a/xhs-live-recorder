export type LiveState = "offline" | "live" | "unknown";

export interface TargetDefinition {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly params: unknown;
}

export interface PlatformTarget {
  readonly definition: TargetDefinition;
  readonly data: unknown;
}

export interface LiveSession {
  readonly platform: string;
  readonly targetId: string;
  readonly roomId?: string;
  readonly xsecToken?: string;
  readonly sourceLink?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type LiveCheckResult =
  | { readonly state: "offline" }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "live"; readonly session: LiveSession };

export type LiveAddressResolution =
  | { readonly status: "resolved"; readonly address: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface LiveDiscoveryResult {
  readonly target: TargetDefinition;
  readonly state: LiveState;
  readonly session: LiveSession | null;
  readonly addressResolution: LiveAddressResolution | null;
  readonly reason: string | null;
  readonly checkedAt: Date;
}

export type LiveErrorKind =
  | "AUTH_EXPIRED"
  | "SIGNATURE_INVALID"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_JSON"
  | "UNKNOWN_RESPONSE"
  | "PLATFORM_DISABLED"
  | "UNEXPECTED_ERROR";

export class LiveDiscoveryError extends Error {
  readonly kind: LiveErrorKind;
  readonly platform: string;
  readonly disablesPlatform: boolean;

  constructor(
    kind: LiveErrorKind,
    platform: string,
    message: string,
    options: { cause?: unknown; disablesPlatform?: boolean } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "LiveDiscoveryError";
    this.kind = kind;
    this.platform = platform;
    this.disablesPlatform = options.disablesPlatform ?? false;
  }
}

export type LiveEvent =
  | {
      readonly kind: "initial" | "started" | "stopped" | "recovered" | "manual";
      readonly target: TargetDefinition;
      readonly result: LiveDiscoveryResult;
    }
  | {
      readonly kind: "error";
      readonly target: TargetDefinition;
      readonly checkedAt: Date;
      readonly errorKind: LiveErrorKind;
      readonly message: string;
    };
