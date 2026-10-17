<template>
  <!-- 导出诊断包:反馈问题时一键把版本、固件、内核状态、脱敏配置和最近日志打成一个文件
       (server/api/diagnostics.mjs)。GitHub 上来回追问三四轮都拿不齐这些。 -->
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('diagnosticsTitle') }}</h2>
        <!-- 说明里的「GitHub issue」做成指向仓库 issue 页的链接(主题色混 30% 正文色、半粗体,与 v0.1.337 一致)(按文案里出现的位置切开,各语言通用) -->
        <p class="text-base-content/60 text-xs">
          {{ descParts[0] }}<a
            v-if="descParts[1]"
            href="https://github.com/timeflysoon/Open-Box/issues"
            target="_blank"
            rel="noopener noreferrer"
            class="link link-hover font-semibold"
            style="color: color-mix(in srgb, var(--color-primary) 70%, var(--color-base-content) 30%)"
          >{{ descParts[1] }}</a>{{ descParts[2] }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="exporting"
          @click="doExport"
        >
          <span
            v-if="exporting"
            class="loading loading-spinner loading-xs"
          />
          <ArrowDownTrayIcon
            v-else
            class="h-4 w-4"
          />
          {{ $t('diagnosticsExport') }}
        </button>
        <span class="text-base-content/50 text-xs">{{ $t('diagnosticsHint') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchDiagnostics } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { ArrowDownTrayIcon } from '@heroicons/vue/24/outline'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const LINK_TEXT = 'GitHub issue'
const descParts = computed(() => {
  const text = t('diagnosticsDescription')
  const i = text.indexOf(LINK_TEXT)
  return i < 0 ? [text, '', ''] : [text.slice(0, i), LINK_TEXT, text.slice(i + LINK_TEXT.length)]
})

const exporting = ref(false)
const pad2 = (n: number) => String(n).padStart(2, '0')

// 和备份卡片同一套下载方式:拉 JSON,浏览器存成文件 open-box-diagnostics-20260908-1030.json
const doExport = async () => {
  if (exporting.value) return
  exporting.value = true
  try {
    const data = await fetchDiagnostics()
    const d = new Date()
    const name = `open-box-diagnostics-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.json`
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showNotification({ content: 'diagnosticsExported', params: { file: name }, type: 'alert-success' })
  } catch (err) {
    showNotification({
      content: 'diagnosticsExportFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  } finally {
    exporting.value = false
  }
}
</script>
