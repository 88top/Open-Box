// 终端分流:按局域网来源 IP / 网段指定出口。档案里存 profile.clientRoutes,这里把它
// 整理成路由规则要的形状:只留启用的、来源合法的;裸 IP 补成 /32、/128 方便统一走
// source_ip_cidr。出口不存在的规则由 routing.mjs 按 knownOutbounds 丢掉(不然内核
// 会因为 outbound not found 起不来)。

import net from 'node:net'

// 地址合法性交给 node:net 判:以前的正则只看字符集,"1:2:3""12345::1""2001:db8:0:0:0:0:0:0:1"
// 这种都会被放过,到部署时 sing-box check 才拒(GitHub 审核 B6)。带 zone 的链路本地地址
// (fe80::1%eth0)不当普通网段:规则里写它没有意义,内核也不收。
const isIpv4 = (s) => net.isIPv4(s)
const isIpv6 = (s) => net.isIPv6(s) && !s.includes('%')
export const isIpLiteral = (s) => isIpv4(s) || isIpv6(s)

// 合法就返回规范化后的 CIDR,不合法返回空串
export const normalizeCidr = (raw) => {
  const s = String(raw || '').trim()
  if (!s) return ''
  const [addr, prefix, ...rest] = s.split('/')
  if (rest.length) return ''
  if (isIpv4(addr)) {
    if (prefix === undefined) return `${addr}/32`
    const n = Number(prefix)
    return /^\d+$/.test(prefix) && n >= 0 && n <= 32 ? `${addr}/${n}` : ''
  }
  if (isIpv6(addr)) {
    if (prefix === undefined) return `${addr}/128`
    const n = Number(prefix)
    return /^\d+$/.test(prefix) && n >= 0 && n <= 128 ? `${addr}/${n}` : ''
  }
  return ''
}

export const isIpOrCidr = (raw) => normalizeCidr(raw) !== ''
// MAC:六组十六进制,冒号或横线分隔,归一成小写冒号写法;不合法返回空串
export const normalizeMac = (raw) => {
  const s = String(raw || '').trim().toLowerCase().replace(/-/g, ':')
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s) ? s : ''
}
export const isMac = (raw) => normalizeMac(raw) !== ''

// 一条终端规则按什么认终端:ip(sources,IP / 网段)或 mac(macs),编辑框里二选一(页签)。老档案没有这个字段:
// 「不进内核」「只让这些进内核」那两种当时必须填 MAC(IP 只给纯 tun 兜底用),算 mac;其余算 ip
export const clientMatch = (r) => {
  if (r && (r.match === 'ip' || r.match === 'mac')) return r.match
  return r && (r.bypass === true || r.admit === true) && Array.isArray(r.macs) && r.macs.length ? 'mac' : 'ip'
}
const cleanSources = (r) => [...new Set((Array.isArray(r.sources) ? r.sources : []).map(normalizeCidr).filter(Boolean))]
const cleanMacs = (r) => [...new Set((Array.isArray(r.macs) ? r.macs : []).map(normalizeMac).filter(Boolean))]

// 终端规则 → 路由 / DNS 规则要的形状(engine/routing.mjs、engine/dns.mjs):按 IP 的写 source_ip_cidr,
// 按 MAC 的写 source_mac_address(sing-box 1.14,内核按邻居表 / DHCP 租约认 MAC)。
// 「不进内核」(GitHub #39,像 OpenClash 的黑名单)的真正放行在入口:按 MAC 是 tun 的 exclude_mac_address,
// 按 IP 是 inet openbox 表里打内核标记(system/entry-bypass.mjs),都只在 auto_redirect 下有效。这里仍给它一条
// 「直连」规则:纯 tun 兼容模式下靠它,auto_redirect 下这些终端根本进不来,这条碰不到
export const normalizeClientRoutes = (list, { directTag = '' } = {}) => {
  if (!Array.isArray(list)) return []
  const out = []
  for (const r of list) {
    if (!r || typeof r !== 'object' || r.enabled === false) continue
    // 「只让这些进内核」不是分流规则:它不指定出口,只决定谁进内核(见下面的 admitSources),路由 / DNS 规则里没有它
    if (r.admit === true) continue
    const match = clientMatch(r)
    const bypass = r.bypass === true
    const outbound = bypass
      ? (directTag || (typeof r.outbound === 'string' && r.outbound.trim()) || 'direct')
      : (typeof r.outbound === 'string' ? r.outbound.trim() : '')
    if (!outbound) continue
    const base = { id: String(r.id || ''), name: String(r.name || ''), match, outbound, ...(bypass ? { bypass: true } : {}) }
    if (match === 'mac') {
      const macs = cleanMacs(r)
      if (macs.length) out.push({ ...base, sources: [], macs })
    } else {
      const sources = cleanSources(r)
      if (sources.length) out.push({ ...base, sources })
    }
  }
  return out
}

