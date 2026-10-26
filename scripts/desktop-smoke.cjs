// Run with workspace Electron after pnpm build. Isolated profile; website responses simulated.
const { app, BrowserWindow, net, clipboard } = require("electron");
const { EventEmitter } = require("node:events");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const deadline = setTimeout(() => {
  console.error("SMOKE_TIMEOUT");
  app.exit(1);
}, 90000);
app.setPath("userData", mkdtempSync(path.join(tmpdir(), "xhs-desktop-smoke-")));
process.env.XHS_START_PAUSED = "1";
delete process.env.ELECTRON_RENDERER_URL;
BrowserWindow.prototype.show = () => {};
let status = 200,
  requests = 0,
  navigations = 0;
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
app.on("ready", () => {
  net.request = (options) => {
    const request = Object.assign(new EventEmitter(), {
      setHeader() {},
      abort() {},
      end(body) {
        requests++;
        assert.equal(options.credentials, "include");
        assert.equal(JSON.parse(body).keyword, "smoke-account");
        setTimeout(() => {
          const response = Object.assign(new EventEmitter(), {
            statusCode: status,
            headers: {},
          });
          request.emit("response", response);
          response.emit(
            "data",
            Buffer.from(
              JSON.stringify(
                status === 200
                  ? payload
                  : { success: false, msg: "Access restricted" },
              ),
            ),
          );
          response.emit("end");
        }, 10);
      },
    });
    return request;
  };
});
app.on("web-contents-created", (_, contents) => {
  const load = contents.loadURL.bind(contents),
    execute = contents.executeJavaScript.bind(contents);
  contents.loadURL = async (url, ...args) => {
    if (!url.startsWith("https://")) return load(url, ...args);
    assert.ok(!url.includes("search_result"));
    navigations++;
    return load(
      'data:text/html,<body style="background:%2318202d;color:white;font:24px sans-serif">Official viewing surface (simulated)<button id="full" onclick="document.documentElement.requestFullscreen()">Video fullscreen</button></body>',
    );
  };
  contents.executeJavaScript = (code, ...args) => {
    if (code.startsWith("typeof window._webmsxyw"))
      return Promise.resolve(true);
    if (code.includes("const chunks = window.webpackChunkxhs_pc_web")) {
      const input = JSON.parse(
        code.match(/await api\((\{[^\n]+\}), \{ adapter/)[1],
      );
      return Promise.resolve({
        url: "https://edith.xiaohongshu.com/api/sns/web/v1/search/onebox",
        body: JSON.stringify({
          keyword: input.keyword,
          biz_type: input.bizType,
        }),
        headers: {
          "x-s": "smoke-signature",
          "x-t": "123",
          "x-s-common": "smoke-common",
        },
      });
    }
    return execute(code, ...args);
  };
});
require(path.join(root, "apps/desktop/out/main/index.js"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test) {
  const end = Date.now() + 20000;
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
      const win = BrowserWindow.getAllWindows()[0];
      return (
        win &&
        (await win.webContents
          .executeJavaScript(
            'Boolean(window.recorder && document.querySelector(".sidebar"))',
          )
          .catch(() => false))
      );
    });
    const win = BrowserWindow.getAllWindows()[0],
      contents = win.webContents;
    const js = (code) => contents.executeJavaScript(code);
    const state = async () => (await js("window.recorder.snapshot()")).value;
    const click = (text) =>
      js(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
      );
    const artifacts = path.join(root, "data/dev/query-session");
    mkdirSync(artifacts, { recursive: true });
    const capture = async (name) =>
      writeFileSync(
        path.join(artifacts, name + ".png"),
        (await win.capturePage()).toPNG(),
      );
    assert.equal(
      (await js("window.recorder.search('smoke-account')")).ok,
      true,
    );
    const target = (await js("window.recorder.add('smoke-user')")).value;
    status = 461;
    const failure = await js(`window.recorder.check('${target.id}')`);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.action, "verify");
    assert.equal((await state()).queryBlockKind, "RESTRICTED");
    await until(() => js("Boolean(document.querySelector('.query-issue'))"));
    await js(`window.recorder.copyDiagnostic('${failure.error.id}')`);
    assert.match(clipboard.readText(), /461/);
    assert.ok(
      !/smoke-account|smoke-signature|smoke-common/.test(clipboard.readText()),
    );
    win.showInactive();
    await wait(300);
    await capture("query-error");
    status = 200;
    await js(`window.recorder.check('${target.id}')`);
    await until(() =>
      js("!document.querySelector('.target-card .query-issue')"),
    );
    assert.equal((await state()).targets[0].error, null);
    const oldNavigations = navigations;
    await click("▣内嵌浏览器");
    await until(() =>
      js("Boolean(document.querySelector('.browser-toolbar'))"),
    );
    const bounds = win.getBounds(),
      maximized = win.isMaximized();
    await click("收起界面");
    await until(() => js("Boolean(document.querySelector('.focus-exit-bar'))"));
    await wait(200);
    const view = win.contentView.children.find(
      (v) => v.webContents && v.webContents !== contents,
    );
    assert.ok(view, "Native viewing surface must exist");
    assert.equal(view.getBounds().y, 34);
    assert.equal(view.getBounds().x, 0);
    assert.equal(view.getBounds().width, win.getContentSize()[0]);
    assert.deepEqual(win.getBounds(), bounds);
    assert.equal(win.isMaximized(), maximized);
    await capture("focus-mode");
    win.focus();
    view.webContents.focus();
    console.log("SMOKE: fullscreen and Escape");
    await view.webContents.executeJavaScript(
      "document.documentElement.requestFullscreen()",
      true,
    );
    await until(() =>
      view.webContents.executeJavaScript("!!document.fullscreenElement"),
    );
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(
      async () =>
        !(await view.webContents.executeJavaScript(
          "!!document.fullscreenElement",
        )),
    );
    assert.equal((await state()).browser.focusMode, true);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(async () => !(await state()).browser.focusMode);
    await click("收起界面");
    await wait(200);
    win.setSize(1120, 760);
    await wait(300);
    assert.equal(view.getBounds().width, win.getContentSize()[0]);
    assert.equal(view.getBounds().height, win.getContentSize()[1] - 34);
    win.minimize();
    await wait(150);
    assert.equal(
      (await js("window.recorder.search('smoke-account')")).ok,
      true,
    );
    win.restore();
    win.hide();
    await wait(150);
    assert.equal(
      (await js("window.recorder.search('smoke-account')")).ok,
      true,
    );
    win.showInactive();
    await wait(150);
    await click("恢复界面");
    await until(async () => !(await state()).browser.focusMode);
    assert.equal(
      navigations,
      oldNavigations,
      "No query or layout operation navigates either surface",
    );
    await click("◉监听列表");
    await click("移除");
    await until(() => js("Boolean(document.querySelector('[role=dialog]'))"));
    assert.match(
      await js("document.querySelector('[role=dialog]').textContent"),
      /历史录像、分片和记录保留/,
    );
    await js("document.querySelector('.remove-dialog .primary').click()");
    await until(async () => (await state()).targets.length === 0);
    assert.equal((await js("window.recorder.removeTarget({})")).ok, false);
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        preload: path.join(root, "apps/desktop/out/preload/index.js"),
      },
    });
    await foreign.loadURL("about:blank");
    await assert.rejects(
      foreign.webContents.executeJavaScript(
        "window.recorder.removeTarget('smoke')",
      ),
    );
    foreign.destroy();
    console.log(
      JSON.stringify({
        result: "DESKTOP_SMOKE_OK",
        requests,
        navigations,
        checks: [
          "structured IPC",
          "restriction recovery",
          "diagnostic copy",
          "focus native bounds",
          "video fullscreen Escape",
          "remote focus Escape",
          "resize",
          "minimize",
          "tray hide/restore",
          "no query navigation",
          "removal dialog",
          "untrusted renderer rejected",
        ],
        website: "simulated",
      }),
    );
    clearTimeout(deadline);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
