<template>
  <!-- embedded:嵌在顶部总卡片里时不带外框、标题和「当前版本」(版本号在标题行) -->
  <div :class="embedded ? undefined : 'card bg-base-100 border-base-300/60 border'">
    <div :class="embedded ? 'flex flex-col gap-3 text-sm' : 'card-body gap-3 p-4 text-sm'">
      <div v-if="!embedded">
        <h2 class="text-base font-semibold">{{ $t('obUpdateTitle') }}</h2>
        <p class="text-base-content/60 text-xs">{{ $t('obUpdateDescription') }}</p>
      </div>

      <!-- 一行:[通道] [检查更新] 最新版本 vX [已是最新] 安装时通道。检查更新探到新版就弹确认框
           (带更新日志),点「确定更新」才真正升级;升级进行中按钮变成「查看进度」。 -->
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="channel"
          v-tip="$t('obUpdateDescription')"
          class="select select-sm w-auto"
          :disabled="updateRunning"
        >
          <option value="auto">{{ $t('obUpdateChannelAuto') }}</option>
          <option value="direct">{{ $t('obUpdateChannelDirect') }}</option>
          <option value="mirror">{{ $t('obUpdateChannelMirror') }}</option>
        </select>
        <button
          v-if="updateRunning"
          type="button"
          class="btn btn-sm"
          @click="updateDialogOpen = true"
        >
          <span class="loading loading-spinner loading-xs loading-inline" />
          {{ $t('obUpdateViewProgress') }}
        </button>
        <button
          v-else
          type="button"
          class="btn btn-sm"
          :disabled="checking"
          @click="check"
        >
          <span
            v-if="checking"
            class="loading loading-spinner loading-xs"
          />
          {{ $t('obUpdateCheck') }}
        </button>
        <template v-if="!embedded">
          <span class="text-base-content/70">{{ $t('obUpdateCurrent') }}:</span>
          <span class="font-mono">{{ updateInfo?.version || '—' }}</span>
        </template>
        <template v-if="latest">
          <span class="text-base-content/70">{{ $t('obUpdateLatest') }}:</span>
          <span class="font-mono">{{ latest.latest }}</span>
          <StatusBadge
            :on="!latest.hasUpdate"
            :on-text="$t('obUpdateUpToDate')"
            :off-text="$t('obUpdateAvailable')"
          />
        </template>
        <span
          v-if="updateInfo?.channel"
          class="text-base-content/50 text-xs"
        >{{ $t('obUpdateInstalledChannel', { channel: updateInfo!.channel.mode === 'mirror' ? $t('obUpdateChannelMirror') : $t('obUpdateChannelDirect') }) }}</span>
      </div>

      <OpenboxUpdateConfirmDialog
        v-model="confirmOpen"
        :current="latest?.current || updateInfo?.version || ''"
        :latest="latest?.latest || ''"
        :loading="notesLoading"
        :note="note"
        :url="notesUrl"
        :starting="updateStarting"
        @confirm="confirmUpdate"
      />

      <div class="bg-base-content/10 h-px" />

      <!-- 自动更新计划 -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span class="font-medium">{{ $t('obUpdateAuto') }}</span>
        <input
          type="checkbox"
          class="toggle toggle-sm"
          :checked="plan.auto"
          @change="savePlan({ auto: ($event.target as HTMLInputElement).checked })"
        />
        <template v-if="plan.auto">
          <span class="text-base-content/70">{{ $t('geoUpdateEvery') }}</span>
          <select
            class="select select-sm w-24"
            :value="plan.days"
            @change="savePlan({ days: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option
              v-for="d in [1, 3, 7, 14, 30]"
              :key="d"
              :value="d"
            >{{ $t('geoUpdateDays', { days: d }) }}</option>
          </select>
          <span class="text-base-content/70">{{ $t('obUpdateAutoAt') }}</span>
          <select
            class="select select-sm w-24"
            :value="plan.hour"
            @change="savePlan({ hour: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option
              v-for="h in 24"
              :key="h - 1"
              :value="h - 1"
            >{{ String(h - 1).padStart(2, '0') }}:00</option>
          </select>
          <select
            class="select select-sm"
            :value="plan.channel"
            @change="savePlan({ channel: ($event.target as HTMLSelectElement).value as 'auto' | 'direct' | 'mirror' })"
          >
            <option value="auto">{{ $t('obUpdateChannelAuto') }}</option>
            <option value="direct">{{ $t('obUpdateChannelDirect') }}</option>
            <option value="mirror">{{ $t('obUpdateChannelMirror') }}</option>
          </select>
        </template>
        <span class="text-base-content/50 text-xs">{{ $t('obUpdateAutoHint') }}</span>
      </div>

    </div>
  </div>

