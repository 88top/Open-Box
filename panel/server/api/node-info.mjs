// 代理页节点悬停浮层里的「节点信息」(用户 2026-10-11):
//   GET  /api/openbox/node-info/:tag                节点本身:协议 / 传输 / TLS、服务器地址和端口、解析出的 IPv4 / IPv6
//   GET  /api/openbox/node-info/:tag/entry-country  入口 IP 在哪个国家(随包 geoip 一份份解开来查,美国那份路由器上要好几秒,
//                                                   单独一个请求,节点本身先显示出来)
//   POST /api/openbox/node-info/:tag/exit           出口:经这个节点访问 ipv4.ping0.cc/geo 拿出口 IP、属地、ASN 和所有者(ipv6.ping0.cc 查得通
//                                                   就是有 IPv6 出口);再查 proxycheck.io(IP 类型、风控值、同网段设备数)和 RDAP(注册国,和属地比出原生 / 广播)
// 数据源是用户选的「免费组合」:ping0.cc 的 /geo 是它给 curl 用的免费接口(同一 IP 5 秒内超过 3 次会被拉黑),所以只在点开时查、
// 按节点缓存,刷新也有最短间隔;proxycheck.io 免费每天 1000 次;原生 / 广播自己比。
// 线路:出口那一步就是要测这个节点,固定经它(和测速一样,临时配置里只有这个节点,链式节点连同此刻经过的上游);
// proxycheck.io 和 RDAP 是面板替用户访问的地址,按目标分流判线路(和规则页、DNS 上游测试同一套,api/dns-upstream-route.mjs)。
// 临时实例的地址族策略和出站标记和内核一致(没开 IPv6 时节点域名不拿 AAAA;Linux 上带标记绕开正在跑的内核)
import dns from 'node:dns/promises'
import express from 'express'
import net from 'node:net'
import { emitEndpoint } from '../engine/emit-endpoint.mjs'
import { emitOutbound } from '../engine/emit-outbound.mjs'
import { chainNodes } from '../engine/chain-proxy.mjs'
import { FALLBACK_REGION_DICT } from '../engine/countries.mjs'
import { matchRegion } from '../engine/rename.mjs'
import { readSystemDns } from '../system/resolv.mjs'
import { ipCountry } from '../system/router-region.mjs'
import { routeForUpstream } from './dns-upstream-route.mjs'
import { upstreamOutbounds } from './node-latency.mjs'
import { createRouteFetcher } from './route-fetch.mjs'
import { activeNodes } from './subscriptions.mjs'

// 两个子域名各只有一种地址:经节点访问 ipv4 的拿到 IPv4 出口,ipv6 的通了就是节点有 IPv6 出口。直接用 ping0.cc 的话
// 节点那头多半先解析成 IPv6,主出口就成了 IPv6(开发路由器上的 AWS 东京节点就是)
export const EXIT_GEO_URLS = Object.freeze({ v4: 'https://ipv4.ping0.cc/geo', v6: 'https://ipv6.ping0.cc/geo' })
export const proxycheckUrl = (ip) => `https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1&risk=1`
export const rdapUrl = (ip) => `https://rdap.arin.net/registry/ip/${encodeURIComponent(ip)}`
// 出口结果按节点缓存 6 小时;手动刷新同一个节点至少隔 15 秒(ping0.cc 的限流按出口 IP 算)
export const EXIT_CACHE_MS = 6 * 60 * 60 * 1000
export const EXIT_REFRESH_MIN_MS = 15 * 1000
const RESOLVE_TIMEOUT_MS = 4000

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

// ping0.cc/geo 回四行:IP、属地(带运营商)、ASN、ASN 所有者
export const parseExitGeo = (text) => {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const ip = lines[0] || ''
  if (!net.isIP(ip)) return null
  return { ip, location: lines[1] || '', asn: /^AS\d+$/i.test(lines[2] || '') ? lines[2].toUpperCase() : '', asnOwner: lines[3] || '' }
}

// proxycheck.io 的 type → 界面上的 IP 类型。没开代理的是 Residential / Wireless / Business / Hosting;判成代理的回 VPN / TOR 这类,
// 这种出口一般在机房里,按机房算、另把代理类型带出去
const IP_TYPES = { residential: 'residential', wireless: 'mobile', business: 'business', hosting: 'hosting' }
export const parseProxycheck = (text, ip) => {
  let data = null
  try { data = JSON.parse(text) } catch { return null }
  const entry = data && typeof data === 'object' ? data[ip] : null
  if (!entry || typeof entry !== 'object') return null
  const raw = String(entry.type || '')
  const proxy = String(entry.proxy || '').toLowerCase() === 'yes'
  const ipType = IP_TYPES[raw.toLowerCase()] || (proxy || raw ? 'hosting' : '')
  const risk = Number(entry.risk)
  const devices = Number(entry.devices && entry.devices.subnet)
  return {
    ipType,
    proxyType: proxy ? raw : '',
    risk: Number.isFinite(risk) ? risk : null,
    devices: Number.isFinite(devices) ? devices : null,
    country: /^[A-Z]{2}$/.test(String(entry.isocode || '')) ? entry.isocode : '',
    provider: String(entry.provider || ''),
  }
}

