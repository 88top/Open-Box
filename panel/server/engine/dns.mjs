import { DEFAULT_BUILTIN, customOutboundTag, customPolicyActive, customRuleTag, dnsRulesetTags, normalizeRouting, policyOutboundOptions, policyGoesDirect, splitRuleSetConditions } from './routing-model.mjs'
import { normalizeDnsRewrite, rewriteDnsRules, rewriteDnsServer } from './dns-rewrite.mjs'
import { FLIP_FALLBACK_TAG, andRule, flipFlagMap } from './flip.mjs'
import { clientSourceMatch, terminalDnsRedirected } from './client-routes.mjs'
import { DEFAULT_DNS_PORT, DEFAULT_PROXY_UPSTREAM, MAX_DNS_EXTRAS, WAN_UPSTREAM, dnsPortOr, dnsProtocolOr, dnsRegionOf, dnsServerEntry, isWanUpstream, normalizeDnsUpstream, wanFallbackUpstream } from './dns-upstream.mjs'

// 直连侧的 DNS。要求是"交回系统默认,不经过 Open-Box 的代理",但两种接管模式下
// 直连侧解析器:三种模式都不再用 sing-box 的 local(系统解析器 → dnsmasq → dnsmasq 的上游)。
// 路由器 dnsmasq 的上游是局域网里的 AdGuard / Pi-hole 时,它们的查询会再次被劫持进
// sing-box,形成 sing-box → dnsmasq → AdGuard → sing-box 的死循环(正式路由器上实测,
// 直连域名全部超时);dnsmasq 转发模式下 dnsmasq 的上游更是 sing-box 自己。所以一律拿
// 档案里的「直连 DNS」经直连出站去查——默认就是系统的上游 DNS(「上游 DNS」,部署时从
// resolv.conf.auto 读,见 system/resolv.mjs),也可以填别的 IP,见下面的 directUpstream。
// 不写 detour:不写就是走默认出站,而默认出站正是 direct。显式写 detour:'direct'
// 会被内核在**启动时**拒绝——"detour to an empty direct outbound makes no sense",
// 而 `sing-box check` 不查这一条,所以校验过了、一跑就 FATAL(真机上就是这样死循环的)。
// HTTPS(65)/ SVCB(64)类型的查询直接回 NOERROR 空应答:浏览器解析域名时会并发发 A / AAAA / HTTPS 三种查询,
// HTTPS 那条经代理侧解析器(明文 TCP 经节点到公共 DNS)常常没有应答,浏览器要等它超时(约 10 秒)再重试,
// 表现就是打开 YouTube / Google 偶发卡 4–12 秒(GitHub #135 抓包证实:A 记录几十毫秒回,Type 65 常无响应)。
// HTTPS 记录只用来做 ECH / ALPN 提示,没有它浏览器直接按 A / AAAA 连,没有副作用;OpenClash / Passwall 也这么处理。
// 只在分流模式加:全部直连时查询本来就不经节点。放在重写和本地主机名规则之后、其它规则之前。
export const HTTPS_RR_RULE = Object.freeze({ query_type: ['HTTPS', 'SVCB'], action: 'predefined', rcode: 'NOERROR' })

// 「上游 DNS」(档案里记成 wan,engine/dns-upstream.mjs 的 WAN_UPSTREAM)此刻是哪台:部署时读到的系统上游 DNS 的第一台,
// 读不到按路由器所在地区退回(国内 223.5.5.5、国外 1.1.1.1)
const wanServer = (profile, options = {}) => {
  const systemDns = Array.isArray(options.systemDns) ? options.systemDns.filter(Boolean) : []
  return systemDns[0] || wanFallbackUpstream(dnsRegionOf(profile))
}
// 档案里的一条上游 → { protocol, server, port, wan }。上游 DNS 固定 UDP 53(协议跟着上游,档案里存的协议不看)、
// wan 标出来(代理侧不给它写 detour);
// 地址折不出合法 IP 的(手改库)按 invalid 退:直连侧退成上游 DNS,代理侧退成随包默认 1.1.1.1
const upstreamOf = (profile, raw, protocol, port, { fallbackProtocol, invalid }, options) => {
  const server = isWanUpstream(raw) ? '' : normalizeDnsUpstream(raw)
  if (!server && (isWanUpstream(raw) || isWanUpstream(invalid))) {
    return { protocol: 'udp', server: wanServer(profile, options), port: DEFAULT_DNS_PORT, wan: true }
  }
  return { protocol: dnsProtocolOr(protocol, fallbackProtocol), server: server || invalid, port: dnsPortOr(port) }
}

// 直连侧实际用哪台、什么协议、哪个端口(api/dns-upstream-test.mjs 也用它算 bootstrap 解析器):档案里的「直连 DNS」
// (dns.direct,协议 / 端口按 dns.directProtocol / dns.directPort)。默认是上游 DNS(用户 2026-10-02 定)
export const directUpstream = (profile, options = {}) => {
  const dns = (profile && profile.dns) || {}
  return upstreamOf(profile, dns.direct, dns.directProtocol, dns.directPort, { fallbackProtocol: 'udp', invalid: WAN_UPSTREAM }, options)
}

