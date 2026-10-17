<template>
  <!-- DNS 劫持方式 + FakeIP。改动写进档案,保存后直接生效(接管 / 还原 dnsmasq 由后台自动处理)。 -->
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4 text-sm">
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold">{{ $t('dnsModeTitle') }}（{{ $t('dnsModePort', { port: KERNEL_DNS_PORT }) }}）</h2>
          <p class="text-base-content/60 text-xs">{{ $t('dnsModeDescription') }}</p>
        </div>
        <select
          class="select select-sm w-40 shrink-0"
          :value="mode"
          :disabled="saving"
          @change="onChange"
        >
          <option
            v-if="dnsmasqAvailable"
            value="dnsmasq"
          >
            {{ $t('dnsModeDnsmasq') }}
          </option>
          <option value="hijack">{{ $t('dnsModeHijack') }}</option>
          <option value="off">{{ $t('dnsModeOff') }}</option>
        </select>
      </div>
      <p class="text-base-content/50 text-xs">{{ $t(NOTE_KEY[mode]) }}</p>
      <!-- 内核 DNS 入站三种模式都开:局域网里的 AdGuard Home / Pi-hole 把上游指到这里就能用分流解析 -->
      <p class="text-base-content/50 text-xs">{{ $t('dnsModeUpstreamHint', { addr: kernelDnsAddr }) }}</p>
      <!-- FakeIP:走代理的域名不在本地解析,内核发占位地址,连接时把域名交给选中的节点 -->
      <div
        v-if="mode !== 'off'"
        class="border-base-300/60 flex items-start gap-3 border-t pt-3"
      >
        <input
          type="checkbox"
          class="toggle toggle-sm mt-0.5 cursor-pointer"
          :aria-label="$t('dnsFakeIpTitle')"
          :checked="fakeIp"
          :disabled="saving"
          @change="onFakeIp"
        >
        <span class="flex flex-col gap-1">
          <span>{{ $t('dnsFakeIpTitle') }}</span>
          <span class="text-base-content/50 text-xs">{{ $t('dnsFakeIpNote') }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchServiceStatus, type OpenboxDnsMode, type OpenboxProfile } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

const NOTE_KEY: Record<OpenboxDnsMode, string> = {
  dnsmasq: 'dnsModeDnsmasqNote',
  hijack: 'dnsModeHijackNote',
  off: 'dnsModeOffNote',
}
const saving = ref(false)
// 跑在 systemd 系统上时没有 dnsmasq 可转发:隐藏这一项,档案里写着 dnsmasq 的按防火墙劫持显示
const platform = ref('openwrt')
onMounted(async () => {
  try {
    platform.value = (await fetchServiceStatus()).platform ?? 'openwrt'
  } catch {
    // 拿不到就按 openwrt 处理
  }
})
const dnsmasqAvailable = computed(() => platform.value !== 'systemd')
const mode = computed<OpenboxDnsMode>(() => {
  const current = props.profile.dns?.mode ?? 'dnsmasq'
  return !dnsmasqAvailable.value && current === 'dnsmasq' ? 'hijack' : current
})
const fakeIp = computed(() => props.profile.dns?.fakeIpForProxy === true)
// 面板就在路由器上,当前打开面板的主机名就是路由器地址
const KERNEL_DNS_PORT = 7853
const kernelDnsAddr = `${location.hostname}:${KERNEL_DNS_PORT}`

const save = async (patch: Record<string, unknown>) => {
  saving.value = true
  try {
    await props.patchProfile({ dns: patch })
    showNotification({ content: 'dnsModeSaved', type: 'alert-success' })
  } catch (err) {
    showNotification({ content: 'routingSaveFailed', params: { message: err instanceof Error ? err.message : String(err) }, type: 'alert-error' })
  } finally {
    saving.value = false
  }
}

const onFakeIp = (event: Event) => save({ fakeIpForProxy: (event.target as HTMLInputElement).checked })

const onChange = (event: Event) => {
  const next = (event.target as HTMLSelectElement).value as OpenboxDnsMode
  if (next === mode.value) return
  return save({ mode: next })
}
</script>
