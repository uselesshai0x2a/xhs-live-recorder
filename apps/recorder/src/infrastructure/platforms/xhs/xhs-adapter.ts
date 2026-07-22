import { randomInt } from "node:crypto";
import {
  type LiveAddressResolution,
  type LiveCheckResult,
  LiveDiscoveryError,
  type LiveSession,
  type PlatformTarget,
  type TargetDefinition,
} from "../../../domain/live";
import type { LivePlatformAdapter } from "../../../ports/platform-adapter";

const XHS_PLATFORM = "xhs";
const XHS_ONEBOX_URL =
  "https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface XhsTargetParams {
  readonly keyWord: string;
}

interface XhsHeaders {
  readonly cookie: string;
  readonly xS: string;
  readonly xSCommon?: string;
}

export interface XhsAdapterOptions {
  readonly fetchFn?: FetchLike;
  readonly searchId?: string;
  readonly timeoutMs?: number;
}

export class XhsAdapter implements LivePlatformAdapter {
  readonly platform = XHS_PLATFORM;
  readonly #headers: XhsHeaders;
  readonly #fetch: FetchLike;
  readonly #searchId: string;
  readonly #timeoutMs: number;

  constructor(auth: unknown, options: XhsAdapterOptions = {}) {
    this.#headers = parseAuth(auth);
    this.#fetch = options.fetchFn ?? fetch;
    this.#searchId = options.searchId ?? generateDigits(21);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  validateTarget(target: TargetDefinition): PlatformTarget {
    if (target.platform !== this.platform) {
      throw new Error(`XHS adapter cannot handle platform: ${target.platform}`);
    }
    const params = requireRecord(target.params, `Target ${target.id} params`);
    const keyWord = requireNonEmptyString(
      params.key_word,
      `Target ${target.id} key_word`,
    );
    return { definition: target, data: { keyWord } satisfies XhsTargetParams };
  }

