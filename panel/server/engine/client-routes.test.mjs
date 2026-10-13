import assert from 'node:assert/strict'
import test from 'node:test'
import { admitDnsDirect, guardTerminalRules, isDirectClientRoute, isIpOrCidr, isNotShareInbound, normalizeCidr, normalizeClientRoutes, stripShareGuardText, terminalDnsLocalOnly, terminalDnsRedirected, terminalDnsSources, withoutShareGuard } from './client-routes.mjs'
import { flattenFlipRule } from './flip.mjs'

test('normalizeCidr:裸 IPv4/IPv6 补前缀,网段原样,非法返回空', () => {
  assert.equal(normalizeCidr('10.0.0.209'), '10.0.0.209/32')
  assert.equal(normalizeCidr(' 10.0.0.0/24 '), '10.0.0.0/24')
  assert.equal(normalizeCidr('fd00::1'), 'fd00::1/128')
  assert.equal(normalizeCidr('fd00::/64'), 'fd00::/64')
  for (const bad of ['', '10.0.0.256', '10.0.0.1/33', 'abc', '10.0.0.1/24/1', 'fd00::/129']) assert.equal(normalizeCidr(bad), '', bad)
  assert.ok(isIpOrCidr('192.168.1.5') && !isIpOrCidr('192.168.1'))
})

test('normalizeClientRoutes:停用的、来源全非法的、没出口的都丢掉', () => {
  const list = [
    { id: 'a', enabled: true, name: '电视', sources: ['10.0.0.5', 'bad', '10.0.1.0/24'], outbound: '香港-自动' },
    { id: 'b', enabled: false, name: '关', sources: ['10.0.0.6'], outbound: '直连' },
    { id: 'c', enabled: true, name: '空', sources: ['x'], outbound: '直连' },
    { id: 'd', enabled: true, name: '无出口', sources: ['10.0.0.7'], outbound: '' },
  ]
  assert.deepEqual(normalizeClientRoutes(list), [{ id: 'a', name: '电视', match: 'ip', outbound: '香港-自动', sources: ['10.0.0.5/32', '10.0.1.0/24'] }])
  assert.deepEqual(normalizeClientRoutes(null), [])
})

test('IPv6 校验交给 node:net:段数不够、段超 ffff、段数超 8 一律拒;带 zone 的链路本地地址不当网段;IPv4-mapped 收（审核 B6）', () => {
  for (const bad of ['1:2:3', '12345::1', '2001:db8:0:0:0:0:0:0:1', 'fe80::1%eth0', ':::1', '2001:db8::/129', '256.1.1.1']) {
    assert.equal(normalizeCidr(bad), '', bad)
    assert.equal(isIpOrCidr(bad), false, bad)
  }
  assert.equal(normalizeCidr('2001:db8::10'), '2001:db8::10/128')
  assert.equal(normalizeCidr('2001:db8:1234::/48'), '2001:db8:1234::/48')
  assert.equal(normalizeCidr('::ffff:192.168.1.1'), '::ffff:192.168.1.1/128')
})

test('不进内核（bypass）:MAC 归一成小写冒号写法、去重、丢掉不合法的;出站写成内置直连的 tag;普通规则原样', async () => {
  const { normalizeClientRoutes, normalizeMac, isMac } = await import('./client-routes.mjs')
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff')
  assert.equal(normalizeMac('aa:bb:cc:dd:ee'), '')
  assert.equal(isMac('00:15:5d:03:0a:28'), true)
  const out = normalizeClientRoutes([
    { id: 'sw', name: 'Switch', sources: ['10.0.0.9'], bypass: true, macs: ['AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff', 'bad'] },
    { id: 'tv', name: 'TV', sources: ['10.0.0.8'], outbound: '香港-自动' },
    { id: 'x', name: 'x', sources: ['10.0.0.7'], bypass: true, macs: ['zz'] },
  ], { directTag: '直连' })
  // 老档案的「不进内核」(IP + MAC 都有、没有 match)按 MAC 认;MAC 全不合法的那条认不出终端,丢掉
  assert.deepEqual(out, [
    { id: 'sw', name: 'Switch', match: 'mac', outbound: '直连', bypass: true, sources: [], macs: ['aa:bb:cc:dd:ee:ff'] },
    { id: 'tv', name: 'TV', match: 'ip', outbound: '香港-自动', sources: ['10.0.0.8/32'] },
  ])
})

