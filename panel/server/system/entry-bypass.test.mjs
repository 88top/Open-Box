import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { KERNEL_MARK, PASS_MARK, bypassPortsElements, entryBypassNft, writeEntryBypass } from './entry-bypass.mjs'
import { createMockContext } from './context.mjs'
import { createPaths } from './paths.mjs'

const paths = createPaths('/opt/open-box')
const MARK = 'meta mark set meta mark or 0x02000000 ct mark set ct mark or 0x02000000'

test('进内核前放行的端口(#183):设置写法 → nft 集合元素;写错或空的一律不放行', () => {
  assert.equal(bypassPortsElements('21114-21119, 2233'), '2233, 21114-21119')
  assert.equal(bypassPortsElements('51820'), '51820')
  assert.equal(bypassPortsElements(''), '')
  assert.equal(bypassPortsElements('22; flush ruleset'), '')
  assert.equal(bypassPortsElements('70000'), '')
})

test('放行端口:prerouting / output 各一条链,mangle - 10,目标和来源端口都打内核标记;不管是不是 auto_redirect', () => {
  const text = entryBypassNft({ ports: '2233', autoRedirect: false })
  assert.equal(text, [
    '\tchain entry_bypass_in {',
    '\t\ttype filter hook prerouting priority mangle - 10; policy accept;',
    `\t\tmeta l4proto { tcp, udp } th dport { 2233 } ${MARK}`,
    `\t\tmeta l4proto { tcp, udp } th sport { 2233 } ${MARK}`,
    '\t}',
    '\tchain entry_bypass_out {',
    '\t\ttype route hook output priority mangle - 10; policy accept;',
    `\t\tmeta l4proto { tcp, udp } th dport { 2233 } ${MARK}`,
    `\t\tmeta l4proto { tcp, udp } th sport { 2233 } ${MARK}`,
    '\t}',
  ].join('\n'))
  assert.equal(entryBypassNft({}), '', '什么都没设就是空的')
})

test('终端分流按 IP(#187):不进内核按来源地址打标记(v4 / v6 分开);白名单只管局域网口进来、IP 和 MAC 都不在名单上的;只在 auto_redirect 下', () => {
  const clientRoutes = [
    { id: 'b', name: 'b', match: 'ip', bypass: true, sources: ['10.0.0.30', 'fd00::30'] },
    { id: 'bm', name: 'bm', match: 'mac', bypass: true, macs: ['aa:bb:cc:00:00:03'] },
    { id: 'a', name: 'a', match: 'ip', admit: true, sources: ['10.0.0.40', '10.0.1.0/24'] },
    { id: 'am', name: 'am', match: 'mac', admit: true, macs: ['aa:bb:cc:00:00:04'] },
    { id: 'tv', name: 'tv', match: 'ip', sources: ['10.0.0.8'], outbound: '香港-自动' },
  ]
  const text = entryBypassNft({ clientRoutes, autoRedirect: true, lanIfaces: ['br-lan', 'br-lan', 'bad name!'] })
  const lines = text.split('\n').map((l) => l.trim())
  assert.ok(lines.includes(`ip saddr { 10.0.0.30/32 } ${MARK}`))
  assert.ok(lines.includes(`ip6 saddr { fd00::30/128 } ${MARK}`))
  // 按 MAC 的黑名单也要在这里打标记:tun 的 exclude_mac_address 只让内核的 nft 重定向跳过这台终端,
  // auto_route 的策略路由照样把它的包拉进 tun,「不进内核」就成了摆设(GitHub #195 的小爱音箱)。
  assert.ok(lines.includes(`ether saddr { aa:bb:cc:00:00:03 } ${MARK}`), '按 MAC 的黑名单也要打放行位,否则只躲过重定向、躲不过策略路由')
  assert.ok(lines.includes(`iifname { "br-lan" } meta nfproto ipv4 ip saddr != { 10.0.0.40/32, 10.0.1.0/24 } ether saddr != { aa:bb:cc:00:00:04 } ${MARK}`))
  assert.ok(lines.includes(`iifname { "br-lan" } meta nfproto ipv6 ether saddr != { aa:bb:cc:00:00:04 } ${MARK}`), '没列 v6 地址:v6 只按 MAC 放进来')
  assert.ok(!text.includes('10.0.0.8'), '指定出站的不在这里')
  assert.ok(!text.includes('entry_bypass_out'), '终端规则只在 prerouting')
  const pureTun = entryBypassNft({ clientRoutes, autoRedirect: false, pureTun: true, lanIfaces: ['br-lan'] })
  assert.ok(!pureTun.includes('saddr'), '纯 tun 兼容模式下终端规则不装')
  const noLan = entryBypassNft({ clientRoutes, autoRedirect: true, lanIfaces: [] })
  assert.ok(!noLan.includes('iifname'), '认不出局域网口就不装白名单,宁可不生效也不误伤 WAN 进来的')
  assert.ok(noLan.includes('ip saddr { 10.0.0.30/32 }'), '黑名单不受影响')
})

