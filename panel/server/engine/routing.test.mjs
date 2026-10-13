import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRoute } from './routing.mjs'
import { FLIP_FALLBACK_TAG, andRule, flipFlagTag } from './flip.mjs'
import { noDomainGuard } from './routing-model.mjs'

const RULESET_DIR = '/data/rulesets'
const build = (routing, options) => buildRoute(routing, RULESET_DIR, options)

const policy = (over = {}) => ({ id: 'p1', name: '谷歌', rulesets: ['geosite-google'], ...over })
// 站点集按 IP 判的那一份:带着「连接没有域名」的前提(有域名的访问只按域名判,都没命中走兜底)
const ipOnly = (match, outbound) => andRule([match, noDomainGuard()], { outbound })

// 前五条规则(sniff / DNS 劫持两条 / 内网直连 / NTP 对时直连)和站点集无关,单独断言一次,
// 后面的用例从 P 往后看它们各自关心的那几条,免得任何一条规则挪位置就全线飘红。
const P = 5
test('固定前缀:sniff → DNS 劫持(认出是 DNS 的 + dns-in 收到的一律,GitHub #550)→ 内网直连 → NTP 对时直连(GitHub #156)', () => {
  const { route } = build({ policies: [] })
  assert.deepEqual(route.rules.slice(0, P), [
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    { inbound: ['dns-in'], action: 'hijack-dns' },
    { ip_is_private: true, outbound: 'direct' },
    { network: 'udp', port: [123], outbound: 'direct' },
  ])
  assert.equal(route.auto_detect_interface, true)
  assert.equal(route.default_domain_resolver, 'dns-direct')
})

test('没有任何站点集时,全部流量落到兜底的「其他」', () => {
  const { route } = build({ policies: [] })
  assert.deepEqual(route.rules.slice(P), [])
  assert.equal(route.final, '其他')
})

test('站点集按顺序生成规则,出站是它自己的同名 selector', () => {
  const { route } = build({
    policies: [policy(), policy({ id: 'p2', name: '微软', rulesets: ['geosite-microsoft'] })],
  })
  assert.deepEqual(route.rules.slice(P), [
    { rule_set: ['geosite-google'], outbound: '谷歌' },
    { rule_set: ['geosite-microsoft'], outbound: '微软' },
  ])
})

