import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import express from 'express'
import { createChainLookup, measureSite, normalizeSites, probeSite, registerSiteLatencyRoutes, SITES } from './site-latency.mjs'
import { SITE_MAX_SAMPLES } from '../system/latency-history.mjs'

// 测试专用的自签证书(和 system/insecure-fetch.test.mjs 里的是同一张,CN=selfsigned.test,100 年有效)
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIBeQIBADCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAAB
AAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA
///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMV
AMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg
9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8A
AAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBBG0wawIBAQQgc2VRUsmKn51R
BL3Ck38YlAAXR6ogSg6l7uLh8V8bgcChRANCAATQsnD41Gd3WKqcSgHyZYjLp9qo
z8Lu22BuCZ1NS4EIuhdY2ObkJqWpDemvSSVcWuoLIu3BrQnpgdCXhH9KUh0K
-----END PRIVATE KEY-----`
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIICGTCCAcACCQDZuw/+tQnfvDAKBggqhkjOPQQDAjAaMRgwFgYDVQQDDA9zZWxm
c2lnbmVkLnRlc3QwIBcNMjYwOTAzMTA1MDUxWhgPMjEyNjA4MTAxMDUwNTFaMBox
GDAWBgNVBAMMD3NlbGZzaWduZWQudGVzdDCCAUswggEDBgcqhkjOPQIBMIH3AgEB
MCwGByqGSM49AQECIQD/////AAAAAQAAAAAAAAAAAAAAAP///////////////zBb
BCD/////AAAAAQAAAAAAAAAAAAAAAP///////////////AQgWsY12Ko6k+ez671V
dpiGvGUdBrDMU7D2O848PifSYEsDFQDEnTYIhucEk2pmeOETnSa3gZ9+kARBBGsX
0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivO
M1drMV7Oy7ZAaDe/UfUCIQD/////AAAAAP//////////vOb6racXnoTzucrC/GMl
UQIBAQNCAATQsnD41Gd3WKqcSgHyZYjLp9qoz8Lu22BuCZ1NS4EIuhdY2ObkJqWp
DemvSSVcWuoLIu3BrQnpgdCXhH9KUh0KMAoGCCqGSM49BAMCA0cAMEQCIFATH5MC
ciJhAJAd6ujPQRySzGm0K2TIT2/vmxvP024dAiAWgDUFn0XfvymsLbljfT3hhyW0
+PAV9fLkXf8muPmmvA==
-----END CERTIFICATE-----`

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) })

// 假的内核回环入站:和 sing-box 的 mixed 一样先答 200,再去连目标(dialDelayMs 模拟节点那头去连站点花的时间)。
// CONNECT 的目标一律接到 upstreamPort 上;reject 为真时答完 200 直接关(内核按规则拒绝就是这个样子)
const fakeInbound = async ({ upstreamPort, dialDelayMs = 0, reject = false }) => {
  const sockets = new Set()
  const seen = []
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('error', () => {})
    client.on('close', () => sockets.delete(client))
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      client.removeListener('data', onData)
      // 接上目标之前先停读,免得这期间到的请求被丢掉
      client.pause()
      seen.push({ line: buf.split('\r\n')[0], sourcePort: client.remotePort })
      client.write('HTTP/1.1 200 Connection established\r\n\r\n')
      if (reject) return void client.end()
      setTimeout(() => {
        const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort })
        upstream.on('error', () => client.destroy())
        client.on('close', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
        client.pipe(upstream)
        upstream.pipe(client)
      }, dialDelayMs)
    }
    client.on('data', onData)
  })
  const port = await listen(server)
  return { port, seen, close: () => { for (const s of sockets) s.destroy(); return close(server) } }
}