// RDAP 网段登记的国家(两位代码);不少登记里没有 country,那就判不出原生 / 广播
export const parseRdapCountry = (text) => {
  try {
    const country = String(JSON.parse(text).country || '').toUpperCase()
    return /^[A-Z]{2}$/.test(country) ? country : ''
  } catch {
    return ''
  }
}

const findNode = (store, tag) => {
  const profile = store.getProfile ? store.getProfile() || {} : {}
  return activeNodes(store).find((n) => n.tag === tag) || chainNodes(profile).find((n) => n.tag === tag) || null
}

// 界面上显示的协议:类型 + TLS(Reality / TLS)+ 传输层(ws / grpc…);flow 是 vision 时也带上
const describeProtocol = (outbound) => {
  const parts = [String(outbound.type || '')]
  if (outbound.tls && outbound.tls.enabled) parts.push(outbound.tls.reality && outbound.tls.reality.enabled ? 'reality' : 'tls')
  if (outbound.transport && outbound.transport.type) parts.push(outbound.transport.type)
  if (outbound.flow) parts.push(outbound.flow)
  return parts.filter(Boolean)
}

export const registerNodeInfoRoutes = (app, {
  ctx, paths, store, fetchImpl = globalThis.fetch, platform = process.platform, now = () => Date.now(),
  resolve4 = (host) => dns.resolve4(host), resolve6 = (host) => dns.resolve6(host),
  countryOf = (ip, first) => ipCountry({ ctx, paths, ip, first }),
  systemDnsReader = readSystemDns, routeFor = routeForUpstream, outboundsFor = upstreamOutbounds,
} = {}) => {
  const router = express.Router()
  router.use(express.json({ limit: '16kb' }))
  const exitCache = new Map() // tag → { key, at, data }
  const countryCache = new Map() // ip → 'HK'
  // 同一时刻只查一个节点的出口:几个临时进程一起跑路由器吃不消,也免得撞 ping0.cc 的限流
  let exitChain = Promise.resolve()

  // 按随包 geoip 一份份解开来查,路由器上一份就要好几百毫秒:先查节点名里认得出的地区(「美国-01」先查 us),一般一次就中
  const regionHint = (node) => {
    const region = matchRegion(String(node.originalTag || node.tag || ''), FALLBACK_REGION_DICT)
    return region ? [region.code] : []
  }
  const lookupCountry = async (ip, first = []) => {
    if (countryCache.has(ip)) return countryCache.get(ip)
    const cc = await countryOf(ip, first).catch(() => '')
    if (cc) countryCache.set(ip, cc)
    return cc
  }

  // 经指定出站 / 按目标分流取网址:和使用教程共用一份(api/route-fetch.mjs)
  const { fetchVia, fetchByRoute } = createRouteFetcher({ ctx, paths, store, fetchImpl, platform, systemDnsReader, routeFor, outboundsFor, name: 'node-info' })

  // 这个节点自己(链式节点连同此刻经过的上游);WireGuard 节点在内核里是 endpoint
  const nodeTargets = async (node) => {
    if (node.type === 'wireguard') return { via: node.tag, outbounds: [], endpoints: [emitEndpoint(node)], dnsServers: [] }
    const set = await outboundsFor({ store, fetchImpl, upstream: node.tag })
    return { via: set.via, outbounds: set.outbounds, endpoints: [], dnsServers: set.dnsServers }
  }

  router.get('/node-info/:tag', async (req, res) => {
    const node = findNode(store, String(req.params.tag || ''))
    if (!node) return res.status(404).json({ error: '找不到这个节点(只有订阅节点和链式代理能看)' })
    let outbound = null
    try {
      outbound = node.type === 'wireguard' ? { type: 'wireguard' } : emitOutbound(node)
    } catch (err) {
      return res.status(400).json({ error: `生成不出这个节点的出站:${(err && err.message) || err}` })
    }
    const server = String(node.server || '')
    const addresses = { v4: [], v6: [] }
    let resolveError = ''
    if (net.isIPv4(server)) addresses.v4.push(server)
    else if (net.isIPv6(server)) addresses.v6.push(server)
    else if (server) {
      const [v4, v6] = await Promise.allSettled([withTimeout(resolve4(server), RESOLVE_TIMEOUT_MS), withTimeout(resolve6(server), RESOLVE_TIMEOUT_MS)])
      if (v4.status === 'fulfilled') addresses.v4 = [...new Set(v4.value)].slice(0, 8)
      if (v6.status === 'fulfilled') addresses.v6 = [...new Set(v6.value)].slice(0, 8)
      if (!addresses.v4.length && !addresses.v6.length) resolveError = `解析不出 ${server} 的地址`
    }
    const first = addresses.v4[0] || addresses.v6[0] || ''
    const entryCountry = (first && countryCache.get(first)) || ''
    res.json({
      tag: node.tag,
      type: node.type,
      protocol: describeProtocol(outbound),
      server,
      port: Number(node.server_port) || null,
      ...(node.detour ? { detour: node.detour } : {}),
      addresses,
      entryCountry,
      ...(resolveError ? { resolveError } : {}),
    })
  })

  // 入口 IP 的国家:只查第一个地址(和界面上标国旗的那个一致)
  router.get('/node-info/:tag/entry-country', async (req, res) => {
    const node = findNode(store, String(req.params.tag || ''))
    if (!node) return res.status(404).json({ error: '找不到这个节点(只有订阅节点和链式代理能看)' })
    const server = String(node.server || '')
    let ip = net.isIP(server) ? server : ''
    if (!ip && server) {
      const [v4, v6] = await Promise.allSettled([withTimeout(resolve4(server), RESOLVE_TIMEOUT_MS), withTimeout(resolve6(server), RESOLVE_TIMEOUT_MS)])
      ip = (v4.status === 'fulfilled' && v4.value[0]) || (v6.status === 'fulfilled' && v6.value[0]) || ''
    }
    res.json({ ip, country: ip ? await lookupCountry(ip, regionHint(node)) : '' })
  })

  router.post('/node-info/:tag/exit', async (req, res) => {
    const tag = String(req.params.tag || '')
    const node = findNode(store, tag)
    if (!node) return res.status(404).json({ error: '找不到这个节点(只有订阅节点和链式代理能看)' })
    // 节点换了服务器 / 端口 / 上游就不用旧结果
    const key = JSON.stringify([node.type, node.server, node.server_port, node.detour || ''])
    const cached = exitCache.get(tag)
    const refresh = Boolean(req.body && req.body.refresh)
    if (cached && cached.key === key) {
      const age = now() - cached.at
      if (!refresh && age < EXIT_CACHE_MS) return res.json({ ...cached.data, cached: true })
      if (refresh && age < EXIT_REFRESH_MIN_MS) return res.json({ ...cached.data, cached: true })
    }
    const job = exitChain.then(async () => {
      const profile = store.getProfile ? store.getProfile() || {} : {}
      let systemDns = []
      try { systemDns = await systemDnsReader(ctx) } catch { systemDns = [] }
      const base = { profile, systemDns }
      let targets
      try {
        targets = await nodeTargets(node)
      } catch (err) {
        return { status: 409, body: { error: (err && err.message) || String(err) } }
      }
      const [res4, res6] = await Promise.all([fetchVia({ ...base, ...targets, url: EXIT_GEO_URLS.v4 }), fetchVia({ ...base, ...targets, url: EXIT_GEO_URLS.v6 })])
      const geo4 = res4.ok ? parseExitGeo(res4.body) : null
      const geo6 = res6.ok ? parseExitGeo(res6.body) : null
      const v4 = geo4 && net.isIPv4(geo4.ip) ? geo4 : null
      const v6 = geo6 && net.isIPv6(geo6.ip) ? geo6 : null
      // 主出口按 IPv4 算(风控值这些都按它查);只有 IPv6 出口的节点才拿 IPv6 那个当主出口
      const geo = v4 || v6
      if (!geo) return { status: 502, body: { error: res4.ok ? 'ping0.cc 返回的不是出口信息' : `经这个节点访问 ping0.cc 失败:${res4.error}` } }
      const [pcRes, rdapRes] = await Promise.all([fetchByRoute(proxycheckUrl(geo.ip), base), fetchByRoute(rdapUrl(geo.ip), base)])
      const pc = pcRes.ok ? parseProxycheck(pcRes.body, geo.ip) : null
      const registeredCountry = rdapRes.ok ? parseRdapCountry(rdapRes.body) : ''
      const country = (pc && pc.country) || (await lookupCountry(geo.ip, regionHint(node)))
      const errors = {}
      if (!pc) errors.proxycheck = pcRes.ok ? 'proxycheck.io 返回的不是这个 IP 的信息' : pcRes.error
      if (!rdapRes.ok) errors.rdap = rdapRes.error
      const data = {
        ok: true,
        at: now(),
        ...geo,
        ipv6: v6 ? v6.ip : '',
        country,
        ipType: pc ? pc.ipType : '',
        proxyType: pc ? pc.proxyType : '',
        risk: pc ? pc.risk : null,
        devices: pc ? pc.devices : null,
        registeredCountry,
        native: registeredCountry && country ? registeredCountry === country : null,
        ...(Object.keys(errors).length ? { errors } : {}),
      }
      exitCache.set(tag, { key, at: data.at, data })
      return { status: 200, body: data }
    })
    exitChain = job.catch(() => {})
    let out
    try {
      out = await job
    } catch (err) {
      out = { status: 500, body: { error: (err && err.message) || String(err) } }
    }
    res.status(out.status).json(out.body)
  })

  app.use('/api/openbox', router)
}
