import { FLIP_FALLBACK_TAG, flattenFlipRule, flipFlagOfRule } from '../engine/flip.mjs'
import { readFlipState } from '../system/flip-files.mjs'
import express from 'express'
import { promises as dnsPromises } from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import { DNS_INBOUND_PORT, PANEL_INBOUND_PORT, PANEL_INBOUND_TAG } from '../engine/config.mjs'
import { CLASH_API_BASE, hasDestinationCondition, matchLocalConditions, matchRuleSetsByDomain } from './penetration.mjs'
import { cidrContains } from '../system/local-subnets.mjs'
import { fetchSelections } from './deploy-runner.mjs'
import { flushDnsCache } from '../system/dns-cache.mjs'
import { detectChallenge, parseHeaderBlock, pickProbeHeaders } from '../system/http-challenge.mjs'
import { builtinTags } from '../engine/user-groups.mjs'
import { connectionOwner } from '../engine/rule-owner.mjs'
import { normalizeRouting, stripNoDomainGuardText } from '../engine/routing-model.mjs'
import { normalizeProbeMethod } from '../system/probe-method.mjs'
import { DNS_REWRITE_TAG, matchRewrite, normalizeDnsRewrite } from '../engine/dns-rewrite.mjs'
import { isProxyResolverTag } from '../engine/dns.mjs'
import { macForIp } from './traffic.mjs'