test('probeSite:明文 HTTP 连发两次 HEAD,卡片上的数取第二次(第一次含着节点那头去连站点的时间)', async () => {
  const requests = []
  const target = http.createServer((req, res) => { requests.push(`${req.method} ${req.url} ${req.headers.host}`); res.writeHead(204); res.end() })
  const targetPort = await listen(target)
  const inbound = await fakeInbound({ upstreamPort: targetPort, dialDelayMs: 120 })
  try {
    const r = await probeSite('http://site.test/favicon.ico?x=1', { proxyPort: inbound.port, timeoutMs: 3000 })
    assert.equal(r.ok, true)
    assert.equal(r.status, 204)
    assert.deepEqual(requests, ['HEAD /favicon.ico?x=1 site.test', 'HEAD /favicon.ico?x=1 site.test'])
    assert.equal(inbound.seen[0].line, 'CONNECT site.test:80 HTTP/1.1')
    assert.equal(r.localPort, inbound.seen[0].sourcePort, '来源端口带回去,调用方拿它去内核连接表里认线路')
    assert.ok(r.openMs >= 110, `首次打开含拨号的 120ms,实际 ${r.openMs}`)
    assert.ok(r.ms < 80, `往返不含拨号,实际 ${r.ms}`)
    r.close()
  } finally {
    await inbound.close()
    await close(target)
  }
})

test('probeSite:HTTPS 先握手再连发两次 HEAD,取小的;自签证书照测;对端答完就关时只用第一次', async () => {
  let count = 0
  const target = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (req, res) => {
    count += 1
    // 第一次慢 60ms、第二次立刻答:取小的那个
    setTimeout(() => { res.writeHead(200); res.end() }, count === 1 ? 60 : 0)
  })
  const closing = http.createServer((_req, res) => { res.writeHead(200, { connection: 'close' }); res.end() })
  const [targetPort, closingPort] = [await listen(target), await listen(closing)]
  const inbound = await fakeInbound({ upstreamPort: targetPort })
  const inbound2 = await fakeInbound({ upstreamPort: closingPort })
  try {
    const r = await probeSite('https://selfsigned.test:8443/', { proxyPort: inbound.port, timeoutMs: 3000 })
    assert.equal(r.ok, true, r.error)
    assert.equal(inbound.seen[0].line, 'CONNECT selfsigned.test:8443 HTTP/1.1')
    assert.equal(count, 2)
    assert.ok(r.ms < 50, `取第二次的,实际 ${r.ms}`)
    assert.ok(r.openMs >= 60)
    r.close()
    const once = await probeSite('http://close.test/', { proxyPort: inbound2.port, timeoutMs: 3000 })
    assert.equal(once.ok, true)
    assert.ok(once.ms >= 1)
    once.close()
  } finally {
    await inbound.close()
    await inbound2.close()
    await close(target)
    await close(closing)
  }
})

test('measureSite:入站连不上 / 被内核断开 / 超时各是一句人话;超时的也认得出线路', async () => {
  // 入站没开
  const dead = net.createServer()
  const deadPort = await listen(dead)
  await close(dead)
  const probeAt = (port) => (url, opts) => probeSite(url, { ...opts, proxyPort: port })
  const noLookup = async () => []
  assert.equal((await measureSite(SITES[0], { probe: probeAt(deadPort), lookupChain: noLookup })).error, '内核没在运行(回环入站连不上)')
  // 内核按规则拒绝:答完 200 就关
  const rejecting = await fakeInbound({ upstreamPort: 1, reject: true })
  // 站点一直不回
  const silent = net.createServer((s) => { s.on('error', () => {}); s.resume() })
  const silentPort = await listen(silent)
  const hanging = await fakeInbound({ upstreamPort: silentPort })
  try {
    const rejected = await measureSite({ id: 'x', url: 'http://blocked.test/' }, { probe: probeAt(rejecting.port), lookupChain: noLookup, timeoutMs: 2000 })
    assert.equal(rejected.ms, null)
    assert.equal(rejected.error, '连接被断开')
    const ports = []
    const timedOut = await measureSite({ id: 'y', url: 'http://slow.test/' }, {
      probe: probeAt(hanging.port), timeoutMs: 300,
      lookupChain: async (port) => { ports.push(port); return ['国外', '香港-自动', 'HK-01'] },
    })
    assert.equal(timedOut.error, '超时')
    assert.deepEqual(timedOut.chain, ['国外', '香港-自动', 'HK-01'])
    assert.equal(timedOut.via, '国外')
    assert.equal(ports[0], hanging.seen[0].sourcePort)
    assert.equal((await measureSite({ id: 'z', url: 'ftp://nope' }, { probe: () => assert.fail('网址无效的不去测') })).error, '网址无效')
  } finally {
    await rejecting.close()
    await hanging.close()
    await close(silent)
  }
})