// 一条整理过的终端规则在路由 / DNS 规则里的来源条件;没有终端的返回 null
export const clientSourceMatch = (cr) => {
  if (!cr) return null
  if (cr.match === 'mac') return Array.isArray(cr.macs) && cr.macs.length ? { source_mac_address: cr.macs } : null
  return Array.isArray(cr.sources) && cr.sources.length ? { source_ip_cidr: cr.sources } : null
}

// 启用的某一类规则(bypass / admit)里的终端,按认法分开合并:{ ips: [网段…], macs: [MAC…] }
const collectSources = (list, flag) => {
  const ips = []
  const macs = []
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object' || r.enabled === false || r[flag] !== true) continue
    if (clientMatch(r) === 'mac') macs.push(...cleanMacs(r))
    else ips.push(...cleanSources(r))
  }
  return { ips: [...new Set(ips)], macs: [...new Set(macs)] }
}

// 「不进内核」(黑名单)的终端:按 IP 的在 nft 里打放行位,按 MAC 的两头都要——tun 的
// exclude_mac_address(跳过内核 nft 重定向)加 nft 里按 ether saddr 打的同一个放行位(跳过策略路由),
// 只写前者的话包照样被路由进 tun,等于没放行(#195)
export const bypassSources = (list) => collectSources(list, 'bypass')

// 终端分流里出口是「直连」的终端(不含「不进内核」那种):连接进了内核也是直连。「直连不进内核」开着、有 nft 重定向时,
// 内核首包预判照规则表把它们在系统入口放行(engine/routing.mjs 的 preMatchBypassRules)
export const isDirectClientRoute = (cr, directTag) => Boolean(cr) && cr.bypass !== true && Boolean(directTag) && cr.outbound === directTag

// 终端分流里出口是节点 / 节点组的终端(不是直连、拒绝,也不是「不进内核」)
export const isProxyClientRoute = (cr, directTag, blockTag) =>
  Boolean(cr) && cr.bypass !== true && Boolean(cr.outbound) && cr.outbound !== directTag && cr.outbound !== blockTag

// 哪些终端的 DNS 要由内核按终端答:在入口把它们的查询转给内核的 DNS 入站(system/entry-bypass.mjs 的 terminal_dns 链),
// 内核才看得到是哪台终端在查,按它自己的规则给答案(engine/dns.mjs)。劫持模式下局域网的查询本来就进内核,只有「不进内核」
// 的终端例外:它们的包在入口打了标记,DNS 劫持也跳过了,查询落到 dnsmasq,再由 dnsmasq 转给内核时已经分不出是谁。
// dnsmasq 转发模式下所有终端都是这样。要按终端答的有三类:
//   · 「不进内核」的终端;
//   · 出口是「直连」、会在首包预判时放行的终端(「直连不进内核」开着、有 nft 重定向)。劫持模式下它们的查询内核本来就接得到。
//     这两类都是整台不该进内核、答案里就不能有 FakeIP 占位地址的(占位地址只有内核认得,拿着它的连接只能进内核);
//   · dnsmasq 模式下出口是节点 / 节点组的终端(GitHub #574,用户 2026-10-13「做吧」):整台进内核,解析也跟着它的出口——开着
//     FakeIP 时它查的域名一律给占位地址,连接带着域名交给它的节点去解析,DNS 和流量是同一个节点。以前按全局规则答:全局判直连的
//     域名在本地解析出真实地址,再经节点去连。没开 FakeIP 时交给代理侧解析器(线路由目标分流定,不是每台终端一个)。
// 拒绝的终端整台进内核,dnsmasq 模式下解析仍按域名规则答(老样子)。没开分流解析(dns.split)时所有查询都是直连解析、没有
// 占位地址,不用转
export const terminalDnsRedirected = (cr, { dnsMode = 'hijack', autoRedirect = false, directBypass = true, splitDns = true, directTag = '', blockTag = '' } = {}) => {
  if (!cr || !autoRedirect || !splitDns) return false
  if (dnsMode !== 'dnsmasq' && dnsMode !== 'hijack') return false
  if (cr.bypass === true) return true
  if (dnsMode !== 'dnsmasq') return false
  if (isProxyClientRoute(cr, directTag, blockTag)) return true
  return directBypass !== false && isDirectClientRoute(cr, directTag)
}

