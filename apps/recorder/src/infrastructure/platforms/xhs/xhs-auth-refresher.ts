import { setTimeout as delay } from "node:timers/promises";

const XHS_ONEBOX_URL_FRAGMENT = "search/onebox";
const XHS_SEARCH_URL =
  "https://www.xiaohongshu.com/search_result?keyword=%s&source=web_search_result_notes";
const XHS_COOKIE_DOMAIN = ".xiaohongshu.com";
const XHS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEFAULT_LAUNCH_TIMEOUT_MS = 45_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;

export interface XhsAuthHeaders {
  readonly cookie: string;
  readonly xS: string;
  readonly xSCommon?: string;
}

export interface XhsAuthRefresher {
  refresh(current: XhsAuthHeaders): Promise<XhsAuthHeaders>;
  close(): Promise<void>;
}

export class XhsAuthRefreshError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "XhsAuthRefreshError";
  }
}

interface CookieParam {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

interface RequestLike {
  url(): string;
  headers(): Record<string, string>;
}

interface PageLike {
  setUserAgent(userAgent: string): Promise<void>;
  setCookie(...cookies: CookieParam[]): Promise<void>;
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForRequest(
    predicate: (request: RequestLike) => boolean,
    options?: { timeout?: number },
  ): Promise<RequestLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export type BrowserLauncher = () => Promise<BrowserLike>;

export interface PuppeteerXhsAuthRefresherOptions {
  /** Keyword typed into the search URL used to trigger the onebox request. */
  readonly probeKeyword?: string;
  /** Chrome/Edge executable path. Falls back to common install locations. */
  readonly executablePath?: string;
  /** Run the browser without a visible window. Default: false. */
  readonly headless?: boolean;
  readonly launchTimeoutMs?: number;
  readonly captureTimeoutMs?: number;
  /** Injectable launcher; defaults to puppeteer-core with a system browser. */
  readonly browserLauncher?: BrowserLauncher;
  readonly logger?: (message: string) => void;
}

export class PuppeteerXhsAuthRefresher implements XhsAuthRefresher {
  readonly #probeKeyword: string;
  readonly #launch: BrowserLauncher;
  readonly #captureTimeoutMs: number;
  readonly #logger: (message: string) => void;
  #browser: BrowserLike | null = null;
  #inFlight: Promise<XhsAuthHeaders> | null = null;

  constructor(options: PuppeteerXhsAuthRefresherOptions = {}) {
    this.#probeKeyword = options.probeKeyword ?? "小红书";
    this.#captureTimeoutMs =
      options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.#logger = options.logger ?? (() => {});
    this.#launch =
      options.browserLauncher ??
      createDefaultLauncher({
        ...(options.executablePath === undefined
          ? {}
          : { executablePath: options.executablePath }),
        headless: options.headless ?? false,
        launchTimeoutMs: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      });
  }