test('部署时写 etc/entry-bypass.nft 给 init 脚本;空的就删掉', async () => {
  const ctx = createMockContext()
  await writeEntryBypass(ctx, paths, 'chain x {}')
  assert.equal(ctx.writes.find((x) => x.path === '/opt/open-box/etc/entry-bypass.nft').content, 'chain x {}\n')
  const off = createMockContext()
  await writeEntryBypass(off, paths, '')
  assert.ok(off.calls.some((c) => c.cmd === 'rm' && c.args.join(' ') === '-f /opt/open-box/etc/entry-bypass.nft'))
  assert.ok(!off.writes.length)
})

test('端口白名单(#198 / #199):只有名单上的端口进内核,其余从局域网口进来的 TCP / UDP 一律放行', () => {
  const text = entryBypassNft({ ports: '80, 443, 53', portsMode: 'whitelist', lanIfaces: ['br-lan'] })
  const lines = text.split('\n').map((l) => l.trim())
  // 两头都不在名单上才放行:回程包的**源**端口才是那个服务端口,只判 dport 会把回程漏出去
  assert.ok(
    lines.includes(`iifname { "br-lan" } meta l4proto { tcp, udp } th dport != { 80, 443, 53 } th sport != { 80, 443, 53 } ${MARK}`),
    `白名单规则不对:\n${text}`,
  )
  assert.ok(!text.includes('entry_bypass_out'), '白名单不碰 output 链:路由器(含内核)自己发出去的流量不能按名单放行')
  // 认不出局域网口时宁可不装:WAN 入站被放行会打乱端口映射的回程和 mwan3 记的出口
  assert.equal(entryBypassNft({ ports: '80', portsMode: 'whitelist', lanIfaces: [] }), '', '认不出局域网口就不装白名单')
  // 黑名单(默认)行为不变
  const black = entryBypassNft({ ports: '80', lanIfaces: ['br-lan'] })
  assert.ok(black.includes(`meta l4proto { tcp, udp } th dport { 80 } ${MARK}`), '默认仍是黑名单')
  assert.ok(black.includes('entry_bypass_out'), '黑名单要管 output:路由器自己连那个端口也要放行')
  assert.ok(!black.includes('iifname { "br-lan" } meta l4proto'), '黑名单不限入口网卡')
  // 名单为空时白名单不装:否则"只有空名单进内核"=全部放行,等于把内核整个旁路掉
  assert.equal(entryBypassNft({ ports: '', portsMode: 'whitelist', lanIfaces: ['br-lan'] }), '', '名单为空时不装白名单,不能全部放行')
})

