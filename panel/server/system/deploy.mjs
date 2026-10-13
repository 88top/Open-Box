import { filterForwardPlan, filterKey, filterSettings } from '../engine/dns-filter.mjs'
import { tunTcpMss } from '../engine/tun-options.mjs'
import { conflictMessage, detectConflicts } from './conflicts.mjs'
import { validateConfigObject, attributeBadNodes, describeConfigError } from './validate.mjs'
import { restartService, stopService, serviceStatus } from './service.mjs'
import { applyDnsTakeover, restoreDnsTakeover, dnsTakeoverBackupPath } from './dns-takeover.mjs'
import { queryLogWanted } from './dnsmasq-query-log.mjs'
import { expandDnsForward } from './dns-forward.mjs'
import { ENTRY_MODE_BLACKLIST, PURE_TUN_ENTRY_REASON, bypassPlanKey, dnsmasqForwardPlan, entryModePlan, nativeBypassPlan, normalizeRouting, policyClasses, routingFingerprint } from '../engine/routing-model.mjs'

// 元数据里的入口模式:flipTargetState 只记了 mode,原因和名单按同一口径再算一遍(纯函数,便宜)
const entryModeMetaOf = (flip, profile, members, builtin, selections, clientRoutes, dnsMode) => {
  const plan = entryModePlan(profile.routing, { members, builtin, selections: selections || {}, clientRoutes, fakeIp: dnsFakeIpEnabled(profile), dnsMode, enabled: profile.directBypass !== false })
  return { mode: flip && flip.entryMode ? flip.entryMode : plan.mode, reason: plan.reason || '', needSets: plan.needSets || [], needCidrs: (plan.needCidrs || []).length, directAnswer: Boolean(plan.directAnswer) }
}
import { normalizeClientRoutes, terminalDnsSources } from '../engine/client-routes.mjs'
import { FAKEIP_V4, FAKEIP_V6, dnsFakeIpEnabled, ipv6ProxyMode } from '../engine/dns.mjs'
import { DNS_DIRECT_INBOUND_PORT, DNS_DIRECT_INBOUND_TAG, DNS_INBOUND_PORT } from '../engine/config.mjs'
import { dnsPolicyClasses } from '../engine/dns.mjs'
import { builtinTags } from '../engine/user-groups.mjs'
import { enabledRewriteSources, normalizeDnsRewrite, rewriteForwardDomains } from '../engine/dns-rewrite.mjs'
import { applyPanelLanRule, applyDnsLanRule, applyTunForwardRule, applyTunInputRule, applyIpv6Block, removeProxyRules, applyServerPortRules, commitFirewall } from './firewall.mjs'
import { panelPort } from './panel-port.mjs'
import { ensureTlsKeypair } from './tls-keypair.mjs'
import { configNeedsTlsKeypair, enabledServers } from '../engine/servers.mjs'
import { ensureRulesets } from './rulesets.mjs'
import { activeBypassPorts, entryBypassNft, writeEntryBypass } from './entry-bypass.mjs'
import { readLocalAddresses } from './local-subnets.mjs'


// 与 openwrt/initd/openbox 的 CONF_META 一致
export const configMetaPath = (paths) => `${paths.etc}/config.meta.json`
// 内核的 tun 入站要这个设备文件;没有 tun 内核模块的固件上它不存在
export const TUN_DEVICE = '/dev/net/tun'

// 回滚到直连:停内核、还原 dnsmasq、撤代理侧的防火墙规则。每一步各自尽力(一步失败不拦着
// 后面的),但失败要如实汇总——以前一律返回 ok:true 且把失败的步骤也记成"已执行",界面显示
// "已恢复直连",实际 DNS / 防火墙可能还停在接管状态。
export const rollbackToDirect = async (ctx, paths) => {
  const actions = []
  const failures = []
  const step = async (name, fn) => {
    try {
      const r = await fn()
      if (r && r.ok === false) failures.push({ step: name, message: String(r.stderr || r.stdout || '').trim() || `code ${r.code}` })
      else actions.push(name)
    } catch (error) {
      failures.push({ step: name, message: String((error && error.message) || error) })
    }
  }
  await step('stop-core', () => stopService(ctx, paths.initd.core))
  // Debian / Ubuntu(system/platform.mjs 的 systemd)没有 dnsmasq 接管和 uci 防火墙,这两步没有东西可还原;
  // 硬跑的话 uci 不存在 → 回滚步骤失败,界面把一次干净的回滚报成"恢复直连未完成"
  if (paths.platform !== 'systemd') {
    await step('restore-dns', () => restoreDnsTakeover(ctx, paths))
    // 只撤代理相关规则,不删面板 LAN 放行——否则回滚会把用户返回恢复界面的路都堵死。
    await step('remove-firewall', () => removeProxyRules(ctx))
  }
  return { ok: failures.length === 0, actions, failures }
}

// 部署失败时提示的尾巴:回滚成功说"已恢复直连",失败把哪一步、为什么带出来,用户才知道
// 路由器此刻是不是还卡在半接管状态
export const rollbackSummary = (rb) => (rb.ok
  ? '已恢复直连'
  : `恢复直连未完成（${rb.failures.map((f) => `${f.step}: ${f.message}`).join('; ')}）`)

const VERIFY_SETTLE_MS = 3000
// 确认在跑之后再在后台看两眼:post-start 排在 DNS 解析之后,节点域名解析超时时 nft 那步会拖到第 5 秒才
// 跑(GitHub #4 的 FATAL[0005]),两眼确认时进程还活着。默认用真定时器且不拖住进程退出;测试注入自己的 sleep
const LATE_WATCH_MS = [6000, 6000]
// auto_redirect 开着时多看几眼、看得更久:nft 那一步在 fw4 规则多的路由器上能拖一分多钟(GitHub #426:装着 PassWall / OpenClash,
// 起 auto_redirect 要 fw4 reload,每次都重跑它们的规则,89 秒才 FATAL),而且 procd 会把崩溃的内核立刻拉起来、状态还是「在跑」——
// 这时按日志里这次重启之后新进程的 FATAL 认
const LATE_WATCH_REDIRECT_MS = [6000, 6000, 20000, 30000, 45000]
const detachedSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === 'function') t.unref() })

