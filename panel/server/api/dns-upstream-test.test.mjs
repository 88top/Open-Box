import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { describeFetchFailure, registerDnsUpstreamTestRoutes } from './dns-upstream-test.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { builtinTags } from '../engine/user-groups.mjs'

const paths = createPaths('/opt/open-box')
const memStore = () => {
  const m = new Map()
  return createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
}
const FETCH_FAIL = async () => { throw new Error('no kernel') }
// routeFor / outboundsFor:目标分流对候选上游的判定、出口此刻落到的出站(真的实现见 api/dns-upstream-route.mjs、
// api/node-latency.mjs 的 upstreamOutbounds);默认判不出来 → 从路由器直连测
const NO_ROUTE = async () => ({ error: 'no rulesets' })
const startApp = async ({ ctx, store = memStore(), fetchImpl = FETCH_FAIL, systemDnsReader = async () => ['192.168.1.1'], routeFor = NO_ROUTE, outboundsFor = async () => { throw new Error('not used') }, platform = 'darwin' } = {}) => {
  const app = express()
  registerDnsUpstreamTestRoutes(app, { ctx, paths, store, fetchImpl, systemDnsReader, routeFor, outboundsFor, platform })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { ctx, store, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}
const post = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/api/openbox/dns/upstream-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const withKernel = (files = {}) => ({ [paths.singbox]: 'bin', ...files })
const fetchCall = (ctx) => ctx.calls.find((c) => c.cmd === paths.singbox && c.args[0] === 'tools' && c.args[1] === 'fetch')
const writtenConfig = (ctx) => JSON.parse(ctx.writes.find((w) => w.path.endsWith('config.dns-probe.json')).content)

test('参数校验:side / 地址（只收 IP）/ 协议;内核没装 → 503', async () => {
  const { baseUrl, close } = await startApp({ ctx: createMockContext({ files: withKernel() }) })
  try {
    assert.equal((await post(baseUrl, { side: 'x', server: '1.1.1.1', protocol: 'udp' })).status, 400)
    assert.equal((await post(baseUrl, { side: 'direct', server: 'dns.google', protocol: 'udp' })).status, 400)
    assert.equal((await post(baseUrl, { side: 'direct', server: 'https://1.1.1.1/dns-query', protocol: 'tcp' })).status, 400)
    assert.equal((await post(baseUrl, { side: 'direct', server: '1.1.1.1', protocol: 'doh' })).status, 400)
    assert.equal((await post(baseUrl, { side: 'direct', server: '1.1.1.1', protocol: 'tls' })).status, 400, '带域名的协议已撤掉')
    assert.equal((await post(baseUrl, { side: 'direct', server: '1.1.1.1', protocol: 'udp', port: 0 })).status, 400)
    assert.equal((await post(baseUrl, { side: 'direct', server: '1.1.1.1', protocol: 'udp', port: '53' })).status, 400)
  } finally {
    await close()
  }
  const bare = await startApp({ ctx: createMockContext() })
  try {
    assert.equal((await post(bare.baseUrl, { side: 'direct', server: '1.1.1.1', protocol: 'udp' })).status, 503)
  } finally {
    await bare.close()
  }
})

test('直连侧:临时配置只有候选那一台（按选的协议）,从路由器直接 tools fetch 直连测速地址;成功给耗时;临时配置用完删掉', async () => {
  const ctx = createMockContext({ files: withKernel() })
  const { baseUrl, close } = await startApp({ ctx })
  try {
    const { status, body } = await post(baseUrl, { side: 'direct', server: '223.5.5.5', protocol: 'tcp', port: 5353 })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.ms, 'number')
    assert.equal(body.via, '')
    assert.deepEqual({ server: body.server, protocol: body.protocol, port: body.port }, { server: '223.5.5.5', protocol: 'tcp', port: 5353 })
    const cfg = writtenConfig(ctx)
    assert.deepEqual(cfg.dns.servers, [{ type: 'tcp', tag: 'probe', server: '223.5.5.5', server_port: 5353 }])
    assert.equal(cfg.dns.strategy, 'ipv4_only', '没开 IPv6 只要 A,和正式内核一样')
    assert.equal(cfg.route.default_domain_resolver, 'probe')
    const call = fetchCall(ctx)
    assert.deepEqual(call.args.slice(0, 4), ['tools', 'fetch', '-c', `${paths.etc}/config.dns-probe.json`])
    assert.ok(!call.args.includes('-o'))
    assert.match(call.args.at(-1), /^http:\/\/connectivitycheck\.platform\.hicloud\.com/)
    assert.equal(`${paths.etc}/config.dns-probe.json` in ctx.files, false, '临时配置用完删掉')
  } finally {
    await close()
  }
})

