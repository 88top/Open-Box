<template>
  <div class="ctrls-bar">
    <!-- 概览页顶栏:左边是面板版本号(加粗),右边是内核版本号(淡色、靠右)。
         两段文字都由后端给出(activation 接口的 defaults),不依赖是否「激活」。 -->
    <div class="app-card-padding flex h-12 flex-row items-center gap-2 overflow-hidden text-sm">
      <span class="truncate font-semibold">{{ left }}</span>
      <span class="text-base-content/70 ml-auto truncate">{{ right }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchActivation } from '@/api/clientApp'
import { useCtrlsBar } from '@/composables/useCtrlsBar'
import { onMounted, ref } from 'vue'

useCtrlsBar()

const left = ref('')
const right = ref('')

onMounted(async () => {
  try {
    const { defaults } = await fetchActivation()
    left.value = defaults.left
    right.value = defaults.right
  } catch {
    // 取不到(没连后端 / 未登录)就留空,不影响页面其余部分
  }
})
</script>