// 「不进内核」的终端只转它发给路由器自己的查询(入口规则带 fib daddr type local):发给路由器的落到 dnsmasq、再转给内核时
// 分不出是谁,答案里会有 FakeIP 占位地址,要转;它自己指定的外部 DNS(比如 223.5.5.5)不截,交给路由器按自己的路由发——
// 用户 2026-10-01 定的原则「不进内核的交给路由器自行处理」。截进内核就按内核的线路查:多线路由器上 mwan3 让这台终端走
// 另一条线时,拿到的地址和它实际走的线不是同一家运营商,跨网绕路、晚高峰丢包(正式路由器上的 s-ui 节点就是这样变慢的)
export const terminalDnsLocalOnly = (cr) => Boolean(cr) && cr.bypass === true

// 上面那些终端的来源,按认法合并(给入口的 DNS 转发规则用);list 是 normalizeClientRoutes 整理过的。
// ips / macs:发往任何 53 端口的查询都转(「直连」终端);localIps / localMacs:只转发给路由器自己的(terminalDnsLocalOnly)
export const terminalDnsSources = (list, options = {}) => {
  const out = { ips: [], macs: [], localIps: [], localMacs: [] }
  for (const cr of Array.isArray(list) ? list : []) {
    if (!terminalDnsRedirected(cr, options)) continue
    const local = terminalDnsLocalOnly(cr)
    if (cr.match === 'mac') (local ? out.localMacs : out.macs).push(...(cr.macs || []))
    else (local ? out.localIps : out.ips).push(...(cr.sources || []))
  }
  return Object.fromEntries(Object.entries(out).map(([key, list]) => [key, [...new Set(list)]]))
}

// 「只让这些终端进内核」按 IP 的(入口 nft 打标记放行名单外的终端,见 system/entry-bypass.mjs):名单外的终端整台不进内核,
// 解析也要给真实地址——占位地址只有内核认得,打了标记的包到不了内核(GitHub #260 #270)。入口把它们的查询转给内核专门的
// DNS 入站(engine/config.mjs 的 DNS_DIRECT_INBOUND_TAG),那里的查询一律直连解析(engine/dns.mjs)。谁算名单外只在入口判一次。
// 只按 MAC 的名单走 tun 原生的 include_mac_address,不打标记,名单外终端拿到的占位地址还能进内核,不用转
export const admitDnsDirect = (list, { dnsMode = 'hijack', autoRedirect = false, splitDns = true } = {}) =>
  Boolean(autoRedirect && splitDns && (dnsMode === 'dnsmasq' || dnsMode === 'hijack') && admitSources(list).ips.length > 0)

// 「只让这些终端进内核」(GitHub #187,像 OpenClash 的白名单):有一台以上时,局域网里不在名单上的终端在入口就放行、
// 连 DNS 也不被劫持,和没装一样;路由器自己的流量不受影响。只有 MAC 时用 tun 的 include_mac_address(内核原生);
// 有按 IP 的就整个交给 nft(system/entry-bypass.mjs:从局域网口进来、IP 和 MAC 都不在名单上的才打标记),
// 不再写 include_mac_address——两边各管一半的话,按 IP 放进来的终端会被按 MAC 的名单挡掉。
// 只在 auto_redirect 下有效,纯 tun 兼容模式下所有终端照常进内核。一条都没有(或都停用)就是默认的全部进内核
export const admitSources = (list) => collectSources(list, 'admit')

