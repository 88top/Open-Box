import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { parseSubscription } from '../engine/subscription.mjs'
import { FLIP_FALLBACK_TAG, flipFlagContent } from '../engine/flip.mjs'
import { FALLBACK_TAG } from '../engine/routing-model.mjs'
import { listTagForUrl } from '../engine/rule-list.mjs'
import { ENGINE_VERSION, buildClientConfig } from '../engine/client-build.mjs'
import { replaceSubscriptionNodes } from '../engine/node-pool.mjs'
import { buildCurrentConfig } from './deploy-runner.mjs'
import { routerId } from './client-app.mjs'
import { CLIENT_DEVICES_KEY, buildClientBundle, registerClientConfigRoutes, registerPublicClientConfigRoutes } from './client-config.mjs'
import { BACKGROUND_IMAGE_KEY } from '../system/seed-defaults.mjs'
import { routeProxyDnsUpstreams } from './dns-upstream-route.mjs'

const sbBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tools/sing-box')
const hasBin = fs.existsSync(sbBin)

const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}

// 路由器上开着一堆手机用不上的东西:dnsmasq 转发、直连上游是局域网地址、DNS 重写、auto_redirect、终端分流、共享网络、IPv6
const seeded = () => {
  const store = memStore()
  const node = parseSubscription('ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@hk.example.com:8388#香港01').nodes[0]
  store.setSubscriptions([{ id: 'sub', name: '机场', url: 'https://sub.example/x' }])
  store.setNodes([{ ...node, subscriptionId: 'sub', tag: '香港-01' }])
  store.setGroups([{ id: 'grp', name: '香港-自动', type: 'urltest', mode: 'dynamic', keywords: [] }])
  store.setProfile({
    rejectQuic: true,
    ipv6: true,
    dns: {
      split: true, mode: 'dnsmasq', fakeIpForProxy: true, direct: '192.168.3.1',
      rewrite: { enabled: true, initialized: 1, rules: [{ id: 'r1', enabled: true, source: 'nas.test', addresses: ['192.168.3.9'] }] },
    },
    tun: { autoRedirect: true },
    clientRoutes: [{ id: 'c1', name: '电视', sources: ['10.0.0.9'], outbound: 'direct' }],
    servers: [{ id: 's1', enabled: true, name: '家里', protocol: 'shadowsocks', port: 8388, method: 'aes-256-gcm', password: 'x', address: 'home.example.com' }],
    routing: {
      fallbackDefault: '香港-自动',
      policies: [
        { id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn', 'geoip-cn'] },
        { id: 'ai', name: 'AI', default: '香港-自动', domainSuffix: ['openai.com'] },
      ],
    },
  })
  return store
}

// 随包 geodata 的替身:有内核就真编,没有就写个 SRS 头(只用来算摘要)
const makeGeoDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-client-geo-'))
  for (const tag of ['geosite-cn', 'geoip-cn']) {
    const out = path.join(dir, `${tag}.srs`)
    if (hasBin) {
      const src = path.join(dir, `${tag}.json`)
      const rule = tag.startsWith('geoip') ? { ip_cidr: ['1.2.3.0/24'] } : { domain_suffix: ['cn'] }
      fs.writeFileSync(src, JSON.stringify({ version: 3, rules: [rule] }))
      execFileSync(sbBin, ['rule-set', 'compile', '--output', out, src])
    } else {
      fs.writeFileSync(out, Buffer.from(`SRS-${tag}`))
    }
  }
  return dir
}

const env = () => {
  const store = seeded()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-client-root-'))
  return {
    store,
    geoDir: makeGeoDir(),
    paths: createPaths(root),
    // 没有 ip 命令、没有内核:局域网地址是空的,内核版本读不到;选择按档案默认
    ctx: createMockContext({ defaultExec: { code: 1, stdout: '', stderr: '' } }),
    fetchImpl: async () => { throw new Error('kernel not running') },
  }
}

