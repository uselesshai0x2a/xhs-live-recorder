# XHS Live Recorder

一个运行在 Windows 上的小红书直播状态轮询与自动录制工具。

程序会定时检查配置的目标用户，在发现开播后使用项目附带的 FFmpeg
录制为 FLV 文件。发布包已经包含 Node.js 运行时和 FFmpeg，普通用户无需另行安装。

> 当前为第一版实验性工具，仅支持小红书。请仅录制你有权保存的内容，并妥善保管登录凭据。

## 功能

- 定时检查多个目标的开播状态
- 开播后自动开始录制，下播后自动停止
- 默认保持直播源的原始音视频码率
- 支持分片、自动合并和断流重试
- 同一直播房间跨程序重启复用任务目录
- 每轮检查都输出状态，避免程序看起来像是卡住
- 每次启动生成独立日志文件
- 项目自带 FFmpeg，不依赖系统环境

## 快速开始

### 1. 准备发布包

下载并解压 Windows x64 发布包。请保持以下文件和目录的相对位置不变：

```text
xhs-live-recorder/
├─ xhs-live-recorder.exe
├─ ffmpeg.exe
├─ start.cmd
└─ config/
   ├─ auth.json
   ├─ target.json
   └─ recording.json
```

`ffmpeg.exe` 必须与 `xhs-live-recorder.exe` 放在同一目录。

### 2. 获取目标用户的 key_word

1. 在 Chrome 或 Edge 中登录[小红书网页版](https://www.xiaohongshu.com/)。
2. 按 `F12` 打开开发者工具，进入 **Network（网络）** 面板。
3. 在小红书页面搜索需要录制的用户。
4. 在 Network 过滤框中输入：

   ```text
   /api/sns/web/v1/search/onebox
   ```

5. 选择名称为 `onebox` 的请求，打开 **Response（响应）**。
6. 在用户数据中找到 `red_id`。该值就是目标的 `key_word`，通常也是用户展示的小红书号。

### 3. 配置录制目标

用记事本或其他文本编辑器打开 `config/target.json`，在 `targets` 数组中添加目标：

```json
{
  "polling": {
    "interval_ms": 30000,
    "request_interval_ms": 5000
  },
  "targets": [
    {
      "id": "xhs:9412892896",
      "platform": "xhs",
      "name": "少年霜",
      "params": {
        "key_word": "9412892896"
      }
    }
  ]
}
```

- `id`：目标的唯一标识，推荐填写为 `xhs:<小红书号>`。
- `platform`：当前固定为 `xhs`。
- `name`：显示名称；请求成功后程序也可能使用接口返回的名称更新它。
- `params.key_word`：上一步获取的 `red_id`。
- `interval_ms`：完整轮询之间的间隔，示例为 30 秒。
- `request_interval_ms`：不同目标请求之间的间隔，建议保持 5 秒或更长。

增加更多用户时，继续向 `targets` 数组添加对象，并确保每个 `id` 都不重复。

### 4. 配置登录授权

仍在浏览器开发者工具中，选择刚才的 `onebox` 请求：

1. 打开 **Headers（标头）**。
2. 找到 **Request Headers（请求标头）**。
3. 复制其中的 `Cookie` 和 `X-S`。
4. 如果请求中存在 `X-S-Common`，也一并复制。
5. 打开 `config/auth.json`，填写对应字段：

```json
{
  "xhs": {
    "headers": {
      "x-s": "粘贴 X-S",
      "x-s-common": "粘贴 X-S-Common，没有时留空",
      "cookie": "粘贴 Cookie"
    }
  }
}
```

> `Cookie`、`X-S` 和 `X-S-Common` 属于敏感信息。不要截图分享，不要提交到 Git，发现泄露后应立即退出对应账号并重新登录。

这些值可能会过期。如果程序持续出现 HTTP 406、认证失败或签名失效，请重新执行本步骤。

### 5. 启动程序

双击 `start.cmd` 即可持续轮询。也可以在终端中运行：

```powershell
.\xhs-live-recorder.exe
```

修改任何 JSON 配置后，需要重启程序才能生效。JSON 文件不支持注释，并且最后一个字段后不能有多余逗号。

## 查看运行状态

控制台会显示每个目标每次检查的结果：

| 日志 | 含义 |
| --- | --- |
| `INITIAL LIVE/OFFLINE` | 启动后的首次明确状态 |
| `CHECKED LIVE/OFFLINE` | 本轮检查成功，状态没有变化 |
| `STARTED` | 检测到目标开始直播 |
| `STOPPED` | 检测到目标结束直播 |
| `RECOVERED` | 请求错误后重新获得明确状态 |
| `ERROR` | 网络、认证、签名或接口响应异常 |

所有控制台日志同时保存在：

```text
logs/recorder-年月日-时分秒-进程ID.log
```

## 录制文件

录制内容默认保存在 `recordings/`：

```text
recordings/
└─ 20260722_<key_word>_<room_id>/
   ├─ task.json
   └─ <主播名称>-20260722-160000.flv
```

相同 `key_word + room_id` 始终对应同一个录制任务目录。程序重启后如果仍是同一直播房间，会在该目录中生成新的 FLV 文件，不会覆盖历史录制。

## 录制配置

`config/recording.json` 的默认配置如下：

```json
{
  "enabled": true,
  "output_dir": "recordings",
  "segmentation": {
    "enabled": true,
    "duration_seconds": 1800,
    "auto_merge": true,
    "keep_segments": false
  },
  "video_bitrate": "source",
  "retry_delays_ms": [5000, 15000, 30000],
  "graceful_stop_timeout_ms": 10000
}
```

- `enabled`：是否启用自动录制。
- `duration_seconds`：单个分片的目标时长，默认 30 分钟。
- `auto_merge`：录制结束后是否自动合并本次运行产生的分片。
- `keep_segments`：合并成功后是否保留原始分片。
- `video_bitrate: "source"`：不转码，保持直播源原始码率。
- `retry_delays_ms`：断流后的重试等待时间。

## 命令行用法

只检查一轮：

```powershell
.\xhs-live-recorder.exe --once
```

只检查指定目标：

```powershell
.\xhs-live-recorder.exe --target "xhs:9412892896"
```

如果单轮检查或手动检查发现正在直播，程序会继续录制，直到直播流结束、录制失败或用户停止程序。

## 从源码构建 Windows 发布包

开发环境需要 Node.js 26 和 pnpm 11：

```powershell
pnpm install
pnpm check
pnpm test
pnpm package:win
```

生成结果位于：

```text
release/windows-x64/
```

打包脚本不会复制开发环境中的真实 `auth.json`，发布目录内使用的是占位认证信息。

## 常见问题

### 一直出现 HTTP 406

通常表示 Cookie 或签名已经失效。重新登录小红书网页版，再复制最新的 `Cookie`、`X-S` 和可选的 `X-S-Common`。

### 第二个目标要等待几秒才检查

这是正常行为。程序会按照 `request_interval_ms` 在目标请求之间主动等待，避免短时间内连续请求被服务器拒绝。

### 控制台没有出现新日志

检查 `interval_ms`。每个完整轮询周期结束后，程序才会等待该间隔进入下一轮；目标之间还会额外等待 `request_interval_ms`。

### 提示找不到 FFmpeg

确认发布包中的 `ffmpeg.exe` 与 `xhs-live-recorder.exe` 位于同一目录，且没有被安全软件隔离。

## 说明

本项目与小红书官方无关，不提供登录凭据或接口签名生成服务。接口行为可能随平台更新而变化。
