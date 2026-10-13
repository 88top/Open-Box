import { createPaths } from '../system/paths.mjs'
import { prepareDnsFilter, readFilterArtifact } from '../system/dns-filter.mjs'
import { filterForwardPlan } from '../engine/dns-filter.mjs'
import { randomBytes } from 'node:crypto'
import { activeNodes } from './subscriptions.mjs'
import { kernelErrorText, kernelRejectedNodes } from '../system/validate.mjs'
import { chainNodes, resolveChainNodes } from '../engine/chain-proxy.mjs'
import { readSystemDns } from '../system/resolv.mjs'
import { normalizeDnsRewrite, rewriteForwardDomains } from '../engine/dns-rewrite.mjs'
import { readLocalSubnets } from '../system/local-subnets.mjs'
import { resolveHostsToCidrs } from '../system/resolve-hosts.mjs'
import { collectDirectHosts } from '../engine/direct-hosts.mjs'
import { PURE_TUN_ENTRY_REASON, bypassPlanKey, dnsmasqForwardPlan, entryModePlan, nativeBypassPlan, normalizeRouting, policyClasses, routingFingerprint } from '../engine/routing-model.mjs'
import { emitUserGroups } from '../engine/user-groups.mjs'
import { normalizeClientRoutes } from '../engine/client-routes.mjs'
import { builtinTags } from '../engine/user-groups.mjs'
import { buildConfigFromParts } from '../engine/client-build.mjs'
import { applyProxyUpstreamRoutes, directResolverServers, dnsPolicyClasses } from '../engine/dns.mjs'
import { routeProxyDnsUpstreams } from './dns-upstream-route.mjs'
import { deployConfig, configMetaPath, applyDnsForwardNow, dnsForwardMeta, profileAsDeployed } from '../system/deploy.mjs'
import { applyFlipDiff, clearFlipStateCache, flipTargetState, writeFlipFiles } from '../system/flip-files.mjs'
import { writeNodeDirectSets } from '../system/node-direct-files.mjs'
import { ensureRuleLists } from '../system/rule-lists.mjs'
import { shareRegionRuleUrls } from '../system/share-region-lists.mjs'
import { dropRuleSetIndex } from '../system/ruleset-index.mjs'
import { ruleListIpTag } from '../engine/rule-list.mjs'
import { resolveNativeBypass } from '../system/native-bypass.mjs'
import { dnsFakeIpEnabled, ipv6ProxyMode } from '../engine/dns.mjs'
import { policyOutboundOptions } from '../engine/routing-model.mjs'
import { enableService, disableService, serviceStatus } from '../system/service.mjs'
import { CLASH_API_BASE } from './penetration.mjs'

// 生成配置前问一下正在跑的内核:每个 selector 现在选的是谁。DNS 规则按它判各站点集
// 此刻走直连还是代理(见 engine/dns.mjs)。内核没在跑就是空表,退回档案默认。
export const fetchSelections = async (fetchImpl, secret) => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    let res
    try {
      res = await fetchImpl(`${CLASH_API_BASE}/proxies`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res || !res.ok) return {}
    const body = await res.json()
    const out = {}
    for (const [name, p] of Object.entries((body && body.proxies) || {})) {
      if (p && typeof p.now === 'string' && p.now) out[name] = p.now
    }
    return out
  } catch {
    return {}
  }
}

// 选择即默认:用户在代理页给某个站点集(或兜底)挑了出口,就把它写进档案当这个站点集的 default。
// 不写的话,用户新建的站点集没有 default,生成配置时按"成员表第一项"= 直连算;内核停着时的
// 部署(升级脚本)又只能靠快照——快照每分钟才刷新一次,刚切换就升级,生成的 DNS 规则还是直连,
// 规则页就一直提示"DNS 规则是旧的,重启内核",重启后 selector 又退回 直连,循环往复。
// 写进档案后,不管快照新不新,selector 的 default 和 DNS 规则都跟着用户的选择走。
// 内置直连 / 拒绝按占位符('direct' / 'block')存:它们可以改名,档案里不存当时的名字。
export const persistSelectionsAsDefaults = (store, selections) => {
  if (!store || typeof store.getProfile !== 'function' || typeof store.setProfile !== 'function') return false
  const map = selections && typeof selections === 'object' ? selections : {}
  if (!Object.keys(map).length) return false
  const profile = store.getProfile() || {}
  const routing = profile.routing && typeof profile.routing === 'object' ? profile.routing : {}
  const builtin = builtinTags(typeof store.getGroups === 'function' ? store.getGroups() : [])
  const stored = (name) => (name === builtin.direct ? 'direct' : name === builtin.block ? 'block' : name)
  const conf = normalizeRouting(routing)
  let changed = false
  const policies = (Array.isArray(routing.policies) ? routing.policies : []).map((p) => {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') return p
    const picked = map[p.name.trim()]
    if (typeof picked !== 'string' || !picked) return p
    const next = stored(picked)
    if ((p.default || '') === next) return p
    changed = true
    return { ...p, default: next }
  })
  let fallbackDefault = routing.fallbackDefault
  const pickedFallback = map[conf.fallback.name]
  if (typeof pickedFallback === 'string' && pickedFallback) {
    const next = stored(pickedFallback)
    if ((fallbackDefault || '') !== next) {
      fallbackDefault = next
      changed = true
    }
  }
  if (!changed) return false
  const patch = { routing: { ...routing, policies } }
  if (fallbackDefault !== undefined) patch.routing.fallbackDefault = fallbackDefault
  store.setProfile(patch)
  return true
}

// 磁盘上那份配置的 dns.rules 是按"哪个站点集走直连、哪个走代理"定死的(见 engine/dns.mjs)。
// 用户在代理页把某个站点集从直连改到代理(或反过来),这份规则就过期了:走代理的域名还在用
// 直连侧解析(拿到的是被污染的地址),或者走直连的域名还在往代理侧的解析器发查询——而那台
// 解析器此刻 detour 的是一条已经改成直连的线路,查询直接超时,整个域名解析全断。
// 所以每次改完出口都比一次:部署时落进 config.meta.json 的那张表 vs 现在的选择。
// 只比两边都有的名字——档案里新加、还没部署过的站点集不算数,免得把"设置已保存但用户还
// 没点生效"的改动顺带应用出去。
export const dnsClassesFlipped = async (ctx, paths, store, selections) => {
  try {
    const meta = JSON.parse(await ctx.readFile(configMetaPath(paths)))
    const prev = meta && meta.dnsPolicyClasses
    const members = meta && Array.isArray(meta.dnsPolicyMembers) ? meta.dnsPolicyMembers : []
    if (!prev || typeof prev !== 'object' || !members.length) return false
    const builtin = builtinTags(typeof store.getGroups === 'function' ? store.getGroups() : [])
    const next = dnsPolicyClasses((store.getProfile() || {}).routing, members, builtin, selections || {})
    return Object.keys(next).some((k) => Object.prototype.hasOwnProperty.call(prev, k) && prev[k] !== next[k])
  } catch {
    // 没有元数据(还没部署过 / 老版本升上来的)就不动:下次部署会把表补上
    return false
  }
}

