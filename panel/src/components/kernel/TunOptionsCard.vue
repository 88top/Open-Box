<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('tunTitle') }}</h2>
        <p class="text-base-content/60 text-xs">{{ $t('tunDescription') }}</p>
      </div>

      <div>
        <button
          type="button"
          class="btn btn-sm"
          :aria-expanded="advancedOpen"
          @click="advancedOpen = !advancedOpen"
        >
          <AdjustmentsHorizontalIcon class="h-4 w-4" />
          {{ $t('tunAdvancedButton') }}
        </button>
      </div>

      <!-- 点「高级设置」弹出窗口:这几项一般不用改 -->
      <DialogWrapper
        v-model="advancedOpen"
        :title="$t('tunAdvancedButton')"
        box-class="w-full max-w-2xl"
      >
        <!-- 结构与 v0.1.337 一致:行间距 gap-3,每行「标签 + 控件」gap-2 可换行,说明独占一行 -->
        <div class="flex flex-col gap-3 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <label class="w-28 shrink-0 text-sm">{{ $t('tunStackLabel') }}</label>
            <select
              class="select select-sm w-36"
              :value="stack"
              @change="onStack"
            >
              <option value="mixed">mixed</option>
              <option value="gvisor">gvisor</option>
              <option value="system">system</option>
            </select>
            <p class="text-base-content/60 basis-full text-xs">{{ $t('tunStackNote') }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="w-28 shrink-0 text-sm">{{ $t('tunMtuLabel') }}</label>
            <input
              v-model="mtuText"
              type="number"
              min="0"
              :max="MTU_MAX"
              class="input input-sm w-28"
              placeholder="0"
              @change="saveNumber('mtu')"
            />
            <p class="text-base-content/60 basis-full text-xs">{{ $t('tunMtuNote') }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="w-28 shrink-0 text-sm">{{ $t('tunMssLabel') }}</label>
            <input
              v-model="mssText"
              type="number"
              min="0"
              :max="MSS_MAX"
              class="input input-sm w-28"
              placeholder="0"
              @change="saveNumber('tcpMss')"
            />
            <p class="text-base-content/60 basis-full text-xs">{{ $t('tunMssNote') }}</p>
          </div>
        </div>
      </DialogWrapper>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxProfile } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { showNotification } from '@/helper/notification'
import { AdjustmentsHorizontalIcon } from '@heroicons/vue/24/outline'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

// 范围与后端 engine/tun-options.mjs 一致;0 = 内核默认 / 不钳制。服务端的校验才是最终依据
const MTU_MIN = 1280
const MTU_MAX = 65535
const MSS_MIN = 536
const MSS_MAX = 65495

// 底层参数默认折起来
const advancedOpen = ref(false)

const tun = computed(() => props.profile.tun ?? {})
const stack = computed(() => (tun.value.stack === 'gvisor' || tun.value.stack === 'system' ? tun.value.stack : 'mixed'))

const mtuText = ref(String(tun.value.mtu ?? 0))
const mssText = ref(String(tun.value.tcpMss ?? 0))
watch(tun, (value) => {
  mtuText.value = String(value.mtu ?? 0)
  mssText.value = String(value.tcpMss ?? 0)
})

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// 后端把 tun 按字段合并,只发改动的那一项即可
const save = async (patch: Record<string, unknown>) => {
  try {
    await props.patchProfile({ tun: patch })
    showNotification({ content: 'tunSaved', type: 'alert-success' })
  } catch (error) {
    showNotification({ content: 'routingSaveFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  }
}

const onStack = (event: Event) => save({ stack: (event.target as HTMLSelectElement).value })

const saveNumber = async (key: 'mtu' | 'tcpMss') => {
  const raw = (key === 'mtu' ? mtuText.value : mssText.value).trim()
  const value = raw === '' ? 0 : Number(raw)
  const [min, max] = key === 'mtu' ? [MTU_MIN, MTU_MAX] : [MSS_MIN, MSS_MAX]
  if (!(value === 0 || (Number.isInteger(value) && value >= min && value <= max))) {
    showNotification({ content: key === 'mtu' ? 'tunMtuInvalid' : 'tunTcpMssInvalid', params: { min: String(min), max: String(max) }, type: 'alert-error' })
    mtuText.value = String(tun.value.mtu ?? 0)
    mssText.value = String(tun.value.tcpMss ?? 0)
    return
  }
  await save({ [key]: value })
}
</script>
