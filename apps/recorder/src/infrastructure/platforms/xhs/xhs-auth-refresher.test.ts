import { describe, expect, it, vi } from "vitest";
import {
  extractHeaders,
  parseCookieHeader,
  PuppeteerXhsAuthRefresher,
  XhsAuthRefreshError,
} from "./xhs-auth-refresher";

const ONEBOX_URL =
  "https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox";

const capturedHeaders = {
  cookie: "fresh-cookie=1; web_session=abc",
  "x-s": "fresh-x-s",
  "x-s-common": "fresh-common",
};

describe("parseCookieHeader", () => {
  it("splits a cookie header into scoped cookie params", () => {
    expect(parseCookieHeader("a=1; b=two; web_session=xyz")).toEqual([
      { name: "a", value: "1", domain: ".xiaohongshu.com", path: "/" },
      { name: "b", value: "two", domain: ".xiaohongshu.com", path: "/" },
      {
        name: "web_session",
        value: "xyz",
        domain: ".xiaohongshu.com",
        path: "/",
      },
    ]);
  });

  it("ignores empty and malformed segments", () => {
    expect(parseCookieHeader("; =bad; good=1;")).toEqual([
      { name: "good", value: "1", domain: ".xiaohongshu.com", path: "/" },
    ]);
  });
});

describe("extractHeaders", () => {
  it("reads a case-insensitive cookie, x-s, and x-s-common", () => {
    expect(
      extractHeaders(
        {
          Cookie: "new-cookie",
          "X-S": "new-x-s",
          "X-S-Common": "new-common",
        },
        { cookie: "old", xS: "old" },
      ),
    ).toEqual({ cookie: "new-cookie", xS: "new-x-s", xSCommon: "new-common" });
  });

  it("falls back to the previous cookie when the request omits one", () => {
    expect(
      extractHeaders(
        { "x-s": "new-x-s" },
        { cookie: "old-cookie", xS: "old" },
      ),
    ).toEqual({ cookie: "old-cookie", xS: "new-x-s" });
  });

  it("throws when the signature header is missing", () => {
    expect(() =>
      extractHeaders({ cookie: "new-cookie" }, { cookie: "old", xS: "old" }),
    ).toThrow(XhsAuthRefreshError);
  });
});

describe("PuppeteerXhsAuthRefresher", () => {
  function createFakePage(headers = capturedHeaders) {
    return {
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      setCookie: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      waitForRequest: vi
        .fn()
        .mockImplementation(
          async (predicate: (request: unknown) => boolean) => {
            const request = {
              url: () => ONEBOX_URL,
              headers: () => headers,
            };
            if (!predicate(request)) {
              throw new Error("predicate did not match");
            }
            return request;
          },
        ),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createFakeBrowser(page = createFakePage()) {
    return {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("injects the current cookie and returns the captured headers", async () => {
    const page = createFakePage();
    const browser = createFakeBrowser(page);
    const browserLauncher = vi.fn().mockResolvedValue(browser);
    const refresher = new PuppeteerXhsAuthRefresher({ browserLauncher });

    const result = await refresher.refresh({
      cookie: "seed=1; b=2",
      xS: "old-x-s",
    });

    expect(result).toEqual({
      cookie: "fresh-cookie=1; web_session=abc",
      xS: "fresh-x-s",
      xSCommon: "fresh-common",
    });
    expect(page.setUserAgent).toHaveBeenCalledTimes(1);
    expect(page.setCookie).toHaveBeenCalledWith(
      expect.objectContaining({ name: "seed", value: "1" }),
      expect.objectContaining({ name: "b", value: "2" }),
    );
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refreshes into a single navigation", async () => {
    const browser = createFakeBrowser();
    const browserLauncher = vi.fn().mockResolvedValue(browser);
    const refresher = new PuppeteerXhsAuthRefresher({ browserLauncher });

    const [first, second] = await Promise.all([
      refresher.refresh({ cookie: "a=1", xS: "old" }),
      refresher.refresh({ cookie: "a=1", xS: "old" }),
    ]);

    expect(first).toEqual(second);
    expect(browserLauncher).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
  });

  it("reuses the browser across sequential refreshes", async () => {
    const browser = createFakeBrowser();
    const browserLauncher = vi.fn().mockResolvedValue(browser);
    const refresher = new PuppeteerXhsAuthRefresher({ browserLauncher });

    await refresher.refresh({ cookie: "a=1", xS: "old" });
    await refresher.refresh({ cookie: "a=1", xS: "old" });

    expect(browserLauncher).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
  });

  it("relaunches the browser after close", async () => {
    const browser = createFakeBrowser();
    const browserLauncher = vi.fn().mockResolvedValue(browser);
    const refresher = new PuppeteerXhsAuthRefresher({ browserLauncher });

    await refresher.refresh({ cookie: "a=1", xS: "old" });
    await refresher.close();
    expect(browser.close).toHaveBeenCalledTimes(1);

    await refresher.refresh({ cookie: "a=1", xS: "old" });
    expect(browserLauncher).toHaveBeenCalledTimes(2);
  });

  it("wraps a missing onebox capture in a descriptive error", async () => {
    const page = createFakePage();
    page.waitForRequest = vi.fn().mockRejectedValue(new Error("timeout"));
    const browser = createFakeBrowser(page);
    const refresher = new PuppeteerXhsAuthRefresher({
      browserLauncher: vi.fn().mockResolvedValue(browser),
    });

    await expect(
      refresher.refresh({ cookie: "a=1", xS: "old" }),
    ).rejects.toBeInstanceOf(XhsAuthRefreshError);
  });

  it("rejects when the current cookie is empty", async () => {
    const browser = createFakeBrowser();
    const refresher = new PuppeteerXhsAuthRefresher({
      browserLauncher: vi.fn().mockResolvedValue(browser),
    });

    await expect(
      refresher.refresh({ cookie: "   ", xS: "old" }),
    ).rejects.toBeInstanceOf(XhsAuthRefreshError);
  });
});
