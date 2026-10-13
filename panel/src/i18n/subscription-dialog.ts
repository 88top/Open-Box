import { LANG } from '@/constant'

// 「添加订阅或节点」弹窗对齐 v0.1.317:全角括号的文案,以及 DoH 填写校验的提示。
// 在 i18n/index.ts 里合并进各语言,同名键覆盖旧文案。
const subscriptionDialogMessages = {
  [LANG.ZH_CN]: {
    subscriptionRenamePrefixLabel: '节点名前加订阅名（如「机场名称 {sep} 香港-01」）',
    subscriptionContentHint:
      '一行一个节点链接（ss:// / trojan:// / vless:// / socks5:// 等）;也支持整段 Clash / sing-box 配置。',
    subscriptionNodeDnsLabel: '节点域名解析（可选）',
    subscriptionNodeDnsNeedUrl: '填了解析 DoH 的 DNS,还要填 DoH 地址',
    subscriptionNodeDnsInvalidUrl: 'DoH 地址要以 https:// 开头',
    subscriptionNodeDnsInvalidBootstrap: '解析 DoH 的 DNS 只能填 IP 地址',
    subscriptionNodeDnsNeedBootstrap: 'DoH 地址是域名,右边要填解析它用的 DNS(IP)',
  },
  [LANG.ZH_TW]: {
    subscriptionNodeDnsNeedUrl: '填了解析 DoH 的 DNS,還要填 DoH 位址',
    subscriptionNodeDnsInvalidUrl: 'DoH 位址要以 https:// 開頭',
    subscriptionNodeDnsInvalidBootstrap: '解析 DoH 的 DNS 只能填 IP 位址',
    subscriptionNodeDnsNeedBootstrap: 'DoH 位址是網域,右邊要填解析它用的 DNS(IP)',
  },
  [LANG.EN_US]: {
    subscriptionNodeDnsNeedUrl: 'A DNS for the DoH host is set; the DoH address is required too',
    subscriptionNodeDnsInvalidUrl: 'The DoH address must start with https://',
    subscriptionNodeDnsInvalidBootstrap: 'The DNS used to resolve the DoH host must be an IP address',
    subscriptionNodeDnsNeedBootstrap:
      'The DoH address is a domain; enter the DNS (IP) used to resolve it on the right',
  },
}

export default subscriptionDialogMessages
