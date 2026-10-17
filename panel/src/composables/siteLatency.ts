import {
  fetchSiteLatencyHistory,
  testSiteLatency,
  type OpenboxLatencyHistory,
  type OpenboxSiteLatencyResult,
} from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { autoConnectionCheck } from '@/store/settings'
import { useStorage } from '@vueuse/core'
import { computed, ref } from 'vue'

// 概览「站点延迟」的共享状态:标题栏的 ⚡ 按钮、自动测速开关和下面的四个小卡要看同一份结果。
// 站点表来自面板设置 → 测试站点(config/test-sites),默认是上游的那四个(服务端 GET 不带正文时也是这四个)。
// id 固定不变(服务端只认小写字母数字和横线),图标 / 名称 / 地址可以改。
export interface TestSite {
  id: string
  icon: string
  name: string
  url: string
}

export const DEFAULT_SITES: TestSite[] = [
  { id: 'baidu', icon: 'brand:baidu', name: '百度', url: 'https://www.baidu.com/favicon.ico' },
  { id: 'google', icon: 'brand:google', name: 'Google', url: 'https://www.google.com/generate_204' },
  { id: 'openai', icon: 'brand:openai-light', name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
  { id: 'telegram', icon: 'brand:telegram', name: 'Telegram', url: 'https://telegram.org/favicon.ico' },
]

const cloneDefaultSites = () => DEFAULT_SITES.map((site) => ({ ...site }))

export const testSites = useStorage<TestSite[]>('config/test-sites', cloneDefaultSites())
export const resetTestSites = () => {
  testSites.value = cloneDefaultSites()
}
// 和 v0.1.337 一样,四个位置都显示;地址不是 http(s) 的那个位置不测,直接显示「不通」
export const activeSites = computed(() => testSites.value)
export const isValidSiteUrl = (url: string) => {
  try {
    const u = new URL(String(url || '').trim())
    return /^https?:$/.test(u.protocol) && u.hostname !== ''
  } catch {
    return false
  }
}

// 打开概览页时要不要自动测一轮;关掉后只显示历史,点 ⚡ 才测。
// 和面板设置里的「自动检查连接」是同一个开关(v0.1.337 的做法)
export const autoSiteLatencyTest = autoConnectionCheck

export const siteResults = ref<Record<string, OpenboxSiteLatencyResult>>({})
export const siteHistory = ref<OpenboxLatencyHistory>({})
export const siteTimeoutMs = ref(5000)
export const siteTestedAt = ref(0)
// 正在测的站点 id:点单张卡只转那一张,点 ⚡ 四张一起转
export const testingSiteIds = ref<Set<string>>(new Set())
export const siteLatencyLoading = computed(() => testingSiteIds.value.size > 0)

// 同一条错误只弹一次,不然每次重测都刷一条
let lastError = ''
const notifyError = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  if (message !== lastError) {
    showNotification({
      content: 'routeTestRequestFailed',
      params: { message },
      key: 'site-latency',
      type: 'alert-error',
    })
  }
  lastError = message
}

export const loadSiteHistory = async () => {
  try {
    const data = await fetchSiteLatencyHistory()
    siteHistory.value = data.history
    siteTimeoutMs.value = data.timeoutMs
  } catch {
    // 只是先把柱子画出来,拿不到就等测完那一轮带回来
  }
}

// id 为空 = 测全部;给了 id = 只测那一张卡。目标里有任何一个还在测就不重复发
export const runSiteLatencyTest = async (id = '') => {
  const targets = activeSites.value.filter((site) => (!id || site.id === id) && isValidSiteUrl(site.url))
  const ids = targets.map((site) => site.id)
  if (!ids.length || ids.some((item) => testingSiteIds.value.has(item))) return
  testingSiteIds.value = new Set([...testingSiteIds.value, ...ids])
  try {
    const run = await testSiteLatency(targets.map(({ id: siteId, url }) => ({ id: siteId, url })))
    for (const site of run.sites) siteResults.value = { ...siteResults.value, [site.id]: site }
    if (run.history) siteHistory.value = run.history
    if (run.timeoutMs) siteTimeoutMs.value = run.timeoutMs
    siteTestedAt.value = run.testedAt
    lastError = ''
  } catch (e) {
    notifyError(e)
  } finally {
    testingSiteIds.value = new Set([...testingSiteIds.value].filter((item) => !ids.includes(item)))
  }
}
