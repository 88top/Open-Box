import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import express from 'express'
import { registerNodeLatencyRoutes } from './node-latency.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createNode } from '../engine/node-model.mjs'
import { createLatencyHistory } from '../system/latency-history.mjs'

const paths = createPaths('/opt/open-box')

// 域名默认解析到公网地址;负向用例单独注入。
const fakeLookup = async (hostname) => {
  const trimmed = String(hostname).replace(/^\[|\]$/g, '').trim()
  const v = net.isIP(trimmed)
  if (v) return [{ address: trimmed, family: v }]
  return [{ address: '8.8.8.8', family: 4 }]
}

const SUB = [
  'ss://YWVzLTI1Ni1nY206cHc=@a.example.com:8388#HK-01',
  'trojan://pw@b.example.com:443?sni=b.example.com#JP-01',
].join('\n')

// 测速实例(system/node-probe.mjs)在这里换成假的:记下每次交给它的出站 / 任务,按 tag 回预设结果。
// 实例本身怎么起、怎么测,见 node-probe.test.mjs
const fakeProber = (scripted = {}) => {
  const calls = []
  return {
    calls,
    run: async (opts) => {
      calls.push(JSON.parse(JSON.stringify(opts)))
      // 和真的一样:实例里没有这个出站就是 not-found
      const known = new Set([...(opts.outbounds || []), ...(opts.endpoints || [])].map((o) => o.tag))
      return opts.jobs.map((j) => (known.has(j.tag) ? scripted[j.tag] || { ok: true, ms: 42 } : { ok: false, reason: 'not-found' }))
    },
  }
}

const memStore = () => {
  const mem = new Map()
  return createStore({ get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), del: (k) => mem.delete(k) })
}

