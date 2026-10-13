import { LANG } from '@/constant'
import { language } from '@/store/settings'
import { createI18n } from 'vue-i18n'
import en from './en'
import zh from './zh'
import overviewMessages from './overview'
import subscriptionDialogMessages from './subscription-dialog'
import zhTW from './zh-tw'

export const i18n = createI18n({
  legacy: false,
  locale: language.value,
  messages: {
    [LANG.EN_US]: en,
    [LANG.ZH_CN]: zh,
    [LANG.ZH_TW]: zhTW,
  },
})

// 后加的文案放在单独的文件里,启动时合并进各语言,不去动三份大词典
for (const [locale, messages] of Object.entries(overviewMessages)) {
  i18n.global.mergeLocaleMessage(locale, messages as Record<string, string>)
}
for (const [locale, messages] of Object.entries(subscriptionDialogMessages)) {
  i18n.global.mergeLocaleMessage(locale, messages as Record<string, string>)
}