test('规则集链接:路由规则按形状表引用域名 / IP 两份 .srs,两份都登记进 rule_set 清单', () => {
  const routing = { policies: [policy({ rulesets: [], ruleUrls: ['https://x.test/Check.list'] })] }
  const tag = 'list-' + (() => { let h = 0x811c9dc5; for (const ch of 'https://x.test/Check.list') { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') })()
  const both = build(routing, { ruleLists: { [tag]: { domain: true, ip: true } } })
  // 域名那份一条;IP 那份一条,只管没有域名的连接
  assert.deepEqual(both.route.rules.slice(P), [{ rule_set: [tag], outbound: '谷歌' }, ipOnly({ rule_set: [`${tag}-ip`] }, '谷歌')])
  assert.deepEqual(both.route.rule_set.map((s) => s.path), [`${RULESET_DIR}/${tag}.srs`, `${RULESET_DIR}/${tag}-ip.srs`])
  const ipShape = build(routing, { ruleLists: { [tag]: { domain: false, ip: true } } })
  assert.deepEqual(ipShape.route.rules[P], ipOnly({ rule_set: [`${tag}-ip`] }, '谷歌'))
  // 没有形状表(预览、还没拉过):按老样子引用一份
  const unknown = build(routing)
  assert.deepEqual(unknown.route.rules[P], { rule_set: [tag], outbound: '谷歌' })
})

test('一个站点集的五类条件:看域名的在前(规则集一条、手写域名一条),看 IP 的在后且只管没有域名的连接(geoip 一条、IP 段一条),同一出口（1.14 起规则集不再稳定地和同条里的域名 / IP「或」）', () => {
  const { route, rulesetTags } = build({
    policies: [
      policy({
        rulesets: ['geosite-google', 'geoip-google'],
        domain: ['example.com'],
        domainSuffix: ['google.com'],
        domainKeyword: ['gstatic'],
        ipCidr: ['8.8.8.8/32'],
      }),
    ],
  })
  assert.deepEqual(route.rules.slice(P), [
    { rule_set: ['geosite-google'], outbound: '谷歌' },
    { domain: ['example.com'], domain_suffix: ['google.com'], domain_keyword: ['gstatic'], outbound: '谷歌' },
    // 有域名的访问(嗅探到的、FakeIP 找回的、DNS 反查记下的)不看这两条:域名没命中就落到兜底,不会被 IP 抢走
    ipOnly({ rule_set: ['geoip-google'] }, '谷歌'),
    ipOnly({ ip_cidr: ['8.8.8.8/32'] }, '谷歌'),
  ])
  // 「有域名」= 至少一个字母、没有冒号:IP 字面量(HTTP Host 直接写 IP 时嗅探出来的)不算
  const re = new RegExp(noDomainGuard().domain_regex[0])
  for (const d of ['brainhost.ai', 'nas', 'xn--fiq228c.example', '123.com']) assert.ok(re.test(d), d)
  for (const d of ['104.21.17.131', '2001:db8::1', '::1', '']) assert.ok(!re.test(d), d)
  // 规则集要登记进 rule_set 清单,否则部署时不会去下载对应的 .srs
  assert.ok(rulesetTags.has('geosite-google') && rulesetTags.has('geoip-google'))
})

test('没有任何规则的站点集被丢掉——空条件规则在内核里等于"全部命中",会盖住后面所有规则', () => {
  const { route } = build({ policies: [{ id: 'x', name: '空的' }] })
  assert.deepEqual(route.rules.slice(P), [])
})

test('名字叫「其他」的站点集被丢掉:那是兜底的保留名,重名会生成两个同名出站', () => {
  const { route } = build({ policies: [policy({ name: '其他' })] })
  assert.deepEqual(route.rules.slice(P), [])
  assert.equal(route.final, '其他')
})

test('dnsmasq 模式:被 auto_redirect 改写到 tun 网段:53 的局域网 DNS 交回本机 dnsmasq,排在防回环 reject 之前', () => {
  const { route } = build({ policies: [] }, { dnsMode: 'dnsmasq', tunCidrs: ['172.19.0.0/30'], dnsmasqTag: 'dnsmasq' })
  assert.deepEqual(route.rules[1], { inbound: ['dns-in'], action: 'hijack-dns' })
  assert.deepEqual(route.rules[2], {
    ip_cidr: ['172.19.0.0/30'], port: [53], action: 'route', outbound: 'dnsmasq', override_address: '127.0.0.1',
  })
  assert.deepEqual(route.rules[3], { ip_cidr: ['172.19.0.0/30'], action: 'reject' })
  assert.ok(route.rules[4].ip_is_private)
  // hijack 模式靠 protocol:dns 接住,不需要这条
  const h = build({ policies: [] }, { dnsMode: 'hijack', tunCidrs: ['172.19.0.0/30'], dnsmasqTag: 'dnsmasq' })
  assert.ok(!h.route.rules.some((r) => r.override_address))
})

test('dnsMode=off 时只劫持 dns-in 自己收到的查询（AdGuard 等主动指过来的）,不改写别的 DNS,也没有回交规则', () => {
  const { route } = build({ policies: [] }, { dnsMode: 'off', tunCidrs: ['172.19.0.0/30'], dnsmasqTag: 'dnsmasq' })
  assert.deepEqual(route.rules.filter((r) => r.action === 'hijack-dns'), [{ inbound: ['dns-in'], action: 'hijack-dns' }])
  assert.ok(!route.rules.some((r) => r.protocol === 'dns'))
  assert.ok(!route.rules.some((r) => r.override_address))
})

test('dnsMode=hijack 时 dns-in(和名单外终端的 dns-in-direct)收到的连接一律劫持(GitHub #550):不发 DNS 的空连接嗅探不出 DNS,以前落到内网直连、拨回自己 :7853 无限自环', () => {
  const { route } = build({ policies: [] }, { dnsMode: 'hijack' })
  const hijacks = route.rules.filter((r) => r.action === 'hijack-dns')
  assert.deepEqual(hijacks, [{ protocol: 'dns', action: 'hijack-dns' }, { inbound: ['dns-in'], action: 'hijack-dns' }])
  // 排在内网直连前面:连 <路由器 IP>:7853 的连接轮不到 ip_is_private → 直连
  assert.ok(route.rules.findIndex((r) => r.inbound) < route.rules.findIndex((r) => r.ip_is_private))
  const admit = build({ policies: [] }, { dnsMode: 'hijack', dnsDirectInbound: 'dns-in-direct' })
  assert.ok(admit.route.rules.some((r) => r.action === 'hijack-dns' && JSON.stringify(r.inbound) === JSON.stringify(['dns-in', 'dns-in-direct'])))
})

test('dnsMode=dnsmasq 时只劫持 dns-in,避免 tun→dns-in 自环', () => {
  const { route } = build({ policies: [] }, { dnsMode: 'dnsmasq' })
  assert.deepEqual(route.rules[1], { inbound: ['dns-in'], action: 'hijack-dns' })
  assert.ok(!route.rules.some((r) => r.protocol === 'dns'))
})

// -------- 地区层退役:老档案迁移(行为不变) --------

test('地区档案:选中的地区按动作拆成站点集,接在用户的站点集后面', () => {
  const { route } = build({
    policies: [policy()],
    regions: [{
      id: 'cn',
      name: '中国大陆',
      catchAll: 'proxy',
      rules: [
        { type: 'geosite', value: 'cn', action: 'direct' },
        { type: 'geoip', value: 'cn', action: 'direct' },
      ],
    }],
    regionId: 'cn',
  })
  assert.deepEqual(route.rules.slice(P), [
    { rule_set: ['geosite-google'], outbound: '谷歌' },
    { rule_set: ['geosite-cn'], outbound: '中国大陆·直连' },
    ipOnly({ rule_set: ['geoip-cn'] }, '中国大陆·直连'),
  ])
  // 兜底"走代理"这件事变成兜底站点集的默认选中项,规则本身仍然是 final → 其他
  assert.equal(route.final, '其他')
})

test('地区档案:一条地区里既有直连又有代理的规则时,拆成两个站点集', () => {
  const { route } = build({
    policies: [],
    regions: [{
      id: 'jp',
      name: '日本',
      catchAll: 'direct',
      rules: [
        { type: 'geosite', value: 'jp', action: 'direct' },
        { type: 'geosite', value: 'cn', action: 'proxy' },
      ],
    }],
    regionId: 'jp',
  })
  assert.deepEqual(route.rules.slice(P), [
    { rule_set: ['geosite-jp'], outbound: '日本·直连' },
    { rule_set: ['geosite-cn'], outbound: '日本·代理' },
  ])
})

test('已经迁过的档案（有 fallbackDefault）不再翻译地区,免得每次读都多长出两个站点集', () => {
  const { route } = build({
    policies: [policy()],
    fallbackDefault: 'proxy',
    regions: [{ id: 'cn', name: '中国大陆', catchAll: 'proxy', rules: [{ type: 'geosite', value: 'cn', action: 'direct' }] }],
    regionId: 'cn',
  })
  assert.deepEqual(route.rules.slice(P), [{ rule_set: ['geosite-google'], outbound: '谷歌' }])
})

test('更老的档案:categories 变成站点集', () => {
  const { route } = build({
    proxyTag: 'PROXY',
    categories: [{ ruleset: 'geosite-netflix', target: '香港-自动' }],
    directRulesets: ['geosite-cn', 'geoip-cn'],
    fallback: 'PROXY',
  })
  assert.deepEqual(route.rules[P], { rule_set: ['geosite-netflix'], outbound: 'geosite-netflix' })
})

test('更老的档案:始终直连里非中国的规则集变成一个默认直连的站点集', () => {
  const { route } = build({ directRulesets: ['geosite-cn', 'geosite-private'], fallback: 'PROXY' })
  assert.ok(route.rules.some((r) => r.outbound === '始终直连'))
})

test('订阅/节点站点直连:紧跟在 ip_is_private 和 NTP 直连之后,域名进 domain、IP 进 ip_cidr', () => {
  const { route } = buildRoute({ policies: [{ id: 'a', name: 'A', rulesets: ['geosite-google'] }], fallbackDefault: 'direct' }, '/r', {
    directTag: '直连',
    directHosts: { domains: ['hiddfy.example.xyz', 'sub.example.com'], cidrs: ['1.2.3.4/32'] },
  })
  const i = route.rules.findIndex((r) => r.ip_is_private)
  assert.deepEqual(route.rules[i + 2], { outbound: '直连', domain: ['hiddfy.example.xyz', 'sub.example.com'], ip_cidr: ['1.2.3.4/32'] })
  assert.equal(route.rules[i + 3].outbound, 'A')
})

test('终端分流:来源网段的流量走指定出口,排在直连站点之后、站点集之前;出口不存在的丢掉', () => {
  const { route } = build({ policies: [policy()] }, {
    directHosts: { domains: ['sub.example.com'], cidrs: [] },
    clientRoutes: [
      { sources: ['10.0.0.5/32'], outbound: '香港-自动' },
      { sources: ['10.0.0.6/32'], outbound: '不存在的组' },
    ],
    knownOutbounds: new Set(['direct', '香港-自动', '谷歌']),
  })
  const i = route.rules.findIndex((r) => r.source_ip_cidr)
  const dh = route.rules.findIndex((r) => r.domain && r.domain.includes('sub.example.com'))
  const pol = route.rules.findIndex((r) => r.outbound === '谷歌')
  assert.ok(i > dh && i < pol, `client=${i} directHosts=${dh} policy=${pol}`)
  assert.deepEqual(route.rules[i], { source_ip_cidr: ['10.0.0.5/32'], outbound: '香港-自动' })
  assert.equal(route.rules.filter((r) => r.source_ip_cidr).length, 1)
})

// ---------- 前置自定义分流:一行一条规则,一行一个出口 ----------
const customRules = (...rules) => ({ custom: { rules } })
const R = (over = {}) => ({ type: 'domainSuffix', value: 'openai.com', outbound: 'VW | 香港-01', ...over })

test('每行各走各的出口,按行的先后进配置', () => {
  const { route } = build(
    customRules(R(), R({ value: 'netflix.com', outbound: 'VW | 美国-01' })),
    { knownOutbounds: new Set(['VW | 香港-01', 'VW | 美国-01']) },
  )
  const mine = route.rules.filter((r) => r.domain_suffix)
  assert.deepEqual(mine, [
    { domain_suffix: ['openai.com'], outbound: 'VW | 香港-01' },
    { domain_suffix: ['netflix.com'], outbound: 'VW | 美国-01' },
  ])
})

test('优先级最高:只让 tun 防回环走在前面,内网直连 / 直连站点 / 终端分流 / 站点集全在它之后', () => {
  const { route } = build(
    { ...customRules(R()), policies: [policy()] },
    {
      knownOutbounds: new Set(['VW | 香港-01', 'direct']),
      tunCidrs: ['172.19.0.0/30'],
      directHosts: { domains: ['node.example.com'], cidrs: [] },
      clientRoutes: [{ sources: ['192.168.3.9/32'], outbound: 'direct' }],
    },
  )
  const at = (pred) => route.rules.findIndex(pred)
  const loop = at((r) => r.action === 'reject' && r.ip_cidr)
  const mine = at((r) => r.domain_suffix && r.domain_suffix[0] === 'openai.com')
  const priv = at((r) => r.ip_is_private)
  const hosts = at((r) => r.domain && r.domain.includes('node.example.com'))
  const client = at((r) => r.source_ip_cidr)
  const site = at((r) => r.outbound === '谷歌')
  assert.ok(loop >= 0 && loop < mine, `防回环必须在最前:${JSON.stringify(route.rules)}`)
  assert.ok(
    mine < priv && priv < hosts && hosts < client && client < site,
    JSON.stringify(route.rules.map((r) => JSON.stringify(r))),
  )
})

test('NTP 对时直连排在前置自定义分流后面:用户写一条端口 123 走节点就能盖过它(GitHub #156)', () => {
  const { route } = build(customRules(R({ type: 'port', value: '123', outbound: 'HK' })), { knownOutbounds: new Set(['HK']) })
  const mine = route.rules.findIndex((r) => r.outbound === 'HK' && r.port && r.port[0] === 123)
  const ntp = route.rules.findIndex((r) => r.network === 'udp' && r.port && r.port[0] === 123 && r.outbound === 'direct')
  assert.ok(mine >= 0 && ntp > mine, JSON.stringify(route.rules))
})

test('排在 ip_is_private 之前:内网段也能被强制送到某个节点（经 WireGuard 访问对端局域网;IP 只管 IP,按域名访问要写域名行）', () => {
  const { route } = build(
    customRules(R({ type: 'ipCidr', value: '10.8.0.0/24', outbound: 'wg-peer' }), R({ type: 'domainSuffix', value: 'nas.peer', outbound: 'wg-peer' })),
    { knownOutbounds: new Set(['wg-peer']), tunCidrs: ['172.19.0.0/30'] },
  )
  const mine = route.rules.findIndex((r) => r.outbound === 'wg-peer' && r.type === 'logical')
  const byName = route.rules.findIndex((r) => r.outbound === 'wg-peer' && r.domain_suffix)
  const priv = route.rules.findIndex((r) => r.ip_is_private)
  assert.ok(mine >= 0 && mine < priv && byName < priv, JSON.stringify(route.rules))
  assert.deepEqual(route.rules[mine], ipOnly({ ip_cidr: ['10.8.0.0/24'] }, 'wg-peer'))
})

test('四种条件各自对到内核字段;geosite / 规则集链接进 rule_set 并登记下载', () => {
  const known = new Set(['HK'])
  const cases = [
    [R({ type: 'domain', value: 'a.com', outbound: 'HK' }), { domain: ['a.com'], outbound: 'HK' }],
    [R({ type: 'domainKeyword', value: 'porn', outbound: 'HK' }), { domain_keyword: ['porn'], outbound: 'HK' }],
    // IP 只管 IP:IP 段 / geoip 那几档带「连接没有域名」的前提
    [R({ type: 'ipCidr', value: '1.2.3.0/24', outbound: 'HK' }), ipOnly({ ip_cidr: ['1.2.3.0/24'] }, 'HK')],
    [R({ type: 'geoip', value: 'telegram', outbound: 'HK' }), ipOnly({ rule_set: ['geoip-telegram'] }, 'HK')],
    [R({ type: 'ruleset', value: 'geoip-netflix', outbound: 'HK' }), ipOnly({ rule_set: ['geoip-netflix'] }, 'HK')],
    [R({ type: 'geosite', value: 'openai', outbound: 'HK' }), { rule_set: ['geosite-openai'], outbound: 'HK' }],
    // 端口(放行 WireGuard 之类):单个进 port,范围进 port_range,TCP / UDP 都算
    [R({ type: 'port', value: '51820, 1000-2000', outbound: 'HK' }), { port: [51820], port_range: ['1000:2000'], outbound: 'HK' }],
  ]
  for (const [rule, expected] of cases) {
    const { route, rulesetTags } = build(customRules(rule), { knownOutbounds: known })
    const got = route.rules.find((r) => r.outbound === 'HK')
    assert.deepEqual(got, expected, JSON.stringify(rule))
    const tags = expected.rule_set || (expected.rules && expected.rules[0].rule_set)
    if (tags) assert.ok(rulesetTags.has(tags[0]))
  }
  // 规则集链接:域名那份一条、IP 那份一条(只管没有域名的连接),都登记下载
  const url = 'https://x.test/Check.list'
  const tag = 'list-' + (() => { let h = 0x811c9dc5; for (const ch of url) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') })()
  const both = build(customRules(R({ type: 'ruleUrl', value: url, outbound: 'HK' })), { knownOutbounds: known, ruleLists: { [tag]: { domain: true, ip: true } } })
  assert.deepEqual(both.route.rules.filter((r) => r.outbound === 'HK'), [{ rule_set: [tag], outbound: 'HK' }, ipOnly({ rule_set: [`${tag}-ip`] }, 'HK')])
  assert.ok(both.rulesetTags.has(tag) && both.rulesetTags.has(`${tag}-ip`))
})

test('direct / block 占位换算成内置出站当时的名字', () => {
  const opts = { directTag: '直连', blockTag: '拒绝', knownOutbounds: new Set(['直连', '拒绝']) }
  const { route } = build(customRules(R({ outbound: 'direct' }), R({ value: 'ad.com', outbound: 'block' })), opts)
  assert.deepEqual(route.rules.filter((r) => r.domain_suffix), [
    { domain_suffix: ['openai.com'], outbound: '直连' },
    { domain_suffix: ['ad.com'], outbound: '拒绝' },
  ])
})

test('出口不在配置里的那一行跳过,其余行照常生效（内核 outbound not found 起不来）', () => {
  const { route } = build(
    customRules(R({ outbound: '已删掉的节点' }), R({ value: 'ok.com', outbound: 'HK' })),
    { knownOutbounds: new Set(['HK']) },
  )
  assert.deepEqual(route.rules.filter((r) => r.domain_suffix), [{ domain_suffix: ['ok.com'], outbound: 'HK' }])
})

test('停用、或一行都没有,整块不出规则', () => {
  const known = new Set(['VW | 香港-01'])
  assert.ok(!build({ custom: { enabled: false, rules: [R()] } }, { knownOutbounds: known }).route.rules.some((r) => r.domain_suffix))
  assert.ok(!build({ custom: { rules: [] } }, { knownOutbounds: known }).route.rules.some((r) => r.domain_suffix))
})

test('值或出口空着的行在归一化时就被丢掉（空条件的规则等价于全部命中）', () => {
  const { route } = build(
    customRules(R({ value: '' }), R({ outbound: '' }), R({ value: 'ok.com' })),
    { knownOutbounds: new Set(['VW | 香港-01']) },
  )
  assert.deepEqual(route.rules.filter((r) => r.domain_suffix), [
    { domain_suffix: ['ok.com'], outbound: 'VW | 香港-01' },
  ])
})

test('IPv6 分层 · 代理 v6 降为 IPv4:出口是节点组的规则(类别不会变)前面直接插 v6 拒绝;出口是站点集的规则前面恒定插一条挂着它开关的 v6 拒绝(此刻直连的也插,开关 OFF 时不命中);兜底同理', () => {
  const rejectV6For = (tag) => tag !== 'direct' && tag !== 'block' && tag !== '国内'
  const { route } = build({
    policies: [
      { id: 'g', name: '谷歌', rulesets: ['geosite-google'], ipCidr: ['8.8.8.0/24'] },
      { id: 'cn', name: '国内', rulesets: ['geosite-cn'], default: 'direct' },
    ],
    custom: { rules: [{ type: 'domainSuffix', value: 'x.test', outbound: '香港-自动' }, { type: 'domainSuffix', value: 'y.test', outbound: 'direct' }] },
  }, { rejectV6For, clientRoutes: [{ sources: ['192.168.1.9/32'], outbound: '香港-自动' }] })
  const G = flipFlagTag({ id: 'g' })
  const CN = flipFlagTag({ id: 'cn' })
  const v6 = (match, flag) => andRule([match, { rule_set: [flag] }, { ip_version: 6 }], { action: 'reject' })
  const rules = route.rules.slice(3)   // 跳过 sniff / 两条 hijack-dns(前置自定义分流排在 ip_is_private 前面)
  // 前置自定义分流(出口是节点组 / 直连,类别定死):代理行前有 v6 拒绝,直连行没有
  assert.deepEqual(rules[0], { domain_suffix: ['x.test'], ip_version: 6, action: 'reject' })
  assert.deepEqual(rules[1], { domain_suffix: ['x.test'], outbound: '香港-自动' })
  assert.deepEqual(rules[2], { domain_suffix: ['y.test'], outbound: 'direct' })
  // 之后的顺序:ip_is_private → 终端分流 → 站点集
  const i = rules.findIndex((r) => r.source_ip_cidr && r.action === 'reject')
  assert.deepEqual(rules[i], { source_ip_cidr: ['192.168.1.9/32'], ip_version: 6, action: 'reject' })
  assert.deepEqual(rules[i + 1], { source_ip_cidr: ['192.168.1.9/32'], outbound: '香港-自动' })
  // 站点集:规则集 + IP 段拆成两条,每一条前面各插一条「同条件 + 开关 + v6」的拒绝;IP 段那条和它的拒绝都带
  // 「连接没有域名」的前提(有域名的连接按域名判走直连时,不能因为地址落在走代理的段里被拒)
  const g = rules.findIndex((r) => r.outbound === '谷歌')
  assert.deepEqual(rules[g - 1], v6({ rule_set: ['geosite-google'] }, G))
  assert.deepEqual(rules[g], { rule_set: ['geosite-google'], outbound: '谷歌' })
  assert.deepEqual(rules[g + 1], andRule([{ ip_cidr: ['8.8.8.0/24'] }, noDomainGuard(), { rule_set: [G] }, { ip_version: 6 }], { action: 'reject' }))
  assert.deepEqual(rules[g + 2], ipOnly({ ip_cidr: ['8.8.8.0/24'] }, '谷歌'))
  // 此刻走直连的「国内」也恒定插:它的开关是 OFF,这条不命中;翻到代理时只改写开关文件
  assert.deepEqual(rules[g + 3], v6({ rule_set: ['geosite-cn'] }, CN))
  assert.deepEqual(rules[g + 4], { rule_set: ['geosite-cn'], outbound: '国内' })
  // 兜底:收尾一条挂着兜底开关的 v6 拒绝
  assert.deepEqual(rules.at(-1), andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, { ip_version: 6 }], { action: 'reject' }))
  // 没开:一条 ip_version 都没有(成对规则里也没有)
  const plain = build({ policies: [{ id: 'g', name: '谷歌', rulesets: ['geosite-google'] }] })
  assert.ok(!JSON.stringify(plain.route.rules).includes('ip_version'))
})

test('屏蔽 QUIC(#163):出口是节点组的规则前面直接插 UDP 443 拒绝;出口是站点集的恒定插一条挂着开关的;直连出口、自己带端口条件的规则不插;兜底同理;和 v6 拒绝可以叠加', () => {
  const isProxy = (tag) => tag !== 'direct' && tag !== 'block' && tag !== '国内'
  const routing = {
    policies: [
      { id: 'g', name: '谷歌', rulesets: ['geosite-google'] },
      { id: 'cn', name: '国内', rulesets: ['geosite-cn'], default: 'direct' },
    ],
    custom: { rules: [{ type: 'domainSuffix', value: 'x.test', outbound: '香港-自动' }, { type: 'port', value: '51820', outbound: '香港-自动' }, { type: 'domainSuffix', value: 'y.test', outbound: 'direct' }] },
  }
  const G = flipFlagTag({ id: 'g' })
  const CN = flipFlagTag({ id: 'cn' })
  const QUIC = { network: 'udp', port: 443 }
  const quic = (match, flag) => andRule([match, { rule_set: [flag] }, QUIC], { action: 'reject' })
  const { route } = build(routing, { rejectQuicFor: isProxy })
  const rules = route.rules.slice(3)   // 跳过 sniff / 两条 hijack-dns
  assert.deepEqual(rules[0], { domain_suffix: ['x.test'], network: 'udp', port: 443, action: 'reject' })
  assert.deepEqual(rules[1], { domain_suffix: ['x.test'], outbound: '香港-自动' })
  // 用户按端口写的规则原样:不叠 443
  assert.deepEqual(rules[2], { port: [51820], outbound: '香港-自动' })
  assert.deepEqual(rules[3], { domain_suffix: ['y.test'], outbound: 'direct' })
  const g = rules.findIndex((r) => r.outbound === '谷歌')
  assert.deepEqual(rules[g - 1], quic({ rule_set: ['geosite-google'] }, G))
  assert.deepEqual(rules[g + 1], quic({ rule_set: ['geosite-cn'] }, CN), '此刻直连的站点集也恒定插,开关 OFF 时不命中')
  assert.deepEqual(rules[g + 2], { rule_set: ['geosite-cn'], outbound: '国内' })
  assert.deepEqual(rules.at(-1), andRule([{ rule_set: [FLIP_FALLBACK_TAG] }, QUIC], { action: 'reject' }), '兜底:收尾一条,挂兜底的开关')
  // 和「代理 v6 降为 IPv4」一起开:先 v6 拒绝、再 QUIC 拒绝、再规则本身
  const both = build(routing, { rejectQuicFor: isProxy, rejectV6For: isProxy }).route.rules.slice(3)
  assert.deepEqual(both.slice(0, 3), [
    { domain_suffix: ['x.test'], ip_version: 6, action: 'reject' },
    { domain_suffix: ['x.test'], network: 'udp', port: 443, action: 'reject' },
    { domain_suffix: ['x.test'], outbound: '香港-自动' },
  ])
  const bg = both.findIndex((r) => r.outbound === '谷歌')
  assert.deepEqual(both.slice(bg - 2, bg), [andRule([{ rule_set: ['geosite-google'] }, { rule_set: [G] }, { ip_version: 6 }], { action: 'reject' }), quic({ rule_set: ['geosite-google'] }, G)])
  // 没开:一条都没有(成对规则里也没有)
  assert.ok(!JSON.stringify(build(routing).route.rules).includes('"port":443'))
})

test('IP 只管 IP、域名只管域名,不管是哪里的分流(用户 2026-09-26,brainhost.ai 没进任何名单,却被「国外」的 geoip-cloudflare 抢去走节点):站点集和前置自定义分流的 IP 条件都只管没有域名的连接,QUIC 拒绝跟着带前提;内置的私网直连不带', () => {
  const G = flipFlagTag({ id: 'abroad' })
  const QUIC = { network: 'udp', port: 443 }
  const { route } = build({
    policies: [{ id: 'abroad', name: '国外', rulesets: ['geosite-gfw', 'geoip-cloudflare'], default: 'HK' }],
    custom: { rules: [{ type: 'ipCidr', value: '10.8.0.0/16', outbound: 'HK' }] },
  }, { rejectQuicFor: (t) => t !== 'direct' })
  const rules = route.rules
  // 前置自定义分流的 IP 行:一样只管没有域名的连接,前面的 QUIC 拒绝也带前提
  const c = rules.findIndex((r) => r.outbound === 'HK')
  assert.deepEqual(rules.slice(c - 1, c + 1), [
    andRule([{ ip_cidr: ['10.8.0.0/16'] }, noDomainGuard(), QUIC], { action: 'reject' }),
    ipOnly({ ip_cidr: ['10.8.0.0/16'] }, 'HK'),
  ])
  // 内置的私网直连是保命规则,不是分流:对所有连接生效
  assert.ok(rules.some((r) => r.ip_is_private === true && r.outbound === 'direct'))
  const i = rules.findIndex((r) => r.outbound === '国外')
  assert.deepEqual(rules.slice(i - 1, i + 3), [
    andRule([{ rule_set: ['geosite-gfw'] }, { rule_set: [G] }, QUIC], { action: 'reject' }),
    { rule_set: ['geosite-gfw'], outbound: '国外' },
    andRule([{ rule_set: ['geoip-cloudflare'] }, noDomainGuard(), { rule_set: [G] }, QUIC], { action: 'reject' }),
    ipOnly({ rule_set: ['geoip-cloudflare'] }, '国外'),
  ])
  // 域名一条都没命中的访问落到这里:兜底
  assert.equal(route.final, '其他')
})

test('预解析（第五轮 任务 4）:只有当按目标 IP 判的规则排在某条域名规则前面时,才给后面的域名规则各插一条同条件的 resolve,用它自己的解析器;没有这种前后关系一条都不插', () => {
  const resolvers = { policies: { 谷歌: 'dns-policy-0', 国内: 'dns-direct', 纯IP: undefined }, custom: [null, 'dns-custom-0', 'dns-direct'], clients: [{ sources: ['192.168.1.9/32'], server: 'dns-client-0' }], fallback: 'dns-proxy' }
  // 前置自定义分流:第 1 行 ip_cidr(IP 规则)→ 后面的域名行、终端分流、站点集、兜底都要预解析
  const { route } = build({
    policies: [
      { id: 'g', name: '谷歌', rulesets: ['geosite-google'], domainSuffix: ['google.com'] },
      { id: 'ip', name: '纯IP', rulesets: ['geoip-telegram'] },
      { id: 'cn', name: '国内', rulesets: ['geosite-cn', 'geoip-cn'], default: 'direct' },
    ],
    custom: { rules: [{ type: 'ipCidr', value: '1.2.3.4/32', outbound: 'block' }, { type: 'domainSuffix', value: 'x.test', outbound: '香港-自动' }, { type: 'domainSuffix', value: 'y.test', outbound: 'direct' }] },
  }, { resolvers, clientRoutes: [{ sources: ['192.168.1.9/32'], outbound: '香港-自动' }] })
  const pre = route.rules.filter((r) => r.action === 'resolve')
  assert.deepEqual(pre, [
    { domain_suffix: ['x.test'], action: 'resolve', server: 'dns-custom-0' },
    { domain_suffix: ['y.test'], action: 'resolve', server: 'dns-direct' },
    { source_ip_cidr: ['192.168.1.9/32'], action: 'resolve', server: 'dns-client-0' },
    { rule_set: ['geosite-google'], action: 'resolve', server: 'dns-policy-0' },
    { domain_suffix: ['google.com'], action: 'resolve', server: 'dns-policy-0' },
    { rule_set: ['geosite-cn'], action: 'resolve', server: 'dns-direct' },
    { action: 'resolve', server: 'dns-proxy' },
  ])
  // 预解析排在所有分流规则前面(sniff / DNS 劫持之后、前置自定义分流之前)
  const firstResolve = route.rules.findIndex((r) => r.action === 'resolve')
  const firstCustom = route.rules.findIndex((r) => r.domain_suffix && r.outbound)
  assert.ok(firstResolve > 0 && firstResolve < firstCustom)
  // 原来的分流规则一条不少、顺序不变
  assert.deepEqual(route.rules.filter((r) => r.outbound && r.domain_suffix).map((r) => r.outbound), ['香港-自动', 'direct', '谷歌'])

  // IP 规则在站点集中间:只有它后面的域名站点集要预解析;前面的不用
  const mid = build({ policies: [
    { id: 'g', name: '谷歌', rulesets: ['geosite-google'] },
    { id: 'ip', name: '纯IP', rulesets: ['geoip-telegram'] },
    { id: 'cn', name: '国内', rulesets: ['geosite-cn'], default: 'direct' },
  ] }, { resolvers: { policies: { 谷歌: 'dns-policy-0', 国内: 'dns-direct' }, custom: [], clients: [], fallback: 'dns-direct' } })
  assert.deepEqual(mid.route.rules.filter((r) => r.action === 'resolve'), [
    { rule_set: ['geosite-cn'], action: 'resolve', server: 'dns-direct' },
    { action: 'resolve', server: 'dns-direct' },
  ])
  // 没有任何 IP 规则:一条都不插
  const none = build({ policies: [{ id: 'g', name: '谷歌', rulesets: ['geosite-google'] }, { id: 'cn', name: '国内', rulesets: ['geosite-cn'], default: 'direct' }] }, { resolvers: { policies: { 谷歌: 'dns-policy-0', 国内: 'dns-direct' }, custom: [], clients: [], fallback: 'dns-direct' } })
  assert.ok(!none.route.rules.some((r) => r.action === 'resolve'))
  // IP 规则在最后:前面的域名规则不需要
  const last = build({ policies: [{ id: 'g', name: '谷歌', rulesets: ['geosite-google'] }, { id: 'cn', name: '国内', rulesets: ['geoip-cn'], default: 'direct' }] }, { resolvers: { policies: { 谷歌: 'dns-policy-0' }, custom: [], clients: [], fallback: 'dns-direct' } })
  assert.deepEqual(last.route.rules.filter((r) => r.action === 'resolve'), [{ action: 'resolve', server: 'dns-direct' }])
  // 没给解析器映射(老调用方 / 预览):不插
  assert.ok(!build({ policies: [{ id: 'ip', name: '纯IP', rulesets: ['geoip-x'] }, { id: 'g', name: '谷歌', rulesets: ['geosite-google'] }] }).route.rules.some((r) => r.action === 'resolve'))
})

test('终端分流「直连」:首包预判照规则放行——bypass 规则排在 sniff 前面,排在它前面、会把连接送去别处的前置自定义分流按 IP / 规则集 / 端口取反挂上', () => {
  const routing = {
    policies: [policy({ name: '谷歌', default: '所有-自动' })],
    custom: {
      rules: [
        { type: 'ipCidr', value: '10.77.0.0/16', outbound: '香港-自动' },
        { type: 'geoip', value: 'telegram', outbound: '香港-自动' },
        { type: 'port', value: '51820, 6000-6100', outbound: '香港-自动' },
        { type: 'domainSuffix', value: 'x.test', outbound: '香港-自动' },   // 按域名的:预判时只有 IP,不用挂
        { type: 'ipCidr', value: '1.2.3.0/24', outbound: 'direct' },        // 直连的行本来就直连,不用挂
        { type: 'ipCidr', value: '5.6.7.0/24', outbound: '已删掉的节点' },  // 出口不存在:配置里没有这一行,也不挂
        { type: 'ipCidr', value: '9.9.9.0/24', outbound: 'block' },         // 拒绝的行照样要进内核
      ],
    },
  }
  const { route } = build(routing, {
    preMatchBypass: true,
    tunCidrs: ['172.19.0.0/30'],
    knownOutbounds: new Set(['香港-自动', 'direct', 'block', '谷歌', '所有-自动']),
    clientRoutes: [
      { match: 'ip', sources: ['192.168.3.18/32', '192.168.3.35/32'], outbound: 'direct' },
      { match: 'mac', sources: [], macs: ['00:15:5d:03:0a:12'], outbound: 'direct' },
      { match: 'ip', sources: ['192.168.3.40/32'], outbound: '香港-自动' },          // 走代理的终端整台进内核
      { match: 'ip', sources: ['192.168.3.50/32'], outbound: 'direct', bypass: true }, // 不进内核的在入口打标记,不归这里
    ],
  })
  const keep = [
    { ip_cidr: ['172.19.0.0/30', '10.77.0.0/16', '9.9.9.0/24'], invert: true },
    { rule_set: ['geoip-telegram'], invert: true },
    { port: [53, 51820], port_range: ['6000:6100'], invert: true },
  ]
  assert.deepEqual(route.rules.slice(0, 3), [
    andRule([{ source_ip_cidr: ['192.168.3.18/32', '192.168.3.35/32'] }, ...keep], { action: 'bypass' }),
    andRule([{ source_mac_address: ['00:15:5d:03:0a:12'] }, ...keep], { action: 'bypass' }),
    { action: 'sniff' },
  ])
  // 正常路由时不带出口的 bypass 被内核跳过,后面那条「来源 → 直连」照旧兜着
  assert.ok(route.rules.some((r) => r.source_ip_cidr && r.source_ip_cidr[0] === '192.168.3.18/32' && r.outbound === 'direct'))
  // 引用到的规则集都在 rule_set 里声明过
  assert.ok(route.rule_set.some((r) => r.tag === 'geoip-telegram'))
})

test('终端分流「直连」首包预判:没开(「直连不进内核」关掉 / 纯 tun)、或者没有直连终端时一条都不写', () => {
  const clientRoutes = [{ match: 'ip', sources: ['192.168.3.18/32'], outbound: 'direct' }]
  assert.deepEqual(build({ policies: [] }, { clientRoutes }).route.rules[0], { action: 'sniff' })
  assert.deepEqual(build({ policies: [] }, { preMatchBypass: true, clientRoutes: [{ match: 'ip', sources: ['192.168.3.40/32'], outbound: '香港-自动' }], knownOutbounds: new Set(['香港-自动', 'direct']) }).route.rules[0], { action: 'sniff' })
  // 没有前置自定义分流时只挂内置的:DNS 端口(和 tun 防回环网段,给了才挂)
  assert.deepEqual(build({ policies: [] }, { preMatchBypass: true, clientRoutes }).route.rules[0],
    andRule([{ source_ip_cidr: ['192.168.3.18/32'] }, { port: [53], invert: true }], { action: 'bypass' }))
})

test('订阅和节点站点直连的地址:首包预判照规则放行,排在直连终端那条前面,取反的条件和终端的一样', () => {
  const { route } = build({
    policies: [],
    custom: { rules: [{ type: 'ipCidr', value: '10.77.0.0/16', outbound: '香港-自动' }] },
  }, {
    preMatchBypass: true,
    tunCidrs: ['172.19.0.0/30'],
    knownOutbounds: new Set(['香港-自动', 'direct', 'block']),
    directHosts: { domains: ['vmiss-cn2.angeworld.top'], cidrs: ['38.207.169.210/32'] },
    clientRoutes: [{ match: 'ip', sources: ['192.168.3.18/32'], outbound: 'direct' }],
  })
  const keep = [{ ip_cidr: ['172.19.0.0/30', '10.77.0.0/16'], invert: true }, { port: [53], invert: true }]
  assert.deepEqual(route.rules.slice(0, 3), [
    andRule([{ ip_cidr: ['38.207.169.210/32'] }, ...keep], { action: 'bypass' }),
    andRule([{ source_ip_cidr: ['192.168.3.18/32'] }, ...keep], { action: 'bypass' }),
    { action: 'sniff' },
  ])
  // 只有节点地址、没有直连终端时也写;没解析出地址(只有域名)时不写;没开首包预判时都不写
  const hostsOnly = build({ policies: [] }, { preMatchBypass: true, directHosts: { domains: [], cidrs: ['1.2.3.4/32'] } }).route.rules[0]
  assert.deepEqual(hostsOnly, andRule([{ ip_cidr: ['1.2.3.4/32'] }, { port: [53], invert: true }], { action: 'bypass' }))
  assert.deepEqual(build({ policies: [] }, { preMatchBypass: true, directHosts: { domains: ['a.test'], cidrs: [] } }).route.rules[0], { action: 'sniff' })
  assert.deepEqual(build({ policies: [] }, { directHosts: { domains: [], cidrs: ['1.2.3.4/32'] } }).route.rules[0], { action: 'sniff' })
})

test('dnsmasq 模式:「只让这些终端进内核」名单外终端的直连 DNS 入站和 dns-in 一样劫持', () => {
  const { route } = build({ policies: [] }, { dnsMode: 'dnsmasq', dnsDirectInbound: 'dns-in-direct' })
  assert.ok(route.rules.some((r) => r.action === 'hijack-dns' && JSON.stringify(r.inbound) === JSON.stringify(['dns-in', 'dns-in-direct'])))
  const plain = build({ policies: [] }, { dnsMode: 'dnsmasq' }).route
  assert.ok(plain.rules.some((r) => r.action === 'hijack-dns' && JSON.stringify(r.inbound) === JSON.stringify(['dns-in'])))
})