// App 那头的解法:AES-256-GCM,密文末尾 16 字节是认证标签
const unseal = (sealed, key) => {
  const raw = Buffer.from(sealed.data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8'))
}

test('客户端配置:路由器专属的都去掉,路由器自己的配置一字不变', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const routerConfig = () => buildCurrentConfig(store, [], { rulesetDir: paths.rulesetDir, geoDir }).config
  const before = routerConfig()
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.deepEqual(routerConfig(), before, '生成客户端配置不能改动档案 / 路由器配置')
  assert.ok(before.inbounds.some((i) => i.auto_redirect), '路由器那份照旧开着 auto_redirect')

  assert.equal(bundle.format, 'open-box-client')
  assert.equal(bundle.router.id, routerId(store))
  assert.match(bundle.fingerprint, /^[0-9a-f]{16}$/)
  const config = bundle.config
  assert.equal(config.inbounds, undefined)
  assert.equal(config.experimental, undefined)
  assert.equal(config.log, undefined)
  const text = JSON.stringify(config)
  // 终端分流、DNS 重写服务、dnsmasq 回送、局域网直连上游都没了
  assert.ok(!text.includes('10.0.0.9'))
  assert.ok(!text.includes('7854'))
  assert.ok(!text.includes('192.168.3.1'))
  assert.ok(!config.outbounds.some((o) => o.tag === 'dnsmasq'))
  assert.deepEqual(config.dns.servers.find((s) => s.tag === 'dns-direct'), { type: 'local', tag: 'dns-direct' })
  assert.equal(config.dns.servers.find((s) => s.type === 'fakeip').inet4_range, '198.18.0.0/16')
  assert.equal(config.route.auto_detect_interface, true)
  for (const entry of config.route.rule_set) assert.match(entry.path, /^(rulesets\/.+\.srs|rulesets\/obnode-direct(-ip)?\.json|flip\/obflip-.+\.json)$/)
  // 订阅和节点站点直连:引用两份 source 规则集(地址不写进规则),内容在 ruleFiles,App 写成文件;不在要下载的 ruleSets 里
  assert.equal(bundle.version, 2)
  assert.deepEqual(config.route.rule_set.filter((e) => e.tag.startsWith('obnode-direct')), [
    { type: 'local', tag: 'obnode-direct', format: 'source', path: 'rulesets/obnode-direct.json' },
    { type: 'local', tag: 'obnode-direct-ip', format: 'source', path: 'rulesets/obnode-direct-ip.json' },
  ])
  assert.ok(config.route.rules.some((r) => JSON.stringify(r.rule_set) === JSON.stringify(['obnode-direct', 'obnode-direct-ip']) && r.outbound === bundle.directTag))
  const inline = (rules) => (rules || []).some((r) => JSON.stringify(r).includes('"hk.example.com"'))
  assert.ok(!inline(config.route.rules) && !inline(config.dns.rules), '节点域名不再写进路由 / DNS 规则')
  assert.deepEqual(Object.keys(bundle.ruleFiles), ['obnode-direct', 'obnode-direct-ip'])
  assert.ok(bundle.ruleFiles['obnode-direct'].rules[0].domain.includes('hk.example.com'))
  assert.ok(bundle.ruleFiles['obnode-direct'].rules[0].domain.includes('sub.example'))

  // 规则集:摘要和路由器上的文件一致;开关:国内此刻直连(关)、兜底此刻走代理(开)
  assert.deepEqual(bundle.ruleSets.map((r) => r.tag).sort(), ['geoip-cn', 'geosite-cn'])
  for (const r of bundle.ruleSets) {
    assert.equal(r.sha256, createHash('sha256').update(fs.readFileSync(path.join(geoDir, `${r.tag}.srs`))).digest('hex'))
    assert.equal(r.data, undefined, '扫码拿的 bundle 不带规则集内容')
  }
  const flags = Object.fromEntries(bundle.flags.map((f) => [f.selector, f]))
  assert.equal(flags['国内'].on, false)
  assert.equal(flags.AI.on, true)
  assert.equal(bundle.flags.find((f) => f.tag === FLIP_FALLBACK_TAG).on, true)
  assert.equal(bundle.directTag, config.outbounds.find((o) => o.type === 'direct').tag)
})

test('客户端配置:selector 默认值跟路由器此刻的选择走', async () => {
  const { store, geoDir, paths, ctx } = env()
  const fetchImpl = async () => ({ ok: true, json: async () => ({ proxies: { 国内: { now: '香港-自动' } } }) })
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(bundle.config.outbounds.find((o) => o.tag === '国内').default, '香港-自动')
  assert.equal(bundle.flags.find((f) => f.selector === '国内').on, true, '国内此刻走代理:开关跟着开')
})