test('按端口放行:发往 FakeIP 占位段的包不打标记(GitHub #572 #517:占位地址只有内核认得,放行了就从宽带口发出去、连不上);黑名单入口 / 本机出站、白名单、纯 tun 都一样', () => {
  const fakeIpCidrs = { v4: ['198.19.0.0/16'], v6: ['fc00::/18'] }
  const black = entryBypassNft({ ports: '993, 8000-8100', autoRedirect: false, pureTun: true, fakeIpCidrs }).split('\n').map((l) => l.trim())
  for (const dir of ['dport', 'sport']) {
    const v4 = `meta nfproto ipv4 ip daddr != { 198.19.0.0/16 } meta l4proto { tcp, udp } th ${dir} { 993, 8000-8100 } ${MARK}`
    const v6 = `meta nfproto ipv6 ip6 daddr != { fc00::/18 } meta l4proto { tcp, udp } th ${dir} { 993, 8000-8100 } ${MARK}`
    assert.equal(black.filter((l) => l === v4).length, 2, `入口和本机出站各一条:\n${black.join('\n')}`)
    assert.equal(black.filter((l) => l === v6).length, 2)
  }
  assert.ok(!black.some((l) => l.startsWith('meta l4proto')), '没有不看目标地址的端口规则')
  const white = entryBypassNft({ ports: '80, 443', portsMode: 'whitelist', lanIfaces: ['br-lan'], autoRedirect: true, fakeIpCidrs: { v4: ['198.19.0.0/16'], v6: [] } }).split('\n').map((l) => l.trim())
  assert.ok(white.includes(`iifname { "br-lan" } meta nfproto ipv4 ip daddr != { 198.19.0.0/16 } meta l4proto { tcp, udp } th dport != { 80, 443 } th sport != { 80, 443 } ${MARK}`), white.join('\n'))
  assert.ok(white.includes(`iifname { "br-lan" } meta nfproto ipv6 meta l4proto { tcp, udp } th dport != { 80, 443 } th sport != { 80, 443 } ${MARK}`), 'v6 没有占位段(不交给节点)时照常放行')
  // 没开 FakeIP:和以前一字不差
  assert.ok(entryBypassNft({ ports: '993' }).includes(`\t\tmeta l4proto { tcp, udp } th dport { 993 } ${MARK}`))
})

test('直连应答放行:有 nft 重定向时建两个带超时的集合,命中就打内核标记;集合空着等于没有', () => {
  const text = entryBypassNft({ autoRedirect: true, directAnswered: true })
  assert.ok(text.startsWith('\tset direct_answered4 {\n\t\ttype ipv4_addr; flags timeout;\n\t}\n\tset direct_answered6 {\n\t\ttype ipv6_addr; flags timeout;\n\t}\n'))
  for (const [family, name] of [['ip', 'direct_answered4'], ['ip6', 'direct_answered6']]) {
    assert.ok(text.includes(`\t\t${family} daddr @${name} meta l4proto != { tcp, udp } ${MARK}`), text)
    assert.ok(text.includes(`\t\t${family} daddr @${name} meta l4proto { tcp, udp } th dport != 53 ${MARK}`), text)
  }
  // 发往集合里地址的 DNS 查询不放(否则跳过内核的 DNS 劫持,域名过滤管不到):没有不带端口条件就放 TCP / UDP 的规则
  assert.ok(!/daddr @direct_answered[46] meta mark set/.test(text), text)
  assert.ok(!text.includes('entry_bypass_out'), '路由器自己的出站不放')
  assert.equal(entryBypassNft({ autoRedirect: true }).includes('direct_answered'), false)
})


