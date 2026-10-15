<template>
  <!-- 地区组编辑弹窗:名称与地区 / 规则 / DNS 三个页签 -->
  <DialogWrapper
    v-model="isOpen"
    :title="$t(group ? 'clientAppEditGroup' : 'clientAppAddGroupTitle')"
    box-class="h-[90dvh] w-full max-w-4xl"
  >
    <div
      v-if="form"
      class="flex flex-col gap-4 text-sm"
    >
      <div
        role="tablist"
        class="tabs-box tabs tabs-xs w-fit"
      >
        <a
          v-for="item in TABS"
          :key="item.key"
          role="tab"
          class="tab"
          :class="tab === item.key && 'tab-active'"
          @click="tab = item.key"
        >
          {{ $t(item.label) }}
        </a>
      </div>

      <!-- 名称与地区 -->
      <div
        v-show="tab === 'name'"
        class="flex flex-col gap-4"
      >
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppGroupName') }}</label>
          <input
            v-model="form.name"
            type="text"
            class="input input-sm w-full"
            :maxlength="SHARE_REGION_LIMITS.nameMax"
            :placeholder="$t('clientAppGroupNamePlaceholder')"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppGroupDesc') }}</label>
          <textarea
            v-model="form.description"
            rows="2"
            class="textarea textarea-sm w-full"
            :maxlength="SHARE_REGION_LIMITS.descriptionMax"
            :placeholder="$t('clientAppGroupDescPlaceholder')"
          />
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <label class="text-xs font-medium">{{ $t('clientAppGroupRegions') }}</label>
            <div
              role="tablist"
              class="tabs-box tabs tabs-xs"
            >
              <a
                role="tab"
                class="tab"
                :class="form.regionMatch === 'inside' && 'tab-active'"
                @click="form.regionMatch = 'inside'"
              >
                {{ $t('clientAppMatchInside') }}
              </a>
              <a
                role="tab"
                class="tab"
                :class="form.regionMatch === 'outside' && 'tab-active'"
                @click="form.regionMatch = 'outside'"
              >
                {{ $t('clientAppMatchOutside') }}
              </a>
            </div>
            <div class="ml-auto w-40">
              <CountrySelect
                model-value=""
                :placeholder="$t('clientAppAddRegion')"
                @update:model-value="addRegion"
              />
            </div>
          </div>
          <div class="border-base-content/10 flex max-h-48 min-h-11 flex-wrap content-start items-center gap-1.5 overflow-y-auto rounded-lg border p-2">
            <p
              v-if="!form.regions.length"
              class="text-base-content/50 w-full text-center text-xs"
            >
              {{ $t('clientAppNoRegion') }}
            </p>
            <span
              v-for="c in form.regions"
              :key="c"
              class="badge badge-outline gap-1 pr-1"
              :title="c"
            >
              <CountryFlag
                :code="c"
                :size="14"
              />
              <span>{{ regionName(c) }}</span>
              <button
                type="button"
                class="hover:text-error rounded-full p-0.5"
                :aria-label="$t('delete')"
                @click="removeRegion(c)"
              >
                <XMarkIcon class="h-3 w-3" />
              </button>
            </span>
          </div>
          <p class="text-base-content/50 text-xs">
            {{ $t(form.regionMatch === 'outside' ? 'clientAppRegionsHintOutside' : 'clientAppRegionsHintInside') }}
          </p>
        </div>

        <div class="flex flex-col gap-1">
          <label class="flex w-fit cursor-pointer items-center gap-3">
            <input
              v-model="form.isDefault"
              type="checkbox"
              class="toggle toggle-sm"
              :disabled="group?.default === true"
            />
            <span>{{ $t('clientAppGroupDefault') }}</span>
          </label>
          <p class="text-base-content/50 text-xs">{{ $t('clientAppDefaultUseHint') }}</p>
        </div>
      </div>

      <!-- 规则 -->
      <div
        v-show="tab === 'rules'"
        class="flex flex-col gap-3"
      >
        <div class="flex items-center justify-between gap-2">
          <p class="text-base-content/60 text-xs">
            {{ $t(form.rules.length || lanSubnets.length ? 'clientAppRulesHint' : 'clientAppNoRules') }}
          </p>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            :disabled="form.rules.length >= SHARE_REGION_LIMITS.rulesPerGroup"
            @click="addRule"
          >
            <PlusIcon class="h-3.5 w-3.5" />
            {{ $t('clientAppAddRule') }}
          </button>
        </div>

        <!-- 路由器自动加的「家里局域网 → 回路由器」,只读 -->
        <div
          v-for="subnet in lanSubnets"
          :key="subnet"
          class="flex flex-wrap items-center gap-2 sm:flex-nowrap"
        >
          <InformationCircleIcon
            v-tip="$t('clientAppLanRuleTip')"
            class="text-base-content/40 h-4 w-4 shrink-0 outline-none"
          />
          <select
            class="select select-sm w-36"
            disabled
          >
            <option>ipcidr</option>
          </select>
          <input
            :value="subnet"
            type="text"
            class="input input-sm min-w-0 flex-1 font-mono text-xs"
            disabled
          />
          <select
            class="select select-sm w-32"
            disabled
          >
            <option>{{ $t('clientAppActionProxy') }}</option>
          </select>
          <span class="w-8 shrink-0" />
        </div>

        <div
          v-for="(r, ri) in form.rules"
          :key="ri"
          class="flex flex-wrap items-center gap-2 sm:flex-nowrap"
        >
          <select
            v-model="r.type"
            class="select select-sm w-36 shrink-0"
          >
            <option
              v-for="rt in SHARE_REGION_RULE_TYPES"
              :key="rt"
              :value="rt"
            >
              {{ rt }}
            </option>
          </select>
          <input
            v-model="r.value"
            type="text"
            class="input input-sm min-w-0 flex-1 font-mono text-xs"
            :placeholder="$t('clientAppRuleValue')"
          />
          <select
            v-model="r.action"
            class="select select-sm w-32 shrink-0"
          >
            <option value="direct">{{ $t('clientAppActionDirect') }}</option>
            <option value="proxy">{{ $t('clientAppActionProxy') }}</option>
          </select>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm hover:text-error"
            :aria-label="$t('delete')"
            @click="form.rules.splice(ri, 1)"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppCatchAll') }}</label>
          <select
            v-model="form.catchAll"
            class="select select-sm w-full md:w-1/2"
          >
            <option value="direct">{{ $t('clientAppActionDirect') }}</option>
            <option value="proxy">{{ $t('clientAppActionProxy') }}</option>
          </select>
        </div>
      </div>

      <!-- DNS:直连 / 代理各一条主上游 + 备用 -->
      <div
        v-show="tab === 'dns'"
        class="flex flex-col gap-3"
      >
        <div
          v-for="side in SIDES"
          :key="side"
          class="flex flex-col gap-1"
        >
          <span class="text-base-content/60 text-xs">
            {{ $t(side === 'direct' ? 'clientAppDnsDirect' : 'clientAppDnsProxy') }}
          </span>
          <div class="flex flex-wrap items-center gap-1">
            <input
              :value="main(side).server"
              type="text"
              class="input input-sm min-w-0 flex-1 font-mono text-xs"
              :placeholder="$t('clientAppDnsServerPlaceholder')"
              @input="setMain(side, 'server', ($event.target as HTMLInputElement).value)"
            />
            <select
              class="select select-sm w-20"
              :value="main(side).protocol"
              :disabled="main(side).server === 'wan'"
              @change="setMain(side, 'protocol', ($event.target as HTMLSelectElement).value)"
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
            </select>
            <input
              :value="main(side).port"
              type="number"
              min="1"
              max="65535"
              class="input input-sm w-24"
              :disabled="main(side).server === 'wan'"
              @input="setMain(side, 'port', Number(($event.target as HTMLInputElement).value))"
            />
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              @click="addExtra(side)"
            >
              <PlusIcon class="h-3.5 w-3.5" />
              {{ $t('clientAppDnsAddBackup') }}
            </button>
          </div>
          <div
            v-for="(x, xi) in extrasOf(side)"
            :key="xi"
            class="flex flex-wrap items-center gap-1 pl-4"
          >
            <input
              v-model="x.server"
              type="text"
              class="input input-sm min-w-0 flex-1 font-mono text-xs"
              :placeholder="$t('clientAppDnsServerPlaceholder')"
            />
            <select
              v-model="x.protocol"
              class="select select-sm w-20"
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
            </select>
            <input
              v-model.number="x.port"
              type="number"
              min="1"
              max="65535"
              class="input input-sm w-24"
            />
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm"
              @click="extrasOf(side).splice(xi, 1)"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          </div>
        </div>
        <p class="text-base-content/50 text-xs">{{ $t('clientAppDnsHint') }}</p>
      </div>

    </div>

    <!-- 底栏:取消 / 保存固定在内容区下面,与 v0.1.331 一致 -->
    <template #footer>
      <button
        type="button"
        class="btn btn-sm"
        @click="isOpen = false"
      >
        {{ $t('cancel') }}
      </button>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="saving"
        @click="submit"
      >
        <span
          v-if="saving"
          class="loading loading-spinner loading-xs"
        />
        {{ $t('save') }}
      </button>
    </template>
  </DialogWrapper>
