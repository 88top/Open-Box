import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDns as rawBuildDns, buildDnsWithResolvers, directResolverServers, dnsPolicyClasses, ipv6ProxyMode, FAKEIP_V4, HTTPS_RR_RULE, applyProxyUpstreamRoutes, isProxyResolverTag } from './dns.mjs'
import { FLIP_FALLBACK_TAG, flattenFlipRule, flipFlagMap, flipFlagOfRule } from './flip.mjs'
import { DEFAULT_BUILTIN, normalizeRouting } from './routing-model.mjs'
import { normalizeClientRoutes } from './client-routes.mjs'

// 分流模式下规则表固定带一条「HTTPS / SVCB 查询回空」(#135),排在重写和本地主机名之后;下面绝大多数用例只关心
// 其它规则的内容和先后,这里把它滤掉,免得每个下标都加一;专门验它的用例用 rawBuildDns
const isHttpsRule = (r) => r && r.action === 'predefined' && Array.isArray(r.query_type) && r.query_type.includes('HTTPS')

// 生成出来的是热切换的成对结构(engine/flip.mjs):每个站点集「挂着开关的代理支 + 紧跟的直连支」,兜底的代理支是排在
// 最后的显式规则、final 固定指直连侧——结构本身在 flip.test.mjs 里验。这里的用例关心的是「按此刻的选择,这条匹配最终
// 由哪台解析器回答、先后顺序对不对」,所以 buildDns 给的是**内核此刻实际生效的视图**:按此刻的类别把每个开关定下来
// (部署 / 翻面流程写开关文件用的是同一个口径),OFF 的代理支去掉,ON 的展平、它后面那条被盖住的直连支去掉,
// 兜底的代理支折回 final。要看原始结构用 rawBuildDns
const effectiveView = (profile, options = {}) => {
  const { dns, resolvers } = buildDnsWithResolvers(profile, options)
  if (!Array.isArray(dns.rules)) return dns
  const conf = normalizeRouting(profile.routing)
  const state = {}
  for (const [name, tag] of flipFlagMap(conf)) {
    state[tag] = tag === FLIP_FALLBACK_TAG ? resolvers.fallback === 'dns-proxy' : Boolean(resolvers.policies[name]) && resolvers.policies[name] !== 'dns-direct'
  }
  const matchOf = (rule) => { const { server: _s, ...m } = rule; void _s; return JSON.stringify(m) }
  const rules = []
  let shadowed = null
  for (const rule of dns.rules) {
    if (flipFlagOfRule(rule)) {
      const flat = flattenFlipRule(rule, state)
      if (!flat) continue
      rules.push(flat)
      if (flat.server && !flat.query_type) shadowed = matchOf(flat)
      continue
    }
    if (Array.isArray(rule.rule_set) && rule.rule_set.length === 1 && rule.rule_set[0] === FLIP_FALLBACK_TAG) continue
    if (shadowed && rule.server === 'dns-direct' && matchOf(rule) === shadowed) { shadowed = null; continue }
    rules.push(rule)
  }
  return { ...dns, rules, final: state[FLIP_FALLBACK_TAG] ? 'dns-proxy' : 'dns-direct' }
}
const buildDns = (...args) => {
  const out = effectiveView(...args)
  if (Array.isArray(out.rules)) out.rules = out.rules.filter((r) => !isHttpsRule(r))
  return out
}
import { cidrContains, cidrsOverlap } from '../system/local-subnets.mjs'

test('FakeIP 使用保留段且不与 OpenClash / Nikki 默认池重叠', () => {
  assert.equal(cidrContains('198.18.0.0/15', FAKEIP_V4), true)
  assert.equal(cidrsOverlap('198.18.0.0/16', FAKEIP_V4), false)
  assert.equal(cidrsOverlap('198.15.0.0/16', FAKEIP_V4), false)
})

const base = {
  ipv6: true,
  // 站点集相关的用例与劫持方式无关,用默认的 dnsmasq 模式;hijack / off 的差异见前几条专门的用例
  dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: '1.1.1.1' },
  // fallbackDefault 写着就说明这份档案已经迁过地区了(见 engine/routing-model.mjs)
  routing: { proxyTag: 'PROXY', policies: [], fallbackDefault: 'proxy' },
}
const withRouting = (routing, over = {}) => ({ ...base, ...over, routing: { ...base.routing, ...routing } })

