import net from 'node:net'
import { parsePortSpec } from '../engine/routing-model.mjs'
import { admitSources, bypassSources, normalizeMac } from '../engine/client-routes.mjs'

// 进内核之前就放行(不经过内核,和没装 Open-Box 一样)的几类流量,由部署生成 nft 链写进 etc/entry-bypass.nft,
// init 脚本(openwrt/initd/openbox 的 openbox_apply_nft)在起内核前装进 Open-Box 自己的 inet openbox 表:
//   · 后端设置「进内核前放行的端口」(GitHub #183):目标或来源端口命中的 TCP / UDP——自建 RustDesk、端口映射出去的
//     NAS 服务这类。前置自定义分流写「端口 → 直连」不行:那时已经进了内核,直连是内核替它重新拨一次,源端口被换掉,
//     NAT 映射和打洞都坏。名单有两种用法(bypassPortsMode,GitHub #198 / #199),两份名单各存各的(bypassPorts /
//     bypassPortsWhitelist),只有选中的那份生效:
//       黑名单(默认、老行为):名单上的端口放行,其余照常进内核;
//       白名单:只有名单上的端口进内核,其余 TCP / UDP 一律放行 —— BT / PT 那种用高位端口的应用就整个不进内核了。
//     白名单只对**从局域网口进来**的包生效(和按 IP 的终端白名单同一个理由:WAN 入站不能动,否则端口映射的回程和
//     mwan3 记的出口会被冲掉);认不出局域网口时这条不装。路由器自己发出去的流量(output 链)也不按白名单放行,
//     否则内核自己的出站都被放行了
//   · 终端分流里的「不进内核」(黑名单):按 IP 的是来源地址,按 MAC 的是来源 MAC
//   · 终端分流里按 IP 的「只让这些终端进内核」(白名单,GitHub #187):从局域网口进来、IP 和 MAC 都不在名单上的
// 做法:在内核的 nft 链之前(priority mangle - 10)给包和连接**或上**放行位 PASS_MARK(meta mark 和 ct mark 都打),
// 内核(1.14.1-openbox-tcp15 起,sing-tun-pass-mark.patch)的 auto_redirect 链见到它就 return;init 脚本另有两条策略路由
// 让带这一位的包不进 tun 的路由表(纯 tun 兼容模式下跳过 tun 的规则、主表查不到路由时到此为止)。和 init 脚本给 dnsmasq
// 出站打的是同一位。tun 自己的 exclude_mac_address / include_mac_address(engine/config.mjs)照常写,但它们只管内核的
// nft 重定向链,管不到 auto_route 的策略路由 —— 所以按 MAC 的黑名单同样要在这里打(#195),白名单则在下面的规则里用
// ether saddr 一起判。
// Open-Box 只决定进不进内核,不进内核的交给路由器自己处理(用户 2026-10-01 定的原则):以前打的是整个换掉的 0x2024
// (内核自身流量的标记,也是路由标记 fwmark 0x2024 lookup main),放行的流量被逼着走主路由表,mwan3 记在连接标记里的
// 线路也被冲掉;放行位只按位或,别的位原样留着,mwan3 / 别的策略路由照常生效。
// 按 IP 的名单只认列出来的地址,IPv6 地址要另外列。改了设置要重启内核才生效
export const PASS_MARK = '0x02000000'
// 内核自己发出的流量带的标记(tun 的 auto_redirect_output_mark),tcpMss 按它认
export const KERNEL_MARK = '0x2024'
const MARK = `meta mark set meta mark or ${PASS_MARK} ct mark set ct mark or ${PASS_MARK}`

// 档案里此刻生效的那份端口名单:黑名单、白名单各存一份,只用 bypassPortsMode 选中的那份
export const activeBypassPorts = (profile) => {
  const p = profile || {}
  const whitelist = p.bypassPortsMode === 'whitelist'
  return { ports: String((whitelist ? p.bypassPortsWhitelist : p.bypassPorts) || ''), portsMode: whitelist ? 'whitelist' : 'blacklist' }
}

// 设置里的端口写法 → nft 集合元素「2233, 21114-21119」;写错或空的一律不放行
export const bypassPortsElements = (spec) => {
  const parsed = parsePortSpec(spec)
  if (!parsed) return ''
  return [...(parsed.port || []).map(String), ...(parsed.port_range || []).map((r) => r.replace(':', '-'))].join(', ')
}