const startApp = async ({ ctx = createMockContext(), lookup = fakeLookup, prober = fakeProber(), store = null, history = null, fetchImpl = async () => { throw new Error('no net') }, kernelStale = null } = {}) => {
  const app = express()
  registerNodeLatencyRoutes(app, { ctx, paths, store, fetchImpl, lookup, prober, history, kernelStale, now: () => Date.parse('2026-09-22T08:00:00Z') })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { ctx, prober, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

const post = (baseUrl, body) =>
  fetch(`${baseUrl}/api/openbox/nodes/latency`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// ---------- 修改 / 添加订阅弹窗:还没保存的节点 ----------
test('弹窗:tags 为空 → 400;目标过多 → 400', async () => {
  const { baseUrl, close } = await startApp()
  try {
    assert.equal((await post(baseUrl, { content: SUB, tags: [] })).status, 400)
    const res = await post(baseUrl, { content: SUB, tags: Array.from({ length: 101 }, (_, i) => `t${i}`) })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /too many/)
  } finally {
    await close()
  }
})

test('弹窗:和订阅卡片同一个测速实例测;出站 tag 用 probe-N(节点名可能重复、含特殊字符),只放要测的节点;结果与 tags 一一对应', async () => {
  const prober = fakeProber({ 'probe-2': { ok: false, reason: 'closed', error: 'use of closed network connection' } })
  const { baseUrl, close } = await startApp({ prober })
  try {
    const res = await post(baseUrl, { content: SUB, tags: ['JP-01', '不存在', 'HK-01'], testUrl: 'http://cp.cloudflare.com/', timeoutMs: 4000 })
    assert.equal(res.status, 200)
    const { results } = await res.json()
    assert.deepEqual(results[0], { ok: true, ms: 42 })
    assert.deepEqual(results[1], { ok: false, reason: 'not-found', error: 'not found' })
    assert.deepEqual(results[2], { ok: false, reason: 'closed', error: 'use of closed network connection' })
    assert.equal(prober.calls.length, 1, '一批只起一个实例')
    const [call] = prober.calls
    assert.deepEqual(call.outbounds.map((o) => [o.tag, o.type]), [['probe-0', 'trojan'], ['probe-2', 'shadowsocks']])
    assert.deepEqual(call.jobs, [{ tag: 'probe-0', url: 'http://cp.cloudflare.com/' }, { tag: 'probe-2', url: 'http://cp.cloudflare.com/' }])
    assert.equal(call.timeoutMs, 4000)
  } finally {
    await close()
  }
})

// 以前弹窗挡内网 / 回环地址的节点,订阅卡片却能测——两种结果。现在统一:照测
test('弹窗:节点服务器是内网 / 回环地址也照测(和订阅卡片一样)', async () => {
  const { baseUrl, prober, close } = await startApp({ lookup: async () => [{ address: '192.168.3.1', family: 4 }] })
  try {
    const [r] = (await (await post(baseUrl, { content: SUB, tags: ['HK-01'] })).json()).results
    assert.deepEqual(r, { ok: true, ms: 42 })
    assert.deepEqual(prober.calls[0].jobs.map((j) => j.tag), ['probe-0'])
  } finally {
    await close()
  }
})

// ---------- 订阅卡片 / 代理页:面板此刻存的节点 ----------
const storedWorld = () => {
  const store = memStore()
  store.setSubscriptions([{ id: 's1', name: '多宝', enabled: true }])
  store.setNodes([
    createNode({ tag: '多宝 | 美国-01', type: 'shadowsocks', server: 'us.example.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'new-pw' }, source: 'clash', subscriptionId: 's1' }),
    createNode({ tag: '多宝 | 香港-01', type: 'shadowsocks', server: 'hk.example.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'new-pw' }, source: 'clash', subscriptionId: 's1' }),
  ])
  return { store, history: createLatencyHistory({ store }) }
}

test('卡片 / 代理页:内核没在跑时测的是面板此刻存的节点(和部署生成得一样,临时测速实例);内置直连是一个 direct 出站;组 / 不在订阅里的回 not-found', async () => {
  const { store, history } = storedWorld()
  const prober = fakeProber({ '多宝 | 香港-01': { ok: false, reason: 'timeout' } })
  const { baseUrl, close } = await startApp({ store, history, prober })
  try {
    const res = await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01' }, { tag: '多宝 | 香港-01', url: 'http://cp.cloudflare.com/' }, { tag: '直连', url: 'http://connect.rom.miui.com/generate_204' }, { tag: '所有-自动' }], timeoutMs: 5000 })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.results[0], { ok: true, ms: 42 })
    assert.deepEqual(body.results[1], { ok: false, reason: 'timeout' })
    assert.deepEqual(body.results[2], { ok: true, ms: 42 })
    assert.deepEqual(body.results[3], { ok: false, reason: 'not-found' })
    const [call] = prober.calls
    const us = call.outbounds.find((o) => o.tag === '多宝 | 美国-01')
    assert.equal(us.password, 'new-pw', '用的是面板存的新密码')
    assert.deepEqual(call.outbounds.find((o) => o.tag === '直连'), { type: 'direct', tag: '直连' })
    // 没传 url 的用档案里的测速地址
    assert.equal(call.jobs[0].url, 'http://www.gstatic.com/generate_204')
    assert.equal(call.jobs[1].url, 'http://cp.cloudflare.com/')
  } finally {
    await close()
  }
})

test('卡片 / 代理页:结果记进延迟历史(src:probe,失败带原因);record:false 的(IPv6 探测)和 not-found 不记;响应里带整份历史', async () => {
  const { store, history } = storedWorld()
  const prober = fakeProber({ '多宝 | 香港-01': { ok: false, reason: 'closed', error: 'use of closed network connection' } })
  const { baseUrl, close } = await startApp({ store, history, prober })
  try {
    const body = await (await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01' }, { tag: '多宝 | 香港-01' }, { tag: '多宝 | 美国-01', url: 'http://ipv6.example/', record: false }, { tag: '没有这个' }] })).json()
    assert.deepEqual(body.history['多宝 | 美国-01'], [{ time: '2026-09-22T08:00:00.000Z', delay: 42, src: 'probe' }])
    assert.deepEqual(body.history['多宝 | 香港-01'], [{ time: '2026-09-22T08:00:00.000Z', delay: 0, reason: 'closed', src: 'probe' }])
    assert.equal(body.history['没有这个'], undefined)
  } finally {
    await close()
  }
})

// 审查第十三项:同一个节点、同一个测速地址重复出现只测一次、只记一笔;结果仍按请求的顺序一一对应
test('卡片 / 代理页:重复的 (节点, 测速地址) 只测一次、只记一笔历史;要记和不记的重了按要记算', async () => {
  const { store, history } = storedWorld()
  const prober = fakeProber()
  const { baseUrl, close } = await startApp({ store, history, prober })
  try {
    const body = await (await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01', record: false }, { tag: '多宝 | 香港-01' }, { tag: '多宝 | 美国-01' }, { tag: '多宝 | 美国-01', url: 'http://ipv6.example/', record: false }] })).json()
    assert.equal(body.results.length, 4)
    assert.deepEqual(body.results[0], body.results[2])
    assert.deepEqual(prober.calls[0].jobs.map((j) => j.tag), ['多宝 | 美国-01', '多宝 | 香港-01', '多宝 | 美国-01'], '同地址的重复只剩一条,IPv6 那条地址不同照测')
    assert.equal(body.history['多宝 | 美国-01'].length, 1, '只记一笔')
  } finally {
    await close()
  }
})

// 审查第十三项:订阅里有同名的原始节点时,第 k 次出现的名字对第 k 个同名节点;单独测一行用 occurrences 说明是第几个
test('弹窗:同名的原始节点按出现顺序对应,不再都测成第一个;occurrences 指定第几个', async () => {
  const dup = [
    'ss://YWVzLTI1Ni1nY206cHc=@a.example.com:8388#HK-01',
    'ss://YWVzLTI1Ni1nY206cHc=@z.example.com:8388#HK-01',
  ].join('\n')
  const prober = fakeProber()
  const { baseUrl, close } = await startApp({ prober })
  try {
    await post(baseUrl, { content: dup, tags: ['HK-01', 'HK-01'] })
    assert.deepEqual(prober.calls[0].outbounds.map((o) => o.server), ['a.example.com', 'z.example.com'])
    await post(baseUrl, { content: dup, tags: ['HK-01'], occurrences: [1] })
    assert.deepEqual(prober.calls[1].outbounds.map((o) => o.server), ['z.example.com'])
  } finally {
    await close()
  }
})

test('卡片 / 代理页:jobs 格式不对 → 400', async () => {
  const { store, history } = storedWorld()
  const { baseUrl, close } = await startApp({ store, history })
  try {
    assert.equal((await post(baseUrl, { jobs: [] })).status, 400)
    assert.equal((await post(baseUrl, { jobs: [{ tag: '' }] })).status, 400)
    assert.equal((await post(baseUrl, { jobs: [{ tag: 'a', url: 'ftp://x' }] })).status, 400)
  } finally {
    await close()
  }
})

// ---------- 链式代理:编辑框里的测速 / IP 地区(POST /chain-proxies/latency) ----------

const chainStore = () => {
  const mem = new Map()
  const store = createStore({ get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), del: (k) => mem.delete(k) })
  store.setNodes([
    createNode({ tag: 'HK-01', type: 'shadowsocks', server: 'hk.example.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'pw' }, source: 'clash', subscriptionId: 's1' }),
    createNode({ tag: 'HK-02', type: 'shadowsocks', server: 'hk2.example.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'pw' }, source: 'clash', subscriptionId: 's1' }),
  ])
  store.setProfile({ chainProxies: [{ id: 'c1', enabled: true, name: '已有链', link: 'http://u:p@gw.example.com:5001', upstream: '香港-自动' }] })
  return store
}
// 内核此刻的选择(GET /proxies 的 now)
const kernelNow = (proxies) => async (url) => {
  if (String(url).endsWith('/proxies')) return new Response(JSON.stringify({ proxies }), { headers: { 'content-type': 'application/json' } })
  throw new Error(`unexpected ${url}`)
}
const startChainApp = async ({ ctx = createMockContext(), store = chainStore(), fetchImpl = kernelNow({ '香港-自动': { now: 'HK-02', all: ['HK-01', 'HK-02'] } }), prober = fakeProber() } = {}) => {
  const app = express()
  registerNodeLatencyRoutes(app, { ctx, paths, store, fetchImpl, lookup: fakeLookup, prober })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { ctx, store, prober, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}
const postChain = (baseUrl, body) => fetch(`${baseUrl}/api/openbox/chain-proxies/latency`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
// exec 执行那一刻把临时配置读下来(mock 的 exec 不看文件,这里包一层)
const recordingCtx = (results) => {
  const ctx = createMockContext({ defaultExec: results.default || { code: 0 } })
  const seen = []
  const exec = ctx.exec
  ctx.exec = async (cmd, args, opts) => {
    const url = args[args.length - 1]
    seen.push({ url, config: JSON.parse(ctx.files[args[3]]) })
    return results[url] || exec(cmd, args, opts)
  }
  return { ctx, seen }
}

test('链式代理测速:上游是组时落到内核此刻选中的节点,链式出站 detour 过去;测速和订阅节点同一个测速实例、用面板设置里的测速地址;IP 信息经同一条链取回正文;临时配置用完就删', async () => {
  const { ctx, seen } = recordingCtx({ 'https://api.ip.sb/geoip?t=1': { code: 0, stdout: '{"ip":"203.0.113.9","country":"Malaysia"}' } })
  const { baseUrl, prober, close } = await startChainApp({ ctx })
  try {
    const res = await postChain(baseUrl, { link: 'http://user:pass@gw.example.com:5001', upstream: '香港-自动', testUrl: 'https://www.gstatic.com/generate_204', timeoutMs: 5000, ipUrls: ['https://api.ip.sb/geoip?t=1', 'https://ipwho.is/?t=1'] })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.ms, 42)
    assert.equal(body.via, 'HK-02')
    assert.deepEqual(body.ip, { ok: true, url: 'https://api.ip.sb/geoip?t=1', body: '{"ip":"203.0.113.9","country":"Malaysia"}' })
    assert.deepEqual(prober.calls[0].jobs, [{ tag: 'probe-chain', url: 'https://www.gstatic.com/generate_204' }])
    assert.deepEqual(seen.map((s) => s.url), ['https://api.ip.sb/geoip?t=1'], '第一家就答了,不再取第二家')
    assert.deepEqual(seen[0].config.outbounds.map((o) => o.tag), ['probe-chain', 'HK-02'], 'IP 信息经同一条链')
    const [chain, upstream, ...rest] = prober.calls[0].outbounds
    assert.deepEqual([chain.tag, chain.type, chain.server, chain.detour], ['probe-chain', 'http', 'gw.example.com', 'HK-02'])
    assert.deepEqual([upstream.tag, upstream.server], ['HK-02', 'hk2.example.com'])
    assert.equal(rest.length, 0)
    assert.ok(!Object.keys(ctx.files).some((p) => p.includes('config.latency-chain-')), '临时配置删掉了')
  } finally { await close() }
})

test('链式代理测速:上游本身是链式代理时再落一层,detour 改指落到的节点;失败给出分类和原文', async () => {
  const prober = fakeProber({ 'probe-chain': { ok: false, reason: 'timeout', error: 'dial tcp: i/o timeout' } })
  const { baseUrl, close } = await startChainApp({ prober, fetchImpl: kernelNow({ '香港-自动': { now: 'HK-01', all: ['HK-01', 'HK-02'] } }) })
  try {
    const body = await (await postChain(baseUrl, { link: 'socks5://gw2.example.com:1080', upstream: '已有链' })).json()
    assert.equal(body.ok, false)
    assert.equal(body.reason, 'timeout')
    assert.equal(body.error, 'dial tcp: i/o timeout')
    assert.equal(body.via, '已有链')
    assert.deepEqual(prober.calls[0].outbounds.map((o) => [o.tag, o.detour || '']), [['probe-chain', '已有链'], ['已有链', 'HK-01'], ['HK-01', '']])
  } finally { await close() }
})

test('链式代理测速:链接解析不了 / 没选上游 → 400;IP 接口不是面板设置里那几家 → 400;上游此刻落在直连 → 409,什么都没写', async () => {
  const { ctx, baseUrl, close } = await startChainApp({ fetchImpl: kernelNow({ '香港-自动': { now: '直连', all: ['直连', 'HK-01'] } }) })
  try {
    assert.equal((await postChain(baseUrl, { link: 'not a link', upstream: '香港-自动' })).status, 400)
    assert.equal((await postChain(baseUrl, { link: 'http://gw.example.com:5001', upstream: '' })).status, 400)
    const bad = await postChain(baseUrl, { link: 'http://gw.example.com:5001', upstream: 'HK-01', ipUrls: ['https://ipwho.is/', 'https://evil.example.com/x'] })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /IP 信息接口/)
    const r = await postChain(baseUrl, { link: 'http://gw.example.com:5001', upstream: '香港-自动' })
    assert.equal(r.status, 409)
    assert.match((await r.json()).error, /落在「直连」/)
    assert.equal(ctx.writes.length, 0)
  } finally { await close() }
})

test('链式代理 IP 信息:第一家不认 tools fetch(api.ip.sb 回 403 拒绝页)就换下一家,返回答话那一家的网址;都不行给出每家的原因', async () => {
  const forbidden = { code: 0, stdout: '<html><head><title>403 Forbidden</title></head></html>' }
  const { ctx, seen } = recordingCtx({
    'https://api.ip.sb/geoip': forbidden,
    'https://ipwho.is/': { code: 0, stdout: '{"success":false,"message":"rate limited"}' },
    'https://api.ipapi.is/': { code: 0, stdout: '{"ip":"203.0.113.9","company":"Example ISP","asn":"AS64500 Example ISP","city":"London","region":"England","country":"United Kingdom"}' },
  })
  const { baseUrl, close } = await startChainApp({ ctx })
  try {
    const body = await (await postChain(baseUrl, { link: 'http://gw.example.com:5001', upstream: 'HK-01', ipUrls: ['https://api.ip.sb/geoip', 'https://ipwho.is/', 'https://api.ipapi.is/'] })).json()
    assert.equal(body.ip.ok, true)
    assert.equal(body.ip.url, 'https://api.ipapi.is/')
    assert.match(body.ip.body, /Example ISP/)
    assert.deepEqual(seen.map((s) => s.url), ['https://api.ip.sb/geoip', 'https://ipwho.is/', 'https://api.ipapi.is/'])
  } finally { await close() }

  const all = recordingCtx({ 'https://api.ip.sb/geoip': forbidden, 'https://ipwho.is/': forbidden })
  const app2 = await startChainApp({ ctx: all.ctx })
  try {
    const body = await (await postChain(app2.baseUrl, { link: 'http://gw.example.com:5001', upstream: 'HK-01', ipUrls: ['https://api.ip.sb/geoip', 'https://ipwho.is/'] })).json()
    assert.equal(body.ok, true, '测速本身是通的')
    assert.equal(body.ip.ok, false)
    assert.match(body.ip.error, /api\.ip\.sb: 返回的不是 IP 信息;ipwho\.is: 返回的不是 IP 信息/)
    assert.ok(!Object.keys(all.ctx.files).some((p) => p.includes('config.latency-chain-')), '先删临时配置再回')
  } finally { await app2.close() }
})

// ---------- 手动测速走内核(A 方案,内核 1.14.1-openbox-tcp14) ----------
// 假内核:/proxies 列出内核里有的出站;单节点测速按脚本回;记下每次请求
const fakeKernel = ({ tags = [], delays = {}, queue = null } = {}) => {
  const calls = []
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const fetchImpl = async (url) => {
    const u = new URL(String(url))
    calls.push(decodeURIComponent(u.pathname) + u.search)
    if (u.pathname === '/proxies') {
      const proxies = Object.fromEntries(tags.map((t) => [t, { type: 'Shadowsocks', history: [] }]))
      proxies['所有-自动'] = { type: 'URLTest', all: tags, now: tags[0], history: [] }
      return json(200, { proxies })
    }
    if (u.pathname === '/openbox/probes') return queue ? json(200, queue) : json(404, {})
    const m = decodeURIComponent(u.pathname).match(/^\/proxies\/(.+)\/delay$/)
    if (m) {
      const r = delays[m[1]]
      if (!r) return json(404, { message: 'Resource not found' })
      return json(r.status || 200, r.body)
    }
    throw new Error('unexpected ' + url)
  }
  return { calls, fetchImpl }
}

// GitHub #482:用全局测速地址测时带上全局的可接受状态码(内核 tcp19);用别的地址测不带。内核回 503 + unexpected status
// 记成「状态码不符」(status),不是超时
test('可接受状态码:全局地址的测速带 expected,别的地址不带;状态码不符单独归类', async () => {
  const { store, history } = storedWorld()
  store.setProfile({ testExpectedStatus: '200-399' })
  const kernel = fakeKernel({ tags: ['多宝 | 美国-01', '多宝 | 香港-01'], delays: {
    '多宝 | 美国-01': { status: 503, body: { message: 'An error occurred in the delay test', error: 'unexpected status 403' } },
    '多宝 | 香港-01': { body: { delay: 66 } },
  } })
  const prober = fakeProber()
  const { baseUrl, close } = await startApp({ store, history, prober, fetchImpl: kernel.fetchImpl })
  try {
    const body = await (await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01' }, { tag: '多宝 | 香港-01', url: 'http://cp.cloudflare.com/' }], timeoutMs: 5000 })).json()
    assert.equal(body.results[0].ok, false)
    assert.equal(body.results[0].reason, 'status')
    assert.deepEqual(body.results[1], { ok: true, ms: 66 })
    const usCall = kernel.calls.find((c) => c.startsWith('/proxies/多宝 | 美国-01/delay'))
    const hkCall = kernel.calls.find((c) => c.startsWith('/proxies/多宝 | 香港-01/delay'))
    assert.match(usCall, /&expected=200-399$/)
    assert.ok(!hkCall.includes('expected='), hkCall)
  } finally {
    await close()
  }
})

test('卡片 / 代理页:内核里有、定义也是最新的节点交给内核测(interactive、15 秒内复用刚测过的);内核里没有 / 还是旧定义的走临时测速实例', async () => {
  const { store, history } = storedWorld()
  const kernel = fakeKernel({ tags: ['多宝 | 美国-01', '多宝 | 香港-01'], delays: { '多宝 | 美国-01': { body: { delay: 88, time: '2026-09-22T07:59:59.000Z', reused: false } } } })
  const prober = fakeProber({ '多宝 | 香港-01': { ok: true, ms: 120 } })
  const kernelStale = { get: async () => ({ staleTags: new Set(['多宝 | 香港-01']) }) }
  const { baseUrl, close } = await startApp({ store, history, prober, fetchImpl: kernel.fetchImpl, kernelStale })
  try {
    const body = await (await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01' }, { tag: '多宝 | 香港-01' }, { tag: '直连', url: 'http://connect.rom.miui.com/generate_204' }], timeoutMs: 5000 })).json()
    assert.deepEqual(body.results, [{ ok: true, ms: 88 }, { ok: true, ms: 120 }, { ok: true, ms: 42 }])
    const delayCall = kernel.calls.find((c) => c.startsWith('/proxies/多宝 | 美国-01/delay'))
    assert.ok(delayCall, kernel.calls.join('\n'))
    assert.match(delayCall, /timeout=5000&force=false&interval=15000&priority=interactive/)
    assert.ok(!kernel.calls.some((c) => c.startsWith('/proxies/多宝 | 香港-01/delay')), '内核还是旧定义的不交给内核')
    const [call] = prober.calls
    assert.deepEqual(call.jobs.map((j) => j.tag), ['多宝 | 香港-01', '直连'], '只有内核测不了的交给测速实例')
    assert.deepEqual(body.history['多宝 | 美国-01'].map((x) => x.delay), [88])
  } finally {
    await close()
  }
})

test('卡片 / 代理页:内核拿的是别人刚测完的结果(reused)不另记一笔历史;内核失败带原始报错的按类归因,504 是超时;内核回 404 的交给测速实例', async () => {
  const { store, history } = storedWorld()
  store.setNodes([...store.getNodes(), createNode({ tag: '多宝 | 日本-01', type: 'shadowsocks', server: 'jp.example.com', server_port: 8388, fields: { method: 'aes-256-gcm', password: 'pw' }, source: 'clash', subscriptionId: 's1' })])
  const kernel = fakeKernel({
    tags: ['多宝 | 美国-01', '多宝 | 香港-01', '多宝 | 日本-01'],
    delays: {
      '多宝 | 美国-01': { body: { delay: 77, time: '2026-09-22T07:59:50.000Z', reused: true } },
      '多宝 | 香港-01': { status: 503, body: { message: 'An error occurred in the delay test', error: 'dial tcp 1.2.3.4:8388: connect: connection refused', reused: false } },
    },
  })
  const prober = fakeProber()
  const { baseUrl, close } = await startApp({ store, history, prober, fetchImpl: kernel.fetchImpl })
  try {
    const body = await (await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01' }, { tag: '多宝 | 香港-01' }, { tag: '多宝 | 日本-01' }] })).json()
    assert.deepEqual(body.results[0], { ok: true, ms: 77 })
    assert.deepEqual(body.results[1], { ok: false, reason: 'refused', error: 'dial tcp 1.2.3.4:8388: connect: connection refused' })
    assert.deepEqual(body.results[2], { ok: true, ms: 42 }, '内核说没有(404)的交给测速实例')
    assert.deepEqual(prober.calls[0].jobs.map((j) => j.tag), ['多宝 | 日本-01'])
    assert.equal(body.history['多宝 | 美国-01'], undefined, '复用来的结果那一笔已经记过')
    assert.deepEqual(body.history['多宝 | 香港-01'].map((x) => [x.delay, x.reason]), [[0, 'refused']])
  } finally {
    await close()
  }
})

// 带 progress:true 的请求逐行回:先一行空的 done,每测完一个一行(请求里 jobs 的下标),最后一行是结果
const readLines = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('卡片 / 代理页:带进度时逐行回 {done:[下标]},每个节点报一次(重复的一起报),最后一行是和不带进度一样的结果', async () => {
  const { store, history } = storedWorld()
  const kernel = fakeKernel({ tags: ['多宝 | 美国-01'], delays: { '多宝 | 美国-01': { body: { delay: 88, time: '2026-09-22T07:59:59.000Z', reused: false } } } })
  const prober = fakeProber({ '多宝 | 香港-01': { ok: false, reason: 'timeout' } })
  const { baseUrl, close } = await startApp({ store, history, prober, fetchImpl: kernel.fetchImpl })
  try {
    const res = await post(baseUrl, { progress: true, jobs: [{ tag: '多宝 | 美国-01' }, { tag: '多宝 | 香港-01' }, { tag: '多宝 | 美国-01' }, { tag: '没有这个' }], timeoutMs: 5000 })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/x-ndjson/)
    const lines = await readLines(res)
    const done = lines.filter((l) => Array.isArray(l.done))
    assert.deepEqual(done[0], { done: [] }, '先回一行,界面马上知道开测了')
    assert.deepEqual(done.slice(1).map((l) => l.done)[0], [0, 2], '内核那个先出结果,重复的两条一起报')
    assert.deepEqual(done.flatMap((l) => l.done).sort(), [0, 1, 2, 3], '每条都报到,只报一次')
    const last = lines[lines.length - 1]
    assert.deepEqual(last.results, [{ ok: true, ms: 88 }, { ok: false, reason: 'timeout' }, { ok: true, ms: 88 }, { ok: false, reason: 'not-found' }])
    assert.ok(last.history['多宝 | 美国-01'])
    // 不带 progress 的照旧回一整份 JSON
    const plain = await post(baseUrl, { jobs: [{ tag: '多宝 | 美国-01' }] })
    assert.match(plain.headers.get('content-type'), /application\/json/)
    // 核对不过照常回 400 JSON,不开始逐行
    const bad = await post(baseUrl, { progress: true, jobs: [] })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /non-empty/)
  } finally {
    await close()
  }
})

test('排队状态:内核测速名额占满或有人排队 = 忙;内核没在跑 / 老内核没有这个接口 = 不忙', async () => {
  const check = async (queue, fetchImpl) => {
    const { store } = storedWorld()
    const { baseUrl, close } = await startApp({ store, fetchImpl: fetchImpl || fakeKernel({ queue }).fetchImpl })
    try {
      return await (await fetch(`${baseUrl}/api/openbox/nodes/latency/queue`)).json()
    } finally {
      await close()
    }
  }
  assert.equal((await check({ running: 4, interactive: 0, background: 0, limit: 4 })).busy, true)
  assert.equal((await check({ running: 2, interactive: 0, background: 5, limit: 4 })).busy, true)
  assert.equal((await check({ running: 1, interactive: 0, background: 0, limit: 4 })).busy, false)
  assert.equal((await check(null)).busy, false)
  assert.equal((await check(null, async () => { throw new Error('no net') })).busy, false)
})
