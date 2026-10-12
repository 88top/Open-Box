// 面板替用户访问外网地址的取法(从 node-info.mjs 抽出来,节点信息和使用教程共用):
//   fetchVia      起一个临时 sing-box(tools fetch),临时配置里只放要用的出站,经指定出站取一个网址
//   fetchByRoute  按目标分流判线路(和规则页、DNS 上游测试同一张表,api/dns-upstream-route.mjs):出口是直连 / 判不出就从
//                 路由器直连取,出口是节点就经那个节点取
//   baseFor       临时实例要的档案和系统 DNS(解析器用直连上游,和 DNS 上游测试的 bootstrap 一样)
// 临时实例的地址族策略和出站标记和内核一致(没开 IPv6 时节点域名不拿 AAAA;Linux 上带标记绕开正在跑的内核)
import { directUpstream, dnsStrategy } from '../engine/dns.mjs'
import { dnsServerEntry } from '../engine/dns-upstream.mjs'
import { builtinTags } from '../engine/user-groups.mjs'
import { PROBE_MARK } from '../system/node-probe.mjs'
import { readSystemDns } from '../system/resolv.mjs'
import { routeForUpstream } from './dns-upstream-route.mjs'
import { upstreamOutbounds } from './node-latency.mjs'

const FETCH_TIMEOUT_MS = 15000
const BOOTSTRAP = 'bootstrap'

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '')
const probeRoute = (platform, route) => (platform === 'linux' ? { ...route, default_mark: PROBE_MARK } : route)

export const createRouteFetcher = ({
  ctx, paths, store, fetchImpl = globalThis.fetch, platform = process.platform,
  systemDnsReader = readSystemDns, routeFor = routeForUpstream, outboundsFor = upstreamOutbounds,
  // 临时配置的文件名前缀(按用途区分,出了问题好认)
  name = 'route-fetch',
} = {}) => {
  let seq = 0

  // timeoutMs / maxBuffer:取大网页(YouTube 频道页 1.3 MB)时放宽;默认和节点信息一样
  const fetchVia = async ({ outbounds = [], endpoints = [], dnsServers = [], via, url, profile, systemDns, timeoutMs = FETCH_TIMEOUT_MS, maxBuffer }) => {
    const configPath = `${paths.etc}/probe/${name}-${process.pid}-${++seq}.json`
    const config = {
      log: { level: 'error', timestamp: false },
      dns: { servers: [dnsServerEntry(directUpstream(profile, { systemDns }), BOOTSTRAP), ...dnsServers], final: BOOTSTRAP, strategy: dnsStrategy(profile) },
      outbounds: [{ type: 'direct', tag: 'direct' }, ...outbounds],
      ...(endpoints.length ? { endpoints } : {}),
      route: probeRoute(platform, { default_domain_resolver: BOOTSTRAP, final: 'direct' }),
    }
    try {
      await ctx.mkdirp(`${paths.etc}/probe`)
      await ctx.writeFile(configPath, JSON.stringify(config))
      const r = await ctx.exec(paths.singbox, ['tools', 'fetch', '-c', configPath, '-o', via, url], { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) })
      if (r.code === 0) return { ok: true, body: String(r.stdout || '') }
      const reason = stripAnsi(r.stderr).split('\n').filter(Boolean).pop() || '超时'
      return { ok: false, error: reason.replace(/^FATAL\[\d+\]\s*/, '').replace(/^Get "[^"]*":\s*/, '').slice(0, 160) }
    } finally {
      // 临时配置里有节点凭据:用完就删
      await ctx.remove(configPath).catch(() => {})
    }
  }

  const baseFor = async () => {
    const profile = store.getProfile ? store.getProfile() || {} : {}
    let systemDns = []
    try { systemDns = await systemDnsReader(ctx) } catch { systemDns = [] }
    return { profile, systemDns }
  }

  // 出口是直连 / 判不出就从路由器直连取;base 不传就现取一份
  const fetchByRoute = async (url, base, options = {}) => {
    const b = base || (await baseFor())
    const host = new URL(url).hostname
    const route = await routeFor({ store, ctx, paths, fetchImpl }, { server: host, port: 443, protocol: 'tcp' })
    if (route.reject) return { ok: false, error: `目标分流拒绝访问 ${host}` }
    const builtin = builtinTags(store.getGroups ? store.getGroups() : [])
    const last = route.chain && route.chain.length ? route.chain[route.chain.length - 1] : ''
    if (route.error || !route.outbound || route.outbound === builtin.direct || last === builtin.direct) return fetchVia({ ...b, ...options, via: 'direct', url })
    let set
    try {
      set = await outboundsFor({ store, fetchImpl, upstream: route.outbound })
    } catch {
      return fetchVia({ ...b, ...options, via: 'direct', url })
    }
    return fetchVia({ ...b, ...options, outbounds: set.outbounds, dnsServers: set.dnsServers, via: set.via, url })
  }

  return { fetchVia, fetchByRoute, baseFor }
}
