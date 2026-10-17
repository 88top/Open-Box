<template>
  <!-- 顶部总卡片:标识 / 平台 / 版本 / 状态 / 启停 / 更新 都在这一张里 -->
  <div class="kernel-top card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4 text-sm">
      <!-- 标题行:Open-Box 标识 + 版本号;右边是需要注意的提示和「恢复出厂设置」 -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="inline-flex items-center gap-2 py-1">
          <img
            :src="logoUrl"
            class="app-logo h-6 w-auto"
            alt="Open-Box"
          />
          <span
            v-if="openboxVersion"
            class="font-mono text-sm"
          >{{ openboxVersion }}</span>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <ExclamationTriangleIcon
            v-if="warnTip"
            class="text-warning h-5 w-5 shrink-0"
            v-tip="warnTip"
          />
          <FactoryResetButton />
        </div>
      </div>

      <!-- 平台:OpenWrt / Linux / Docker 三张卡,本机所在的那张高亮,其余灰底灰图标(与 v0.1.337 一致) -->
      <div
        v-if="serviceStatus"
        class="router-platform-tiles grid grid-cols-[repeat(auto-fill,minmax(min(19rem,100%),1fr))] gap-2"
      >
        <div
          v-for="p in platformCards"
          :key="p.id"
          class="@container/tile bg-base-100 border-base-300/60 rounded-lg border px-3 py-2.5"
          :class="p.current && 'platform-tile-current'"
          :title="p.hint"
        >
          <span class="flex flex-col items-start gap-1.5 @min-[14rem]/tile:flex-row @min-[14rem]/tile:gap-2">
            <CountryFlag
              :code="p.icon"
              :size="32"
              :title="p.hint"
              class="shrink-0 @min-[14rem]/tile:mt-0.5"
              :class="!p.current && 'grayscale'"
            />
            <span class="flex max-w-full min-w-0 flex-col">
              <span class="flex max-w-full flex-wrap items-baseline gap-x-1.5">
                <span class="max-w-full truncate leading-5 font-medium">{{ p.title }}</span>
                <span
                  v-if="p.current && thisDevice"
                  class="text-base-content/60 max-w-full truncate text-xs leading-4 tabular-nums"
                >
                  {{ thisDevice }}
                </span>
              </span>
              <span class="platform-tile-req text-base-content/50 text-xs leading-4 break-keep">{{ nbsp(p.req) }}</span>
            </span>
          </span>
        </div>
      </div>

      <div
        v-if="status && status.conflicts.length > 0"
        class="alert alert-warning flex-col items-start gap-1"
      >
        <div class="flex items-center gap-2 font-medium">
          <ExclamationTriangleIcon class="h-4 w-4 shrink-0" />
          {{ $t('kernelConflictTitle') }}
        </div>
        <ul class="list-disc pl-6 text-xs">
          <li
            v-for="c in status.conflicts"
            :key="c.id"
          >
            {{ $t('kernelConflictItem', { name: c.label }) }}
          </li>
        </ul>
      </div>

      <!-- 内核版本 + sing-box 项目链接 -->
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CpuChipIcon class="text-base-content/60 h-4 w-4 shrink-0" />
        <span class="text-base-content/70">{{ $t('kernelVersionLabel') }}:</span>
        <span class="font-medium">{{ kernelText }}</span>
        <a
          href="https://github.com/SagerNet/sing-box"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:bg-base-200 inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5"
          v-tip="$t('singboxGithubHint')"
        >
          <GithubIcon class="h-4 w-4" />
          <span>{{ $t('singboxGithubLabel') }}</span>
          <ArrowTopRightOnSquareIcon class="text-base-content/50 h-3.5 w-3.5" />
        </a>
      </div>

      <!-- Geo 数据:份数、数据日期、数据来源 -->
      <div
        v-if="updateInfo?.geoCounts || updateInfo?.geoDate"
        class="text-base-content/70 flex flex-wrap items-center gap-x-4 gap-y-1"
      >
        <span
          v-if="updateInfo.geoCounts"
          class="inline-flex items-center gap-1.5"
        >
          <MapIcon class="h-4 w-4 shrink-0" />
          {{ $t('geoSiteCount', { count: updateInfo.geoCounts.geosite }) }}
        </span>
        <span
          v-if="updateInfo.geoCounts"
          class="inline-flex items-center gap-1.5"
        >
          <CircleStackIcon class="h-4 w-4 shrink-0" />
          {{ $t('geoIpCount', { count: updateInfo.geoCounts.geoip }) }}
        </span>
        <span v-if="updateInfo.geoDate">{{ updateInfo.geoDate }}</span>
        <a
          href="https://github.com/MetaCubeX/meta-rules-dat"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:bg-base-200 inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5"
          v-tip="$t('geoGithubHint')"
        >
          <GithubIcon class="h-4 w-4" />
          <span>{{ $t('geoGithubLabel') }}</span>
          <ArrowTopRightOnSquareIcon class="text-base-content/50 h-3.5 w-3.5" />
        </a>
      </div>

      <div class="bg-base-content/10 h-px" />

      <!-- 内核 / 面板 / 开机自启三项状态放同一行,标签用全局统一的 StatusBadge -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ $t('kernelCoreLabel') }}</span>
          <StatusBadge
            v-if="serviceStatus"
            :on="serviceStatus.core.running"
            :on-text="$t('kernelStatusRunning')"
            :off-text="$t('kernelStatusStopped')"
          />
          <span
            v-else
            class="badge badge-sm"
          >—</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ $t('kernelPanelLabel') }}</span>
          <StatusBadge
            v-if="serviceStatus"
            :on="serviceStatus.panel.running"
            :on-text="$t('kernelStatusRunning')"
            :off-text="$t('kernelStatusStopped')"
          />
          <span
            v-else
            class="badge badge-sm"
          >—</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ $t('kernelAutostartLabel') }}</span>
          <StatusBadge
            v-if="serviceStatus"
            :on="Boolean(serviceStatus.core.autostart)"
            :on-text="$t('kernelAutostartOn')"
            :off-text="$t('kernelAutostartOff')"
          />
          <span
            v-else
            class="badge badge-sm"
          >—</span>
        </div>
      </div>

      <!-- 启动/重启 = 用当前设置重新生成配置并应用(server/api/service.mjs),
           所以界面上没有单独的「部署」按钮:各设置页保存完,来这里启动一下就生效。 -->
      <p class="text-base-content/60 text-xs">{{ $t('kernelApplyHint') }}</p>

      <!-- 一行:[启动] [停止] [重启]。开机自启不单独给按钮:启动 / 重启成功即打开自启,停止即关闭
           (server/api/service.mjs 与 deploy-runner.mjs),上面的状态标签只是展示。
           互斥:内核在跑就不能再「启动」,没在跑就不能「停止/重启」;有动作进行中时全部禁用。 -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isStartDisabled"
          @click="runKernelAction('start')"
        >
          <span
            v-if="pendingAction === 'start'"
            class="loading loading-spinner loading-xs"
          />
          <PlayIcon
            v-else
            class="h-4 w-4"
          />
          {{ $t('kernelActionStart') }}
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isStopDisabled"
          v-tip="$t('kernelActionStopHint')"
          @click="runKernelAction('stop')"
        >
          <span
            v-if="pendingAction === 'stop'"
            class="loading loading-spinner loading-xs"
          />
          <StopIcon
            v-else
            class="h-4 w-4"
          />
          {{ $t('kernelActionStop') }}
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="isRestartDisabled"
          @click="runKernelAction('restart')"
        >
          <span
            v-if="pendingAction === 'restart'"
            class="loading loading-spinner loading-xs"
          />
          <ArrowPathIcon
            v-else
            class="h-4 w-4"
          />
          {{ $t('kernelActionRestart') }}
        </button>
      </div>

      <!-- Open-Box 更新:通道 / 检查更新 / 自动更新(档案还在加载时先不显示) -->
      <template v-if="profile && patchProfile">
        <div class="bg-base-content/10 h-px" />
        <OpenboxUpdateCard
          embedded
          :profile="profile"
          :patch-profile="patchProfile"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxKernelVersion, OpenboxProfile, OpenboxServiceStatus } from '@/api/openbox'