test('createChainLookup:按来源端口 + 面板入站认连接;chains 翻成「策略 → 节点」;__fo: 子组不给看;同时结束的几条合成一次查询', async () => {
  const calls = []
  const connections = [
    { metadata: { type: 'tun/tun-in', sourcePort: '40001' }, chains: ['别人的节点', '国外'] },
    { metadata: { type: 'mixed/panel-in', sourcePort: '40001' }, chains: ['US-01', '__fo:g-1:lane-x', '美国-故转', 'Google'] },
    { metadata: { type: 'mixed/panel-in', sourcePort: '40002' }, chains: ['直连', '国内'] },
  ]
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization })
    return new Response(JSON.stringify({ connections }), { headers: { 'content-type': 'application/json' } })
  }
  const lookup = createChainLookup({ store: { getClashSecret: () => 's3cret' }, fetchImpl, waitMs: 20 })
  const [a, b, none, noPort] = await Promise.all([lookup(40001), lookup(40002), lookup(49999), lookup(null)])
  assert.deepEqual(a, ['Google', '美国-故转', 'US-01'])
  assert.deepEqual(b, ['国内', '直连'])
  assert.deepEqual(none, [])
  assert.deepEqual(noPort, [])
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/connections$/)
  assert.equal(calls[0].auth, 'Bearer s3cret')
  await lookup(40001)
  assert.equal(calls.length, 2, '上一批查完之后再来的另起一次')
  const broken = createChainLookup({ store: {}, fetchImpl: async () => { throw new Error('down') }, waitMs: 1 })
  assert.deepEqual(await broken(40001), [], '连接表查不到不影响延时结果')
})