</template>

<script setup lang="ts">
import {
  SHARE_REGION_LIMITS,
  SHARE_REGION_RULE_TYPES,
  type OpenboxShareDnsUpstream,
  type OpenboxShareGroupDns,
  type OpenboxShareRegionGroup,
  type OpenboxShareRule,
} from '@/api/clientApp'
import CountryFlag from '@/components/common/CountryFlag.vue'
import CountrySelect from '@/components/common/CountrySelect.vue'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { countryName, findCountry } from '@/constant/countries'
import { showNotification } from '@/helper/notification'
import {
  InformationCircleIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

type Side = 'direct' | 'proxy'
type Tab = 'name' | 'rules' | 'dns'
type Form = {
  id: string
  name: string
  description: string
  regions: string[]
  regionMatch: 'inside' | 'outside'
  isDefault: boolean
  rules: OpenboxShareRule[]
  catchAll: 'direct' | 'proxy'
  dns: OpenboxShareGroupDns
}

const props = defineProps<{
  modelValue: boolean
  // null = 新建
  group: OpenboxShareRegionGroup | null
  groups: OpenboxShareRegionGroup[]
  defaults: OpenboxShareRegionGroup[]
  lanSubnets: string[]
  saving: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [group: OpenboxShareRegionGroup]
}>()

const { locale } = useI18n()

const isOpen = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const SIDES: Side[] = ['direct', 'proxy']
const TABS: { key: Tab; label: string }[] = [
  { key: 'name', label: 'clientAppTabBasic' },
  { key: 'rules', label: 'clientAppTabRules' },
  { key: 'dns', label: 'clientAppTabDns' },
]

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const form = ref<Form | null>(null)
const tab = ref<Tab>('name')

const newId = () => {
  const used = new Set(props.groups.map((g) => g.id))
  for (;;) {
    const id = `g${Math.random().toString(36).slice(2, 8)}`
    if (!used.has(id)) return id
  }
}

// 新建时 DNS 先抄默认「其他地区」那一组(两侧都是系统 DNS);没有就给个能过校验的
const blankDns = (): OpenboxShareGroupDns => {
  const template = props.defaults.find((g) => g.id === 'other')
  return template
    ? clone(template.dns)
    : {
        direct: 'wan',
        directProtocol: 'udp',
        directPort: 53,
        directExtras: [],
        proxy: 'wan',
        proxyProtocol: 'udp',
        proxyPort: 53,
        proxyExtras: [],
      }
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    tab.value = 'name'
    const g = props.group
    form.value = g
      ? {
          id: g.id,
          name: g.name,
          description: g.description ?? '',
          regions: [...g.regions],
          regionMatch: g.regionMatch === 'outside' ? 'outside' : 'inside',
          isDefault: g.default === true,
          rules: clone(g.rules),
          catchAll: g.catchAll,
          dns: clone(g.dns),
        }
      : {
          id: newId(),
          name: '',
          description: '',
          regions: [],
          regionMatch: 'inside',
          isDefault: false,
          rules: [],
          catchAll: 'direct',
          dns: blankDns(),
        }
  },
  { immediate: true },
)