// 第一层的计划(入口原生旁路的集合、DNS 转发的三态)也是生成配置时按当时的选择定死的。只按 IP
// 分流的站点集(geoip-cn → 直连)不进 DNS 分类表,代理页把它从直连切到代理时 dnsClassesFlipped
// 看不出来,入口的 nft 集合还按旧的放行(复审 R3)。所以再比一次 config.meta.json 里的 firstLayer。
export const firstLayerChanged = async (ctx, paths, store, selections) => {
  try {
    const meta = JSON.parse(await ctx.readFile(configMetaPath(paths)))
    const prev = meta && meta.firstLayer
    const members = meta && Array.isArray(meta.dnsPolicyMembers) ? meta.dnsPolicyMembers : []
    if (!prev || typeof prev !== 'object' || !members.length) return false
    const profile = store.getProfile() || {}
    const builtin = builtinTags(typeof store.getGroups === 'function' ? store.getGroups() : [])
    const dnsMode = (profile.dns && profile.dns.mode) || 'hijack'
    const bypass = nativeBypassPlan(profile.routing, { members, builtin, selections: selections || {}, clientRoutes: normalizeClientRoutes(profile.clientRoutes, { directTag: builtin.direct }), fakeIp: dnsFakeIpEnabled(profile), dnsMode, enabled: profile.directBypass !== false })
    // 和元数据里计划阶段的结论比(pending 的重叠核对要到部署时才做)。指纹含候选集合、核对对象(名字 + 集合 +
    // CIDR)和 FakeIP 前提——"核对对象从一条变成两条"这种变化只比站点集名字会漏掉(第四轮 T2)。老元数据没有
    // 指纹就退回比集合 / pending 名字
    if (typeof prev.nativeBypassPlanKey === 'string') {
      if (prev.nativeBypassPlanKey !== bypassPlanKey(bypass)) return true
    } else {
      // 升级前写的元数据没有指纹:有 pending 的计划光比名字看不出核对对象的变化,宁可多重生成一次(之后的元数据
      // 就带指纹了);没有 pending 的照旧比集合
      const sortedSets = (v) => [...(Array.isArray(v) ? v : [])].sort().join('\n')
      const planned = prev.nativeBypassPlanned || { sets: (prev.nativeBypass || {}).sets, pending: [] }
      const pendingNames = (v) => [...(Array.isArray(v) ? v : [])].map((x) => (typeof x === 'string' ? x : x.policy)).sort().join('\n')
      if (sortedSets(planned.sets) !== sortedSets(bypass.sets) || pendingNames(planned.pending) !== pendingNames(bypass.pending)) return true
      if (bypass.pending.length || (Array.isArray(planned.pending) && planned.pending.length)) return true
    }
    // IPv6 分层 · 代理 v6 降为 IPv4:每条走代理的路由规则前面有一条 v6 拒绝,纯 IP 站点集在直连 / 代理之间
    // 切换时 DNS 分类看不出来,但这条保护要跟着变(第四轮 T3)。按元数据里生成时的出口类别表比,只比两边
    // 都有的名字(和 dnsClassesFlipped 一个道理)。屏蔽 QUIC 的拒绝规则是同一个套路,同样要比——
    // 它刚加进来时漏了这里,纯 IP 站点集翻面后 QUIC 拒绝会留在已经直连的站点集上(或该拒的没拒)
    const v6Guard = prev.ipv6 === 'ipv4' && ipv6ProxyMode(profile) === 'ipv4'
    const quicGuard = prev.rejectQuic === true && profile.rejectQuic === true
    if (v6Guard || quicGuard) {
      // 升级前的元数据没有出口类别表:不知道生成时的 v6 保护落在哪些站点集上,宁可多重生成一次
      if (!prev.policyClasses || typeof prev.policyClasses !== 'object') return true
      const next = policyClasses(profile.routing, members, builtin, selections || {})
      if (Object.keys(next).some((k) => Object.prototype.hasOwnProperty.call(prev.policyClasses, k) && (prev.policyClasses[k] === 'proxy') !== (next[k] === 'proxy'))) return true
    }
    if (prev.dnsMode === 'dnsmasq') {
      // 这里只能算到计划阶段(规则集要到部署时才展开),所以和元数据里计划阶段的模式比;老元数据
      // 没有这个字段时退回和实际模式比
      const rewrite = normalizeDnsRewrite(profile.dns)
      const forward = filterForwardPlan(profile, dnsmasqForwardPlan(profile.routing, members, builtin, selections || {}, { rewriteDomains: rewrite.enabled ? rewriteForwardDomains(rewrite.rules) : [] }))
      if (forward.mode !== (prev.dnsForwardPlanned || prev.dnsForward)) return true
    }
    return false
  } catch {
    return false
  }
}

// 内核在跑就用它此刻的选择并顺手存快照(同时按"选择即默认"写进档案);读不到(内核停着、
// API 没起来)就退回上次的快照。
export const resolveSelections = (store, live) => {
  const hasLive = live && typeof live === 'object' && Object.keys(live).length > 0
  if (hasLive) {
    try { store.setSelectionsSnapshot?.(live) } catch { /* 存不上不影响这次部署 */ }
    try { persistSelectionsAsDefaults(store, live) } catch { /* 写不进档案也不影响这次部署 */ }
    return live
  }
  try { return store.getSelectionsSnapshot?.() || {} } catch { return {} }
}

// deployConfig 对 start/verify/error 三个阶段都会自行调用 rollbackToDirect 回到直连,
// 但 rollbackToDirect 只管停服务/还原 DNS/撤防火墙,不动"开机自启"标志位——
// 若不在这里额外 disable,曾经 enable 过的内核在下次重启时仍会被 procd 拉起,
// 而此时配置/DNS 接管已经回滚,等于开机直接指向一份死配置。
const ROLLED_BACK_STAGES = new Set(['start', 'verify', 'error'])

export const STATUS_BY_STAGE = {
  conflict: 409,
  validate: 409,
  // 被停止 / 回滚取消:请求本身没错,只是被后来的用户动作抢先了
  cancelled: 409,
  // 规则集拉不下来是外部依赖(GitHub / 加速站)不可用,不是请求本身有问题,也没动
  // 任何系统状态 —— 用 503 与"配置有毛病"的 409 区分开。
  rulesets: 503,
  start: 500,
  verify: 500,
  error: 500,
}

