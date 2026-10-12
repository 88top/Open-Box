import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import YAML from 'yaml'
import { createStore } from '../store/openbox-store.mjs'
import { registerPublicSubscriptionShareRoutes, registerSubscriptionShareRoutes } from './subscription-shares.mjs'
import { parseSubscription } from '../engine/subscription.mjs'

const setup = async () => {
  const map = new Map()
  const store = createStore({ get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), del: (k) => map.delete(k) })
  store.setSubscriptions([{ id: 'one', name: 'One', content: 'ss://example#one', nodeCount: 1 }])
  const app = express()
  registerPublicSubscriptionShareRoutes(app, { store, fetchImpl: async () => ({ ok: true, text: async () => '' }) })
  registerSubscriptionShareRoutes(app, { store })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { store, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('subscription share management and public URL', async () => {
  const { store, base, close } = await setup()
  try {
    const createdResponse = await fetch(`${base}/api/openbox/subscription-shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '手机', host: 'router.local:2026', subscriptionIds: ['one'] }) })
    assert.equal(createdResponse.status, 201)
    const { share } = await createdResponse.json()
    assert.equal(share.subscriptionIds[0], 'one')
    const publicResponse = await fetch(`${base}/sub/${share.token}`)
    assert.equal(publicResponse.status, 200)
    assert.equal(await publicResponse.text(), 'ss://example#one')
    const regenerated = await fetch(`${base}/api/openbox/subscription-shares/${share.id}/regenerate`, { method: 'POST' })
    assert.equal(regenerated.status, 200)
    const next = (await regenerated.json()).share
    assert.notEqual(next.token, share.token)
    const disabled = await fetch(`${base}/api/openbox/subscription-shares/${share.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    assert.equal(disabled.status, 200)
    assert.equal((await disabled.json()).share.enabled, false)
    assert.equal((await fetch(`${base}/sub/${next.token}`)).status, 404)
    assert.equal(store.getSubscriptionShares().length, 1)
  } finally { await close() }
})

test('public URL decodes base64 subscription content before serving', async () => {
  const { store, base, close } = await setup()
  try {
    const encoded = Buffer.from('ss://example#one\n', 'utf8').toString('base64')
    store.setSubscriptions([{ id: 'one', name: 'One', content: encoded, nodeCount: 1 }])
    const createdResponse = await fetch(`${base}/api/openbox/subscription-shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'base64', host: 'router.local:2026', subscriptionIds: ['one'] }) })
    const { share } = await createdResponse.json()
    const response = await fetch(`${base}/sub/${share.token}`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ss://example#one')
  } finally { await close() }
})

test('public URL uses imported node snapshot instead of re-fetching a reset source', async () => {
  const { store, base, close } = await setup()
  try {
    const source = 'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@proxy.example:8388#香港01'
    const node = parseSubscription(source).nodes[0]
    store.setSubscriptions([{ id: 'one', name: 'One', url: 'https://source.example/sub', nodeCount: 1 }])
    store.setNodes([{ ...node, subscriptionId: 'one', tag: '香港-01' }])
    store.setSubscriptionShares([{ id: 'share', token: 'c'.repeat(48), name: 'snapshot', subscriptionIds: ['one'] }])
    const response = await fetch(`${base}/sub/${'c'.repeat(48)}`)
    assert.equal(response.status, 200)
    const parsed = parseSubscription(await response.text())
    assert.equal(parsed.format, 'singbox')
    assert.equal(parsed.nodes[0].tag, '香港-01')
  } finally { await close() }
})

test('public share applies current per-subscription naming after decoding and before merging', async () => {
  const { store, base, close } = await setup()
  try {
    const original = 'anytls://test-password@proxy.example:443?sni=tls.example#%E9%A6%99%E6%B8%AFA'
    const subscriptions = [
      { id: 'one', name: '机场', content: Buffer.from(original).toString('base64'), renameOptions: { enabled: true, usePrefix: true } },
      { id: 'two', name: '原样', content: original, renameOptions: { enabled: false } },
    ]
    store.setSubscriptions(subscriptions)
    store.setSubscriptionShares([{ id: 'share', token: 'a'.repeat(48), name: '聚合', subscriptionIds: ['one', 'two'] }])
    const response = await fetch(`${base}/sub/${'a'.repeat(48)}`)
    assert.equal(response.status, 200)
    assert.deepEqual(parseSubscription(await response.text()).nodes.map((node) => node.tag), ['机场 | 香港-01', '香港A'])
    store.setSubscriptions([{ ...subscriptions[0], name: '新名称' }, subscriptions[1]])
    const updated = await fetch(`${base}/sub/${'a'.repeat(48)}`)
    assert.deepEqual(parseSubscription(await updated.text()).nodes.map((node) => node.tag), ['新名称 | 香港-01', '香港A'])
  } finally { await close() }
})

test('public share returns Clash YAML when requested by a Clash client', async () => {
  const { store, base, close } = await setup()
  try {
    const encoded = Buffer.from('anytls://test-password@proxy.example:443?sni=tls.example#%E9%A6%99%E6%B8%AFA', 'utf8').toString('base64')
    store.setSubscriptions([{ id: 'one', name: '机场', content: encoded, renameOptions: { enabled: true } }])
    store.setSubscriptionShares([{ id: 'share', token: 'b'.repeat(48), name: 'Clash', subscriptionIds: ['one'] }])
    const response = await fetch(`${base}/sub/${'b'.repeat(48)}`, { headers: { 'user-agent': 'ClashMi/1.0' } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /yaml/)
    const body = await response.text()
    assert.match(body, /^proxies:/)
    assert.equal(YAML.parse(body).proxies[0].name, '香港-01')
    assert.equal(YAML.parse(body).proxies[0].type, 'anytls')
    assert.equal(YAML.parse(body).proxies[0].password, 'test-password')
    assert.equal(YAML.parse(body).proxies[0].servername, 'tls.example')
  } finally { await close() }
})

test('新建分享可以带前端先生成的 token:合法且未占用就照用;不合法或撞了已有的就服务端另生成', async () => {
  const { store, base, close } = await setup()
  try {
    const post = (body) => fetch(`${base}/api/openbox/subscription-shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A', host: 'r.example', protocol: 'https', subscriptionIds: ['one'], ...body }) })
    const mine = 'e'.repeat(48)
    const a = await (await post({ token: mine.toUpperCase() })).json()
    assert.equal(a.share.token, mine, '大小写归一后照用')
    const b = await (await post({ token: mine })).json()
    assert.notEqual(b.share.token, mine, '撞了已有的另生成')
    assert.match(b.share.token, /^[0-9a-f]{48}$/)
    const c = await (await post({ token: 'short' })).json()
    assert.match(c.share.token, /^[0-9a-f]{48}$/)
    assert.equal(store.getSubscriptionShares().length, 3)
    assert.equal((await fetch(`${base}/sub/${mine}`)).status, 200)
  } finally { await close() }
})
