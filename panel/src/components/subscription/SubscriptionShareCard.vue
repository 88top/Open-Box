<template>
  <CollapseCard
    :name="COLLAPSE_KEY"
    :content-scrollable="false"
  >
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="flex items-center gap-1 text-base font-semibold">
            订阅分享
            <ChevronUpIcon
              v-if="shareExpanded"
              class="h-4 w-4"
            />
            <ChevronDownIcon
              v-else
              class="h-4 w-4"
            />
          </h2>
          <p class="text-base-content/55 mt-1 text-xs">生成可供其他设备或代理软件直接使用的订阅链接</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm btn-square" v-tip="'添加'" aria-label="添加" @click.stop="openCreate">
          <PlusIcon class="h-4 w-4" />
        </button>
      </div>
    </template>

    <template #content>
      <div v-if="!shares.length" class="text-base-content/55 py-3 text-center text-sm">
        暂无订阅分享，点击右上角“添加”创建
      </div>
      <div v-else class="divide-base-content/10 divide-y">
        <div v-for="share in shares" :key="share.id" class="flex flex-wrap items-center gap-3 py-3 first:pt-1 last:pb-1" :class="share.enabled === false && 'opacity-50'">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2 text-sm font-medium"><span class="min-w-0 truncate">{{ share.name }}</span><span v-if="selectedNames(share).length" class="text-base-content/55 min-w-0 truncate text-xs font-normal">· {{ selectedNames(share).join('、') }}</span></div>
          <div class="text-base-content/55 mt-1 truncate font-mono text-xs">{{ shareUrl(share) }}</div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="btn btn-ghost btn-sm btn-square" title="启用/停用" :class="share.enabled === false ? 'text-base-content/40' : 'text-success'" @click="toggle(share)"><PowerIcon class="h-4 w-4" /></button>
          <button type="button" class="btn btn-ghost btn-sm btn-square" title="复制链接" @click="copy(shareUrl(share))"><ClipboardDocumentIcon class="h-4 w-4" /></button>
          <button type="button" class="btn btn-ghost btn-sm btn-square" title="重新生成" :disabled="busy" @click="regenerate(share)"><ArrowPathIcon class="h-4 w-4" /></button>
          <button type="button" class="btn btn-ghost btn-sm btn-square" title="编辑" @click="openEdit(share)"><PencilSquareIcon class="h-4 w-4" /></button>
          <button type="button" class="btn btn-ghost btn-sm btn-square hover:text-error" title="删除" @click="remove(share)"><TrashIcon class="h-4 w-4" /></button>
        </div>
        </div>
      </div>
    </template>
  </CollapseCard>

  <DialogWrapper v-model="dialogOpen" :title="editing ? '编辑订阅分享' : '新增订阅分享'" box-class="w-full max-w-3xl">
    <div class="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)]">
      <div class="flex min-h-0 flex-col gap-2">
        <div class="text-xs font-medium">选择要分享的订阅节点</div>
        <div class="max-h-80 overflow-y-auto pr-1">
          <label v-for="sub in subscriptions" :key="sub.id" class="border-base-content/10 flex items-center gap-2 border-b py-2 text-sm first:border-t">
            <input v-model="form.subscriptionIds" type="checkbox" class="checkbox checkbox-sm" :value="sub.id" />
            <span class="min-w-0 flex-1 truncate">{{ sub.name }}</span><span class="text-base-content/50 text-xs">{{ sub.nodeCount }} 个节点</span>
          </label>
        </div>
        <p v-if="!subscriptions.length" class="text-base-content/55 text-xs">请先添加至少一条订阅</p>
      </div>
      <div class="flex flex-col gap-3">
        <label class="flex flex-col gap-1"><span class="text-xs font-medium">标题</span><input v-model="form.name" class="input input-sm w-full" placeholder="例如：手机代理订阅" /></label>
        <label class="flex flex-col gap-1"><span class="text-xs font-medium">域名或 IP</span><div class="join w-full"><select v-model="form.protocol" class="select select-sm join-item"><option value="http">http://</option><option value="https">https://</option></select><input v-model="form.host" class="input input-sm join-item min-w-0 flex-1 font-mono" placeholder="当前地址" /></div></label>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium">分享链接</label>
          <div class="join w-full">
            <input :value="displayUrl" readonly class="input input-sm join-item min-w-0 flex-1 font-mono text-xs" />
            <button type="button" class="btn btn-sm join-item" v-tip="'复制链接'" @click="copy(displayUrl)"><ClipboardDocumentIcon class="h-4 w-4" /></button>
          </div>
        </div>
        <label v-if="editing" class="flex cursor-pointer items-center gap-2 text-xs"><input v-model="renewToken" type="checkbox" class="checkbox checkbox-xs" />重新生成链接(旧链接立即失效)</label>
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="订阅分享二维码" class="h-44 w-44 self-center rounded-lg bg-white p-1" />
        <p v-if="!generatedShare" class="text-base-content/60 text-xs">{{ editing && renewToken ? '保存后生成新的地址和二维码' : '保存后此地址和二维码生效' }}</p>
        <div class="flex justify-end gap-2 pt-1"><button type="button" class="btn btn-sm" @click="dialogOpen = false">取消</button><button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="save"><span v-if="busy" class="loading loading-spinner loading-xs" />保存并生成</button></div>
      </div>
    </div>
  </DialogWrapper>
</template>