// 从当前 store 状态(profile + 节点 + 按区域分组)组装一份 sing-box 配置。
// clash secret 独立存储,只在此处临时注入 profile 副本供 buildConfig 写入
// experimental.clash_api.secret,不回写 store.profile。
// systemDns 是路由器系统的上游 DNS(见 system/resolv.mjs):「上游 DNS」(档案记号 wan)用的就是它,不能让 sing-box
// 去问系统解析器——dnsmasq 接管模式下系统解析器就是 dnsmasq,而 dnsmasq 的上游又是 sing-box,一问就死循环。
// 预览接口没有 ctx 也照样能出配置,按地区回落到随包默认。
// profilePatch:在当前档案上临时盖一层再生成(不落库)。部署时 auto_redirect 起不来要降级
// 重试就靠它把 tun.autoRedirect 关掉重生成一份(见 system/deploy.mjs)。
// 当前档案 + 此刻的选择 → 旁路计划(纯函数那一步)。部署前和选择同步时都用它,口径一致
export const currentBypassPlan = (store, selections, profile = store.getProfile() || {}) => {
  const groups = typeof store.getGroups === 'function' ? store.getGroups() : []
  const builtin = builtinTags(groups)
  const { publicTags } = emitUserGroups(groups, activeNodes(store), {})
  const members = policyOutboundOptions(publicTags, builtin)
  return nativeBypassPlan(profile.routing, { members, builtin, selections: selections || {}, clientRoutes: normalizeClientRoutes(profile.clientRoutes, { directTag: builtin.direct }), fakeIp: dnsFakeIpEnabled(profile), dnsMode: (profile.dns && profile.dns.mode) || 'hijack', enabled: profile.directBypass !== false })
}

// 代理页改完出口之后的同步判断 + 执行:DNS 分类翻面、或第一层计划(入口旁路指纹 / DNS 转发三态 / v6 保护
// 的出口类别)变了,就在后台重新生成配置并重启内核。index.mjs 的选择同步和开发路由器的运行时验收都走这
// 一个入口,保证"判断变了"之后调用方真的执行了更新(第四轮 T2 / T3)
// 热切换的成员表 / 内置名字 / 目标状态:和 currentBypassPlan 同一个口径(档案 + 此刻的选择)
// 入口模式(白名单 / 黑名单,engine/routing-model.mjs 的 entryModePlan):和旁路计划同一口径。只在有 nft 重定向时有意义,
// 纯 tun 一律黑名单(那边的名单是编进路由表的,没验证过能在线换)
// 元数据里记的入口模式:模式、原因、名单里有哪些集合、手写网段数(网段本身不进元数据)
export const entryModeMeta = (entryMode) => ({ mode: entryMode.mode, reason: entryMode.reason || '', needSets: entryMode.needSets || [], needCidrs: (entryMode.needCidrs || []).length, directAnswer: Boolean(entryMode.directAnswer) })
export const currentEntryMode = (store, selections, profile = store.getProfile() || {}) => {
  const autoRedirect = Boolean(profile.tun && profile.tun.autoRedirect && ((profile.dns && profile.dns.mode) || 'hijack') !== 'off')
  if (!autoRedirect) return { mode: 'blacklist', reason: PURE_TUN_ENTRY_REASON, fakeIp: false, needSets: [], needCidrs: [] }
  const groups = typeof store.getGroups === 'function' ? store.getGroups() : []
  const builtin = builtinTags(groups)
  const { publicTags } = emitUserGroups(groups, activeNodes(store), {})
  const members = policyOutboundOptions(publicTags, builtin)
  return entryModePlan(profile.routing, { members, builtin, selections: selections || {}, clientRoutes: normalizeClientRoutes(profile.clientRoutes, { directTag: builtin.direct }), fakeIp: dnsFakeIpEnabled(profile), dnsMode: (profile.dns && profile.dns.mode) || 'hijack', enabled: profile.directBypass !== false })
}
const flipStateNow = (store, selections, nativeBypass, entryMode = null, profile = store.getProfile() || {}) => {
  const groups = typeof store.getGroups === 'function' ? store.getGroups() : []
  const builtin = builtinTags(groups)
  const { publicTags } = emitUserGroups(groups, activeNodes(store), {})
  const members = policyOutboundOptions(publicTags, builtin)
  return { ...flipTargetState({ routing: profile.routing, members, builtin, selections: selections || {}, nativeBypass, entryMode: entryMode || currentEntryMode(store, selections, profile) }), members, builtin }
}