// 代理侧:连上游走哪条线路由目标分流按候选上游的地址判(用户 2026-09-28「全局就只有一个分流规则:目标分流」),
// 和规则页查这个地址、和部署时写进内核代理侧解析器的是同一套
const HK_OUT = { type: 'shadowsocks', tag: 'HK-01', server: 'hk.example.com', server_port: 8388, method: 'aes-256-gcm', password: 'pw' }
test('代理侧:按目标分流判出的出口测——出口此刻落到的节点放进临时配置,候选服务器 detour 到它;fetch 走 direct 且 direct 的域名解析钉在候选服务器上(不能 -o 从节点出去);节点域名由 bootstrap(直连 DNS:默认上游 DNS,填了 IP 用 IP)解析;显示同规则页', async () => {
  const seen = []
  const routeFor = async (_deps, up) => { seen.push(up); return { ...up, outbound: '国外', reject: false, owner: { kind: 'policy', name: '国外' }, chain: ['国外', '香港-故转', 'HK-01'], ruleIndex: 49 } }
  const outboundsFor = async ({ upstream }) => { seen.push(upstream); return { via: 'HK-01', outbounds: [{ ...HK_OUT }], dnsServers: [] } }
  const ctx = createMockContext({ files: withKernel() })
  const { baseUrl, store, close } = await startApp({ ctx, routeFor, outboundsFor })
  try {
    const { body } = await post(baseUrl, { side: 'proxy', server: '8.8.8.8', protocol: 'udp' })
    assert.equal(body.ok, true)
    assert.deepEqual(seen, [{ protocol: 'udp', server: '8.8.8.8', port: 53 }, '国外'], '按候选上游(地址、端口、协议)判,再取出口「国外」此刻的节点')
    assert.equal(body.via, '香港-故转 → HK-01', '链路开头的站点集去掉,和规则页一样')
    assert.deepEqual(body.chain, ['香港-故转', 'HK-01'], '逐跳交给前端(故障转移的内部子组它换成页签名)')
    assert.equal(body.policy, '国外')
    assert.equal(body.note, undefined)
    const cfg = writtenConfig(ctx)
    assert.deepEqual(cfg.dns.servers, [
      { type: 'udp', tag: 'bootstrap', server: '192.168.1.1' },
      { type: 'udp', tag: 'probe', server: '8.8.8.8', detour: 'HK-01' },
    ])
    assert.equal(cfg.dns.final, 'bootstrap')
    assert.equal(cfg.dns.strategy, 'ipv4_only', '节点域名只解析 A:运营商 DNS 回 AAAA、往 v6 发包在路由器上是 operation not permitted')
    assert.equal(cfg.route.default_domain_resolver, 'bootstrap')
    assert.equal(cfg.route.final, 'direct')
    assert.deepEqual(cfg.outbounds[0], { type: 'direct', tag: 'direct', domain_resolver: { server: 'probe' } })
    assert.deepEqual(cfg.outbounds[1], HK_OUT)
    const call = fetchCall(ctx)
    assert.ok(!call.args.includes('-o'), JSON.stringify(call.args))
    assert.equal(call.args.at(-1), 'http://connectivitycheck.platform.hicloud.com/generate_204')
    // 直连 DNS 填了 IP:bootstrap 用它
    store.setProfile({ dns: { direct: '223.5.5.5', directExtras: [] } })
    assert.equal((await post(baseUrl, { side: 'proxy', server: '8.8.8.8', protocol: 'udp' })).body.ok, true)
    const again = JSON.parse(ctx.writes.filter((w) => w.path.endsWith('config.dns-probe.json')).at(-1).content)
    assert.deepEqual(again.dns.servers[0], { type: 'udp', tag: 'bootstrap', server: '223.5.5.5' })
  } finally {
    await close()
  }
})

