// 设置页顶部「链式代理」页签的名字(上游的键名是 chainProxyTab)。
// 单独成键:卡片标题继续用 chainTitle,页签名各语言各自写。自己合并进 i18n,不依赖别的文案文件。
import { i18n } from '@/i18n'

i18n.global.mergeLocaleMessage('zh-CN', { chainProxyTab: '链式代理' })
i18n.global.mergeLocaleMessage('zh-TW', { chainProxyTab: '鏈式代理' })
i18n.global.mergeLocaleMessage('en-US', { chainProxyTab: 'Chain proxy' })
