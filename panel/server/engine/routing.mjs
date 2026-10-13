import { FLIP_FALLBACK_TAG, andRule, flipFlagMap } from './flip.mjs'
import { customOutboundTag, customPolicyActive, customRuleTag, isIpRuleSetTag, noDomainGuard, normalizeRouting, ntpDirectRule, parsePortSpec, policyRouteMatches, routeRulesetTags, splitRuleSetConditions } from './routing-model.mjs'
import { clientSourceMatch, isDirectClientRoute } from './client-routes.mjs'

// 一条策略的匹配条件 → 一条 sing-box 路由规则。
// 同一条规则里的域名 / IP 字段是「或」的关系(sing-box 规则内部目标地址各字段取并集),所以一条策略
// 写了域名后缀又写了 IP 段时,任一命中即算这条策略命中——和用户在界面上的理解一致。
// 规则集例外:sing-box 1.14 起它和同一条里的域名 / IP 条件不再稳定地「或」,写进配置前要经
// routing-model.mjs 的 splitRuleSetConditions 拆成两条(见那里的说明)
// 规则集链接是域名 / IP 两份 .srs,路由规则两份都引用(见 routing-model.mjs 的 routeRulesetTags)
const policyRule = (policy, ruleLists) => {
  const rule = {}
  const rulesets = routeRulesetTags(policy, ruleLists)
  if (rulesets.length) rule.rule_set = rulesets
  if (policy.domain.length) rule.domain = policy.domain
  if (policy.domainSuffix.length) rule.domain_suffix = policy.domainSuffix
  if (policy.domainKeyword.length) rule.domain_keyword = policy.domainKeyword
  if (policy.ipCidr.length) rule.ip_cidr = policy.ipCidr
  rule.outbound = policy.name
  return rule
}

// 前置自定义分流的一行 → 一条 sing-box 路由规则。一行只有一个条件,出口是这行自己选的。
// 规则集那几档要按 ruleLists 折算成域名 / IP 两份 .srs(和站点集同一套)。
const customRule = (rule, ruleLists, outbound) => {
  const tag = customRuleTag(rule)
  if (tag) {
    const tags = routeRulesetTags({ rulesets: [tag] }, ruleLists)
    return tags.length ? { rule_set: tags, outbound } : null
  }
  // 端口:TCP / UDP 都算,不限协议——放行 WireGuard 这种 UDP 也就是靠它
  if (rule.type === 'port') {
    const spec = parsePortSpec(rule.value)
    return spec ? { ...spec, outbound } : null
  }
  const field = {
    domain: 'domain', domainSuffix: 'domain_suffix',
    domainKeyword: 'domain_keyword', ipCidr: 'ip_cidr',
  }[rule.type]
  return field ? { [field]: [rule.value], outbound } : null
}

// 前置自定义分流的一行 → 进配置的一到两条规则。IP 只管 IP、域名只管域名(用户 2026-09-26,不管是哪里的分流):
// IP 段 / geoip / 规则集链接编出来的 IP 那份带「连接没有域名」的前提(noDomain),域名那几档照常;端口行两类连接都管
const customRuleParts = (rule, ruleLists, outbound) => {
  const tag = customRuleTag(rule)
  if (tag) {
    const tags = routeRulesetTags({ rulesets: [tag] }, ruleLists)
    const domainTags = tags.filter((t) => !isIpRuleSetTag(t))
    const ipTags = tags.filter((t) => isIpRuleSetTag(t))
    return [
      ...(domainTags.length ? [{ rule: { rule_set: domainTags, outbound }, noDomain: false }] : []),
      ...(ipTags.length ? [{ rule: { rule_set: ipTags, outbound }, noDomain: true }] : []),
    ]
  }
  const emitted = customRule(rule, ruleLists, outbound)
  return emitted ? [{ rule: emitted, noDomain: Object.prototype.hasOwnProperty.call(emitted, 'ip_cidr') }] : []
}