test('代理侧:目标分流让这个地址走直连(命中直连的站点集,或站点集此刻选着直连)→ 从路由器直连测,这就是真实路径', async () => {
  const store = memStore()
  const direct = builtinTags(store.getGroups()).direct
  for (const route of [
    { outbound: direct, owner: { kind: 'policy', name: '国内' }, chain: [direct] },
    { outbound: '国外', owner: { kind: 'policy', name: '国外' }, chain: ['国外', direct] },
  ]) {
    const ctx = createMockContext({ files: withKernel() })
    const { baseUrl, close } = await startApp({ ctx, store, routeFor: async (_d, up) => ({ ...up, reject: false, ruleIndex: 3, ...route }), outboundsFor: async () => assert.fail('走直连不用生成出站') })
    try {
      const { body } = await post(baseUrl, { side: 'proxy', server: '1.1.1.1', protocol: 'tcp' })
      assert.equal(body.ok, true)
      assert.equal(body.via, '')
      assert.equal(body.note, `按目标分流,1.1.1.1 走直连(「${route.owner.name}」)`)
      assert.deepEqual(writtenConfig(ctx).dns.servers, [{ type: 'tcp', tag: 'probe', server: '1.1.1.1' }])
      assert.ok(!fetchCall(ctx).args.includes('-o'))
    } finally {
      await close()
    }
  }
})

test('代理侧:目标分流拒绝这个地址 → 不测,直接说内核不会去问它', async () => {
  const ctx = createMockContext({ files: withKernel() })
  const { baseUrl, close } = await startApp({ ctx, routeFor: async (_d, up) => ({ ...up, reject: true, outbound: '', ruleIndex: 4, owner: { kind: 'custom', name: '前置自定义' }, chain: [] }) })
  try {
    const { body } = await post(baseUrl, { side: 'proxy', server: '1.1.1.1', protocol: 'tcp' })
    assert.equal(body.ok, false)
    assert.equal(body.error, '目标分流拒绝访问 1.1.1.1(第 5 条,「前置自定义」),内核不会去问它')
    assert.equal(fetchCall(ctx), undefined)
  } finally {
    await close()
  }
})

test('代理侧:判不出线路(规则集读不了)或出口此刻落在测不了的出站上 → 退回从路由器直连测,note 说明', async () => {
  const noRoute = createMockContext({ files: withKernel() })
  const a = await startApp({ ctx: noRoute })
  try {
    const { body } = await post(a.baseUrl, { side: 'proxy', server: '1.1.1.1', protocol: 'tcp' })
    assert.equal(body.ok, true)
    assert.equal(body.port, 53, '没传端口按默认 53')
    assert.equal(body.via, '')
    assert.match(body.note, /判不出 1\.1\.1\.1 走哪条线路.*直连测/)
    assert.deepEqual(writtenConfig(noRoute).dns.servers, [{ type: 'tcp', tag: 'probe', server: '1.1.1.1' }])
  } finally {
    await a.close()
  }
  const wg = createMockContext({ files: withKernel() })
  const b = await startApp({
    ctx: wg,
    routeFor: async (_d, up) => ({ ...up, reject: false, outbound: '国外', owner: { kind: 'policy', name: '国外' }, chain: ['国外', 'WG-01'], ruleIndex: 9 }),
    outboundsFor: async () => { throw new Error('上游「国外」此刻落在「WG-01」,不是可以测的节点') },
  })
  try {
    const { body } = await post(b.baseUrl, { side: 'proxy', server: '1.1.1.1', protocol: 'tcp' })
    assert.equal(body.ok, true)
    assert.equal(body.via, '')
    assert.match(body.note, /线路「国外」此刻测不了.*直连测/)
  } finally {
    await b.close()
  }
})