// 面板进程自己做直连解析时问哪几台(节点直连的域名解析、DNS 重写的后备):和内核直连侧同一个口径——直连 DNS 主 + 备用,
// 上游 DNS 展开成系统上游 DNS 的全部(内核只用第一台,面板这里多几台更稳)。给 node:dns 的 Resolver.setServers,非 53 端口
// 写成 ip:port(node:dns 只会 UDP、截断再 TCP,选了 TCP 的直连 DNS 这里照样先发 UDP)
export const directResolverServers = (profile, systemDns = []) => {
  const wan = (Array.isArray(systemDns) ? systemDns : []).filter(Boolean)
  const address = ({ server, port }) => (port === DEFAULT_DNS_PORT ? server : server.includes(':') ? `[${server}]:${port}` : `${server}:${port}`)
  const out = []
  for (const up of [directUpstream(profile, { systemDns: wan }), ...directExtraUpstreams(profile, { systemDns: wan })]) {
    for (const s of up.wan && wan.length ? wan : [address(up)]) if (!out.includes(s)) out.push(s)
  }
  return out
}
const directServerFor = (profile, options) => dnsServerEntry(directUpstream(profile, options), 'dns-direct')

// 备用上游(档案 dns.directExtras / dns.proxyExtras,GitHub #151):和主上游**并发**查,
// 谁先给出 NOERROR 就用谁的。单上游卡住时,客户端原来只能干等到自己超时。
// 空数组时下面所有分支都退化成原来的单服务器 + 单规则,生成的配置一字不差。
// 备用里也可以有上游 DNS;和主上游(或别的备用)落到同一台的去掉
const extraUpstreams = (profile, list, primary, fallbackProtocol, options) => {
  const seen = new Set([primary.server])
  const out = []
  for (const item of (Array.isArray(list) ? list : []).slice(0, MAX_DNS_EXTRAS)) {
    if (!item || !(isWanUpstream(item.server) || normalizeDnsUpstream(item.server))) continue
    const up = upstreamOf(profile, item.server, item.protocol, item.port, { fallbackProtocol, invalid: WAN_UPSTREAM }, options)
    if (seen.has(up.server)) continue
    seen.add(up.server)
    out.push(up)
  }
  return out
}
export const directExtraUpstreams = (profile, options = {}) =>
  extraUpstreams(profile, profile?.dns?.directExtras, directUpstream(profile, options), 'udp', options)

// 代理侧上游:档案 dns.proxy + dns.proxyProtocol(默认 tcp)。老档案的 DoH 链接由 store 读档案时折成主机名,这里再兜一次。
// 路由器在中国大陆之外时可以是上游 DNS(固定直连);在中国大陆不行,档案校验挡掉(api/profile.mjs)
export const proxyUpstream = (profile, options = {}) => {
  const dns = (profile && profile.dns) || {}
  return upstreamOf(profile, dns.proxy, dns.proxyProtocol, dns.proxyPort, { fallbackProtocol: 'tcp', invalid: DEFAULT_PROXY_UPSTREAM }, options)
}

// 代理侧的解析器:按档案选的协议(udp / tcp)向上游查询。只有一组——主上游一台(dns-proxy)、每个备用上游一台——走代理的
// 域名(站点集、兜底、前置自定义分流、终端分流)都交给它。连上游走哪条线路不按"查的是谁的域名"定,由「目标分流」按上游的
// 地址判,和局域网终端访问这个地址一样(用户 2026-09-28:「全局就只有一个分流规则:目标分流」;以前每个站点集各开一台、
// 各自 detour 到自己的 selector,同一个 1.1.1.1 查 Dola 的域名经新加坡、查「国外」的经香港,和规则页查 1.1.1.1 对不上)。
// 部署时按规则页同一套推算判出来写进 detour(api/dns-upstream-route.mjs → applyProxyUpstreamRoutes);没判(测试、规则页
// 预览生成的那份)先写兜底的 selector。
// 明文而不是 DoH:这台服务器的查询整段都封在代理隧道里,出了节点才是明文——路上没人
// 看得见,再套一层 TLS 只是每次查询多一次握手。DoH 还有两处实打实的坏处:一是节点到
// DoH 站点这一段偶尔被对端拒(实测 1.12.12.12 经香港节点 EOF、经美国节点正常),二是
// 用域名形态的 DoH 地址会引出"解析 DoH 域名"的自举问题(所以地址只收 IP)。默认 TCP 而不是 UDP:
// UDP 经代理常被截断/丢包,TCP 的可靠性正好抵掉它多出来的那次握手。端口不写就是 53。
const proxyServerFor = (upstream, tag, detour) => dnsServerEntry(upstream, tag, detour)
export const PROXY_RESOLVER_TAG = 'dns-proxy'
// 某台解析器是不是代理侧的:按 tag 认,不能按有没有 detour 认——目标分流让上游走直连时它没有 detour。
// dns-policy-N / dns-custom-N / dns-client-N 是老版本(每个站点集各一台)部署的,重新部署之前内核里还是它们
export const isProxyResolverTag = (tag) => /^dns-(proxy|policy-\d+|custom-\d+|client-\d+)(__alt\d+)?$/.test(String(tag || ''))

// 代理侧的备用上游(档案 dns.proxyExtras,GitHub #151):和主上游**并发**查,谁先给出 NOERROR 就用谁的。
// 单上游经节点卡住时,客户端原来只能干等到自己超时;并发之后另一个上游正常就照常出结果。
// 没配备用上游时下面所有分支都退化成原来的单服务器 + 单规则,生成的配置一字不差。
export const proxyExtraUpstreams = (profile, options = {}) =>
  extraUpstreams(profile, profile?.dns?.proxyExtras, proxyUpstream(profile, options), 'tcp', options)