test('客户端配置:view 给 App 的策略 / 节点 / 订阅页签,带用到的图标', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const sub = store.getSubscriptions()[0]
  store.setSubscriptions([
    { ...sub, updatedAt: 1700000000000, usage: { upload: 100, download: 200, total: 1000, expire: 1800000000, at: 1 }, autoUpdate: { enabled: true, days: 3, hour: 4 } },
    { id: 'off', name: '停用的', url: 'https://sub.example/y', enabled: false, autoUpdate: { enabled: true, mode: 'hours', hours: 6 } },
    { id: 'manual', name: '手动的', url: 'https://sub.example/z', autoUpdate: { enabled: false, days: 1, hour: 0 } },
  ])
  store.setGroups([...store.getGroups().map((g) => (g.name === '香港-自动' ? { ...g, icon: 'HK' } : g))])
  store.setProfile({
    routing: {
      displayOrder: ['AI', '不存在的'],
      fallbackIcon: 'brand:google',
      policies: [
        { id: 'cn', name: '国内', default: 'direct', rulesets: ['geosite-cn', 'geoip-cn'], icon: 'CN' },
        { id: 'ai', name: 'AI', default: '香港-自动', domainSuffix: ['openai.com'], icon: 'brand:openai' },
        { id: 'off', name: '停用站点集', enabled: false, domainSuffix: ['x.com'], icon: 'misc:pin' },
      ],
    },
    chainProxies: [{ id: 'c1', name: '链-美国', upstream: '香港-01', link: 'socks5://u:p@1.2.3.4:1080#x' }],
  })
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const { view } = bundle
  // 策略:displayOrder 里排过的(且真有)在前,其余按命中顺序,兜底在其中;停用的站点集不在
  assert.deepEqual(view.policies.map((p) => p.tag), ['AI', '国内', '其他'])
  assert.deepEqual(view.policies.map((p) => p.icon), ['brand:openai', 'CN', 'brand:google'])
  // 节点组:用户组,带类型和图标;内置直连 / 拒绝单列它们的图标
  const group = view.groups.find((g) => g.tag === '香港-自动')
  assert.deepEqual(group, { tag: '香港-自动', name: '香港-自动', icon: 'HK', type: 'urltest' })
  assert.ok(view.groups.every((g) => !g.tag.startsWith('__fo:')))
  assert.equal(view.builtins[bundle.directTag], 'misc:dart')
  // 订阅:流量 / 到期换成毫秒;停用的订阅节点不在配置里;链式代理单列
  const main = view.subscriptions.find((x) => x.id === 'sub')
  assert.deepEqual(main, {
    id: 'sub', name: '机场', enabled: true, nodes: ['香港-01'], upload: 100, download: 200, total: 1000, expire: 1800000000000, updatedAt: 1700000000000,
    autoUpdate: { enabled: true, days: 3, hour: 4 },
  })
  assert.deepEqual(view.subscriptions.find((x) => x.id === 'off').nodes, [])
  // 定期更新:按小时的原样带;没开的不带这个字段
  assert.deepEqual(view.subscriptions.find((x) => x.id === 'off').autoUpdate, { enabled: true, mode: 'hours', hours: 6 })
  assert.ok(!('autoUpdate' in view.subscriptions.find((x) => x.id === 'manual')))
  assert.deepEqual(view.subscriptions.find((x) => x.id === 'chain-proxy').nodes, ['链-美国'])
  // 图标:只带用到的,键照面板写法
  assert.deepEqual(Object.keys(view.icons).sort(), ['CN', 'HK', 'brand:google', 'brand:openai', 'misc:cross', 'misc:dart'])
  for (const svg of Object.values(view.icons)) assert.match(svg, /^<svg/)
  // view 算进指纹
  store.setGroups(store.getGroups().map((g) => (g.name === '香港-自动' ? { ...g, icon: 'JP' } : g)))
  const again = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.notEqual(again.fingerprint, bundle.fingerprint)
  assert.ok(again.view.icons.JP && !again.view.icons.HK)
})

