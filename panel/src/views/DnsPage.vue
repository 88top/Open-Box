<template>
  <div
    class="flex h-full min-h-0 flex-col overflow-y-auto"
    :style="padding"
  >
    <Teleport
      defer
      to="#settings-header-actions"
    >
      <button
        v-tip="$t('flushDNSCache')"
        type="button"
        class="btn btn-sm btn-square"
        :aria-label="$t('flushDNSCache')"
        :disabled="flushing"
        @click="flush"
      >
        <span
          v-if="flushing"
          class="loading loading-spinner loading-xs"
        />
        <TrashIcon
          v-else
          class="h-4 w-4"
        />
      </button>
    </Teleport>
    <div class="flex flex-col gap-2 p-2">
      <template v-if="profile && status">
        <DnsModeCard
          :profile="profile"
          :patch-profile="patchProfile"
        />
        <DnsUpstreamCard
          :profile="profile"
          :patch-profile="patchProfile"
          @refresh="load"
        />
        <DnsRewriteCard
          :profile="profile"
          :patch-profile="patchProfile"
          :busy="busy"
        />
        <DnsFilterCard
          :status="status"
          :busy="busy"
          @saved="load"
          @update="apply(true, $event?.id)"
        />
        <DnsFilterRecords
          :connected="status.connected"
          :enabled="status.applied?.enabled === true"
          :query-log="status.queryLog"
        />
      </template>
      <span
        v-else
        class="loading loading-spinner mx-auto my-8"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  applyDnsFilter,
  fetchDnsFilter,
  fetchProfile,
  flushDnsCache,
  saveProfile,
  type DnsFilterStatus,
  type OpenboxProfile,
} from '@/api/openbox'
import DnsFilterCard from '@/components/dns/DnsFilterCard.vue'
import DnsFilterRecords from '@/components/dns/DnsFilterRecords.vue'
import DnsUpstreamCard from '@/components/dns/DnsUpstreamCard.vue'
import DnsModeCard from '@/components/kernel/DnsModeCard.vue'
import DnsRewriteCard from '@/components/kernel/DnsRewriteCard.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { showNotification } from '@/helper/notification'
import { TrashIcon } from '@heroicons/vue/24/outline'
import { onMounted, onUnmounted, ref } from 'vue'
const { padding } = usePaddingForViews({ offsetTop: 0, offsetBottom: 0 })
const profile = ref<OpenboxProfile | null>(null)
const status = ref<DnsFilterStatus | null>(null)
const busy = ref(false)
const load = async () => {
  try {
    ;[profile.value, status.value] = await Promise.all([fetchProfile(), fetchDnsFilter()])
  } catch (error) {
    showNotification({
      content: 'routeTestRequestFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      key: 'dns-settings-load',
      type: 'alert-error',
    })
  }
}
const patchProfile = async (patch: Record<string, unknown>) => {
  profile.value = await saveProfile(patch)
  return profile.value
}
const apply = async (update: boolean, listId = '') => {
  busy.value = true
  showNotification({
    content: update ? 'dfUpdating' : 'dfApplying',
    key: 'dns-settings-apply',
    type: 'alert-info',
    timeout: 0,
  })
  try {
    await applyDnsFilter(update, listId)
    await load()
    showNotification({ content: 'dfApplied', key: 'dns-settings-apply', type: 'alert-success' })
  } catch (error) {
    showNotification({
      content: 'routeTestRequestFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      key: 'dns-settings-apply',
      type: 'alert-error',
    })
  } finally {
    busy.value = false
  }
}
const flushing = ref(false)
const flush = async () => {
  flushing.value = true
  try {
    await flushDnsCache()
    showNotification({ content: 'flushDNSCacheSuccess', key: 'dns-flush-cache', type: 'alert-success' })
  } catch (error) {
    showNotification({
      content: 'routeTestRequestFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      key: 'dns-flush-cache',
      type: 'alert-error',
    })
  } finally {
    flushing.value = false
  }
}
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  load()
  timer = setInterval(() => {
    if (!busy.value && !document.hidden)
      fetchDnsFilter()
        .then((s) => {
          status.value = s
        })
        .catch(() => {})
  }, 10000)
})
onUnmounted(() => clearInterval(timer))
</script>
