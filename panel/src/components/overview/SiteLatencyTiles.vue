<template>
  <!-- 四个站点延迟小卡(对齐 v0.1.337):品牌图标 + 最近若干次的小柱 + 站名 + 延迟 / 不通。
       点哪张就只重测哪一张;自动测速开关和 ⚡ 按钮在上面「面板概览」的标题栏里(PanelOverviewCard.vue) -->
  <div class="@container">
    <div class="grid grid-cols-2 gap-3 @[900px]:grid-cols-4">
      <div
        v-for="card in cards"
        :key="card.id"
        class="bg-base-100 border-base-300/60 hover:border-base-content/20 active:bg-base-200/40 flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-[color,background-color,border-color,scale] duration-150 ease-out select-none active:scale-[0.98]"
        role="button"
        tabindex="0"
        :aria-busy="card.loading"
        @click="runSiteLatencyTest(card.id)"
        @keydown.enter.prevent="runSiteLatencyTest(card.id)"
        @keydown.space.prevent="runSiteLatencyTest(card.id)"
      >
        <span
          v-if="showIcon"
          class="bg-base-200/60 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
        >
          <ProxyIcon
            v-if="card.iconUrl"
            :icon="card.iconUrl"
            :size="28"
            :margin="0"
          />
          <GlobeAltIcon
            v-else
            class="text-base-content/50 h-6 w-6"
          />
        </span>
        <!-- 小柱容器占满图标和文字之间的空位、两端对齐:柱数按容器宽度算,柱宽 6px、间距 2px;
             只有几根时也是一根贴左、一根居中、一根贴右 -->
        <span
          v-if="card.bars.length"
          :ref="(el) => observe(el, card.id)"
          class="flex h-[34px] min-w-0 flex-1 items-end justify-between gap-[2px]"
        >
          <span
            v-for="(bar, i) in card.bars"
            :key="i"
            v-tip="bar.tip"
            class="w-[6px] shrink-0 rounded-[1px]"
            :class="bar.color"
            :style="{ height: bar.height }"
          ></span>
        </span>
        <span
          v-else
          :ref="(el) => observe(el, card.id)"
          class="min-w-0 flex-1"
        ></span>
        <span class="flex max-w-[55%] shrink-0 flex-col">
          <span class="text-base-content/60 mb-1 truncate text-xs">{{ card.label }}</span>
          <span class="leading-none">
            <span
              v-if="card.loading && card.ms === undefined"
              class="loading loading-dots loading-sm text-base-content/60 my-1"
            ></span>
            <span
              v-else-if="card.ms === undefined"
              class="text-base-content/40 text-xl leading-none tabular-nums"
              >—</span
            >
            <span
              v-else-if="card.ms === null"
              class="text-xl leading-none font-semibold text-red-500 transition-opacity"
              :class="card.loading && 'opacity-40'"
            >
              <span class="text-base leading-none">{{ $t('siteUnreachable') }}</span>
            </span>
            <span
              v-else
              class="text-xl leading-none font-semibold tabular-nums transition-opacity"
              :class="[card.color, card.loading && 'opacity-40']"
            >
              {{ card.ms }}<span class="text-base-content/50 ml-1 text-xs leading-none font-normal">ms</span>
            </span>
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ProxyIcon from '@/components/proxies/ProxyIcon.vue'
import {
  activeSites,
  autoSiteLatencyTest,
  isValidSiteUrl,
  loadSiteHistory,
  runSiteLatencyTest,
  siteHistory,
  siteResults,
  siteTimeoutMs,
  testingSiteIds,
} from '@/composables/siteLatency'
import { brandName, findBrand } from '@/constant/brands'
import { NOT_CONNECTED } from '@/constant'
import { getColorForLatency } from '@/helper'
import { iconUrlFor } from '@/helper/iconUrl'
import { GlobeAltIcon } from '@heroicons/vue/24/outline'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { locale, t } = useI18n()

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
// 图标占的宽度(图标 44 + 间距 12);容器放不下 MIN_BARS 根时把图标让出来
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

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const delayText = (delay: number) => (delay === NOT_CONNECTED ? t('siteUnreachable') : `${delay} ms`)
// 悬停小柱:上一行是当时走的线路(没记录就用这个站点最近一次有记录的),下一行是时间 · 延迟
const barTip = (sample: { time: number; delay: number; node?: string }, fallbackNode: string) => {
  const node = sample.node || fallbackNode
  const lines: string[] = []
  if (node) lines.push(`<span class="text-xs opacity-70">${escapeHtml(node)}</span>`)
  lines.push(escapeHtml(`${dayjs(sample.time).format('MM-DD HH:mm:ss')} · ${delayText(sample.delay)}`))
  return lines.join('<br>')
}
const lastNode = (id: string) => {
  const list = siteHistory.value[id] || []
  for (let i = list.length - 1; i >= 0; i--) if (list[i].node) return list[i].node as string
  return ''
}

const hostOf = (url: string) => {
  try {
    return new URL(String(url || '').trim()).hostname
  } catch {
    return ''
  }
}

const cards = computed(() =>
  activeSites.value.map((site) => {
    const valid = isValidSiteUrl(site.url)
    // 只认和当前地址对得上的结果:改了地址后旧结果不再显示
    const result = siteResults.value[site.id]?.url === site.url ? siteResults.value[site.id] : undefined
    const history = siteHistory.value[site.id] ?? []
    const last = history.length ? history[history.length - 1] : undefined
    // undefined = 还没测过(显示 —);null = 不通
    const ms: number | null | undefined = !valid
      ? null
      : result
        ? result.ms
        : last
          ? last.delay === NOT_CONNECTED
            ? null
            : last.delay
          : undefined
    const brand = findBrand(site.icon)
    const fallbackNode = lastNode(site.id)
    return {
      id: site.id,
      label: site.name.trim() || (brand ? brandName(brand, locale.value) : '') || hostOf(site.url) || site.id,
      iconUrl: iconUrlFor(site.icon),
      ms,
      loading: testingSiteIds.value.has(site.id),
      color: typeof ms === 'number' ? getColorForLatency(ms) : '',
      bars: visibleSamples(site.id).map((sample) => ({
        height: `${Math.max(MIN_PCT, Math.round((effective(sample.delay) / maxValue.value) * 100))}%`,
        color: barColor(sample.delay),
        tip: barTip(sample, fallbackNode),
      })),
    }
  }),
)

onMounted(async () => {
  await loadSiteHistory()
  if (autoSiteLatencyTest.value) void runSiteLatencyTest()
})
</script>