// 按来源认终端的规则(终端分流、「不进内核」,路由和 DNS 两处,源 IP / MAC)只管局域网终端经路由器上网的连接。
// 从共享网络入站(engine/servers.mjs 的 serverTag,share-<id>:节点分流 App、把路由器当代理用的设备)进来的连接按路由器
// 的分流规则走,不能因为来源地址恰好是某台终端就被这些规则接走——家里的电脑设成「直连」终端、又用 App 的节点分流连回
// 路由器时,内核看到的来源就是这台电脑,Google 被送去直连、DNS 也被按直连答(客户端会话 2026-10-07 在正式路由器上查到)。
// sing-box 的 inbound 条件只能写正向列表,所以补一个「入站不是共享网络」的子条件:普通规则拆成 logical AND(条件一份、
// 动作留在外面),logical AND 直接追加。规则条数不变,按下标记的规则归属照旧对得上;没有共享网络入站时原样返回。
// 读规则的各处(规则页推算、规则归属)模拟的都是局域网终端,由 engine/flip.mjs 的 flattenFlipRule 把这个子条件去掉再判
export const notShareInbound = (tags) => ({ inbound: [...tags], invert: true })
export const isNotShareInbound = (sub) => Boolean(sub) && typeof sub === 'object' && sub.invert === true && Array.isArray(sub.inbound) &&
  sub.inbound.length > 0 && sub.inbound.every((t) => typeof t === 'string' && t.startsWith('share-')) && Object.keys(sub).length === 2
const hasSourceCondition = (rule) => Boolean(rule) && typeof rule === 'object' &&
  (Object.prototype.hasOwnProperty.call(rule, 'source_ip_cidr') || Object.prototype.hasOwnProperty.call(rule, 'source_mac_address'))
// 普通规则拆开时算「条件」的字段(其余是动作:outbound / action / server / tag / strategy …)。只列这些规则实际会带的,
// 多一个没列的条件会被当成动作留在外面——engine/client-routes.test.mjs 用生成的配置逐条核对
const SHARE_GUARD_CONDITION_KEYS = new Set([
  'source_ip_cidr', 'source_mac_address', 'domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'rule_set', 'query_type',
  'ip_version', 'network', 'protocol', 'port', 'port_range', 'ip_cidr', 'ip_is_private', 'inbound', 'invert', 'source_port', 'source_port_range',
])
export const guardTerminalRules = (rules, shareTags) => {
  const tags = Array.isArray(shareTags) ? shareTags.filter((t) => typeof t === 'string' && t) : []
  if (!Array.isArray(rules) || !tags.length) return rules
  return rules.map((rule) => {
    if (!rule || typeof rule !== 'object') return rule
    if (rule.type === 'logical') {
      if (rule.mode !== 'and' || !Array.isArray(rule.rules) || !rule.rules.some(hasSourceCondition)) return rule
      return { ...rule, rules: [...rule.rules, notShareInbound(tags)] }
    }
    if (!hasSourceCondition(rule)) return rule
    const cond = {}
    const tail = {}
    for (const [key, value] of Object.entries(rule)) (SHARE_GUARD_CONDITION_KEYS.has(key) ? cond : tail)[key] = value
    return { type: 'logical', mode: 'and', rules: [cond, notShareInbound(tags)], ...tail }
  })
}

// 读规则的各处(规则页推算、规则归属、真实路由对回配置)模拟 / 认的都是局域网终端,「入站不是共享网络」恒成立:去掉这个子条件;
// 只剩一条普通条件的并回普通规则(动作照抄),还带开关等其它子规则的留着 logical
export const withoutShareGuard = (rule) => {
  if (!rule || rule.type !== 'logical' || rule.mode !== 'and' || !Array.isArray(rule.rules) || !rule.rules.some(isNotShareInbound)) return rule
  const rest = rule.rules.filter((sub) => !isNotShareInbound(sub))
  const { type: _t, mode: _m, rules: _r, ...tail } = rule
  void _t
  void _m
  void _r
  if (rest.length === 1 && rest[0] && rest[0].type !== 'logical') return { ...rest[0], ...tail }
  return { ...rule, rules: rest }
}
// 内核连接记录里的规则原文(rule.String()):logical 各子规则用 " && " 连,取反的写成 "!(…)",入站一个写 inbound=x、多个写
// inbound=[x y]。去掉这段再给界面看 / 对回配置
const SHARE_GUARD_TEXT = / && !\(inbound=(?:\[share-[^\]]*\]|share-[^\s)]+)\)/g
export const stripShareGuardText = (text) => String(text || '').replace(SHARE_GUARD_TEXT, '')
