<template>
  <div
    ref="menuRef"
    class="settings-menu scrollbar-hidden ctrls-bar app-card-padding"
    @touchstart.passive.stop
    @touchmove.passive.stop
    @touchend.passive.stop
  >
    <!-- 页签靠左、各自按内容取宽,不两端拉伸;右侧 #settings-header-actions 是各页签
         把自己的操作按钮(添加订阅、自动分组…)Teleport 过来的位置,位置固定在右上角 -->
    <div class="flex w-full items-center gap-2">
      <ul
        ref="listRef"
        class="menu menu-horizontal settings-menu-list scrollbar-hidden flex min-w-0 flex-1 flex-nowrap gap-2 overflow-x-auto bg-transparent p-0"
        :style="fadeStyle"
        @scroll.passive="updateFade"
        @wheel="onWheel"
      >
        <li
          v-for="item in menuItems"
          :key="item.key"
          class="settings-menu-slot min-w-fit"
        >
          <button
            :ref="(el) => setMenuItemRef(el as HTMLButtonElement | null, item.key)"
            type="button"
            :data-key="item.key"
            :id="`menu-item-${item.key}`"
            class="settings-menu-btn w-full"
            :class="[activeMenuKey === item.key ? 'menu-active' : '']"
            @click="handleMenuClick(item.key)"
          >
            <component
              :is="item.icon"
              class="h-5 w-5 shrink-0"
            />
            <span class="hidden truncate text-sm md:block">
              {{ $t(item.label) }}
            </span>
          </button>
        </li>
      </ul>
      <div
        id="settings-header-actions"
        class="ml-auto flex shrink-0 items-center gap-2"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useCtrlsBar } from '@/composables/useCtrlsBar'
import type { Component } from 'vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// key 故意放宽成 string:这个条形菜单原本只服务于面板设置内部的分组
// (SETTINGS_MENU_KEY),现在改为驱动设置页的一级页签(SETTINGS_TAB)。两者是不同
// 的枚举,组件本身并不关心具体是哪一个,只负责"渲染一排、点哪个发哪个 key"。
type MenuItem = {
  key: string
  label: string
  icon: Component
}

const props = defineProps<{
  menuItems: MenuItem[]
  activeMenuKey: string
}>()

const emit = defineEmits<{
  (e: 'menu-click', key: string): void
}>()

const menuRef = ref<HTMLDivElement>()
const menuItemRefs = ref(new Map<string, HTMLButtonElement>())

useCtrlsBar()

const setMenuItemRef = (el: HTMLButtonElement | null, key: string) => {
  if (!el) {
    menuItemRefs.value.delete(key)
    return
  }

  menuItemRefs.value.set(key, el)
}

// 页签一多(手机上七个图标 + 右上角按钮)一屏放不下,靠 ul 的 overflow-x-auto 横向滑动。
// 原来这里用 useSwipe 做"手指划过哪个页签就切到哪个",它的 passive:false 会把 touchmove
// preventDefault 掉,原生横向滚动就被吞了,后面的页签永远划不出来——两者只能留一个,
// 留滚动。外层的 @touchstart/@touchmove .stop 仍然保留:别让页面级的左右滑动切页抢走手势。
const handleMenuClick = (key: string) => {
  emit('menu-click', key)
}

// 切换页签时把当前页签滚到正中间。最后几个页签(DNS / 后端设置)滚不到中间,就自然靠右停住,
// 不会被挤出屏幕;和上游 v0.1.315 一样
watch(
  () => props.activeMenuKey,
  (key) => {
    const el = menuItemRefs.value.get(key)
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  },
  { flush: 'post' },
)

// 页签条两端的渐隐遮罩:左边滚出去了就左边渐隐,右边还有就右边渐隐,提示还能继续滑
const listRef = ref<HTMLUListElement>()
const fadeLeft = ref(false)
const fadeRight = ref(false)
const FADE_PX = 28
const updateFade = () => {
  const el = listRef.value
  if (!el) return
  fadeLeft.value = el.scrollLeft > 1
  fadeRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}
const fadeStyle = computed(() => {
  if (!fadeLeft.value && !fadeRight.value) return undefined
  const left = fadeLeft.value ? `transparent 0, #000 ${FADE_PX}px` : '#000 0'
  const right = fadeRight.value ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : '#000 100%'
  const mask = `linear-gradient(to right, ${left}, ${right})`
  return { maskImage: mask, WebkitMaskImage: mask }
})

// 鼠标滚轮(竖向)转成页签条的横向滚动;触摸板本来就是横向的,不动它
const onWheel = (e: WheelEvent) => {
  const el = listRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
  e.preventDefault()
  el.scrollLeft += e.deltaY
}

let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  const el = listRef.value
  if (el) {
    resizeObserver = new ResizeObserver(updateFade)
    resizeObserver.observe(el)
  }
  // 首次进入时,当前页签直接居中(不做动画),不然停在最左边会看不到靠后的页签
  menuItemRefs.value.get(props.activeMenuKey)?.scrollIntoView({ block: 'nearest', inline: 'center' })
  updateFade()
})
onBeforeUnmount(() => resizeObserver?.disconnect())

const getMenuHeight = () => {
  return menuRef.value?.offsetHeight || 0
}

defineExpose({
  getMenuHeight,
})
</script>
