<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { AppSnapshot } from '../../shared/app'
import type { Candidate, RecordingFile, Settings, Target } from '@xhs-live-recorder/core'
const api = globalThis.window.recorder
const browser = globalThis.window.browser
type Page = 'targets' | 'browser' | 'recordings' | 'settings'
const page = ref<Page>('targets')
const snapshot = ref<AppSnapshot>()
const draft = ref<Settings>()
const keyword = ref('')
const candidates = ref<Candidate[]>([])
const error = ref('')
const busy = ref(false)
const removingTarget = ref<Target>()
const worker = ref(false)
const surface = ref<HTMLElement>()
const selectedRun = ref('')
const files = ref<RecordingFile[]>([])
let observer: ResizeObserver | undefined
const disposers: (() => void)[] = []
const pages: { id: Page; label: string; icon: string }[] = [
  { id: 'targets', label: '监听列表', icon: '◉' },
  { id: 'browser', label: '内嵌浏览器', icon: '▣' },
  { id: 'recordings', label: '录制记录', icon: '▤' },
  { id: 'settings', label: '设置', icon: '⚙' }
]
const titles = {
  targets: ['监听列表', '开播时通知，后台自动保存'],
  browser: ['内嵌浏览器', '观看官方网页，与后台录制独立运行'],
  recordings: ['录制记录', '按主播保存，每一次录制都有记录'],
  settings: ['设置', '存储位置、录制方式和后台行为']
}
const running = computed(
  () =>
    snapshot.value?.runs.filter((run) =>
      ['starting', 'recording', 'retry_wait', 'stopping', 'merging'].includes(run.state)
    ) ?? []
)
const live = computed(
  () => snapshot.value?.targets.filter((target) => target.state === 'live').length ?? 0
)
const stateNames: Record<string, string> = {
  starting: '准备中',
  recording: '录制中',
  retry_wait: '等待重连',
  stopping: '收尾中',
  merging: '合并中',
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
  interrupted: '上次运行中断'
}
const blockNames = { manual: '本场已手动停止', disk: '磁盘待处理', output: '输出配置待处理' }
function size(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GiB'
}
function at(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '尚未检查'
}
async function action(fn: () => Promise<unknown>): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    await fn()
    if (api) snapshot.value = await api.snapshot()
  } catch (e) {
    error.value =
      e instanceof Error
        ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : String(e)
  } finally {
    busy.value = false
  }
}
function targetState(target: Target): string {
  if (!target.lastConfirmedAt || target.state === 'unknown') return '待确认'
  const stale =
    snapshot.value?.paused ||
    snapshot.value?.authBlocked ||
    !target.enabled ||
    target.error ||
    (target.checkedAt && Date.parse(target.checkedAt) > Date.parse(target.lastConfirmedAt)) ||
    snapshot.value?.pendingConfirmations?.includes(target.id)
  return (stale ? '上次确认：' : '') + (target.state === 'live' ? '直播中' : '未开播')
}
async function removeTarget(): Promise<void> {
  const target = removingTarget.value
  if (!target) return
  await action(async () => {
    await api.removeTarget(target.id)
    removingTarget.value = undefined
  })
}
async function setPage(value: Page): Promise<void> {
  page.value = value
  if (value === 'settings' && snapshot.value) draft.value = { ...snapshot.value.settings }
  await api?.page(value)
  await nextTick()
  observer?.disconnect()
  if (surface.value) observer?.observe(surface.value)
  resize()
}
function resize(): void {
  const r = surface.value?.getBoundingClientRect()
  if (r && browser)
    void browser
      .setBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
      .catch(() => undefined)
}
async function search(): Promise<void> {
  await action(async () => {
    candidates.value = await api.search(keyword.value)
    await setPage('targets')
  })
}
async function fromProfile(): Promise<void> {
  await action(async () => {
    candidates.value = await api.profile()
    await setPage('targets')
    if (!candidates.value.length) throw new Error('搜索结果未匹配当前主页，请手动搜索主播')
  })
}
async function add(candidate: Candidate): Promise<void> {
  await action(async () => {
    await api.add(candidate.userId!)
    candidates.value = []
  })
}
async function toggle(
  target: Target,
  key: 'enabled' | 'notify' | 'autoRecord',
  event: Event
): Promise<void> {
  await action(() =>
    api.updateTarget(target.id, { [key]: (event.target as HTMLInputElement).checked })
  )
}
async function choose(): Promise<void> {
  await action(async () => {
    const directory = await api.chooseDirectory()
    if (directory && draft.value) draft.value.outputDir = directory
  })
}
async function toggleWorker(): Promise<void> {
  worker.value = !worker.value
  await action(() => browser.showQueryPage(worker.value))
}
async function showFiles(id: string): Promise<void> {
  selectedRun.value = id
  await action(async () => {
    files.value = await api.files(id)
  })
}
onMounted(async () => {
  if (!api) {
    error.value = '这是本地开发页面。请在同时启动的 Electron 窗口中管理监听、登录和录制。'
    return
  }
  disposers.push(
    api.subscribe((value) => {
      snapshot.value = value
    }),
    api.onWatch(() => {
      void setPage('browser')
    })
  )
  await action(async () => {
    snapshot.value = await api.snapshot()
  })
  observer = new ResizeObserver(resize)
  globalThis.window.addEventListener('resize', resize)
})
onUnmounted(() => {
  observer?.disconnect()
  disposers.forEach((dispose) => dispose())
  globalThis.window.removeEventListener('resize', resize)
})
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">●</div>
        <div><strong>XHS</strong><span>LIVE RECORDER</span></div>
      </div>
      <div class="nav-caption">工作空间</div>
      <nav>
        <button
          v-for="item in pages"
          :key="item.id"
          :class="{ active: page === item.id }"
          @click="setPage(item.id)"
        >
          <span>{{ item.icon }}</span
          >{{ item.label }}
        </button>
      </nav>
      <div class="sidebar-bottom">
        <span class="status-dot"></span> {{ snapshot?.paused ? '监听已暂停' : '后台服务运行中' }}
        <p>关闭窗口后驻留托盘</p>
      </div>
    </aside>
    <main>
      <header class="page-header">
        <div>
          <span class="eyebrow">XHS LIVE RECORDER</span>
          <h1>{{ titles[page][0] }}</h1>
          <p>{{ titles[page][1] }}</p>
        </div>
        <div class="header-actions">
          <span class="session-pill" :class="{ warning: snapshot?.authBlocked }">{{
            snapshot?.authBlocked
              ? snapshot.queryBlockKind === 'AUTH'
                ? '需要重新登录或验证'
                : '网站限制查询，请稍后手动检查'
              : snapshot?.browser.signedRequestObserved
                ? '浏览器查询已就绪'
                : snapshot?.browser.cookieAvailable
                  ? '登录已保留，等待查询'
                  : '在浏览器中登录'
          }}</span
          ><button
            v-if="page === 'targets'"
            :disabled="!api"
            @click="action(() => api.pause(!snapshot?.paused))"
          >
            {{ snapshot?.paused ? '恢复监听' : '暂停监听' }}
          </button>
        </div>
      </header>
      <div v-if="error" role="alert" class="alert error">
        {{ error }}<button @click="error = ''">×</button>
      </div>
      <div v-if="api && !api.removeTarget" class="alert setup">
        新功能将在重启应用后启用，当前录制不受影响。
      </div>
      <div
        v-if="snapshot && !snapshot.settings.outputConfigured && page !== 'settings'"
        class="alert setup"
      >
        首次使用请确认录制目录，确认前只监听、不自动录制。<button @click="setPage('settings')">
          设置目录 →
        </button>
      </div>

      <section v-if="page === 'targets'" class="content">
        <div class="stats">
          <article>
            <span>监听对象</span
            ><strong
              >{{ snapshot?.targets.filter((t) => t.enabled).length ?? 0
              }}<small>位主播</small></strong
            >
          </article>
          <article>
            <span>正在直播</span><strong>{{ live }}<small>场直播</small></strong>
          </article>
          <article>
            <span>运行任务</span><strong>{{ running.length }}<small>录制 / 合并</small></strong>
          </article>
          <article>
            <span>录制盘可用</span
            ><strong class="disk-value">{{
              snapshot?.settings.outputConfigured && snapshot?.disks[0]
                ? size(snapshot.disks[0].freeBytes)
                : '待设置'
            }}</strong>
          </article>
        </div>
        <div class="panel">
          <div class="panel-heading">
            <h2>我的监听</h2>
            <form class="search-form" @submit.prevent="search">
              <input v-model="keyword" placeholder="输入小红书号或用户名" maxlength="100" /><button
                class="primary"
                :disabled="busy || !api || !keyword.trim()"
              >
                查找主播
              </button>
            </form>
          </div>
          <div v-if="candidates.length" class="candidate-list">
            <p>确认要添加的用户</p>
            <article v-for="candidate in candidates" :key="candidate.userId ?? candidate.keyWord">
              <div class="avatar">{{ candidate.name.slice(0, 1) }}</div>
              <div>
                <b>{{ candidate.name }}</b>
                <p>小红书号 {{ candidate.keyWord }}</p>
              </div>
              <button :disabled="busy || !candidate.userId" @click="add(candidate)">
                添加监听
              </button>
            </article>
          </div>
          <div v-if="!snapshot?.targets.length" class="empty">
            <div class="empty-icon">◉</div>
            <h3>从第一位主播开始</h3>
            <p>搜索小红书号，或在浏览器打开主播主页后添加。<br />默认开启开播通知与静默录制。</p>
            <button @click="setPage('browser')">打开小红书浏览器</button>
          </div>
          <div v-else class="target-list">
            <article v-for="target in snapshot.targets" :key="target.id" class="target-card">
              <div class="avatar">{{ target.name.slice(0, 1) }}</div>
              <div class="target-info">
                <div class="target-title">
                  <b>{{ target.name }}</b
                  ><span class="badge" :class="{ live: target.state === 'live' }">{{
                    targetState(target)
                  }}</span
                  ><span
                    v-if="running.some((r) => r.targetId === target.id)"
                    class="badge recording"
                    >● 任务运行中</span
                  >
                </div>
                <p>小红书号 {{ target.keyWord }} · 上次检查 {{ at(target.checkedAt) }}</p>
                <p>最后明确确认：{{ at(target.lastConfirmedAt) }}</p>
                <p v-if="snapshot?.pendingConfirmations?.includes(target.id)" class="error-text">
                  录制流已结束，等待确认直播状态
                </p>
                <p v-if="target.error" class="error-text">{{ target.error }}</p>
                <p v-if="target.blockedReason" class="error-text">
                  {{ blockNames[target.blockedReason] }}
                  <button
                    class="text-button"
                    :disabled="busy"
                    @click="action(() => api.resume(target.id))"
                  >
                    恢复录制
                  </button>
                </p>
                <div class="switches">
                  <label
                    ><input
                      type="checkbox"
                      :checked="target.enabled"
                      @change="toggle(target, 'enabled', $event)"
                    />监听</label
                  ><label
                    ><input
                      type="checkbox"
                      :checked="target.notify"
                      @change="toggle(target, 'notify', $event)"
                    />开播通知</label
                  ><label
                    ><input
                      type="checkbox"
                      :checked="target.autoRecord"
                      @change="toggle(target, 'autoRecord', $event)"
                    />自动录制</label
                  >
                </div>
              </div>
              <div class="target-actions">
                <button :disabled="busy" @click="action(() => api.check(target.id))">检查</button
                ><button :disabled="busy" @click="action(() => api.watch(target.id))">观看</button
                ><button
                  v-if="running.some((r) => r.targetId === target.id)"
                  :disabled="busy"
                  @click="action(() => api.stop(target.id))"
                >
                  停止</button
                ><button
                  v-else
                  :disabled="busy || target.state !== 'live'"
                  @click="action(() => api.record(target.id))"
                >
                  录制
                </button>
                <button :disabled="busy || !api.removeTarget" @click="removingTarget = target">
                  移除
                </button>
              </div>
            </article>
          </div>
        </div>
        <section v-if="snapshot?.notices.length" class="panel notices">
          <div class="panel-heading"><h2>历史动态（不代表当前状态）</h2></div>
          <article v-for="notice in snapshot.notices.slice(0, 8)" :key="notice.id">
            <time>{{ at(notice.createdAt) }}</time>
            <div>
              <b>{{ notice.title }}</b>
              <p>{{ notice.message }}</p>
            </div>
          </article>
        </section>
      </section>

      <section v-if="page === 'browser'" class="browser-content">
        <div class="browser-toolbar">
          <button
            :disabled="!browser"
            @click="action(() => browser.open('https://www.xiaohongshu.com/explore'))"
          >
            首页 / 登录</button
          ><button :disabled="busy || !api" @click="fromProfile">＋ 添加当前主页主播</button
          ><button :disabled="!browser" @click="toggleWorker">
            {{ worker ? '返回观看页' : '查看后台查询页' }}</button
          ><span>{{ worker ? '后台查询页始终静音' : '观看与后台录制独立运行' }}</span>
        </div>
        <div class="browser-address">
          {{
            worker
              ? '后台查询页 · 可处理登录或验证码'
              : snapshot?.browser.foregroundUrl || '等待浏览器就绪'
          }}
        </div>
        <div ref="surface" class="browser-surface"></div>
      </section>

      <section v-if="page === 'recordings'" class="content">
        <div class="panel">
          <div class="panel-heading">
            <h2>全部录制</h2>
            <span>保留源视频质量 · FLV</span>
          </div>
          <div v-if="!snapshot?.runs.length" class="empty">
            <div class="empty-icon">▤</div>
            <h3>还没有录制记录</h3>
            <p>主播开播后，录制会自动出现在这里。</p>
          </div>
          <article v-for="run in snapshot?.runs" :key="run.id" class="run-card">
            <div class="run-main">
              <div>
                <b>{{ run.name }}</b
                ><span class="badge">{{ stateNames[run.state] }}</span
                ><span v-if="run.mergeState === 'pending'" class="badge warning">待合并</span>
                <p>{{ at(run.startedAt) }} · {{ run.directory }}</p>
                <p v-if="run.message" class="error-text">{{ run.message }}</p>
              </div>
              <div class="target-actions">
                <button @click="showFiles(run.id)">文件</button
                ><button @click="action(() => api.reveal(run.id))">打开文件夹</button
                ><button
                  v-if="run.mergeState === 'pending'"
                  :disabled="busy || running.some((r) => r.targetId === run.targetId)"
                  @click="action(() => api.merge(run.id))"
                >
                  合并分片
                </button>
              </div>
            </div>
            <div v-if="selectedRun === run.id" class="file-list">
              <div v-for="file in files" :key="file.path">
                <span>{{ file.path }}</span
                ><b>{{ file.exists ? size(file.bytes) : '文件暂不可用' }}</b>
              </div>
              <p v-if="!files.length">尚未发现已保存文件</p>
            </div>
          </article>
        </div>
      </section>

      <section v-if="page === 'settings'" class="content settings-content">
        <form v-if="draft" @submit.prevent="action(() => api.saveSettings({ ...draft! }))">
          <div class="panel settings-panel">
            <h2>录制存储</h2>
            <p>修改目录只影响新任务，已有录制保留在原位置。</p>
            <label class="field"
              >录制目录
              <div class="directory-field">
                <input v-model="draft.outputDir" /><button type="button" @click="choose">
                  选择目录
                </button>
              </div></label
            >
            <div class="field-grid">
              <label class="field"
                >空间告警（GiB）<input
                  v-model.number="draft.warningGiB"
                  type="number"
                  min="0.1"
                  step="0.1" /></label
              ><label class="field"
                >停止录制保留空间（GiB）<input
                  v-model.number="draft.stopGiB"
                  type="number"
                  min="0.1"
                  step="0.1"
              /></label>
            </div>
            <p>空间不足时安全停止并保留分片，不自动删除历史录像。处理后需点击恢复录制。</p>
            <article v-for="disk in snapshot?.disks" :key="disk.directory" class="disk-card">
              <b>{{ disk.directory }}</b>
              <p>
                {{ size(disk.freeBytes) }} 可用 / {{ size(disk.totalBytes) }} 总容量 ·
                {{
                  disk.level === 'ok'
                    ? '空间充足'
                    : disk.level === 'warning'
                      ? '空间告警'
                      : disk.level === 'stop'
                        ? '空间不足'
                        : '目录暂不可用'
                }}
              </p>
            </article>
          </div>
          <div class="panel settings-panel">
            <h2>录制与检查</h2>
            <div class="field-grid">
              <label class="field"
                >分片时长（秒）<input
                  v-model.number="draft.segmentSeconds"
                  type="number"
                  min="10" /></label
              ><label class="field"
                >视频码率<input v-model="draft.videoBitrate" placeholder="source 或 4000k" /></label
              ><label class="field"
                >直播中未录制或状态未知的复查间隔（毫秒）<input
                  v-model.number="draft.intervalMs"
                  type="number"
                  min="1000" /></label
              ><label class="field"
                >随机请求间隔下限（毫秒，上限为 3 倍）<input
                  v-model.number="draft.requestIntervalMs"
                  type="number"
                  min="5000"
              /></label>
            </div>
            <div class="switches">
              <label><input v-model="draft.autoMerge" type="checkbox" />结束后自动合并</label
              ><label><input v-model="draft.keepSegments" type="checkbox" />合并后保留分片</label>
            </div>
            <p>
              未开播目标每 120 秒复查；直播中且正在录制时每 300 秒复查。
              录制流自然结束或重试耗尽后提前确认一次。目标之间默认随机等待 5–15 秒，队列繁忙时顺延。
            </p>
          </div>
          <div class="panel settings-panel">
            <h2>后台运行</h2>
            <label class="checkbox-field"
              ><input v-model="draft.startAtLogin" type="checkbox" />随 Windows
              登录启动到托盘（安装版）</label
            >
            <p>最小化保留任务栏按钮；关闭主窗口后进入托盘并静音观看页。使用托盘菜单退出应用。</p>
          </div>
          <button class="primary save-button" :disabled="busy">保存设置</button>
        </form>
        <div v-else class="empty">请在 Electron 窗口中打开设置。</div>
      </section>
    </main>
    <div v-if="removingTarget" class="remove-overlay" role="presentation">
      <section class="remove-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title">
        <h2 id="remove-title">移除并停止录制</h2>
        <p>
          确定移除「{{ removingTarget.name }}」吗？当前任务会收尾停止，历史录像、分片和记录保留。
        </p>
        <button :disabled="busy" @click="removingTarget = undefined">取消</button>
        <button class="primary" :disabled="busy" @click="removeTarget">
          {{ busy ? '正在收尾…' : '移除并停止录制' }}
        </button>
      </section>
    </div>
  </div>
</template>