// 内核起来又死了的时候,把它最后一句 FATAL 带回界面——"内核启动后未在运行"这句话
// 本身什么都说明不了,用户还得自己去翻 logread。读不到就是空串。
// logread 是整份环形缓冲,以前几次(几小时前、上一次降级时)的 FATAL 都还在:只认重启之后新进程留下的。
// mark 是重启前 kernelLogMark 记下的最后一行和出现过的进程号——那一行还在就只看它后面的,缓冲转了一圈
// 找不到它就只看没出现过的进程号。新进程没留 FATAL 就死了(被杀、OOM)时读到空串,不会把老的那句当成这次的
// 原因、更不会因此误降级成纯 tun
const kernelLogLines = async (ctx) => {
  try {
    const { code, stdout } = await ctx.exec('logread', ['-e', 'sing-box'])
    return code === 0 && stdout ? String(stdout).split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}
const logPid = (line) => (/sing-box\[(\d+)\]/.exec(line) || [])[1] || ''
const kernelLogMark = async (ctx) => {
  const lines = await kernelLogLines(ctx)
  return { last: lines.length ? lines[lines.length - 1] : '', pids: new Set(lines.map(logPid).filter(Boolean)) }
}
// newPidsOnly:只看重启前没出现过的进程号——旧内核被停掉时晚到的 FATAL(收尾时 nft 那步失败之类)记在 mark 后面,也不算
const readLastKernelFatal = async (ctx, mark = null, { newPidsOnly = false } = {}) => {
  let lines = await kernelLogLines(ctx)
  if (mark) {
    const at = mark.last ? lines.lastIndexOf(mark.last) : -1
    lines = at >= 0 ? lines.slice(at + 1) : lines.filter((line) => !mark.pids.has(logPid(line)))
    if (newPidsOnly) lines = lines.filter((line) => !mark.pids.has(logPid(line)))
  }
  const fatal = lines.filter((line) => /FATAL/.test(line)).pop()
  if (!fatal) return ''
  // 去掉 syslog 前缀和终端色码,只留 sing-box 自己那句话
  return fatal.replace(/\x1b\[[0-9;]*m/g, '').replace(/^.*?sing-box\[\d+\]:\s*/, '')
}
const crashMessage = (fatal, rb) => (fatal
  ? `内核启动后崩溃,${rollbackSummary(rb)}:${fatal}`
  : `内核启动后未在运行,${rollbackSummary(rb)}`)

// auto_redirect 在 nftables 这一层起不来的那类 FATAL:内核把 nft 规则批量提交时被内核拒了——
// EEXIST(上次没清干净的表)、ENOENT(固件缺 nft_redir / nft_nat 之类模块,或 PassWall /
// OpenClash 把 fw4 的表改得对不上)。这些和节点、分流都没关系,纯 tun 模式(只靠 auto_route
// 的策略路由)照样能跑,只是少了 nft 转发那点吞吐。与其回滚直连让人对着英文报错猜,不如
// 自动降级再试一次,并把原话和常见原因一起告诉用户(GitHub #12 #15)。
// 两种原话:setup nftables(建表 / 提交规则被拒)和 missing nftables support(内核压根没有 nf_tables,老的 iptables 固件,
// GitHub #137:sing-tun 探测 nft 时 netlink 回 invalid argument)。后者以前没匹配上,被按普通崩溃回滚直连
export const AUTO_REDIRECT_FATAL = /auto-redirect: (setup nftables|missing nftables support)/i
// 起内核时建 tun 网卡、路由、策略路由那一步失败:多半是上一个内核还没拆完(被 procd 到点强杀,tun 网卡还在注销
// 新进程就起来了),隔一会儿再起一次通常就好(#386:starting TUN interface: set routes: add route 56: no route to host)
export const TUN_START_FATAL = /inbound\/tun\[[^\]]*\]: (starting TUN interface|configure tun interface)/i
// 这两类先原样再起一次再说:auto_redirect 那类也可能只是撞上了没拆完的旧状态,第二次就好;真起不来(缺模块之类)
// 第二次照样失败,再按原来的办法降级纯 tun / 回滚直连
const START_RETRY_SETTLE_MS = 2000
// auto_redirect 那类里的临时性错误:内核把 nft 规则整批提交、读确认时接收缓冲区塞满(ENOBUFS:no buffer space available),
// 或者一时分配不到内存(cannot allocate memory)。不是缺模块、也不是规则冲突,隔一会儿原样再起多半就好。iStoreOS 用户
// 2026-10-05:升级时连着两次撞上就降级成纯 tun,旁路由的手机 DNS 不经本机、上不了外网,要手动再重启一次内核。tcp17 起
// 内核按批大小放大了接收缓冲区,这里兜底:这一类原样多起几次、间隔拉长,都不行才降级
export const TRANSIENT_REDIRECT_FATAL = /no buffer space available|cannot allocate memory/i
const TRANSIENT_RETRY_SETTLE_MS = [2000, 5000, 10000]
export const autoRedirectFallbackWarning = (fatal) =>
  `auto_redirect（nftables 转发）起不来,已改用纯 tun 模式启动（兼容模式）:分流规则不受影响,直连目标的入口旁路改由系统路由表实现,吞吐略低。内核原话:${fatal}。常见原因:固件缺 kmod-nft-nat 等 nftables 模块,或 PassWall / OpenClash 等插件的 nftables 规则冲突——处理好之后重启内核会自动恢复 auto_redirect。旁路由请注意:纯 tun 模式不改写终端的 DNS,终端的 DNS 若不指向本机,请在 网络 → DHCP/DNS 里打开「DNS 重定向」（把终端的 DNS 请求引到本机 dnsmasq）,否则会解析不了域名。`

// rebuild(profilePatch):按改过的档案重新生成一份配置(见 api/deploy-runner.mjs)。只在 auto_redirect
// 起不来要降级重试时用;不传就不降级,照旧回滚直连。
// 元数据 firstLayer 里 DNS 转发那几项:部署和热切换(api/deploy-runner.mjs 的 applyHotFlip)写的是同一个形状
export const dnsForwardMeta = (dnsMode, dnsForward, dnsPlanned) => ({
  dnsForward: dnsMode === 'dnsmasq' ? dnsForward.mode : dnsMode === 'hijack' ? 'all' : 'none',
  dnsForwardReason: dnsMode === 'dnsmasq' ? dnsForward.reason : '',
  // 计划阶段的模式(规则集还没展开):api/deploy-runner.mjs 的 firstLayerChanged 只能算到这一步,
  // 要和它比,不能和展开 / 应用后的实际模式比
  dnsForwardPlanned: dnsMode === 'dnsmasq' ? dnsPlanned.mode : dnsMode === 'hijack' ? 'all' : 'none',
  // 转发名单的规模和超集说明(正则只能按字面后缀整段交给内核)
  dnsForwardDomains: dnsMode === 'dnsmasq' && dnsForward.mode === 'domains' ? dnsForward.domains.length : 0,
  dnsForwardExpanded: (dnsForward.expanded || []).map((x) => `${x.tag}:${x.count}`),
  dnsForwardSuperset: (dnsForward.superset || []).map((x) => `${x.tag}:${x.suffix}`),
})

// 入口怎么放行(入口旁路计划、白名单 / 黑名单、直连应答放行)取决于这几项设置。部署时记进元数据,热切换
// (api/deploy-runner.mjs 的 applyHotFlip)按这份算:设置改了、保存了还没重启内核时,运行中的 DNS / 路由还是按老设置
// 生成的,翻面要是按新设置写入口文件,就会把一半新设置提前生效——比如刚打开 FakeIP 还没重启,入口却切成了白名单,
// 代理站点集的真实 IP 在入口被放走直连(审查第四项)
export const hotFlipInputs = (profile) => {
  const p = profile || {}
  return {
    dns: { mode: p.dns ? p.dns.mode : undefined, split: p.dns ? p.dns.split : undefined, fakeIpForProxy: p.dns ? p.dns.fakeIpForProxy : undefined },
    directBypass: p.directBypass,
    clientRoutes: Array.isArray(p.clientRoutes) ? p.clientRoutes : [],
    tun: { autoRedirect: p.tun ? p.tun.autoRedirect : undefined },
  }
}
// 部署时写进系统(入口的 nft 放行、dnsmasq 查询日志)、却不进 config.json 的几项设置。改了也要重启内核才生效,待重启判断
// (api/hot-apply.mjs)除了比配置,还要比这一份和部署时记下的
export const deploySideInputs = (profile) => {
  const p = profile || {}
  return { bypassPorts: activeBypassPorts(p), tcpMss: tunTcpMss(p) || 0, queryLog: Boolean(queryLogWanted(p)) }
}
// 当前档案套上部署时记下的那几项;老元数据没有这一段就原样用当前档案
export const profileAsDeployed = (profile, meta) => {
  const inputs = meta && meta.firstLayer && meta.firstLayer.inputs
  const p = profile || {}
  if (!inputs || typeof inputs !== 'object') return p
  return {
    ...p,
    dns: { ...(p.dns || {}), ...(inputs.dns || {}) },
    directBypass: inputs.directBypass,
    clientRoutes: Array.isArray(inputs.clientRoutes) ? inputs.clientRoutes : [],
    tun: { ...(p.tun || {}), ...(inputs.tun || {}) },
  }
}

// 按此刻的选择重算 dnsmasq 转发计划并应用(名单没变时 applyDnsTakeover 什么都不做、不重启 dnsmasq)。
// 部署和热切换共用;返回最终实际执行的那份和计划阶段的那份
export const applyDnsForwardNow = async (ctx, paths, { profile, policyMembers, builtin, selections, dnsMode }) => {
  const dnsRewriteConfig = normalizeDnsRewrite(profile.dns)
  const dnsRewrite = dnsRewriteConfig.enabled ? dnsRewriteConfig.rules : []
  const dnsPlanned = filterForwardPlan(profile, dnsmasqForwardPlan(profile.routing, policyMembers, builtin, selections || {}, { rewriteDomains: rewriteForwardDomains(dnsRewrite) }))
  let dnsForward = dnsMode === 'dnsmasq' ? await expandDnsForward(ctx, paths, dnsPlanned) : dnsPlanned
  const applied = await applyDnsTakeover(ctx, paths, { mode: dnsMode, forward: dnsForward, rewriteSources: enabledRewriteSources(dnsRewrite), queryLog: queryLogWanted(profile) })
  if (dnsMode === 'dnsmasq' && applied.effective && applied.effective.mode !== dnsForward.mode) dnsForward = { ...dnsForward, ...applied.effective, expanded: [], superset: [] }
  return { dnsForward, dnsPlanned, applied }
}

// flip:这次部署写进热切换文件的目标状态(system/flip-files.mjs 的 flipTargetState)
// dnsUpstreamRoutes:代理侧 DNS 上游按目标分流判出的线路(api/dns-upstream-route.mjs),记进元数据给规则页 / 诊断包看
export const deployConfig = async (ctx, paths, { config, profile, userGroups, nodes = [], subscriptions = [], selections = {}, isCancelled = () => false, rebuild, nativeBypass: bypassGiven, failover = [], flip = null, writeFlip = null, dnsRuleOwners = [], dnsUpstreamRoutes = [], buildInputs = null } = {}) => {
  const describeError = (message, badTags = []) => describeConfigError(message, config, { nodes, subscriptions, badTags })
  const describeCrash = (fatal, rb) => ({ ...describeError(fatal), message: crashMessage(describeError(fatal).message, rb) })
  // 每一步花了多久:随结果一起带回去写进日志,"重启要一分钟"这种反馈能直接看到卡在哪
  const timings = {}
  let stepStart = Date.now()
  const mark = (name) => {
    const now = Date.now()
    timings[name] = (timings[name] || 0) + (now - stepStart)
    stepStart = now
  }
  const withTimings = (result) => ({ ...result, timings })

  // 1. 冲突检测:别的代理工具在跑就不启动,一个文件都不写、内核不动(用户 2026-10-05:检测到其他代理工具就禁止启动,并明确提示)
  const { conflicts, hasRunning } = await detectConflicts(ctx)
  mark('冲突检测')
  if (hasRunning) {
    return { ok: false, stage: 'conflict', message: conflictMessage(conflicts) }
  }

  // 2. 核对随包规则集并迁移旧配置路径
  // 必须排在校验之前:sing-box check 会真的去打开每个 rule_set 的 .srs,缺文件就直接
  // FATAL,而那条报错("open .../geosite-cn.srs: no such file or directory")对用户来说
  // 完全不知所云。这一步只核对本地安装包，失败原地返回，不进行网络下载。
  const rulesets = await ensureRulesets(ctx, config, { paths })
  mark('规则集')
  if (!rulesets.ok) {
    return withTimings({ ok: false, stage: 'rulesets', message: rulesets.message })
  }
  // (规则集链接的 .srs 由 api/deploy-runner.mjs 在生成配置之前补齐:路由 / DNS 规则要凭
  // 每条名单编成了哪几份文件来决定引用什么,所以它必须排在 buildConfig 前面,不在这里。)
  // 热切换的开关 / 旁路动态集:同样要排在校验之前(sing-box check 会去打开每个本地规则集文件),但要排在冲突检测
  // 之后——别的代理在跑、这次部署压根不会进行的时候,一个文件都不该写
  // 动态集编不出来(system/flip-files.mjs 已经先写了占位)先记着别报:校验紧跟其后,同一个二进制编不出集合时
  // sing-box check 多半也过不了,那边的归因(哪个节点坏了)才是用户要看的,以前这里先抛就把它盖成了一句
  // 「编不出来」。校验过了才把这个错误原样报出去、不再往下走:内核不能带着占位的「进内核」名单启动
  // (白名单模式下那会把该进内核的目标放走)
  let flipError = ''
  if (writeFlip) {
    try {
      await writeFlip()
    } catch (error) {
      flipError = String((error && error.message) || error)
    }
    mark('规则集')
  }

  // 3. 校验(失败则归因,不动系统)
  // mkdirp 必须在写 candidate 文件之前:全新安装时 paths.etc 尚不存在,
  // 之前 mkdirp 排在步骤 3 会让这里的 writeFile 在真实 fs 上 ENOENT(mock 掩盖了此问题)。
  await ctx.mkdirp(paths.etc)
  // 共享网络里有要 TLS 的入站时,先把自签证书备好:sing-box check 会真的去读证书文件
  if (configNeedsTlsKeypair(config)) {
    try {
      await ensureTlsKeypair(ctx, paths)
    } catch (error) {
      return { ok: false, stage: 'validate', message: String((error && error.message) || error) }
    }
  }
  const candidatePath = `${paths.etc}/config.candidate.json`
  const validation = await validateConfigObject(ctx, paths, config, candidatePath)
  mark('校验')
  if (!validation.ok) {
    let detail = describeError(validation.message)
    if (!detail.located) {
      const { badTags } = await attributeBadNodes(ctx, paths, config, `${paths.etc}/config.probe.json`)
      detail = describeError(validation.message, badTags)
    }
    // error:内核的原始报错(部署入口跳过内核不认的节点时要用它说原因,api/deploy-runner.mjs)
    return { ok: false, stage: 'validate', message: detail.message, badTags: detail.badTags, error: validation.message }
  }

  if (flipError) return withTimings({ ok: false, stage: 'error', message: flipError })

  // 到这里还没动系统:排队期间或校验期间来了「停止」,直接退出
  if (isCancelled()) return withTimings({ ok: false, stage: 'cancelled', message: '部署被「停止」取消,没有改动系统' })

  try {
    // 4. 落盘
    // 旁边放一份元数据给 init 脚本:开机时它要知道这份配置是不是 dnsmasq 分流模式
    // (要不要重新接管 dnsmasq)。以前靠在 config.json 里 grep 出站 tag,节点名撞上就误判。
    const dnsMode = (profile.dns && profile.dns.mode) || 'hijack'
    let autoRedirect = Boolean(profile.tun && profile.tun.autoRedirect && dnsMode !== 'off')
    // auto_redirect 起不来、降级成纯 tun 重新生成过(下面 rebuild 那两处):记进元数据的生成输入,重新生成时照样降级
    let autoRedirectFallback = false
    // 站点集的成员表 = 兜底 selector 的成员(刚生成的这份配置里就有,不另算一遍)
    const fallbackTag = normalizeRouting(profile?.routing).fallback.name
    const fallbackSelector = (config.outbounds || []).find((o) => o.tag === fallbackTag)
    const policyMembers = fallbackSelector ? fallbackSelector.outbounds : []
    const builtin = builtinTags(userGroups || [])
    // 第一层的两个判定(和 engine/config.mjs 生成 tun 入站、下面的 DNS 接管用的是同一份计算):
    // DNS 转发计划、入口原生旁路。落进元数据,规则页和诊断包都拿它说明"直连到底进没进内核"
    const clientRoutes = normalizeClientRoutes(profile.clientRoutes)
    // 计划阶段(纯函数)→ 展开阶段(把走代理的规则集解码成域名,展不开就降成 all)→ 应用阶段
    // (可能再降级)。元数据记的是最终实际执行的那份;计划阶段的模式另存一份,选择同步时按同口径比
    const dnsRewriteConfig = normalizeDnsRewrite(profile.dns)
    const dnsRewrite = dnsRewriteConfig.enabled ? dnsRewriteConfig.rules : []
    const dnsPlanned = filterForwardPlan(profile, dnsmasqForwardPlan(profile.routing, policyMembers, builtin, selections || {}, { rewriteDomains: rewriteForwardDomains(dnsRewrite) }))
    let dnsForward = dnsMode === 'dnsmasq' ? await expandDnsForward(ctx, paths, dnsPlanned) : dnsPlanned
    const bypassPlanned = nativeBypassPlan(profile.routing, { members: policyMembers, builtin, selections: selections || {}, clientRoutes, fakeIp: dnsFakeIpEnabled(profile), dnsMode, enabled: profile.directBypass !== false })
    // 部署入口(api/deploy-runner.mjs)会带一份做过重叠核对的结论;没带就按纯函数的保守结论
    const nativeBypass = bypassGiven && typeof bypassGiven === 'object' ? bypassGiven : { ...bypassPlanned, pending: [] }
    // 解析要由内核按终端答、入口把查询转给内核 DNS 入站的终端(engine/client-routes.mjs 的 terminalDnsSources,和 engine/dns.mjs
    // 生成规则用的同一个判断)。按此刻的 autoRedirect 算:降级成纯 tun 后就没有了
    const terminalDnsNow = () => terminalDnsSources(normalizeClientRoutes(profile.clientRoutes, { directTag: builtin.direct }), {
      dnsMode, autoRedirect, directBypass: profile.directBypass !== false, splitDns: Boolean(profile.dns && profile.dns.split), directTag: builtin.direct, blockTag: builtin.block,
    })
    // dnsmasq 查询日志(system/dnsmasq-query-log.mjs)开没开:DNS 接管应用完才知道,变了就把元数据再写一遍。面板按它读日志、认终端
    let queryLogState = { active: false, reason: '' }
    // 配置 + 元数据一起写;auto_redirect 降级重试时再写一遍
    const writeConfigAndMeta = async (cfg) => {
      await ctx.writeFile(paths.configPath, JSON.stringify(cfg, null, 2))
      await ctx.writeFile(
        configMetaPath(paths),
        JSON.stringify({
          dnsMode,
          dnsFilter: { enabled: profile.dns?.filter?.enabled === true, key: filterKey(filterSettings(profile)) },
          dnsmasqQueryLog: queryLogState,
          // 代理侧 DNS 上游各走哪条线路(目标分流判的):出口、命中第几条、归谁;判不出来的带 error
          dnsUpstreamRoutes: (Array.isArray(dnsUpstreamRoutes) ? dnsUpstreamRoutes : []).map((r) => ({
            server: r.server, port: r.port, protocol: r.protocol, outbound: r.outbound || '', reject: Boolean(r.reject),
            ruleIndex: r.ruleIndex ?? null, owner: r.owner || null, ...(r.wan ? { wan: true } : {}), ...(r.error ? { error: r.error } : {}),
          })),
          autoRedirect,
          generatedAt: new Date().toISOString(),
          // 这份 dns.rules 是按"谁走直连、谁走代理"定死的,把当时的判断和成员表一并存下来:
          // 代理页改出口后要拿它比对,翻面了才重新生成(见 api/deploy-runner.mjs)
          dnsPolicyMembers: policyMembers,
          dnsPolicyClasses: dnsPolicyClasses(profile.routing, policyMembers, builtin, selections || {}),
          // 这次部署用的是哪份分流设置。规则页拿它和当前档案比,改了没重启就明说
          routingHash: routingFingerprint(profile.routing),
          // 故障转移的运行映射:父组 id / tag、页签 id / 顺序 / 有效节点 / 子组 tag / 派生模式、检测参数。
          // 后台管理器只按已经部署的这份做主备决策(弹窗里保存了还没生效的定义不算)
          failover: Array.isArray(failover) ? failover : [],
          // 这次部署里进了内核 dns.rules 的 DNS 重写源域名:规则改了没重启,规则页和状态接口拿它对照
          dnsRewrite: enabledRewriteSources(dnsRewrite),
          // 每条 dns.rules 归哪个站点集(engine/dns.mjs):直连应答放行按内核日志里的规则下标找回站点集
          dnsRuleOwners: Array.isArray(dnsRuleOwners) ? dnsRuleOwners : [],
          // 生成这份配置用到的、档案之外的输入(api/deploy-runner.mjs 的 configFromInputs):热替换 / 待重启判断按同样的输入
          // 重新生成、和运行中的比(api/hot-apply.mjs)
          ...(buildInputs ? { buildInputs: { ...buildInputs, autoRedirectFallback, deploySide: deploySideInputs(profile) } } : {}),
          // 热切换(engine/flip.mjs):这份配置里按类别分叉的规则都挂在开关规则集上。记下每个开关 / 旁路动态集此刻
          // 写的是什么,翻面时按这张表比、只改写变了的文件(api/deploy-runner.mjs 的 applyHotFlip);没有这一段 = 老结构,
          // 翻面照旧重启。bypassMode:有 nft 重定向时入口旁路是动态集(能在线换),降级到纯 tun 是老的静态写法
          // need / entryMode:只在有 nft 重定向时写(纯 tun 没有 route_address_set,热切换看到 need 为空就一份都不动)
          ...(flip ? { flip: { mode: 'hot', flags: flip.flags, names: flip.names, bypass: flip.bypass, bypassContent: flip.bypassContent || {}, bypassMode: autoRedirect ? 'dynamic' : 'static', ...(autoRedirect && flip.need ? { need: flip.need, entryMode: flip.entryMode } : {}) } } : {}),
          // 第一层:DNS 怎么分(none / domains / all)、入口有没有原生旁路、终端来源的 DNS 规则
          // 有没有生效(只有劫持模式内核才看得到终端的来源地址;dnsmasq 转发过来的一律是本机)
          firstLayer: {
            dnsMode,
            ...dnsForwardMeta(dnsMode, dnsForward, dnsPlanned),
            // 开 auto_redirect 时内核把集合写成 nft 集合在入口 return;纯 tun 模式下等价于加进路由表的排除项
            nativeBypass: nativeBypass.enabled ? { ...nativeBypass, via: autoRedirect ? 'nft' : 'route' } : nativeBypass,
            // 计划阶段(纯函数)的结论:选择同步时按同口径比。指纹含候选集合、核对对象和 FakeIP 前提(第四轮 T2)
            nativeBypassPlanned: { sets: bypassPlanned.sets, pending: bypassPlanned.pending.map((x) => x.policy) },
            nativeBypassPlanKey: bypassPlanKey(bypassPlanned),
            // 入口模式(白名单 / 黑名单):flip 状态里带着 deploy-runner 算好的结论;没带(测试)就按纯函数算一份。
            // 纯 tun(含 auto_redirect 降级)只有黑名单,原因写明,规则页「业务入口」照样能说清为什么没默认放行
            entryMode: autoRedirect
              ? entryModeMetaOf(flip, profile, policyMembers, builtin, selections, clientRoutes, dnsMode)
              : { mode: ENTRY_MODE_BLACKLIST, reason: PURE_TUN_ENTRY_REASON, needSets: [], needCidrs: 0 },
            // 每个站点集(含兜底)此刻的出口类别:纯 IP 站点集切换时 DNS 表看不出来,v6 保护 / 旁路要按它比(第四轮 T3)
            policyClasses: policyClasses(profile.routing, policyMembers, builtin, selections || {}),
            fakeIp: dnsFakeIpEnabled(profile),
            // IPv6 分层:off(老关闭语义)/ node(代理 v6 交给节点)/ ipv4(走代理的降为 IPv4,裸 v6 明确拒绝)
            ipv6: ipv6ProxyMode(profile),
            // 屏蔽 QUIC 的拒绝规则也按出口类别插:选择同步时要和 v6 保护一样比类别(api/deploy-runner.mjs 的 firstLayerChanged)
            rejectQuic: profile.rejectQuic === true,
            // 有没有终端的解析按终端答:劫持模式下全部终端;dnsmasq 模式下只有入口把查询转给内核的那几类
            // (「直连」「不进内核」的终端,engine/client-routes.mjs 的 terminalDnsRedirected)
            dnsSourceRules: dnsMode === 'hijack' ? clientRoutes.length > 0 : Object.values(terminalDnsNow()).some((list) => list.length > 0),
            // 热切换按部署时的这几项设置算入口(hotFlipInputs 的说明)
            inputs: hotFlipInputs(profile),
          },
        }, null, 2),
      )
    }
    await writeConfigAndMeta(config)
    // 进内核之前就放行的端口 / 终端:写给 init 脚本,下面重启内核时由它装进 nft(system/entry-bypass.mjs)。
    // 白名单按 IP 时只管局域网口进来的包,局域网口从 netifd 认(lan* 逻辑接口占着的设备)
    const lanIfaces = (await readLocalAddresses(ctx, { platform: paths.platform }).catch(() => [])).filter((a) => a.kind === 'lan').map((a) => a.iface)
    // directAnswered:直连域名解析出来的地址在入口放行的动态集合(内核往里写,system/direct-answer-bypass.mjs),有 nft 重定向就建。
    // terminalDns:「直连」「不进内核」的终端的查询转给内核 DNS 入站、按终端答(engine/client-routes.mjs 的 terminalDnsRedirected,
    // 和 engine/dns.mjs 生成规则用的同一个判断;「不进内核」的只转发给路由器自己的);fakeIpCidrs:「不进内核」的终端发往占位段的包照常进内核。
    // auto_redirect 降级成纯 tun 时按降级后的结论重写一遍(只剩端口那几条)
    const writeEntry = () => {
      const fakeIp = dnsFakeIpEnabled(profile)
      return writeEntryBypass(ctx, paths, entryBypassNft({
        ...activeBypassPorts(profile), clientRoutes: profile.clientRoutes, autoRedirect, lanIfaces, directAnswered: autoRedirect, tcpMss: tunTcpMss(profile),
        pureTun: (config.inbounds || []).some((i) => i && i.type === 'tun'),
        terminalDns: terminalDnsNow(),
        dnsPort: DNS_INBOUND_PORT,
        dnsV6: Boolean(profile.ipv6),
        fakeIpCidrs: fakeIp ? { v4: [FAKEIP_V4], v6: ipv6ProxyMode(profile) === 'node' ? [FAKEIP_V6] : [] } : { v4: [], v6: [] },
        // 「只让这些终端进内核」名单外终端的查询转给内核的直连 DNS 入站:配置里有这个入站才转(engine/config.mjs 按档案决定)
        admitDnsPort: (config.inbounds || []).some((i) => i && i.tag === DNS_DIRECT_INBOUND_TAG) ? DNS_DIRECT_INBOUND_PORT : 0,
      }))
    }
    await writeEntry()

    // 5. DNS 接管
    if (dnsMode !== 'dnsmasq' && (await ctx.exists(dnsTakeoverBackupPath(paths)))) {
      // 上次部署用了 dnsmasq 接管、这次切回 hijack(或其它非 dnsmasq 模式):
      // 若不先还原,dnsmasq 会继续指向 127.0.0.1#7853,而新配置已无 dns-in 入站,
      // LAN DNS 全断却仍报部署成功。备份是否存在的判断与 Critical 2 的回滚修复共用。
      await restoreDnsTakeover(ctx, paths)
    }
    // 代理面能被逐条列出来时,只把那几个域名转给内核,其余交回路由器自己解析——
    // 直连的 DNS 就真的不经过 Open-Box 了。列不出来就照旧全局转发。
    // 成员表从刚生成的配置里取(兜底 selector 的成员就是那一份),不另算一遍。
    const applied = await applyDnsTakeover(ctx, paths, { mode: dnsMode, forward: dnsForward, rewriteSources: enabledRewriteSources(dnsRewrite), queryLog: queryLogWanted(profile) })
    // 应用阶段又降级了(计划阶段本该拦住,这是最后一道):元数据必须记实际执行的,重写一遍;查询日志开没开也在这时才知道
    const degraded = dnsMode === 'dnsmasq' && applied.effective && applied.effective.mode !== dnsForward.mode
    if (degraded) dnsForward = { ...dnsForward, ...applied.effective, expanded: [], superset: [] }
    const nextQueryLog = applied.queryLog || { active: false, reason: '' }
    const queryLogChanged = nextQueryLog.active !== queryLogState.active || nextQueryLog.reason !== queryLogState.reason
    queryLogState = nextQueryLog
    if (degraded || queryLogChanged) await writeConfigAndMeta(config)
    mark('DNS 接管')

    // 6. 防火墙:四条规则各自对齐到目标状态,只要有一条真变了才 commit + reload,且只一次。
    // fw4 reload 在规则多的路由器上一次好几秒,以前每条规则各 reload 一遍,一次部署要等十几秒。
    // Debian / Ubuntu 没有 uci 防火墙:一条都不写(没有 fw4 那套区域,默认策略是放行;有自己防火墙的用户自理,README 有说明)
    const firewall = paths.platform === 'systemd' ? [] : [
      await applyPanelLanRule(ctx, { port: panelPort(), commit: false }),
      // 内核 DNS 入站 :7853 只放行 LAN(config.mjs 的 dns-in)
      await applyDnsLanRule(ctx, { port: 7853, commit: false }),
      await applyTunForwardRule(ctx, { device: config.inbounds?.find((i) => i.type === 'tun')?.interface_name || '', commit: false }),
      await applyTunInputRule(ctx, { device: config.inbounds?.find((i) => i.type === 'tun')?.interface_name || '', commit: false }),
      await applyIpv6Block(ctx, { enabled: profile.ipv6 === false, commit: false }),
      // 共享网络:从 WAN 放行各服务器的端口(局域网本来就能到路由器)
      await applyServerPortRules(ctx, enabledServers(profile.servers), { commit: false }),
    ]
    if (firewall.some((r) => r.changed)) await commitFirewall(ctx)
    mark('防火墙')

    // DNS / 防火墙已经按新配置改了,内核还没起:被停止取消就回滚到直连,不能留着半接管的状态
    if (isCancelled()) {
      const rb = await rollbackToDirect(ctx, paths)
      return withTimings({ ok: false, stage: 'cancelled', message: `部署被「停止」取消,${rollbackSummary(rb)}`, rollback: rb })
    }

    // 7. 重启内核前预检:procd 的 rc_procd 包装(procd_open_service; "$@"; procd_close_service)
    // 会吞掉 start_service 的返回码,二进制/配置缺失时 start 仍可能退出 0 且以零实例注册——
    // 脚本自身的 exit code 不可靠。这里主动检查一次,把"内核启动后未在运行"这类笼统错误
    // 收窄成精确的"文件缺失"归因,方便面板显示。
    if (!(await ctx.exists(paths.singbox)) || !(await ctx.exists(paths.configPath))) {
      const rb = await rollbackToDirect(ctx, paths)
      return { ok: false, stage: 'start', message: `sing-box 二进制或配置文件缺失,${rollbackSummary(rb)}`, rollback: rb }
    }
    // tun 设备:有的固件没装 / 没加载 tun 模块(GitHub #12,内核 FATAL "open /dev/net/tun:
    // no such file or directory")。先试着加载一次,还没有就明说要装 kmod-tun,别让用户
    // 对着内核的英文报错猜。
    if (!(await ctx.exists(TUN_DEVICE))) {
      await ctx.exec('modprobe', ['tun'])
      if (!(await ctx.exists(TUN_DEVICE))) {
        const rb = await rollbackToDirect(ctx, paths)
        return {
          ok: false, stage: 'start', rollback: rb,
          message: `系统没有 tun 设备（${TUN_DEVICE} 不存在）,内核起不来。${paths.platform === 'systemd' ? '请确认系统内核带 tun 模块（modprobe tun）' : '请安装 kmod-tun（opkg install kmod-tun）'}后重试。${rollbackSummary(rb)}`,
        }
      }
    }

    // 8. 重启内核;9. 验证运行。起 tun 撞上旧状态的先原样再起一次;auto_redirect 起不来的那种崩溃会降级成纯 tun
    // 再来一轮,所以套一层循环
    let warning = ''
    let redirectFallbackTried = false
    let startRetried = false
    let transientRetries = 0
    let logMark = null
    for (;;) {
      logMark = await kernelLogMark(ctx)
      const restart = await restartService(ctx, paths.initd.core)
      mark('重启')
      if (!restart.ok) {
        const rb = await rollbackToDirect(ctx, paths)
        const detail = describeError(String(restart.stderr || '').trim() || '内核启动失败')
        return withTimings({ ok: false, stage: 'start', ...detail, message: `${detail.message},${rollbackSummary(rb)}`, rollback: rb })
      }

      // 验证运行。看两眼而不是一眼:有一类错误 `sing-box check` 查不出来、进程起来
      // 之后才 FATAL(比如 DNS 服务器的 detour 写法),procd 会立刻重启它形成死循环——
      // 只看第一眼正好撞上"刚起来还没死"的那个瞬间,面板就会报"启动成功",刷新一看
      // 又是停止。等几秒再看一次,死循环里的进程这时多半正处在两次崩溃之间。
      let crashed = false
      for (const wait of [0, VERIFY_SETTLE_MS]) {
        if (wait) await ctx.sleep(wait)
        // 内核已经起了:取消的话交给排在后面的停止动作去停,这里只要别报成功、别开自启
        if (isCancelled()) return withTimings({ ok: false, stage: 'cancelled', message: '部署被「停止」取消,内核由随后的停止动作处理' })
        const status = await serviceStatus(ctx, paths.initd.core)
        if (!status.running) {
          crashed = true
          break
        }
      }
      if (!crashed) break

      const fatal = await readLastKernelFatal(ctx, logMark)
      if (autoRedirect && AUTO_REDIRECT_FATAL.test(fatal) && TRANSIENT_REDIRECT_FATAL.test(fatal) && transientRetries < TRANSIENT_RETRY_SETTLE_MS.length) {
        startRetried = true
        await ctx.sleep(TRANSIENT_RETRY_SETTLE_MS[transientRetries++])
        continue
      }
      if (!startRetried && (TUN_START_FATAL.test(fatal) || (autoRedirect && AUTO_REDIRECT_FATAL.test(fatal)))) {
        startRetried = true
        await ctx.sleep(START_RETRY_SETTLE_MS)
        continue
      }
      if (autoRedirect && !redirectFallbackTried && typeof rebuild === 'function' && AUTO_REDIRECT_FATAL.test(fatal)) {
        // nftables 那层起不来:关掉 auto_redirect 重新生成配置(排除表、DNS 改写都跟着变,
        // 不能只把字段删掉),再起一次。只试一次,再崩就按普通崩溃处理
        redirectFallbackTried = true
        autoRedirect = false
        autoRedirectFallback = true
        config = rebuild({ tun: { ...(profile.tun || {}), autoRedirect: false } })
        await writeConfigAndMeta(config)
        await writeEntry()
        warning = autoRedirectFallbackWarning(fatal)
        continue
      }
      const rb = await rollbackToDirect(ctx, paths)
      return withTimings({ ok: false, stage: 'verify', ...describeCrash(fatal, rb), rollback: rb })
    }
    mark('确认在跑')

    // 9b. 晚发生的崩溃交给调用方在后台盯:死了且是 auto_redirect 那类就照样降级重来一次,别的崩溃回滚直连。
    //     返回 null 表示一直在跑;isStale() 为真(又有新的部署开始了)就什么都不做
    const lateCrashWatch = async ({ sleep = detachedSleep, isStale = () => false } = {}) => {
      for (const wait of autoRedirect ? LATE_WATCH_REDIRECT_MS : LATE_WATCH_MS) {
        await sleep(wait)
        if (isStale() || isCancelled()) return null
        const running = (await serviceStatus(ctx, paths.initd.core)).running
        // 在跑的时候也要看:auto_redirect 那类崩了被 procd 立刻拉起来,状态照样是「在跑」(#426)
        const fatal = running
          ? (autoRedirect ? await readLastKernelFatal(ctx, logMark, { newPidsOnly: true }) : '')
          : await readLastKernelFatal(ctx, logMark)
        if (running && !(autoRedirect && AUTO_REDIRECT_FATAL.test(fatal))) continue
        if (autoRedirect && !redirectFallbackTried && typeof rebuild === 'function' && AUTO_REDIRECT_FATAL.test(fatal)) {
          redirectFallbackTried = true
          autoRedirect = false
          autoRedirectFallback = true
          config = rebuild({ tun: { ...(profile.tun || {}), autoRedirect: false } })
          await writeConfigAndMeta(config)
          await writeEntry()
          const fallbackMark = await kernelLogMark(ctx)
          const restart = await restartService(ctx, paths.initd.core)
          if (restart.ok) {
            await sleep(VERIFY_SETTLE_MS)
            if ((await serviceStatus(ctx, paths.initd.core)).running) return { ok: true, stage: 'running', message: '', warning: autoRedirectFallbackWarning(fatal) }
          }
          const rb2 = await rollbackToDirect(ctx, paths)
          return { ok: false, stage: 'verify', ...describeCrash(await readLastKernelFatal(ctx, fallbackMark), rb2), rollback: rb2 }
        }
        const rb = await rollbackToDirect(ctx, paths)
        return { ok: false, stage: 'verify', ...describeCrash(fatal, rb), rollback: rb }
      }
      return null
    }
    return withTimings({ ok: true, stage: 'running', message: '', warning, lateCrashWatch })
  } catch (error) {
    // 落盘之后任一步骤抛出异常(闪存写满、uci 调用失败等)都不能让部署直接 reject——
    // 必须尽力回滚到直连状态,不留半接管的死配置。
    const rb = await rollbackToDirect(ctx, paths)
    return { ok: false, stage: 'error', message: `${String((error && error.message) || error)},${rollbackSummary(rb)}`, rollback: rb }
  }
}
