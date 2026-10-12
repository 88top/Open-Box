<template>
  <!-- 恢复出厂设置:标题行右上角的红色警示图标,点开是确认弹窗。
       后端 POST /api/openbox/factory-reset:整张表清空(订阅、节点、分流、面板设置、背景图、
       面板密码、登录会话)、统计清零、按随包默认重新播种、内核停掉。不可恢复。 -->
  <div class="inline-flex">
    <button
      type="button"
      class="btn btn-ghost btn-circle btn-xs text-error"
      v-tip="$t('factoryResetTitle')"
      :aria-label="$t('factoryResetTitle')"
      @click="open = true"
    >
      <ExclamationTriangleIcon class="h-5 w-5" />
    </button>

    <DialogWrapper
      v-model="open"
      :title="$t('factoryResetTitle')"
      box-class="w-full max-w-md"
    >
      <div class="flex flex-col gap-3 text-sm">
        <p>{{ $t('factoryResetIntro') }}</p>
        <ul class="text-base-content/70 list-disc pl-5 text-xs leading-relaxed">
          <li>{{ $t('factoryResetItemData') }}</li>
          <li>{{ $t('factoryResetItemRouting') }}</li>
          <li>{{ $t('factoryResetItemPanel') }}</li>
          <li>{{ $t('factoryResetItemStats') }}</li>
        </ul>
        <p class="text-base-content/70 text-xs">{{ $t('factoryResetAfter') }}</p>
        <p class="text-error text-xs font-medium">{{ $t('factoryResetWarning') }}</p>
        <div class="flex justify-end gap-2 pt-1">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="busy"
            @click="open = false"
          >
            {{ $t('cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-error btn-sm"
            :disabled="busy"
            @click="run"
          >
            <span
              v-if="busy"
              class="loading loading-spinner loading-xs"
            />
            {{ $t('factoryResetConfirm') }}
          </button>
        </div>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import { factoryReset } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { showNotification } from '@/helper/notification'
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { ref } from 'vue'

const open = ref(false)
const busy = ref(false)

const run = async () => {
  if (busy.value) return
  busy.value = true
  try {
    await factoryReset()
    showNotification({ content: 'factoryResetDone', type: 'alert-success' })
    // 登录会话和面板密码都被清了:重新载入后面板会像第一次那样让人设密码
    setTimeout(() => window.location.reload(), 1200)
  } catch (error) {
    busy.value = false
    showNotification({
      content: 'factoryResetFailed',
      params: { message: error instanceof Error ? error.message : String(error) },
      type: 'alert-error',
    })
  }
}
</script>