test('接口:GET 测默认四个;POST 按前端给的站点表测(只传一个就只测一个);站点表不合法 400;并发请求共用同一轮', async () => {
  const probed = []
  let port = 50000
  const plan = { 'www.baidu.com': { ok: true, ms: 38, openMs: 160 }, 'www.google.com': { ok: true, ms: 121, openMs: 490 }, 'api.openai.com': { ok: false, error: 'timeout' } }
  const probe = async (url) => {
    probed.push(url)
    // 真去访问要几十上百毫秒;这里也留一点时间,并发请求才会真的撞上同一轮
    await new Promise((r) => setTimeout(r, 40))
    const step = plan[new URL(url).hostname] || { ok: false, error: 'read ECONNRESET' }
    return { ...step, status: 200, localPort: (port += 1), close: () => {} }
  }
  const fetchImpl = async () => new Response(JSON.stringify({ connections: [{ metadata: { type: 'mixed/panel-in', sourcePort: '50002' }, chains: ['US-01', 'Google'] }] }))
  const app = express()
  // 站点历史要真的记下来:给一个最小的内存 store(真实的那个在 index.mjs 里)
  const kv = new Map()
  const store = { getRaw: (k) => kv.get(k) ?? null, setRaw: (k, v) => kv.set(k, v), delRaw: (k) => kv.delete(k) }
  registerSiteLatencyRoutes(app, { store, fetchImpl, probe })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/openbox/site-latency`
    const [a, b] = await Promise.all([fetch(base).then((r) => r.json()), fetch(base).then((r) => r.json())])
    assert.equal(probed.length, 4, '两次并发请求只测了一轮')
    assert.deepEqual(a.sites.map((s) => s.id), ['baidu', 'google', 'openai', 'telegram'])
    assert.deepEqual(a.sites.map((s) => s.ms), [38, 121, null, null])
    assert.deepEqual(a.sites.map((s) => s.openMs), [160, 490, null, null])
    assert.deepEqual(a.sites.map((s) => s.error), [null, null, '超时', '连接被断开'])
    assert.deepEqual(a.sites[1].chain, ['Google', 'US-01'])
    assert.equal(a.sites[1].via, 'Google')
    assert.equal(a.sites[1].url, SITES[1].url)
    assert.equal(a.testedAt, b.testedAt)
    const post = (body) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const one = await post({ sites: [{ id: 'google', url: 'https://www.google.com/generate_204' }] }).then((r) => r.json())
    assert.deepEqual(one.sites.map((s) => s.id), ['google'])
    assert.equal(one.sites[0].ms, 121)
    assert.equal(probed.length, 5)
    // 网址无效的不去测,直接带回「网址无效」
    const badUrl = await post({ sites: [{ id: 'x', url: 'ftp://nope' }, { id: 'baidu', url: 'https://www.baidu.com/favicon.ico' }] }).then((r) => r.json())
    assert.equal(badUrl.sites[0].error, '网址无效')
    assert.equal(badUrl.sites[1].ms, 38)
    assert.equal(probed.length, 6)
    assert.equal((await post({ sites: [] })).status, 400)
    assert.equal((await post({ sites: [{ id: 'Bad Id', url: 'https://a.test/' }] })).status, 400)
    assert.equal((await post({ sites: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, url: 'https://a.test/' })) })).status, 400)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('normalizeSites:个数、id 形态、重复 id、网址长度', () => {
  assert.equal(normalizeSites(undefined), null)
  assert.equal(normalizeSites([]), null)
  assert.deepEqual(normalizeSites([{ id: 'a-1', url: ' https://a.test/x ' }]), [{ id: 'a-1', url: 'https://a.test/x' }])
  assert.equal(normalizeSites([{ id: 'a', url: 'https://a.test/' }, { id: 'a', url: 'https://b.test/' }]), null, '重复 id')
  assert.equal(normalizeSites([{ id: 'a', url: 'https://a.test/' + 'x'.repeat(2100) }]), null)
})

test('站点延时历史:每测一次记一笔、按 SITE_MAX_SAMPLES 截断、测不通记 0;/history 单独取得到', async () => {
  const kv = new Map()
  const store = { getRaw: (k) => kv.get(k) ?? null, setRaw: (k, v) => kv.set(k, v), delRaw: (k) => kv.delete(k) }
  let ms = 30
  const probe = async (url) => {
    const host = new URL(url).hostname
    // baidu 每次给不同的数(时间戳也就不同,才会真的记成新的一笔);openai 一直不通
    if (host === 'api.openai.com') return { ok: false, error: 'timeout', localPort: 1, close: () => {} }
    ms += 7
    return { ok: true, ms, openMs: ms * 3, status: 200, localPort: 1, close: () => {} }
  }
  const app = express()
  registerSiteLatencyRoutes(app, { store, fetchImpl: async () => new Response('{}'), probe })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}/api/openbox/site-latency`
  const sites = [{ id: 'baidu', url: 'https://www.baidu.com/favicon.ico' }, { id: 'openai', url: 'https://api.openai.com/v1/models' }]

  const rounds = SITE_MAX_SAMPLES + 2
  for (let i = 0; i < rounds; i++) {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sites }) })
    assert.equal(res.status, 200)
    await new Promise((r) => setTimeout(r, 2)) // 时间戳要不同,否则会被当成同一次结果
  }

  const { history } = await fetch(`${base}/history`).then((r) => r.json())
  assert.ok(Array.isArray(history.baidu), '应当记了 baidu 的历史')
  assert.equal(history.baidu.length, SITE_MAX_SAMPLES, `最多留 ${SITE_MAX_SAMPLES} 笔,实际 ${history.baidu.length}`)
  assert.ok(history.baidu.every((s) => s.delay > 0), '通的那些延迟要大于 0')
  // 留下的是最后那几笔:延迟递增,所以最后一笔应当是最大的
  assert.equal(history.baidu[SITE_MAX_SAMPLES - 1].delay, Math.max(...history.baidu.map((s) => s.delay)))
  assert.ok(history.openai.length > 0 && history.openai.every((s) => s.delay === 0), '测不通记 0')

  await new Promise((r) => server.close(r))
})

test('站点延时:历史存不下也不能影响测速结果(store 坏了照样返回这一轮的数)', async () => {
  const brokenStore = { getRaw: () => { throw new Error('库炸了') }, setRaw: () => { throw new Error('库炸了') } }
  const app = express()
  registerSiteLatencyRoutes(app, {
    store: brokenStore,
    fetchImpl: async () => new Response('{}'),
    probe: async () => ({ ok: true, ms: 42, openMs: 99, status: 200, localPort: 1, close: () => {} }),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/openbox/site-latency`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sites: [{ id: 'baidu', url: 'https://www.baidu.com/favicon.ico' }] }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.sites[0].ms, 42, '测速结果照常返回')
  await new Promise((r) => server.close(r))
})