// 首包预判放行(sing-box 1.13+ 的 bypass 动作,auto_redirect 的 nfqueue 预判):新连接的第一个包先交给内核按路由规则比一遍,
// 命中不带出口的 bypass 就在系统层打上内核自身流量的标记放走,整条连接不再进内核。只有本来要进内核的连接才会被预判(白名单
// 模式下就是目标在「进内核」名单里的那些),其余照旧在入口直接放走、不打标记,多 WAN(mwan3)的选线不受影响。
// 规则表里按直连走、又能在首包判定的两类用它:
//   · 「订阅和节点站点直连」的地址(部署时节点 / 订阅的域名解析出来的 IP 也在里面):局域网设备连节点服务器;
//   · 终端分流里出口是「直连」的终端。
// 排在它们前面、可能把连接送去别处的,只有前置自定义分流里走代理 / 拒绝的行,和内置的 DNS 接管、tun 防回环:这些按 IP /
// 规则集 / 端口判的条件原样取反挂上——命中的连接照常进内核、按原规则走,其余放行。按域名的条件不用挂:预判时连接只有目标
// IP;FakeIP 占位地址会被找回成域名,而 bypass 对域名目标不生效,这类连接照常进内核按规则走。
// 不带 outbound 的 bypass 只在预判里生效,正常路由时内核跳过它,后面原来那条直连规则照旧兜着。必须排在 sniff 前面:TCP 首包
// 没有载荷,预判碰到 sniff 就停了。没有 nfqueue(缺内核模块)时预判不开,这几条等于不存在
// directHostSet:订阅和节点站点直连的 IP 那份规则集(engine/direct-hosts.mjs 的 NODE_DIRECT_IP_TAG,部署的配置用它,地址变了
// 只换文件);直接给 directHosts 地址的(测试)照旧写成 ip_cidr
export const preMatchBypassRules = (conf, { clientRoutes = [], directHosts = null, directHostSet = '', directTag = 'direct', blockTag = 'block', ruleLists = {}, knownOutbounds = null, tunCidrs = [] } = {}) => {
  const direct = (Array.isArray(clientRoutes) ? clientRoutes : []).filter((cr) => isDirectClientRoute(cr, directTag))
  const hostCidrs = !directHostSet && directHosts && Array.isArray(directHosts.cidrs) ? directHosts.cidrs : []
  if (!direct.length && !hostCidrs.length && !directHostSet) return []
  const cidrs = [...tunCidrs]
  const sets = []
  const ports = [53]
  const ranges = []
  const add = (list, v) => { if (!list.includes(v)) list.push(v) }
  if (customPolicyActive(conf.custom)) {
    const builtinTags = { direct: directTag, block: blockTag }
    for (const rule of conf.custom.rules) {
      const target = customOutboundTag(rule, builtinTags)
      if (target === directTag) continue
      if (knownOutbounds && !knownOutbounds.has(target)) continue
      for (const { rule: part } of customRuleParts(rule, ruleLists, target)) {
        for (const c of part.ip_cidr || []) add(cidrs, c)
        for (const t of part.rule_set || []) add(sets, t)
        for (const p of part.port || []) add(ports, p)
        for (const r of part.port_range || []) add(ranges, r)
      }
    }
  }
  const keep = [
    ...(cidrs.length ? [{ ip_cidr: cidrs, invert: true }] : []),
    ...(sets.length ? [{ rule_set: sets, invert: true }] : []),
    { port: ports, ...(ranges.length ? { port_range: ranges } : {}), invert: true },
  ]
  const ips = [...new Set(direct.filter((cr) => cr.match !== 'mac').flatMap((cr) => cr.sources || []))]
  const macs = [...new Set(direct.filter((cr) => cr.match === 'mac').flatMap((cr) => cr.macs || []))]
  // 顺序和内核规则表一致:订阅和节点站点直连在终端分流前面
  return [
    ...(directHostSet ? [andRule([{ rule_set: [directHostSet] }, ...keep], { action: 'bypass' })] : []),
    ...(hostCidrs.length ? [andRule([{ ip_cidr: hostCidrs }, ...keep], { action: 'bypass' })] : []),
    ...(ips.length ? [andRule([{ source_ip_cidr: ips }, ...keep], { action: 'bypass' })] : []),
    ...(macs.length ? [andRule([{ source_mac_address: macs }, ...keep], { action: 'bypass' })] : []),
  ]
}

