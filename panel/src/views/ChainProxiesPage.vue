<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      :style="padding"
    >
      <div class="flex flex-col gap-2 px-2 md:py-2">
        <!-- 链式代理:上游是单独的一级页签,不再塞在「出站节点」里 -->
        <ChainProxyManager />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ChainProxyManager from '@/components/subscription/ChainProxyManager.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { loadOpenboxNodeGroups } from '@/store/openboxSiteSets'
import { fetchProxies } from '@/store/proxies'
import { onMounted } from 'vue'

const { padding } = usePaddingForViews({
  offsetTop: 0,
  offsetBottom: 0,
})

// 链式代理编辑器要选节点 / 节点组,这两份数据原本由订阅页挂载时拉取,独立成页后自己拉
onMounted(() => {
  void loadOpenboxNodeGroups()
  void fetchProxies()
})
</script>