const byFamily = (cidrs) => {
  const v4 = []
  const v6 = []
  for (const c of cidrs) {
    const addr = String(c).split('/')[0]
    if (net.isIPv4(addr)) v4.push(c)
    else if (net.isIPv6(addr)) v6.push(c)
  }
  return { v4, v6 }
}
const set = (items) => `{ ${items.join(', ')} }`
const IFNAME_RE = /^[A-Za-z0-9_.@-]{1,15}$/
// 目标是路由器自己的任一地址(局域网口、WAN 口……,重拨换了地址也跟着变)。fib 表达式是 auto_redirect 本来就要的模块
// (init 脚本起内核前 modprobe nft_fib_inet),这些规则也只在 auto_redirect 下才写
const TO_ROUTER = 'fib daddr type local'

// 生成链的正文(不含 table 外壳);什么都不用放行时返回空串。
// autoRedirect:终端分流的两类只在 auto_redirect 下生效(纯 tun 兼容模式下黑名单靠直连路由规则,白名单不生效);
// lanIfaces:白名单只管从这些局域网口进来的包——WAN 进来的(端口映射的入站连接等)不能打标记,否则 mwan3 给入站
// 连接记的回程出口也被冲掉。一个局域网口都认不出时白名单这条不装(宁可不生效,也不误伤)
// 直连应答放行(GitHub:speedtest.net 挂在 Cloudflare 上,入口只看 IP 分不出它是直连域名):内核 DNS 对直连站点集
// 的域名回了真实地址,面板把这些地址塞进带超时的集合(system/direct-answer-bypass.mjs),命中的包在入口就打标记放走。
// 集合空着时规则不命中,等于不存在;内核重启 init 重装这张表,集合从空开始重新攒
export const DIRECT_ANSWERED_SET = { 4: 'direct_answered4', 6: 'direct_answered6' }
export const directAnsweredSets = () => [
  `	set ${DIRECT_ANSWERED_SET[4]} {`, '		type ipv4_addr; flags timeout;', '	}',
  `	set ${DIRECT_ANSWERED_SET[6]} {`, '		type ipv6_addr; flags timeout;', '	}',
]

