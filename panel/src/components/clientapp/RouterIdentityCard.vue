<template>
  <!-- 路由器标识:图标 + 名称 + 地区,一行排开,改完自动保存(没有保存按钮) -->
  <div class="card">
    <div class="app-card-inset flex flex-col gap-3">
      <span class="text-base font-semibold">{{ $t('clientAppServerInfoTitle') }}</span>
      <p class="text-base-content/60 text-xs">{{ $t('clientAppServerInfoHint') }}</p>

      <div class="flex flex-wrap items-end gap-2">
        <div class="flex min-w-[14rem] flex-1 items-end gap-2">
          <div class="flex w-28 shrink-0 flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppServerIcon') }}</label>
            <CountrySelect
              :model-value="form.icon"
              clearable
              globes
              brands
              icon-only
              :placeholder="$t('clientAppServerIconDefault')"
              :placeholder-flag="defaultIcon"
              @update:model-value="onIcon"
            />
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <label class="text-xs font-medium">{{ $t('clientAppServerName') }}</label>
            <input
              v-model="form.name"
              type="text"
              class="input input-sm w-full min-w-0"
              :maxlength="SERVER_INFO_NAME_MAX"
              @change="save"
            />
          </div>
        </div>
        <div class="flex w-full flex-col gap-1 md:w-52">
          <label class="text-xs font-medium">{{ $t('clientAppServerRegion') }}</label>
          <CountrySelect
            :model-value="form.region"
            clearable
            :placeholder="regionPlaceholder"
            :placeholder-flag="detected"
            @update:model-value="onRegion"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  detectEgressCountry,
  saveServerInfo,
  SERVER_INFO_NAME_MAX,
  type OpenboxClientAppInfo,
} from '@/api/clientApp'
import CountrySelect from '@/components/common/CountrySelect.vue'
import { findBrand } from '@/constant/brands'
import { countryName, findCountry } from '@/constant/countries'
import { showNotification } from '@/helper/notification'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ info: OpenboxClientAppInfo }>()
const { t, locale } = useI18n()

const DAY = 24 * 3600 * 1000
const DEFAULT_ICONS = ['brand:openbox', 'brand:openbox-light']

const defaultName = computed(() => props.info.serverInfoDefaults.name || 'Open-Box')
// 没选图标时 App 画 Open-Box 标志;占位处也显示它(main 里没有这个品牌图标就不显示)
const defaultIcon = findBrand('brand:openbox') ? 'brand:openbox' : ''

const form = reactive({
  name: props.info.serverInfo.name || defaultName.value,
  icon: props.info.serverInfo.icon || '',
  region: props.info.serverInfo.region || '',
})

// 最近一次保存成功的值:保存失败时退回它;iconSvg 只在图标没换时沿用
let last = { ...form }
let lastSvg = props.info.serverInfo.iconSvg ?? ''

const detected = ref(props.info.egressCountry?.country || '')
const detecting = ref(false)

const countryLabel = (code: string) => {
  const c = findCountry(code)
  return c ? countryName(c, locale.value) : code
}

const regionPlaceholder = computed(() => {
  if (detecting.value) return t('clientAppServerRegionAutoDetecting')
  if (detected.value) return t('clientAppServerRegionAutoDetected', { name: countryLabel(detected.value) })
  return t('clientAppServerRegionAuto')
})

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const detect = async (force: boolean) => {
  const known = props.info.egressCountry
  if (!force && known && Date.now() - known.at < DAY) return
  detecting.value = true
  try {
    const r = await detectEgressCountry()
    if (r.country) detected.value = r.country
  } catch {
    // 判不出来就继续显示「自动(按出口 IP)」
  } finally {
    detecting.value = false
  }
}

let chain: Promise<void> = Promise.resolve()

const doSave = async () => {
  const name = form.name.trim() || defaultName.value
  form.name = name
  const icon = form.icon.trim()
  const region = form.region.trim().toUpperCase()
  const svg = icon && icon === last.icon ? lastSvg : ''
  try {
    await saveServerInfo({
      name: name === defaultName.value ? '' : name,
      icon,
      iconSvg: svg,
      region,
    })
    last = { name, icon, region }
    lastSvg = svg
    showNotification({ content: 'clientAppServerInfoSaved', type: 'alert-success' })
    if (!region && !detected.value) void detect(true)
  } catch (error) {
    Object.assign(form, last)
    showNotification({
      content: 'saveFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
  }
}

const save = () => {
  chain = chain.then(doSave)
}

const onIcon = (value: string) => {
  form.icon = DEFAULT_ICONS.includes(value) ? '' : value
  save()
}

const onRegion = (value: string) => {
  form.region = value
  save()
}

onMounted(() => {
  if (!form.region) void detect(false)
})
</script>