import CountryFlag from '@/components/common/CountryFlag.vue'
import GithubIcon from '@/components/common/GithubIcon.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import FactoryResetButton from '@/components/kernel/FactoryResetButton.vue'
import OpenboxUpdateCard from '@/components/kernel/OpenboxUpdateCard.vue'
import {
  isRestartDisabled,
  isStartDisabled,
  isStopDisabled,
  pendingAction,
  serviceStatus,
  useKernelActions,
} from '@/composables/kernelService'
import { refreshUpdateInfo, updateInfo } from '@/composables/openboxUpdate'
import { DARK_THEME, theme } from '@/store/settings'
import logoUrl from '@/assets/logo.png'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CircleStackIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  MapIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/vue/24/outline'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// Geo 数据、安装通道都来自更新状态(同卡的更新区也会拉;这里没有就自己拉一次)
onMounted(() => {
  if (!updateInfo.value) void refreshUpdateInfo()
})

// status 仍作为 prop 保留给页面传入(刷新时序由页面掌握),卡片本身只读共享状态
const props = defineProps<{
  status: OpenboxServiceStatus | null
  kernelVersion: OpenboxKernelVersion | null
  profile?: OpenboxProfile | null
  patchProfile?: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
}>()

const emit = defineEmits<{
  refresh: []
}>()