// 备用上游的服务器 tag:主 tag 后面挂序号。tag 只在配置内部用,不对外
const extraTag = (tag, i) => `${tag}__alt${i + 1}`

// 仅代理域名 FakeIP(原型,档案开关 dns.fakeIpForProxy):走代理的域名 A / AAAA 查询由内核返回
// 占位地址,真实解析完全不在本地发生——连接进内核时按占位地址找回域名,把域名交给选中的节点,
// 由节点那头解析并连接。于是 (1) 代理域名的解析和连接天然在同一个实际节点上(不再是"DNS detour
// 到组、连接又落到组里另一个叶子");(2) 客户端拿到的是占位地址,永远不会落进 geoip-cn 这种
// 直连集合,入口旁路就不会被"域名规则解析出来的 IP"误放行。直连域名照旧真实解析。
// 使用 RFC 2544 保留段的另一半，避开 OpenClash / Nikki 默认的 198.18.0.0/16。
// IPv6 沿用 sing-box 的 fc00::/18。
export const FAKEIP_V4 = '198.19.0.0/16'
export const FAKEIP_V6 = 'fc00::/18'
// 旧内核清理单栈 FakeIP 缓存时，缺失的 IPv6 bucket 会使清理事务回滚。
// 按地址池隔离缓存文件，避免升级换池后继续返回旧占位地址。
export const fakeIpCachePath = (base) => `${base}.fakeip-${`${FAKEIP_V4}-${FAKEIP_V6}`.replace(/[^a-zA-Z0-9]/g, '_')}`
export const FAKEIP_TAG = 'dns-fakeip'
export const dnsFakeIpEnabled = (profile) => Boolean(profile && profile.dns && profile.dns.split !== false && profile.dns.fakeIpForProxy === true)

// IPv6 分层(第三轮 阶段 5):
//   off    —— 档案 ipv6 关着:老语义原样保留,DNS 只解析 A、tun 不给 v6、防火墙 REJECT 局域网→WAN 的 v6
//   node   —— ipv6 开着、走代理的 v6 目标和 v4 一样交给节点(老"开启"语义)
//   ipv4   —— ipv6 开着,但代理线路不管 v6:走代理的域名不给 AAAA(终端自然用 v4 连),裸 v6 目标要走
//             代理时在内核里明确拒绝(engine/routing.mjs),不悄悄从 WAN 直出;直连的 v6 照常解析、照常走
//   bypass —— ipv6 开着,v6 流量根本不进内核(tun 不给 v6 地址、不劫 v6 路由、防火墙不拦),按系统路由
//             直接从 WAN 出去——和 OpenClash / DAE 默认行为一样(GitHub #36:用户要的就是 test-ipv6 能过);
//             DNS 照常给 AAAA,走代理的域名终端会先试 v6 直连、不通再退回 v4 走代理
export const ipv6ProxyMode = (profile) => (!profile || !profile.ipv6 ? 'off' : profile.ipv6Proxy === 'ipv4' ? 'ipv4' : profile.ipv6Proxy === 'bypass' ? 'bypass' : 'node')
// v6 要不要进 tun:开着 ipv6 且不是「不进内核」
export const ipv6InTun = (profile) => Boolean(profile && profile.ipv6) && ipv6ProxyMode(profile) !== 'bypass'

// 前置自定义分流的一行 → 一条 DNS 规则的匹配部分。只按 IP 分流的行(ip_cidr / geoip /
// 只编出 IP 那份的规则集链接)不进 DNS:解析的时候还没有 IP,拿什么都匹配不上。
// 端口同理:DNS 查询里没有目标端口。
const customDnsMatch = (rule, ruleLists) => {
  if (rule.type === 'ipCidr' || rule.type === 'geoip' || rule.type === 'port') return null
  const tag = customRuleTag(rule)
  if (tag) {
    const tags = dnsRulesetTags({ rulesets: [tag] }, ruleLists)
    return tags.length ? { rule_set: tags } : null
  }
  const field = { domain: 'domain', domainSuffix: 'domain_suffix', domainKeyword: 'domain_keyword' }[rule.type]
  return field ? { [field]: [rule.value] } : null
}

// 劫持模式下局域网的查询根本到不了 dnsmasq,而本地主机名(DHCP 租约名、/etc/hosts、
// *.lan)只有 dnsmasq 认得:这类名字交给 local(→ 路由器自己的 dnsmasq),其余一律不走
// local。dnsmasq 转发模式不需要:客户端本来就先经过 dnsmasq。禁用模式 sing-box 不答 DNS。
const LOCAL_SUFFIXES = ['.lan', '.local', '.home', '.internal', '.home.arpa']
const localNameRules = (dnsMode) => (dnsMode === 'hijack'
  ? [{ domain_suffix: LOCAL_SUFFIXES, server: 'dns-local' }, { domain_regex: ['^[^.]+$'], server: 'dns-local' }]
  : [])
const localServer = { type: 'local', tag: 'dns-local' }

