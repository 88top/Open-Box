// 地区组的 DNS 上游:常量和校验照抄 server/engine/dns-upstream.mjs(服务端那份才是准绳,
// 这里只为在请求发出去之前挡掉明显的错)。和路由器「DNS 设置」页的 DNS 上游同一个设计。
import type { OpenboxShareGroupDns } from '@/api/clientApp'

// 记号 wan = 手机此刻所在网络的系统 DNS:固定 UDP 53
export const WAN_UPSTREAM = 'wan'
export const DEFAULT_DNS_PORT = 53
// 每一侧最多几个备用上游(和主上游一起并发竞速)
export const MAX_DNS_EXTRAS = 3

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV6_RE = /^[0-9a-f:]+$/i

export const isDnsIp = (value: string) => {
  const host = String(value ?? '').trim()
  if (!host) return false
  if (IPV4_RE.test(host)) return host !== '0.0.0.0'
  if (!host.includes(':')) return false
  return IPV6_RE.test(host) && host !== '::' && host.split('::').length <= 2 && host.split(':').length <= 8
}

export const isDnsPort = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535

// 两个地区的默认(服务端 regionDnsDefaults):含中国大陆——直连系统 DNS、代理 TCP 1.1.1.1;
// 不含——两侧都是系统 DNS
export const regionDnsDefaults = (region: 'cn' | 'intl'): OpenboxShareGroupDns => ({
  direct: WAN_UPSTREAM,
  directProtocol: 'udp',
  directPort: DEFAULT_DNS_PORT,
  directExtras: [],
  proxy: region === 'intl' ? WAN_UPSTREAM : '1.1.1.1',
  proxyProtocol: region === 'intl' ? 'udp' : 'tcp',
  proxyPort: DEFAULT_DNS_PORT,
  proxyExtras: [],
})
