# XHS Live Recorder

Windows 小红书直播监听与录制应用，使用 Electron + Vue。通过内嵌的官方网页登录，后台查询和观看共用持久化浏览器会话，FFmpeg 独立静默录制。

## 使用

1. 当前使用开发入口 `pnpm dev`；在可完成打包的 Windows 环境中，也可安装生成的 NSIS 安装包。
2. 在“内嵌浏览器”中的小红书官方网页登录。
3. 在“设置”中确认录制目录。默认建议系统“视频”目录下的 `XHS Live Recorder`；确认前不会自动录制。
4. 输入小红书号，确认用户后添加监听；也可以打开主播主页，用工具栏添加。昵称可能重名，请核对账号。
5. 每个目标可分别开关监听、开播通知和自动录制，也可立即检查、观看、手动录制、停止及恢复。

未开播目标每 120 秒复查，直播中且正在录制时每 300 秒复查，各目标独立计时；请求间随机等待 5–15 秒，繁忙时顺延。直播中未录制或状态未知的复查间隔默认 120 秒，可在设置中调整。录制流自然结束或重试耗尽后，会提前确认一次直播状态；暂停或网站限制期间不额外请求。

“移除”会确认后从列表归档并收尾当前录制，历史录像、分片和记录保留。重新添加同一账号会恢复该目标的历史关联。账号验证黄字在实际查询成功后消失，目标自身查询错误需该目标查询成功后清除；磁盘、输出和手动停止提示保留各自的恢复条件。

监听暂停或查询失败时，界面显示“上次确认”的状态与确认时间。HTTP 461 会暂停自动查询并记住限制状态，重启也不会自动试查；稍后手动检查一个目标成功后才解除限制。历史动态不代表当前状态。

关闭窗口隐藏到托盘并暂时静音观看页，恢复后恢复原音量开关；最小化保留任务栏按钮。观看、切换页面与录制独立。托盘支持显示窗口、暂停监听、停止全部录制和退出。暂停监听不会终止已有录制。

录制记录可以查看分片和最终文件、打开输出文件夹、重试合并。首版没有应用内历史录像播放器。开机启动默认关闭，在安装版本设置中启用后随 Windows 登录进入托盘。

**当前交付为未签名的验收版本。** 最新代码、生产构建和桌面集成测试已通过；2026-09-15 重试 NSIS 打包成功，安装包位于 `release/desktop/XHS-Live-Recorder-0.2.0-Windows-x64.exe`。完整解包构建位于 `release/desktop/win-unpacked`。干净 Windows 环境安装、自启动和系统通知点击仍需验收。真实网站查询及两次录制的历史结果见 [验收记录](docs/browser-validation.md)。

## 开发与构建

需要 Windows x64、Node.js 26、pnpm 11。安装依赖前从托盘退出开发应用，避免正在加载的 SQLite 原生文件被锁定。

```powershell
pnpm install
pnpm dev
```

开发入口启动 `http://127.0.0.1:5173/` 本地 Vite 服务及 Electron，支持界面热更新，端口占用时直接报错。它不是本地 HTML 文件预览。普通浏览器只提供界面预览；数据库、录制和网页登录在 Electron 窗口操作。业务调用通过受限 IPC 连接主进程，不使用会复制登录凭据的 HTTP 代理。

```powershell
pnpm typecheck
pnpm check
pnpm test
pnpm build
node scripts/test-desktop.mjs
pnpm package:win
```

`pnpm test` 包含普通测试和在 Electron 运行时执行的 SQLite 原生测试。安装钩子按 Electron ABI 准备 `better-sqlite3`；不要用系统 Node 的 ABI 替换该模块。打包复用已安装的 Electron，并携带 FFmpeg，最终用户不需要安装 Node.js 或 FFmpeg。

`node scripts/test-desktop.mjs` 在构建后使用隔离数据目录验证真实界面、preload 和 IPC；网站响应为模拟数据，不发送网站请求，也不使用你的登录信息。

打包工具下载被网络阻断时，可在**当前构建终端**指定镜像：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm package:win
```

不需要修改系统代理或浏览器安全设置。`app-builder-lib` 的下载依赖在工作区锁定为 `@electron/get 4.0.3`，用于匹配其实际使用的缓存 API。

## 数据与磁盘

- 业务数据：`%APPDATA%\XHS Live Recorder\recorder.db`，SQLite WAL、外键及版本迁移。
- 登录状态：同一目录下的 Electron 持久化 Session；数据库只保存授权状态，不保存 Cookie 或签名。
- 输出目录可修改，新任务使用新目录，旧记录和正在运行的任务保留原路径。
- 每 10 秒检查实际输出盘；默认低于 10 GiB 提醒，低于 2 GiB 阻止新任务并停止受影响磁盘的录制。其他磁盘上的任务继续运行。
- 空间不足、拔盘或不可写时保留分片，用户处理后点击恢复录制。不会自动删除历史录像。合并必须预留分片总大小和停止阈值空间。
- 手动停止后同一房间不会自动重启；手动开始或新房间可以解除。连接重试耗尽后冷却至少 60 秒。
- 异常退出后旧运行标记为中断，保留和核对文件；不会冒充录制成功。

全新数据库不导入旧 JSON、不删除旧数据。`apps/recorder` 仅保留历史实现和回归测试，已停止作为发布入口，原 Node SEA 打包脚本已移除。

## 架构与限制

参见 [架构说明](docs/architecture.md)。网站验证码、登录过期或接口变化可能暂停查询；可打开后台查询页处理，登录会话变化后恢复，必要时点击立即检查验证。查询失败不直接停止正在正常拉流的录制。

首版只支持单账号；不批量导入关注列表。电脑休眠期间不承诺监听，恢复后重新检查。Windows 通知受系统通知设置影响，应用内仍保留通知记录。

FFmpeg 的许可证随安装包置于 `resources/FFmpeg-LICENSE.txt`。所用预构建来源为 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)，上游源码与构建信息参见该项目及 [FFmpeg](https://ffmpeg.org/download.html)。