  refresh(current: XhsAuthHeaders): Promise<XhsAuthHeaders> {
    // Coalesce concurrent refreshes so a single browser navigation is shared.
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    const run = this.#refreshOnce(current).finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  async #refreshOnce(current: XhsAuthHeaders): Promise<XhsAuthHeaders> {
    const browser = await this.#ensureBrowser();
    let page: PageLike | undefined;
    try {
      page = await browser.newPage();
      await page.setUserAgent(XHS_USER_AGENT);
      const cookies = parseCookieHeader(current.cookie);
      if (cookies.length === 0) {
        throw new XhsAuthRefreshError(
          "Current cookie is empty; cannot seed the browser session",
        );
      }
      await page.setCookie(...cookies);

      const capture = page.waitForRequest(
        (request) => request.url().includes(XHS_ONEBOX_URL_FRAGMENT),
        { timeout: this.#captureTimeoutMs },
      );
      const targetUrl = XHS_SEARCH_URL.replace(
        "%s",
        encodeURIComponent(this.#probeKeyword),
      );
      this.#logger(`Refreshing XHS auth via ${targetUrl}`);
      // Navigation and capture race; the onebox request fires during load.
      await page
        .goto(targetUrl, { waitUntil: "domcontentloaded" })
        .catch((error: unknown) => {
          this.#logger(
            `XHS navigation warning: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

      const request = await capture.catch((error: unknown) => {
        throw new XhsAuthRefreshError(
          "Timed out waiting for the XHS onebox request; the session may be logged out",
          { cause: error },
        );
      });

      return extractHeaders(request.headers(), current);
    } finally {
      if (page !== undefined) {
        await page.close().catch(() => {});
      }
    }
  }

  async #ensureBrowser(): Promise<BrowserLike> {
    if (this.#browser !== null) {
      return this.#browser;
    }
    try {
      this.#browser = await this.#launch();
    } catch (error) {
      throw new XhsAuthRefreshError("Failed to launch the browser", {
        cause: error,
      });
    }
    return this.#browser;
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (browser !== null) {
      await browser.close().catch(() => {});
    }
  }
}

export function parseCookieHeader(cookieHeader: string): CookieParam[] {
  const cookies: CookieParam[] = [];
  for (const segment of cookieHeader.split(";")) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (name === "") {
      continue;
    }
    cookies.push({
      name,
      value,
      domain: XHS_COOKIE_DOMAIN,
      path: "/",
    });
  }
  return cookies;
}

export function extractHeaders(
  requestHeaders: Record<string, string>,
  fallback: XhsAuthHeaders,
): XhsAuthHeaders {
  const normalized = normalizeHeaderKeys(requestHeaders);
  const cookie = firstNonEmpty(normalized.cookie, fallback.cookie);
  const xS = firstNonEmpty(normalized["x-s"]);
  const xSCommon = firstNonEmpty(normalized["x-s-common"]);

  if (cookie === undefined) {
    throw new XhsAuthRefreshError(
      "Captured onebox request did not include a cookie header",
    );
  }
  if (xS === undefined) {
    throw new XhsAuthRefreshError(
      "Captured onebox request did not include an x-s signature header",
    );
  }
  return {
    cookie,
    xS,
    ...(xSCommon === undefined ? {} : { xSCommon }),
  };
}

function normalizeHeaderKeys(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

interface DefaultLauncherOptions {
  readonly executablePath?: string;
  readonly headless: boolean;
  readonly launchTimeoutMs: number;
}

const WINDOWS_BROWSER_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function createDefaultLauncher(
  options: DefaultLauncherOptions,
): BrowserLauncher {
  return async () => {
    const puppeteer = await importPuppeteer();
    const executablePath = await resolveExecutablePath(options.executablePath);
    // Small settle time avoids a race where the profile lock is still held.
    await delay(0);
    const browser = await puppeteer.launch({
      headless: options.headless,
      executablePath,
      timeout: options.launchTimeoutMs,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    return browser as unknown as BrowserLike;
  };
}

interface PuppeteerModule {
  launch(options: Record<string, unknown>): Promise<unknown>;
}

async function importPuppeteer(): Promise<PuppeteerModule> {
  try {
    const module = (await import("puppeteer-core")) as unknown as {
      default?: PuppeteerModule;
    } & Partial<PuppeteerModule>;
    const launcher = module.default ?? module;
    if (typeof launcher.launch !== "function") {
      throw new Error("puppeteer-core did not export a launch function");
    }
    return launcher as PuppeteerModule;
  } catch (error) {
    throw new XhsAuthRefreshError(
      "puppeteer-core is not available; install it to enable auth refresh",
      { cause: error },
    );
  }
}

async function resolveExecutablePath(
  configured: string | undefined,
): Promise<string> {
  if (configured !== undefined && configured.trim() !== "") {
    return configured.trim();
  }
  const fromEnv =
    process.env.XHS_BROWSER_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  const { access } = await import("node:fs/promises");
  for (const candidate of WINDOWS_BROWSER_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new XhsAuthRefreshError(
    "Could not locate a Chrome or Edge executable; set XHS_BROWSER_PATH",
  );
}
