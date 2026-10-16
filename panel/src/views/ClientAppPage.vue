<template>
  <!-- 设置 · 客户端:Open-Box App(手机 / 电脑)的配对码、地区分流、路由器标识 -->
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      :style="padding"
    >
      <div class="flex flex-col gap-2 px-2 pb-2 md:py-2">
        <ClientDownloadsCard />
        <div
          v-if="loading"
          class="flex justify-center py-14"
        >
          <span class="loading loading-spinner loading-md" />
        </div>
        <template v-else-if="info">
          <RouterIdentityCard :info="info" />
          <div class="card">
            <ShareRegionsList :info="info" @saved="load" />
            <div class="border-base-300/60 mx-4 border-t" />
            <ShareNodeCodesCard :info="info" />
          </div>
          <LocalRoutingCard :info="info" />
          <ContentFilterCard />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchClientAppInfo, type OpenboxClientAppInfo } from '@/api/clientApp'
import ClientDownloadsCard from '@/components/clientapp/ClientDownloadsCard.vue'
import ContentFilterCard from '@/components/clientapp/ContentFilterCard.vue'
import LocalRoutingCard from '@/components/clientapp/LocalRoutingCard.vue'
import RouterIdentityCard from '@/components/clientapp/RouterIdentityCard.vue'
import ShareNodeCodesCard from '@/components/clientapp/ShareNodeCodesCard.vue'
import ShareRegionsList from '@/components/clientapp/ShareRegionsList.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { showNotification } from '@/helper/notification'
import { onMounted, ref } from 'vue'

const { padding } = usePaddingForViews({ offsetTop: 0, offsetBottom: 0 })

const info = ref<OpenboxClientAppInfo | null>(null)
const loading = ref(true)

const load = async () => {
  try {
    info.value = await fetchClientAppInfo()
  } catch (error) {
    showNotification({
      content: 'clientAppLoadFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>