const regionName = (code: string) => {
  const c = findCountry(code)
  return c ? countryName(c, locale.value) : code
}

const addRegion = (code: string) => {
  const f = form.value
  const upper = String(code || '').trim().toUpperCase()
  if (!f || !upper || f.regions.includes(upper)) return
  f.regions.push(upper)
}

const removeRegion = (code: string) => {
  const f = form.value
  if (f) f.regions = f.regions.filter((c) => c !== code)
}

const addRule = () => {
  form.value?.rules.push({ type: 'domainSuffix', value: '', action: 'proxy' })
}

// ---- DNS ----

const main = (side: Side): OpenboxShareDnsUpstream => {
  const d = form.value!.dns
  return side === 'direct'
    ? { server: d.direct, protocol: d.directProtocol, port: d.directPort }
    : { server: d.proxy, protocol: d.proxyProtocol, port: d.proxyPort }
}

const setMain = (side: Side, key: 'server' | 'protocol' | 'port', value: string | number) => {
  const d = form.value!.dns
  if (key === 'server') {
    const server = String(value).trim()
    if (side === 'direct') d.direct = server
    else d.proxy = server
    // 系统 DNS 固定 UDP 53
    if (server === 'wan') {
      if (side === 'direct') [d.directProtocol, d.directPort] = ['udp', 53]
      else [d.proxyProtocol, d.proxyPort] = ['udp', 53]
    }
  } else if (key === 'protocol') {
    if (side === 'direct') d.directProtocol = String(value)
    else d.proxyProtocol = String(value)
  } else if (side === 'direct') d.directPort = Number(value)
  else d.proxyPort = Number(value)
}

