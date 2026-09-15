// Run with the workspace Electron after `pnpm build`. Uses an isolated database and no website requests.
const { app, BrowserWindow, webContents } = require("electron");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const profile = mkdtempSync(path.join(tmpdir(), "xhs-desktop-smoke-"));
app.setPath("userData", profile);
process.env.XHS_START_PAUSED = "1";
delete process.env.ELECTRON_RENDERER_URL;
BrowserWindow.prototype.show = () => {};
let status = 200;
let sequence = 0;
const payload = {
  success: true,
  data: {
    onebox_list: [
      {
        user_one_box: {
          id: "smoke-user",
          red_id: "smoke-account",
          title: "界面验收主播",
          live_info: { status: 0 },
        },
      },
    ],
  },
};
app.on("web-contents-created", (_, contents) => {
  const originalLoad = contents.loadURL.bind(contents);
  const originalCommand = contents.debugger.sendCommand.bind(contents.debugger);
  contents.debugger.sendCommand = (method, args) =>
    method === "Network.getResponseBody"
      ? Promise.resolve({ body: JSON.stringify(payload) })
      : originalCommand(method, args);
  contents.loadURL = async (url, ...args) => {
    if (!url.startsWith("https://")) return originalLoad(url, ...args);
    if (!url.includes("/search_result/")) return;
    const keyword = new URL(url).searchParams.get("keyword");
    const requestId = `smoke-${++sequence}`;
    setTimeout(() => {
      contents.debugger.emit("message", {}, "Network.requestWillBeSent", {
        requestId,
        request: {
          url: "https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox",
          postData: JSON.stringify({ keyword }),
        },
      });
      contents.debugger.emit("message", {}, "Network.responseReceived", {
        requestId,
        response: { status },
      });
      contents.debugger.emit("message", {}, "Network.loadingFinished", {
        requestId,
      });
    }, 10);
  };
});
require(path.join(root, "apps/desktop/out/main/index.js"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await test()) return;
    await wait(50);
  }
  throw new Error("Desktop smoke check timed out");
}
app
  .whenReady()
  .then(async () => {
    await until(async () => {
      const window = BrowserWindow.getAllWindows()[0];
      return (
        window &&
        (await window.webContents
          .executeJavaScript("Boolean(window.recorder)")
          .catch(() => false))
      );
    });
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const js = (code) => contents.executeJavaScript(code);
    const state = () => js("window.recorder.snapshot()");
    await js("window.recorder.search('smoke-account')");
    const target = await js("window.recorder.add('smoke-user')");
    status = 461;
    await js(`window.recorder.check('${target.id}')`).then(
      () => assert.fail("Expected restriction"),
      () => {},
    );
    assert.equal((await state()).queryBlockKind, "RESTRICTED");
    await until(() => js("Boolean(document.querySelector('.error-text'))"));
    status = 200;
    await js(`window.recorder.check('${target.id}')`);
    await until(() =>
      js("!document.querySelector('.target-card .error-text')"),
    );
    assert.equal((await state()).targets[0].error, null);
    assert.equal((await state()).queryBlockKind, null);
    await js(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='移除').click()",
    );
    await until(() => js("Boolean(document.querySelector('[role=dialog]'))"));
    BrowserWindow.fromWebContents(contents).showInactive();
    await wait(500);
    const artifacts = path.join(root, "data/dev");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      path.join(artifacts, "remove-dialog.png"),
      (await contents.capturePage()).toPNG(),
    );
    BrowserWindow.fromWebContents(contents).hide();
    assert.match(
      await js("document.querySelector('[role=dialog]').textContent"),
      /历史录像、分片和记录保留/,
    );
    await js("document.querySelector('.remove-dialog .primary').click()");
    await until(async () => (await state()).targets.length === 0);
    await until(() => js("!document.querySelector('[role=dialog]')"));
    await js("window.recorder.removeTarget({})").then(
      () => assert.fail("Expected invalid argument rejection"),
      () => {},
    );
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        preload: path.join(root, "apps/desktop/out/preload/index.js"),
      },
    });
    await foreign.loadURL("about:blank");
    await foreign.webContents
      .executeJavaScript("window.recorder.removeTarget('smoke')")
      .then(
        () => assert.fail("Expected foreign renderer rejection"),
        () => {},
      );
    foreign.destroy();
    assert.equal(
      webContents
        .getAllWebContents()
        .filter((c) => c.getURL().startsWith("https://")).length,
      0,
    );
    console.log(
      "DESKTOP_SMOKE_OK: real renderer/preload/IPC, restriction recovery, removal dialog and source validation; website responses simulated",
    );
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
