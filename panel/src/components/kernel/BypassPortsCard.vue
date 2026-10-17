<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">{{ $t('bypassPortsTitle') }}</h2>
          <p class="text-base-content/60 text-xs">{{ $t('bypassPortsDescription') }}</p>
        </div>
        <div
          role="tablist"
          class="tabs-box tabs tabs-xs shrink-0 rounded-full"
        >
          <a
            v-for="m in MODES"
            :key="m.value"
            role="tab"
            class="tab rounded-full"
            :class="mode === m.value && 'tab-active'"
            @click="switchMode(m.value)"
          >
            {{ $t(m.label) }}
          </a>
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-1">
        <input
          v-model="current"
          type="text"
          class="input input-sm w-full font-mono text-xs"
          :placeholder="$t('bypassPortsPlaceholder')"
          @change="savePorts"
        />
        <p class="text-base-content/50 text-xs">
          {{ mode === 'whitelist' ? $t('bypassPortsWhitelistHint') : $t('bypassPortsBlacklistHint') }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxProfile } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { computed, ref, watch } from 'vue'

type Mode = 'blacklist' | 'whitelist'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

const MODES: { value: Mode; label: string }[] = [
  { value: 'blacklist', label: 'bypassPortsModeBlacklist' },
  { value: 'whitelist', label: 'bypassPortsModeWhitelist' },
]
const FIELD: Record<Mode, 'bypassPorts' | 'bypassPortsWhitelist'> = {
  blacklist: 'bypassPorts',
  whitelist: 'bypassPortsWhitelist',
}
// 「21114-21119, 2233」:单个端口或范围,逗号隔开(服务端 parsePortSpec 是最终裁判)
const PORT_SPEC = /^\d{1,5}(-\d{1,5})?(\s*,\s*\d{1,5}(-\d{1,5})?)*$/

const modeOf = (p: OpenboxProfile): Mode => (p.bypassPortsMode === 'whitelist' ? 'whitelist' : 'blacklist')
const valuesOf = (p: OpenboxProfile): Record<Mode, string> => ({
  blacklist: p.bypassPorts || '',
  whitelist: p.bypassPortsWhitelist || '',
})

const mode = ref<Mode>(modeOf(props.profile))
const values = ref(valuesOf(props.profile))
watch(
  () => props.profile,
  (p) => {
    mode.value = modeOf(p)
    values.value = valuesOf(p)
  },
)

// 黑名单、白名单各存一份,输入框显示选中的那份
const current = computed({
  get: () => values.value[mode.value],
  set: (v: string) => {
    values.value = { ...values.value, [mode.value]: v }
  },
})

const switchMode = async (next: Mode) => {
  if (mode.value === next) return
  const prev = mode.value
  mode.value = next
  try {
    await props.patchProfile({ bypassPortsMode: next })
    showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
  } catch (err) {
    mode.value = prev
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}

const savePorts = async () => {
  const text = current.value.trim()
  if (text && !PORT_SPEC.test(text)) {
    showNotification({ content: 'bypassPortsInvalid', type: 'alert-error' })
    return
  }
  try {
    await props.patchProfile({ [FIELD[mode.value]]: text })
    showNotification({ content: 'routingPolicySaved', type: 'alert-success' })
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  }
}
</script>