// 热切换:站点集在直连 / 代理之间翻面,不重启内核(engine/flip.mjs)。
// 按**已经部署的那份**元数据里记的开关表比——档案改了还没重启内核时,运行中的配置用的还是老的那套开关,
// 照当前档案算会写错文件。只重写变了的开关 / 旁路动态集(内核盯着文件自己重载),dnsmasq 模式下顺带重算转发名单,
// 最后把元数据更新到此刻的状态(generatedAt 不动:故障转移管理器拿它当配置版本)。
// 返回 { ok:true, changed } 或 { ok:false, reason }——后者由调用方决定要不要回到老的重启路径。
export const applyHotFlip = async ({ store, ctx, paths, selections, log = () => {} }) => {
  const startedAt = Date.now()
  let meta
  try { meta = JSON.parse(await ctx.readFile(configMetaPath(paths))) } catch { return { ok: false, reason: '读不到部署元数据' } }
  // 入口相关的设置(FakeIP、DNS 模式、直连不进内核、终端分流、auto_redirect)按部署时记下的算,保存了还没重启的
  // 改动不在翻面时提前生效一半(system/deploy.mjs 的 hotFlipInputs);分流设置本身改过由下面的 routingHash 挡
  const profile = profileAsDeployed(store.getProfile() || {}, meta)
  // 运行中的配置还是老结构:从带开关的老版本(v0.1.207 / v0.1.208 开着「切换重启内核」)升上来、内核还没按新版本重新部署过
  if (!meta || !meta.flip || meta.flip.mode !== 'hot' || !meta.flip.flags) return { ok: false, reason: '运行中的配置不是热切换结构(老版本生成的,还没重新部署)' }
  // 分流设置改过(界面里改了站点集、或者刚导入了一份备份)而内核还没重启:运行中的规则是按老设置生成的,拿新设置去算
  // 开关该开该关会写错——比如导入的站点集 id 相同、名字不同,内核里查不到它的选择,就会按档案默认值去改一个正在用的开关。
  // 这种时候不热切换,交还给调用方(经面板切换的会走老路径重新部署,新设置随之生效;每分钟对账则什么都不做)
  if (typeof meta.routingHash === 'string' && meta.routingHash && meta.routingHash !== routingFingerprint(profile.routing)) {
    return { ok: false, reason: '分流设置改过,还没重启内核' }
  }
  const dynamicBypass = meta.flip.bypassMode === 'dynamic'
  try {
    // 先只算开关(便宜):一个都没变就什么都不做——在代理线路之间换(香港 → 美国)、每分钟对账,绝大多数落在这里
    const cheap = flipStateNow(store, selections, null, null, profile)
    const known = (tag) => Object.prototype.hasOwnProperty.call(meta.flip.flags, tag)
    const flagsChanged = Object.keys(cheap.flags).filter((tag) => known(tag) && Boolean(meta.flip.flags[tag]) !== cheap.flags[tag])
    if (!flagsChanged.length) return { ok: true, changed: { flags: [], bypass: [] }, ms: Date.now() - startedAt }
    // 类别真变了才重算入口旁路(每个 geoip 集合要起一次内核进程解码;核对不过的一律不旁路)
    const plan = currentBypassPlan(store, selections, profile)
    if (!dynamicBypass && bypassPlanKey(plan) !== (meta.firstLayer && meta.firstLayer.nativeBypassPlanKey)) {
      return { ok: false, reason: '入口旁路变了,而这台设备没有 nft 重定向(纯 tun),旁路集合换不了' }
    }
    const nativeBypass = dynamicBypass ? await resolveNativeBypass(ctx, paths, plan) : (meta.firstLayer && meta.firstLayer.nativeBypass) || { enabled: false, sets: [] }
    const entryMode = currentEntryMode(store, selections, profile)
    const next = flipStateNow(store, selections, nativeBypass, entryMode, profile)
    // 只动部署时就在的开关 / 候选(档案里新加、还没部署的站点集,运行中的配置里没有它的规则)。
    // need 侧同理:运行中的配置没有 route_address_set(老版本部署的)时 meta.flip.need 是空的,一份都不写
    const knownBypass = (tag) => Object.prototype.hasOwnProperty.call(meta.flip.bypass || {}, tag)
    const knownNeed = (tag) => Object.prototype.hasOwnProperty.call(meta.flip.need || {}, tag)
    const scoped = {
      flags: Object.fromEntries(Object.entries(next.flags).filter(([tag]) => known(tag))),
      bypass: Object.fromEntries(Object.entries(next.bypass).filter(([tag]) => knownBypass(tag))),
      bypassContent: Object.fromEntries(Object.entries(next.bypassContent || {}).filter(([tag]) => knownBypass(tag))),
      bypassTrimmed: Object.fromEntries(Object.entries(next.bypassTrimmed || {}).filter(([tag]) => knownBypass(tag))),
      need: Object.fromEntries(Object.entries(next.need || {}).filter(([tag]) => knownNeed(tag))),
      needCidrs: Object.fromEntries(Object.entries(next.needCidrs || {}).filter(([tag]) => knownNeed(tag))),
    }
    const changed = await applyFlipDiff(ctx, paths, meta.flip, scoped, { dynamicBypass })
    // dnsmasq 接管模式:走代理的域名名单跟着类别变(名单没变时这一步什么都不做,不重启 dnsmasq)
    const dnsMode = (profile.dns && profile.dns.mode) || 'hijack'
    let forwardMeta = {}
    let queryLogMeta = {}
    if (dnsMode === 'dnsmasq' && meta.dnsMode === 'dnsmasq') {
      const { dnsForward, dnsPlanned, applied } = await applyDnsForwardNow(ctx, paths, { profile, policyMembers: meta.dnsPolicyMembers || next.members, builtin: next.builtin, selections: selections || {}, dnsMode })
      forwardMeta = dnsForwardMeta(dnsMode, dnsForward, dnsPlanned)
      if (applied && applied.queryLog) queryLogMeta = { dnsmasqQueryLog: applied.queryLog }
    }
    const members = Array.isArray(meta.dnsPolicyMembers) && meta.dnsPolicyMembers.length ? meta.dnsPolicyMembers : next.members
    const updated = {
      ...meta,
      ...queryLogMeta,
      dnsPolicyClasses: dnsPolicyClasses(profile.routing, members, next.builtin, selections || {}),
      firstLayer: {
        ...(meta.firstLayer || {}),
        ...forwardMeta,
        ...(dynamicBypass ? {
          nativeBypass: nativeBypass.enabled ? { ...nativeBypass, via: 'nft' } : nativeBypass,
          nativeBypassPlanned: { sets: plan.sets, pending: plan.pending.map((x) => x.policy) },
          nativeBypassPlanKey: bypassPlanKey(plan),
          ...(Object.keys(meta.flip.need || {}).length ? { entryMode: entryModeMeta(entryMode) } : {}),
        } : {}),
        policyClasses: next.classes,
      },
      flip: { ...meta.flip, flags: { ...meta.flip.flags, ...scoped.flags }, bypass: { ...(meta.flip.bypass || {}), ...scoped.bypass }, bypassContent: { ...(meta.flip.bypassContent || {}), ...scoped.bypassContent }, ...(Object.keys(meta.flip.need || {}).length ? { need: { ...meta.flip.need, ...scoped.need }, entryMode: next.entryMode } : {}), flippedAt: new Date().toISOString() },
    }
    await ctx.writeFile(configMetaPath(paths), JSON.stringify(updated, null, 2))
    // 读规则的各处缓存着开关状态(1 秒),刚翻完立刻作废
    clearFlipStateCache()
    const names = Object.entries(meta.flip.names || {}).filter(([, tag]) => changed.flags.includes(tag)).map(([name, tag]) => `「${name}」→${scoped.flags[tag] ? '代理' : '直连'}`)
    const ms = Date.now() - startedAt
    const modeNote = meta.flip.entryMode && next.entryMode !== meta.flip.entryMode ? `,入口 ${meta.flip.entryMode === 'whitelist' ? '默认放行' : '默认进内核'} → ${next.entryMode === 'whitelist' ? '默认放行' : '默认进内核'}` : ''
    log(`[proxies] 热切换:${names.join('、') || '开关'}${changed.bypass.length ? `,入口旁路 ${changed.bypass.length} 份集合` : ''}${(changed.need || []).length ? `,进内核名单 ${changed.need.length} 份` : ''}${modeNote},内核没有重启(${ms} ms)`)
    return { ok: true, changed, ms }
  } catch (error) {
    return { ok: false, reason: `热切换出错:${error instanceof Error ? error.message : String(error)}` }
  }
}

// 规则页推算用:运行中的配置还不是热切换结构(刚关掉开关、还没重启内核)时,按档案里的默认出口算一份开关状态
export const flipStateFromProfile = (store) => flipStateNow(store, {}, null).flags

export const regenerateIfPlanChanged = async ({ store, ctx, paths, selections, log = () => {}, deploy = runDeploy, exclusive = runExclusive }) => {
  // 先试着只改写开关文件(热切换);走不通(运行中的还是老结构、纯 tun 下旁路变了、分流改过没重启、写文件出错……)
  // 才回到下面重新部署、重启内核的路径。和部署排同一个队,免得一边写开关一边重启内核
  const hot = await exclusive(store, () => applyHotFlip({ store, ctx, paths, selections, log }))
  if (hot.ok) return { regenerated: false, hot: true, reason: '', changed: hot.changed }
  log(`[proxies] 热切换走不通(${hot.reason}),改走重启`)
  const dnsFlipped = await dnsClassesFlipped(ctx, paths, store, selections)
  const planChanged = dnsFlipped ? false : await firstLayerChanged(ctx, paths, store, selections)
  if (!dnsFlipped && !planChanged) return { regenerated: false, reason: '' }
  const reason = dnsFlipped ? '站点集在直连/代理之间翻面' : '第一层计划（入口旁路 / DNS 转发 / v6 保护）变了'
  log(`[proxies] ${reason},后台重新生成配置`)
  const result = await deploy({ store, ctx, paths })
  if (!result.ok) log(`[proxies] 重新生成配置失败（${result.stage}）:${result.message}`)
  return { regenerated: true, reason, result }
}

