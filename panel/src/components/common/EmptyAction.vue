<template>
  <!-- 列表页没有内容时的空状态:一个淡色大图标、一行说明、一个绿色添加按钮。
       尺寸、间距、按钮高度与订阅管理的空状态保持一致(py-14 / gap-3 / h-10 图标 / btn-sm) -->
  <div class="flex flex-col items-center gap-3 py-14 text-center">
    <component
      :is="icon"
      class="text-base-content/30 h-10 w-10"
    />
    <p class="text-base-content/60 text-sm">
      <slot />
    </p>
    <button
      type="button"
      class="btn btn-primary btn-sm"
      @click="emit('action')"
    >
      <PlusIcon class="h-4 w-4" />
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