<script setup lang="ts">
import QRCode from 'qrcode'
import { computed, reactive, ref, watch } from 'vue'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import CollapseCard from '@/components/common/CollapseCard.vue'
import { collapseGroupMap } from '@/store/settings'
import type { OpenboxSubscription, OpenboxSubscriptionShare } from '@/api/openbox'
import { createSubscriptionShare, deleteSubscriptionShare, regenerateSubscriptionShare, updateSubscriptionShare } from '@/api/openbox'
import { copyText as copyToClipboard } from '@/helper/clipboard'
import { showNotification } from '@/helper/notification'
import { ArrowPathIcon, ChevronDownIcon, ChevronUpIcon, ClipboardDocumentIcon, PencilSquareIcon, PlusIcon, PowerIcon, TrashIcon } from '@heroicons/vue/24/outline'

const props = defineProps<{ subscriptions: OpenboxSubscription[]; shares: OpenboxSubscriptionShare[] }>()
const emit = defineEmits<{ changed: [] }>()
const COLLAPSE_KEY = 'subscription-share'
const shareExpanded = computed(() => Boolean(collapseGroupMap.value[COLLAPSE_KEY]))
const dialogOpen = ref(false)
const editing = ref<OpenboxSubscriptionShare | null>(null)
const generatedShare = ref<OpenboxSubscriptionShare | null>(null)
const qrDataUrl = ref('')
const draftToken = ref('')
const busy = ref(false)
// 编辑时才有:勾上保存时换一个新 token(旧链接立即失效);不勾就保持原链接,只改名字 / 主机 / 订阅
const renewToken = ref(false)
const form = reactive({ name: '', protocol: 'http' as 'http' | 'https', host: '', subscriptionIds: [] as string[] })
const currentHost = () => window.location.host
const currentProtocol = () => window.location.protocol === 'https:' ? 'https' : 'http'
const shareUrl = (share: OpenboxSubscriptionShare) => `${share.protocol || currentProtocol()}://${share.host || currentHost()}/sub/${share.token}`
const displayUrl = computed(() => {
  if (generatedShare.value) return shareUrl(generatedShare.value)
  const token = editing.value ? (renewToken.value ? '' : editing.value.token) : draftToken.value
  return token ? `${form.protocol}://${form.host || currentHost()}/sub/${token}` : ''
})
const makeDraftToken = () => {
  try {
    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(24)
      window.crypto.getRandomValues(bytes)
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
  } catch { /* HTTP 页面或旧浏览器可能没有 Web Crypto */ }
  return Array.from({ length: 48 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}
const selectedNames = (share: OpenboxSubscriptionShare) => (Array.isArray(share.subscriptionIds) ? share.subscriptionIds : []).map((id) => props.subscriptions.find((s) => s.id === id)?.name || id)
const reset = () => { form.name = ''; form.protocol = currentProtocol(); form.host = currentHost(); form.subscriptionIds = []; editing.value = null; generatedShare.value = null; draftToken.value = makeDraftToken(); qrDataUrl.value = ''; renewToken.value = false }
const openCreate = () => { reset(); dialogOpen.value = true }
const openEdit = (share: OpenboxSubscriptionShare) => { reset(); editing.value = share; form.name = share.name; form.protocol = share.protocol || currentProtocol(); form.host = share.host || currentHost(); form.subscriptionIds = [...share.subscriptionIds]; dialogOpen.value = true }
const makeQr = async (share: OpenboxSubscriptionShare) => { generatedShare.value = share; qrDataUrl.value = await QRCode.toDataURL(shareUrl(share), { margin: 1, width: 240 }) }
watch(() => [form.protocol, form.host, draftToken.value, renewToken.value], async () => { if (!generatedShare.value) qrDataUrl.value = displayUrl.value ? await QRCode.toDataURL(displayUrl.value, { margin: 1, width: 240 }) : '' })
const save = async () => {
  if (!form.name.trim() || !form.subscriptionIds.length || busy.value) return
  busy.value = true
  try {
    const share = editing.value
      ? await updateSubscriptionShare(editing.value.id, { name: form.name, host: form.host, protocol: form.protocol, subscriptionIds: form.subscriptionIds, regenerate: renewToken.value })
      : await createSubscriptionShare({ name: form.name, host: form.host, protocol: form.protocol, subscriptionIds: form.subscriptionIds, token: draftToken.value })
    await makeQr(share); emit('changed'); dialogOpen.value = false; showNotification({ content: '订阅分享已保存', type: 'alert-success' })
  } catch (error) { showNotification({ content: '订阅分享保存失败', type: 'alert-error', params: { message: error instanceof Error ? error.message : String(error) } }) } finally { busy.value = false }
}
const toggle = async (share: OpenboxSubscriptionShare) => { if (busy.value) return; busy.value = true; try { await updateSubscriptionShare(share.id, { name: share.name, host: share.host, protocol: (share.protocol || currentProtocol()) as 'http' | 'https', subscriptionIds: share.subscriptionIds, enabled: share.enabled === false }) ; emit('changed') } finally { busy.value = false } }
const regenerate = async (share: OpenboxSubscriptionShare) => { if (busy.value) return; busy.value = true; try { await regenerateSubscriptionShare(share.id); emit('changed') } finally { busy.value = false } }
const remove = async (share: OpenboxSubscriptionShare) => { if (busy.value || !window.confirm(`确定删除“${share.name}”？`)) return; busy.value = true; try { await deleteSubscriptionShare(share.id); emit('changed') } finally { busy.value = false } }
const copy = async (value: string) => { const ok = await copyToClipboard(value); showNotification({ content: ok ? 'copySuccess' : 'copyFailed', type: ok ? 'alert-success' : 'alert-error' }) }
</script>