// 按终端答的直连解析(终端分流里「直连」「不进内核」的终端):和 dns-direct 同一个上游,单独一个 tag。内核只把 dns-direct
// 那一组的应答写进入口放行集合(scripts/singbox-tcp-dns-hotfix 的 IsDirectTransport),这些终端的答案不能写进去:放行集合
// 按目标地址放行所有终端,一台直连终端查到的 YouTube 地址,不能让别的终端按 IP 访问它时也走直连
export const TERMINAL_DIRECT_TAG = 'dns-terminal-direct'

// 策略的域名类条件 → 一条 DNS 规则。ip_cidr 不进来:DNS 查询阶段还没有 IP,
// 拿它当条件永远不会命中,写进去只会让人以为生效了。
// 规则集同理,只收纯域名的那些(geosite-*、规则集链接的域名那份):含 IP 的规则集进了 DNS 规则
// 不是"不命中",而是更糟的"每个域名都先按这条查一遍再扔掉"——见 routing-model.mjs 的 dnsRulesetTags。
const policyDnsRule = (policy, server, ruleLists) => {
  const rule = server ? { server } : {}
  const rulesets = dnsRulesetTags(policy, ruleLists)
  if (rulesets.length) rule.rule_set = rulesets
  if (policy.domain.length) rule.domain = policy.domain
  if (policy.domainSuffix.length) rule.domain_suffix = policy.domainSuffix
  if (policy.domainKeyword.length) rule.domain_keyword = policy.domainKeyword
  return rule
}

const hasDomainCondition = (p, ruleLists) =>
  dnsRulesetTags(p, ruleLists).length > 0 || p.domain.length > 0 || p.domainSuffix.length > 0 || p.domainKeyword.length > 0

export const buildDns = (profile, options = {}) => buildDnsWithResolvers(profile, options).dns

// 生成 DNS 配置,同时交出"谁用哪台解析器"的映射:站点集名 → 解析器 tag、前置自定义分流每一行 → 解析器 tag
// (拒绝行 / 纯 IP 行为 null)、指定终端的来源 → 解析器 tag、兜底 → 解析器 tag。engine/routing.mjs 按它给
// 路由规则加"先解析再判 IP 规则"的 resolve 动作(第五轮 任务 4)
// 内核解析的地址族:没开 IPv6 只要 A(路由器上 v6 出不去,内核的 tun 把新的 v6 连接一律拒掉)。api/dns-upstream-test.mjs 的
// 临时实例也照这个来,不然它从运营商 DNS 拿到节点域名的 AAAA,往 v6 发包就是 sendmsg: operation not permitted
export const dnsStrategy = (profile) => (profile && profile.ipv6 ? 'prefer_ipv4' : 'ipv4_only')

