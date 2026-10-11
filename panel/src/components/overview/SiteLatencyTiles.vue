<template>
  <!-- 四个站点延迟小卡:品牌标识 + 最近 10 次的小柱 + 站名 + 延迟 / 不通。
       自动测速开关和 ⚡ 按钮在上面「面板概览」的标题栏里(PanelOverviewCard.vue) -->
  <div class="grid grid-cols-2 gap-2 xl:grid-cols-4">
    <div
      v-for="card in cards"
      :key="card.id"
      class="border-base-300/60 bg-base-100 flex min-w-0 items-center gap-3 rounded-full border px-3 py-2.5"
      :title="card.hint"
    >
      <span
        v-if="showIcon"
        class="flex h-9 w-9 shrink-0 items-center justify-center"
      >
        <CountryFlag
          :code="card.icon"
          :size="36"
        />
      </span>
      <!-- 小柱容器占满图标和文字之间的空位、两端对齐(和 v0.1.308 一样):柱数按容器宽度算,
           柱宽 6px、间距 2px;只有几根时也是一根贴左、一根居中、一根贴右 -->
      <span
        v-if="card.bars.length"
        :ref="(el) => observe(el, card.id)"
        class="flex h-[34px] min-w-0 flex-1 items-end justify-between gap-[2px]"
      >
        <span
          v-for="(bar, i) in card.bars"
          :key="i"
          class="w-[6px] shrink-0 rounded-[1px]"
          :class="bar.color"
          :style="{ height: bar.height }"
          :title="bar.title"
        ></span>
      </span>
      <span
        v-else
        :ref="(el) => observe(el, card.id)"
        class="min-w-0 flex-1"
      ></span>
      <span class="flex max-w-[55%] shrink-0 flex-col">
        <span class="text-base-content/60 mb-1 truncate text-xs">{{ card.name }}</span>
        <!-- 外层 text-xl 给数字用;「不通」嵌一层 text-base,比数字小一档 -->
        <span
          class="text-xl leading-none font-semibold"
          :class="card.color"
        >
          <span
            v-if="siteLatencyLoading && card.ms === null"
            class="loading loading-dots loading-sm text-base-content/60 my-1"
          ></span>
          <span
            v-else-if="card.ms !== null"
            class="tabular-nums"
          >
            {{ card.ms }}<span class="text-base-content/50 ml-1 text-xs leading-none font-normal">ms</span>
          </span>
          <span
            v-else-if="card.failed"
            class="text-base"
          >{{ $t('siteUnreachable') }}</span>
          <span
            v-else
            class="text-base-content/40 font-normal"
          >—</span>
        </span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import CountryFlag from '@/components/common/CountryFlag.vue'
import {
  activeSites,
  autoSiteLatencyTest,
  loadSiteHistory,
  runSiteLatencyTest,
  siteHistory,
  siteLatencyLoading,
  siteResults,
  siteTimeoutMs,
} from '@/composables/siteLatency'
import { NOT_CONNECTED } from '@/constant'
import { getColorForLatency } from '@/helper'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// 类名要写全,Tailwind 只编它在源码里见过的类
const barColor = (delay: number) => {
  if (delay === NOT_CONNECTED) return 'bg-red-500'
  switch (getColorForLatency(delay)) {
    case 'text-green-500':
      return 'bg-green-500'
    case 'text-yellow-500':
      return 'bg-yellow-500'
    case 'text-red-500':
      return 'bg-red-500'
    default:
      return 'bg-gray-400'
  }
}

// 小柱的尺寸(px),和模板里的 w-[6px] / gap-[2px] 对应;柱数 = 容器宽度能放下几根
const BAR_W = 6
const BAR_GAP = 2
const BAR_EDGE = 1
const MAX_BARS = 60
const MIN_BARS = 8
// 图标占的宽度(图标 36 + 间距 12 再留一点);容器放不下 MIN_BARS 根时把图标让出来
const ICON_SPACE = 56
// 柱子最矮不低于容器高度的 5%,不然几十毫秒的柱子会看不见
const MIN_PCT = 5

