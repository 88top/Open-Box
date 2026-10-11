import {
  fetchSiteLatencyHistory,
  testSiteLatency,
  type OpenboxLatencyHistory,
  type OpenboxSiteLatencyResult,
} from '@/api/openbox'
import { showNotification } from '@/helper/notification'
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
// 地址留空的站点不参与测速,也不在概览里显示
export const activeSites = computed(() => testSites.value.filter((site) => site.url.trim() !== ''))

// 打开概览页时要不要自动测一轮;关掉后只显示历史,点 ⚡ 才测
export const autoSiteLatencyTest = useStorage('config/auto-site-latency-test', true)

export const siteResults = ref<Record<string, OpenboxSiteLatencyResult>>({})
export const siteHistory = ref<OpenboxLatencyHistory>({})
export const siteTimeoutMs = ref(5000)
export const siteTestedAt = ref(0)
export const siteLatencyLoading = ref(false)

const notifyError = (e: unknown) => {
  showNotification({
    content: 'routeTestRequestFailed',
    params: { message: e instanceof Error ? e.message : String(e) },
    key: 'site-latency-card',
    type: 'alert-error',
  })
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

export const runSiteLatencyTest = async () => {
  if (siteLatencyLoading.value) return
  const sites = activeSites.value.map(({ id, url }) => ({ id, url: url.trim() }))
  if (!sites.length) return
  siteLatencyLoading.value = true
  try {
    const run = await testSiteLatency(sites)
    siteResults.value = Object.fromEntries(run.sites.map((site) => [site.id, site]))
    siteHistory.value = run.history
    siteTimeoutMs.value = run.timeoutMs
    siteTestedAt.value = run.testedAt
  } catch (e) {
    notifyError(e)
  } finally {
    siteLatencyLoading.value = false
  }
}