const extrasOf = (side: Side): OpenboxShareDnsUpstream[] =>
  side === 'direct' ? form.value!.dns.directExtras : form.value!.dns.proxyExtras

const addExtra = (side: Side) => {
  extrasOf(side).push({ server: '', protocol: side === 'direct' ? 'udp' : 'tcp', port: 53 })
}

// ---- 提交 ----

const submit = () => {
  const f = form.value
  if (!f) return
  const name = f.name.trim()
  if (!name) {
    tab.value = 'name'
    showNotification({ content: 'clientAppErrName', params: { id: f.id }, type: 'alert-error' })
    return
  }
  if (f.regionMatch === 'outside' && !f.regions.length) {
    tab.value = 'name'
    showNotification({ content: 'clientAppErrOutside', params: { id: f.id }, type: 'alert-error' })
    return
  }
  const group: OpenboxShareRegionGroup = {
    id: f.id,
    name,
    description: f.description.trim(),
    regions: [...f.regions],
    ...(f.regionMatch === 'outside' ? { regionMatch: 'outside' as const } : {}),
    ...(f.isDefault ? { default: true } : {}),
    rules: f.rules
      .map((r) => ({ type: r.type, value: r.value.trim(), action: r.action }))
      .filter((r) => r.value),
    catchAll: f.catchAll,
    dns: {
      ...f.dns,
      directExtras: f.dns.directExtras.filter((x) => x.server.trim()),
      proxyExtras: f.dns.proxyExtras.filter((x) => x.server.trim()),
    },
  }
  emit('saved', group)
}
</script>