test('出站 TCP MSS 钳制(#239):tcpMss > 0 时在 output 钩子上给打着内核标记的 SYN 钳 MSS;0 就没有这条链', () => {
  const text = entryBypassNft({ tcpMss: 1400 })
  assert.match(text, /chain tcp_mss_out \{\n\t\ttype filter hook output priority mangle - 10; policy accept;\n\t\tmeta mark 0x2024 tcp flags syn tcp option maxseg size set 1400\n\t\}/)
  // init 脚本只认这些字符,混进别的整份不装(openwrt/initd/openbox 的 openbox_entry_bypass)
  assert.doesNotMatch(text, /[^A-Za-z0-9 \t{}.,:;!="_@/\n-]/)
  assert.equal(entryBypassNft({ tcpMss: 0 }), '')
  assert.equal(entryBypassNft({ tcpMss: -5 }), '')
})

test('「不进内核」的终端:发往 FakeIP 占位段的包不打标记(占位地址只有内核认得,打了标记会从 WAN 发出去、哪都到不了)', () => {
  const clientRoutes = [
    { sources: ['192.168.1.9', '2001:db8::9'], bypass: true, match: 'ip' },
    { macs: ['AA-BB-CC-00-11-22'], bypass: true, match: 'mac' },
  ]
  const fakeIpCidrs = { v4: ['198.19.0.0/16'], v6: ['fc00::/18'] }
  const text = entryBypassNft({ clientRoutes, autoRedirect: true, fakeIpCidrs })
  assert.ok(text.includes(`ip saddr { 192.168.1.9/32 } ip daddr != { 198.19.0.0/16 } ${MARK}`))
  assert.ok(text.includes(`ip6 saddr { 2001:db8::9/128 } ip6 daddr != { fc00::/18 } ${MARK}`))
  assert.ok(text.includes(`ether saddr { aa:bb:cc:00:11:22 } meta nfproto ipv4 ip daddr != { 198.19.0.0/16 } ${MARK}`))
  assert.ok(text.includes(`ether saddr { aa:bb:cc:00:11:22 } meta nfproto ipv6 ip6 daddr != { fc00::/18 } ${MARK}`))
  // v6 没有占位段(代理 v6 不交给节点)时 v6 整个放行;没开 FakeIP 时和以前一样
  const v4Only = entryBypassNft({ clientRoutes, autoRedirect: true, fakeIpCidrs: { v4: ['198.19.0.0/16'], v6: [] } })
  assert.ok(v4Only.includes(`ether saddr { aa:bb:cc:00:11:22 } meta nfproto ipv6 ${MARK}`))
  const noFake = entryBypassNft({ clientRoutes, autoRedirect: true })
  assert.ok(noFake.includes(`ip saddr { 192.168.1.9/32 } ${MARK}`))
  assert.ok(noFake.includes(`ether saddr { aa:bb:cc:00:11:22 } ${MARK}`))
})

test('按终端答解析的终端:查询在内核的 nat 链之前转给内核 DNS 入站;只转 v4,DNS 入站听 :: 时连 v6 一起转', () => {
  const terminalDns = { ips: ['192.168.3.18/32', '2001:db8::18/128'], macs: ['00:15:5d:03:0a:12'] }
  const text = entryBypassNft({ autoRedirect: true, terminalDns, dnsPort: 7853 })
  assert.equal(text, [
    '\tchain terminal_dns {',
    '\t\ttype nat hook prerouting priority dstnat - 5; policy accept;',
    '\t\tip saddr { 192.168.3.18/32 } meta l4proto { tcp, udp } th dport 53 redirect to :7853',
    '\t\tether saddr { 00:15:5d:03:0a:12 } meta nfproto ipv4 meta l4proto { tcp, udp } th dport 53 redirect to :7853',
    '\t}',
  ].join('\n'))
  const v6 = entryBypassNft({ autoRedirect: true, terminalDns, dnsPort: 7853, dnsV6: true })
  assert.ok(v6.includes('ip6 saddr { 2001:db8::18/128 } meta l4proto { tcp, udp } th dport 53 redirect to :7853'))
  assert.ok(v6.includes('ether saddr { 00:15:5d:03:0a:12 } meta l4proto { tcp, udp } th dport 53 redirect to :7853'))
  // 纯 tun(没有 nft 重定向)不写;没给端口也不写
  assert.equal(entryBypassNft({ autoRedirect: false, terminalDns, dnsPort: 7853 }), '')
  assert.equal(entryBypassNft({ autoRedirect: true, terminalDns }), '')
  // init 脚本只收这些字符(openwrt/initd/openbox 的 openbox_entry_bypass)
  assert.ok(!/[^A-Za-z0-9 \t\n{}.,:;!="_@/-]/.test(v6))
})

test('「不进内核」的终端只转发给路由器自己的查询:它自己指定的外部 DNS 不截,交给路由器按自己的路由(mwan3 等)发', () => {
  const terminalDns = {
    ips: ['192.168.3.18/32'], macs: [],
    localIps: ['192.168.3.4/32', '2001:db8::4/128'], localMacs: ['00:15:5d:03:0a:34'],
  }
  const text = entryBypassNft({ autoRedirect: true, terminalDns, dnsPort: 7853 })
  assert.equal(text, [
    '\tchain terminal_dns {',
    '\t\ttype nat hook prerouting priority dstnat - 5; policy accept;',
    '\t\tip saddr { 192.168.3.18/32 } meta l4proto { tcp, udp } th dport 53 redirect to :7853',
    '\t\tip saddr { 192.168.3.4/32 } fib daddr type local meta l4proto { tcp, udp } th dport 53 redirect to :7853',
    '\t\tether saddr { 00:15:5d:03:0a:34 } meta nfproto ipv4 fib daddr type local meta l4proto { tcp, udp } th dport 53 redirect to :7853',
    '\t}',
  ].join('\n'))
  const v6 = entryBypassNft({ autoRedirect: true, terminalDns, dnsPort: 7853, dnsV6: true })
  assert.ok(v6.includes('ip6 saddr { 2001:db8::4/128 } fib daddr type local meta l4proto { tcp, udp } th dport 53 redirect to :7853'))
  assert.ok(v6.includes('ether saddr { 00:15:5d:03:0a:34 } fib daddr type local meta l4proto { tcp, udp } th dport 53 redirect to :7853'))
  // 只有「不进内核」的终端时也照样装这条链;init 脚本只收这些字符
  const only = entryBypassNft({ autoRedirect: true, terminalDns: { localIps: ['192.168.3.4/32'] }, dnsPort: 7853 })
  assert.ok(only.includes('ip saddr { 192.168.3.4/32 } fib daddr type local meta l4proto { tcp, udp } th dport 53 redirect to :7853'))
  assert.ok(!/[^A-Za-z0-9 \t\n{}.,:;!="_@/-]/.test(v6))
})

test('「只让这些终端进内核」名单外的终端:发往 FakeIP 占位段的包不打标记;发给路由器自己的查询转给内核的直连 DNS 入站(GitHub #260 #270),外部 DNS 不截', () => {
  const clientRoutes = [{ sources: ['192.168.2.10'], admit: true, match: 'ip' }]
  const text = entryBypassNft({ clientRoutes, autoRedirect: true, lanIfaces: ['br-lan'], fakeIpCidrs: { v4: ['198.19.0.0/16'], v6: [] }, admitDnsPort: 7855 })
  assert.ok(text.includes(`iifname { "br-lan" } meta nfproto ipv4 ip saddr != { 192.168.2.10/32 } ip daddr != { 198.19.0.0/16 } ${MARK}`))
  assert.ok(text.includes(`iifname { "br-lan" } meta nfproto ipv6 ${MARK}`))
  assert.ok(text.includes('iifname { "br-lan" } meta nfproto ipv4 ip saddr != { 192.168.2.10/32 } fib daddr type local meta l4proto { tcp, udp } th dport 53 redirect to :7855'))
  assert.ok(!text.includes('meta nfproto ipv6 meta l4proto { tcp, udp } th dport 53'), 'DNS 入站只听 IPv4 时不转 v6 查询')
  // 配置里没有直连 DNS 入站(admitDnsPort 0)时不转;认不出局域网口时整条白名单都不装
  assert.ok(!entryBypassNft({ clientRoutes, autoRedirect: true, lanIfaces: ['br-lan'] }).includes('redirect'))
  assert.equal(entryBypassNft({ clientRoutes, autoRedirect: true, lanIfaces: [], admitDnsPort: 7855 }), '')
})


test('纯 tun 兼容模式:回包方向只给包或上放行位,端口映射的回包不再被拉进 tun(#383);auto_redirect 下内核自己 return,不写', () => {
  const text = entryBypassNft({ autoRedirect: false, pureTun: true })
  assert.equal(text, [
    '\tchain entry_bypass_in {',
    '\t\ttype filter hook prerouting priority mangle - 10; policy accept;',
    `\t\tct direction reply meta mark set meta mark or ${PASS_MARK}`,
    '\t}',
  ].join('\n'))
  assert.ok(!text.includes('ct mark set'), '不动连接标记')
  assert.equal(entryBypassNft({ autoRedirect: true, pureTun: true }), '', 'auto_redirect 下不写')
  assert.equal(entryBypassNft({ autoRedirect: false }), '', '配置里没有 tun 时不写')
  // init 脚本只收这些字符(openwrt/initd/openbox 的 openbox_entry_bypass)
  assert.ok(!/[^A-Za-z0-9 \t\n{}.,:;!="_@/-]/.test(text))
})

test('activeBypassPorts:只用选中模式的那份名单', async () => {
  const { activeBypassPorts } = await import('./entry-bypass.mjs')
  assert.deepEqual(activeBypassPorts({ bypassPorts: '22', bypassPortsWhitelist: '443', bypassPortsMode: 'blacklist' }), { ports: '22', portsMode: 'blacklist' })
  assert.deepEqual(activeBypassPorts({ bypassPorts: '22', bypassPortsWhitelist: '443', bypassPortsMode: 'whitelist' }), { ports: '443', portsMode: 'whitelist' })
  assert.deepEqual(activeBypassPorts({ bypassPorts: '22', bypassPortsMode: 'whitelist' }), { ports: '', portsMode: 'whitelist' })
  assert.deepEqual(activeBypassPorts({}), { ports: '', portsMode: 'blacklist' })
})

// 用户 2026-10-01:Open-Box 只决定进不进内核,不进内核的交给路由器自己处理。放行只按位或上放行位,别的位(mwan3 记在
// 连接上的线路)原样留着;放行位要和内核(sing-tun-pass-mark.patch 的 OpenBoxPassMark)、两份 init 脚本认的是同一个
test('放行位三处一致(面板、init 脚本、内核补丁);生成的规则只按位或,不再整个改写标记', () => {
  const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8')
  const kernel = /OpenBoxPassMark uint32 = (0x[0-9a-fA-F]+)/.exec(read('scripts/singbox-tcp-dns-hotfix/sing-tun-pass-mark.patch'))
  assert.ok(kernel, '内核补丁里找不到 OpenBoxPassMark')
  assert.equal(Number(kernel[1]), Number(PASS_MARK))
  for (const f of ['openwrt/initd/openbox', 'debian/bin/openbox-ctl']) assert.match(read(f), new RegExp(`^OPENBOX_PASS_MARK=${PASS_MARK}$`, 'm'), f)
  assert.equal(Number(PASS_MARK) & 0x3f00, 0, '不能和 mwan3 的 0x3F00 重叠')
  const text = entryBypassNft({ ports: '2233', directAnswered: true, tcpMss: 1400 })
  assert.ok(!/mark set 0x/.test(text), text)
  assert.ok(text.includes(`meta mark set meta mark or ${PASS_MARK} ct mark set ct mark or ${PASS_MARK}`), text)
  assert.ok(text.includes(`meta mark ${KERNEL_MARK} tcp flags syn tcp option maxseg size set 1400`), 'MSS 仍按内核自己的 0x2024 认')
})
