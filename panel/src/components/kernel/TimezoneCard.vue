<template>
  <div class="card bg-base-100 border-base-300/60 border">
    <div class="card-body gap-3 p-4">
      <div>
        <h2 class="text-base font-semibold">{{ $t('timezoneTitle') }}</h2>
        <p class="text-base-content/60 text-xs">{{ $t('timezoneDescription') }}</p>
      </div>

      <span
        v-if="loading"
        class="loading loading-spinner loading-xs"
      />
      <template v-else-if="state">
        <!-- 一个下拉:点开有搜索框,选中即生效。外框宽度、触发框高度与字号和 v0.1.337 一致
             (max-w-sm、input-sm、font-mono text-xs;保存中的转圈放在框外右侧) -->
        <div class="flex flex-wrap items-center gap-2">
          <div
            ref="rootEl"
            class="relative w-full max-w-sm"
          >
            <button
              type="button"
              class="input input-sm hover:border-base-content/30 flex w-full cursor-pointer items-center gap-1.5 font-mono text-xs"
              :disabled="saving"
              :aria-expanded="open"
              @click="toggle"
            >
              <span
                class="min-w-0 flex-1 truncate text-left"
                :class="{ 'text-base-content/40': !state.zone }"
              >{{ state.zone || $t('timezoneUnknown') }}</span>
              <span
                v-if="state.offset"
                class="text-base-content/50 shrink-0"
              >UTC{{ state.offset }}</span>
              <ChevronDownIcon class="text-base-content/40 h-3.5 w-3.5 shrink-0" />
            </button>
            <div
              v-if="open"
              class="bg-base-100 border-base-300 absolute z-30 mt-1 w-full overflow-hidden rounded-2xl border shadow-lg"
            >
              <div class="p-2">
                <input
                  ref="searchEl"
                  v-model.trim="keyword"
                  type="search"
                  class="input input-sm w-full"
                  :placeholder="$t('timezoneSearch')"
                  @keydown.esc="open = false"
                />
              </div>
              <ul class="max-h-64 overflow-y-auto pb-1">
                <li
                  v-for="zone in filtered"
                  :key="zone"
                >
                  <button
                    type="button"
                    class="hover:bg-base-200 flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm"
                    :class="{ 'bg-base-200 font-medium': zone === state.zone }"
                    @click="pick(zone)"
                  >
                    <span class="truncate">{{ label(zone) }}</span>
                    <span class="text-base-content/50 shrink-0 font-mono text-xs">{{ zoneOffset(zone) }}</span>
                  </button>
                </li>
                <li
                  v-if="!filtered.length"
                  class="text-base-content/50 px-3 py-2 text-xs"
                >
                  {{ $t('timezoneNoMatch') }}
                </li>
              </ul>
            </div>
          </div>
          <span
            v-if="saving"
            class="loading loading-spinner loading-xs"
          />
        </div>
        <p
          v-if="state.local"
          class="text-base-content/60 text-xs"
        >
          {{ $t('timezoneNow', { time: localTime, offset: state.offset }) }}
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchTimezone, saveTimezone, type OpenboxTimezoneState } from '@/api/openbox'
import { showNotification } from '@/helper/notification'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const state = ref<OpenboxTimezoneState | null>(null)
const loading = ref(true)
const saving = ref(false)
const open = ref(false)
const keyword = ref('')
const rootEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)

// 国家 / 地区名按浏览器语言显示,只用来在下拉里标注和搜索
const regionNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'region' })
  } catch {
    return null
  }
})()
const countryName = (zone: string) => {
  const code = state.value?.countries?.[zone]
  if (!code) return ''
  try {
    return regionNames?.of(code) || code
  } catch {
    return code
  }
}
const label = (zone: string) => {
  const country = countryName(zone)
  return country ? `${zone} · ${country}` : zone
}

// 每个时区现在的 UTC 偏移(带夏令时),只用浏览器自带的时区库算
const offsetCache = new Map<string, string>()
const zoneOffset = (zone: string) => {
  const cached = offsetCache.get(zone)
  if (cached !== undefined) return cached
  let text = ''
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset' as 'long',
    }).formatToParts(new Date())
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
    text = name === 'GMT' ? 'UTC+00:00' : name.replace('GMT', 'UTC')
  } catch {
    text = ''
  }
  offsetCache.set(zone, text)
  return text
}

const filtered = computed(() => {
  const zones = state.value?.zones ?? []
  const query = keyword.value.toLowerCase()
  if (!query) return zones
  return zones.filter((zone) => {
    const text = `${label(zone)} ${zoneOffset(zone)}`.toLowerCase()
    return text.includes(query) || text.replace(/_/g, ' ').includes(query)
  })
})

// 路由器时间不显示秒
const localTime = computed(() => (state.value?.local ?? '').replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}$/, '$1'))

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const toggle = async () => {
  open.value = !open.value
  if (open.value) {
    keyword.value = ''
    await nextTick()
    searchEl.value?.focus()
  }
}

const save = async (zone: string) => {
  saving.value = true
  try {
    const next = await saveTimezone(zone)
    state.value = next
    showNotification({ content: 'timezoneSaved', params: { zone: next.zone, offset: next.offset }, type: 'alert-success' })
  } catch (error) {
    showNotification({ content: 'timezoneSaveFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    saving.value = false
  }
}

// 选中即生效;选的就是当前时区时只收起
const pick = (zone: string) => {
  open.value = false
  if (zone && zone !== state.value?.zone) void save(zone)
}

const onDocumentClick = (event: MouseEvent) => {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) open.value = false
}

onMounted(async () => {
  document.addEventListener('click', onDocumentClick)
  try {
    state.value = await fetchTimezone()
  } catch (error) {
    showNotification({ content: 'timezoneLoadFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>
