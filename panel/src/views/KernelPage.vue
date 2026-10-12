<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      :style="padding"
    >
      <div class="flex flex-col gap-2 px-2 md:py-2">
        <!-- 顶部总卡片:标识、平台、版本、状态、启停、更新都在这一张里 -->
        <KernelServiceCard
          :status="status"
          :kernel-version="kernelVersion"
          :profile="profile"
          :patch-profile="patchProfile"
          @refresh="loadStatus"
        />

        <!-- 内核参数:DNS 劫持、直连、IPv6、测速地址。改动写进档案,重启内核后生效。
             相邻的设置合成三张大卡片,卡片之间用分隔线隔开。 -->
        <template v-if="profile">
          <div class="card bg-base-100 border-base-300/60 border">
            <div class="kernel-group">
              <NodeDirectCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <DirectBypassCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <BlockQuicCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <BypassPortsCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <Ipv6Card
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <TunOptionsCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
            </div>
          </div>

          <div class="card bg-base-100 border-base-300/60 border">
            <div class="kernel-group">
              <TestUrlCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <TrafficRetentionCard
                :profile="profile"
                :patch-profile="patchProfile"
              />
              <!-- 路由器系统时区:定时任务按路由器本地时间跑 -->
              <TimezoneCard />
            </div>
          </div>

          <div class="card bg-base-100 border-base-300/60 border">
            <div class="kernel-group">
              <!-- 导出 / 导入:导入后档案换了,重新拉一遍状态和档案 -->
              <BackupCard
                :profile="profile"
                @imported="onImported"
              />
              <!-- 导出诊断包:反馈问题用,和备份放一起 -->
              <DiagnosticsCard />
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { refreshServiceStatus } from '@/composables/kernelService'
import type { OpenboxKernelVersion, OpenboxProfile, OpenboxServiceStatus } from '@/api/openbox'
import { fetchKernelVersion, fetchProfile, saveProfile } from '@/api/openbox'
import KernelServiceCard from '@/components/kernel/KernelServiceCard.vue'
import NodeDirectCard from '@/components/kernel/NodeDirectCard.vue'
import DirectBypassCard from '@/components/kernel/DirectBypassCard.vue'
import BlockQuicCard from '@/components/kernel/BlockQuicCard.vue'
import BypassPortsCard from '@/components/kernel/BypassPortsCard.vue'
import BackupCard from '@/components/kernel/BackupCard.vue'
import TrafficRetentionCard from '@/components/kernel/TrafficRetentionCard.vue'
import TimezoneCard from '@/components/kernel/TimezoneCard.vue'
import DiagnosticsCard from '@/components/kernel/DiagnosticsCard.vue'
import TunOptionsCard from '@/components/kernel/TunOptionsCard.vue'
import Ipv6Card from '@/components/routing/Ipv6Card.vue'
import TestUrlCard from '@/components/routing/TestUrlCard.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { showNotification } from '@/helper/notification'
import { onMounted, ref } from 'vue'

const { padding } = usePaddingForViews({
  offsetTop: 0,
  offsetBottom: 0,
})

const status = ref<OpenboxServiceStatus | null>(null)
const kernelVersion = ref<OpenboxKernelVersion | null>(null)
const profile = ref<OpenboxProfile | null>(null)

// 首次加载和每个动作(启动/停止/重启/自启开关)之后的刷新都走这里
const loadStatus = async () => {
  // 服务状态和版本并行请求,但先把服务状态交给卡片;版本命令较慢时不再拖住整张卡片。
  const statusRequest = refreshServiceStatus().then((fetchedStatus) => {
    status.value = fetchedStatus ?? null
  })
  const versionRequest = fetchKernelVersion().then((fetchedVersion) => {
    kernelVersion.value = fetchedVersion
  })
  const results = await Promise.allSettled([statusRequest, versionRequest])
  const error = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason
  if (error) {
    showNotification({
      content: 'kernelLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  }
}

const loadProfile = async () => {
  try {
    profile.value = await fetchProfile()
  } catch (error) {
    showNotification({
      content: 'routingLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  }
}

// 两张参数卡片的改动都经这里写档案,成功后用服务端返回的新档案刷新
const patchProfile = async (patch: Record<string, unknown>): Promise<OpenboxProfile> => {
  const updated = await saveProfile(patch)
  profile.value = updated
  return updated
}

const onImported = () => Promise.all([loadStatus(), loadProfile()])

onMounted(async () => {
  await Promise.all([loadStatus(), loadProfile()])
})
</script>

<style>
/* 把相邻的设置卡片拼成一张:去掉各自的外框、底色、毛玻璃,中间只留一条分隔线。
   主题(背景图模式)会给所有 .card 强加半透明底和模糊,所以这里要用 !important 压住 */
.kernel-group {
  display: flex;
  flex-direction: column;
}
.kernel-group > .card {
  border-width: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
.kernel-group > .card + .card {
  border-top: 1px solid color-mix(in oklab, currentColor 10%, transparent) !important;
}
/* 每张设置卡片里,标题和它下面的说明之间再空出 4px,与上游 v0.1.317 一致 */
.kernel-group .card-body > div:first-child > p {
  margin-top: 0.25rem;
}
/* 这一页的按钮、输入框、下拉、黑白名单切换统一用胶囊形,和上游一致。
   主题自己也在管这些控件的圆角,不加 !important 压不住 */
.kernel-top .btn,
.kernel-group .btn,
.kernel-top .select,
.kernel-group .select,
.kernel-top .input,
.kernel-group .input,
.kernel-group .tabs-box,
.kernel-group .tabs-box .tab {
  border-radius: 9999px !important;
}
</style>
