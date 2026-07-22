import { describe, expect, it, vi } from "vitest";
import type { TargetDefinition } from "../../../domain/live";
import { XhsAdapter } from "./xhs-adapter";

const auth = {
  headers: {
    cookie: "cookie-value",
    "x-s": "signature-value",
    "x-s-common": "common-value",
  },
};

const target: TargetDefinition = {
  id: "xhs:alice",
  platform: "xhs",
  name: "Alice",
  params: { key_word: "alice" },
};

describe("XhsAdapter", () => {
  it("maps explicit status 0 to offline", async () => {
    const adapter = adapterWithPayload({
      data: { user: { live_info: { status: 0 } } },
    });

    const result = await adapter.checkLiveStatus(
      adapter.validateTarget(target),
      new AbortController().signal,
    );

    expect(result).toEqual({ state: "offline" });
  });

  it("maps explicit status 2 to a live session and preserves room context", async () => {
    const adapter = adapterWithPayload({
      data: {
        user: {
          live_info: {
            status: 2,
            room_id: "room-1",
            xsec_token: "xsec-1",
            link: "https://example.test/source",
          },
        },
      },
    });

    const result = await adapter.checkLiveStatus(
      adapter.validateTarget(target),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      state: "live",
      session: {
        platform: "xhs",
        targetId: "xhs:alice",
        roomId: "room-1",
        xsecToken: "xsec-1",
        sourceLink: "https://example.test/source",
      },
    });
    if (result.state !== "live") {
      throw new Error("Expected a live result");
    }
    await expect(
      adapter.resolveLiveAddress(result.session, new AbortController().signal),
    ).resolves.toEqual({ status: "unavailable", reason: "not_implemented" });
  });

  it("returns unknown instead of offline when live_info is missing", async () => {
    const adapter = adapterWithPayload({ data: { items: [] } });

    const result = await adapter.checkLiveStatus(
      adapter.validateTarget(target),
      new AbortController().signal,
    );

    expect(result).toEqual({
      state: "unknown",
      reason: "live_info is missing from the XHS response",
    });
  });

  it("reuses search_id and creates a new request_id for each request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = async (
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: { live_info: { status: 0 } } });
    };
    const adapter = new XhsAdapter(auth, {
      fetchFn,
      searchId: "123456789012345678901",
    });
    const platformTarget = adapter.validateTarget(target);
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000);

    await adapter.checkLiveStatus(platformTarget, new AbortController().signal);
    await adapter.checkLiveStatus(platformTarget, new AbortController().signal);
    now.mockRestore();

    expect(bodies.map((body) => body.search_id)).toEqual([
      "123456789012345678901",
      "123456789012345678901",
    ]);
    expect(bodies[0]?.request_id).toMatch(/^[0-9]{6}-1000$/);
    expect(bodies[1]?.request_id).toMatch(/^[0-9]{6}-2000$/);
  });

  it.each([
    [401, { message: "unauthorized" }, "AUTH_EXPIRED", true],
    [403, { message: "X-S signature invalid" }, "SIGNATURE_INVALID", true],
    [429, { message: "too many requests" }, "RATE_LIMITED", false],
    [500, { message: "server error" }, "HTTP_ERROR", false],
  ] as const)(
    "classifies HTTP %s without returning offline",
    async (status, payload, kind, disablesPlatform) => {
      const adapter = new XhsAdapter(auth, {
        fetchFn: () => Promise.resolve(jsonResponse(payload, status)),
      });

      const promise = adapter.checkLiveStatus(
        adapter.validateTarget(target),
        new AbortController().signal,
      );

      await expect(promise).rejects.toMatchObject({ kind, disablesPlatform });
    },
  );

  it("classifies invalid successful JSON", async () => {
    const adapter = new XhsAdapter(auth, {
      fetchFn: () => Promise.resolve(new Response("not-json", { status: 200 })),
    });

    await expect(
      adapter.checkLiveStatus(
        adapter.validateTarget(target),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "INVALID_JSON" });
  });

  it("classifies timeout and network failures", async () => {
    const timeoutAdapter = new XhsAdapter(auth, {
      timeoutMs: 1,
      fetchFn: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    });
    const networkAdapter = new XhsAdapter(auth, {
      fetchFn: () => Promise.reject(new Error("network down")),
    });

    await expect(
      timeoutAdapter.checkLiveStatus(
        timeoutAdapter.validateTarget(target),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "TIMEOUT" });
    await expect(
      networkAdapter.checkLiveStatus(
        networkAdapter.validateTarget(target),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "NETWORK_ERROR" });
  });
});

function adapterWithPayload(payload: unknown): XhsAdapter {
  return new XhsAdapter(auth, {
    fetchFn: () => Promise.resolve(jsonResponse(payload)),
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
