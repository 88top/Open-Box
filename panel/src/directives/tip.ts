import { useTooltip } from '@/helper/tooltip'
import type { Directive } from 'vue'
import type { Props } from 'tippy.js'

// v-tip="文字":鼠标悬停显示全局统一样式的提示(tippy),取代各处零散的 title=。
// 值为空时不显示。
// v-tip.contain="文字":提示框限制在所在卡片(.card)内,右边界不会超出卡片;提示框被推回卡片内时,
// 箭头仍对着触发按钮(靠近提示框右端),不会错位。
const { showTip, hideTip } = useTooltip()
const KEY = '__tipText'
type TipEl = HTMLElement & { [KEY]?: string; __tipBound?: boolean; __tipContain?: boolean }

const containConfig = (el: HTMLElement): Partial<Props> => {
  const boundary = el.closest<HTMLElement>('.card')
  if (!boundary) return {}
  return {
    popperOptions: {
      modifiers: [
        { name: 'preventOverflow', options: { boundary, padding: 4 } },
        { name: 'flip', options: { fallbackPlacements: ['top', 'bottom'] } },
      ],
    },
  }
}

const tip: Directive<TipEl, string | undefined> = {
  mounted(el, binding) {
    el[KEY] = binding.value
    el.__tipContain = !!binding.modifiers.contain
    if (el.__tipBound) return
    el.__tipBound = true
    el.addEventListener('mouseenter', (e) => {
      if (el[KEY]) showTip(e, el[KEY]!, el.__tipContain ? containConfig(el) : {})
    })
    el.addEventListener('mouseleave', () => hideTip())
  },
  updated(el, binding) {
    el[KEY] = binding.value
    el.__tipContain = !!binding.modifiers.contain
  },
}

export default tip