test('终端按 IP / 按 MAC 二选一:match 说了算;路由 / DNS 的来源条件分别是 source_ip_cidr / source_mac_address;黑白名单按认法分开收', async () => {
  const { clientMatch, clientSourceMatch, bypassSources, admitSources } = await import('./client-routes.mjs')
  assert.equal(clientMatch({ bypass: true, macs: ['aa:bb:cc:dd:ee:ff'], sources: ['10.0.0.9'] }), 'mac', '老档案的不进内核')
  assert.equal(clientMatch({ admit: true, macs: ['aa:bb:cc:dd:ee:ff'] }), 'mac')
  assert.equal(clientMatch({ bypass: true, sources: ['10.0.0.9'] }), 'ip')
  assert.equal(clientMatch({ match: 'ip', bypass: true, macs: ['aa:bb:cc:dd:ee:ff'], sources: ['10.0.0.9'] }), 'ip')
  const [tvMac, pcIp] = normalizeClientRoutes([
    { id: 'tv', name: 'TV', match: 'mac', macs: ['AA-BB-CC-00-00-01'], sources: ['10.0.0.8'], outbound: '香港-自动' },
    { id: 'pc', name: 'PC', match: 'ip', sources: ['10.0.0.20'], macs: ['aa:bb:cc:00:00:02'], bypass: true },
  ], { directTag: '直连' })
  assert.deepEqual(clientSourceMatch(tvMac), { source_mac_address: ['aa:bb:cc:00:00:01'] })
  assert.deepEqual(clientSourceMatch(pcIp), { source_ip_cidr: ['10.0.0.20/32'] })
  assert.equal(pcIp.outbound, '直连')
  const list = [
    { id: 'b1', name: 'b1', match: 'ip', bypass: true, sources: ['10.0.0.30', 'fd00::30'] },
    { id: 'b2', name: 'b2', match: 'mac', bypass: true, macs: ['aa:bb:cc:00:00:03'] },
    { id: 'a1', name: 'a1', match: 'ip', admit: true, sources: ['10.0.0.40'] },
    { id: 'a2', name: 'a2', match: 'mac', admit: true, macs: ['aa:bb:cc:00:00:04'] },
    { id: 'a3', name: 'a3', enabled: false, match: 'ip', admit: true, sources: ['10.0.0.41'] },
  ]
  assert.deepEqual(bypassSources(list), { ips: ['10.0.0.30/32', 'fd00::30/128'], macs: ['aa:bb:cc:00:00:03'] })
  assert.deepEqual(admitSources(list), { ips: ['10.0.0.40/32'], macs: ['aa:bb:cc:00:00:04'] })
})

test('哪些终端的解析由内核按终端答(入口把查询转给内核 DNS 入站):不进内核的两种模式都要;直连的只在 dnsmasq 模式、且会在首包预判放行时', () => {
  const list = normalizeClientRoutes([
    { sources: ['192.168.3.18'], outbound: '直连' },
    { macs: ['AA-BB-CC-00-11-22'], match: 'mac', bypass: true },
    { sources: ['192.168.3.40'], outbound: '香港-自动' },
  ], { directTag: '直连' })
  const [direct, bypass, proxy] = list
  assert.equal(isDirectClientRoute(direct, '直连'), true)
  assert.equal(isDirectClientRoute(bypass, '直连'), false, '不进内核的出口也写成直连,但它在入口打标记,不归首包预判')
  assert.equal(isDirectClientRoute(proxy, '直连'), false)
  const on = { dnsMode: 'dnsmasq', autoRedirect: true, directBypass: true, splitDns: true, directTag: '直连', blockTag: '拒绝' }
  // dnsmasq 模式下指定走节点的终端也按终端答(GitHub #574):解析跟着它的出口
  assert.deepEqual(list.map((cr) => terminalDnsRedirected(cr, on)), [true, true, true])
  assert.deepEqual(list.map((cr) => terminalDnsRedirected(cr, { ...on, dnsMode: 'hijack' })), [false, true, false], '劫持模式下内核本来就接得到直连 / 走节点终端的查询')
  assert.deepEqual(list.map((cr) => terminalDnsRedirected(cr, { ...on, directBypass: false })), [false, true, true], '「直连不进内核」关着只影响直连终端')
  assert.equal(terminalDnsRedirected({ sources: ['192.168.3.50/32'], outbound: '拒绝' }, on), false, '拒绝的终端照旧按域名规则答')
  assert.deepEqual(list.map((cr) => terminalDnsRedirected(cr, { ...on, autoRedirect: false })), [false, false, false])
  assert.deepEqual(list.map((cr) => terminalDnsRedirected(cr, { ...on, splitDns: false })), [false, false, false])
  assert.deepEqual(list.map((cr) => terminalDnsRedirected(cr, { ...on, dnsMode: 'off' })), [false, false, false])
  // 「不进内核」的单独列:入口只转它发给路由器自己的查询,它自己指定的外部 DNS 交给路由器(terminalDnsLocalOnly)
  assert.deepEqual(list.map(terminalDnsLocalOnly), [false, true, false])
  assert.deepEqual(terminalDnsSources(list, on), { ips: ['192.168.3.18/32', '192.168.3.40/32'], macs: [], localIps: [], localMacs: ['aa:bb:cc:00:11:22'] })
  assert.deepEqual(terminalDnsSources(list, { ...on, dnsMode: 'hijack' }), { ips: [], macs: [], localIps: [], localMacs: ['aa:bb:cc:00:11:22'] })
})