test('hijack 模式:直连侧用直连 DNS(上游 DNS = 系统上游 DNS 的第一台)而不是 local（local 会经 dnsmasq 绕回局域网里的 AdGuard 形成回环）;本地主机名单独交给 local', () => {
  const sys = { systemDns: ['192.168.1.1', '8.8.8.8'] }
  const dns = buildDns({ ...base, dns: { ...base.dns, mode: 'hijack' } }, sys)
  assert.deepEqual(dns.servers[0], { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' })
  assert.deepEqual(buildDns({ ...base, dns: { ...base.dns, mode: 'hijack', direct: 'wan' } }, sys).servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.1.1' })
  assert.ok(dns.servers.some((s) => s.type === 'local' && s.tag === 'dns-local'))
  assert.deepEqual(dns.rules[0], { domain_suffix: ['.lan', '.local', '.home', '.internal', '.home.arpa'], server: 'dns-local' })
  assert.deepEqual(dns.rules[1], { domain_regex: ['^[^.]+$'], server: 'dns-local' })
})

test('off 模式:直连侧同样用直连 DNS(上游 DNS),不再有 local 与本地主机名规则', () => {
  const dns = buildDns({ ...base, dns: { ...base.dns, mode: 'off', direct: 'wan' } }, { systemDns: ['192.168.1.1'] })
  assert.deepEqual(dns.servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.1.1' })
  assert.ok(!dns.servers.some((s) => s.type === 'local'))
  assert.ok(!dns.rules.some((r) => r.server === 'dns-local'))
})

test('hijack 模式:直连 DNS 是上游 DNS 又读不到系统上游 DNS 时按地区退回:国内 223.5.5.5、国外 1.1.1.1', () => {
  const dns = buildDns({ ...base, dns: { ...base.dns, mode: 'hijack', direct: 'wan' } })
  assert.deepEqual(dns.servers[0], { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' })
  assert.equal(buildDns({ ...base, dns: { ...base.dns, mode: 'hijack', direct: 'wan', region: 'intl' } }).servers[0].server, '1.1.1.1')
})

test('dnsmasq 模式不能用 local（会绕回 dnsmasq 死循环）,用直连 DNS:填了 IP 用它,上游 DNS 用系统的上游 DNS', () => {
  const sys = { systemDns: ['192.168.1.1', '8.8.8.8'] }
  // 不带 detour:显式 detour:'direct' 会在启动时被内核拒绝(check 查不出来)
  assert.deepEqual(buildDns({ ...base, dns: { ...base.dns, mode: 'dnsmasq' } }, sys).servers[0], { type: 'udp', tag: 'dns-direct', server: '223.5.5.5' })
  assert.deepEqual(buildDns({ ...base, dns: { ...base.dns, mode: 'dnsmasq', direct: 'wan' } }, sys).servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.1.1' })
})

test('dnsmasq 模式:直连 DNS 是上游 DNS 又读不到系统上游时,用随包默认', () => {
  const dns = buildDns({ ...base, dns: { ...base.dns, mode: 'dnsmasq', direct: 'wan' } })
  assert.equal(dns.servers[0].server, '223.5.5.5')
})

test('上游 DNS(wan)在两侧都能当主上游或备用:直连侧填了 IP 就用它、上游 DNS 用系统上游 DNS 的第一台;和别的条目落到同一台的去掉', () => {
  const sys = { systemDns: ['192.168.1.1', '192.168.1.2'] }
  const profile = { ...base, dns: { ...base.dns, mode: 'hijack', directExtras: [{ server: 'wan', protocol: 'udp' }, { server: '119.29.29.29', protocol: 'udp' }] } }
  const directSide = (dns) => dns.servers.filter((s) => s.tag === 'dns-direct' || s.tag.startsWith('dns-direct__')).map((s) => s.server)
  assert.deepEqual(directSide(rawBuildDns(profile, sys)), ['223.5.5.5', '192.168.1.1', '119.29.29.29'])
  const wanFirst = rawBuildDns({ ...profile, dns: { ...profile.dns, direct: 'wan' } }, sys)
  assert.deepEqual(directSide(wanFirst), ['192.168.1.1', '119.29.29.29'], '备用里的上游 DNS 和主上游是同一台,去掉')
})

test('代理侧用上游 DNS(路由器在中国大陆之外):系统上游 DNS 的第一台,不写 detour(固定直连),固定 UDP 53;读不到退回 1.1.1.1', () => {
  const profile = withRouting({}, { dns: { ...base.dns, mode: 'hijack', region: 'intl', proxy: 'wan', proxyProtocol: 'tcp', proxyPort: 5353, proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }] } })
  const servers = rawBuildDns(profile, { systemDns: ['81.2.69.142'], groupTags: [] }).servers
  assert.deepEqual(servers.find((s) => s.tag === 'dns-proxy'), { type: 'udp', tag: 'dns-proxy', server: '81.2.69.142' })
  assert.deepEqual(servers.find((s) => s.tag === 'dns-proxy__alt1'), { type: 'tcp', tag: 'dns-proxy__alt1', server: '8.8.8.8', detour: '其他' })
  assert.equal(rawBuildDns(profile, { groupTags: [] }).servers.find((s) => s.tag === 'dns-proxy').server, '1.1.1.1')
})

test('面板自己做直连解析(directResolverServers):直连 DNS 主 + 备用,非 53 端口写成 ip:port;上游 DNS 展开成系统上游 DNS 的全部,读不到按地区退回', () => {
  const p = (dns) => ({ dns: { direct: '223.5.5.5', ...dns } })
  assert.deepEqual(directResolverServers(p({}), ['192.168.1.1']), ['223.5.5.5'])
  assert.deepEqual(
    directResolverServers(p({ directPort: 5353, directExtras: [{ server: '119.29.29.29' }, { server: '2400:3200::1', port: 5300 }, { server: '223.5.5.5' }] }), ['192.168.1.1']),
    ['223.5.5.5:5353', '119.29.29.29', '[2400:3200::1]:5300'],
  )
  assert.deepEqual(directResolverServers(p({ direct: 'wan', directExtras: [{ server: '119.29.29.29' }] }), ['192.168.1.1', '192.168.1.2']), ['192.168.1.1', '192.168.1.2', '119.29.29.29'])
  assert.deepEqual(directResolverServers(p({ direct: 'wan' }), []), ['223.5.5.5'])
  assert.deepEqual(directResolverServers(p({ direct: 'wan', region: 'intl' }), []), ['1.1.1.1'])
})

// 成员表现在整份来自「节点管理」(内置直连/拒绝 + 节点组),用例里要把它们都给出来
const GROUPS = { groupTags: ['direct', '所有-自动', 'block'] }

test('兜底走代理时,没被站点集挑走的域名用代理侧解析', () => {
  const dns = buildDns(base, GROUPS)
  // 代理侧解析跟着兜底站点集「其他」走(它选哪条线路就用哪条解析),明文 TCP 53:
  // 查询整段封在代理隧道里,再套一层 DoH 只是每次多一次 TLS 握手
  assert.deepEqual(dns.servers[1], { type: 'tcp', tag: 'dns-proxy', server: '1.1.1.1', detour: '其他' })
  assert.equal(dns.final, 'dns-proxy')
})

test('兜底直连时,兜底的解析也回到本地', () => {
  const dns = buildDns(withRouting({ fallbackDefault: 'direct' }), GROUPS)
  assert.equal(dns.final, 'dns-direct')
})

test('走代理的站点集交给代理侧那一组解析器,不再每个站点集各开一台:连上游走哪条线路由目标分流按上游地址判(部署时写 detour)', () => {
  const dns = buildDns(
    withRouting({
      policies: [{ id: 'p1', name: '谷歌', default: 'block', rulesets: ['geosite-google'], domainSuffix: ['google.com'] }],
    }),
    GROUPS,
  )
  assert.deepEqual(dns.servers.map((x) => x.tag), ['dns-direct', 'dns-proxy'])
  // 规则集和手写域名拆成紧邻的两条、同一台解析器(sing-box 1.14 起规则集不再稳定地和同条里的域名条件「或」)
  assert.deepEqual(dns.rules[0], { rule_set: ['geosite-google'], server: 'dns-proxy' })
  assert.deepEqual(dns.rules[1], { domain_suffix: ['google.com'], server: 'dns-proxy' })
})

test('走直连的站点集此刻用本地解析（国内站点才拿得到就近地址）;代理那一支照样写着(挂着开关)——它随时可能翻到代理,翻面不重启内核', () => {
  const profile = withRouting({ policies: [{ id: 'p1', name: '中国', default: 'direct', rulesets: ['geosite-cn'] }] })
  const dns = buildDns(profile)
  assert.deepEqual(dns.rules[0], { server: 'dns-direct', rule_set: ['geosite-cn'] })
  assert.deepEqual(dns.servers.map((x) => x.tag), ['dns-direct', 'dns-proxy'])
  // 原始结构:挂着开关的代理支在前,直连支紧跟
  const raw = rawBuildDns(profile).rules.filter((r) => !isHttpsRule(r))
  assert.equal(flipFlagOfRule(raw[0]).startsWith('obflip-'), true)
  assert.equal(raw[0].server, 'dns-proxy')
  assert.deepEqual(raw[1], { rule_set: ['geosite-cn'], server: 'dns-direct' })
})

test('default 空着、内核没在跑时按成员表第一项算（直连）', () => {
  const dns = buildDns(withRouting({ policies: [{ id: 'p1', name: 'x', rulesets: ['geosite-x'] }] }))
  assert.deepEqual(dns.rules[0], { server: 'dns-direct', rule_set: ['geosite-x'] })
})

test('内核里当前的选择优先于档案默认:默认直连但代理页切到了节点组 → 代理侧解析器;反之 → 本地解析', () => {
  const routing = {
    fallbackDefault: 'direct',
    policies: [
      { id: 'p1', name: '谷歌', default: 'direct', rulesets: ['geosite-google'] },
      { id: 'p2', name: '中国', default: 'block', rulesets: ['geosite-cn'] },
    ],
  }
  const selections = { 谷歌: '香港-自动', '香港-自动': 'HK-01', 中国: 'direct', 其他: '香港-自动' }
  const dns = buildDns(withRouting(routing), { ...GROUPS, selections })
  assert.deepEqual(dns.rules[0], { server: 'dns-proxy', rule_set: ['geosite-google'] })
  assert.deepEqual(dns.rules[1], { server: 'dns-direct', rule_set: ['geosite-cn'] })
  assert.equal(dns.final, 'dns-proxy')
})

test('geoip 规则集不进 DNS 规则:含 IP 的规则集会让内核对每个域名先按这条查一遍再扔掉重查', () => {
  const dns = buildDns(
    withRouting({
      policies: [{ id: 'p1', name: 'Netflix', default: 'block', rulesets: ['geosite-netflix', 'geoip-netflix'] }],
    }),
    GROUPS,
  )
  assert.deepEqual(dns.rules[0], { server: 'dns-proxy', rule_set: ['geosite-netflix'] })
})

test('只有 geoip 规则集的站点集不生成 DNS 规则,也不给专属解析器', () => {
  const dns = buildDns(
    withRouting({ policies: [{ id: 'p1', name: '电报', default: 'block', rulesets: ['geoip-telegram'] }] }),
    GROUPS,
  )
  assert.deepEqual(dns.rules, [])
  assert.equal(dns.servers.length, 2)
})

test('规则集链接:DNS 规则只引用域名那份;名单里只有 IP 的不进 DNS 规则;没有形状表就按老样子引用一份', () => {
  const routing = { policies: [{ id: 'p1', name: 'Speed', default: 'block', ruleUrls: ['https://x.test/Check.list'] }] }
  const tag = 'list-' + (() => { let h = 0x811c9dc5; for (const ch of 'https://x.test/Check.list') { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') })()
  const both = buildDns(withRouting(routing), { ...GROUPS, ruleLists: { [tag]: { domain: true, ip: true } } })
  assert.deepEqual(both.rules[0], { server: 'dns-proxy', rule_set: [tag] })
  const ipOnly = buildDns(withRouting(routing), { ...GROUPS, ruleLists: { [tag]: { domain: false, ip: true } } })
  assert.deepEqual(ipOnly.rules, [])
  assert.equal(ipOnly.servers.length, 2)
  const unknown = buildDns(withRouting(routing), GROUPS)
  assert.deepEqual(unknown.rules[0], { server: 'dns-proxy', rule_set: [tag] })
})

test('只有 IP 条件的站点集不进 DNS 规则:解析阶段还没有 IP,写进去只会让人以为生效了', () => {
  const dns = buildDns(withRouting({ policies: [{ id: 'p1', name: '内网', ipCidr: ['10.0.0.0/8'] }] }))
  assert.deepEqual(dns.rules, [])
  assert.equal(dns.servers.length, 2)
})

test('分流 DNS 关掉时只剩一条直连通道', () => {
  const dns = buildDns({ ...base, dns: { ...base.dns, split: false } })
  assert.equal(dns.servers.length, 1)
  assert.equal(dns.final, 'dns-direct')
  assert.ok(!dns.rules)
})

test('reverse_mapping 恒开:按 IP 连的客户端也能命中域名规则', () => {
  assert.equal(buildDns(base).reverse_mapping, true)
  assert.equal(buildDns({ ...base, dns: { ...base.dns, split: false } }).reverse_mapping, true)
})

test('ipv6 关:strategy=ipv4_only', () => {
  assert.equal(buildDns({ ...base, ipv6: false }).strategy, 'ipv4_only')
})


test('一个节点组都没有时,兜底的「走代理」只能落回直连:不能指向内核里不存在的出站', () => {
  const dns = buildDns(base)
  assert.equal(dns.final, 'dns-direct')
})

test('dnsPolicyClasses:落进 config.meta.json 的那张"谁走直连、谁走代理"表', () => {
  const routing = {
    fallbackDefault: 'proxy',
    policies: [
      { id: 'p1', name: '谷歌', default: 'block', rulesets: ['geosite-google'] },
      { id: 'p2', name: '中国', default: 'direct', rulesets: ['geosite-cn'] },
      // 只有 IP 条件:不进 DNS 规则,也就不进这张表(改它不会让规则过期)
      { id: 'p3', name: '内网', default: 'direct', ipCidr: ['10.0.0.0/8'] },
    ],
  }
  const members = ['direct', '所有-自动', 'block']
  assert.deepEqual(dnsPolicyClasses(routing, members), { 谷歌: 'proxy', 中国: 'direct', 其他: 'proxy' })
  // 内核里当前的选择优先:代理页把兜底切到直连、把「中国」切到节点组
  assert.deepEqual(
    dnsPolicyClasses(routing, members, undefined, { 其他: 'direct', 中国: '所有-自动' }),
    { 谷歌: 'proxy', 中国: 'proxy', 其他: 'direct' },
  )
})

test('前置自定义分流:走代理的行交给代理侧那一组解析器,不再按出口各开一台', () => {
  const dns = buildDns(
    withRouting({
      custom: {
        rules: [
          { type: 'domainSuffix', value: 'openai.com', outbound: 'VW | 香港-01' },
          { type: 'domainSuffix', value: 'chat.com', outbound: 'VW | 香港-01' },
          { type: 'domain', value: 'netflix.com', outbound: 'VW | 美国-01' },
        ],
      },
    }),
    { groupTags: ['direct', '香港-自动'] },
  )
  assert.deepEqual(dns.servers.map((x) => x.tag), ['dns-direct', 'dns-proxy'])
  const mine = dns.rules.filter((r) => ['openai.com', 'chat.com', 'netflix.com'].includes((r.domain_suffix || r.domain || [])[0]))
  assert.deepEqual(mine, [
    { domain_suffix: ['openai.com'], server: 'dns-proxy' },
    { domain_suffix: ['chat.com'], server: 'dns-proxy' },
    { domain: ['netflix.com'], server: 'dns-proxy' },
  ])
})

test('前置自定义分流:出口是直连的行用直连侧解析,不另开解析器', () => {
  const dns = buildDns(
    withRouting({ custom: { rules: [{ type: 'domainSuffix', value: 'cn.example', outbound: 'direct' }] } }),
    { groupTags: ['direct'] },
  )
  assert.ok(!dns.servers.some((x) => x.tag.startsWith('dns-custom')))
  assert.ok(dns.rules.some((r) => r.server === 'dns-direct' && r.domain_suffix?.includes('cn.example')))
})

test('前置自定义分流:只按 IP 匹配的行不进 DNS（解析时还没有 IP）', () => {
  const dns = buildDns(
    withRouting({
      custom: {
        rules: [
          { type: 'ipCidr', value: '1.2.3.0/24', outbound: 'VW | 香港-01' },
          { type: 'geoip', value: 'cn', outbound: 'direct' },
          { type: 'port', value: '51820', outbound: 'VW | 香港-01' },
        ],
      },
    }),
    { groupTags: ['direct'] },
  )
  assert.ok(!dns.servers.some((x) => x.tag.startsWith('dns-custom')))
  assert.ok(!dns.rules.some((r) => r.ip_cidr || r.port || r.port_range))
})

// ---------- 第一层整改:顺序、拒绝、终端来源 ----------
test('DNS 规则顺序和连接侧一致:前置自定义分流 → 直连站点 → 终端分流 → 站点集（审核 B4）', () => {
  const dns = buildDns(
    withRouting({
      custom: { rules: [{ type: 'domainSuffix', value: 'allowed.example', outbound: 'HK' }] },
      policies: [{ id: 'p', name: 'P', default: 'HK', domainSuffix: ['p.example'] }],
    }, { dns: { ...base.dns, mode: 'hijack' } }),
    { groupTags: ['HK'], directHosts: { domains: ['node.example.com'], cidrs: [] }, clientRoutes: [{ sources: ['192.168.3.9/32'], outbound: 'direct' }] },
  )
  const at = (pred) => dns.rules.findIndex(pred)
  const custom = at((r) => r.domain_suffix && r.domain_suffix[0] === 'allowed.example')
  const hosts = at((r) => r.domain && r.domain.includes('node.example.com'))
  const client = at((r) => r.source_ip_cidr)
  const site = at((r) => r.domain_suffix && r.domain_suffix[0] === 'p.example')
  assert.ok(custom >= 0 && custom < hosts && hosts < client && client < site, JSON.stringify(dns.rules))
  assert.ok(!dns.rules.some((r) => r.action === 'reject' && r.rule_set), '广告拦截已退役,不该再有按规则集拒绝的 DNS 规则')
})

test('前置自定义分流出口是拒绝的行:解析也拒,不再当直连解析', () => {
  const dns = buildDns(withRouting({ custom: { rules: [{ type: 'domain', value: 'bad.example', outbound: 'block' }] } }), { groupTags: [] })
  assert.deepEqual(dns.rules.find((r) => r.domain && r.domain[0] === 'bad.example'), { domain: ['bad.example'], action: 'reject' })
})

test('终端分流（劫持模式）:指定来源的终端,解析跟着它的出口是直连还是代理——直连终端用按终端答的直连解析器,走代理的交给代理侧那一组（审核 B3）', () => {
  const dns = buildDns(
    withRouting({ policies: [{ id: 'y', name: 'Youtube', default: 'HK', domainSuffix: ['youtube.com'] }] }, { dns: { ...base.dns, mode: 'hijack' } }),
    {
      groupTags: ['HK', 'US'],
      knownOutbounds: new Set(['HK', 'US', 'direct', 'block', 'VW | 美国-01']),
      clientRoutes: [
        { sources: ['192.168.1.10/32', '2001:db8::10/128'], outbound: 'direct' },
        { sources: ['192.168.1.20/32'], outbound: 'US' },
        { sources: ['192.168.1.30/32'], outbound: 'VW | 美国-01' },   // 直接指到节点也行
        { sources: ['192.168.1.40/32'], outbound: 'block' },
        { sources: ['192.168.1.50/32'], outbound: '已删掉的组' },        // 出口不存在:丢掉
      ],
    },
  )
  const src = dns.rules.filter((r) => r.source_ip_cidr)
  assert.deepEqual(src, [
    // 直连终端用按终端答的直连解析器:和 dns-direct 同一个上游,但内核不把它的应答写进全局的入口放行集合
    { source_ip_cidr: ['192.168.1.10/32', '2001:db8::10/128'], server: 'dns-terminal-direct' },
    { source_ip_cidr: ['192.168.1.20/32'], server: 'dns-proxy' },
    { source_ip_cidr: ['192.168.1.30/32'], server: 'dns-proxy' },
    { source_ip_cidr: ['192.168.1.40/32'], action: 'reject' },
  ])
  const direct = dns.servers.find((s) => s.tag === 'dns-direct')
  assert.deepEqual({ ...dns.servers.find((s) => s.tag === 'dns-terminal-direct'), tag: 'dns-direct' }, direct, '上游和 dns-direct 一模一样,只是 tag 不同')
  assert.ok(!dns.servers.some((s) => /^dns-client-/.test(s.tag)), '走代理的终端不再各开一台')
  // 1.14 起缓存本来就按解析器分,弃用的 independent_cache 不再写
  assert.equal(dns.independent_cache, undefined)
  // 终端规则排在站点集之前:直连终端查 youtube.com 也用直连解析,和它的连接一致
  const client = dns.rules.findIndex((r) => r.source_ip_cidr)
  const site = dns.rules.findIndex((r) => r.domain_suffix && r.domain_suffix[0] === 'youtube.com')
  assert.ok(client < site)
})

test('终端分流（dnsmasq 转发模式）:内核看不到终端来源,不生成来源规则、不开独立缓存——这是明确的限制,不是漏了', () => {
  const dns = buildDns(withRouting({}), { groupTags: ['HK'], knownOutbounds: new Set(['HK']), clientRoutes: [{ sources: ['192.168.1.20/32'], outbound: 'HK' }] })
  assert.ok(!dns.rules.some((r) => r.source_ip_cidr))
  assert.equal(dns.independent_cache, undefined)
})

test('终端分流（dnsmasq 转发模式）:「直连」「不进内核」和走节点的终端查询由入口转给内核、按终端答——不进内核的排在前置自定义分流前面,直连 / 走节点的排在后面;本地主机名交回 dnsmasq', () => {
  const profile = withRouting({
    policies: [{ id: 'y', name: 'Youtube', default: 'HK', domainSuffix: ['youtube.com'] }],
    custom: { rules: [{ type: 'domainSuffix', value: 'x.test', outbound: 'HK' }] },
  })
  const clientRoutes = normalizeClientRoutes([
    { sources: ['192.168.1.10'], outbound: 'direct' },
    { match: 'mac', macs: ['AA-BB-CC-00-11-22'], bypass: true },
    { sources: ['192.168.1.20'], outbound: 'HK' },
  ], { directTag: 'direct' })
  const options = { groupTags: ['HK'], knownOutbounds: new Set(['HK', 'direct', 'block']), clientRoutes }
  const dns = buildDns(profile, { ...options, terminalDns: { autoRedirect: true, directBypass: true } })
  const at = (pred) => dns.rules.findIndex(pred)
  const bypassAt = at((r) => r.source_mac_address && r.server === 'dns-terminal-direct')
  const customAt = at((r) => r.domain_suffix && r.domain_suffix[0] === 'x.test')
  const directAt = at((r) => r.source_ip_cidr && r.server === 'dns-terminal-direct' && !r.domain_suffix && !r.domain_regex)
  assert.ok(bypassAt >= 0 && bypassAt < customAt, '不进内核的终端整台不进内核,前置自定义分流也管不到它,排在前面、不会拿到占位地址')
  assert.ok(directAt > customAt, '直连终端排在前置自定义分流后面:走代理的自定义域名照样拿占位地址、进内核按规则走')
  assert.ok(directAt < at((r) => r.domain_suffix && r.domain_suffix[0] === 'youtube.com'), '排在站点集前面:直连终端查 youtube.com 也是直连解析')
  // 指定走节点的终端也按终端答(GitHub #574):解析跟着它的出口交给代理侧,排在前置自定义分流后面、站点集前面
  const proxyAt = at((r) => r.source_ip_cidr && r.source_ip_cidr.includes('192.168.1.20/32') && !r.domain_suffix && !r.domain_regex)
  assert.ok(proxyAt > customAt && proxyAt < at((r) => r.domain_suffix && r.domain_suffix[0] === 'youtube.com'), JSON.stringify(dns.rules))
  assert.ok(isProxyResolverTag(dns.rules[proxyAt].server), dns.rules[proxyAt].server)
  // 转进来的终端不再经过 dnsmasq:本地主机名只对它们交回 dnsmasq(dns-local)
  const local = dns.rules.filter((r) => r.server === 'dns-local')
  assert.deepEqual(local, [
    { source_ip_cidr: ['192.168.1.10/32'], domain_suffix: ['.lan', '.local', '.home', '.internal', '.home.arpa'], server: 'dns-local' },
    { source_ip_cidr: ['192.168.1.10/32'], domain_regex: ['^[^.]+$'], server: 'dns-local' },
    { source_mac_address: ['aa:bb:cc:00:11:22'], domain_suffix: ['.lan', '.local', '.home', '.internal', '.home.arpa'], server: 'dns-local' },
    { source_mac_address: ['aa:bb:cc:00:11:22'], domain_regex: ['^[^.]+$'], server: 'dns-local' },
    { source_ip_cidr: ['192.168.1.20/32'], domain_suffix: ['.lan', '.local', '.home', '.internal', '.home.arpa'], server: 'dns-local' },
    { source_ip_cidr: ['192.168.1.20/32'], domain_regex: ['^[^.]+$'], server: 'dns-local' },
  ])
  assert.ok(dns.servers.some((s) => s.tag === 'dns-local' && s.type === 'local'))
  assert.equal(dns.servers.filter((s) => s.tag === 'dns-terminal-direct').length, 1)

  // 「直连不进内核」关掉:直连终端整台进内核,不用按终端答;不进内核、走节点的终端照旧
  const off = buildDns(profile, { ...options, terminalDns: { autoRedirect: true, directBypass: false } })
  assert.ok(!off.rules.some((r) => r.source_ip_cidr && r.source_ip_cidr.includes('192.168.1.10/32')))
  assert.ok(off.rules.some((r) => r.source_ip_cidr && r.source_ip_cidr.includes('192.168.1.20/32') && isProxyResolverTag(r.server)))
  assert.ok(off.rules.some((r) => r.source_mac_address && r.server === 'dns-terminal-direct'))
  // 没有 nft 重定向(纯 tun)、或者没开分流解析:入口转不了 / 不用转,一条都不写
  const pure = buildDns(profile, { ...options, terminalDns: { autoRedirect: false, directBypass: true } })
  assert.ok(!pure.rules.some((r) => r.source_ip_cidr || r.source_mac_address))
  assert.ok(!pure.servers.some((s) => s.tag === 'dns-terminal-direct' || s.tag === 'dns-local'))
  const noSplit = buildDns({ ...profile, dns: { ...profile.dns, split: false } }, { ...options, terminalDns: { autoRedirect: true, directBypass: true } })
  assert.ok(!noSplit.rules || !noSplit.rules.some((r) => r.source_ip_cidr || r.source_mac_address))
})

test('终端分流（劫持模式）:不进内核的终端也按终端答、排在前置自定义分流前面(它们的查询由入口转给内核);本地主机名规则照旧对所有终端', () => {
  const profile = withRouting({ custom: { rules: [{ type: 'domainSuffix', value: 'x.test', outbound: 'HK' }] } }, { dns: { ...base.dns, mode: 'hijack' } })
  const clientRoutes = normalizeClientRoutes([{ sources: ['192.168.1.30'], bypass: true }, { sources: ['192.168.1.10'], outbound: 'direct' }], { directTag: 'direct' })
  const dns = buildDns(profile, { groupTags: ['HK'], knownOutbounds: new Set(['HK', 'direct', 'block']), clientRoutes, terminalDns: { autoRedirect: true, directBypass: true } })
  const bypassAt = dns.rules.findIndex((r) => r.source_ip_cidr && r.source_ip_cidr[0] === '192.168.1.30/32')
  const customAt = dns.rules.findIndex((r) => r.domain_suffix && r.domain_suffix[0] === 'x.test')
  const directAt = dns.rules.findIndex((r) => r.source_ip_cidr && r.source_ip_cidr[0] === '192.168.1.10/32')
  assert.ok(bypassAt >= 0 && bypassAt < customAt && customAt < directAt)
  assert.equal(dns.rules[bypassAt].server, 'dns-terminal-direct')
  assert.ok(!dns.rules.some((r) => r.server === 'dns-local' && (r.source_ip_cidr || r.source_mac_address)), '劫持模式下本地主机名规则本来就对所有终端')
})

test('「只让这些终端进内核」名单外终端的专用入站:查询一律直连解析,排在前置自定义分流前面;dnsmasq 模式下本地主机名交回 dnsmasq', () => {
  const profile = withRouting({
    policies: [{ id: 'y', name: 'Youtube', default: 'HK', domainSuffix: ['youtube.com'] }],
    custom: { rules: [{ type: 'domainSuffix', value: 'x.test', outbound: 'HK' }] },
  })
  const dns = buildDns(profile, { groupTags: ['HK'], knownOutbounds: new Set(['HK', 'direct', 'block']), terminalDns: { autoRedirect: true, directBypass: true, admitDirect: 'dns-in-direct' } })
  const at = dns.rules.findIndex((r) => r.inbound && r.server === 'dns-terminal-direct')
  assert.ok(at >= 0 && at < dns.rules.findIndex((r) => r.domain_suffix && r.domain_suffix[0] === 'x.test'))
  assert.deepEqual(dns.rules[at], { inbound: ['dns-in-direct'], server: 'dns-terminal-direct' })
  assert.deepEqual(dns.rules.filter((r) => r.server === 'dns-local'), [
    { inbound: ['dns-in-direct'], domain_suffix: ['.lan', '.local', '.home', '.internal', '.home.arpa'], server: 'dns-local' },
    { inbound: ['dns-in-direct'], domain_regex: ['^[^.]+$'], server: 'dns-local' },
  ])
  // 没有这个入站时一条都不写
  const none = buildDns(profile, { groupTags: ['HK'], knownOutbounds: new Set(['HK', 'direct', 'block']), terminalDns: { autoRedirect: true } })
  assert.ok(!none.rules.some((r) => r.inbound && r.inbound.includes('dns-in-direct')))
})

test('FakeIP 原型（dns.fakeIpForProxy）:走代理的匹配先给 A / AAAA 一条占位地址规则,其它类型仍走代理侧解析器;直连和拒绝不变;兜底走代理时收尾也发占位地址', () => {
  const routing = {
    policies: [
      { id: 'g', name: '谷歌', default: '所有-自动', rulesets: ['geosite-google'] },
      { id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn'] },
    ],
    custom: { rules: [{ type: 'domainSuffix', value: 'x.test', outbound: '所有-自动' }, { type: 'domainSuffix', value: 'ad.test', outbound: 'block' }] },
    fallbackDefault: 'proxy',
  }
  const on = buildDns({ ...withRouting(routing), dns: { ...base.dns, fakeIpForProxy: true } }, GROUPS)
  const fake = on.servers.find((s) => s.type === 'fakeip')
  assert.deepEqual(fake, { type: 'fakeip', tag: 'dns-fakeip', inet4_range: '198.19.0.0/16', inet6_range: 'fc00::/18' })
  // 自定义代理行:占位规则在真解析器规则前面,且只管 A / AAAA
  assert.deepEqual(on.rules[0], { domain_suffix: ['x.test'], query_type: ['A', 'AAAA'], server: 'dns-fakeip' })
  assert.deepEqual(on.rules[1], { domain_suffix: ['x.test'], server: 'dns-proxy' })
  // 拒绝行照旧拒绝,不发占位地址
  assert.deepEqual(on.rules[2], { domain_suffix: ['ad.test'], action: 'reject' })
  // 站点集:走代理的先占位,直连的照旧真实解析
  assert.deepEqual(on.rules[3], { rule_set: ['geosite-google'], query_type: ['A', 'AAAA'], server: 'dns-fakeip' })
  assert.deepEqual(on.rules[4], { server: 'dns-proxy', rule_set: ['geosite-google'] })
  assert.deepEqual(on.rules[5], { server: 'dns-direct', rule_set: ['geosite-cn'] })
  // 兜底走代理:没命中的域名 A / AAAA 也占位;final 仍是代理侧解析器(其它查询类型)
  assert.deepEqual(on.rules[6], { query_type: ['A', 'AAAA'], server: 'dns-fakeip' })
  assert.equal(on.final, 'dns-proxy')
  // 没开 IPv6 就不给 v6 占位段
  const v4 = buildDns({ ...withRouting(routing), ipv6: false, dns: { ...base.dns, fakeIpForProxy: true } }, GROUPS)
  assert.deepEqual(v4.servers.find((s) => s.type === 'fakeip'), { type: 'fakeip', tag: 'dns-fakeip', inet4_range: '198.19.0.0/16' })
  // 兜底直连:收尾不占位
  const fbDirect = buildDns({ ...withRouting({ ...routing, fallbackDefault: 'direct' }), dns: { ...base.dns, fakeIpForProxy: true } }, GROUPS)
  assert.ok(!fbDirect.rules.some((r) => r.server === 'dns-fakeip' && !r.rule_set && !r.domain_suffix))
  // 关着(默认):一条占位规则、一台 fakeip 服务器都没有
  const off = buildDns(withRouting(routing), GROUPS)
  assert.ok(!off.servers.some((s) => s.type === 'fakeip'))
  assert.ok(!off.rules.some((r) => r.server === 'dns-fakeip'))
})

test('FakeIP 原型:指定终端走代理的来源规则（hijack 模式）也先占位', () => {
  const dns = buildDns(
    { ...withRouting({ fallbackDefault: 'direct' }), dns: { ...base.dns, mode: 'hijack', fakeIpForProxy: true }, clientRoutes: [{ id: 'a', name: 'a', sources: ['192.168.1.9'], outbound: '所有-自动' }] },
    { ...GROUPS, clientRoutes: [{ sources: ['192.168.1.9/32'], outbound: '所有-自动' }] },
  )
  const i = dns.rules.findIndex((r) => r.source_ip_cidr && r.server === 'dns-fakeip')
  assert.ok(i >= 0)
  assert.deepEqual(dns.rules[i].query_type, ['A', 'AAAA'])
  assert.equal(dns.rules[i + 1].server, 'dns-proxy')
})

test('IPv6 分层 · 代理 v6 降为 IPv4（ipv6 开 + ipv6Proxy=ipv4）:走代理的规则前面一条 predefined 把 AAAA 回空（1.14 不认遗留的 strategy）,直连规则照常;兜底走代理时 AAAA 也回空;FakeIP 不给 v6 占位段、只管 A', () => {
  const routing = {
    policies: [
      { id: 'g', name: '谷歌', default: '所有-自动', rulesets: ['geosite-google'] },
      { id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn'] },
    ],
    fallbackDefault: 'proxy',
  }
  const split = buildDns({ ...withRouting(routing), ipv6: true, ipv6Proxy: 'ipv4' }, GROUPS)
  assert.equal(split.strategy, 'prefer_ipv4')                       // 全局(直连侧)仍然双栈
  assert.deepEqual(split.rules[0], { rule_set: ['geosite-google'], query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' })
  assert.deepEqual(split.rules[1], { rule_set: ['geosite-google'], server: 'dns-proxy' })
  assert.deepEqual(split.rules[2], { server: 'dns-direct', rule_set: ['geosite-cn'] })
  assert.deepEqual(split.rules.at(-1), { query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' })
  assert.equal(split.final, 'dns-proxy')
  // 遗留的 strategy 动作一条都不写:1.14 里它和 query_type 不能出现在同一份 DNS 配置里(启动 FATAL)
  assert.ok(!split.rules.some((r) => r.strategy))
  // 兜底直连:没有那条 AAAA 收尾
  const fbDirect = buildDns({ ...withRouting({ ...routing, fallbackDefault: 'direct' }), ipv6: true, ipv6Proxy: 'ipv4' }, GROUPS)
  assert.ok(!fbDirect.rules.some((r) => r.query_type && !r.rule_set))
  // node(默认)/ ipv6 关着:一条 AAAA 回空都不写
  const node = buildDns({ ...withRouting(routing), ipv6: true, ipv6Proxy: 'node' }, GROUPS)
  assert.ok(!node.rules.some((r) => r.strategy || r.action === 'predefined'))
  const off = buildDns({ ...withRouting(routing), ipv6: false, ipv6Proxy: 'ipv4' }, GROUPS)
  assert.ok(!off.rules.some((r) => r.strategy || r.action === 'predefined'))
  assert.equal(off.strategy, 'ipv4_only')
  // FakeIP + 降为 IPv4:占位服务器没有 inet6_range;每个走代理的匹配是 AAAA 回空 → 占位(只管 A)→ 真实解析器,
  // 兜底同样先回空 AAAA 再占位 A
  const fake = buildDns({ ...withRouting(routing), ipv6: true, ipv6Proxy: 'ipv4', dns: { ...base.dns, fakeIpForProxy: true } }, GROUPS)
  assert.deepEqual(fake.servers.find((s) => s.type === 'fakeip'), { type: 'fakeip', tag: 'dns-fakeip', inet4_range: '198.19.0.0/16' })
  const fakeGoogle = fake.rules.filter((r) => r.rule_set && r.rule_set[0] === 'geosite-google')
  assert.deepEqual(fakeGoogle.map((r) => r.action || r.server), ['predefined', 'dns-fakeip', 'dns-proxy'])
  assert.deepEqual(fakeGoogle[1].query_type, ['A'])
  assert.deepEqual(fake.rules.slice(-2), [{ query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' }, { query_type: ['A'], server: 'dns-fakeip' }])
  const fakeNode = buildDns({ ...withRouting(routing), ipv6: true, ipv6Proxy: 'node', dns: { ...base.dns, fakeIpForProxy: true } }, GROUPS)
  assert.equal(fakeNode.servers.find((s) => s.type === 'fakeip').inet6_range, 'fc00::/18')
})

test('ipv6ProxyMode:关着 off、默认 node、降级 ipv4、不进内核 bypass;bypass 的 DNS 和 node 一样双栈、不回空 AAAA', () => {
  assert.equal(ipv6ProxyMode({ ipv6: false, ipv6Proxy: 'bypass' }), 'off')
  assert.equal(ipv6ProxyMode({ ipv6: true }), 'node')
  assert.equal(ipv6ProxyMode({ ipv6: true, ipv6Proxy: 'ipv4' }), 'ipv4')
  assert.equal(ipv6ProxyMode({ ipv6: true, ipv6Proxy: 'bypass' }), 'bypass')
  const routing = { policies: [{ id: 'g', name: '谷歌', default: '所有-自动', rulesets: ['geosite-google'] }], fallbackDefault: 'proxy' }
  const bypass = buildDns({ ...withRouting(routing), ipv6: true, ipv6Proxy: 'bypass' }, GROUPS)
  assert.equal(bypass.strategy, 'prefer_ipv4')
  assert.ok(!bypass.rules.some((r) => r.action === 'predefined' || r.strategy))
})

test('F2:IPv6 不进内核（bypass）+ FakeIP:占位只管 A,AAAA 继续交给真实解析器（逐策略和兜底都是）;node 模式 A/AAAA 都占位;ipv4 模式 AAAA 回空', () => {
  const routing = { policies: [{ id: 'g', name: '谷歌', default: '所有-自动', rulesets: ['geosite-google'] }], fallbackDefault: 'proxy' }
  const fake = (over) => buildDns({ ...withRouting(routing), ipv6: true, dns: { ...base.dns, fakeIpForProxy: true }, ...over }, GROUPS)
  const bypass = fake({ ipv6Proxy: 'bypass' })
  const rulesFor = (dns) => dns.rules.filter((r) => r.rule_set && r.rule_set[0] === 'geosite-google')
  assert.deepEqual(rulesFor(bypass).map((r) => [r.server || r.action, r.query_type || null]), [['dns-fakeip', ['A']], ['dns-proxy', null]])
  assert.deepEqual(bypass.rules.at(-1), { query_type: ['A'], server: 'dns-fakeip' })
  assert.equal(bypass.servers.find((s) => s.type === 'fakeip').inet6_range, undefined)
  assert.ok(!bypass.rules.some((r) => r.action === 'predefined'))
  const node = fake({ ipv6Proxy: 'node' })
  assert.deepEqual(rulesFor(node)[0].query_type, ['A', 'AAAA'])
  assert.deepEqual(node.rules.at(-1), { query_type: ['A', 'AAAA'], server: 'dns-fakeip' })
  const v4 = fake({ ipv6Proxy: 'ipv4' })
  assert.deepEqual(rulesFor(v4).map((r) => [r.server || r.action, r.query_type || null]), [['predefined', ['AAAA']], ['dns-fakeip', ['A']], ['dns-proxy', null]])
})

// ---------- DNS 上游协议(dns.directProtocol / dns.proxyProtocol) ----------
test('直连侧协议:按 dns.directProtocol 出 udp / tcp;没填 / 不认识的（含已撤掉的 tls）按 udp;上游 DNS 一律 UDP(跟着上游走,档案里的协议不看)', () => {
  const sys = { systemDns: ['192.168.1.1'] }
  assert.deepEqual(buildDns({ ...base, dns: { ...base.dns, directProtocol: 'tcp' } }, sys).servers[0], { type: 'tcp', tag: 'dns-direct', server: '223.5.5.5' })
  assert.deepEqual(buildDns({ ...base, dns: { ...base.dns, directProtocol: 'tcp' } }).servers[0], { type: 'tcp', tag: 'dns-direct', server: '223.5.5.5' })
  assert.deepEqual(buildDns({ ...base, dns: { ...base.dns, direct: 'wan', directProtocol: 'tcp' } }, sys).servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.1.1' })
  for (const protocol of ['doh', 'tls', 'https', undefined]) {
    assert.equal(buildDns({ ...base, dns: { ...base.dns, directProtocol: protocol } }, sys).servers[0].type, 'udp', String(protocol))
  }
})

test('代理侧协议:兜底、站点集、终端分流、前置分流都交给代理侧那一组解析器,按 dns.proxyProtocol 出;默认 tcp', () => {
  const profile = withRouting(
    {
      custom: { rules: [{ type: 'domainSuffix', value: 'c.example', outbound: 'HK' }] },
      policies: [{ id: 'p', name: 'P', default: 'HK', domainSuffix: ['p.example'] }],
    },
    { dns: { ...base.dns, mode: 'hijack', proxy: '8.8.8.8', proxyProtocol: 'udp' } },
  )
  const dns = buildDns(profile, { groupTags: ['HK'], clientRoutes: [{ sources: ['192.168.3.9/32'], outbound: 'HK' }] })
  const proxies = dns.servers.filter((s) => isProxyResolverTag(s.tag))
  assert.deepEqual(proxies.map((s) => s.tag), ['dns-proxy'], JSON.stringify(dns.servers))
  for (const s of proxies) {
    assert.equal(s.type, 'udp', s.tag)
    assert.equal(s.server, '8.8.8.8', s.tag)
  }
  assert.equal(buildDns(base).servers.find((s) => s.tag === 'dns-proxy').type, 'tcp')
})

test('上游地址是域名或老的 DoH 链接时不进配置:直连侧退回上游 DNS,代理侧退回默认 1.1.1.1', () => {
  const dns = buildDns({ ...base, dns: { ...base.dns, direct: 'dns.alidns.com', proxy: 'https://dns.google/dns-query' } })
  assert.equal(dns.servers[0].server, '223.5.5.5')
  assert.equal(dns.servers.find((s) => s.tag === 'dns-proxy').server, '1.1.1.1')
})

test('上游端口:改了才写 server_port;直连 DNS 填了 IP 就用它和它的端口,上游 DNS 端口固定 53', () => {
  const dns = buildDns({ ...base, dns: { ...base.dns, direct: '192.168.3.5', directPort: 5353, proxyPort: 5300 } })
  assert.deepEqual(dns.servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.3.5', server_port: 5353 })
  const proxy = dns.servers.find((s) => s.tag === 'dns-proxy')
  assert.equal(proxy.server_port, 5300)
  const withWan = buildDns({ ...base, dns: { ...base.dns, direct: '192.168.3.5', directPort: 5353 } }, { systemDns: ['192.168.1.1'] })
  assert.deepEqual(withWan.servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.3.5', server_port: 5353 })
  const viaWan = buildDns({ ...base, dns: { ...base.dns, direct: 'wan', directPort: 5353 } }, { systemDns: ['192.168.1.1'] })
  assert.deepEqual(viaWan.servers[0], { type: 'udp', tag: 'dns-direct', server: '192.168.1.1' })
  assert.equal('server_port' in buildDns(base).servers[0], false)
})

test('分流模式下 HTTPS / SVCB 查询直接回空(#135):排在重写、本地主机名之后,其它规则之前;全部直连时不加', () => {
  const dns = rawBuildDns(withRouting({ policies: [{ id: 'p', name: 'P', default: 'HK', domainSuffix: ['p.example'] }] }, { dns: { ...base.dns, mode: 'hijack' } }), { groupTags: ['HK'] })
  const i = dns.rules.findIndex(isHttpsRule)
  assert.ok(i >= 0)
  assert.deepEqual(dns.rules[i], { query_type: ['HTTPS', 'SVCB'], action: 'predefined', rcode: 'NOERROR' })
  const local = dns.rules.findIndex((r) => r.server === 'dns-local')
  const site = dns.rules.findIndex((r) => r.domain_suffix && r.domain_suffix[0] === 'p.example')
  assert.ok(local >= 0 && local < i && i < site, JSON.stringify(dns.rules))
  assert.ok(!rawBuildDns({ ...base, dns: { ...base.dns, split: false } }).rules)
  // 只有 IP 条件的站点集不进 DNS 规则时,规则表里也只剩这一条
  // (外加兜底的代理支:它恒定排在最后、挂着兜底的开关)
  assert.deepEqual(rawBuildDns(withRouting({ policies: [{ id: 'p1', name: '内网', ipCidr: ['10.0.0.0/8'] }] })).rules, [HTTPS_RR_RULE, { rule_set: [FLIP_FALLBACK_TAG], server: 'dns-proxy' }])
})

test('代理 DNS 备用上游:并发竞速,谁先回 NOERROR 用谁的;没配备用时生成的配置一字不差(GitHub #151)', () => {
  const base = {
    dns: { split: true, mode: 'hijack', direct: '223.5.5.5', proxy: '1.1.1.1', proxyProtocol: 'tcp' },
    routing: { fallbackDefault: '香港-自动', policies: [{ id: 'g', name: 'Google', default: '香港-自动', domainSuffix: ['gstatic.com'] }] },
  }
  const opts = { groupTags: ['香港-自动'] }
  // 没配备用 = 老样子:一条 evaluate / respond 都没有
  const plain = rawBuildDns(base, opts)
  assert.equal(plain.rules.filter((r) => r.action === 'evaluate' || r.action === 'respond').length, 0)

  const raced = rawBuildDns({ ...base, dns: { ...base.dns, proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }] } }, opts)
  const flat = (r) => (r.type === 'logical' ? r : r)
  const evaluates = raced.rules.map(flat).filter((r) => r.action === 'evaluate')
  const responds = raced.rules.filter((r) => r.action === 'respond' && r.race === true)
  assert.ok(evaluates.length >= 2, `每条走代理的规则都要对每个上游各发起一次,实际 ${evaluates.length}`)
  assert.equal(responds.length, evaluates.length, '发起几次就有几条竞速应答规则')
  // 响应 tag 必须唯一:内核见到重复的 evaluate tag 直接 FATAL(真机 check 实测)
  const tags = evaluates.map((r) => r.tag)
  assert.equal(new Set(tags).size, tags.length, `响应 tag 重复了:${tags.join(', ')}`)
  for (const r of responds) assert.ok(tags.includes(r.match_response), `应答规则找不到对应的发起:${r.match_response}`)
  // 只认 NOERROR:上游回 SERVFAIL / NXDOMAIN 不算赢,留给别家
  for (const r of responds) assert.equal(r.response_rcode, 'NOERROR')
  // 备用上游各自一台解析器,detour 和主解析器相同(解析和流量还是同一条线路)
  const proxyServers = raced.servers.filter((x) => String(x.tag).startsWith('dns-proxy'))
  const primary = proxyServers.find((x) => x.tag === 'dns-proxy')
  const alt = proxyServers.find((x) => x.server === '8.8.8.8')
  assert.ok(alt, '备用上游要开解析器')
  assert.equal(alt.detour, primary.detour, '备用解析器要和主解析器走同一条线路')
  // 和主上游同地址的备用忽略掉,不重复开
  const dup = rawBuildDns({ ...base, dns: { ...base.dns, proxyExtras: [{ server: '1.1.1.1' }] } }, opts)
  assert.equal(dup.rules.filter((r) => r.action === 'evaluate').length, 0, '和主上游同地址的备用要被忽略')
})

test('ruleOwners:每条 dns.rules 都归到某一段(前置自定义 / 站点集 / 兜底),按站点集下标;直连站点集的规则命中时能找回它', () => {
  const profile = { dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: '1.1.1.1', fakeIpForProxy: true }, routing: { fallbackDefault: 'direct', custom: { rules: [{ type: 'domainSuffix', value: 'baidu.com', outbound: 'direct' }] }, policies: [
    { id: 's', name: 'Speed', domainSuffix: ['speedtest.net'], default: 'direct' },
    { id: 'w', name: '国外', rulesets: ['geosite-gfw', 'geoip-cloudflare'], default: '香港-自动' },
  ] } }
  const { dns, ruleOwners } = buildDnsWithResolvers(profile, { groupTags: ['香港-自动'] })
  const covered = new Set()
  for (const o of ruleOwners) for (let i = o.from; i < o.to; i++) covered.add(i)
  const kinds = ruleOwners.map((o) => `${o.kind}:${o.index}`)
  assert.ok(kinds.includes('custom:0') && kinds.includes('policy:0') && kinds.includes('policy:1'), kinds.join(','))
  assert.equal(ruleOwners.find((o) => o.kind === 'policy' && o.index === 0).name, 'Speed')
  // 站点集那几段之间没有缝(每段紧接上一段),兜底那段在最后
  const policy = ruleOwners.filter((o) => o.kind === 'policy')
  for (let i = 1; i < policy.length; i++) assert.equal(policy[i].from, policy[i - 1].to)
  assert.ok(ruleOwners.every((o) => o.to <= dns.rules.length))
  // Speed 那段里有一条是直连侧解析器
  const speed = ruleOwners.find((o) => o.name === 'Speed')
  assert.ok(dns.rules.slice(speed.from, speed.to).some((r) => r.server === 'dns-direct'))
})

// ---------- 代理侧 DNS 上游按目标分流走(用户 2026-09-28「全局就只有一个分流规则:目标分流」) ----------
test('applyProxyUpstreamRoutes:目标分流对每个代理侧上游的判定写进解析器的 detour——站点集 / 兜底写 selector,直连不写,拒绝写内置拒绝,判不出来保持兜底', () => {
  const profile = withRouting({ fallbackDefault: 'proxy' }, { dns: { ...base.dns, proxy: '1.1.1.1', proxyExtras: [{ server: '8.8.8.8', protocol: 'tcp' }, { server: '9.9.9.9', protocol: 'udp', port: 5353 }] } })
  const config = { dns: buildDns(profile, GROUPS) }
  assert.deepEqual(config.dns.servers.filter((s) => isProxyResolverTag(s.tag)).map((s) => [s.tag, s.detour]), [['dns-proxy', '其他'], ['dns-proxy__alt1', '其他'], ['dns-proxy__alt2', '其他']], '没判之前先写兜底')
  const applied = applyProxyUpstreamRoutes(config, [
    { server: '1.1.1.1', port: 53, protocol: 'tcp', outbound: '国外', reject: false },
    { server: '8.8.8.8', port: 53, protocol: 'tcp', outbound: DEFAULT_BUILTIN.direct, reject: false },
    { server: '9.9.9.9', port: 5353, protocol: 'udp', error: 'rule set unreadable' },
  ], DEFAULT_BUILTIN)
  assert.deepEqual(applied, [
    { tag: 'dns-proxy', server: '1.1.1.1', port: 53, detour: '国外' },
    { tag: 'dns-proxy__alt1', server: '8.8.8.8', port: 53, detour: '' },
    { tag: 'dns-proxy__alt2', server: '9.9.9.9', port: 5353, detour: '其他' },
  ])
  assert.equal('detour' in config.dns.servers.find((s) => s.tag === 'dns-proxy__alt1'), false, '直连不写 detour(显式 detour 到空的直连出站内核会拒)')
  applyProxyUpstreamRoutes(config, [{ server: '1.1.1.1', port: 53, protocol: 'tcp', outbound: '', reject: true }], DEFAULT_BUILTIN)
  assert.equal(config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, DEFAULT_BUILTIN.block, '目标分流拒绝这个地址,内核也不去访问')
})

test('isProxyResolverTag:按 tag 认代理侧解析器(含老版本部署的 dns-policy-N 这类),不看有没有 detour', () => {
  for (const tag of ['dns-proxy', 'dns-proxy__alt1', 'dns-policy-3', 'dns-custom-0__alt2', 'dns-client-1']) assert.equal(isProxyResolverTag(tag), true, tag)
  for (const tag of ['dns-direct', 'dns-direct__alt1', 'dns-terminal-direct', 'dns-fakeip', 'dns-local', 'dns-rewrite', '', undefined]) assert.equal(isProxyResolverTag(tag), false, String(tag))
})