// 「真实路由」:不只按规则推,而是真的走一遍——
//   1. DNS 用哪台服务器:按生成配置里 dns.rules 的顺序判(规则集先用进程内索引比,答不了的才用内核 rule-set match,
//      域名条件本地比),得到 dns-direct(直连解析)还是某个带 detour 的代理 DNS;
//   2. 解析结果:向内核的 DNS 入站(127.0.0.1:7853)发一次真正的查询,和终端(dnsmasq 转过来的)走同一个入口,拿到的
//      就是终端会拿到的答案(见 kernelDnsQuery);
//   3. 实际出口:面板进程在路由器上真发一个 HTTPS 请求(会经过 tun 进内核),然后到
//      clash_api /connections 里找这条连接,读它实际走的链路和命中的规则;顺带记耗时。
const TARGET_PATTERN = /^[A-Za-z0-9._:-]+$/
const isValidTarget = (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('-') && TARGET_PATTERN.test(v)
const isIp = (v) => net.isIP(String(v)) !== 0
// host:port 的写法:IPv6 字面量要加方括号(RFC 3986 §3.2.2),否则 "2001:db8::1:80" 分不出端口
export const hostPort = (host, port) => (net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`)
// URL 里的 host 部分:IPv6 同样加括号;默认端口不写
export const targetUrl = (host, port, secure) => {
  const h = net.isIPv6(host) ? `[${host}]` : host
  const defaultPort = secure ? 443 : 80
  return `${secure ? 'https' : 'http'}://${h}${port === defaultPort ? '' : `:${port}`}/`
}
// 诊断同时识别本机 198.19/16 和上游 Clash 常用的 198.18/16；198.15/16 是公网地址。
// 使用实际 CIDR 边界，不能把整个 fc00::/7 的内网地址都误报成 FakeIP。
export const isFakeIp = (ip) => net.isIP(String(ip)) !== 0
  && ['198.18.0.0/15', 'fc00::/18'].some((cidr) => cidrContains(cidr, ip))
const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

const fetchWithTimeout = async (fetchImpl, url, init = {}, timeoutMs = 8000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// dns.rules 里每条的条件和 route.rules 同一套写法(rule_set / domain / domain_suffix / domain_keyword /
// source_ip_cidr)。带来源条件的规则要有终端来源 IP 才判得了;没给时不中断,记成前提(按不在该来源里的
// 终端推算)继续往下,前提原样回给前端列出来
// rewriteRules:档案里的 DNS 重写规则(engine/dns-rewrite.mjs 归一化后的);命中 dns-rewrite 服务器时把命中的
// 那条(源 / 目标)一并回给前端,规则页画成「原域名 → 目标」
// ignoreServers:跳过指向这些解析器的规则——重写服务要知道「没有重写时这个域名会怎么判」,就把 dns-rewrite 那条跳过
export const decideDnsServer = async (ctx, paths, config, target, { sourceIp = '', sourceMac = '', rewriteRules = [], ignoreServers = [], flipState } = {}) => {
  // 热切换结构(engine/flip.mjs)里每个站点集两支规则都在:挂着开关的代理支此刻算不算数,看已部署的开关状态。
  // 开关 OFF 的那条跳过,ON 的展平成普通规则再判;不是热切换结构时开关表是空的,下面和以前一样
  const flags = flipState || await readFlipState(ctx, paths)
  const dns = config.dns || {}
  const ignored = new Set(ignoreServers)
  const servers = new Map((dns.servers || []).map((s) => [s.tag, s]))
  const srsPathByTag = new Map(((config.route || {}).rule_set || []).map((r) => [r.tag, r.path]))
  const rules = dns.rules || []
  // 内核自己的 fakeip 规则(engine/dns.mjs 的 FakeIP 原型):A / AAAA 先拿占位地址,真正的解析发生在
  // 连接时选中的节点那头。判定时把它记成 fakeIpRule 后继续往下找同一个匹配的真解析器(其它查询
  // 类型仍走它),两边一起给前端画
  let fakeIpRule
  const assumed = []
  // 返回时给每条前提标 sameOutcome:它命中时用的解析器 / 拒绝,和这里判出来的结果是不是一样(一样的前端不提示)
  const withFake = (r0) => {
    let r = r0
    if (r.server && r.server.tag === DNS_REWRITE_TAG) {
      const hit = matchRewrite(rewriteRules, target)
      r = { ...r, rewrite: hit ? { source: hit.source, domain: hit.domain, addresses: hit.addresses } : { source: '', domain: '', addresses: [] } }
    }
    const out = fakeIpRule === undefined ? r : { ...r, fakeIpRule }
    if (!assumed.length) return out
    const finalized = assumed.map((a) => ({ ...a, sameOutcome: a.action === 'reject' ? Boolean(r.rejected) : Boolean(r.server && a.server === r.server.tag) }))
    return { ...out, assumed: finalized }
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = flattenFlipRule(rules[i], flags)
    if (!rule || typeof rule !== 'object') continue
    if (rule.server && ignored.has(rule.server)) continue
    // 只管某些查询类型、又不含 A 的规则(代理 v6 降为 IPv4 时给走代理的域名回空 AAAA 的 predefined 那条)和这里
    // 无关:规则页推算的是「这个域名的 A 查询由谁解析」
    if (Array.isArray(rule.query_type) && rule.query_type.length && !rule.query_type.includes('A')) continue
    const hasDest = hasDestinationCondition(rule)
    // 来源条件:按 IP(source_ip_cidr)或按 MAC(source_mac_address,终端分流的 MAC 页签)
    const hasSourceIp = Object.prototype.hasOwnProperty.call(rule, 'source_ip_cidr')
    const hasSourceMac = Object.prototype.hasOwnProperty.call(rule, 'source_mac_address')
    const hasSource = hasSourceIp || hasSourceMac
    const fake = rule.server && (servers.get(rule.server) || {}).type === 'fakeip'
    // 热切换结构里兜底的代理支:去掉开关后没有任何条件、只有解析器——开关 ON 时它就是「上面都没命中的全走这里」
    if (rule !== rules[i] && !hasDest && !hasSource && !fake && rule.server) {
      const server = servers.get(rule.server) || { tag: rule.server }
      return withFake({ ruleIndex: i, server, viaProxy: isProxyResolverTag(server.tag) })
    }
    if (!hasDest && !hasSource && !fake) continue
    if (hasSourceIp && sourceIp) {
      const list = Array.isArray(rule.source_ip_cidr) ? rule.source_ip_cidr : [rule.source_ip_cidr]
      if (!list.some((c) => cidrContains(c, sourceIp))) continue
    }
    if (hasSourceMac && sourceMac) {
      const list = [].concat(rule.source_mac_address).map((m) => String(m).toLowerCase())
      if (!list.includes(sourceMac)) continue
    }
    let hit = !hasDest
    if (hasDest && matchLocalConditions(rule, target)) hit = true
    else if (hasDest && Object.prototype.hasOwnProperty.call(rule, 'rule_set')) {
      // 规则集按域名比走进程内索引(penetration.mjs 的 matchRuleSetsByDomain),解不开的才起内核进程
      const r = await matchRuleSetsByDomain(ctx, paths, srsPathByTag, [].concat(rule.rule_set), target)
      if (r.error) return { error: `dns rule #${i + 1}: ${r.error}` }
      hit = r.hit
    }
    if (!hit) continue
    // 目标这一组命中了、但规则还要看来源而这次没给:记成前提,按不在该来源里的终端继续
    if ((hasSourceIp && !sourceIp) || (hasSourceMac && !sourceMac)) {
      const a = hasSourceMac
        ? { ruleIndex: i, needs: ['sourceMac'], sourceMac: [].concat(rule.source_mac_address) }
        : { ruleIndex: i, needs: ['sourceIp'], sourceIpCidr: [].concat(rule.source_ip_cidr) }
      if (rule.server !== undefined) a.server = rule.server
      if (rule.action !== undefined) a.action = rule.action
      assumed.push(a)
      continue
    }
    if (rule.action === 'reject') return withFake({ ruleIndex: i, rejected: true })
    if (fake) {
      if (fakeIpRule === undefined) fakeIpRule = i
      continue
    }
    const server = servers.get(rule.server) || { tag: rule.server }
    return withFake({ ruleIndex: i, server, viaProxy: isProxyResolverTag(server.tag) })
  }
  const server = servers.get(dns.final) || { tag: dns.final || '' }
  return withFake({ ruleIndex: null, server, viaProxy: isProxyResolverTag(server.tag) })
}

const clashHeaders = (secret) => (secret ? { Authorization: `Bearer ${secret}` } : {})

// 内核诊断的解析:向内核的 DNS 入站发一次真正的查询(UDP),和终端(dnsmasq 转过来的)走同一个入口。以前问的是
// clash_api 的 /dns/query——那条查询不经过任何入站、没有网络类型,热切换开关那几份规则集(开着时内容是
// network: tcp / udp)一律不命中,走代理的域名全落到最后的直连 DNS:开着 FakeIP 也拿到直连上游的答案(国内多半是
// 污染过的地址;开发路由器的上游本身也发 198.19 的占位地址,连过去被内核换成别的域名),探测连过去自然失败。
// 回 [{ address, ttl }];没有记录(NXDOMAIN / 没有这类记录)回空数组,别的错误抛出
export const kernelDnsQuery = async (name, type = 'A', { port = DNS_INBOUND_PORT, timeoutMs = 5000 } = {}) => {
  const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setServers([`127.0.0.1:${port}`])
  try {
    const records = type === 'AAAA' ? await resolver.resolve6(name, { ttl: true }) : await resolver.resolve4(name, { ttl: true })
    return records.map((r) => ({ address: r.address, ttl: r.ttl }))
  } catch (err) {
    if (err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND')) return []
    throw err
  }
}

// 经内核的回环 mixed 入站发一次真实请求:CONNECT 目标:port → (加密时再套 TLS)→ GET / HEAD /。
// method 和模拟终端同一套(system/probe-method.mjs):TCP = CONNECT 被内核接下就算通(和终端的 TCP 一样只到内核为止);
// TLS = 握手完成;GET / HEAD = 读到状态码。
// 走这条路请求才会像客户端流量一样过内核的分流规则,连接表里也就能找到它。
// connectTo:终端都是先解析再按 IP 去连的,探测也一样——CONNECT 的目标写解析出来的 IP,
// TLS 的 SNI / HTTP 的 Host 仍是域名,内核靠嗅探拿到域名去匹配规则(和 tun 里的终端流量一样)。
// 这一点决定了节点那头拿到的是 IP 还是域名:内核不改写目标(sniff 不带 override_destination),
// 节点拿到的就是这个 IP,按它直接连,不会再解析一次;拿到域名才会在节点那边再解析。
// 只读响应首行,拿到状态码就断开。
export const probeViaKernel = (host, { port = 443, secure = port !== 80, proxyPort = PANEL_INBOUND_PORT, timeoutMs = 10000, connectTo = '', method = 'HEAD' } = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now()
    let done = false
    const finish = (r) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - t0 }) } }
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort })
    const timer = setTimeout(() => { finish({ ok: false, error: 'timeout' }); socket.destroy() }, timeoutMs)
    // 只有连回环入站本身失败才是「入站没开」;连上之后再出错(比如内核拨号失败把连接 RST 掉)
    // 是这条线路的问题,不能扣到入站头上
    let connected = false
    socket.once('error', (err) => { clearTimeout(timer); finish({ ok: false, error: connected ? err.message : `inbound: ${err.message}` }) })
    socket.once('connect', () => {
      connected = true
      const dest = hostPort(connectTo || host, port)
      socket.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n\r\n`)
    })
    let buf = ''
    const onConnectData = (chunk) => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onConnectData)
      const line = buf.slice(0, buf.indexOf('\r\n'))
      if (!/^HTTP\/1\.[01] 200/.test(line)) { clearTimeout(timer); finish({ ok: false, error: `CONNECT: ${line}` }); socket.destroy(); return }
      // 先不断开(调用方要趁连接还在去内核连接表里找它,找完再 close());兜底 15 秒后自动断
      const holdOpen = (stream) => {
        clearTimeout(timer)
        const close = () => { try { stream.destroy() } catch { /* ignore */ } try { socket.destroy() } catch { /* ignore */ } }
        setTimeout(close, 15000).unref?.()
        return close
      }
      if (method === 'TCP') { finish({ ok: true, close: holdOpen(socket) }); return }
      // keep-alive:带 Connection: close 的话对端一答完就关,内核随即把它从连接表里删掉,
      // 后面就查不到了。连接由调用方 close() 收尾。
      const hostHeader = net.isIPv6(host) ? `[${host}]` : host
      const request = `${method === 'GET' ? 'GET' : 'HEAD'} / HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: open-box-route-test\r\nConnection: keep-alive\r\n\r\n`
      const readStatus = (stream) => {
        let head = ''
        let done = false
        stream.on('data', (c) => {
          if (done) return
          head += c.toString('latin1')
          const i = head.indexOf('\r\n')
          if (i === -1) return
          // 头读到空行再报:要拿响应头认人机验证(system/http-challenge.mjs);16KB 还没到空行就只报状态行
          const end = head.indexOf('\r\n\r\n')
          if (end === -1 && head.length < 16384) return
          done = true
          const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head.slice(0, i))
          const headers = end === -1 ? {} : pickProbeHeaders(parseHeaderBlock(head.slice(i + 2, end)))
          const close = holdOpen(stream)
          finish(m ? { ok: true, status: Number(m[1]), headers, close } : { ok: false, error: `bad response: ${head.slice(0, i)}`, close })
        })
        stream.once('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message }) })
        stream.once('close', () => { clearTimeout(timer); finish({ ok: false, error: 'connection closed' }) })
      }
      if (secure) {
        // SNI 只能是域名:IP 字面量不能进 SNI(RFC 6066),Node 也会拒
        const secureStream = tls.connect({ socket, ...(isIp(host) ? {} : { servername: host }), rejectUnauthorized: false }, () => {
          if (method === 'TLS') finish({ ok: true, close: holdOpen(secureStream) })
          else secureStream.write(request)
        })
        readStatus(secureStream)
      } else {
        socket.write(request)
        readStatus(socket)
      }
    }
    socket.on('data', onConnectData)
  })

export const registerRouteTestRoutes = (app, { store, ctx, paths, fetchImpl = globalThis.fetch, probe = probeViaKernel, resolveDns = kernelDnsQuery } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '16kb' }))

  router.post('/route-test', async (req, res) => {
    const target = String((req.body || {}).target || '').trim().toLowerCase()
    if (!isValidTarget(target)) return res.status(400).json({ message: 'target must be a domain or IP' })
    let method
    try { method = normalizeProbeMethod((req.body || {}).method) }
    catch (err) { return res.status(400).json({ message: errorMessage(err) }) }
    let config
    try {
      config = JSON.parse(await ctx.readFile(paths.configPath))
    } catch {
      return res.status(503).json({ message: '还没有生成过配置（内核没启动过）' })
    }
    const secret = store.getClashSecret ? store.getClashSecret() : ''
    const routingConf = normalizeRouting((store.getProfile ? store.getProfile() : {}).routing)
    const out = { target }

    // 1. DNS 决策
    if (isIp(target)) {
      out.dns = { skipped: true }
    } else {
      try {
        const sourceIp = req.body && typeof req.body.sourceIp === 'string' && net.isIP(req.body.sourceIp.trim()) ? req.body.sourceIp.trim() : ''
        const rewrite = typeof store?.getProfile === 'function' ? normalizeDnsRewrite(store.getProfile().dns) : { enabled: true, rules: [] }
        const sourceMac = sourceIp ? await macForIp(ctx, paths, sourceIp) : ''
        out.dns = await decideDnsServer(ctx, paths, config, target, { sourceIp, sourceMac, rewriteRules: rewrite.enabled ? rewrite.rules : [] })
        // 下面的解析和访问都是面板自己发起的:向内核 DNS 入站的查询来源是本机(不是原终端),
        // 回环 mixed 入站的探测来源也是本机——指定终端的来源规则在这两步里没有生效,不能把它们画成
        // "该终端的实测"(复审 S4)
        if (sourceIp) out.context = { sourceIp, predictedFor: 'terminal', probeOrigin: 'panel', sourceVerified: false }
      } catch (err) {
        out.dns = { error: errorMessage(err) }
      }
    }

    // 1b. 内核配置是不是旧的:配置里这条 DNS 决策是"直连解析"还是"代理解析",是生成配置
    //     那一刻按站点集走哪定死的。拿它和内核里此刻的选择比——两边不一样就说明这份
    //     dns.rules 过期了。正常情况下面板在代理页改完出口就会在后台重新生成(见
    //     server/index.mjs),所以这里标出来的只有那几秒窗口、或者后台那次生成失败了。
    if (out.dns && out.dns.server) {
      try {
        const selections = await fetchSelections(fetchImpl, secret)
        // 顺着 selector 的 now 一路下钻:站点集 → 节点组 → 节点。查询实际经过的线路就是这一串
        const chainOf = (name) => {
          const chain = [name]
          const seen = new Set()
          let cur = name
          for (let i = 0; i < 16 && Object.prototype.hasOwnProperty.call(selections, cur) && !seen.has(cur); i++) { seen.add(cur); cur = selections[cur]; chain.push(cur) }
          return chain
        }
        const leafOf = (name) => chainOf(name).at(-1)
        const directTag = builtinTags(store.getGroups ? store.getGroups() : []).direct
        const detour = out.dns.server.detour
        if (detour) {
          out.dns.runtimeChain = chainOf(detour)
          out.dns.runtimeLeaf = out.dns.runtimeChain.at(-1)
        }
        // 这条决策归谁管:一条规则都没命中就是兜底,命中了就按条件反查是哪个站点集写的
        // 热切换结构里命中的可能是挂着开关的代理支:去掉开关再拿条件反查;兜底的代理支去掉开关后没有条件,单独认
        const rawHit = out.dns.ruleIndex === null || out.dns.ruleIndex === undefined ? null : (config.dns.rules || [])[out.dns.ruleIndex] || {}
        const fallbackHit = rawHit && (flipFlagOfRule(rawHit) === FLIP_FALLBACK_TAG || (Array.isArray(rawHit.rule_set) && rawHit.rule_set.length === 1 && rawHit.rule_set[0] === FLIP_FALLBACK_TAG))
        const hitRule = rawHit && !fallbackHit ? flattenFlipRule(rawHit, true) || {} : null
        const owner = hitRule
          ? (routingConf.activePolicies || []).find((p) => (hitRule.rule_set && p.rulesets.join() === [].concat(hitRule.rule_set).join()) || (hitRule.domain_suffix && p.domainSuffix.join() === [].concat(hitRule.domain_suffix).join()))
          : routingConf.fallback
        if (owner && Object.prototype.hasOwnProperty.call(selections, owner.name)) {
          // 代理侧解析器 = 当时判成走代理;dns-direct / dns-local = 判成走直连。按 tag 认:代理侧上游按目标分流走直连时没有 detour
          const baked = isProxyResolverTag(out.dns.server.tag) ? 'proxy' : 'direct'
          const now = leafOf(owner.name) === directTag ? 'direct' : 'proxy'
          if (now !== baked) out.dns.stale = now
        }
      } catch { /* 拿不到内核状态就不标 */ }
    }

    // 2. 内核解析
    if (!isIp(target)) {
      // 每次查询都先清掉内核 DNS 缓存:这一页的全部意义就是"看真实路由",拿一份之前
      // 别的线路问出来的缓存答案没有意义(界面上只能标一句"命中缓存",看不到真实答案)。
      // 打字触发的那次也清——输入停下 600ms 才发一次请求,一次查询就是一次,不会被每个
      // 按键牵动。代价是这一趟慢几十到几百毫秒,以及局域网里别的域名要重新解析一次。
      await flushDnsCache(fetchImpl, secret)
      const t0 = Date.now()
      try {
        const records = (await resolveDns(target, 'A')).filter((a) => a && a.address)
        const answers = records.map((a) => String(a.address))
        const ms = Date.now() - t0
        out.resolve = { ok: true, answers, ms }
        const ttl = records.map((a) => Number(a.ttl)).find((n) => Number.isFinite(n))
        if (ttl !== undefined) out.resolve.ttl = ttl
        // 档案开了 IPv6 才问 AAAA:关着时内核 strategy=ipv4_only,问了也是空。分开报,A / AAAA
        // 各自验证(审核 C1:以前只查 A,IPv6 路径完全没看)
        const profile = store.getProfile ? store.getProfile() : null
        if (profile && profile.ipv6) {
          try {
            // 查询本身成没成功和有没有记录分开记:空答案不能盖住"查询失败"
            out.resolve.answers6 = (await resolveDns(target, 'AAAA')).map((a) => String(a && a.address)).filter((a) => a.includes(':'))
            out.resolve.ok6 = true
          } catch (err) {
            out.resolve.ok6 = false
            out.resolve.answers6 = []
            out.resolve.error6 = errorMessage(err)
          }
        }
        // 命中内核 DNS 缓存的判断:代理侧解析要在隧道里新开一条 TCP 到 DNS 服务器再问,至少两个
        // 来回,几十毫秒起步;几毫秒就回来的只能是缓存。缓存不分线路——换了节点,缓存没过期前
        // 拿到的还是上一条线路问出来的答案。直连解析本来就只有几毫秒,分不出来,不标。
        if (out.dns && out.dns.server && out.dns.server.detour && ms < 20 && answers.length) out.resolve.cached = true
      } catch (err) {
        out.resolve = { ok: false, answers: [], ms: Date.now() - t0, error: errorMessage(err) }
      }
      // 2b. 答案是 fake-ip:配置里写的那台 DNS 根本没收到这条查询,是线路对端截下来答的。
      //     代理侧解析时对端就是 detour 此刻落到的那个节点(runtimeLeaf;拿不到内核状态就退回
      //     detour 本身),前端把它画成单独一环;直连解析回 fake-ip 则是上游 DNS 自己在做 fake-ip。
      if (out.resolve.answers.length && out.resolve.answers.every(isFakeIp)) {
        out.resolve.fakeIp = true
        // 内核自己配了 fakeip 服务器(engine/dns.mjs 的 FakeIP 原型):走代理域名的占位地址是内核发的,
        // 不是线路对端截下来答的;连接进内核时会按占位地址找回域名再分流
        if (out.dns && out.dns.fakeIpRule !== undefined) {
          out.resolve.fakeIpLocal = true
        } else {
          const detour = out.dns && out.dns.server && out.dns.server.detour
          if (detour) out.resolve.fakeIpFrom = out.dns.runtimeLeaf || detour
        }
      }
    }

    // 3. 经内核的回环入站真实访问一次,同时在连接表里找这条连接
    // 端口:调用方给了就用(格式化查询会把 URL 里的端口带过来),没给按 域名 443 / IP 80。
    // 80 以外一律按 TLS 处理(4433、8443 这类都是 https)。
    const bodyPort = Number((req.body || {}).port)
    const port = Number.isInteger(bodyPort) && bodyPort >= 1 && bodyPort <= 65535 ? bodyPort : isIp(target) ? 80 : 443
    // 和模拟终端同一个判法(api/terminal-test.mjs):TLS 一定加密,TCP 不加密,GET / HEAD 按端口(80 以外按 https)
    const secure = method === 'TLS' || (method !== 'TCP' && port !== 80)
    let exit = { url: ['TCP', 'TLS'].includes(method) ? `${method.toLowerCase()}://${hostPort(target, port)}` : targetUrl(target, port, secure), method }
    // 查连接表和访问并行,而不是访问完再查:访问失败(对端关连接、超时)的那一刻这条连接就从内核
    // 连接表里消失了,事后什么都查不到;趁请求还挂着的时候找到它,失败了也知道是从哪个节点出去的。
    // 探测连接认得很准:入站是面板的回环 mixed(metadata.type = mixed/panel-in)、目标端口对得上、
    // 主机名或 IP 对得上。连接表里没有入站信息的老内核,等访问结束后退一步只按主机名 / IP 对;
    // 有入站信息但不是面板入站的(别的终端到同一目标的连接)一律不算,免得把别人的线路当成自己的。
    let settled = false
    // 像终端一样:解析出了地址就按第一个地址去连(fake-ip 也照连——终端拿到的就是它)
    const connectTo = !isIp(target) && out.resolve && out.resolve.answers.length ? String(out.resolve.answers[0]) : ''
    if (connectTo) exit.connectTo = connectTo
    const probing = probe(target, { port, secure, connectTo, method }).then((r) => { settled = true; return r })
    const resolvedIps = new Set(((out.resolve && out.resolve.answers) || []).map(String))
    const sameTarget = (m) => String(m.host || '').toLowerCase() === target ||
      m.destinationIP === target ||
      (resolvedIps.size > 0 && resolvedIps.has(String(m.destinationIP || '')))
    const viaPanelInbound = (m) => String(m.type || '').endsWith(`/${PANEL_INBOUND_TAG}`) && String(m.destinationPort || '') === String(port)
    const newestFirst = (a, b) => String(b.start || '').localeCompare(String(a.start || ''))
    const lookup = async () => {
      const delays = [100, 200, 300, 500, 800, 1000]
      let total = 0
      let sample = []
      let after = 0
      for (let i = 0; ; i++) {
        const c = await fetchWithTimeout(fetchImpl, `${CLASH_API_BASE}/connections`, { headers: clashHeaders(secret) }, 5000)
        const body = await c.json()
        const list = ((body && body.connections) || []).filter((x) => x && x.metadata)
        total = list.length
        sample = list.slice(-5).map((x) => `${x.metadata.host || ''}|${x.metadata.destinationIP || ''}`)
        const mine = list.filter((x) => sameTarget(x.metadata)).sort(newestFirst)
        const exact = mine.find((x) => viaPanelInbound(x.metadata))
        if (exact) return { hit: exact, total, sample }
        if (settled) {
          const loose = mine.find((x) => !x.metadata.type)
          if (loose) return { hit: loose, total, sample }
          if (++after >= 3) return { hit: null, total, sample }
        }
        await new Promise((resolve) => setTimeout(resolve, delays[Math.min(i, delays.length - 1)]))
      }
    }
    let found = { hit: null, total: 0, sample: [] }
    let connectionsError = ''
    const looking = lookup().then((f) => { found = f }, (err) => { connectionsError = errorMessage(err) })
    const r = await probing
    await looking
    exit = { ...exit, ok: r.ok, status: r.status, ms: r.ms }
    if (!r.ok) exit.error = r.error
    if (r.headers && typeof r.headers === 'object') {
      exit.headers = r.headers
      const challenge = detectChallenge(r.status, r.headers)
      if (challenge) exit.challenge = challenge
    }
    if (found.hit) {
      exit.chains = Array.isArray(found.hit.chains) ? found.hit.chains.slice().reverse() : []
      exit.rule = found.hit.rule || ''
      exit.rulePayload = found.hit.rulePayload || ''
      exit.destinationIP = found.hit.metadata.destinationIP || ''
      // 链路末尾是节点还是内置的直连 / 拒绝:走节点的,前端要写明节点拿到的是 IP 还是 fake-ip
      const leaf = exit.chains.at(-1)
      const tags = builtinTags(store.getGroups ? store.getGroups() : [])
      if (leaf) exit.viaProxy = leaf !== tags.direct && leaf !== tags.block
      // 这条连接归哪个站点集 / 前置自定义 / 内置规则:链路根是站点集就是它,否则拿内核记的规则原文对回正在跑的配置
      const owner = connectionOwner({ chains: exit.chains, rule: exit.rule, routeRules: config && config.route ? config.route.rules : [], routing: (store.getProfile ? store.getProfile() : {}).routing, builtin: tags })
      if (owner) exit.owner = owner
      // 站点集按 IP 判的那一份带「连接没有域名」的前提:原文里那段正则去掉,改成 noDomain 标记
      const readable = stripNoDomainGuardText(exit.rule)
      exit.rule = readable.rule
      if (readable.noDomain) exit.noDomain = true
    } else if (connectionsError) {
      exit.connectionsError = connectionsError
    } else {
      exit.notSeen = true
      exit.debug = { connections: found.total, sample: found.sample }
    }
    if (typeof r.close === 'function') r.close()
    out.exit = exit
    // 有 AAAA 记录就按第一个 v6 地址再访问一次,v4 / v6 链路分别验证(只记探测结果,不再查连接表)
    const connectTo6 = !isIp(target) && out.resolve && Array.isArray(out.resolve.answers6) && out.resolve.answers6.length ? String(out.resolve.answers6[0]) : ''
    if (connectTo6) {
      const r6 = await probe(target, { port, secure, connectTo: connectTo6, method })
      out.exit6 = { connectTo: connectTo6, ok: r6.ok, status: r6.status, ms: r6.ms }
      if (!r6.ok) out.exit6.error = r6.error
      if (typeof r6.close === 'function') r6.close()
    }
    res.json(out)
  })

  app.use('/api/openbox', router)
}