// skipNodes:这次不进配置的节点(内核不认,见下面 runDeploy 的说明)
export const buildCurrentConfig = (store, systemDns, { geoDir = createPaths(process.env.OPENBOX_ROOT).geoDir, rulesetDir = createPaths(process.env.OPENBOX_ROOT).rulesetDir, cacheFilePath, selections, tlsCert, localSubnets = [], directHostCidrs = [], ruleLists = {}, profilePatch, nativeBypass, inlineDirectHosts = false, skipNodes = [] } = {}) => {
  const profile = profilePatch ? { ...store.getProfile(), ...profilePatch } : store.getProfile()
  // 计算本身在 engine/client-build.mjs(App 本地分流用同一份);这里只从 store 取输入。
  // 停用的订阅的节点不进内核(api/subscriptions.mjs 的 activeNodes);内核不认、这次跳过的也不进
  const skip = new Set(Array.isArray(skipNodes) ? skipNodes : [])
  const { config, failover, dnsRuleOwners, directHosts } = buildConfigFromParts({
    profile,
    nodes: skip.size ? activeNodes(store).filter((n) => !skip.has(n.tag)) : activeNodes(store),
    groups: store.getGroups(),
    subscriptions: store.getSubscriptions ? store.getSubscriptions() : [],
    clashSecret: store.getClashSecret(),
    geoDir,
    rulesetDir,
    cacheFilePath,
    selections,
    tlsCert,
    systemDns,
    localSubnets,
    directHostCidrs,
    ruleLists,
    nativeBypass,
    dnsFilter: readFilterArtifact(store),
    inlineDirectHosts,
  })
  return { config, profile, failover, dnsRuleOwners, directHosts }
}

// 按部署时记下的生成输入(元数据的 buildInputs:系统 DNS、本机网段、节点域名解析结果、当时的选择、入口旁路结论、代理 DNS
// 上游的线路、auto_redirect 有没有降级)+ 此刻的档案 / 节点 / 节点组重新生成一份配置。部署自己也走这里,所以同样的输入
// 生成的就是运行中的那份;热替换(api/hot-apply.mjs)拿它和运行中的比:只差节点 / 节点组这些出站的,在线换掉,不重启;
// 别处也变了的,才是真的要重启内核
export const configFromInputs = (store, paths, inputs = {}, { ruleLists = {} } = {}) => {
  const profile = store.getProfile() || {}
  const patch = {}
  if (inputs.autoRedirectFallback) patch.tun = { ...(profile.tun || {}), autoRedirect: false }
  // 域名过滤这次没准备好(部署时记下的,见 runDeployInner):照样关着生成,和运行中的一致
  if (inputs.dnsFilterOff) patch.dns = { ...(profile.dns || {}), filter: { ...((profile.dns && profile.dns.filter) || {}), enabled: false } }
  const profilePatch = Object.keys(patch).length ? patch : undefined
  const built = buildCurrentConfig(store, Array.isArray(inputs.systemDns) ? inputs.systemDns : [], {
    geoDir: paths.geoDir, rulesetDir: paths.rulesetDir, cacheFilePath: paths.cacheDb,
    selections: inputs.selections && typeof inputs.selections === 'object' ? inputs.selections : {},
    tlsCert: { certPath: paths.tlsCert, keyPath: paths.tlsKey },
    localSubnets: Array.isArray(inputs.localSubnets) ? inputs.localSubnets : [],
    directHostCidrs: Array.isArray(inputs.directHostCidrs) ? inputs.directHostCidrs : [],
    ruleLists,
    ...(inputs.nativeBypass && typeof inputs.nativeBypass === 'object' ? { nativeBypass: inputs.nativeBypass } : {}),
    ...(profilePatch ? { profilePatch } : {}),
    ...(Array.isArray(inputs.skipNodes) && inputs.skipNodes.length ? { skipNodes: inputs.skipNodes } : {}),
  })
  applyProxyUpstreamRoutes(built.config, Array.isArray(inputs.dnsUpstreamRoutes) ? inputs.dnsUpstreamRoutes : [], builtinTags(store.getGroups ? store.getGroups() : []))
  return built
}

// 「保存设置」与「让设置生效」之间只隔一次启动内核:各个设置页只管把自己那块写进档案,
// 真正生成配置、下规则集、接管 DNS/防火墙、起内核、失败回滚,统一在这里做一次。
// 所以启动/重启内核走的就是这条路径(server/api/service.mjs),不再有单独的"部署"动作。
// 「订阅和节点站点直连」开着时,把它涉及的域名解析成 IP;关着就不解析。
// 问直连 DNS(和内核直连侧同一个口径,上游 DNS 展开成系统的上游 DNS systemDns,engine/dns.mjs 的
// directResolverServers),不走路由器自己的 resolver(见 system/resolve-hosts.mjs)。
// 要解析的是哪些域名(订阅链接的主机名、节点服务器的域名):记进元数据,在线更新节点时(api/hot-apply.mjs)名单变了才重新解析
export const directHostDomains = (store) => {
  if ((store.getProfile() || {}).directForNodes === false) return []
  return collectDirectHosts(activeNodes(store), store.getSubscriptions ? store.getSubscriptions() : []).domains
}
export const resolveDirectHostCidrs = async (store, systemDns, lookup) => {
  const domains = directHostDomains(store)
  if (!domains.length) return []
  return resolveHostsToCidrs(domains, lookup ? { lookup } : { servers: directResolverServers(store.getProfile(), systemDns) })
}

// 启动时跳过内核不认的节点最多重来几次(每次先把内核不认的一次找全,通常一次就够;完整配置里才暴露的问题——节点依赖的
// 出站 / DNS 不对——每次多一个)
const MAX_SKIP_NODE_ROUNDS = 5

// 校验没过、报出来的是某个存着的节点时:内核不认的节点一次都找出来(system/validate.mjs 的 kernelRejectedNodes,只放节点
// 自己的小配置);报出来的那个单独检查时没报(依赖了别的出站 / DNS,完整配置里才出错)也跳过,原因用完整校验的报错。
// 报的不是节点(节点组、内置出站、共享网络……)就不跳,照原样失败
const kernelRejectedForDeploy = async (ctx, paths, store, result, skipped) => {
  const stored = activeNodes(store).filter((n) => !skipped.has(n.tag))
  const storedTags = new Set(stored.map((n) => n.tag))
  const located = (result.badTags || []).filter((tag) => storedTags.has(tag))
  if (!located.length) return []
  const dir = `${paths.etc}/probe`
  await ctx.mkdirp(dir)
  const { rejected } = await kernelRejectedNodes(ctx, paths, stored, `${dir}/vet-deploy-${process.pid}.json`)
  const out = rejected.filter((r) => storedTags.has(r.tag))
  for (const tag of located) if (!out.some((r) => r.tag === tag)) out.push({ tag, error: kernelErrorText(result.error || result.message) })
  return out
}