// 状态标签和按钮读的是同一份共享状态(composables/kernelService.ts):页面自己再拿一份
// 会分叉——在侧边栏点停止、内核被外部停掉时标签不跟着变;直接往共享状态里写又绕过了
// refreshSeq,旧响应能把新状态盖回去。

const { runKernelAction: run } = useKernelActions()
const runKernelAction = async (action: Parameters<typeof run>[0]) => {
  await run(action)
  emit('refresh')
}

// Open-Box 自己的版本号(来自更新状态,标题行显示成 v0.1.317 这种)
const openboxVersion = computed(() => {
  const raw = updateInfo.value?.version || ''
  return raw ? `v${raw.replace(/^v/i, '')}` : ''
})

// 内核版本:新服务端读到的是「1.14.1-xxx」,界面统一写成「sing-box version …」
const kernelText = computed(() => {
  const raw = (props.kernelVersion?.ok === false ? '' : props.kernelVersion?.version) || updateInfo.value?.singboxVersion || ''
  if (!raw) return t('kernelVersionUnknown')
  return /^sing-box/i.test(raw) ? raw : `sing-box version ${raw}`
})

// 需要用户注意的事:有冲突的代理工具、或有改动还没重启生效
const warnTip = computed(() => {
  if (props.status?.conflicts.length) return t('kernelConflictTitle')
  if (serviceStatus.value?.pendingRestart?.pending) return t('kernelPendingRestart')
  return ''
})

// 本机系统:发行版名 + 版本 + 架构。osRelease 的形状随服务端版本不同,按几种常见写法读
const osName = computed(() => {
  const release = serviceStatus.value?.osRelease
  if (!release) return ''
  if (typeof release === 'string') return release
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = release[key]
      if (typeof value === 'string' && value) return value
    }
    return ''
  }
  const pretty = pick('prettyName', 'PRETTY_NAME', 'DISTRIB_DESCRIPTION')
  if (pretty) return pretty
  return [pick('name', 'NAME', 'DISTRIB_ID', 'id', 'ID'), pick('version', 'VERSION_ID', 'DISTRIB_RELEASE', 'versionId')]
    .filter(Boolean)
    .join(' ')
})
const thisDevice = computed(() => {
  const arch = serviceStatus.value?.arch || ''
  const text = [osName.value, arch].filter(Boolean).join(' · ')
  return text ? t('routerPlatformThisVersion', { version: text }) : ''
})
// 本机跑在哪种环境:openwrt / systemd(Linux)/ container(Docker);老服务端没有 platform 时按 openwrt 处理
const platformKind = computed(() => serviceStatus.value?.platform || 'openwrt')
// 「Ubuntu 22.04 / Debian 12 · x64 / arm64」里的空格换成不换行空格,窄卡片里只在「/」「·」处换行
const nbsp = (text: string) =>
  text
    .split(' · ')
    .map((part) => part.split(' / ').map((item) => item.replace(/ /g, '\u00a0')).join(' / '))
    .join(' · ')
const platformCards = computed(() => [
  {
    id: 'openwrt' as const,
    title: 'OpenWrt',
    icon: 'brand:openwrt',
    req: t('routerPlatformReqOpenwrt'),
    hint: t('routerPlatformHintOpenwrt'),
    current: platformKind.value === 'openwrt',
  },
  {
    id: 'linux' as const,
    title: 'Linux',
    icon: theme.value === DARK_THEME ? 'brand:linux-color-light' : 'brand:linux-color',
    req: t('routerPlatformReqLinux'),
    hint: t('routerPlatformHintLinux'),
    current: platformKind.value === 'systemd',
  },
  {
    id: 'docker' as const,
    title: 'Docker',
    icon: 'brand:docker',
    req: 'Linux · x64 / arm64',
    hint: t('dockerAccessHint', { ip: serviceStatus.value?.container?.lanIp || '' }),
    current: platformKind.value === 'container',
  },
])
</script>