export const buildDnsWithResolvers = (profile, options = {}) => {
  const strategy = dnsStrategy(profile)
  const dnsMode = (profile.dns && profile.dns.mode) || 'hijack'
  const directServer = directServerFor(profile, options)
  const localRules = localNameRules(dnsMode)
  const localServers = localRules.length ? [localServer] : []

  // reverse_mapping:内核记住"这个 IP 是哪个域名解析出来的",客户端随后按 IP 去连时把域名
  // 找回来再匹配规则。没有它,SSH / 游戏这类嗅不出域名的连接永远命中不了域名规则(比如
  // 「订阅和节点站点直连」),全落到兜底走代理。
  const resolvers = { policies: {}, custom: [], clients: [], fallback: 'dns-direct' }
  // 每条 dns.rules 归谁:内核日志里 `dns: match[N]` 只给规则下标,直连应答放行(system/direct-answer-bypass.mjs)
  // 要知道命中的是哪个站点集,才能按站点集顺序判"前面有没有走代理的 IP 规则会先抢走这个地址"。
  // 记成区段 [from, to):kind = custom(前置自定义第 index 行)/ directHosts / client / policy(第 index 个站点集)/ fallback
  const ruleOwners = []
  const own = (kind, index, name, body) => {
    const from = rules.length
    body()
    if (rules.length > from) ruleOwners.push({ from, to: rules.length, kind, index, name })
  }
  // DNS 重写(engine/dns-rewrite.mjs):命中源域名的查询交给面板进程在 127.0.0.1:7854 上开的重写服务,排在所有
  // 规则最前面——先定命中哪条重写,再谈别的
  const rewrite = normalizeDnsRewrite(profile.dns)
  const rewriteRules = rewrite.enabled ? rewriteDnsRules(rewrite.rules) : []
  const filterRules = options.filterRules || []
  const rewriteServers = rewriteRules.length ? [rewriteDnsServer()] : []
  // 终端分流:哪些终端的解析由内核按终端答(engine/client-routes.mjs 的 terminalDnsRedirected)。劫持模式下内核接得到每台
  // 终端的查询,老样子全部按终端答;dnsmasq 模式下只有入口把查询转给内核 DNS 入站的那几类(system/entry-bypass.mjs)
  const clientRoutes = Array.isArray(options.clientRoutes) ? options.clientRoutes : []
  const terminalDns = { dnsMode, splitDns: Boolean(profile.dns && profile.dns.split), directTag: (options.builtin || DEFAULT_BUILTIN).direct, blockTag: (options.builtin || DEFAULT_BUILTIN).block, ...(options.terminalDns || {}) }
  const answersPerTerminal = (cr) => dnsMode === 'hijack' || terminalDnsRedirected(cr, terminalDns)
  // dnsmasq 模式下转进来的终端不再经过 dnsmasq:本地主机名(DHCP 租约名、*.lan)照劫持模式的办法交回 dnsmasq,只管这些终端
  // 「只让这些终端进内核」名单外终端的专用入站(engine/config.mjs 的 DNS_DIRECT_INBOUND_TAG):查询一律直连解析
  const admitInbound = typeof terminalDns.admitDirect === 'string' ? terminalDns.admitDirect : ''
  const terminalLocalRules = dnsMode === 'dnsmasq'
    ? [
        ...clientRoutes.filter((cr) => terminalDnsRedirected(cr, terminalDns)).map(clientSourceMatch).filter(Boolean),
        ...(admitInbound ? [{ inbound: [admitInbound] }] : []),
      ].flatMap((match) => [{ ...match, domain_suffix: LOCAL_SUFFIXES, server: 'dns-local' }, { ...match, domain_regex: ['^[^.]+$'], server: 'dns-local' }])
    : []
  if (!profile.dns.split) {
    const only = { servers: [directServer, ...rewriteServers, ...localServers], final: 'dns-direct', strategy, reverse_mapping: true }
    if (rewriteRules.length || localRules.length || filterRules.length) only.rules = [...rewriteRules, ...localRules, ...filterRules]
    return { dns: only, resolvers, ruleOwners: [] }
  }

  const conf = normalizeRouting(profile.routing)
  const proxyUp = proxyUpstream(profile, options)
  const proxyExtras = proxyExtraUpstreams(profile, options)
  const directExtras = directExtraUpstreams(profile, options)
  const directExtraServers = directExtras.map((up, i) => dnsServerEntry(up, extraTag('dns-direct', i)))
  // 代理侧只有这一组解析器(见 proxyServerFor 上面):detour 先写兜底的 selector,部署时按目标分流改成上游地址该走的出口。
  // 上游 DNS 固定直连,不写 detour(部署时目标分流那步也跳过它,api/dns-upstream-route.mjs)
  const proxyDetour = (up) => (up.wan ? '' : conf.fallback.name)
  const servers = [
    directServer,
    ...directExtraServers,
    ...rewriteServers,
    proxyServerFor(proxyUp, PROXY_RESOLVER_TAG, proxyDetour(proxyUp)),
    ...proxyExtras.map((up, i) => proxyServerFor(up, extraTag(PROXY_RESOLVER_TAG, i), proxyDetour(up))),
  ]

  // 规则顺序和连接侧(routing.mjs)对齐:DNS 重写 → 本地主机名 → 前置自定义分流 → 订阅 / 节点站点直连 →
  // 终端分流 → 站点集 → 兜底。
  const rules = [...rewriteRules, ...localRules, ...terminalLocalRules, { ...HTTPS_RR_RULE, query_type: [...HTTPS_RR_RULE.query_type] }, ...filterRules]
  // 按终端答的直连解析器(见 TERMINAL_DIRECT_TAG):有终端用到时才建,备用上游跟 dns-direct 一样竞速
  let terminalDirectServers = false
  const terminalDirect = () => {
    if (!terminalDirectServers) {
      terminalDirectServers = true
      servers.push({ ...directServer, tag: TERMINAL_DIRECT_TAG }, ...directExtras.map((up, i) => dnsServerEntry(up, extraTag(TERMINAL_DIRECT_TAG, i))))
    }
    return TERMINAL_DIRECT_TAG
  }

  // 每个站点集的域名怎么解析,看它此刻实际走哪:
  //   · 走直连 → dns-direct(本地/直连解析,国内站点才拿得到就近的 CDN 地址)
  //   · 走代理 → 一台专属的 TCP 解析器,detour 指向同名 selector,解析和流量同一条路
  // "此刻走哪"优先用内核里当前的选择(options.selections:生成配置时从跑着的内核读
  // 出来的各 selector 的 now,顺着 now 一路下钻到叶子),内核没在跑时才退回档案里的默认。
  // 这一判断只在生成配置时做一次,之后就定死在 dns.rules 里了:代理页把某个站点集从
  // 直连改成代理(或反过来),这份规则就过期了。所以每次部署都把这张"谁走直连、谁走代理"
  // 的表落进 config.meta.json(见 system/deploy.mjs),代理页一改动就比对一次,真的翻面
  // 了才在后台重新生成配置(见 index.mjs)——用户不用自己去点重启。
  // 反过来,在代理线路之间换(香港 → 美国)不影响这张表:代理侧的解析器 detour 的是站点集
  // 自己的 selector,换线路它跟着换,不用重新生成。
  const builtin = options.builtin || DEFAULT_BUILTIN
  const members = policyOutboundOptions(options.groupTags || [], builtin)
  const selections = options.selections && typeof options.selections === 'object' ? options.selections : {}
  const goesDirect = (name, fallbackDefault) => policyGoesDirect(name, fallbackDefault, members, builtin, selections)
  // 规则集链接的形状表(哪些有域名那份),部署时从 rule-lists.json 得来;没有就按老样子引用
  const ruleLists = options.ruleLists && typeof options.ruleLists === 'object' ? options.ruleLists : {}
  // 前置自定义分流的解析跟着每一行自己的出口走:出口是设置里定死的,不随代理页的点选变化。
  // 少了这段,被强制送到某个节点的域名仍会在本地解析,拿到的是本地就近的 CDN 地址。
  // 每个用到的代理出口开一台解析器,同一个出口的多行共用一台。
  // 走代理的匹配:开了 FakeIP 就先给 A / AAAA 一条占位地址规则,其它查询类型(HTTPS / TXT …)仍走
  // 代理侧真实解析器
  const fakeIp = dnsFakeIpEnabled(profile)
  // 代理 v6 降为 IPv4:走代理的匹配 AAAA 直接回空(NOERROR、没有记录),终端就不会拿着 v6 地址去连代理线路。
  // 以前写在规则动作上的 strategy: ipv4_only 在 sing-box 1.14 里是遗留写法,和同一份 DNS 配置里的 query_type
  // (FakeIP 那条、兜底那条)不能共存、启动直接 FATAL(migration:ip_version and query_type behavior changes);
  // 改成 predefined 动作明确回空答案,语义和原来一样、和 1.13 也兼容(predefined 1.12 起就有)
  const proxyV4Only = ipv6ProxyMode(profile) === 'ipv4'
  // FakeIP 的占位只在「代理也管 v6」(交给节点)时连 AAAA 一起给;降级时 AAAA 已经回空,不进内核(bypass)时
  // 占位服务器没有 v6 段,AAAA 落到它上面只会回空——要让 AAAA 继续交给真实解析器(复核 F2)
  const fakeIpTypes = ipv6ProxyMode(profile) === 'node' ? ['A', 'AAAA'] : ['A']
  const emptyAAAA = (match) => ({ ...match, query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' })
  // 规则集 + 域名的匹配拆成两条(1.14 的规则集语义,见 routing-model.mjs 的 splitRuleSetConditions),每一半各带
  // 同一套 AAAA / FakeIP / 真实解析器规则
  // 代理侧配了备用上游时,每个代理解析器都要开一组:主 tag 一台、每个备用上游一台(detour 相同,
  // 只是上游地址不同)。没配备用时这个函数就只返回主 tag 那一台,和原来一模一样
  // 竞速规则:make(tail) 负责套上这条规则该有的条件(普通规则 / 带热切换开关的 logical),
  // 这里只管"并发发起 + 谁先回 NOERROR 谁赢 + 都没成时落回普通规则"。
  // 没配备用上游时退化成一条普通规则,和原来一字不差
  // 响应 tag 必须整份配置唯一(内核:duplicate evaluate tag 直接 FATAL)。同一条规则被
  // splitRuleSetConditions 拆成几段时,每段各占一个号
  let raceSeq = 0
  const pushRaceOrPlain = (make, tag, extras = proxyExtras) => {
    if (!extras.length) {
      rules.push(make({ server: tag }))
      return
    }
    const servers = [tag, ...extras.map((_, i) => extraTag(tag, i))]
    const round = raceSeq++
    const responseTag = (i) => `race-${round}-${i}`
    servers.forEach((t, i) => rules.push(make({ action: 'evaluate', server: t, tag: responseTag(i) })))
    // respond 规则只按响应 tag 匹配,不带域名条件:tag 是这一段专属的,不会串台。
    // 热切换把代理支关掉时上面的 evaluate 不命中,也就没有响应 tag,这几条自然不会触发
    servers.forEach((_, i) => rules.push({ match_response: responseTag(i), response_rcode: 'NOERROR', action: 'respond', race: true }))
    // 几个上游都没给出 NOERROR:落回主上游那条普通规则,行为和单上游时一样
    rules.push(make({ server: tag }))
  }
  const pushProxyRule = (match, tag) => {
    for (const part of splitRuleSetConditions(match)) {
      if (proxyV4Only) rules.push(emptyAAAA(part))
      if (fakeIp) rules.push({ ...part, query_type: fakeIpTypes, server: FAKEIP_TAG })
      pushRaceOrPlain((tail) => ({ ...part, ...tail }), tag)
    }
  }
  // 热切换(engine/flip.mjs):站点集此刻走直连还是走代理不定死在规则结构里。每个站点集两支都写——包了开关的
  // 代理支在前,直连支紧跟其后——翻面只改写开关文件,不重启内核。前置自定义分流 / 终端分流那两块的出口是设置里
  // 定死的,不看站点集类别,不用成对
  const flipFlags = flipFlagMap(conf)
  const pushFlipPair = (match, tag, flag) => {
    for (const part of splitRuleSetConditions(match)) {
      if (proxyV4Only) rules.push(andRule([part, { rule_set: [flag] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' }))
      // FakeIP:和老结构同一个顺序——占位地址那条排在真实解析器前面,同样挂着开关(翻到直连后 A 查询就回真实地址)
      if (fakeIp) rules.push(andRule([part, { rule_set: [flag] }, { query_type: fakeIpTypes }], { server: FAKEIP_TAG }))
      pushRaceOrPlain((tail) => andRule([part, { rule_set: [flag] }], tail), tag)
      pushRaceOrPlain((tail) => ({ ...part, ...tail }), 'dns-direct', directExtras)
    }
  }
  // 「不进内核」的终端整台不进内核,前置自定义分流也管不到它们,解析排在前置自定义分流前面:一律直连解析、给真实地址
  // (前置自定义分流里走代理的域名会拿到占位地址,那只有内核认得)
  const bypassFrom = rules.length
  if (admitInbound) pushRaceOrPlain((tail) => ({ inbound: [admitInbound], ...tail }), terminalDirect(), directExtras)
  for (const cr of clientRoutes) {
    if (cr.bypass !== true || !answersPerTerminal(cr)) continue
    const match = clientSourceMatch(cr)
    if (!match) continue
    pushRaceOrPlain((tail) => ({ ...match, ...tail }), terminalDirect(), directExtras)
    if (match.source_ip_cidr) resolvers.clients.push({ sources: cr.sources, server: TERMINAL_DIRECT_TAG })
  }
  if (rules.length > bypassFrom) ruleOwners.push({ from: bypassFrom, to: rules.length, kind: 'client', index: 0, name: '' })
  const custom = conf.custom
  if (customPolicyActive(custom)) {
    custom.rules.forEach((rule, customIndex) => own('custom', customIndex, '', () => {
      const match = customDnsMatch(rule, ruleLists)
      if (!match) { resolvers.custom.push(null); return }
      const target = customOutboundTag(rule, builtin)
      if (target === builtin.direct) {
        pushRaceOrPlain((tail) => ({ ...match, ...tail }), 'dns-direct', directExtras)
        resolvers.custom.push('dns-direct')
        return
      }
      // 出口是拒绝的行:解析也拒,和连接侧一致(明确拒绝不能变成"先解析再说")
      if (target === builtin.block) {
        rules.push({ ...match, action: 'reject' })
        resolvers.custom.push(null)
        return
      }
      pushProxyRule(match, PROXY_RESOLVER_TAG)
      resolvers.custom.push(PROXY_RESOLVER_TAG)
    }))
  }

  // 订阅和节点站点直连:它们的域名也用直连侧解析。部署的配置引用域名那份本地规则集(directHostSets,engine/direct-hosts.mjs,
  // 地址变了只换文件、不重启内核);直接给地址的(directHosts,测试)照旧写进规则
  const dh = options.directHosts
  if (options.directHostSets) {
    own('directHosts', 0, '', () => pushRaceOrPlain((tail) => ({ rule_set: [options.directHostSets.domain], ...tail }), 'dns-direct', directExtras))
  } else if (dh && dh.domains && dh.domains.length) {
    own('directHosts', 0, '', () => pushRaceOrPlain((tail) => ({ domain: dh.domains, ...tail }), 'dns-direct', directExtras))
  }

  // 终端分流:指定来源的终端,解析跟着它的出口是直连还是代理(直连给真实地址,代理给占位地址 / 交给代理侧解析器)。内核要看得到
  // 终端的来源地址才能按终端答:劫持模式下局域网的查询都进内核;dnsmasq 转发模式下查询是 dnsmasq 转来的,来源一律是本机
  // (审核 B3),只有入口把查询直接转给内核 DNS 入站的那几类终端才看得到(answersPerTerminal)。
  // 「不进内核」的终端上面已经排在前置自定义分流前面答过了,这里不再写
  const clientFrom = rules.length
  {
    for (const cr of clientRoutes) {
      if (cr.bypass === true || !answersPerTerminal(cr)) continue
      // 按 IP 的写 source_ip_cidr,按 MAC 的写 source_mac_address(engine/client-routes.mjs)
      const match = clientSourceMatch(cr)
      if (!match || !cr.outbound) continue
      // 预解析(engine/routing.mjs 的 preResolveRules,本轮不进正式配置)只认来源网段,按 MAC 的不记
      const byIp = Boolean(match.source_ip_cidr)
      if (cr.outbound === builtin.block) {
        rules.push({ ...match, action: 'reject' })
        continue
      }
      if (cr.outbound === builtin.direct) {
        pushRaceOrPlain((tail) => ({ ...match, ...tail }), terminalDirect(), directExtras)
        if (byIp) resolvers.clients.push({ sources: cr.sources, server: TERMINAL_DIRECT_TAG })
        continue
      }
      if (options.knownOutbounds instanceof Set && !options.knownOutbounds.has(cr.outbound)) continue
      pushProxyRule({ ...match }, PROXY_RESOLVER_TAG)
      if (byIp) resolvers.clients.push({ sources: cr.sources, server: PROXY_RESOLVER_TAG })
    }
  }

  if (rules.length > clientFrom) ruleOwners.push({ from: clientFrom, to: rules.length, kind: 'client', index: 0, name: '' })

  conf.activePolicies.forEach((policy, index) => {
    if (!hasDomainCondition(policy, ruleLists)) return
    // 此刻走直连的站点集也写代理那一支(挂着开关):它随时可能翻到代理
    own('policy', index, policy.name, () => pushFlipPair(policyDnsRule(policy, '', ruleLists), PROXY_RESOLVER_TAG, flipFlags.get(policy.name)))
    resolvers.policies[policy.name] = goesDirect(policy.name, policy.default) ? 'dns-direct' : PROXY_RESOLVER_TAG
  })
  const fallbackFrom = rules.length

  const fallbackDirect = goesDirect(conf.fallback.name, conf.fallback.default)
  resolvers.fallback = fallbackDirect ? 'dns-direct' : PROXY_RESOLVER_TAG
  // 兜底也成对。final 带不了条件,代理支写成显式规则排在最后,顺序:AAAA 空应答(代理 v6 降为 IPv4 时)→
  // FakeIP 占位 → 代理侧解析器;都挂在兜底的开关上。final 固定指直连侧
  if (proxyV4Only) rules.push(andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { query_type: ['AAAA'] }], { action: 'predefined', rcode: 'NOERROR' }))
  if (fakeIp) {
    // v6 占位段只在「代理也管 v6」(交给节点)时给;降级和不进内核都不给——不进内核时终端拿到占位 v6 会直接
    // 往 WAN 发,哪都到不了
    servers.push({ type: 'fakeip', tag: FAKEIP_TAG, inet4_range: FAKEIP_V4, ...(ipv6ProxyMode(profile) === 'node' ? { inet6_range: FAKEIP_V6 } : {}) })
    // 兜底走代理时,上面都没命中的域名 A(交给节点时连 AAAA)也发占位地址
    rules.push(andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { query_type: fakeIpTypes }], { server: FAKEIP_TAG }))
  }
  // 兜底代理支的真实解析器排在最后(其它查询类型、以及没开 FakeIP 时的 A 都走它)
  pushRaceOrPlain((tail) => ({ rule_set: [FLIP_FALLBACK_TAG], ...tail }), PROXY_RESOLVER_TAG)
  servers.push(...(localServers.length || terminalLocalRules.length ? [localServer] : []))
  // final 带不了条件,也就没法竞速。直连侧配了备用上游时,在规则表最后补一段**无条件**的竞速:
  // 前面都没命中的查询走到这里,几家一起问、谁先回 NOERROR 用谁的;都没成就落到 final(主上游),
  // 和单上游时一样。没配备用时这段整个不生成
  if (directExtras.length) {
    const tags = ['dns-direct', ...directExtras.map((_, i) => extraTag('dns-direct', i))]
    const round = raceSeq++
    tags.forEach((t, i) => rules.push({ action: 'evaluate', server: t, tag: `race-${round}-${i}` }))
    tags.forEach((_, i) => rules.push({ match_response: `race-${round}-${i}`, response_rcode: 'NOERROR', action: 'respond', race: true }))
  }
  if (rules.length > fallbackFrom) ruleOwners.push({ from: fallbackFrom, to: rules.length, kind: 'fallback', index: 0, name: conf.fallback.name })
  const dns = {
    servers,
    rules,
    // 兜底走代理时由上面那条挂着开关的规则接走;走直连时落到这里
    final: 'dns-direct',
    strategy,
    reverse_mapping: true,
  }
  return { dns, resolvers, ruleOwners }
}

// 把目标分流对每个代理侧上游的判定(api/dns-upstream-route.mjs 的 routeProxyDnsUpstreams)写进解析器的 detour:
//   · 命中的出口是内置直连 → 不写 detour(默认出站就是直连;显式 detour 到空的直连出站内核会拒)
//   · 命中拒绝 → detour 到内置拒绝:目标分流不让访问这个地址,内核也不去访问(代理侧解析会失败,部署日志里说)
//   · 其余(站点集 / 兜底的 selector、前置自定义那一行的出口)→ detour 到它
//   · 判不出来(规则集读不了等)→ 保持生成时的兜底 selector
// 按地址 + 端口对上解析器(主上游 dns-proxy、备用 dns-proxy__altN)。返回每台解析器最后的 detour(直连为空串)
export const applyProxyUpstreamRoutes = (config, routes, builtin = DEFAULT_BUILTIN) => {
  const servers = (config && config.dns && Array.isArray(config.dns.servers)) ? config.dns.servers : []
  const applied = []
  for (const s of servers) {
    if (!s || !(s.tag === PROXY_RESOLVER_TAG || String(s.tag).startsWith(`${PROXY_RESOLVER_TAG}__alt`))) continue
    const port = s.server_port || DEFAULT_DNS_PORT
    const route = (Array.isArray(routes) ? routes : []).find((r) => r && r.server === s.server && Number(r.port || DEFAULT_DNS_PORT) === port)
    if (route && !route.error) {
      if (route.reject) s.detour = builtin.block
      else if (!route.outbound || route.outbound === builtin.direct) delete s.detour
      else s.detour = route.outbound
    }
    applied.push({ tag: s.tag, server: s.server, port, detour: s.detour || '' })
  }
  return applied
}

// 这次生成把每个站点集(以及兜底)判成了"直连解析"还是"代理解析"。落进 config.meta.json,
// 下次代理页有人改出口时拿它比对:同一个名字两边不一样,说明磁盘上那份 dns.rules 已经
// 过期,要重新生成配置(见 api/deploy-runner.mjs 的 dnsClassesFlipped)。
// 只收有域名条件的站点集:只按 IP 分流的那些本来就不进 DNS 规则,改它不会让规则过期。
// 规则集链接这里一律当作有域名那份(不传形状表):写表和比对的两边都这么算,才不会因为
// 一边知道形状、一边不知道而误判"翻面"。多算一个站点集只是多比对一次,没有代价。
export const dnsPolicyClasses = (routing, members = ['direct'], builtin = DEFAULT_BUILTIN, selections = {}) => {
  const conf = normalizeRouting(routing)
  const klass = (name, def) => (policyGoesDirect(name, def, members, builtin, selections) ? 'direct' : 'proxy')
  const out = {}
  for (const p of conf.activePolicies) {
    if (!hasDomainCondition(p, {})) continue
    out[p.name] = klass(p.name, p.default)
  }
  out[conf.fallback.name] = klass(conf.fallback.name, conf.fallback.default)
  return out
}