// 一条规则(前置自定义分流的一行 / 站点集)有没有按目标 IP 判的条件
const customRowNeedsIp = (rule, ruleLists) => {
  if (rule.type === 'ipCidr' || rule.type === 'geoip') return true
  const tag = customRuleTag(rule)
  if (!tag) return false
  const shape = ruleLists && ruleLists[tag]
  return !shape || Boolean(shape.ip)
}
const policyNeedsIp = (policy, ruleLists) => policy.ipCidr.length > 0 || routeRulesetTags(policy, ruleLists).some((tag) => /^geoip-/.test(tag) || tag.endsWith('-ip'))
const policyDomainMatch = (policy, ruleLists) => {
  const rule = policyRule(policy, ruleLists)
  delete rule.outbound
  // 只留域名类条件:IP 条件本来就按 IP 判,不需要预解析
  delete rule.ip_cidr
  if (rule.rule_set) {
    rule.rule_set = rule.rule_set.filter((tag) => !/^geoip-/.test(tag) && !tag.endsWith('-ip'))
    if (!rule.rule_set.length) delete rule.rule_set
  }
  return Object.keys(rule).length ? rule : null
}

// "需要真实目标 IP"的范围 → 预解析规则表(见 buildRoute 里的说明)。顺序是内核里的真实顺序:
// 前置自定义分流各行 → 终端分流 → 站点集 → 兜底
export const preResolveRules = (conf, ruleLists, resolvers, options = {}) => {
  const builtinTags = { direct: options.directTag || 'direct', block: options.blockTag || 'block' }
  const known = options.knownOutbounds instanceof Set ? options.knownOutbounds : null
  const out = []
  let ipSeen = false
  if (customPolicyActive(conf.custom)) {
    conf.custom.rules.forEach((rule, i) => {
      const target = customOutboundTag(rule, builtinTags)
      if (known && !known.has(target)) return
      if (customRowNeedsIp(rule, ruleLists)) { ipSeen = true; return }
      const server = resolvers.custom && resolvers.custom[i]
      if (!ipSeen || !server) return
      const row = customRule(rule, ruleLists, target)
      if (!row) return
      delete row.outbound
      out.push({ ...row, action: 'resolve', server })
    })
  }
  // 终端分流按来源判,本身不需要 IP;但它后面的站点集要看它前面有没有 IP 规则——顺序不变,这里只记录
  for (const cr of Array.isArray(resolvers.clients) ? resolvers.clients : []) {
    if (ipSeen && cr && cr.sources && cr.sources.length && cr.server) out.push({ source_ip_cidr: cr.sources, action: 'resolve', server: cr.server })
  }
  for (const policy of conf.activePolicies) {
    // 一条站点集自己的 IP 条件不算它自己域名条件的"前面的 IP 规则":同一条规则里域名 / IP 是"或",域名命中就够了
    const server = resolvers.policies && resolvers.policies[policy.name]
    if (ipSeen && server) {
      const match = policyDomainMatch(policy, ruleLists)
      if (match) for (const part of splitRuleSetConditions(match)) out.push({ ...part, action: 'resolve', server })
    }
    if (policyNeedsIp(policy, ruleLists)) ipSeen = true
  }
  // 兜底:前面有 IP 规则时,没命中任何域名规则的域名目标也先解析(否则它们在 IP 规则处同样没有真实 IP)
  if (ipSeen && resolvers.fallback) out.push({ action: 'resolve', server: resolvers.fallback })
  return out
}