const barsWidth = ref<Record<string, number>>({})
const iconFits = ref<Record<string, boolean>>({})
const showIcon = ref(true)
const needed = (n: number) => n * BAR_W + (n - 1) * BAR_GAP + BAR_EDGE

const observers = new Map<string, { node: HTMLElement; ob: ResizeObserver }>()
const observe = (el: unknown, id: string) => {
  const node = (el as HTMLElement | null) ?? null
  const cur = observers.get(id)
  if (cur && cur.node === node) return
  cur?.ob.disconnect()
  observers.delete(id)
  if (!node || !('ResizeObserver' in window)) return
  const ob = new ResizeObserver(([entry]) => {
    const w = entry?.contentRect.width ?? 0
    if (w <= 0) return
    barsWidth.value = { ...barsWidth.value, [id]: w }
    // 图标显示时容器宽度已经扣掉了图标;图标隐藏时要先扣回去再比
    const withIcon = showIcon.value ? w : w - ICON_SPACE
    iconFits.value = { ...iconFits.value, [id]: withIcon >= needed(MIN_BARS) }
    const all = Object.values(iconFits.value).every(Boolean)
    if (all !== showIcon.value) showIcon.value = all
  })
  ob.observe(node)
  observers.set(id, { node, ob })
}
onBeforeUnmount(() => {
  for (const { ob } of observers.values()) ob.disconnect()
  observers.clear()
})

const barCount = (id: string) => {
  const w = barsWidth.value[id]
  if (!w) return 10
  return Math.max(1, Math.min(MAX_BARS, Math.floor((w - BAR_EDGE + BAR_GAP) / (BAR_W + BAR_GAP))))
}
// 「不通」记的是 0,实际等了 timeoutMs,按超时时长算高度
const effective = (delay: number) => (delay === NOT_CONNECTED ? siteTimeoutMs.value : delay)
const visibleSamples = (id: string) => (siteHistory.value[id] ?? []).slice(-barCount(id))
// 四个站点的柱子共用同一把尺:所有可见样本里最大的那个值算 100%
const maxValue = computed(() =>
  Math.max(1, ...activeSites.value.flatMap((site) => visibleSamples(site.id).map((s) => effective(s.delay)))),
)

const cards = computed(() =>
  activeSites.value.map((site) => {
    const result = siteResults.value[site.id]
    const history = siteHistory.value[site.id] ?? []
    const last = history.length ? history[history.length - 1] : null
    // 这一轮测过就用这一轮的;还没测就先显示历史里最后一次
    const ms = result ? (result.ms ?? null) : last && last.delay !== NOT_CONNECTED ? last.delay : null
    // 这一轮测过但没通,或者还没测、历史里最后一次就是不通
    const failed = ms === null && (Boolean(result) || last?.delay === NOT_CONNECTED)
    const chain = result?.chain?.length ? result.chain.join(' → ') : ''
    return {
      id: site.id,
      name: site.name,
      icon: site.icon,
      ms,
      failed,
      color: failed ? 'text-red-500' : ms === null ? '' : getColorForLatency(ms),
      hint: [result?.error, chain, result?.openMs != null ? `${result.openMs}ms` : '']
        .filter(Boolean)
        .join(' · '),
      bars: visibleSamples(site.id).map((sample) => ({
        height: `${Math.max(MIN_PCT, Math.round((effective(sample.delay) / maxValue.value) * 100))}%`,
        color: barColor(sample.delay),
        title: `${dayjs(sample.time).format('MM-DD HH:mm:ss')} ${
          sample.delay === NOT_CONNECTED ? t('latencyTimeout') : `${sample.delay}ms`
        }${sample.node ? ` · ${sample.node}` : ''}`,
      })),
    }
  }),
)

onMounted(async () => {
  await loadSiteHistory()
  if (autoSiteLatencyTest.value) void runSiteLatencyTest()
})
</script>
