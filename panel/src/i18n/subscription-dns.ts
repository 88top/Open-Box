// v0.1.311 订阅管理页新增/改动的文案:空状态、订阅 DNS 解析(DoH)
export const subscriptionDnsZh = {
  subscriptionEmpty: '还没有订阅。',
  subscriptionNodeDnsToggle: '订阅 DNS 解析',
  subscriptionNodeDnsLabel: '节点域名解析(可选)',
  subscriptionNodeDnsUrlPlaceholder: 'DoH 地址,如 https://dns.example.net:2096/路径',
  subscriptionNodeDnsBootstrapPlaceholder: '解析 DoH 的 DNS(IP)',
  subscriptionNodeDnsHint:
    '机场要求节点域名用它自己的 DoH 解析时填(相当于 OpenClash 的 proxy-server-nameserver / nameserver-policy)。只用来解析这份订阅的节点服务器域名,普通网站和局域网的 DNS 不受影响;测速也按它解析。DoH 地址是域名时,右边要填解析它用的 DNS(IP)。',
}
export const subscriptionDnsZhTw = {
  subscriptionEmpty: '還沒有訂閱。',
  subscriptionNodeDnsToggle: '訂閱 DNS 解析',
  subscriptionNodeDnsLabel: '節點網域解析(可選)',
  subscriptionNodeDnsUrlPlaceholder: 'DoH 位址,如 https://dns.example.net:2096/路徑',
  subscriptionNodeDnsBootstrapPlaceholder: '解析 DoH 的 DNS(IP)',
  subscriptionNodeDnsHint:
    '機場要求節點網域用它自己的 DoH 解析時填(相當於 OpenClash 的 proxy-server-nameserver / nameserver-policy)。只用來解析這份訂閱的節點伺服器網域,一般網站和區域網路的 DNS 不受影響;測速也按它解析。DoH 位址是網域時,右邊要填解析它用的 DNS(IP)。',
}
export const subscriptionDnsEn = {
  subscriptionEmpty: 'No subscriptions yet.',
  subscriptionNodeDnsToggle: 'Subscription DNS',
  subscriptionNodeDnsLabel: 'Node domain resolution (optional)',
  subscriptionNodeDnsUrlPlaceholder: 'DoH address, e.g. https://dns.example.net:2096/path',
  subscriptionNodeDnsBootstrapPlaceholder: 'DNS (IP) to resolve the DoH host',
  subscriptionNodeDnsHint:
    "Fill in when the provider requires its own DoH for node domains (like OpenClash's proxy-server-nameserver / nameserver-policy). It only resolves this subscription's node server domains; ordinary sites and LAN DNS are unaffected, and speed tests use it too. If the DoH address is a domain, enter the DNS (IP) used to resolve it on the right.",
}