export const buildRoute = (routing, rulesetDir, options = {}) => {
  const conf = normalizeRouting(routing)
  const rulesetTags = new Set()
  const addTag = (tag) => { if (tag) rulesetTags.add(tag) }

  const dnsMode = options.dnsMode || 'hijack'
  // 出口必须是配置里真有的 outbound(内核 outbound not found 会起不来),前置自定义分流和
  // 终端分流都按这张表筛;规则集链接的形状表决定引用域名那份还是 IP 那份
  const known = options.knownOutbounds instanceof Set ? options.knownOutbounds : null
  const ruleLists = options.ruleLists || {}
  // 订阅和节点站点直连的地址、终端分流「直连」的终端,在首包预判时照规则放行(preMatchBypassRules),排在 sniff 前面。
  // 「直连不进内核」开着、有 nft 重定向时才写(options.preMatchBypass,engine/config.mjs 按档案算)
  const preMatch = options.preMatchBypass
    ? preMatchBypassRules(conf, { clientRoutes: options.clientRoutes, directHosts: options.directHosts, directHostSet: options.directHostSets ? options.directHostSets.ip : '', directTag: options.directTag || 'direct', blockTag: options.blockTag || 'block', ruleLists, knownOutbounds: known, tunCidrs: Array.isArray(options.tunCidrs) ? options.tunCidrs : [] })
    : []
  const rules = [...preMatch, { action: 'sniff' }]
  // IPv6 分层 · 代理 v6 降为 IPv4(engine/dns.mjs 的 ipv6ProxyMode):某条规则的出口此刻是代理线路时,
  // 先插一条同条件 + ip_version 6 的 reject——裸 v6 目标、终端自己解析出来的 v6 地址要走代理线路
  // 时明确失败,不能悄悄从 WAN 直出,也不影响直连出口的 v6(直连规则前面不插)。
  // rejectV6For(出口 tag) 由调用方按此刻的选择算(config.mjs)
  const rejectV6For = typeof options.rejectV6For === 'function' ? options.rejectV6For : null
  // 屏蔽 QUIC(GitHub #163):同一个套路——出口此刻是代理线路的规则前面插一条同条件 + UDP 443 的 reject,
  // 浏览器收到拒绝就退回 TCP(HTTPS);不少节点转发 UDP 很差,YouTube 走 QUIC 反而卡。直连出口的 QUIC 不动。
  // 规则自己带端口 / 协议条件的(前置自定义分流按端口写的)不插:那是用户明说的,再叠一个 443 语义就变了。
  // rejectQuicFor(出口 tag) 同样由调用方按此刻的选择算
  const rejectQuicFor = typeof options.rejectQuicFor === 'function' ? options.rejectQuicFor : null
  const QUIC_MATCH = { network: 'udp', port: 443 }
  // 热切换(engine/flip.mjs):出口是站点集的规则,v6 / QUIC 拒绝不按此刻的类别决定插不插,而是恒定插一条
  // 「同条件 + 开关 + 附加条件」的 logical AND——开关 ON(不是直连)才命中,翻面只改写开关文件、不重启内核。
  // 出口是节点 / 节点组 / 直连 / 拒绝的规则类别不会变,按 rejectV6For / rejectQuicFor 此刻的结论直接写
  const flipFlags = flipFlagMap(conf)
  const canQuic = (match) => match.port === undefined && match.port_range === undefined && match.network === undefined
  // noDomain:这条是站点集按 IP 判的那一份,只管没有域名的连接(routing-model.mjs 的 noDomainGuard)。同条件的
  // v6 / QUIC 拒绝也带着这个前提——有域名的连接按域名判出来走直连时,不能因为地址落在某个走代理的集合里被拒
  const pushRule = (rule, { noDomain = false } = {}) => {
    const match = { ...rule }
    delete match.outbound
    const guard = noDomain ? [noDomainGuard()] : []
    const routed = noDomain ? andRule([match, ...guard], { outbound: rule.outbound }) : rule
    const flag = rule.outbound ? flipFlags.get(rule.outbound) : undefined
    if (flag) {
      if (rejectV6For) rules.push(andRule([match, ...guard, { rule_set: [flag] }, { ip_version: 6 }], { action: 'reject' }))
      if (rejectQuicFor && canQuic(match)) rules.push(andRule([match, ...guard, { rule_set: [flag] }, QUIC_MATCH], { action: 'reject' }))
      rules.push(routed)
      return
    }
    if (rejectV6For && rule.outbound && rejectV6For(rule.outbound)) {
      rules.push(noDomain ? andRule([match, ...guard, { ip_version: 6 }], { action: 'reject' }) : { ...match, ip_version: 6, action: 'reject' })
    }
    if (rejectQuicFor && rule.outbound && rejectQuicFor(rule.outbound) && canQuic(match)) {
      rules.push(noDomain ? andRule([match, ...guard, QUIC_MATCH], { action: 'reject' }) : { ...match, ...QUIC_MATCH, action: 'reject' })
    }
    rules.push(routed)
  }
  // off:Open-Box 不劫持任何 DNS——不改写、不回交,局域网的 53 端口流量当普通 UDP 按规则走
  // (配合 config.mjs 里关掉 auto_redirect,它自带 nft 层的 DNS 劫持,关不掉)。但内核 DNS 入站
  // dns-in 仍开着,主动发到 <路由器 IP>:7853 的查询(AdGuard Home / Pi-hole 的上游)照常解析。
  // hijack 模式靠 {protocol:'dns'} 一并接住 dns-in 收到的查询(sniff 对 direct 入站同样生效)。
  if (dnsMode === 'hijack') {
    rules.push({ protocol: 'dns', action: 'hijack-dns' })
    // dns-in(以及名单外终端的 dns-in-direct)收到的连接一律当 DNS 处理,和另外两种模式一样(GitHub #550):只靠上面那条
    // {protocol:'dns'} 的话,连到 :7853 却不发 DNS 的连接(空连接、探活)嗅探不出 DNS,会落到 ip_is_private → 直连,
    // 直连再拨 <路由器 IP>:7853 又回到 dns-in——每一跳新开一个连接、永不收敛,一个核跑满。不用 reject:
    // 真正的 DNS 查询来得慢、嗅探超时没认出来的,交给 hijack-dns 照样能解析
    rules.push({ inbound: ['dns-in', ...(options.dnsDirectInbound ? [options.dnsDirectInbound] : [])], action: 'hijack-dns' })
  } else if (dnsMode === 'off') {
    rules.push({ inbound: ['dns-in'], action: 'hijack-dns' })
  } else if (dnsMode === 'dnsmasq') {
    // dnsmasq 接管模式下不能全局劫持 DNS 协议流量:tun 里到 dns-in 的转发查询也会
    // 匹配 {protocol:'dns'},被劫持回同一个 dns-in 入站,形成自环导致解析超时。
    // 仅劫持 dns-in 自身收到的查询,其余 DNS 流量按普通路由走(交给 dnsmasq 上游)。
    // 「只让这些终端进内核」名单外终端的专用入站(options.dnsDirectInbound)一样劫持
    rules.push({ inbound: ['dns-in', ...(options.dnsDirectInbound ? [options.dnsDirectInbound] : [])], action: 'hijack-dns' })
    // sing-box 开了 auto_redirect 时会自带一条 nft DNAT:局域网发给任何 53 端口的查询
    // (包括发给路由器自己 dnsmasq 的)统统改写到 tun 对端 172.19.0.2:53 送进 tun。
    // hijack 模式靠 {protocol:'dns'} 把它们接住;dnsmasq 模式只劫持 dns-in,这些查询会
    // 落到 ip_is_private → 直连 → 再拨 172.19.0.2 → 又进 tun,自环(真机上就是这么卡死的)。
    // 这里把它们交回本机 dnsmasq(override 到 127.0.0.1:53),dnsmasq 再按它的上游配置
    // 转给 dns-in,局域网客户端仍然走 dnsmasq 这一层(本地主机名、按域名分流都保留)。
    // 出站必须是绑定 lo 的专用直连(见 config.mjs):全局 auto_detect_interface 会把
    // 普通直连绑到 WAN 口,拨 127.0.0.1 不通。
    if (Array.isArray(options.tunCidrs) && options.tunCidrs.length && options.dnsmasqTag) {
      rules.push({
        ip_cidr: options.tunCidrs, port: [53], action: 'route',
        outbound: options.dnsmasqTag, override_address: '127.0.0.1',
      })
    }
  }
  // 防回环:目标是 tun 自己的网段(172.19.0.0/30 等)的连接直接拒绝。tun 的对端地址
  // 172.19.0.2 只是路由下一跳,没有任何合法流量会以它为目标;可一旦有(真机上出现过
  // 对 172.19.0.2:53 的 TCP DNS 查询),ip_is_private 会把它交给直连出站,直连再拨
  // 172.19.0.2 又会回到 tun,sing-box 自己喂自己,每一跳新开一个连接,几十秒就把
  // 句柄和内存吃光、整机卡死。必须排在 ip_is_private 前面。
  if (Array.isArray(options.tunCidrs) && options.tunCidrs.length) {
    rules.push({ ip_cidr: options.tunCidrs, action: 'reject' })
  }
  // 【本轮不启用】需要真实目标 IP 的范围(第五轮 任务 4):用户配置里按目标 IP 判的规则(前置自定义分流的 ip_cidr / geoip /
  // 规则集行,站点集的 ip_cidr / geoip / 规则集链接的 IP 那份)排在某条域名规则前面时,以域名进内核的连接
  // (面板回环 mixed、共享网络的 SOCKS5h / HTTP 代理、FakeIP 试验找回的域名)在这条 IP 规则那里没有真实 IP,
  // 会直接掠过它、落到后面的域名规则——和终端按 IP 连接的 tun 路径语义不一致。
  // 处理办法:在所有分流规则前面,给"排在第一条 IP 规则之后的域名规则"各插一条同条件的 resolve 动作,用
  // 这条规则自己的解析器(engine/dns.mjs 交出的映射:直连的用 dns-direct,走代理的用它自己 detour 的解析器)
  // 先把域名解析成真实 IP,再往下按原顺序判;没有这种前后关系时一条都不插。resolve 只对域名目标生效,
  // 按 IP 连进来的 tun 流量不受影响;解析走的是站点集自己的线路,和 DNS 规则一致,不是节点自己解析。
  // 收尾验收复现的回归:兜底那条无条件 resolve 排在所有分流规则前面,原本排在 IP 规则前面的域名规则也会先经
  // 它解析,直连解析器对只有节点认得的域名回 NXDOMAIN 时连接被终止(resolve 失败会结束连接)。所以正式生成
  // (engine/config.mjs)现在不传 resolvers,这段只在显式给了映射时生效,留给后续方案验证
  const resolvers = options.resolvers && typeof options.resolvers === 'object' ? options.resolvers : null
  const preResolve = resolvers ? preResolveRules(conf, ruleLists, resolvers, options) : []
  const preResolveAt = rules.length
  // 前置自定义分流:用户手写的强制通道,"不管别的规则怎么写,这些目标就走这个出口"。
  // 所以它排在所有规则最前面,只让上面那条 tun 防回环走在它前头——那条挡的是内核自己
  // 喂自己(真机上出现过几十秒把整机吃死),不是分流,不能被任何规则盖过。
  // 排在 ip_is_private 之前是有意的:否则"把某个内网段送到某个节点"(比如经 WireGuard
  // 访问对端局域网)永远写不出来,会被局域网直连那条先接走。
  // 一行一个出口,按行的先后进配置(内核首条命中生效)。IP 只管 IP、域名只管域名:IP 那几档只管没有域名的连接
  // (按域名访问对端局域网要写域名行),规则集链接拆成域名一条、IP 一条(customRuleParts)。
  // 出口必须是配置里真有的 outbound,指向已删掉的节点的那一行跳过,其余行照常生效。
  const custom = conf.custom
  if (customPolicyActive(custom)) {
    const builtinTags = { direct: options.directTag || 'direct', block: options.blockTag || 'block' }
    for (const rule of custom.rules) {
      const target = customOutboundTag(rule, builtinTags)
      if (known && !known.has(target)) continue
      for (const { rule: emitted, noDomain } of customRuleParts(rule, ruleLists, target)) {
        for (const tag of emitted.rule_set || []) addTag(tag)
        pushRule(emitted, { noDomain })
      }
    }
  }

  // 内置的直连出站可以改名,tag 从调用方传进来
  rules.push({ ip_is_private: true, outbound: options.directTag || 'direct' })
  // NTP 对时直连(GitHub #156):路由器自己和局域网设备的 NTP(UDP 123)一律直连。对时服务器多在国外
  // (time.google.com、pool.ntp.org),落到走代理的站点集后,不转发 UDP 的节点上对时一直失败,电视这类
  // 设备开机对不上时间。排在前置自定义分流后面:真要经节点对时,在那里写一条端口 123 就能盖过它
  rules.push(ntpDirectRule(options.directTag || 'direct'))

  // 订阅和节点站点直连(开关在后端设置):排在所有站点集之前,不受它们影响。部署的配置引用两份本地规则集(directHostSets,
  // engine/direct-hosts.mjs):地址变了只换文件、不重启内核;直接给地址的(directHosts,测试)照旧写进规则
  const dh = options.directHosts
  if (options.directHostSets) {
    rules.push({ rule_set: [options.directHostSets.domain, options.directHostSets.ip], outbound: options.directTag || 'direct' })
  } else if (dh && ((dh.domains && dh.domains.length) || (dh.cidrs && dh.cidrs.length))) {
    const rule = { outbound: options.directTag || 'direct' }
    if (dh.domains && dh.domains.length) rule.domain = dh.domains
    if (dh.cidrs && dh.cidrs.length) rule.ip_cidr = dh.cidrs
    rules.push(rule)
  }

  // 终端分流:指定终端(来源 IP / 网段,或 MAC)的全部流量走某个出口,排在站点集之前(优先级高于按目标
  // 分流),但在前置自定义分流 / ip_is_private / 直连站点之后。
  // 出口必须是配置里真有的 outbound,否则内核 outbound not found 起不来,这种规则直接丢掉。
  for (const cr of Array.isArray(options.clientRoutes) ? options.clientRoutes : []) {
    const match = clientSourceMatch(cr)
    if (!match || !cr.outbound) continue
    if (known && !known.has(cr.outbound)) continue
    pushRule({ ...match, outbound: cr.outbound })
  }

  // 站点集按用户排的顺序逐条匹配,首条命中生效。每个站点集拆成「看域名」「看 IP」两份(routing-model.mjs 的
  // policyRouteMatches):看 IP 的那份带着「连接没有域名」的前提——有域名的访问只按域名把站点集对一遍,都没命中就
  // 落到 final(兜底),不会被某个站点集的 geoip / IP 段抢走;没有域名的连接只看 IP 那份。两类连接各走各的,所以
  // 两份的先后不影响结果,照站点集顺序排。规则集 + 域名 / IP 字段再拆成紧邻的两条(1.14 的规则集语义)
  for (const policy of conf.activePolicies) {
    for (const tag of routeRulesetTags(policy, ruleLists)) addTag(tag)
    const { domain, ip } = policyRouteMatches(policy, ruleLists)
    if (domain) for (const part of splitRuleSetConditions(domain)) pushRule({ ...part, outbound: policy.name })
    if (ip) for (const part of splitRuleSetConditions(ip)) pushRule({ ...part, outbound: policy.name }, { noDomain: true })
  }
  // 兜底走代理时,没命中的 v6 连接 / QUIC 同样明确拒绝(final 写不了条件,单独写;挂在兜底的开关上)
  if (rejectV6For) rules.push(andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { ip_version: 6 }], { action: 'reject' }))
  if (rejectQuicFor) rules.push(andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, QUIC_MATCH], { action: 'reject' }))

  if (preResolve.length) rules.splice(preResolveAt, 0, ...preResolve)

  // 上面都没命中的流量交给兜底站点集(它也是一个 selector,见 config.mjs);
  // 内核的 final 必须指向某个存在的出站,所以这条永远有。
  const rule_set = [...rulesetTags].map((tag) => ({
    type: 'local', tag, format: 'binary', path: `${rulesetDir}/${tag}.srs`,
  }))

  const route = {
    auto_detect_interface: true,
    default_domain_resolver: 'dns-direct',
    rule_set,
    rules,
    final: conf.fallback.name,
  }
  return { route, rulesetTags }
}
