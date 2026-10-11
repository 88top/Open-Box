<template>
  <!-- 客户端下载:版本号从 GitHub Releases 读(缓存 10 分钟),点一下直接下载 -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <span class="text-base font-semibold">{{ $t('clientDownloadTitle') }}</span>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <component
          :is="tile.available ? 'a' : 'div'"
          v-for="tile in tiles"
          :key="tile.key"
          v-bind="tile.attrs"
          :title="tile.hint"
          class="border-base-content/10 bg-base-100/60 flex items-center gap-2.5 rounded-lg border px-3 py-2.5"
          :class="tile.available ? 'hover:bg-base-200/60 transition-colors' : 'cursor-not-allowed'"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span
            v-if="tile.svg"
            class="inline-flex shrink-0"
            :class="!tile.available && 'opacity-50 grayscale'"
            v-html="tile.svg"
          />
          <CountryFlag
            v-else
            :code="tile.icon"
            :size="32"
            class="shrink-0"
            :class="!tile.available && 'opacity-50 grayscale'"
          />
          <span class="flex min-w-0 flex-col">
            <span class="flex flex-wrap items-baseline gap-x-1.5">
              <span
                class="truncate leading-5 font-medium"
                :class="!tile.available && 'text-base-content/50'"
              >
                {{ tile.name }}
              </span>
              <span
                v-if="tile.available && loading"
                class="loading loading-dots loading-xs"
              />
              <span
                v-else
                class="truncate text-xs leading-4 tabular-nums"
                :class="tile.available ? 'text-base-content/60' : 'text-base-content/40'"
              >
                {{ tile.status }}
              </span>
            </span>
            <span
              class="text-xs leading-4"
              :class="tile.available ? 'text-base-content/50' : 'text-base-content/40'"
            >
              {{ tile.requirement }}
            </span>
          </span>
        </component>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import CountryFlag from '@/components/common/CountryFlag.vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const RELEASES_PAGE = 'https://github.com/timeflysoon/Open-Box/releases/latest'
const RELEASES_API = 'https://api.github.com/repos/timeflysoon/Open-Box/releases?per_page=30'
const CACHE_KEY = 'cache/client-downloads'
const CACHE_TTL = 10 * 60 * 1000
const FETCH_TIMEOUT = 10 * 1000

// 安装包文件名 → 平台;和发布流程里的命名对应
const PATTERNS: Record<string, RegExp> = {
  android: /^open-box-android-(\d+(?:\.\d+){2,3})\.apk$/,
  macos: /^open-box-macos-(\d+(?:\.\d+){2,3})-arm64\.dmg$/,
  windows: /^open-box-windows-(\d+(?:\.\d+){2,3})-x64-setup\.exe$/,
  linux: /^open-box-desktop-linux-(\d+(?:\.\d+){2,3})-amd64\.deb$/,
}

interface Release {
  version: string
  name: string
  url: string
}

interface Platform {
  key: string
  name: string
  icon: string
  release?: string
  requires?: string
  // 内置图标:main 的 brands.ts 里没有这几个品牌,就直接画在卡片里
  svg?: string
}

const SVG_ANDROID =
  '<svg width="32" height="32" viewBox="0 0 24 24"><path fill="none" stroke="#3DDC84" stroke-width="1.2" stroke-linecap="round" d="M7.5 6.5 9 9M16.5 6.5 15 9"/><path fill="#3DDC84" d="M2.5 19a9.5 9.5 0 0 1 19 0z"/><circle cx="8.3" cy="15" r="1" fill="#fff"/><circle cx="15.7" cy="15" r="1" fill="#fff"/></svg>'