test('客户端配置:故障转移组带页签(名字、图标、内核里的出站、失效成员),和 config.meta.json 同一份', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const [hk2, jp] = parseSubscription([
    'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@hk2.example.com:8388#香港02',
    'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@jp.example.com:8388#日本01',
  ].join('\n')).nodes
  store.setNodes([...store.getNodes(), { ...hk2, subscriptionId: 'sub', tag: '香港-02' }, { ...jp, subscriptionId: 'sub', tag: '日本-01' }])
  // 一个组最多三个页签:手动选择的页签放第二个组
  store.setGroups([...store.getGroups(), {
    id: 'fo', name: '香港-故转', type: 'failover', icon: 'HK',
    lanes: [
      { id: 'main', name: 'VW-HK-OS', icon: 'globe:asia', members: ['香港-01', '香港-02'] },
      { id: 'b1', members: ['日本-01', '已删的节点'] },
      { id: 'b2', name: '空的', members: ['已删的节点'] },
    ],
  }, {
    id: 'fo2', name: '手动-故转', type: 'failover',
    lanes: [{ id: 'm', name: '手动', manual: true, members: ['香港-01', '日本-01'] }],
  }])
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const fo = bundle.view.groups.find((g) => g.tag === '香港-故转')
  assert.equal(fo.type, 'failover')
  assert.deepEqual(fo.lanes, [
    { id: 'main', name: 'VW-HK-OS', icon: 'globe:asia', mode: 'urltest', ref: '__fo:fo:main', members: ['香港-01', '香港-02'], valid: ['香港-01', '香港-02'] },
    { id: 'b1', name: '', icon: '', mode: 'single', ref: '日本-01', members: ['日本-01', '已删的节点'], valid: ['日本-01'] },
    { id: 'b2', name: '空的', icon: '', mode: 'empty', ref: null, members: ['已删的节点'], valid: [] },
  ])
  const manual = bundle.view.groups.find((g) => g.tag === '手动-故转')
  assert.deepEqual(manual.lanes, [
    { id: 'm', name: '手动', icon: '', mode: 'selector', ref: '__fo:fo2:m', members: ['香港-01', '日本-01'], valid: ['香港-01', '日本-01'] },
  ])
  // ref 都是这份配置里真有的出站;内部子组不单列成节点组
  const tags = new Set(bundle.config.outbounds.map((o) => o.tag))
  for (const lane of [...fo.lanes, ...manual.lanes]) if (lane.ref) assert.ok(tags.has(lane.ref), lane.ref)
  assert.ok(bundle.view.groups.every((g) => !g.tag.startsWith('__fo:')))
  // 和路由器写进 config.meta.json 的同一份(部署那边的 buildCurrentConfig)
  const { failover } = buildCurrentConfig(store, [])
  assert.deepEqual(fo.lanes.map((l) => l.ref), failover.find((f) => f.tag === '香港-故转').lanes.map((l) => l.ref))
  // 页签自己的图标也带上;别的组没有 lanes
  assert.match(bundle.view.icons['globe:asia'], /^<svg/)
  assert.equal(bundle.view.groups.find((g) => g.tag === '香港-自动').lanes, undefined)
  // 组定义整份随包(App 手机上自动切页签用):和 App 用同一份 source 重算出来的一样,父组 / 页签引用和路由器的一样
  assert.deepEqual(bundle.failover, buildClientConfig({ source: bundle.source, nodes: bundle.source.nodes }).failover)
  assert.deepEqual(bundle.failover.map((f) => [f.tag, f.rejectTag, f.lanes.map((l) => l.ref)]), failover.map((f) => [f.tag, f.rejectTag, f.lanes.map((l) => l.ref)]))
})

test('客户端配置:bundle 带 source;用 source.nodes 重算(App 本机刷新订阅用的同一个函数)和 config / flags / view 逐字一样', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  // 加点复杂度:多一条停用的订阅、故障转移组、链式代理、DNS 分流(代理侧上游的线路要按目标分流判)
  const [jp, us] = parseSubscription([
    'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@jp.example.com:8388#日本01',
    'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@us.example.com:8388#美国01',
  ].join('\n')).nodes
  store.setSubscriptions([...store.getSubscriptions(), { id: 'off', name: '停用的', url: 'https://sub.example/off', enabled: false }])
  store.setNodes([...store.getNodes(), { ...jp, subscriptionId: 'sub', tag: '日本-01' }, { ...us, subscriptionId: 'off', tag: '美国-01' }])
  store.setGroups([...store.getGroups(), { id: 'fo', name: '故转', type: 'failover', lanes: [{ id: 'm', members: ['香港-01', '日本-01'] }, { id: 'b', members: ['日本-01'] }] }])
  const profile = store.getProfile()
  store.setProfile({ ...profile, chainProxies: [{ id: 'c1', name: '链-日本', upstream: '香港-01', link: 'socks5://u:p@1.2.3.4:1080#x' }] })

  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  // App 拿到的是 JSON:过一遍再算
  const source = JSON.parse(JSON.stringify(bundle.source))
  assert.equal(source.engineVersion, ENGINE_VERSION)
  assert.equal(source.nodes.length, 3)
  // 客户端补丁已经打上(终端分流、共享网络这些手机上没有)
  assert.deepEqual(source.profile.clientRoutes, [])
  assert.deepEqual(source.profile.servers, [])
  assert.equal(source.profile.dns.mode, 'hijack')
  const again = buildClientConfig({ source, nodes: source.nodes })
  assert.deepEqual(again.config, bundle.config)
  assert.deepEqual(again.flags, bundle.flags)
  assert.deepEqual(again.ruleFiles, bundle.ruleFiles)
  assert.equal(again.directTag, bundle.directTag)
  assert.deepEqual(again.view.subscriptions, bundle.view.subscriptions)
  assert.deepEqual(again.view.groups, bundle.view.groups)
  assert.deepEqual(again.ruleSets, bundle.ruleSets.map((r) => r.tag).filter((t) => again.ruleSets.includes(t)))

  // 手机本机刷新了「机场」:节点换成手机拉到的,配置跟着变;停用订阅的节点照样不进配置
  const phone = replaceSubscriptionNodes(source.nodes, source.subscriptions, [{ id: 'sub', nodes: [{ ...jp, tag: '日本-手机' }] }])
  const mine = buildClientConfig({ source, nodes: phone })
  const tags = mine.config.outbounds.map((o) => o.tag)
  assert.ok(tags.includes('日本-手机'))
  assert.ok(!tags.includes('香港-01') && !tags.includes('美国-01'))
  assert.deepEqual(mine.view.subscriptions.find((x) => x.id === 'sub').nodes, ['日本-手机'])
  // 故障转移的页签成员没了:页签变成空的
  assert.deepEqual(mine.view.groups.find((g) => g.tag === '故转').lanes.map((l) => l.mode), ['empty', 'empty'])
  // 节点站点直连换的是文件,路由 / DNS 规则不动(以后才能只换出站、不重启内核)
  assert.deepEqual(mine.config.route.rules, again.config.route.rules)
  assert.deepEqual(mine.config.dns.rules, again.config.dns.rules)
  assert.ok(mine.ruleFiles['obnode-direct'].rules[0].domain.includes('jp.example.com'))
  assert.ok(!mine.ruleFiles['obnode-direct'].rules[0].domain.includes('hk.example.com'))
  // 开关关掉:不引用、不出文件
  const off = buildClientConfig({ source: { ...source, profile: { ...source.profile, directForNodes: false } }, nodes: source.nodes })
  assert.deepEqual(off.ruleFiles, {})
  assert.ok(!off.config.route.rule_set.some((e) => e.tag.startsWith('obnode-direct')))
})

