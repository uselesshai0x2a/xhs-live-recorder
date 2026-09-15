import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  shell,
  Tray
} from 'electron'
import { join, isAbsolute, dirname } from 'node:path'
import { mkdir, writeFile, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { validateSettings } from '@xhs-live-recorder/core'
import { XhsBrowserService } from './browser/browser-service'
import { SqliteStore } from './store'
import { RecorderService } from './recorder-service'

let window: BrowserWindow | null = null
let browser: XhsBrowserService | null = null
let store: SqliteStore | null = null
let service: RecorderService | null = null
let tray: Tray | null = null
let quitting = false
let disposed = false
let disposing = false
let page = 'targets'
let publishTimer: ReturnType<typeof setTimeout> | undefined
const notifications = new Set<Notification>()

app.setName('XHS Live Recorder')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('启动失败', error instanceof Error ? error.message : '无法启动录制应用')
      app.quit()
    })
}
function showWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  browser?.setHidden(false)
  window.show()
  window.focus()
}
function publish(): void {
  if (publishTimer || disposing) return
  publishTimer = setTimeout(() => {
    publishTimer = undefined
    if (service && window && !window.isDestroyed())
      window.webContents.send('app:changed', service.snapshot())
    updateTray()
  }, 100)
}
function updateTray(): void {
  tray?.setToolTip(`XHS Live Recorder · ${service?.engine.activeRuns.length ?? 0} 个任务`)
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: showWindow },
      {
        label: service?.paused ? '恢复监听' : '暂停监听',
        click: () => service?.setPaused(!service.paused)
      },
      {
        label: '停止全部录制',
        click: () => {
          void service?.stopAll()
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
}
async function watch(id: string): Promise<void> {
  const target = store?.target(id)
  if (!target) throw new Error('找不到监听对象')
  const url =
    target.pageUrl ??
    (target.userId
      ? `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(target.userId)}`
      : null)
  if (!url) throw new Error('尚无官方网页地址，请重新查询主播')
  page = 'browser'
  showWindow()
  window!.webContents.send('app:watch')
  await browser!.open(url)
  browser!.setVisible(true)
  if (!/^\/(?:live|livestream)\//.test(new URL(url).pathname))
    store!.notice('已打开主播主页', '直播网页地址不可用时，可从主播主页进入官方直播间', id)
  publish()
}
function notify(title: string, body: string, id: string | null): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: true })
  notifications.add(notification)
  notification.on('click', () => {
    if (id) void watch(id).catch(() => showWindow())
    else showWindow()
  })
  notification.on('close', () => notifications.delete(notification))
  notification.on('failed', () => notifications.delete(notification))
  notification.show()
}
async function verifyDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error('录制目录必须为绝对路径')
  await mkdir(directory, { recursive: true })
  const probe = join(directory, `.xhs-write-test-${randomUUID()}`)
  await writeFile(probe, '', { flag: 'wx' })
  await rm(probe)
}
async function start(): Promise<void> {
  app.setAppUserModelId('com.xhs.live.recorder')
  await mkdir(app.getPath('userData'), { recursive: true })
  store = new SqliteStore(
    join(app.getPath('userData'), 'recorder.db'),
    join(app.getPath('videos'), 'XHS Live Recorder')
  )
  window = new BrowserWindow({
    title: 'XHS Live Recorder',
    width: 1380,
    height: 900,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const rendererUrl = new URL(
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  ).href
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault()
  })
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== rendererUrl
    )
      throw new Error('拒绝未知页面请求')
  }
  const handle = (name: string, action: (value: unknown) => unknown): void => {
    ipcMain.handle(name, (event, value: unknown) => {
      trusted(event)
      return action(value)
    })
  }
  const string = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000)
      throw new Error('无效参数')
    return value
  }
  browser = new XhsBrowserService(
    window,
    join(app.getPath('userData'), 'logs', 'browser.log'),
    (snapshot) => {
      if (window && !window.isDestroyed()) window.webContents.send('browser:changed', snapshot)
      publish()
    }
  )
  const require = createRequire(__filename)
  const binary = app.isPackaged
    ? join(process.resourcesPath, 'ffmpeg.exe')
    : join(dirname(require.resolve('ffmpeg-static/package.json')), 'ffmpeg.exe')
  await access(binary, constants.X_OK)
  service = new RecorderService(store, browser, binary, publish, notify)
  if (process.env.XHS_START_PAUSED === '1') service.setPaused(true)

  handle('app:snapshot', () => service!.snapshot())
  handle('app:search', (value) => service!.search(string(value)))
  handle('app:profile', () => service!.profile())
  handle('app:remove', (value) => service!.remove(string(value)))
  handle('app:add', (value) => service!.add(string(value)))
  handle('app:update', (value) => {
    if (!value || typeof value !== 'object') throw new Error('无效修改')
    const { id, patch } = value as { id: unknown; patch: unknown }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效修改')
    for (const [key, enabled] of Object.entries(patch))
      if (!['enabled', 'notify', 'autoRecord'].includes(key) || typeof enabled !== 'boolean')
        throw new Error('无效监听开关')
    service!.update(string(id), patch)
  })
  handle('app:check', (value) => service!.check(string(value)))
  handle('app:record', (value) => service!.record(string(value)))
  handle('app:stop', (value) => service!.stop(string(value)))
  handle('app:resume', (value) => service!.resume(string(value)))
  handle('app:pause', (value) => {
    if (typeof value !== 'boolean') throw new Error('无效开关')
    service!.setPaused(value)
  })
  handle('app:watch', (value) => watch(string(value)))
  handle('app:page', (value) => {
    if (!['targets', 'browser', 'recordings', 'settings'].includes(String(value)))
      throw new Error('未知页面')
    page = String(value)
    browser!.setVisible(page === 'browser')
  })
  handle('app:directory', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '选择录制目录',
      defaultPath: store!.settings().outputDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return null
    await verifyDirectory(result.filePaths[0])
    const disk = await service!.disk.probe(result.filePaths[0], store!.settings())
    if (disk.level === 'unavailable') throw new Error(disk.message!)
    return result.filePaths[0]
  })
  handle('app:settings', async (value) => {
    const settings = validateSettings(value)
    await verifyDirectory(settings.outputDir)
    settings.outputConfigured = true
    if (settings.startAtLogin && !app.isPackaged) throw new Error('开机启动请在安装后的应用中设置')
    if (app.isPackaged)
      app.setLoginItemSettings({
        openAtLogin: settings.startAtLogin,
        path: process.execPath,
        args: ['--background']
      })
    store!.saveSettings(settings)
    service!.settingsChanged()
  })
  handle('app:merge', (value) => service!.engine.merge(string(value)))
  handle('app:files', (value) => store!.files(string(value)))
  handle('app:reveal', (value) => {
    const run = store!.run(string(value))
    if (!run) throw new Error('找不到录制记录')
    return shell.openPath(run.directory)
  })
  handle('browser:snapshot', () => browser!.snapshot())
  handle('browser:open', async (value) => {
    await browser!.open(string(value))
    browser!.setVisible(page === 'browser')
  })
  handle('browser:search', (value) => service!.search(string(value)))
  handle('browser:worker', (value) => {
    if (typeof value !== 'boolean') throw new Error('无效页面选择')
    browser!.showQueryPage(value)
    browser!.setVisible(page === 'browser')
  })
  handle('browser:bounds', (value) => {
    if (!value || typeof value !== 'object') throw new Error('无效尺寸')
    const bounds = value as Record<string, unknown>
    if (
      !['x', 'y', 'width', 'height'].every(
        (key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])
      )
    )
      throw new Error('无效尺寸')
    browser!.setBounds(bounds as { x: number; y: number; width: number; height: number })
  })
  tray = new Tray(join(__dirname, '../../resources/icon.png'))
  updateTray()
  tray.on('double-click', showWindow)
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    browser?.setHidden(true)
    window?.hide()
  })
  window.on('show', () => browser?.setHidden(false))
  window.on('closed', () => {
    window = null
  })
  powerMonitor.on('resume', () => {
    if (!service?.paused)
      for (const target of store!.targets().filter((t) => t.enabled))
        void service!.check(target.id).catch(() => undefined)
  })
  await window.loadURL(rendererUrl)
  console.log(`[desktop] Renderer loaded: ${window.webContents.getURL()}`)
  if (!process.argv.includes('--background')) window.show()
  else browser.setHidden(true)
  try {
    await browser.initialize()
  } catch {
    store.notice('小红书页面暂时无法打开', '请检查网络后在浏览器页面重新打开首页')
  }
  browser.setVisible(page === 'browser')
  service.start()
  publish()
}
app.on('before-quit', (event) => {
  quitting = true
  if (disposed) return
  event.preventDefault()
  if (disposing) return
  disposing = true
  if (publishTimer) clearTimeout(publishTimer)
  void (async () => {
    if (service) await service.close()
    else await browser?.dispose()
    store?.close()
    for (const notice of notifications) notice.close()
    tray?.destroy()
  })()
    .catch(() => {
      console.error(
        '[desktop] Shutdown cleanup failed; unfinished runs will be recovered on restart'
      )
    })
    .finally(() => {
      disposed = true
      app.quit()
    })
})
