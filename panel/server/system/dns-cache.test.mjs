import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { flushDnsCache, registerDnsCacheRoutes } from './dns-cache.mjs'
import { createMockContext } from './context.mjs'

test('flushDnsCache:POST /cache/dns/flush,带上 secret', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization })
    return { ok: true, status: 204 }
  }
  assert.equal(await flushDnsCache(fetchImpl, 'sec'), true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/cache\/dns\/flush$/)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].auth, 'Bearer sec')
})

test('flushDnsCache:内核没在跑 / 接口不存在都只回 false,不抛出去', async () => {
  assert.equal(await flushDnsCache(async () => { throw new Error('ECONNREFUSED') }, 's'), false)
  assert.equal(await flushDnsCache(async () => ({ ok: false, status: 404 }), 's'), false)
})

test('flushDnsCache:没有 secret 时不带 Authorization 头', async () => {
  let headers = null
  await flushDnsCache(async (_u, init) => { headers = init.headers; return { ok: true, status: 204 } }, '')
  assert.deepEqual(headers, {})
})

// signal:给 dnsmasq 发信号的办法(dnsmasq-signal.mjs);found = 找到几个 dnsmasq 守护进程
const fakeSignal = (found) => {
  const sent = []
  const signal = (sig, opts) => { sent.push({ sig, opts }); return { found, sent: found, young: 0 } }
  return { signal, sent }
}
const startApp = async ({ ctx, fetchImpl, signal = fakeSignal(0).signal }) => {
  const app = express()
  registerDnsCacheRoutes(app, { ctx, store: { getClashSecret: () => 's3cret' }, fetchImpl, signal })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}
const flush = async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/openbox/dns/flush-cache`, { method: 'POST' })
  return { status: res.status, body: await res.json() }
}

test('清空 DNS 缓存:内核 /cache/dns/flush 带密钥;dnsmasq 在跑就发 SIGHUP(只发给真正的 dnsmasq,刚起来的不发)', async () => {
  const seen = []
  const ctx = createMockContext()
  const hup = fakeSignal(1)
  const { baseUrl, close } = await startApp({ ctx, signal: hup.signal, fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true } } })
  try {
    const { status, body } = await flush(baseUrl)
    assert.equal(status, 200)
    assert.deepEqual(body, { kernel: true, dnsmasq: true, resolved: false })
    assert.match(seen[0].url, /\/cache\/dns\/flush$/)
    assert.equal(seen[0].init.method, 'POST')
    assert.equal(seen[0].init.headers.Authorization, 'Bearer s3cret')
    assert.deepEqual(hup.sent.map((x) => x.sig), ['SIGHUP'])
    assert.ok(hup.sent[0].opts.minAgeMs > 0)
    assert.ok(!ctx.calls.some((c) => c.cmd === 'killall'), '不用 killall:它会连正在重启 dnsmasq 的 init 脚本一起打断')
  } finally {
    await close()
  }
})

test('清空 DNS 缓存:dnsmasq 没在跑不发信号;内核也不通就回 503', async () => {
  const ctx = createMockContext()
  const up = await startApp({ ctx, fetchImpl: async () => ({ ok: true }) })
  try {
    assert.deepEqual((await flush(up.baseUrl)).body, { kernel: true, dnsmasq: false, resolved: false })
  } finally {
    await up.close()
  }
  const down = await startApp({ ctx: createMockContext(), fetchImpl: async () => { throw new Error('refused') } })
  try {
    const { status, body } = await flush(down.baseUrl)
    assert.equal(status, 503)
    assert.equal(body.kernel, false)
    assert.equal(body.dnsmasq, false)
    assert.equal(body.resolved, false)
  } finally {
    await down.close()
  }
})

test('清空 DNS 缓存:Debian / Ubuntu 有 resolvectl 就顺带清 systemd-resolved 的缓存;单靠它也算清到了', async () => {
  const ctx = createMockContext({ files: { '/usr/bin/resolvectl': '' } })
  const app = await startApp({ ctx, fetchImpl: async () => { throw new Error('refused') } })
  try {
    const { status, body } = await flush(app.baseUrl)
    assert.equal(status, 200)
    assert.deepEqual(body, { kernel: false, dnsmasq: false, resolved: true })
    assert.ok(ctx.calls.some((c) => c.cmd === 'resolvectl' && c.args.join(' ') === 'flush-caches'))
  } finally {
    await app.close()
  }
})