test('客户端配置:代理侧 DNS 上游的线路按目标分流判(和部署一样)', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const profile = store.getProfile()
  // 上游 9.9.9.9 被一个按 IP 分的站点集接住:解析器 detour 到那个站点集;不在任何站点集里就跟兜底
  store.setProfile({
    ...profile,
    dns: { ...profile.dns, proxy: '9.9.9.9', proxyProtocol: 'tcp' },
    routing: { ...profile.routing, policies: [{ id: 'dns', name: 'DNS上游', default: '香港-自动', ipCidr: ['9.9.9.9/32'] }, ...profile.routing.policies] },
  })
  const viaPolicy = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(viaPolicy.config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, 'DNS上游')
  store.setProfile({ ...store.getProfile(), dns: { ...store.getProfile().dns, proxy: '8.8.4.4' } })
  const viaFallback = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(viaFallback.config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, '其他')
})

test('客户端配置:判上游线路用的是手机那份规则表(profilePatch),不是路由器的', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const profile = store.getProfile()
  // 路由器开着 IPv6、代理线路的 v6 降为 IPv4:走代理的 v6 目标在路由器上会被拒绝;手机那份关了 IPv6,没有这条拒绝
  store.setProfile({
    ...profile,
    ipv6: true,
    ipv6Proxy: 'ipv4',
    dns: { ...profile.dns, proxy: '2606:4700:4700::1111', proxyProtocol: 'tcp' },
    routing: { ...profile.routing, policies: [{ id: 'dns', name: 'DNS上游', default: '香港-自动', ipCidr: ['2606:4700:4700::1111/128'] }, ...profile.routing.policies] },
  })
  const [onRouter] = await routeProxyDnsUpstreams({ store, ctx, paths, fetchImpl }, store.getProfile())
  assert.equal(onRouter.reject, true, '按路由器的规则表判:v6 目标走代理线路被拒绝')
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(bundle.config.dns.servers.find((s) => s.tag === 'dns-proxy').detour, 'DNS上游', '按手机的规则表判:落到那个站点集')
})