test('Linux 上临时实例自己的包打内核出站标记(和节点测速一样):不打的话正在跑的内核把它当本机流量接走,走 UDP 的节点(TUIC)直接 operation not permitted', async () => {
  const routeFor = async (_d, up) => ({ ...up, reject: false, outbound: '国外', owner: { kind: 'policy', name: '国外' }, chain: ['国外', 'HK-01'], ruleIndex: 49 })
  const outboundsFor = async () => ({ via: 'HK-01', outbounds: [{ ...HK_OUT }], dnsServers: [] })
  for (const side of ['proxy', 'direct']) {
    const ctx = createMockContext({ files: withKernel() })
    const { baseUrl, close } = await startApp({ ctx, routeFor, outboundsFor, platform: 'linux' })
    try {
      await post(baseUrl, { side, server: '1.1.1.1', protocol: 'tcp' })
      assert.equal(writtenConfig(ctx).route.default_mark, 0x2024, side)
    } finally {
      await close()
    }
  }
  // 按直连测(目标分流判成直连 / 判不出来)也打
  const ctx = createMockContext({ files: withKernel() })
  const { baseUrl, close } = await startApp({ ctx, platform: 'linux' })
  try {
    await post(baseUrl, { side: 'proxy', server: '1.1.1.1', protocol: 'tcp' })
    assert.equal(writtenConfig(ctx).route.default_mark, 0x2024)
  } finally {
    await close()
  }
  // macOS(本机开发)不认 default_mark,整个实例会 FATAL:不写
  const mac = createMockContext({ files: withKernel() })
  const m = await startApp({ ctx: mac, routeFor, outboundsFor })
  try {
    await post(m.baseUrl, { side: 'proxy', server: '1.1.1.1', protocol: 'tcp' })
    assert.equal(writtenConfig(mac).route.default_mark, undefined)
  } finally {
    await m.close()
  }
})

test('解析失败按 stderr 的 lookup 原因翻译;进程超时（没输出）算超时;解析通了但取网页失败仍算可用并带 warning', async () => {
  const cmd = (extra) => [paths.singbox, 'tools', 'fetch', '-c', `${paths.etc}/config.dns-probe.json`, ...extra, 'http://connectivitycheck.platform.hicloud.com/generate_204'].join(' ')
  const host = 'connectivitycheck.platform.hicloud.com'
  const cases = [
    { stderr: `FATAL[0010] Get "http://${host}/generate_204": lookup ${host}: (exchange6: context deadline exceeded | exchange4: context deadline exceeded)`, ok: false, error: /超时/ },
    { stderr: `FATAL[0005] Get "http://${host}/generate_204": lookup ${host}: (exchange6: dial TLS connection: read tcp 1.2.3.4:1->5.6.7.8:853: read: connection reset by peer | exchange4: x)`, ok: false, error: /重置/ },
    { stderr: `FATAL[0000] Get "http://${host}/generate_204": lookup ${host}: (exchange6: NXDOMAIN | exchange4: NXDOMAIN)`, ok: false, error: /NXDOMAIN/ },
    { stderr: '', ok: false, error: /超时/ },
    { stderr: `FATAL[0003] Get "http://${host}/generate_204": dial tcp 1.2.3.4:80: i/o timeout`, ok: true, warning: /取测速地址失败/ },
  ]
  for (const c of cases) {
    const ctx = createMockContext({ files: withKernel(), execResults: { [cmd([])]: { code: 1, stderr: c.stderr } } })
    const { baseUrl, close } = await startApp({ ctx })
    try {
      const { body } = await post(baseUrl, { side: 'direct', server: '1.1.1.1', protocol: 'tcp' })
      assert.equal(body.ok, c.ok, c.stderr)
      if (c.error) assert.match(body.error, c.error, c.stderr)
      if (c.warning) assert.match(body.warning, c.warning, c.stderr)
    } finally {
      await close()
    }
  }
})

test('describeFetchFailure:剥 ANSI 色码,取第一路的原因', () => {
  const r = describeFetchFailure('\x1b[31mFATAL\x1b[0m[0010] Get "http://x.example/": lookup x.example: (exchange4: dial TLS connection: context deadline exceeded | exchange6: y)\n', 'x.example')
  assert.equal(r.dnsFailed, true)
  assert.match(r.reason, /超时/)
  assert.deepEqual(describeFetchFailure('FATAL[0001] Get "http://x.example/": dial tcp: connection refused', 'x.example'), { dnsFailed: false, reason: 'Get "http://x.example/": dial tcp: connection refused' })
})

test('开着 IPv6 时临时实例和正式内核一样 prefer_ipv4', async () => {
  const store = memStore()
  store.setProfile({ ipv6: true })
  const ctx = createMockContext({ files: withKernel() })
  const { baseUrl, close } = await startApp({ ctx, store })
  try {
    await post(baseUrl, { side: 'direct', server: '223.5.5.5', protocol: 'udp' })
    assert.equal(writtenConfig(ctx).dns.strategy, 'prefer_ipv4')
  } finally {
    await close()
  }
})

