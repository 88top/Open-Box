<template>
  <!-- 地区组的 DNS:直连 / 代理各一行(哪一侧 / 协议 / 地址 / 端口),每行能修改、删除;设计和路由器「DNS 设置」页的 DNS 上游一致。
       每侧第一条是主上游,后面是备用(并发查,谁先返回用谁的);含中国大陆的组代理侧不能用系统 DNS。 -->
  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-end gap-1">
      <button
        v-tip="$t('dnsUpstreamRestore')"
        type="button"
        class="btn btn-ghost btn-square btn-xs"
        :aria-label="$t('dnsUpstreamRestore')"
        @click="restoreOpen = true"
      >
        <ArrowUturnLeftIcon class="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-xs"
        @click="openEditor(null)"
      >
        <PlusIcon class="h-3.5 w-3.5" />
        {{ $t('dnsUpstreamAdd') }}
      </button>
    </div>

    <div class="border-base-content/10 divide-base-content/10 divide-y rounded-lg border px-3">
      <div
        v-for="row in rows"
        :key="row.key"
        class="flex items-center gap-2 py-2"
      >
        <span class="badge badge-sm shrink-0">{{ sideName(row.side) }}</span>
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 font-mono text-xs">
          <span
            v-if="!row.wan"
            class="text-base-content/60"
          >{{ row.protocol.toUpperCase() }}</span>
          <template v-if="row.wan">
            <span class="font-sans">{{ $t('shareRegionsDnsSystem') }}</span>
            <span class="text-base-content/50 truncate font-sans">{{ $t('shareRegionsDnsSystemText') }}</span>
            <span
              v-if="row.side === 'proxy'"
              class="text-base-content/50 font-sans"
            >{{ $t('dnsUpstreamWanDirectTag') }}</span>
          </template>
          <span
            v-else
            class="truncate"
          >{{ row.server }}<span class="text-base-content/50">:{{ row.port }}</span></span>
          <span
            v-if="row.index > 0"
            class="text-base-content/50 font-sans"
          >{{ $t('dnsUpstreamBackupTag') }}</span>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :aria-label="$t('groupEdit')"
          @click="openEditor(row)"
        >
          <PencilSquareIcon class="h-4 w-4" />
        </button>
        <button
          v-tip="deleteBlocked(row) || $t('delete')"
          type="button"
          class="btn btn-ghost btn-square btn-xs hover:text-error"
          :disabled="!!deleteBlocked(row)"
          :aria-label="$t('delete')"
          @click="removeRow(row)"
        >
          <TrashIcon class="h-4 w-4" />
        </button>
      </div>
    </div>
    <p class="text-base-content/50 text-xs">{{ $t('shareRegionsDnsNote') }}</p>

    <!-- 恢复默认前确认一次 -->
    <DialogWrapper
      v-model="restoreOpen"
      :title="$t('dnsUpstreamRestore')"
    >
      <div class="flex flex-col gap-3">
        <p class="text-sm">{{ $t('shareRegionsDnsRestoreConfirm') }}</p>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn-sm"
            @click="restoreOpen = false"
          >
            {{ $t('cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-error btn-sm"
            @click="restoreDefaults"
          >
            {{ $t('confirm') }}
          </button>
        </div>
      </div>
    </DialogWrapper>

    <DialogWrapper
      v-model="editorOpen"
      :title="$t(editing ? 'dnsUpstreamEditTitle' : 'dnsUpstreamAddTitle')"
      box-class="w-full max-w-lg"
      header-class="mx-4 px-0! [&>button]:right-[-0.5rem]!"
      footer-class="mx-4 px-0!"
    >
      <div
        v-if="draft"
        class="flex flex-col gap-3 text-sm"
      >
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">{{ $t('dnsUpstreamSide') }}</label>
          <div
            role="tablist"
            class="tabs-box tabs tabs-xs w-fit"
          >
            <a
              v-for="s in SIDES"
              :key="s"
              role="tab"
              class="tab"
              :class="draft.side === s && 'tab-active'"
              @click="draft.side = s"
            >{{ sideName(s) }}</a>
          </div>
          <p class="text-base-content/50 text-xs">
            {{ $t(draft.side === 'direct' ? 'shareRegionsDnsDirectNote' : 'shareRegionsDnsProxyNote') }}
          </p>
        </div>
        <div class="flex flex-col gap-1">
          <div
            role="tablist"
            class="tabs-box tabs tabs-xs w-fit"
          >
            <a
              role="tab"
              class="tab"
              :class="!draft.wan && 'tab-active'"
              @click="draft.wan = false"
            >{{ $t('dnsUpstreamSourceIp') }}</a>
            <a
              role="tab"
              class="tab"
              :class="[draft.wan && 'tab-active', !wanAllowed(draft.side) && 'tab-disabled']"
              @click="wanAllowed(draft.side) && (draft.wan = true)"
            >{{ $t('shareRegionsDnsSystem') }}</a>
          </div>
          <template v-if="wanAllowed(draft.side)">
            <p
              v-if="draft.side === 'proxy' && draft.wan"
              class="text-base-content/50 text-xs"
            >
              {{ $t('shareRegionsDnsSystemProxyNote') }}
            </p>
          </template>
          <p
            v-else
            class="text-base-content/50 text-xs"
          >
            {{ $t('shareRegionsDnsSystemNotInCn') }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <select
            v-if="!draft.wan"
            v-model="draft.protocol"
            class="select select-sm w-20 shrink-0"
            :title="$t('dnsUpstreamProtocol')"
          >
            <option value="udp">UDP</option>
            <option value="tcp">TCP</option>
          </select>
          <span
            v-if="draft.wan"
            class="text-base-content/60 min-w-0 flex-1 truncate text-xs"
          >{{ $t('shareRegionsDnsSystemText') }}</span>
          <template v-else>
            <input
              v-model.trim="draft.server"
              type="text"
              class="input input-sm min-w-0 flex-1 font-mono"
              :class="{ 'input-error': draft.server && !isDnsIp(draft.server) }"
              :placeholder="draft.side === 'direct' ? '223.5.5.5' : '1.1.1.1'"
              spellcheck="false"
            >
            <input
              v-model.number="draft.port"
              type="number"
              min="1"
              max="65535"
              class="input input-sm w-20 shrink-0"
              :class="{ 'input-error': !isDnsPort(draft.port) }"
              :title="$t('dnsUpstreamPort')"
            >
          </template>
        </div>
        <p
          v-if="editorError"
          class="text-error text-xs"
        >
          {{ editorError }}
        </p>
      </div>

      <template #footer>
        <button
          type="button"
          class="btn btn-sm"
          @click="editorOpen = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="!draftValid"
          @click="saveEditor"
        >
          {{ $t('confirm') }}
        </button>
      </template>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxShareGroupDns } from '@/api/clientApp'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import {
  DEFAULT_DNS_PORT,
  MAX_DNS_EXTRAS,
  WAN_UPSTREAM,
  isDnsIp,
  isDnsPort,
  regionDnsDefaults,
} from '@/constant/shareRegionDns'
import '@/i18n/client-app-dns'
import { ArrowUturnLeftIcon, PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

type Side = 'direct' | 'proxy'
type Protocol = 'udp' | 'tcp'
// 一条上游:wan 为真表示系统 DNS(手机此刻所在网络的,固定 UDP 53)
interface Upstream {
  side: Side
  wan: boolean
  server: string
  protocol: Protocol
  port: number
}
interface Row extends Upstream {
  index: number
  key: string
}

const props = defineProps<{
  // 这一组含中国大陆:代理侧不能用系统 DNS(中国大陆的 DNS 对境外域名有污染)
  inCn: boolean
}>()
const dns = defineModel<OpenboxShareGroupDns>({ required: true })

const { t } = useI18n()

const SIDES: Side[] = ['direct', 'proxy']
const FALLBACK_PROTOCOL: Record<Side, Protocol> = { direct: 'udp', proxy: 'tcp' }

const sideName = (side: Side) => t(side === 'direct' ? 'dnsUpstreamDirect' : 'dnsUpstreamProxy')
// 系统 DNS 只有直连能用;不含中国大陆的组代理侧也能用
const wanAllowed = (side: Side) => side === 'direct' || !props.inCn

// ---- 档案 ⇄ 行
const readOne = (side: Side, server: unknown, protocol: unknown, port: unknown): Upstream | null => {
  const wan = server === WAN_UPSTREAM
  const host = typeof server === 'string' && !wan ? server : ''
  if (!wan && !host) return null
  return {
    side,
    wan,
    server: wan ? '' : host,
    protocol: wan ? 'udp' : protocol === 'udp' || protocol === 'tcp' ? protocol : FALLBACK_PROTOCOL[side],
    port: wan || !isDnsPort(port) ? DEFAULT_DNS_PORT : (port as number),
  }
}
const sideRows = (side: Side): Row[] => {
  const d = dns.value as unknown as Record<string, unknown>
  const main =
    side === 'direct'
      ? readOne(side, d.direct, d.directProtocol, d.directPort)
      : readOne(side, d.proxy, d.proxyProtocol, d.proxyPort)
  const extrasRaw = (side === 'direct' ? d.directExtras : d.proxyExtras) as Array<Record<string, unknown>> | undefined
  const extras = (Array.isArray(extrasRaw) ? extrasRaw : [])
    .slice(0, MAX_DNS_EXTRAS)
    .map((x) => readOne(side, x?.server, x?.protocol, x?.port))
  return [main, ...extras]
    .filter((x): x is Upstream => !!x)
    .map((x, index) => ({ ...x, index, key: `${side}-${index}` }))
}
const rows = computed<Row[]>(() => [...sideRows('direct'), ...sideRows('proxy')])
const countOf = (side: Side) => rows.value.filter((r) => r.side === side).length

const toOut = (u: Upstream) =>
  u.wan
    ? { server: WAN_UPSTREAM, protocol: 'udp', port: DEFAULT_DNS_PORT }
    : { server: u.server, protocol: u.protocol, port: u.port }
// 把一整张列表写回 dns:每侧第一条是主上游,后面是备用;一侧删光了就退回系统 DNS
const write = (list: Upstream[]) => {
  const out: Record<string, unknown> = {}
  for (const side of SIDES) {
    const own = list.filter((r) => r.side === side)
    const [main, ...extras] = own.length
      ? own
      : [{ side, wan: true, server: '', protocol: 'udp' as Protocol, port: DEFAULT_DNS_PORT }]
    const m = toOut(main)
    const ex = extras.slice(0, MAX_DNS_EXTRAS).map(toOut)
    if (side === 'direct') Object.assign(out, { direct: m.server, directProtocol: m.protocol, directPort: m.port, directExtras: ex })
    else Object.assign(out, { proxy: m.server, proxyProtocol: m.protocol, proxyPort: m.port, proxyExtras: ex })
  }
  dns.value = out as unknown as OpenboxShareGroupDns
}

// ---- 删除:不能删光;含中国大陆的组代理 DNS 至少留一个,别的一侧删光了改用系统 DNS
const deleteBlocked = (r: Row) => {
  if (countOf(r.side) > 1) return ''
  if (wanAllowed(r.side)) return r.wan ? t('shareRegionsDnsSystemLast') : ''
  return t('shareRegionsDnsLastOne')
}
const removeRow = (r: Row) => {
  if (deleteBlocked(r)) return
  write(rows.value.filter((x) => x.key !== r.key))
}

// ---- 恢复默认:按这一组含不含中国大陆
const restoreOpen = ref(false)
const restoreDefaults = () => {
  dns.value = regionDnsDefaults(props.inCn ? 'cn' : 'intl')
  restoreOpen.value = false
}

// ---- 添加 / 修改
const editorOpen = ref(false)
const editing = ref<Row | null>(null)
const draft = ref<Upstream | null>(null)
const editorError = ref('')
const draftValid = computed(() => {
  const d = draft.value
  return !!d && (d.wan || (isDnsIp(d.server) && isDnsPort(d.port)))
})
const openEditor = (row: Row | null) => {
  editing.value = row
  editorError.value = ''
  draft.value = row
    ? { side: row.side, wan: row.wan, server: row.server, protocol: row.protocol, port: row.port }
    : { side: 'proxy', wan: false, server: '', protocol: 'tcp', port: DEFAULT_DNS_PORT }
  editorOpen.value = true
}
const saveEditor = () => {
  const d = draft.value
  if (!d || !draftValid.value) return
  if (d.wan && !wanAllowed(d.side)) {
    editorError.value = t('shareRegionsDnsSystemNotInCn')
    return
  }
  const current = editing.value
  // 把这一条从原来那一侧挪走以后,原来那一侧不能空(含中国大陆的组代理 DNS)
  if (current && current.side !== d.side && !wanAllowed(current.side) && countOf(current.side) <= 1) {
    editorError.value = t('shareRegionsDnsLastOne')
    return
  }
  const duplicate = rows.value
    .filter((r) => r.key !== current?.key)
    .some((r) => r.side === d.side && (d.wan ? r.wan : !r.wan && r.server === d.server))
  if (duplicate) {
    editorError.value = t('dnsUpstreamExtraDuplicate')
    return
  }
  if ((!current || current.side !== d.side) && countOf(d.side) > MAX_DNS_EXTRAS) {
    editorError.value = t('dnsUpstreamTooMany', { max: MAX_DNS_EXTRAS + 1 })
    return
  }
  const next: Upstream[] = current
    ? rows.value.map((x) => (x.key === current.key ? { ...d } : x))
    : [...rows.value, { ...d }]
  write([...next.filter((x) => x.side === 'direct'), ...next.filter((x) => x.side === 'proxy')])
  editorOpen.value = false
}
</script>
