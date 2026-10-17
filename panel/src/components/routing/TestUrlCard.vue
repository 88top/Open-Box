<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('testUrlTitle') }}</h2>
        <p class="text-base-content/60 text-xs leading-relaxed">{{ $t('testUrlDescription') }}</p>
      </div>

      <div class="flex flex-col gap-3 sm:flex-row">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('testUrlLabel') }}</label>
          <input
            v-model="testUrl"
            type="url"
            class="input input-sm w-full font-mono text-xs"
            :placeholder="TEST_URL"
            @change="save('testUrl', testUrl)"
          />
          <p class="text-base-content/50 text-xs">{{ $t('testUrlHint') }}</p>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('directTestUrl') }}</label>
          <input
            v-model="directUrl"
            type="url"
            class="input input-sm w-full font-mono text-xs"
            :placeholder="DIRECT_TEST_URL"
            @change="save('directTestUrl', directUrl)"
          />
          <p class="text-base-content/50 text-xs">{{ $t('directTestUrlHint') }}</p>
        </div>
      </div>

      <div class="flex flex-col gap-3 sm:flex-row">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('testExpectedStatusLabel') }}</label>
          <input
            v-model="expectedStatus"
            type="text"
            class="input input-sm w-full font-mono text-xs"
            placeholder="*"
            @change="saveExpectedStatus"
          />
          <p class="text-base-content/50 text-xs">{{ $t('testExpectedStatusHint') }}</p>
        </div>
        <div class="min-w-0 flex-1" />
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { showNotification } from '@/helper/notification'
import type { OpenboxProfile } from '@/api/openbox'
import { DIRECT_TEST_URL, TEST_URL } from '@/constant'
import { kernelTestUrl } from '@/helper/testUrl'
import { directTestUrl, speedtestUrl } from '@/store/settings'
import { ref, watch } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

const testUrl = ref(props.profile.testUrl || '')
const directUrl = ref(props.profile.directTestUrl || '')
const expectedStatus = ref(props.profile.testExpectedStatus || '')
watch(
  () => props.profile,
  (p) => {
    testUrl.value = p.testUrl || ''
    directUrl.value = p.directTestUrl || ''
    expectedStatus.value = p.testExpectedStatus || ''
  },
)

// 空就回落到 HTTP 默认值；自定义地址保留原协议；存进档案的同时
// 更新面板那份,延迟测试立刻按新地址走,不用刷新
const save = async (key: 'testUrl' | 'directTestUrl', raw: string) => {
  const value = kernelTestUrl(raw) || (key === 'testUrl' ? TEST_URL : DIRECT_TEST_URL)
  try {
    await props.patchProfile({ [key]: value })
    if (key === 'testUrl') { speedtestUrl.value = value; testUrl.value = value }
    else { directTestUrl.value = value; directUrl.value = value }
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}

// 「可接受状态码」:200-399 或 204,多段用 / 连接;空 / * = 不限。写法不对返回 null(服务端校验同一套规则)
const normalizeExpectedStatus = (raw: string): string | null => {
  const text = raw.trim().replace(/\s+/g, '')
  if (!text || text === '*') return ''
  const parts = text.split('/')
  for (const part of parts) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(part)
    if (!m) return null
    const lo = Number(m[1])
    const hi = m[2] ? Number(m[2]) : lo
    if (lo < 100 || hi > 599 || lo > hi) return null
  }
  return parts.join('/')
}

const saveExpectedStatus = async () => {
  const value = normalizeExpectedStatus(expectedStatus.value)
  if (value === null) {
    showNotification({ content: 'expectedStatusInvalid', type: 'alert-error' })
    expectedStatus.value = props.profile.testExpectedStatus || ''
    return
  }
  expectedStatus.value = value
  if (value === (props.profile.testExpectedStatus || '')) return
  try {
    await props.patchProfile({ testExpectedStatus: value })
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}
</script>
