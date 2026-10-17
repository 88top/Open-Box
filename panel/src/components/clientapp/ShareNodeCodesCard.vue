<template>
  <!-- 节点分流(客户端):共享网络每台服务器一个码,点二维码在弹窗里看 -->
  <div class="app-card-inset flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <span class="text-base font-semibold">{{ $t('clientAppShareTitle') }}</span>
      <p class="text-base-content/60 text-xs leading-relaxed">{{ $t('clientAppShareHint') }}</p>
    </div>

    <div
      v-if="loading"
      class="flex justify-center py-4"
    >
      <span class="loading loading-spinner loading-md" />
    </div>
    <p
      v-else-if="!rows.length"
      class="text-base-content/50 text-xs"
    >
      {{ $t('clientAppShareEmpty') }}
    </p>
    <div
      v-else
      class="divide-base-content/10 divide-y"
    >
      <div
        v-for="r in rows"
        :key="r.server.id"
        class="flex items-center gap-2 py-2"
      >
        <ServerStackIcon class="text-base-content/50 h-4 w-4 shrink-0" />
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
          <span class="truncate">{{ r.server.name }}</span>
          <StatusBadge
            v-if="r.server.enabled === false"
            :on="false"
            on-text=""
            :off-text="$t('groupDisabledBadge')"
          />
          <span class="text-base-content/50 text-xs">
            {{ r.server.protocol }} · {{ $t('serverPortLabel') }} {{ r.server.port }}
          </span>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!r.code"
          v-tip="$t('clientAppShareScan')"
          @click="openQr(r)"
        >
          <QrCodeIcon class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-square btn-xs"
          :disabled="!r.code"
          v-tip="$t('copyLink')"
          @click="copy(r.code)"
        >
          <ClipboardDocumentIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <DialogWrapper
      v-model="showQr"
      :title="current ? $t('clientAppShareQrTitle', { name: current.server.name }) : ''"
      box-class="w-full max-w-md"
    >
      <div
        v-if="current"
        class="flex flex-col gap-3 text-sm"
      >
        <img
          v-if="qrDataUrl"
          :src="qrDataUrl"
          class="h-56 w-56 self-center rounded-lg bg-white p-1"
          alt="QR"
        />
        <p class="text-base-content/60 text-center text-xs">{{ $t('clientAppShareQrHint') }}</p>
        <div class="join w-full">
          <input
            :value="current.code"
            type="text"
            readonly
            class="input input-sm join-item w-full font-mono text-xs"
          />
          <button
            type="button"
            class="btn btn-sm join-item"
            @click="copy(current.code)"
          >
            <ClipboardDocumentIcon class="h-4 w-4" />
          </button>
        </div>
        <p
          v-if="!info.lanAddresses.length"
          class="text-warning text-xs"
        >
          {{ $t('clientAppLocalNoLan') }}
        </p>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import type { OpenboxClientAppInfo } from '@/api/clientApp'
import { fetchProfile, type OpenboxServer } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { copyText } from '@/helper/clipboard'
import { buildShareAppCode } from '@/helper/clientAppCode'
import { showNotification } from '@/helper/notification'
import { buildShareLink } from '@/helper/shareLink'
import { ClipboardDocumentIcon, QrCodeIcon, ServerStackIcon } from '@heroicons/vue/24/outline'
import QRCode from 'qrcode'
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ info: OpenboxClientAppInfo }>()

type Row = { server: OpenboxServer; code: string }

const servers = ref<OpenboxServer[]>([])
const loading = ref(true)
const showQr = ref(false)
const current = ref<Row | null>(null)
const qrDataUrl = ref('')

const router = computed(() => ({
  routerId: props.info.routerId,
  routerName: props.info.routerName,
  lan: props.info.lanAddresses[0] || '',
  panelPort: props.info.panelPort,
}))

const rows = computed<Row[]>(() =>
  servers.value.map((server) => ({
    server,
    code: buildShareAppCode(router.value, { id: server.id, link: buildShareLink(server) || '' }),
  })),
)

const copy = async (text: string) => {
  if (!text) return
  const ok = await copyText(text)
  showNotification(
    ok
      ? { content: 'copySuccess', type: 'alert-success' }
      : { content: 'copyFailed', type: 'alert-error' },
  )
}

const openQr = async (row: Row) => {
  current.value = row
  qrDataUrl.value = ''
  showQr.value = true
  try {
    qrDataUrl.value = await QRCode.toDataURL(row.code, { margin: 1, width: 352 })
  } catch {
    qrDataUrl.value = ''
  }
}

onMounted(async () => {
  try {
    const profile = await fetchProfile()
    servers.value = profile.servers ?? []
  } catch (error) {
    showNotification({
      content: 'clientAppLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  } finally {
    loading.value = false
  }
})
</script>
