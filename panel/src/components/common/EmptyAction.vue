<template>
  <!-- 列表页没有内容时的空状态:一个淡色大图标、一行说明、一个绿色胶囊的添加按钮。
       链式代理、终端分流这些页共用,样式对齐 v0.1.311 -->
  <div class="flex flex-col items-center gap-4 px-4 py-16 text-center">
    <component
      :is="icon"
      class="text-base-content/30 h-14 w-14"
    />
    <p class="text-base-content/60 text-sm">
      <slot />
    </p>
    <button
      type="button"
      class="btn btn-primary rounded-full"
      @click="emit('action')"
    >
      <PlusIcon class="h-5 w-5" />
      {{ action }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { PlusIcon } from '@heroicons/vue/24/outline'
import type { Component } from 'vue'

defineProps<{
  icon: Component
  action: string
}>()

const emit = defineEmits<{
  action: []
}>()
</script>
