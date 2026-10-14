// 站点集 / 前置自定义分流「规则备注」输入框的占位文字(上游的键名是 routingPolicyRuleNotePlaceholder)。
// 自己合并进 i18n,不依赖别的文案文件。
import { i18n } from '@/i18n'

i18n.global.mergeLocaleMessage('zh-CN', { routingPolicyRuleNotePlaceholder: '备注' })
i18n.global.mergeLocaleMessage('zh-TW', { routingPolicyRuleNotePlaceholder: '備註' })
i18n.global.mergeLocaleMessage('en-US', { routingPolicyRuleNotePlaceholder: 'Note' })
