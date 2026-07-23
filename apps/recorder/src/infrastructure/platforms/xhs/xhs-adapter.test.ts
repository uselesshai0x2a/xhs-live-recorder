import { describe, expect, it, vi } from "vitest";
import type { TargetDefinition } from "../../../domain/live";
import { generateXhsLiveStreamAddress, XhsAdapter } from "./xhs-adapter";

const auth = {
  headers: {
    cookie: "cookie-value",
    "x-s": "signature-value",
    "x-s-common": "common-value",
  },
};

const expectedUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

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
        recordingIdentity: {
          platform: "xhs",
          targetKey: "alice",
          roomKey: "room-1",
        },
      },
    });
    if (result.state !== "live") {
      throw new Error("Expected a live result");
    }
    await expect(
      adapter.resolveLiveAddress(result.session, new AbortController().signal),
    ).resolves.toEqual({
      status: "resolved",
      address: "https://live-source-play-hw.xhscdn.com/live/room-1.flv",
    });
  });

  it("generates the confirmed XHS FLV stream address from room_id", () => {
    expect(generateXhsLiveStreamAddress("570374211240727213")).toBe(
      "https://live-source-play-hw.xhscdn.com/live/570374211240727213.flv",
    );
  });

  it("does not resolve a stream address without room_id", async () => {
    const adapter = adapterWithPayload({});

    await expect(
      adapter.resolveLiveAddress(
        {
          platform: "xhs",
          targetId: "xhs:alice",
          metadata: {},
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "missing_room_id" });
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

  it("extracts the observed target name from user_one_box.title", async () => {
    const adapter = adapterWithPayload({
      data: {
        onebox_list: [
          {
            user_one_box: {
              title: "Observed Name",
              live_info: { status: 0 },
            },
          },
        ],
      },
    });

    await expect(
      adapter.checkLiveStatus(
        adapter.validateTarget(target),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ state: "offline", observedName: "Observed Name" });
  });

  it("reuses search_id and creates a new request_id for each request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const requestHeaders: Headers[] = [];
    const fetchFn = async (
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      requestHeaders.push(new Headers(init?.headers));
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
    for (const headers of requestHeaders) {
      expect(headers.get("user-agent")).toBe(expectedUserAgent);
      expect(headers.get("x-b3-traceid")).toBeNull();
      expect(headers.get("cookie")).toBe("cookie-value");
      expect(headers.get("x-s")).toBe("signature-value");
      expect(headers.get("x-s-common")).toBe("common-value");
    }
  });

  it("classifies an abnormal account state without returning offline", async () => {
    const adapter = new XhsAdapter(auth, {
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            success: false,
            msg: "\u8d26\u53f7\u72b6\u6001\u5f02\u5e38",
          }),
        ),
    });

    await expect(
      adapter.checkLiveStatus(
        adapter.validateTarget(target),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      kind: "ACCOUNT_RESTRICTED",
      disablesPlatform: true,
    });
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