// 跳过了哪些节点、为什么:启动成功后弹黄色提示(和 auto_redirect 降级同一条路),订阅名带上方便找;多了只列前几个
const SKIPPED_NODES_SHOWN = 5
export const skippedNodesWarning = (store, skipped) => {
  const nodes = activeNodes(store)
  const subscriptions = store.getSubscriptions ? store.getSubscriptions() : []
  const items = [...skipped].map(([tag, error]) => {
    const node = nodes.find((n) => n.tag === tag)
    const sub = node && subscriptions.find((s) => s.id === node.subscriptionId)
    return `「${tag}」${sub ? `(订阅「${sub.name}」)` : ''}:${error}`
  })
  const shown = items.slice(0, SKIPPED_NODES_SHOWN).join(';')
  const more = items.length > SKIPPED_NODES_SHOWN ? `;另外还有 ${items.length - SKIPPED_NODES_SHOWN} 个` : ''
  return `有 ${items.length} 个节点内核不认,这次启动跳过了它们:${shown}${more}。其余照常;刷新订阅或修改这些节点后会重新检查`
}

// 域名过滤没全用上(GitHub #562 #565):missing = 下不来、本地也没有、这次跳过的名单;off = 整个过滤这次没准备好的原因
export const dnsFilterWarning = (missing = [], off = '') => {
  if (off) return `域名过滤这次没开(${off}),内核照常启动`
  const names = missing.map((m) => `「${m.name}」`).join('、')
  const reasons = [...new Set(missing.map((m) => m.error).filter(Boolean))].join(';')
  return `域名过滤名单${names}没下载下来${reasons ? `(${reasons})` : ''},这次先不按${missing.length > 1 ? '它们' : '它'}过滤,内核照常启动;能连上后在「DNS 设置」点「更新名单」`
}

// 站点集 / 前置自定义分流里引用着、随包规则库里已经没有的规则集(上游删掉的分类,engine/routing-model.mjs 的
// setAvailableGeoTags):生成配置时已经跳过那几项,启动成功后照样弹黄色提示,告诉用户换成别的分类;多了只列前几个
const MISSING_RULESETS_SHOWN = 5
export const missingRulesetsWarning = (missing) => {
  const items = missing.map(({ tag, owner }) => `${tag}(「${owner}」)`)
  const shown = items.slice(0, MISSING_RULESETS_SHOWN).join('、')
  const more = items.length > MISSING_RULESETS_SHOWN ? `等,另外还有 ${items.length - MISSING_RULESETS_SHOWN} 个` : ''
  return `规则库更新后已经没有这些规则集,用到它们的那几项这次跳过了:${shown}${more}。其余照常;在站点集里换成别的分类就不再提示`
}

// 部署流水线(uci 写 dhcp/firewall、重启 dnsmasq、重启内核、等几秒验证)没法交错执行:
// 两条同时跑,一条的验证会撞上另一条的重启窗口,回滚把对方刚接管好的 DNS 撤掉却报成功。
// 面板的启动/重启、POST /deploy、Geo 刷新、计划任务、升级脚本的 CLI 都会调到这里,
// 进程内按调用顺序排队;跨进程(升级时 CLI 与面板)靠 store 里的锁记录互相等待。
let deployQueue = Promise.resolve()
const LOCK_KEY = 'openbox/deploy-lock'
// 持有者每隔 HEARTBEAT 刷新一次锁上的时间戳;超过 STALE 没刷新 = 持有者卡死(进程还在但
// 事件循环挂了),别的进程可以接管。以前没有续租,慢一点的部署(规则集下载 / 编译超过 3 分钟)
// 持有者活得好好的,另一个进程照样闯进来一起写 config、改 DNS、交错重启。
const LOCK_STALE_MS = 3 * 60 * 1000
const LOCK_HEARTBEAT_MS = 20 * 1000
const LOCK_WAIT_MS = 90 * 1000

// 「停止」「回滚」进来时把正在跑 / 排队中的部署标成取消:部署在几个安全点上检查,取消了就
// 不再往下走(没动系统的直接退出;动了 DNS / 防火墙但还没起内核的先回滚;已经起了内核的
// 让排在后面的停止动作去处理),也不会在结尾把开机自启重新打开。
let stopGeneration = 0
export const cancelPendingDeploys = () => { stopGeneration += 1 }

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

// 此刻有没有部署 / 停止 / 回滚握着锁(持锁进程还活着才算)。面板内存自检用:别在改系统的半路上重启自己
export const isDeployLocked = (store, { alive = pidAlive } = {}) => {
  try {
    const lock = JSON.parse(store.getRaw(LOCK_KEY) || 'null')
    return Boolean(lock && lock.pid && alive(lock.pid))
  } catch {
    return false
  }
}

export const withDeployLock = async (store, fn, {
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, waitMs = LOCK_WAIT_MS, pid = process.pid, alive = pidAlive,
  heartbeatMs = LOCK_HEARTBEAT_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
} = {}) => {
  const canLock = store && typeof store.getRaw === 'function' && typeof store.setRaw === 'function' && typeof store.delRaw === 'function'
  const getLock = () => {
    try { return JSON.parse(store.getRaw(LOCK_KEY) || 'null') } catch { return null }
  }
  // 锁上带一个随机 token:同一进程内的两次部署、以及被复用的 PID,都不会把别人的锁当成自己的
  const token = randomBytes(8).toString('hex')
  const mine = (lock) => Boolean(lock && lock.pid === pid && lock.token === token)
  let beat = null
  if (canLock) {
    const deadline = now() + waitMs
    for (;;) {
      const lock = getLock()
      const held = lock && !mine(lock) && now() - Number(lock.at || 0) < LOCK_STALE_MS && alive(lock.pid)
      if (!held) {
        store.setRaw(LOCK_KEY, JSON.stringify({ pid, at: now(), token }))
        // 写完再读一次:两个进程同时抢,后写的赢,先写的看到锁不是自己的就回去继续等。不是原子
        // CAS(存储只有 get / set),但并发窗口从"整个部署"缩到两次写之间的几毫秒。
        if (mine(getLock())) break
      }
      if (now() > deadline) throw new Error(`另一个部署（pid ${lock && lock.pid}）正在进行,等了 ${Math.round(waitMs / 1000)} 秒仍未结束`)
      await sleep(500)
    }
    beat = setIntervalImpl(() => {
      const lock = getLock()
      if (mine(lock)) store.setRaw(LOCK_KEY, JSON.stringify({ ...lock, at: now() }))
    }, heartbeatMs)
    if (beat && typeof beat.unref === 'function') beat.unref()
  }
  try {
    return await fn()
  } finally {
    if (canLock) {
      if (beat) clearIntervalImpl(beat)
      if (mine(getLock())) store.delRaw(LOCK_KEY)
    }
  }
}

// 停止 / 回滚这类会改服务、DNS、防火墙的动作和部署共用同一条队列、同一把锁:以前它们绕过
// 队列直接动系统,停止已经报成功、排在前面的旧部署随后照样把内核拉起来、把自启打开。
export const runExclusive = (store, fn) => {
  const run = deployQueue.then(() => withDeployLock(store, fn))
  deployQueue = run.catch(() => {})
  return run
}

