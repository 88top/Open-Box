<template>
  <div :class="className.list">
    <div
      v-for="stat in order"
      :key="stat"
      :class="className.item"
    >
      <div :class="className.label">{{ $t(labelKey(stat)) }}</div>
      <div :class="className.value">{{ statisticsMap[stat] }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { STATISTICS_TYPE, statisticsMap } from '@/composables/statistics'
import { computed } from 'vue'

const props = defineProps<{
  type: 'overview' | 'ctrl' | 'settings'
}>()

const classMap = {
  overview: {
    list: 'grid grid-flow-col grid-cols-3 grid-rows-2 gap-2 rounded-xl border border-base-300/60 bg-base-100 p-3 lg:grid-flow-row lg:grid-cols-6 lg:grid-rows-1',
    item: 'flex h-12 flex-col items-center justify-center lg:gap-0.5',
    label: 'text-xs text-base-content/70',
    value: 'text-lg lg:text-xl font-bold',
  },
  settings: {
    list: 'grid w-full grid-cols-3 gap-1 rounded-lg bg-base-200/50 p-3',
    item: 'flex flex-col items-start',
    label: 'text-xs text-base-content/70',
    value: 'text-sm',
  },
  ctrl: {
    // 侧边栏那张卡片自己就是容器(CommonCtrl.vue,card p-3 = 12px 内边距),这里不再套底色也不再加内边距
    list: 'grid w-full grid-cols-2 gap-2',
    item: 'flex items-start flex-col',
    label: 'text-xs text-base-content/70',
    value: 'text-sm',
  },
}

const orderMap = {
  overview: [
    STATISTICS_TYPE.CONNECTIONS,
    STATISTICS_TYPE.MEMORY_USAGE,
    STATISTICS_TYPE.DOWNLOAD,
    STATISTICS_TYPE.DL_SPEED,
    STATISTICS_TYPE.UPLOAD,
    STATISTICS_TYPE.UL_SPEED,
  ],
  settings: [
    STATISTICS_TYPE.CONNECTIONS,
    STATISTICS_TYPE.DOWNLOAD,
    STATISTICS_TYPE.DL_SPEED,
    STATISTICS_TYPE.MEMORY_USAGE,
    STATISTICS_TYPE.UPLOAD,
    STATISTICS_TYPE.UL_SPEED,
  ],
  ctrl: [
    STATISTICS_TYPE.CONNECTIONS,
    STATISTICS_TYPE.MEMORY_USAGE,
    STATISTICS_TYPE.DOWNLOAD,
    STATISTICS_TYPE.DL_SPEED,
    STATISTICS_TYPE.UPLOAD,
    STATISTICS_TYPE.UL_SPEED,
  ],
}

const className = computed(() => classMap[props.type])
const order = computed(() => orderMap[props.type])

// 概览和侧边栏用「连接数 / 进站流量 / 出站流量」这几个标签;设置页保持原样
const LABEL_KEY: Record<string, string> = {
  [STATISTICS_TYPE.CONNECTIONS]: 'statConnections',
  [STATISTICS_TYPE.DOWNLOAD]: 'statDownloadTotal',
  [STATISTICS_TYPE.UPLOAD]: 'statUploadTotal',
}
const labelKey = (stat: string) => (props.type === 'settings' ? stat : (LABEL_KEY[stat] ?? stat))
</script>
