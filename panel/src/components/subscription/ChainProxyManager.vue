<template>
  <!-- 链式代理页(对齐 v0.1.311):没有标题卡片;空的时候居中放一个图标和「添加链式代理」按钮,
       有内容时右上角一个添加按钮,下面是列表。 -->
  <div class="flex flex-col gap-2">
    <div
      v-if="loading"
      class="flex justify-center py-16"
    >
      <span class="loading loading-spinner loading-sm" />
    </div>

    <div
      v-else-if="!chains.length"
      class="flex flex-col items-center gap-4 px-4 py-16 text-center"
    >
      <LinkIcon class="text-base-content/30 h-14 w-14" />
      <p class="text-base-content/60 text-sm">{{ $t('chainEmpty') }}</p>
      <button
        type="button"
        class="btn btn-primary rounded-full"
        @click="openEditor(null)"
      >
        <PlusIcon class="h-5 w-5" />
        {{ $t('chainProxyAdd') }}
      </button>
    </div>

    <template v-else>
      <div class="flex justify-end">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          @click="openEditor(null)"
        >
          <PlusIcon class="h-4 w-4" />
          {{ $t('chainProxyAdd') }}
        </button>
      </div>
      <div class="card bg-base-100 border-base-300/60 border">
        <div class="card-body gap-2 p-4">
          <div
            v-for="chain in chains"
            :key="chain.id"
            class="border-base-content/10 flex flex-row items-center gap-2 rounded-lg border p-3"
            :class="chain.enabled === false && 'opacity-50'"
          >
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="max-w-full truncate text-base font-medium">{{ chain.name }}</span>
                <StatusBadge
                  v-if="chain.enabled === false"
                  :on="false"
                  on-text=""
                  :off-text="$t('groupDisabledBadge')"
                />
              </div>
              <div class="text-base-content/60 mt-0.5 truncate text-xs">{{ summary(chain) }}</div>
            </div>
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm"
              :class="chain.enabled === false ? 'text-base-content/40' : 'text-success'"
              :aria-label="$t(chain.enabled === false ? 'groupEnable' : 'groupDisable')"
              v-tip="$t(chain.enabled === false ? 'groupEnable' : 'groupDisable')"
              :disabled="saving"
              @click="toggleEnabled(chain)"
            >
              <PowerIcon class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm"
              :aria-label="$t('groupEdit')"
              @click="openEditor(chain)"
            >
              <PencilSquareIcon class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-square btn-sm hover:text-error"
              :aria-label="$t('delete')"
              v-tip="$t('delete')"
              @click="askDelete(chain)"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </template>

    <DialogWrapper
      v-model="showEditor"
      :title="$t(editing ? 'chainEditTitle' : 'chainAddTitle')"
      box-class="w-full max-w-2xl"
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainProxyNameLabel') }}</label>
          <input
            v-model="draft.name"
            type="text"
            maxlength="64"
            class="input input-sm w-full"
            :placeholder="$t('chainProxyNamePlaceholder')"
          />
        </div>

        <!-- 节点:「链接」粘一条分享链接 / 节点配置;「字段」按住宅代理商表格里的账号一栏栏填,保存时拼成链接 -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <label class="text-xs font-medium">{{ $t('chainProxyLinkLabel') }}</label>
            <div
              role="tablist"
              class="tabs-box tabs tabs-sm shrink-0"
            >
              <a
                v-for="m in MODES"
                :key="m.value"
                role="tab"
                class="tab"
                :class="mode === m.value && 'tab-active'"
                @click="setMode(m.value)"
              >{{ $t(m.label) }}</a>
            </div>
          </div>

          <template v-if="mode === 'link'">
            <textarea
              v-model="draft.link"
              rows="4"
              spellcheck="false"
              class="textarea textarea-sm w-full font-mono text-xs"
              :placeholder="$t('chainProxyLinkPlaceholder')"
            />
            <p class="text-base-content/50 text-xs">{{ $t('chainProxyLinkHint') }}</p>
          </template>
          <template v-else>
            <div class="flex flex-wrap gap-2 sm:flex-nowrap">
              <select
                v-model="fields.scheme"
                class="select select-sm w-full shrink-0 sm:w-36"
              >
                <option
                  v-for="s in SCHEMES"
                  :key="s.value"
                  :value="s.value"
                >{{ s.label }}</option>
              </select>
              <input
                v-model.trim="fields.host"
                type="text"
                spellcheck="false"
                class="input input-sm min-w-0 flex-1 font-mono text-xs"
                :placeholder="$t('chainProxyHostLabel')"
              />
              <input
                v-model.trim="fields.port"
                type="text"
                inputmode="numeric"
                class="input input-sm w-full shrink-0 font-mono text-xs sm:w-28"
                :placeholder="$t('chainProxyPortLabel')"
              />
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <input
                v-model="fields.username"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="input input-sm w-full"
                :placeholder="$t('chainProxyUserLabel')"
              />
              <input
                v-model="fields.password"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="input input-sm w-full"
                :placeholder="$t('chainProxyPassLabel')"
              />
            </div>
            <p class="text-base-content/50 text-xs">{{ $t('chainProxyFieldsHint') }}</p>
          </template>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('chainProxyUpstreamLabel') }}</label>
          <OutboundPicker
            v-model="draft.upstream"
            :options="pickerOptions"
            :placeholder="$t('chainProxyUpstreamPlaceholder')"
          />
          <p class="text-base-content/50 text-xs">{{ $t('chainProxyHint') }}</p>
        </div>

        <div class="flex flex-col gap-2">
          <div>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="testing"
              @click="runTest"
            >
              <span
                v-if="testing"
                class="loading loading-spinner loading-xs"
              />
              <BoltIcon
                v-else
                class="h-4 w-4"
              />
              {{ $t('chainProxyTest') }}
            </button>
          </div>
          <div
            v-if="testResult"
            class="bg-base-200/60 flex flex-col gap-1 rounded-lg px-3 py-2 text-xs"
          >
            <div>
              <span :class="testResult.ok ? 'text-success' : 'text-error'">
                {{ testResult.ok ? $t('chainTestOk', { ms: testResult.ms ?? 0 }) : $t('chainTestFailed', { message: testResult.error || '' }) }}
              </span>
              <span
                v-if="testResult.via"
                class="text-base-content/60"
              > · {{ $t('chainTestVia', { via: testResult.via }) }}</span>
            </div>
            <div
              v-if="ipSummary"
              class="text-base-content/70 break-all"
            >
              {{ ipSummary }}
            </div>
          </div>
          <p class="text-base-content/50 text-xs">{{ $t('chainProxyTestHint') }}</p>
        </div>

        <div class="border-base-content/10 flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            class="btn btn-sm"
            @click="showEditor = false"
          >
            {{ $t('cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="saving"
            @click="saveDraft"
          >
            <span
              v-if="saving"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('subscriptionSave') }}
          </button>
        </div>
      </div>
    </DialogWrapper>

    <DialogWrapper
      v-model="showDelete"
      :title="$t('chainDeleteTitle')"
    >
      <div class="flex flex-col gap-4 p-2">
        <p class="text-sm">{{ $t('chainDeleteConfirm', { name: pendingDelete?.name || '' }) }}</p>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-sm"
            @click="showDelete = false"
          >
            {{ $t('cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-error btn-sm"
            :disabled="saving"
            @click="confirmDelete"
          >
            <span
              v-if="saving"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('confirm') }}
          </button>
        </div>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import { fetchNodeGroups, fetchProfile, saveProfile, testChainLatency } from '@/api/openbox'
import type { OpenboxChainLatencyResult, OpenboxChainProxy } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import OutboundPicker from '@/components/common/OutboundPicker.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { IP_INFO_API } from '@/constant'
import { showNotification } from '@/helper/notification'
import { IPInfoAPI, speedtestTimeout, speedtestUrl } from '@/store/settings'
import { BoltIcon, LinkIcon, PencilSquareIcon, PlusIcon, PowerIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const chains = ref<OpenboxChainProxy[]>([])
const groupNames = ref<string[]>([])
const nodeOptions = ref<Array<{ name: string; subscription: string }>>([])
const loading = ref(true)
const saving = ref(false)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const load = async () => {
  try {
    const [profile, payload] = await Promise.all([fetchProfile(), fetchNodeGroups()])
    chains.value = profile.chainProxies ?? []
    // 内置的直连 / 拒绝、已停用的组不能当上游
    groupNames.value = payload.groups.filter((g) => !g.kind && g.enabled !== false).map((g) => g.name)
    nodeOptions.value = payload.availableNodes
  } catch (error) {
    showNotification({ content: 'routingLoadFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
  } finally {
    loading.value = false
  }
}
onMounted(load)

const summary = (chain: OpenboxChainProxy) => {
  const node = chain.node ? `${chain.node.type} · ${chain.node.server}:${chain.node.port}` : ''
  return [node, `→ ${chain.upstream}`].filter(Boolean).join('  ')
}

// 整份写回;服务端校验不过(重名、上游自己、节点内容解析失败等)会回一句话,原样提示。
// 发出去的只留可写的字段,node 摘要由服务端按 link 重算
const persist = async (next: OpenboxChainProxy[]) => {
  saving.value = true
  try {
    const plain = next.map(({ id, enabled, name, link, upstream }) => ({ id, enabled, name, link, upstream }))
    const profile = await saveProfile({ chainProxies: plain })
    chains.value = profile.chainProxies ?? []
    showNotification({ content: 'chainSaved', type: 'alert-success' })
    return true
  } catch (error) {
    showNotification({ content: 'saveFailed', params: { message: errorMessage(error) }, type: 'alert-error' })
    return false
  } finally {
    saving.value = false
  }
}

const toggleEnabled = (chain: OpenboxChainProxy) => {
  void persist(chains.value.map((c) => (c.id === chain.id ? { ...c, enabled: c.enabled === false } : c)))
}

// ---------- 节点的两种填法 ----------
type Mode = 'link' | 'fields'
type Scheme = 'http' | 'https' | 'socks5'
const MODES: { value: Mode; label: string }[] = [
  { value: 'link', label: 'chainProxyModeLink' },
  { value: 'fields', label: 'chainProxyModeFields' },
]
const SCHEMES: { value: Scheme; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
]
const emptyFields = () => ({ scheme: 'http' as Scheme, host: '', port: '', username: '', password: '' })
const mode = ref<Mode>('fields')
const fields = ref(emptyFields())

// 只认「协议://[用户名:密码@]主机:端口」这一种形状;别的(ss:// vless:// 或一段配置)只能用「链接」填
const LINK_RE = /^(https?|socks5):\/\/(?:([^:@/\s]*):([^@/\s]*)@)?(\[[^\]]+\]|[^:/\s@]+):(\d{1,5})\/?$/i
const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
const parseLink = (link: string) => {
  const m = LINK_RE.exec(link.trim())
  if (!m) return null
  return {
    scheme: m[1].toLowerCase() as Scheme,
    host: m[4].replace(/^\[|\]$/g, ''),
    port: m[5],
    username: safeDecode(m[2] ?? ''),
    password: safeDecode(m[3] ?? ''),
  }
}
const composeLink = (): string | null => {
  const f = fields.value
  const host = f.host.trim()
  const port = Number(f.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const hostText = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const auth = f.username ? `${encodeURIComponent(f.username)}:${encodeURIComponent(f.password)}@` : ''
  return `${f.scheme}://${auth}${hostText}:${port}`
}

const setMode = (next: Mode) => {
  if (mode.value === next) return
  if (next === 'link') {
    // 字段填全了就把拼好的链接带过去,免得切过去是一片空白
    const link = composeLink()
    if (link) draft.value.link = link
  } else {
    const parsed = parseLink(draft.value.link)
    if (parsed) fields.value = parsed
  }
  mode.value = next
}

// 当前这种填法下要保存 / 测速的链接;填得不对就提示并返回 null
const effectiveLink = (): string | null => {
  if (mode.value === 'link') {
    const link = draft.value.link.trim()
    if (!link) {
      showNotification({ content: 'chainLinkRequired', type: 'alert-error' })
      return null
    }
    return link
  }
  if (!fields.value.host.trim()) {
    showNotification({ content: 'chainProxyErrHost', type: 'alert-error' })
    return null
  }
  const link = composeLink()
  if (!link) showNotification({ content: 'chainProxyErrPort', type: 'alert-error' })
  return link
}

// ---------- 编辑 ----------
const showEditor = ref(false)
const editing = ref<OpenboxChainProxy | null>(null)
const draft = ref({ id: '', enabled: true, name: '', link: '', upstream: '' })
const testing = ref(false)
const testResult = ref<OpenboxChainLatencyResult | null>(null)

const openEditor = (chain: OpenboxChainProxy | null) => {
  editing.value = chain
  draft.value = chain
    ? { id: chain.id, enabled: chain.enabled !== false, name: chain.name, link: chain.link, upstream: chain.upstream }
    : { id: `chain-${Date.now().toString(36)}`, enabled: true, name: '', link: '', upstream: '' }
  // 新建默认按字段填;编辑时链接是标准的 http / socks5 就拆成字段,否则留在「链接」里
  const parsed = chain ? parseLink(chain.link) : null
  fields.value = parsed ?? emptyFields()
  mode.value = !chain || parsed ? 'fields' : 'link'
  testResult.value = null
  showEditor.value = true
}

// 上游可选:节点、节点组;别的链式代理也能当上游(服务端会查环),自己不行
const pickerOptions = computed(() => {
  const self = editing.value?.name
  const seen = new Set<string>()
  const nodes: Array<{ name: string; subscription: string }> = []
  const push = (name: string, subscription: string) => {
    if (!name || name === self || seen.has(name)) return
    seen.add(name)
    nodes.push({ name, subscription })
  }
  for (const n of nodeOptions.value) push(n.name, n.subscription)
  for (const c of chains.value) if (c.id !== draft.value.id) push(c.name, t('chainBadge'))
  return { builtin: [], groups: groupNames.value.filter((name) => name !== self), nodes }
})

const saveDraft = async () => {
  const name = draft.value.name.trim()
  const upstream = draft.value.upstream.trim()
  if (!name) return showNotification({ content: 'chainNameRequired', type: 'alert-error' })
  if (!upstream) return showNotification({ content: 'chainUpstreamRequired', type: 'alert-error' })
  const link = effectiveLink()
  if (!link) return
  const item: OpenboxChainProxy = { id: draft.value.id, enabled: draft.value.enabled, name, link, upstream }
  const next = editing.value ? chains.value.map((c) => (c.id === item.id ? item : c)) : [...chains.value, item]
  if (await persist(next)) showEditor.value = false
}

// ---------- 删除 ----------
const showDelete = ref(false)
const pendingDelete = ref<OpenboxChainProxy | null>(null)
const askDelete = (chain: OpenboxChainProxy) => {
  pendingDelete.value = chain
  showDelete.value = true
}
const confirmDelete = async () => {
  const target = pendingDelete.value
  if (!target) return
  if (await persist(chains.value.filter((c) => c.id !== target.id))) {
    showDelete.value = false
    pendingDelete.value = null
  }
}

// ---------- 测速 / IP 地区 ----------
// 面板设置里选的 IP 信息接口排第一,其余依次兜底(后端只认这几家的主机名)
const IP_URLS = [
  { api: IP_INFO_API.IPSB, url: 'https://api.ip.sb/geoip' },
  { api: IP_INFO_API.IPWHOIS, url: 'https://ipwho.is' },
  { api: IP_INFO_API.IPAPI, url: 'https://api.ipapi.is' },
]
const ipUrls = () =>
  [...IP_URLS.filter((x) => x.api === IPInfoAPI.value), ...IP_URLS.filter((x) => x.api !== IPInfoAPI.value)].map((x) => x.url)

const runTest = async () => {
  if (testing.value) return
  const link = effectiveLink()
  if (!link) return
  const upstream = draft.value.upstream.trim()
  if (!upstream) return showNotification({ content: 'chainUpstreamRequired', type: 'alert-error' })
  testing.value = true
  testResult.value = null
  const base = { link, upstream, testUrl: speedtestUrl.value, timeoutMs: speedtestTimeout.value }
  try {
    try {
      testResult.value = await testChainLatency({ ...base, ipUrls: ipUrls() })
    } catch (error) {
      // 后端的 IP 接口白名单和这里对不上时只丢掉 IP 信息,延迟照测
      if (!/ipUrls/.test(errorMessage(error))) throw error
      testResult.value = await testChainLatency(base)
    }
  } catch (error) {
    testResult.value = { via: '', ok: false, error: errorMessage(error) }
  } finally {
    testing.value = false
  }
}

// 后端把 IP 信息接口的正文原样交回,这里按答话那一家的格式取出 IP、国家、运营商
const ipSummary = computed(() => {
  const ip = testResult.value?.ip
  if (!ip) return ''
  if (!ip.ok) return t('chainIpFailed', { message: ip.error || '' })
  try {
    const data = JSON.parse(ip.body || '{}')
    const host = new URL(ip.url || '').hostname
    const [country, org] =
      host === 'api.ipapi.is'
        ? [data.location?.country, data.asn?.org]
        : host === 'ipwho.is'
          ? [data.country, data.connection?.org]
          : [data.country, data.organization]
    return t('chainIpResult', { ip: data.ip, info: [country, org].filter(Boolean).join(' ') })
  } catch {
    return ''
  }
})
</script>