  async checkLiveStatus(
    target: PlatformTarget,
    signal: AbortSignal,
  ): Promise<LiveCheckResult> {
    const { keyWord } = target.data as XhsTargetParams;
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Response;

    try {
      response = await this.#fetch(XHS_ONEBOX_URL, {
        method: "POST",
        headers: this.#requestHeaders(),
        body: JSON.stringify({
          keyword: keyWord,
          search_id: this.#searchId,
          biz_type: "web_search_user",
          request_id: `${generateDigits(6)}-${Date.now()}`,
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !signal.aborted) {
        throw new LiveDiscoveryError(
          "TIMEOUT",
          this.platform,
          "XHS request timed out",
          {
            cause: error,
          },
        );
      }
      if (signal.aborted) {
        throw error;
      }
      throw new LiveDiscoveryError(
        "NETWORK_ERROR",
        this.platform,
        "XHS network request failed",
        {
          cause: error,
        },
      );
    }

    const responseText = await response.text();
    const payload = parsePayload(responseText, response.ok);
    const diagnostic = extractDiagnostic(payload, responseText);

    if (response.status === 401 || looksLikeAuthFailure(diagnostic)) {
      throw new LiveDiscoveryError(
        "AUTH_EXPIRED",
        this.platform,
        "XHS authentication expired",
        {
          disablesPlatform: true,
        },
      );
    }
    if (looksLikeSignatureFailure(diagnostic)) {
      throw new LiveDiscoveryError(
        "SIGNATURE_INVALID",
        this.platform,
        "XHS signature is invalid or expired",
        { disablesPlatform: true },
      );
    }
    if (response.status === 429) {
      throw new LiveDiscoveryError(
        "RATE_LIMITED",
        this.platform,
        "XHS rate limit reached",
      );
    }
    if (!response.ok) {
      throw new LiveDiscoveryError(
        "HTTP_ERROR",
        this.platform,
        `XHS request failed with HTTP ${response.status}`,
      );
    }
    if (isApiFailure(payload)) {
      throw new LiveDiscoveryError(
        "API_ERROR",
        this.platform,
        "XHS API returned a failure response",
      );
    }

    const liveInfo = findLiveInfo(payload);
    if (liveInfo === null) {
      return {
        state: "unknown",
        reason: "live_info is missing from the XHS response",
      };
    }
    if (liveInfo.status === 0) {
      return { state: "offline" };
    }
    if (liveInfo.status !== 2) {
      return {
        state: "unknown",
        reason: `Unsupported XHS live_info.status: ${String(liveInfo.status)}`,
      };
    }

    const roomId = optionalString(liveInfo.room_id);
    const xsecToken = optionalString(liveInfo.xsec_token);
    const sourceLink = optionalString(liveInfo.link);
    return {
      state: "live",
      session: {
        platform: this.platform,
        targetId: target.definition.id,
        ...(roomId === undefined ? {} : { roomId }),
        ...(xsecToken === undefined ? {} : { xsecToken }),
        ...(sourceLink === undefined ? {} : { sourceLink }),
        metadata: { liveInfo },
      },
    };
  }

  resolveLiveAddress(
    _session: LiveSession,
    _signal: AbortSignal,
  ): Promise<LiveAddressResolution> {
    return Promise.resolve({
      status: "unavailable",
      reason: "not_implemented",
    });
  }

  #requestHeaders(): Record<string, string> {
    return {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      cookie: this.#headers.cookie,
      "x-s": this.#headers.xS,
      ...(this.#headers.xSCommon === undefined
        ? {}
        : { "x-s-common": this.#headers.xSCommon }),
    };
  }
}

function parseAuth(input: unknown): XhsHeaders {
  const auth = requireRecord(input, "auth.xhs");
  const headers = requireRecord(auth.headers, "auth.xhs.headers");
  const xSCommon = optionalString(headers["x-s-common"]);
  return {
    cookie: requireNonEmptyString(headers.cookie, "auth.xhs.headers.cookie"),
    xS: requireNonEmptyString(headers["x-s"], "auth.xhs.headers.x-s"),
    ...(xSCommon === undefined ? {} : { xSCommon }),
  };
}

function parsePayload(source: string, responseOk: boolean): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    if (!responseOk) {
      return null;
    }
    throw new LiveDiscoveryError(
      "INVALID_JSON",
      XHS_PLATFORM,
      "XHS returned invalid JSON",
      {
        cause: error,
      },
    );
  }
}

function isApiFailure(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return payload.success === false;
}

function extractDiagnostic(payload: unknown, responseText: string): string {
  if (!isRecord(payload)) {
    return responseText.toLowerCase();
  }
  const parts = [payload.code, payload.msg, payload.message, payload.error]
    .filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )
    .map(String);
  return `${parts.join(" ")} ${responseText}`.toLowerCase();
}

function looksLikeAuthFailure(message: string): boolean {
  return /(未登录|登录失效|登录过期|login required|not logged|cookie expired|session expired|authentication expired)/i.test(
    message,
  );
}

function looksLikeSignatureFailure(message: string): boolean {
  return /(x-s|signature|invalid sign|sign invalid|签名失效|签名错误|签名校验)/i.test(
    message,
  );
}

function findLiveInfo(payload: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [payload];
  let visited = 0;
  while (queue.length > 0 && visited < 10_000) {
    const current = queue.shift();
    visited += 1;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (isRecord(current.live_info)) {
      return current.live_info;
    }
    queue.push(...Object.values(current));
  }
  return null;
}

function generateDigits(length: number): string {
  return Array.from({ length }, (_, index) =>
    String(randomInt(index === 0 ? 1 : 0, 10)),
  ).join("");
}

function optionalString(value: unknown): string | undefined {
  if (
    (typeof value === "string" || typeof value === "number") &&
    String(value).trim() !== ""
  ) {
    return String(value).trim();
  }
  return undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