test('上游 DNS(wan):测系统此刻上游 DNS 的第一台,代理侧也从路由器直连测(不按目标分流判),回的 server 是那台的地址;GET /dns/wan 给出系统的上游 DNS', async () => {
  const seen = []
  const routeFor = async (_deps, up) => { seen.push(up); return { ...up, outbound: '国外', reject: false, owner: null, chain: [], ruleIndex: 0 } }
  const ctx = createMockContext({ files: withKernel() })
  const store = memStore()
  store.setProfile({ dns: { region: 'intl' } })
  const { baseUrl, close } = await startApp({ ctx, store, routeFor, systemDnsReader: async () => ['81.2.69.142', '81.2.69.143'] })
  try {
    const { body } = await post(baseUrl, { side: 'proxy', server: 'wan', protocol: 'tcp', port: 5353 })
    assert.equal(body.ok, true)
    assert.equal(body.wan, true)
    assert.equal(body.server, '81.2.69.142')
    assert.equal(body.port, 53, '上游 DNS 固定 53 端口,传了别的也不认')
    assert.equal(body.protocol, 'udp', '上游 DNS 固定 UDP,协议跟着上游走')
    assert.match(body.note, /固定直连/)
    assert.deepEqual(seen, [], '不按目标分流判')
    assert.deepEqual(writtenConfig(ctx).dns.servers, [{ type: 'udp', tag: 'probe', server: '81.2.69.142' }])
    const wan = await (await fetch(`${baseUrl}/api/openbox/dns/wan`)).json()
    assert.deepEqual(wan, { servers: ['81.2.69.142', '81.2.69.143'] })
  } finally {
    await close()
  }
})

test('POST /dns/region-detect:按出口公网 IP 判一次路由器在哪,判不出 region 是 null(「恢复默认」先调它)', async () => {
  const calls = []
  const answers = [{ region: 'cn', ip: '39.129.157.217' }, { region: null, ip: '' }]
  const ctx = createMockContext({ files: withKernel() })
  const app = express()
  registerDnsUpstreamTestRoutes(app, { ctx, paths, store: memStore(), detectRegion: async (deps) => { calls.push(deps.timeoutMs); return answers.shift() } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${server.address().port}/api/openbox/dns/region-detect`
  try {
    assert.deepEqual(await (await fetch(url, { method: 'POST' })).json(), { region: 'cn', ip: '39.129.157.217' })
    assert.deepEqual(await (await fetch(url, { method: 'POST' })).json(), { region: null, ip: '' })
    assert.ok(calls.every((t) => t > 0 && t < 15000), '界面上有人等着,超时比后台判的短')
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('GET /dns/region-detect 给出启动时那次后台判定还在不在等;POST 判出的地区和档案一样就顺手清掉待判定', async () => {
  const store = memStore()
  store.setProfile({ dns: { region: 'cn' } })
  store.setRaw('openbox/dns-region-detect', 'pending')
  const ctx = createMockContext({ files: withKernel() })
  const answers = [{ region: 'intl', ip: '131.117.188.66' }, { region: 'cn', ip: '39.129.157.217' }]
  const app = express()
  registerDnsUpstreamTestRoutes(app, { ctx, paths, store, detectRegion: async () => answers.shift() })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${server.address().port}/api/openbox/dns/region-detect`
  try {
    assert.deepEqual(await (await fetch(url)).json(), { pending: true, region: 'cn' })
    // 判成中国大陆之外、档案还是中国大陆:由卡片保存地区时清(PUT 带 dns.region),这里不动
    await fetch(url, { method: 'POST' })
    assert.deepEqual(await (await fetch(url)).json(), { pending: true, region: 'cn' })
    // 判成中国、档案也是中国:「恢复默认」不会再保存,这里清掉
    await fetch(url, { method: 'POST' })
    assert.deepEqual(await (await fetch(url)).json(), { pending: false, region: 'cn' })
    // 档案里的地区变了(后台判完),状态里跟着变:卡片拿它和页面上的比
    store.setProfile({ dns: { region: 'intl', proxy: 'wan' } })
    assert.deepEqual(await (await fetch(url)).json(), { pending: false, region: 'intl' })
  } finally {
    await new Promise((r) => server.close(r))
  }
})