// tcpMss(后端设置 → TUN 参数,GitHub #239):内核自己发出的 TCP 连接都打着 0x2024 标记(auto_route 的输出标记,纯 tun 也一样),
// 在 output 钩子上把这些连接的 SYN 的 MSS 钳到指定值;sing-box 没有这个选项。局域网转发的流量不管:那是 fw4 的 mtu_fix 的事
// terminalDns:要由内核按终端答解析的终端来源(engine/client-routes.mjs 的 terminalDnsSources)。查询在入口转给内核的
// DNS 入站(dnsPort),内核才看得到是哪台终端在查——dnsmasq 转过来的查询来源一律是本机。ips / macs(「直连」终端)发往任何
// 53 端口的都转;localIps / localMacs(「不进内核」的终端)只转发给路由器自己的(TO_ROUTER),它自己指定的外部 DNS 不截。
// dnsV6:DNS 入站听的是 ::(开了 IPv6),v6 的查询也能转;否则只转 v4,v6 的查询落回 dnsmasq,拿到的占位地址照样进内核兜着。
// fakeIpCidrs:FakeIP 占位段 { v4, v6 }。「不进内核」的终端发往占位段的包不打标记(见下)
// admitDnsPort:「只让这些终端进内核」名单外终端发给路由器自己的查询转到内核的直连 DNS 入站(engine/config.mjs 的
// DNS_DIRECT_INBOUND_PORT);0 = 配置里没有这个入站,不转
export const entryBypassNft = ({ ports = '', portsMode = 'blacklist', clientRoutes = [], autoRedirect = false, pureTun = false, lanIfaces = [], directAnswered = false, tcpMss = 0, terminalDns = { ips: [], macs: [] }, dnsPort = 0, dnsV6 = false, fakeIpCidrs = { v4: [], v6: [] }, admitDnsPort = 0 } = {}) => {
  const inRules = []
  const outRules = []
  if (directAnswered) {
    // 发往这些地址的 DNS 查询(53 端口)不放:集合里偶尔有公共 DNS 的地址(主机名按直连解析、IP 又落在要进内核的网段里,
    // 比如挂在 Cloudflare / 谷歌云上的),终端直接往它的 53 端口发查询时打了放行位,就跳过了内核的 DNS 劫持,
    // 域名过滤和按规则分流解析都管不到。不打放行位,照常被劫持进内核(内核的 nat 链里 DNS 劫持排在按目标地址放行之前)
    for (const [family, name] of [['ip', DIRECT_ANSWERED_SET[4]], ['ip6', DIRECT_ANSWERED_SET[6]]]) {
      inRules.push(`${family} daddr @${name} meta l4proto != { tcp, udp } ${MARK}`)
      inRules.push(`${family} daddr @${name} meta l4proto { tcp, udp } th dport != 53 ${MARK}`)
    }
  }
  const portEls = bypassPortsElements(ports)
  const lanIfnames = [...new Set(lanIfaces)].filter((n) => IFNAME_RE.test(n))
  // FakeIP 占位地址只有内核认得(解析没转到内核时、或者转之前缓存下来的):发往占位段的包不打放行位,照常进内核按规则走;
  // 放行了就交给路由器按真实路由从宽带口发出去,哪都到不了。「不进内核」的终端、按端口放行(GitHub #572 #517)都这样
  const f4 = (fakeIpCidrs.v4 || []).length ? ` ip daddr != ${set(fakeIpCidrs.v4)}` : ''
  const f6 = (fakeIpCidrs.v6 || []).length ? ` ip6 daddr != ${set(fakeIpCidrs.v6)}` : ''
  // 端口规则不分地址族,要排除占位段就按族拆成两条;没开 FakeIP 时还是一条
  const notFake = f4 || f6 ? [`meta nfproto ipv4${f4} `, `meta nfproto ipv6${f6} `] : ['']
  if (portEls && portsMode === 'whitelist') {
    // 白名单:两头端口都不在名单上才放行(任一头命中就进内核 —— 回程包的源端口才是那个服务端口)。
    // 只管局域网口进来的包;路由器自己的 output 不动
    if (lanIfnames.length) {
      const iif = `iifname ${set(lanIfnames.map((n) => `"${n}"`))}`
      for (const guard of notFake) inRules.push(`${iif} ${guard}meta l4proto { tcp, udp } th dport != ${set([portEls])} th sport != ${set([portEls])} ${MARK}`)
    }
  } else if (portEls) {
    for (const dir of ['dport', 'sport']) {
      for (const guard of notFake) {
        const rule = `${guard}meta l4proto { tcp, udp } th ${dir} ${set([portEls])} ${MARK}`
        inRules.push(rule)
        outRules.push(rule)
      }
    }
  }
  const natRules = []
  if (pureTun && !autoRedirect) {
    // 纯 tun 兼容模式(pureTun:配置里有 tun、没有 auto_redirect):auto_route 的策略路由(9003 not iif lo lookup <tun 表>)把进来的包全拉进 tun 表,回包也不例外——
    // 端口映射(WAN → 局域网 / docker 里的服务 DNAT)的回包被内核当成新连接重新拨出去,WireGuard、公网 socks 这类映射
    // 全断(#383)。auto_redirect 的 nft 链见到回包方向就 return(sing-tun redirect_nftables.go),这里照做:回包只给包
    // 或上放行位(不动连接),init 的 8998 让它跳过 tun 的规则按路由器自己的路由走。经内核的连接回包本来就从 tun 出来
    // (9002 iif tun 那条),结果不变
    inRules.push(`ct direction reply meta mark set meta mark or ${PASS_MARK}`)
  }
  if (autoRedirect) {
    const blackSrc = bypassSources(clientRoutes)
    const black = byFamily(blackSrc.ips)
    // 「不进内核」的终端发往占位段的包也不打放行位(f4 / f6 见上面端口那段)
    if (black.v4.length) inRules.push(`ip saddr ${set(black.v4)}${f4} ${MARK}`)
    if (black.v6.length) inRules.push(`ip6 saddr ${set(black.v6)}${f6} ${MARK}`)
    // 按 MAC 的黑名单也要在这里打放行位,不能只靠 tun 的 exclude_mac_address:那个只让内核的 nft
    // 重定向链跳过这台终端,而 auto_route 装的策略路由(`not from all fwmark 0x2024 lookup <tun 表>`)
    // 照样把它的包拉进 tun —— 结果就是「不进内核」勾了等于没勾。GitHub #195 的小爱音箱 / 智能屏
    // 就是这样断网的,报告者自己用 `ip rule add from <IP> table main` 试出来是路由这一层的问题。
    // 打上放行位之后 init 脚本那两条策略路由让它不进 tun 表,和按 IP 那条走同一条路。
    const blackMacs = blackSrc.macs.map(normalizeMac).filter(Boolean)
    if (blackMacs.length && (f4 || f6)) {
      inRules.push(`ether saddr ${set(blackMacs)} meta nfproto ipv4${f4} ${MARK}`)
      inRules.push(`ether saddr ${set(blackMacs)} meta nfproto ipv6${f6} ${MARK}`)
    } else if (blackMacs.length) inRules.push(`ether saddr ${set(blackMacs)} ${MARK}`)
    // 按终端答解析的终端:查询转给内核的 DNS 入站。「直连」终端发往任何 53 端口的都转;「不进内核」的终端只转发给路由器
    // 自己的,它自己指定的外部 DNS 交给路由器按自己的路由发(engine/client-routes.mjs 的 terminalDnsLocalOnly)
    if (Number.isInteger(dnsPort) && dnsPort > 0) {
      const redirect = `meta l4proto { tcp, udp } th dport 53 redirect to :${dnsPort}`
      const add = (ips, macList, cond) => {
        const t = byFamily(ips || [])
        if (t.v4.length) natRules.push(`ip saddr ${set(t.v4)} ${cond}${redirect}`)
        if (t.v6.length && dnsV6) natRules.push(`ip6 saddr ${set(t.v6)} ${cond}${redirect}`)
        const macs = (macList || []).map(normalizeMac).filter(Boolean)
        if (macs.length) natRules.push(`ether saddr ${set(macs)} ${dnsV6 ? '' : 'meta nfproto ipv4 '}${cond}${redirect}`)
      }
      add(terminalDns.ips, terminalDns.macs, '')
      add(terminalDns.localIps, terminalDns.localMacs, `${TO_ROUTER} `)
    }
    const admit = admitSources(clientRoutes)
    const ifaces = lanIfnames
    if (admit.ips.length && ifaces.length) {
      const white = byFamily(admit.ips)
      const macs = admit.macs.map(normalizeMac).filter(Boolean)
      const macCond = macs.length ? ` ether saddr != ${set(macs)}` : ''
      const iif = `iifname ${set(ifaces.map((n) => `"${n}"`))}`
      const v4Match = `${iif} meta nfproto ipv4${white.v4.length ? ` ip saddr != ${set(white.v4)}` : ''}${macCond}`
      const v6Match = `${iif} meta nfproto ipv6${white.v6.length ? ` ip6 saddr != ${set(white.v6)}` : ''}${macCond}`
      // 名单外的终端拿到的 FakeIP 占位地址只有内核认得,发往占位段的包不打标记(GitHub #260 #270,同「不进内核」那条)
      inRules.push(`${v4Match}${f4} ${MARK}`)
      inRules.push(`${v6Match}${f6} ${MARK}`)
      // 名单外终端发给路由器自己的查询转给内核的直连 DNS 入站,拿到的是真实地址;它们自己指定的外部 DNS 不截(同「不进内核」)
      if (Number.isInteger(admitDnsPort) && admitDnsPort > 0) {
        const redirect = `${TO_ROUTER} meta l4proto { tcp, udp } th dport 53 redirect to :${admitDnsPort}`
        natRules.push(`${v4Match} ${redirect}`)
        if (dnsV6) natRules.push(`${v6Match} ${redirect}`)
      }
    }
  }
  const chain = (name, type, rules, priority = 'mangle - 10') => [
    `\tchain ${name} {`,
    `\t\ttype ${type} priority ${priority}; policy accept;`,
    ...rules.map((r) => `\t\t${r}`),
    '\t}',
  ]
  const mssRules = Number.isInteger(tcpMss) && tcpMss > 0 ? [`meta mark ${KERNEL_MARK} tcp flags syn tcp option maxseg size set ${tcpMss}`] : []
  return [
    ...(directAnswered ? directAnsweredSets() : []),
    ...(inRules.length ? chain('entry_bypass_in', 'filter hook prerouting', inRules) : []),
    ...(outRules.length ? chain('entry_bypass_out', 'route hook output', outRules) : []),
    ...(mssRules.length ? chain('tcp_mss_out', 'filter hook output', mssRules) : []),
    // 排在内核自己的 nat 链(dstnat + 2)之前:先转走,内核那边看到的已经是发给本机 DNS 入站的包
    ...(natRules.length ? chain('terminal_dns', 'nat hook prerouting', natRules, 'dstnat - 5') : []),
  ].join('\n')
}

// 写给 init 脚本;什么都不用放行就删掉这个文件
export const writeEntryBypass = async (ctx, paths, text) => {
  if (text) await ctx.writeFile(paths.entryBypassPath, `${text}\n`)
  else await ctx.exec('rm', ['-f', paths.entryBypassPath])
  return text
}