test('客户端配置按 App 的补法补齐后通过 sing-box check', { skip: hasBin ? false : '没有 panel/.tools/sing-box' }, async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-client-check-'))
  fs.mkdirSync(path.join(dir, 'rulesets'))
  fs.mkdirSync(path.join(dir, 'flip'))
  for (const r of bundle.ruleSets) fs.copyFileSync(path.join(geoDir, `${r.tag}.srs`), path.join(dir, 'rulesets', `${r.tag}.srs`))
  for (const f of bundle.flags) fs.writeFileSync(path.join(dir, 'flip', `${f.tag}.json`), flipFlagContent(f.on))
  for (const [tag, content] of Object.entries(bundle.ruleFiles)) fs.writeFileSync(path.join(dir, 'rulesets', `${tag}.json`), JSON.stringify(content))
  // 和 clients/core/obclient 的 BuildFullConfig 补的一样:tun、只听本机的 mixed、clash_api、cache_file、log
  const config = {
    ...bundle.config,
    log: { level: 'warn' },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, stack: 'mixed' },
      { type: 'mixed', tag: 'app-in', listen: '127.0.0.1', listen_port: 17890 },
    ],
    experimental: { clash_api: { external_controller: '127.0.0.1:19090', secret: 'x' }, cache_file: { enabled: true, path: 'cache.db', store_fakeip: true } },
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
  execFileSync(sbBin, ['check', '-c', path.join(dir, 'config.json'), '-D', dir])
})