const SVG_LINUX =
  '<svg width="32" height="32" viewBox="0 0 24 24"><ellipse cx="5.6" cy="14.5" rx="1.6" ry="4.2" fill="#1c1c1c" transform="rotate(14 5.6 14.5)"/><ellipse cx="18.4" cy="14.5" rx="1.6" ry="4.2" fill="#1c1c1c" transform="rotate(-14 18.4 14.5)"/><ellipse cx="12" cy="14" rx="6.3" ry="8" fill="#1c1c1c"/><ellipse cx="12" cy="7.4" rx="3.9" ry="4.4" fill="#1c1c1c"/><ellipse cx="12" cy="15.4" rx="3.9" ry="5.4" fill="#fff"/><ellipse cx="10.5" cy="6.6" rx="1.1" ry="1.3" fill="#fff"/><ellipse cx="13.5" cy="6.6" rx="1.1" ry="1.3" fill="#fff"/><circle cx="10.7" cy="6.8" r=".5" fill="#1c1c1c"/><circle cx="13.3" cy="6.8" r=".5" fill="#1c1c1c"/><ellipse cx="12" cy="9" rx="1.9" ry="1" fill="#F8BF11"/><ellipse cx="8.2" cy="21.4" rx="3" ry="1.3" fill="#F8BF11"/><ellipse cx="15.8" cy="21.4" rx="3" ry="1.3" fill="#F8BF11"/></svg>'
const SVG_HARMONY =
  '<svg width="32" height="32" viewBox="0 0 24 24"><circle cx="12" cy="10.5" r="7.5" fill="none" stroke="#6B7280" stroke-width="2.6"/><rect x="6.5" y="20.2" width="11" height="2.2" rx="1.1" fill="#6B7280"/></svg>'

const PLATFORMS: Platform[] = [
  { key: 'android', name: 'Android', icon: 'brand:android', svg: SVG_ANDROID, release: 'android', requires: 'clientDownloadReqAndroid' },
  { key: 'macos', name: 'macOS', icon: 'brand:apple-mono', release: 'macos', requires: 'clientDownloadReqMacos' },
  { key: 'windows', name: 'Windows', icon: 'brand:windows', release: 'windows', requires: 'clientDownloadReqWindows' },
  { key: 'linux', name: 'Linux', icon: 'brand:linux-color', svg: SVG_LINUX, release: 'linux', requires: 'clientDownloadReqLinux' },
  { key: 'ios', name: 'iOS', icon: 'brand:apple-mono' },
  { key: 'harmonyos', name: 'HarmonyOS', icon: 'brand:harmonyos', svg: SVG_HARMONY },
]

const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

const parseReleases = (data: unknown): Record<string, Release> => {
  const out: Record<string, Release> = {}
  if (!Array.isArray(data)) return out
  for (const rel of data) {
    if (!rel || rel.draft || rel.prerelease || !Array.isArray(rel.assets)) continue
    for (const asset of rel.assets) {
      const name = typeof asset?.name === 'string' ? asset.name : ''
      const url = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : ''
      if (!url.startsWith('https://github.com/')) continue
      for (const key of Object.keys(PATTERNS)) {
        const version = PATTERNS[key].exec(name)?.[1]
        const cur = out[key]
        if (version && (!cur || compareVersions(cur.version, version) < 0)) {
          out[key] = { version, name, url }
        }
      }
    }
  }
  return out
}

const loadReleases = async (): Promise<Record<string, Release>> => {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (cached?.downloads && Date.now() - Number(cached.at) < CACHE_TTL) return cached.downloads
  } catch {
    // 缓存坏了就重新取
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(RELEASES_API, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const downloads = parseReleases(await res.json())
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), downloads }))
    } catch {
      // 存不了就算了
    }
    return downloads
  } finally {
    clearTimeout(timer)
  }
}

const loading = ref(true)
const releases = ref<Record<string, Release>>({})

const tiles = computed(() =>
  PLATFORMS.map((p) => {
    const available = !!p.release
    const r = p.release ? releases.value[p.release] : undefined
    return {
      ...p,
      available,
      attrs: available
        ? { href: r?.url || RELEASES_PAGE, target: '_blank', rel: 'noopener noreferrer' }
        : { 'aria-disabled': 'true' },
      requirement: available && p.requires ? t(p.requires) : t('clientDownloadReqPending'),
      status: available
        ? r
          ? `v${r.version}`
          : t('clientDownloadLatest')
        : t('clientDownloadComingSoon'),
      hint: available
        ? r
          ? t('clientDownloadFromGithub', { name: r.name })
          : t('clientDownloadOpenReleases')
        : t('clientDownloadComingSoon'),
    }
  }),
)

onMounted(async () => {
  try {
    releases.value = await loadReleases()
  } catch {
    // 取不到就停在「最新版」,点开去 GitHub 发布页
  } finally {
    loading.value = false
  }
})
</script>
