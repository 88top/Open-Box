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
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              :disabled="form.rules.length >= SHARE_REGION_LIMITS.rulesPerGroup"
              @click="showImport = true"
            >
              {{ $t('routingPolicyRuleImport') }}
            </button>
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
        </div>

        <!-- 路由器自动加的「家里局域网 → 经路由器」,只读(规则里已经有同一网段就不重复显示) -->
        <div
          v-for="subnet in lanRows"
          :key="subnet"
          class="flex flex-wrap items-center gap-2 sm:flex-nowrap"
        >
          <LockClosedIcon
            v-tip="$t('clientAppLanRuleTip')"
            class="text-base-content/40 h-4 w-4 shrink-0 outline-none"
          />
          <select
            class="select select-sm w-36 shrink-0 max-sm:w-auto max-sm:min-w-0 max-sm:grow max-sm:basis-[35%]"
            disabled
          >
            <option>{{ $t('routingPolicyIpCidr') }}</option>
          </select>
          <div class="flex min-w-0 flex-1 items-center gap-2 max-sm:order-3 max-sm:grow max-sm:basis-[60%]">
            <input
              :value="subnet"
              type="text"
              class="input input-sm min-w-0 flex-1 font-mono text-xs"
              disabled
            />
          </div>
          <select
            class="select select-sm w-32 shrink-0 max-sm:order-1 max-sm:w-auto max-sm:min-w-0 max-sm:grow max-sm:basis-[40%]"
            disabled
          >
            <option>{{ $t('clientAppActionProxyShort') }}</option>
          </select>
          <span class="w-8 shrink-0 max-sm:order-2" />
        </div>

        <Draggable
          v-if="form.rules.length"
          v-model="form.rules"
          :animation="150"
          :force-fallback="true"
          :fallback-tolerance="5"
          :fallback-on-body="true"
          handle=".drag-handle"
          ghost-class="opacity-40"
          item-key="key"
          class="flex flex-col gap-2"
        >
          <template #item="{ element, index }">
            <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Bars3Icon class="drag-handle text-base-content/40 h-4 w-4 shrink-0 cursor-move" />
              <select
                v-model="element.type"
                class="select select-sm w-36 shrink-0 max-sm:w-auto max-sm:min-w-0 max-sm:grow max-sm:basis-[35%]"
              >
                <option
                  v-for="rt in RULE_TYPES"
                  :key="rt.type"
                  :value="rt.type"
                >
                  {{ $t(rt.labelKey) }}
                </option>
              </select>
              <div class="flex min-w-0 flex-1 items-center gap-2 max-sm:order-3 max-sm:grow max-sm:basis-[60%]">
                <GeoRuleValue
                  v-if="element.type === 'geosite' || element.type === 'geoip'"
                  v-model="element.value"
                  :kind="element.type"
                  :placeholder="$t('routingPolicyRuleGeoPlaceholder')"
                  :exclude="excludeOf(index)"
                />
                <RuleUrlValue
                  v-else-if="element.type === 'ruleUrl'"
                  v-model="element.value"
                  :placeholder="$t('routingPolicyRuleUrlPlaceholder')"
                />
                <input
                  v-else
                  v-model="element.value"
                  type="text"
                  class="input input-sm min-w-0 flex-1 font-mono text-xs"
                  :placeholder="$t(placeholderOf(element.type))"
                  @change="splitRuleRow(index)"
                />
              </div>
              <select
                v-model="element.action"
                class="select select-sm w-32 shrink-0 max-sm:order-1 max-sm:w-auto max-sm:min-w-0 max-sm:grow max-sm:basis-[40%]"
              >
                <option
                  v-for="a in ACTIONS"
                  :key="a.value"
                  :value="a.value"
                >
                  {{ $t(a.labelKey) }}
                </option>
              </select>
              <button
                type="button"
                class="btn btn-ghost btn-square btn-sm hover:text-error max-sm:order-2"
                :aria-label="$t('delete')"
                @click="form.rules.splice(index, 1)"
              >
                <TrashIcon class="h-4 w-4" />
              </button>
            </div>
          </template>
        </Draggable>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('clientAppCatchAll') }}</label>
          <select
            v-model="form.catchAll"
            class="select select-sm w-full md:w-1/2"
          >
            <option
              v-for="a in ACTIONS"
              :key="a.value"
              :value="a.value"
            >
              {{ $t(a.labelKey) }}
            </option>
          </select>
        </div>

        <RuleImportDialog
          v-model="showImport"
          :max="importMax"
          hint-key="clientAppRuleImportHint"
          @import="onImport"
        />
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
  type OpenboxShareDnsUpstream,
  type OpenboxShareGroupDns,
  type OpenboxShareRegionGroup,
  type OpenboxShareRule,
  type OpenboxShareRuleType,
} from '@/api/clientApp'
import RuleImportDialog from '@/components/clientapp/RuleImportDialog.vue'
import CountryFlag from '@/components/common/CountryFlag.vue'
import CountrySelect from '@/components/common/CountrySelect.vue'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import GeoRuleValue from '@/components/routing/GeoRuleValue.vue'
import RuleUrlValue from '@/components/routing/RuleUrlValue.vue'
import { countryName, findCountry } from '@/constant/countries'
import { showNotification } from '@/helper/notification'
import {
  Bars3Icon,
  LockClosedIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Draggable from 'vuedraggable'

type Side = 'direct' | 'proxy'
type Tab = 'name' | 'rules' | 'dns'
// 规则行要一个稳定的 key 给拖动排序用:类型和值都会被改,不能拿它们当 key
type RuleRow = OpenboxShareRule & { key: number }
type Form = {
  id: string
  name: string
  description: string
  regions: string[]
  regionMatch: 'inside' | 'outside'
  isDefault: boolean
  rules: RuleRow[]
  catchAll: 'direct' | 'proxy'
  dns: OpenboxShareGroupDns
}
let ruleKeySeed = 0

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
          rules: clone(g.rules).map((r) => ({ ...r, key: ++ruleKeySeed })),
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

// ---- 规则 ----

const RULE_TYPES: { type: OpenboxShareRuleType; labelKey: string; placeholderKey: string }[] = [
  { type: 'domainSuffix', labelKey: 'routingPolicyDomainSuffix', placeholderKey: 'routingPolicyRuleDomainSuffixPlaceholder' },
  { type: 'domain', labelKey: 'routingPolicyDomain', placeholderKey: 'routingPolicyRuleDomainPlaceholder' },
  { type: 'domainKeyword', labelKey: 'routingPolicyDomainKeyword', placeholderKey: 'routingPolicyRuleDomainKeywordPlaceholder' },
  { type: 'ipcidr', labelKey: 'routingPolicyIpCidr', placeholderKey: 'routingPolicyRuleIpCidrPlaceholder' },
  { type: 'geosite', labelKey: 'routingPolicyGeosite', placeholderKey: 'routingPolicyRuleGeoPlaceholder' },
  { type: 'geoip', labelKey: 'routingPolicyGeoip', placeholderKey: 'routingPolicyRuleGeoPlaceholder' },
  { type: 'ruleUrl', labelKey: 'routingPolicyRuleUrl', placeholderKey: 'routingPolicyRuleUrlPlaceholder' },
]
const ACTIONS: { value: 'direct' | 'proxy'; labelKey: string }[] = [
  { value: 'direct', labelKey: 'clientAppActionDirect' },
  { value: 'proxy', labelKey: 'clientAppActionProxyShort' },
]

const placeholderOf = (type: string) =>
  RULE_TYPES.find((r) => r.type === type)?.placeholderKey || 'routingPolicyRuleDomainPlaceholder'

// 新行沿用上一行的走向
const addRule = () => {
  const f = form.value
  if (!f) return
  const last = f.rules[f.rules.length - 1]
  f.rules.push({ key: ++ruleKeySeed, type: 'domainSuffix', value: '', action: last?.action || 'direct' })
}

// 同一类型里别的行已经选过的值,选择器里不再给
const excludeOf = (index: number) => {
  const rules = form.value?.rules || []
  return rules
    .filter((r, i) => i !== index && r.type === rules[index]?.type)
    .map((r) => r.value)
}

// 在域名 / IP 这几类的值框里粘贴了一串(空格、逗号、顿号隔开),自动拆成一行一个;新行沿用这一行的类型和走向
const SPLIT_PATTERN = /[\s,，;；、]+/
const splitRuleRow = (index: number) => {
  const rules = form.value?.rules
  const row = rules?.[index]
  if (!rules || !row || row.type === 'geosite' || row.type === 'geoip' || row.type === 'ruleUrl') return
  const parts = row.value.split(SPLIT_PATTERN).map((s) => s.trim()).filter(Boolean)
  if (parts.length <= 1) {
    row.value = parts[0] ?? ''
    return
  }
  row.value = parts[0]
  rules.splice(
    index + 1,
    0,
    ...parts.slice(1).map((value) => ({ key: ++ruleKeySeed, type: row.type, value, action: row.action })),
  )
}

// 家里局域网网段:路由器自动加,只读。规则里已经写了同一网段就不重复显示
const normCidr = (raw: string) => {
  const v = raw.trim()
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(v)
  if (!m) return v
  const bits = Number(m[5])
  if (bits > 32) return v
  const ip = (((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0)
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const n = (ip & mask) >>> 0
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${bits}`
}
const lanRows = computed(() => {
  const have = new Set(
    (form.value?.rules || []).filter((r) => r.type === 'ipcidr').map((r) => normCidr(r.value)),
  )
  return (props.lanSubnets || []).filter((s) => !have.has(normCidr(s)))
})

// 规则值校验(和后端 engine/share-regions.mjs 同一套,后端才是权威)
const GEO_RE = /^[a-z0-9!@._-]{1,80}$/
const DOMAIN_RE = /^[A-Za-z0-9*_.-]{1,253}$/
const URL_RE = /^https?:\/\/\S+$/i
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const isIpOrCidr = (raw: string) => {
  const [addr, prefix, ...rest] = raw.split('/')
  if (rest.length) return false
  const v4 = IPV4_RE.test(addr)
  const v6 = !v4 && /^[0-9a-f:]+$/i.test(addr) && addr.includes(':') && addr.split('::').length <= 2
  if (!v4 && !v6) return false
  if (prefix === undefined) return true
  if (!/^\d+$/.test(prefix)) return false
  return Number(prefix) <= (v4 ? 32 : 128)
}
const ruleValueOk = (type: string, value: string) => {
  if (type === 'geosite' || type === 'geoip') return GEO_RE.test(value)
  if (type === 'ipcidr') return isIpOrCidr(value)
  if (type === 'ruleUrl') return URL_RE.test(value) && value.length <= SHARE_REGION_LIMITS.ruleUrlMax
  return DOMAIN_RE.test(value)
}

// ---- 导入规则(从规则集网址预览后追加明细)----

const showImport = ref(false)
const filledRules = () => (form.value?.rules || []).filter((r) => r.value.trim())
const importMax = computed(() => Math.max(0, SHARE_REGION_LIMITS.rulesPerGroup - filledRules().length))
const IMPORT_TYPES: Record<string, OpenboxShareRuleType | undefined> = {
  domain: 'domain',
  domain_suffix: 'domainSuffix',
  domain_keyword: 'domainKeyword',
  ip_cidr: 'ipcidr',
}
const onImport = (entries: { type: string; value: string }[]) => {
  const f = form.value
  if (!f) return
  const kept = filledRules()
  // 走向沿用最后一行;一行都没有时,和「其余流量」相反(其余走哪边,导入的就走另一边)
  const action = kept[kept.length - 1]?.action || (f.catchAll === 'proxy' ? 'direct' : 'proxy')
  f.rules = [
    ...kept,
    ...entries.flatMap((e) => {
      const type = IMPORT_TYPES[e.type]
      return type ? [{ key: ++ruleKeySeed, type, value: e.value, action }] : []
    }),
  ]
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
  for (let i = 0; i < f.rules.length; i++) splitRuleRow(i)
  const rules = f.rules
    .map((r) => ({ type: r.type, value: r.value.trim(), action: r.action }))
    .filter((r) => r.value)
  const bad = rules.findIndex((r) => !ruleValueOk(r.type, r.value))
  if (bad >= 0) {
    tab.value = 'rules'
    showNotification({
      content: 'clientAppErrRule',
      params: { index: String(bad + 1), value: rules[bad].value },
      type: 'alert-error',
    })
    return
  }
  const group: OpenboxShareRegionGroup = {
    id: f.id,
    name,
    description: f.description.trim(),
    regions: [...f.regions],
    ...(f.regionMatch === 'outside' ? { regionMatch: 'outside' as const } : {}),
    ...(f.isDefault ? { default: true } : {}),
    rules,
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
