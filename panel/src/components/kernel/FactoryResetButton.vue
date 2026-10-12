<template>
  <!-- 恢复出厂设置:标题行右上角的红色警示图标,点开是确认弹窗(对齐 v0.1.317:标题 + 两段说明 +
       「取消 / 确定(7)」,确定要倒数 7 秒才能点)。
       后端 POST /api/openbox/factory-reset:整张表清空(订阅、节点、分流、面板设置、背景图、
       面板密码、登录会话)、统计清零、按随包默认重新播种、内核停掉。不可恢复。 -->
  <div class="inline-flex">
    <button
      type="button"
      class="btn btn-ghost btn-circle btn-sm text-error"
      v-tip="$t('factoryResetTitle')"
      :aria-label="$t('factoryResetTitle')"
      @click="open = true"
    >
      <ExclamationTriangleIcon class="h-4 w-4" />
    </button>

    <DialogWrapper
      v-model="open"
      box-class="w-full max-w-lg"
      content-class="pb-2"
    >
      <div class="flex flex-col">
        <div class="border-base-content/10 relative border-b pb-2">
          <h3 class="pr-8 text-base font-bold">{{ $t('factoryResetTitle') }}</h3>
          <button
            type="button"
            class="btn btn-circle btn-ghost btn-xs absolute top-0 right-0"
            aria-label="close"
            @click="open = false"
          >
            <XMarkIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="mt-4 flex flex-col gap-3">
          <p class="text-sm">{{ $t('factoryResetIntro') }}</p>
          <p class="text-base-content/60 text-xs">{{ $t('factoryResetDetail') }}</p>
        </div>
        <div class="border-base-content/10 mt-4 flex items-center justify-end gap-2 border-t pt-2">
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
            :disabled="busy || countdown > 0"
            @click="run"
          >
            <span
              v-if="busy"
              class="loading loading-spinner loading-xs"
            />
            {{ countdown > 0 ? `${$t('confirm')} (${countdown})` : $t('confirm') }}
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
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { onBeforeUnmount, ref, watch } from 'vue'

// 危险操作:每次打开都先倒数 7 秒,倒数完才能点「确定」
const COUNTDOWN_SECONDS = 7

const open = ref(false)
const busy = ref(false)
const countdown = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

const stop = () => {
  if (timer) clearInterval(timer)
  timer = null
}

watch(open, (isOpen) => {
  stop()
  if (!isOpen) return
  countdown.value = COUNTDOWN_SECONDS
  timer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) stop()
  }, 1000)
})

onBeforeUnmount(stop)

const run = async () => {
  if (busy.value || countdown.value > 0) return
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