test('接口:统一的一个码 → 拉加密配置 → 规则集 → 导出文件;以前按设备发的码收成一条', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const app = express()
  app.use(express.json())
  registerPublicClientConfigRoutes(app, { store, ctx, paths, fetchImpl, geoDir })
  registerClientConfigRoutes(app, { store, ctx, paths, fetchImpl, geoDir })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const codeNow = async () => (await fetch(`${base}/api/openbox/client-config`)).json()
  try {
    // 第一次取:没有就发一套
    const created = await codeNow()
    assert.equal(created.routerId, routerId(store))
    assert.match(created.token, /^[0-9a-f]{48}$/)
    assert.equal(Buffer.from(created.key, 'base64url').length, 32)
    assert.equal(created.device.key, undefined)
    assert.equal(created.device.lastSyncAt, 0)

    const url = `${base}/client/v1/${created.routerId}/config/${created.token}`
    const sealed = await (await fetch(url)).json()
    const bundle = unseal(sealed, created.key)
    assert.equal(bundle.format, 'open-box-client')
    assert.ok(!JSON.stringify(sealed).includes('hk.example.com'), '传输的是密文')

    // 码固定:再取还是同一个,带着最后同步时间
    const again = await codeNow()
    assert.equal(again.token, created.token)
    assert.equal(again.key, created.key)
    assert.ok(again.device.lastSyncAt > 0)
    assert.equal(JSON.parse(store.getRaw(CLIENT_DEVICES_KEY)).length, 1)

    const srs = await fetch(`${url}/rule-set/geosite-cn.srs`)
    assert.equal(srs.status, 200)
    assert.deepEqual(Buffer.from(await srs.arrayBuffer()), fs.readFileSync(path.join(geoDir, 'geosite-cn.srs')))
    assert.equal((await fetch(`${url}/rule-set/..%2F..%2Fetc%2Fpasswd`)).status, 404)
    // 认不出的码 / 换了路由器:404 unpaired,App 提示「配对失效,请重新配对」
    const unknown = await fetch(`${base}/client/v1/${created.routerId}/config/${'0'.repeat(48)}`)
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { error: 'unpaired' })
    assert.equal((await fetch(`${base}/client/v1/${'f'.repeat(32)}/config/${created.token}`)).status, 404)

    // 电源图标(用户 2026-10-07「点击可以关闭,这样避免泄露,需要同步时再打开」):关了以后码对也拉不到配置、规则集、背景,
    // 回 403 disabled;认不出的码照旧 404 unpaired;导出文件是登录后的,不受影响;打开后恢复
    const power = (enabled) => fetch(`${base}/api/openbox/client-config/enabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
    assert.equal(again.enabled, true)
    assert.deepEqual(await (await power(false)).json(), { enabled: false })
    assert.equal((await codeNow()).enabled, false)
    const blocked = await fetch(url)
    assert.equal(blocked.status, 403)
    assert.deepEqual(await blocked.json(), { error: 'disabled' })
    assert.equal((await fetch(`${url}/rule-set/geosite-cn.srs`)).status, 403)
    assert.equal((await fetch(`${url}/background`)).status, 403)
    assert.equal((await fetch(`${base}/client/v1/${created.routerId}/config/${'0'.repeat(48)}`)).status, 404)
    assert.equal((await fetch(`${base}/api/openbox/client-config/file`)).status, 200)
    assert.equal((await power('no')).status, 400)
    assert.deepEqual(await (await power(true)).json(), { enabled: true })
    assert.equal((await fetch(url)).status, 200)

    // 导出文件:geosite / geoip 随 App 安装包带,只列 tag / 摘要 / 大小、不带内容(码由面板界面放进 importCode)
    const file = await (await fetch(`${base}/api/openbox/client-config/file`)).json()
    const cnBytes = fs.readFileSync(path.join(geoDir, 'geosite-cn.srs'))
    assert.deepEqual(file.ruleSets.find((r) => r.tag === 'geosite-cn'), {
      tag: 'geosite-cn', sha256: createHash('sha256').update(cnBytes).digest('hex'), size: cnBytes.length,
    })
    // 按设备发码的接口没有了
    assert.equal((await fetch(`${base}/api/openbox/client-config/devices`)).status, 404)

    // 以前按设备发过码:留最近同步过、库里存着原码的那个,其余作废
    const device = (name, lastSyncAt, withToken = true) => {
      const token = randomBytes(24).toString('hex')
      return { id: `d-${name}`, name, ...(withToken ? { token } : {}), tokenHash: createHash('sha256').update(token).digest('hex'), key: randomBytes(32).toString('base64url'), createdAt: 1, lastSyncAt, lastSyncFrom: '' }
    }
    const older = device('旧手机', 100)
    const newer = device('手机', 200)
    const hashOnly = device('更早', 300, false)
    store.setRaw(CLIENT_DEVICES_KEY, JSON.stringify([older, newer, hashOnly]))
    const merged = await codeNow()
    assert.equal(merged.token, newer.token)
    assert.equal(merged.key, newer.key)
    assert.deepEqual(JSON.parse(store.getRaw(CLIENT_DEVICES_KEY)).map((d) => d.id), [newer.id])
    assert.equal((await fetch(`${base}/client/v1/${merged.routerId}/config/${newer.token}`)).status, 200)
    assert.equal((await fetch(`${base}/client/v1/${merged.routerId}/config/${older.token}`)).status, 404)
    // 一个原码都没有(都是更早只存摘要的):新发一套
    store.setRaw(CLIENT_DEVICES_KEY, JSON.stringify([hashOnly]))
    const fresh = await codeNow()
    assert.match(fresh.token, /^[0-9a-f]{48}$/)
    assert.equal(JSON.parse(store.getRaw(CLIENT_DEVICES_KEY)).length, 1)
    assert.equal((await codeNow()).token, fresh.token, '发了之后固定')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('客户端配置:view 带面板背景的元数据;导出文件带图片字节(不进指纹);图片接口要码对得上', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  const plain = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.equal(plain.view.background, null)

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 8, 7])
  store.setRaw('config/custom-background-image', 'local-image-1788361724032')
  store.setRaw(BACKGROUND_IMAGE_KEY, `data:image/jpeg;base64,${jpeg.toString('base64')}`)
  store.setRaw('config/dashboard-transparent', '84')
  store.setRaw('config/blur-intensity', '16')
  const version = createHash('sha256').update(jpeg).digest('hex').slice(0, 16)
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  assert.deepEqual(bundle.view.background, { version, transparent: 84, blur: 16 })
  assert.notEqual(bundle.fingerprint, plain.fingerprint, '换了背景,App 同步时要拿到')
  const file = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir, withData: true })
  assert.deepEqual(file.view.background, { version, transparent: 84, blur: 16, data: jpeg.toString('base64') })
  assert.equal(file.fingerprint, bundle.fingerprint, '图片字节不进指纹(version 已经跟着图走)')
  assert.deepEqual({ ...file.view, background: bundle.view.background }, bundle.view, 'view 别的部分一样')

  const app = express()
  registerPublicClientConfigRoutes(app, { store, ctx, paths, fetchImpl, geoDir })
  registerClientConfigRoutes(app, { store, ctx, paths, fetchImpl, geoDir })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const code = await (await fetch(`${base}/api/openbox/client-config`)).json()
    const image = await fetch(`${base}/client/v1/${code.routerId}/config/${code.token}/background`)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg)
    const unknown = await fetch(`${base}/client/v1/${code.routerId}/config/${'0'.repeat(48)}/background`)
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { error: 'unpaired' })
    store.setRaw('config/custom-background-image', '')
    assert.equal((await fetch(`${base}/client/v1/${code.routerId}/config/${code.token}/background`)).status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('客户端配置:站点集带域名穿透的展开清单,要解的 .srs 都随配置下发(App 本地展开、不再问路由器)', async () => {
  const { store, geoDir, paths, ctx, fetchImpl } = env()
  // 规则集链接:路由器上编出了域名、IP 两份(没有形状表时内核配置只引用域名那份,IP 那份要额外带上)
  const LIST_URL = 'https://lists.example/one.list'
  const L = listTagForUrl(LIST_URL)
  fs.mkdirSync(paths.rulesetDir, { recursive: true })
  fs.writeFileSync(path.join(paths.rulesetDir, `${L}.srs`), Buffer.from('SRS-list-domain'))
  fs.writeFileSync(path.join(paths.rulesetDir, `${L}-ip.srs`), Buffer.from('SRS-list-ip'))
  const profile = store.getProfile()
  store.setProfile({
    routing: {
      ...profile.routing,
      policies: [
        ...profile.routing.policies,
        { id: 'list', name: '名单', default: 'direct', ruleUrls: [LIST_URL] },
        // 手写条件不管字段怎么排,出来都是 domain → domain_suffix → domain_keyword → ip_cidr
        { id: 'mix', name: '手写', default: 'direct', ipCidr: ['10.1.0.0/16'], domainKeyword: ['kw'], domainSuffix: ['b.example'], domain: ['a.example'] },
      ],
    },
  })
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const drill = Object.fromEntries(bundle.view.policies.map((p) => [p.tag, p.drill]))
  assert.deepEqual(drill[FALLBACK_TAG], { fallback: true })
  assert.deepEqual(drill.AI, { fallback: false, custom: [{ type: 'domain_suffix', content: 'openai.com' }], rulesets: [] })
  assert.deepEqual(drill['国内'], {
    fallback: false, custom: [],
    rulesets: [{ tag: 'geosite-cn', source: 'geosite-cn', parts: ['geosite-cn'] }, { tag: 'geoip-cn', source: 'geoip-cn', parts: ['geoip-cn'] }],
  })
  assert.deepEqual(drill['名单'].rulesets, [{ tag: L, source: LIST_URL, parts: [L, `${L}-ip`] }])
  assert.deepEqual(drill['手写'].custom, [
    { type: 'domain', content: 'a.example' }, { type: 'domain_suffix', content: 'b.example' },
    { type: 'domain_keyword', content: 'kw' }, { type: 'ip_cidr', content: '10.1.0.0/16' },
  ])

  // 要解的每一份都在 ruleSets 里(配对时 App 照单下载);内核配置没引用的排在后面
  const tags = bundle.ruleSets.map((r) => r.tag)
  for (const p of bundle.view.policies) for (const r of p.drill.rulesets || []) for (const part of r.parts) assert.ok(tags.includes(part), part)
  const referenced = (bundle.config.route.rule_set || []).map((r) => r.tag)
  assert.ok(!referenced.includes(`${L}-ip`))
  assert.equal(tags.at(-1), `${L}-ip`)
  assert.equal(bundle.ruleSets.at(-1).sha256, createHash('sha256').update('SRS-list-ip').digest('hex'))
  // 导出文件:路由器编出来的照旧带内容(离线导入也能展开),geosite / geoip 不带(App 用安装包里的)
  const file = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir, withData: true })
  assert.equal(Buffer.from(file.ruleSets.find((r) => r.tag === `${L}-ip`).data, 'base64').toString(), 'SRS-list-ip')
  assert.equal(Buffer.from(file.ruleSets.find((r) => r.tag === L).data, 'base64').toString(), 'SRS-list-domain')
  for (const r of file.ruleSets.filter((x) => /^geo(site|ip)-/.test(x.tag))) assert.equal(r.data, undefined, r.tag)
  assert.deepEqual(file.ruleSets.map((r) => r.tag), bundle.ruleSets.map((r) => r.tag))
})

// 客户端那头(clients/core/obclient 的 BuildFullConfig)的测试吃的就是这里生成的模板:路由器这边的形状变了,
// 这条会失败,提醒去重新生成(OPENBOX_UPDATE_GOLDEN=1 node --test server/api/client-config.test.mjs),Go 那边再跑一遍
const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../clients/core/obclient/testdata/full-template.json')
// 只打包面板的检出里没有 clients/(比如发版用的 worktree),跳过;要重生成的时候照样写
test('客户端模板和 clients/core/obclient/testdata 里的一致', { skip: fs.existsSync(GOLDEN) || process.env.OPENBOX_UPDATE_GOLDEN === '1' ? false : '这个检出里没有 clients/' }, async () => {
  const { store, paths, ctx, fetchImpl } = env()
  const geoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/geodata')
  const bundle = await buildClientBundle({ store, ctx, paths, fetchImpl, geoDir })
  const golden = { config: bundle.config, flags: bundle.flags, directTag: bundle.directTag, ruleSets: bundle.ruleSets.map((r) => r.tag), ruleFiles: bundle.ruleFiles }
  if (process.env.OPENBOX_UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
    fs.writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')), golden)
})

