<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { QueryIssue, QueryRecoveryAction } from '@xhs-live-recorder/core'
const props = defineProps<{ issue: QueryIssue; busy?: boolean }>()
defineEmits<{ recover: [action: QueryRecoveryAction]; copy: [id: string] }>()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => clearInterval(timer))
const remaining = computed(
  () => Math.max(0, Math.ceil((Date.parse(props.issue.retryAt ?? '') - now.value) / 1000)) || 0
)
const actionLabel = computed(
  () =>
    ({
      login: '前往登录',
      verify: '前往验证',
      retry: '重试',
      repair: '修复并重试',
      wait: '重试',
      details: '查看详情'
    })[props.issue.action]
)
</script>
<template>
  <div class="query-issue" role="alert">
    <strong>{{ issue.title }}</strong>
    <p>{{ issue.message }}</p>
    <p>{{ issue.help }}</p>
    <p v-if="remaining">{{ remaining }} 秒后可重试</p>
    <div class="issue-actions">
      <button
        v-if="issue.action !== 'details'"
        :disabled="busy || remaining > 0"
        @click="$emit('recover', issue.action === 'wait' ? 'retry' : issue.action)"
      >
        {{ actionLabel }}
      </button>
      <button v-if="issue.action === 'verify'" :disabled="busy" @click="$emit('recover', 'retry')">
        验证后重试
      </button>
      <button :disabled="busy" @click="$emit('copy', issue.id)">复制诊断信息</button>
    </div>
    <details>
      <summary>诊断详情</summary>
      <dl>
        <dt>发生时间</dt>
        <dd>{{ new Date(issue.occurredAt).toLocaleString() }}</dd>
        <dt>诊断编号</dt>
        <dd>{{ issue.id }}</dd>
        <template v-if="issue.httpStatus !== undefined"
          ><dt>HTTP 状态</dt>
          <dd>{{ issue.httpStatus }}</dd></template
        >
        <template v-if="issue.businessCode !== undefined"
          ><dt>业务码</dt>
          <dd>{{ issue.businessCode }}</dd></template
        >
        <template v-if="issue.diagnostic"
          ><dt>网站消息</dt>
          <dd>{{ issue.diagnostic }}</dd></template
        >
      </dl>
    </details>
  </div>
</template>
