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
                class="truncate text-sm leading-5 font-medium"
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
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="#34A853" d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/></svg>'
const SVG_LINUX =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 256 295"><defs><linearGradient x1="53.4670683%" y1="48.9213861%" x2="38.9488708%" y2="98.0999776%" id="tux-a"><stop stop-color="#FFA63F" offset="0%"></stop><stop stop-color="#FFFF00" offset="100%"></stop></linearGradient><linearGradient x1="30.580815%" y1="34.0241079%" x2="65.8867024%" y2="89.175349%" id="tux-b"><stop stop-color="#FFA63F" offset="0%"></stop><stop stop-color="#FFFF00" offset="100%"></stop></linearGradient><linearGradient x1="49.7328042%" y1="17.6085216%" x2="50.5582487%" y2="99.3854667%" id="tux-c"><stop stop-color="#FFA63F" offset="0%"></stop><stop stop-color="#FFFF00" offset="100%"></stop></linearGradient></defs><g fill="none" transform="translate(10 0)"><path d="M53.2125821,215.473804 C41.8258117,199.128278 39.6219206,145.867578 66.160442,113.084699 C79.2919595,97.3819748 82.6896249,86.4543483 83.6997416,71.6699125 C84.434372,54.8652433 71.8538272,4.81855066 119.237485,1.05357012 C167.263944,-2.80323922 164.600909,44.5804184 164.325423,69.6496791 C164.141765,90.7703016 179.844489,102.799874 190.680286,119.329056 C210.607135,149.632558 208.954216,201.791313 186.915306,230.074582 C158.999353,265.428667 135.123866,250.093259 119.237485,251.378862 C89.4849556,253.123609 88.4748389,268.918162 53.2125821,215.473804 L53.2125821,215.473804 Z" fill="#000000"/><path d="M169.10052,122.451235 C177.365111,130.073025 198.76122,164.141508 164.876395,185.445788 C152.938652,192.88392 175.528535,221.167189 186.364333,207.484699 C205.556551,182.874582 193.343321,143.571858 181.772893,129.522053 C174.059275,119.604543 162.121532,115.747734 169.10052,122.451235 L169.10052,122.451235 Z" fill="#FFFFFF"/><path d="M166.8048,117.859796 C180.395461,128.879251 205.097407,167.447344 169.008691,192.608434 C157.162777,200.413881 179.477174,225.115827 192.057718,212.535282 C235.676395,168.641119 190.955773,118.227111 175.528535,100.871469 C161.754216,85.719718 149.540987,104.360963 166.8048,117.859796 L166.8048,117.859796 Z" stroke="#000000" stroke-width="0.9773" fill="#000000"/><path d="M107.483399,54.9570721 C107.942543,63.1298347 104.085734,70.0169942 98.7596638,70.2924806 C93.4335938,70.567967 88.7503253,64.2317802 88.2911813,56.0590176 L88.2911813,56.0590176 C87.8320374,47.8862549 91.6888467,40.9990954 97.0149167,40.723609 C102.340987,40.4481226 107.024255,46.7843094 107.483399,54.9570721 L107.483399,54.9570721 L107.483399,54.9570721 Z" fill="#FFFFFF"/><path d="M117.125423,55.5998736 C117.30908,65.0582394 123.461609,72.5882005 130.807913,72.4045429 C138.154216,72.2208853 143.93943,64.4154378 143.755773,54.8652433 L143.755773,54.8652433 C143.572115,45.4068775 137.419586,37.8769164 130.073282,38.060574 C122.726979,38.2442316 116.849936,46.1415079 117.125423,55.5998736 L117.125423,55.5998736 L117.125423,55.5998736 Z" fill="#FFFFFF"/><path d="M123.186123,57.7119359 C123.094294,62.9461771 125.6655,67.1703016 129.063166,67.1703016 C132.369002,67.1703016 135.215695,62.9461771 135.307524,57.8037647 L135.307524,57.8037647 C135.399353,52.5695234 132.828146,48.3453989 129.430481,48.3453989 C126.032816,48.3453989 123.277952,52.5695234 123.186123,57.7119359 L123.186123,57.7119359 L123.186123,57.7119359 Z" fill="#000000"/><path d="M101.973672,57.8037647 C102.432816,62.119718 100.779897,65.7928697 98.3923486,66.1601849 C96.0048,66.4356713 93.7090802,63.2216635 93.2499362,58.9057102 L93.2499362,58.9057102 C92.7907922,54.5897569 94.4437105,50.9166051 96.8312591,50.54929 C99.2188078,50.2738036 101.514528,53.4878114 101.973672,57.8037647 L101.973672,57.8037647 L101.973672,57.8037647 Z" fill="#000000"/><path d="M71.0273681,145.68392 C77.5472125,130.899485 91.4133603,104.911936 91.6888467,84.80143 C91.6888467,68.8232199 139.531648,64.9664106 143.388458,80.9446207 C147.245267,96.9228308 156.979119,120.798317 163.223477,132.368745 C169.467835,143.847344 187.558107,180.487033 168.274061,212.443453 C150.918419,240.726722 98.3005198,263.132948 70.2009089,208.586644 C60.6507144,189.669913 62.3954615,166.25357 71.0273681,145.68392 L71.0273681,145.68392 Z" fill="#FFFFFF"/><path d="M65.1503253,134.664465 C59.5487689,145.224776 47.9783409,172.957072 76.2616093,188.108823 C106.65694,204.270691 106.565111,237.420885 70.0172514,221.626333 C36.5915704,207.39287 51.3760062,149.724387 60.7425432,135.950068 C66.8032436,126.308045 75.986123,114.46213 65.1503253,134.664465 L65.1503253,134.664465 Z" fill="#FFFFFF"/><path d="M69.9254226,122.726722 C61.0180296,137.235671 39.7137494,171.395983 68.2725043,189.210769 C106.65694,212.810769 95.8211424,236.31894 60.7425432,215.106488 C11.3386521,185.537617 54.7736716,125.848901 74.5168623,103.07536 C97.1067455,77.5469553 78.8328156,107.758628 69.9254226,122.726722 L69.9254226,122.726722 Z" stroke="#000000" stroke-width="1.25" fill="#000000"/><path d="M51.8351502,258.541508 C31.2655004,247.613881 1.42114241,260.65357 12.2569401,231.084699 C14.4608311,224.381197 9.0429323,214.280029 12.5324265,207.760185 C16.6647222,199.77108 25.5721152,201.515827 30.8981852,196.189757 C36.1324265,190.680029 39.438263,181.129835 49.263944,182.599095 C58.9977961,184.068356 65.5176405,196.006099 72.3129712,210.698706 C77.3635549,221.167189 95.1783409,235.951625 93.9845665,247.70571 C92.5153058,265.704154 72.0374848,269.101819 51.8351502,258.541508 L51.8351502,258.541508 Z" stroke="#E68C3F" stroke-width="6.25" fill="url(#tux-a)"/><path d="M201.607913,189.11894 C198.485734,194.995983 185.446045,204.454348 176.72231,201.974971 C167.906746,199.587422 163.866279,186.180418 165.611026,175.987422 C167.263944,164.600652 176.72231,163.95785 188.660053,169.651235 C201.516084,175.987422 205.372893,181.313492 201.607913,189.11894 L201.607913,189.11894 Z" fill="#FFFFFF"/><path d="M194.445267,253.490924 C209.505189,235.216994 243.022699,238.981975 220.432816,213.912714 C215.657718,208.494815 217.126979,196.924387 211.249936,191.965632 C204.362777,185.904932 196.740987,190.863687 189.761998,187.741508 C182.78301,184.343842 175.436707,177.823998 166.896629,182.415438 C158.356551,187.098706 157.438263,199.220107 156.611804,215.198317 C155.877174,226.676916 145.408691,245.869134 151.010247,256.429446 C159.091181,272.774971 180.119975,270.57108 194.445267,253.490924 L194.445267,253.490924 Z" stroke="#E68C3F" stroke-width="6.2507" fill="url(#tux-b)"/><path d="M199.587679,188.843453 C196.832816,193.618551 185.629703,201.148512 178.19157,199.128278 C170.569781,197.199874 167.080286,186.455905 168.641376,178.374971 C170.018808,169.192092 178.19157,168.732948 188.476395,173.324387 C199.404022,178.283142 202.801687,182.507267 199.587679,188.843453 L199.587679,188.843453 Z" fill="#000000"/><path d="M97.1067455,66.3438425 C100.779897,62.9461771 109.68729,52.5695234 126.583788,63.4053211 C129.705967,65.4255546 132.277174,65.6092121 138.246045,68.1804184 C150.275617,73.1391732 144.582232,85.0769164 131.726201,89.1173833 C126.216473,90.8621304 121.257718,97.5656324 111.340209,96.9228308 C102.800131,96.4636868 100.59624,90.8621304 95.3619984,87.8317802 C86.0872903,82.597539 84.7098584,75.5267219 89.760442,71.7617413 C94.8110257,67.9967608 96.7394304,66.6193289 97.1067455,66.3438425 L97.1067455,66.3438425 Z" stroke="#E68C3F" stroke-width="3.75" fill="url(#tux-c)"/><path d="M138.429703,75.9858658 C133.379119,76.2613522 122.451493,87.1889787 110.972893,87.1889787 C99.4942942,87.1889787 92.6071346,76.5368386 90.8623875,76.5368386" stroke="#E68C3F" stroke-width="2.5"/></g></svg>'
const SVG_HARMONY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M2.758 9.242a9.242 9.242 0 1 0 18.485 0a9.242 9.242 0 1 0-18.485 0ZM5.485 9.242a6.515 6.515 0 1 0 13.03 0a6.515 6.515 0 1 0-13.03 0Z"/><path fill="#306FF6" d="M5.818 21.394h12.364V24H5.818Z"/></svg>'

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