</template>

<script setup lang="ts">
import type { OpenboxProfile, OpenboxUpdateChannel, OpenboxUpdateNote } from '@/api/openbox'
import { checkUpdate, fetchUpdateNotes } from '@/api/openbox'
import StatusBadge from '@/components/common/StatusBadge.vue'
import OpenboxUpdateConfirmDialog from '@/components/kernel/OpenboxUpdateConfirmDialog.vue'
// 升级进度是全局的(面板和内核各重启一次,用户可能待在任何页面),状态和弹窗都在
// composables/openboxUpdate 这个单例里,弹窗由 App.vue 挂在根上;这张卡只管发起和显示版本。
import {
  refreshUpdateInfo,
  startUpdate,
  updateDialogOpen,
  updateInfo,
  updateRunning,
  updateStarting,
} from '@/composables/openboxUpdate'
import { showNotification } from '@/helper/notification'
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  profile: OpenboxProfile
  patchProfile: (patch: Record<string, unknown>) => Promise<OpenboxProfile>
  embedded?: boolean
}>()

const latest = ref<{ current: string; latest: string; hasUpdate: boolean } | null>(null)
const checking = ref(false)
const plan = computed(() => ({
  auto: props.profile.updates?.openbox?.auto === true,
  hour: props.profile.updates?.openbox?.hour ?? 4,
  days: props.profile.updates?.openbox?.days ?? 1,
  channel: props.profile.updates?.openbox?.channel ?? 'auto',
  checkChannel: props.profile.updates?.openbox?.checkChannel ?? 'auto',
}))
// 手动检查 / 更新用的通道:记在档案里,下次进页面还是上次选的;改了就静默存一次
const channel = ref<OpenboxUpdateChannel>(plan.value.checkChannel)
watch(() => plan.value.checkChannel, (v) => { channel.value = v })
watch(channel, async (v) => {
  if (v === plan.value.checkChannel) return
  try {
    await props.patchProfile({ updates: { openbox: { ...plan.value, checkChannel: v } } })
  } catch (err) {
    showNotification({
      content: 'routingSaveFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  }
})

// 确认弹窗:探到新版就打开,更新日志按版本只取一次(取失败下次再试)
const confirmOpen = ref(false)
const note = ref<OpenboxUpdateNote | null>(null)
const notesLoading = ref(false)
const notesUrl = ref('https://github.com/timeflysoon/Open-Box/releases')
let notesFor = ''

const openConfirm = async () => {
  const version = latest.value?.latest || ''
  if (!version) return
  confirmOpen.value = true
  if (notesFor === version) return
  notesFor = version
  notesLoading.value = true
  note.value = null
  try {
    const r = await fetchUpdateNotes(version)
    note.value = r.note
    if (r.url) notesUrl.value = r.url
  } catch {
    notesFor = ''
  } finally {
    notesLoading.value = false
  }
}

const confirmUpdate = async () => {
  if (await startUpdate(channel.value)) confirmOpen.value = false
}

const check = async () => {
  checking.value = true
  try {
    const r = await checkUpdate()
    latest.value = r
    if (r.hasUpdate) void openConfirm()
    else showNotification({ content: 'obUpdateUpToDateToast', params: { latest: r.latest }, type: 'alert-success' })
  } catch (err) {
    showNotification({
      content: 'obUpdateCheckFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  } finally {
    checking.value = false
  }
}

const savePlan = async (patch: Partial<{ auto: boolean; hour: number; days: number; channel: OpenboxUpdateChannel }>) => {
  try {
    await props.patchProfile({ updates: { openbox: { ...plan.value, ...patch } } })
    showNotification({ content: 'obUpdatePlanSaved', type: 'alert-success' })
  } catch (err) {
    showNotification({
      content: 'routingSaveFailed',
      params: { message: err instanceof Error ? err.message : String(err) },
      type: 'alert-error',
    })
  }
}

onMounted(() => {
  void refreshUpdateInfo()
})
</script>