test('「只让这些终端进内核」:名单里有按 IP 的才转名单外终端的查询(按 MAC 的走 tun 原生 include,不打标记)', () => {
  const ipList = [{ sources: ['192.168.2.10'], admit: true, match: 'ip' }]
  const macList = [{ macs: ['aa:bb:cc:00:11:22'], admit: true, match: 'mac' }]
  const on = { dnsMode: 'dnsmasq', autoRedirect: true, splitDns: true }
  assert.equal(admitDnsDirect(ipList, on), true)
  assert.equal(admitDnsDirect(ipList, { ...on, dnsMode: 'hijack' }), true)
  assert.equal(admitDnsDirect(macList, on), false)
  assert.equal(admitDnsDirect(ipList, { ...on, autoRedirect: false }), false)
  assert.equal(admitDnsDirect(ipList, { ...on, splitDns: false }), false)
  assert.equal(admitDnsDirect(ipList, { ...on, dnsMode: 'off' }), false)
  assert.equal(admitDnsDirect([], on), false)
})

test('guardTerminalRules:带来源条件的规则挂「入站不是共享网络」,普通规则拆成条件 + 动作,logical 直接追加;其余不动,没有共享入站原样返回', () => {
  const rules = [
    { source_ip_cidr: ['192.168.3.18/32'], outbound: '直连' },
    { source_mac_address: ['00:15:5d:03:0a:12'], domain_suffix: ['lan'], server: 'dns-local' },
    { type: 'logical', mode: 'and', rules: [{ source_ip_cidr: ['192.168.3.20/32'] }, { ip_version: 6 }], action: 'reject' },
    { domain_suffix: ['google.com'], outbound: '谷歌' },
    { type: 'logical', mode: 'and', rules: [{ rule_set: ['obflip-a'] }, { domain: ['x.com'] }], server: 'dns-proxy' },
  ]
  assert.equal(guardTerminalRules(rules, []), rules, '没有共享入站:原样')
  const out = guardTerminalRules(rules, ['share-home', 'share-lan'])
  const guard = { inbound: ['share-home', 'share-lan'], invert: true }
  assert.deepEqual(out[0], { type: 'logical', mode: 'and', rules: [{ source_ip_cidr: ['192.168.3.18/32'] }, guard], outbound: '直连' })
  assert.deepEqual(out[1], { type: 'logical', mode: 'and', rules: [{ source_mac_address: ['00:15:5d:03:0a:12'], domain_suffix: ['lan'] }, guard], server: 'dns-local' })
  assert.deepEqual(out[2].rules, [{ source_ip_cidr: ['192.168.3.20/32'] }, { ip_version: 6 }, guard])
  assert.equal(out[2].action, 'reject')
  assert.equal(out[3], rules[3], '不带来源条件的规则不动')
  assert.equal(out[4], rules[4])
  assert.ok(isNotShareInbound(guard))
  assert.ok(!isNotShareInbound({ inbound: ['dns-in'], invert: true }), '别的入站取反不算')
  // 读规则的各处去掉这个子条件,就是原来那条
  out.forEach((r, i) => assert.deepEqual(withoutShareGuard(r), rules[i]))
  assert.deepEqual(flattenFlipRule(out[0], {}), rules[0], 'flattenFlipRule 先去掉它再判开关')
})

test('stripShareGuardText:内核规则原文里「入站不是共享网络」那段去掉(一个入站 / 多个入站两种写法),别的不动', () => {
  // 真内核(1.14.1-openbox-tcp18)打出来的原文
  assert.equal(stripShareGuardText('source_ip_cidr=192.168.3.18/32 && !(inbound=share-lan) => route(直连)'), 'source_ip_cidr=192.168.3.18/32 => route(直连)')
  assert.equal(stripShareGuardText('source_ip_cidr=[192.168.3.18/32 192.168.3.4/32] && !(inbound=[share-home share-lan]) => route(直连)'), 'source_ip_cidr=[192.168.3.18/32 192.168.3.4/32] => route(直连)')
  assert.equal(stripShareGuardText('ip_cidr=10.0.0.0/8 && !(inbound=dns-in) => route(直连)'), 'ip_cidr=10.0.0.0/8 && !(inbound=dns-in) => route(直连)')
  assert.equal(stripShareGuardText(''), '')
})