export const runDeploy = (args) => {
  // 排队时就记下代数:排队期间来了停止,这次部署轮到时第一个检查点就退出,不再把内核拉起来
  const generation = stopGeneration
  const isCancelled = () => stopGeneration !== generation
  const run = deployQueue.then(() => withDeployLock(args.store, () => runDeployInner({ ...args, isCancelled })))
  deployQueue = run.catch(() => {})
  return run
}

const CANCELLED = { ok: false, stage: 'cancelled', message: '部署被「停止」取消,没有改动系统', badTags: [] }

// 每次部署一个序号:后台盯晚崩溃的那段发现已经有新的部署开始就退出,不和它抢
let deploySerial = 0

const runDeployInner = async ({ store, ctx, paths, fetchImpl = globalThis.fetch, lookup, isCancelled = () => false, lateWatch = true, refreshDnsFilter = false }) => {
  let result
  const startedAt = Date.now()
  const serial = ++deploySerial
  try {
    if (isCancelled()) {
      store.setDeployState({ stage: CANCELLED.stage, message: CANCELLED.message, at: Date.now(), badTags: [] })
      return { ...CANCELLED }
    }
    const [systemDns, localSubnets] = await Promise.all([readSystemDns(ctx), readLocalSubnets(ctx)])
    const directHostCidrs = await resolveDirectHostCidrs(store, systemDns, lookup)
    const selections = resolveSelections(store, await fetchSelections(fetchImpl, store.getClashSecret()))
    // 域名过滤不让内核起不来(GitHub #562 #565):下不来的名单 prepareDnsFilter 自己跳过(missing);别的原因准备不好
    // (内存不够、规则总数超限……)这次先关着过滤生成配置。两种都在启动成功后弹黄色提示
    let filterMissing = []
    let filterOff = ''
    try {
      filterMissing = (await prepareDnsFilter({ store, ctx, paths, force: refreshDnsFilter }))?.missing || []
    } catch (error) {
      filterOff = error instanceof Error ? error.message : String(error)
      console.warn(`[deploy] 域名过滤这次没开:${filterOff}`)
    }
    // 规则集链接要排在生成配置之前:拉回来才知道每条名单编成了域名 / IP 哪几份 .srs,
    // 路由规则和 DNS 规则要凭这个决定引用哪几份(见 engine/routing-model.mjs)。
    // 这一步只往 rulesetDir 里写文件,失败原地返回,不动系统。
    // 地区分流(给手机用的)里的规则集链接一起编:状态文件只写一份,分开编会互相冲掉;它们拉不到不让这次部署失败
    const ruleLists = await ensureRuleLists(ctx, paths, (store.getProfile() || {}).routing, { fetchImpl, log: (m) => console.log(m), extra: shareRegionRuleUrls(store.getProfile()) })
    // 这次重拉重编过的名单,规则页推算用的索引立刻作废(不然还要照旧内容算 10 分钟)
    dropRuleSetIndex((ruleLists.updated || []).flatMap((tag) => [tag, ruleListIpTag(tag)]))
    if (!ruleLists.ok) {
      result = { ok: false, stage: 'rulesets', message: ruleLists.message }
    } else {
      // 入口原生旁路:纯函数先算,FakeIP 下留下的 pending 在这里解码两边的集合核对重叠(system/native-bypass.mjs),
      // 生成配置和元数据用同一份结论
      const nativeBypass = await resolveNativeBypass(ctx, paths, currentBypassPlan(store, selections))
      // 代理侧 DNS 上游走哪条线路:由目标分流按上游地址判,和终端访问这个地址同一套规则(api/dns-upstream-route.mjs,用户
      // 2026-09-28「全局就只有一个分流规则:目标分流」)。规则集这时都已就位(随包的 + 上面补齐的规则集链接)
      const profileNow = store.getProfile() || {}
      const dnsUpstreamRoutes = profileNow.dns && profileNow.dns.split
        ? await routeProxyDnsUpstreams({ store, ctx, paths, fetchImpl, systemDns }, profileNow)
        : []
      // 生成配置用到的、档案之外的输入:记进元数据(buildInputs),热替换按同样的输入重新生成、和运行中的比(configFromInputs)
      let buildInputs = { systemDns, localSubnets, directHostCidrs, directHostDomains: directHostDomains(store), selections, nativeBypass, dnsUpstreamRoutes, ...(filterOff ? { dnsFilterOff: true } : {}) }
      for (const r of dnsUpstreamRoutes) {
        if (r.error) console.warn(`[deploy] 代理 DNS 上游 ${r.server} 按目标分流判不出线路,先走兜底:${r.error}`)
        else if (r.reject) console.warn(`[deploy] 代理 DNS 上游 ${r.server} 被目标分流拒绝(第 ${Number(r.ruleIndex) + 1} 条),走代理的域名解析会失败`)
      }
      // 内核不认的节点(GitHub #518:一个坏节点让整个内核起不来):校验报出是某个节点时,把内核不认的节点一次都找出来
      // (只放节点的小配置,快),跳过它们重新生成、再部署一次,成功了提示跳过了哪几个、为什么。订阅添加 / 刷新时已经
      // 挑掉过一遍(api/subscriptions.mjs),这里兜之前存下的和手动加的。跳过名单记进生成输入(元数据),在线更新节点时照样跳过
      const skippedNodes = new Map() // tag → 内核报错
      // 最后一次部署用的热切换状态(部署后按内核真实的选择对账要用)
      let flip = null
      for (let attempt = 0; ; attempt += 1) {
        const { config, profile, failover, dnsRuleOwners, directHosts } = configFromInputs(store, paths, buildInputs, { ruleLists: ruleLists.lists })
        // 内核启动时每个本地规则集文件都必须已经在,所以热切换的开关 / 旁路动态集在这里按此刻的选择全套写好
        // (system/flip-files.mjs)。这份状态一并交给 deployConfig 记进元数据,翻面时按它比
        const entryMode = currentEntryMode(store, selections)
        flip = flipStateNow(store, selections, nativeBypass, entryMode)
        const flipNow = flip
        const autoRedirect = Boolean(profile.tun && profile.tun.autoRedirect && ((profile.dns && profile.dns.mode) || 'hijack') !== 'off')
        // 真正落盘交给 deployConfig 在「冲突检测之后、校验之前」做:别的代理在跑、这次部署不会进行时,一个文件都不写
        // 订阅和节点站点直连的两份规则集文件(system/node-direct-files.mjs)同样要在内核启动之前写好
        const writeFlip = async () => {
          await writeFlipFiles(ctx, paths, flipNow, { dynamicBypass: autoRedirect })
          if (directHosts) await writeNodeDirectSets(ctx, paths, directHosts)
        }
        // 链式代理里没进配置的条目(上游没了 / 成环 / 重名)记一笔,界面上那条会显示上游不存在,这里给日志留个原因
        if (attempt === 0) {
          for (const s of resolveChainNodes({ chainProxies: profile.chainProxies, nodes: activeNodes(store), userGroups: store.getGroups() }).skipped) {
            console.warn(`[deploy] 链式代理「${s.name}」没有进配置:${s.reason === 'cycle' ? `上游「${s.upstream}」绕回了它自己` : s.reason === 'duplicate' ? '名称和别的出站重复' : `上游「${s.upstream}」不存在或不可用`}`)
          }
        }
        const prepMs = Date.now() - startedAt
        const inputs = buildInputs
        result = await deployConfig(ctx, paths, {
          config, profile, userGroups: store.getGroups(), nodes: [...activeNodes(store), ...chainNodes(profile)], subscriptions: store.getSubscriptions(), selections, isCancelled, nativeBypass, failover, flip: flipNow, writeFlip, dnsRuleOwners, dnsUpstreamRoutes, buildInputs: inputs,
          // auto_redirect 起不来时关掉它重新生成(system/deploy.mjs);元数据记下降过级,重新生成时照样关
          rebuild: () => configFromInputs(store, paths, { ...inputs, autoRedirectFallback: true }, { ruleLists: ruleLists.lists }).config,
        })
        result.timings = { 准备: prepMs, ...(result.timings || {}) }
        const more = attempt < MAX_SKIP_NODE_ROUNDS && !result.ok && result.stage === 'validate' ? await kernelRejectedForDeploy(ctx, paths, store, result, skippedNodes) : []
        if (!more.length) break
        for (const r of more) skippedNodes.set(r.tag, r.error)
        console.warn(`[deploy] 内核不认,跳过 ${more.length} 个节点再试:${more.map((r) => `${r.tag}(${r.error})`).join('、')}`)
        buildInputs = { ...buildInputs, skipNodes: [...skippedNodes.keys()] }
      }
      if (result.ok && skippedNodes.size) result.warning = [result.warning, skippedNodesWarning(store, skippedNodes)].filter(Boolean).join(';')
      if (result.ok && (filterMissing.length || filterOff)) result.warning = [result.warning, dnsFilterWarning(filterMissing, filterOff)].filter(Boolean).join(';')
      const missingRulesets = result.ok ? normalizeRouting((store.getProfile() || {}).routing).missingRulesets || [] : []
      if (missingRulesets.length) result.warning = [result.warning, missingRulesetsWarning(missingRulesets)].filter(Boolean).join(';')
      // 跳过之后还是没起来(问题在别处):跳过的那几个也确实是坏的,和这次报出来的一起给界面标红
      else if (!result.ok && skippedNodes.size) result.badTags = [...new Set([...skippedNodes.keys(), ...(result.badTags || [])])]
      if (result.warning) console.warn(`[deploy] ${result.warning}`)
      // 热切换的开关是按「重启前」的选择写的,而内核重启后从缓存文件里恢复出来的选择可能不一样(换过缓存文件、
      // 缓存里的节点已经不在了……)。内核确认在跑之后立刻按它此刻真实的选择对一次账,只改写开关文件、不会再触发部署。
      // (开发路由器验收时遇到过:切换 FakeIP 换了缓存文件,兜底从直连变成了代理。)老路径下同样的偏差要等下次切换才发现
      if (flip && result.ok) {
        try {
          const live = await fetchSelections(fetchImpl, store.getClashSecret ? store.getClashSecret() : '')
          if (Object.keys(live).length) {
            const hot = await applyHotFlip({ store, ctx, paths, selections: resolveSelections(store, live), log: (m) => console.log(m) })
            if (!hot.ok) console.warn(`[deploy] 部署后的热切换对账没做成:${hot.reason}`)
          }
        } catch (error) {
          console.warn(`[deploy] 部署后的热切换对账出错:${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    store.setDeployState({
      stage: result.stage,
      // 成功但降过级(auto_redirect 起不来改纯 tun)的,把降级原因当消息存着,诊断包里能看到
      message: result.message || result.warning || '',
      at: Date.now(),
      badTags: result.badTags || [],
    })
    // 部署多久,日志里直接能看到——用户反馈「重启要一分钟」时不用猜
    const steps = Object.entries(result.timings || {}).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(' · ')
    console.log(`[deploy] ${result.ok ? '完成' : `失败(${result.stage})`},耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s${steps ? `(${steps})` : ''}`)
    // 确认在跑之后再在后台盯两眼(GitHub #4:nft 那步在第 5 秒才崩,确认时还活着):崩了就降级 / 回滚并把结果写进部署状态
    if (result.ok && lateWatch && typeof result.lateCrashWatch === 'function') {
      const watch = result.lateCrashWatch
      watch({ isStale: () => serial !== deploySerial }).then(async (late) => {
        if (!late) return
        store.setDeployState({ stage: late.stage, message: late.message || late.warning || '', at: Date.now(), badTags: [] })
        console[late.ok ? 'warn' : 'error'](`[deploy] 内核在确认后崩溃:${late.message || late.warning}`)
        if (!late.ok) await disableService(ctx, paths.initd.core).catch(() => {})
      }).catch((err) => console.warn('[deploy] late crash watch failed:', err instanceof Error ? err.message : err))
    }
    delete result.lateCrashWatch
  } catch (error) {
    // deployConfig 只在"落盘"之后的步骤自行 try/catch;冲突检测(detectConflicts)、
    // mkdirp、validateConfigObject 这些落盘之前的步骤抛出的异常会冒泡到这里。不兜底的话
    // setDeployState 不会执行——部署态停留在上一次的结果,前端轮询会显示过期状态。
    const message = error instanceof Error ? error.message : String(error)
    store.setDeployState({ stage: 'error', message, at: Date.now(), badTags: [] })
    result = { ok: false, stage: 'error', message, badTags: [] }
  }

  // enable/disable 只是"开机自启"标志位的同步动作,发生在结果已经 setDeployState 落盘
  // 之后——它失败不代表这次应用失败(内核已经在跑、配置已经生效),所以单独兜底,
  // 不让它把刚写入的成功状态改写成 error。
  // 失败时的规则和面板里「停止」一致:内核没在跑就把自启关掉。只看回滚过的阶段不够——
  // 升级脚本先停内核再跑这条流水线,在 conflict / rulesets / validate 阶段失败时内核
  // 停着、自启却还开着,下次开机 procd 会直接拉起磁盘上那份旧配置(dnsmasq 模式下
  // init 还会先把 dnsmasq 接管过去),等于开机指向一份没验证过的配置。
  try {
    if (result.stage === 'cancelled') {
      // 自启标志位交给排在后面的停止 / 回滚动作处理:这里既不能 enable(用户要的是停),
      // 也不抢着 disable(那是停止动作的事,它会做)
    } else if (result.ok) {
      await enableService(ctx, paths.initd.core)
    } else if (ROLLED_BACK_STAGES.has(result.stage) || !(await serviceStatus(ctx, paths.initd.core)).running) {
      await disableService(ctx, paths.initd.core)
    }
  } catch (error) {
    console.warn(
      'deploy: enable/disable service (autostart flag) failed:',
      error instanceof Error ? error.message : error,
    )
  }

  // warning:内核起来了但有降级 / 跳过了内核不认的节点,启动接口(api/service.mjs)交给前端弹黄色提示
  return { ok: result.ok, stage: result.stage, message: result.message || '', badTags: result.badTags || [], ...(result.warning ? { warning: result.warning } : {}) }
}
