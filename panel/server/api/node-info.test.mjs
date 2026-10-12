import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { EXIT_GEO_URLS, parseExitGeo, parseProxycheck, parseRdapCountry, proxycheckUrl, rdapUrl, registerNodeInfoRoutes } from './node-info.mjs'

test('ping0.cc/geo 四行:IP、属地、ASN、所有者;第一行不是 IP 就不认', () => {
  assert.deepEqual(parseExitGeo('103.135.248.181\n中国 香港 香港 — DMIT\nAS32519\nDMIT Cloud Services\n'), {
    ip: '103.135.248.181', location: '中国 香港 香港 — DMIT', asn: 'AS32519', asnOwner: 'DMIT Cloud Services',
  })
  assert.equal(parseExitGeo('<html>blocked</html>'), null)
})

test('proxycheck.io:IP 类型按 type 归类,判成代理的按机房算并带出代理类型;风控值、同网段设备数、国家', () => {
  const body = (entry) => JSON.stringify({ status: 'ok', '1.2.3.4': entry })
  assert.deepEqual(parseProxycheck(body({ proxy: 'no', type: 'Residential', risk: 0, isocode: 'US', devices: { subnet: 3 } }), '1.2.3.4'),
    { ipType: 'residential', proxyType: '', risk: 0, devices: 3, country: 'US', provider: '' })
  assert.deepEqual(parseProxycheck(body({ proxy: 'yes', type: 'VPN', risk: 66, isocode: 'HK', provider: 'DMIT', devices: { subnet: 58 } }), '1.2.3.4'),
    { ipType: 'hosting', proxyType: 'VPN', risk: 66, devices: 58, country: 'HK', provider: 'DMIT' })
  assert.equal(parseProxycheck(body({ proxy: 'no', type: 'Wireless' }), '1.2.3.4').ipType, 'mobile')
  assert.equal(parseProxycheck('not json', '1.2.3.4'), null)
  assert.equal(parseProxycheck(body({}), '5.6.7.8'), null, '别的 IP 的结果不认')
})

test('RDAP 的登记国家:两位代码,没有就是空', () => {
  assert.equal(parseRdapCountry(JSON.stringify({ country: 'hk', name: 'HK-DMIT' })), 'HK')
  assert.equal(parseRdapCountry(JSON.stringify({ name: 'NET' })), '')
  assert.equal(parseRdapCountry('oops'), '')
})

const setup = async ({ exec, resolve4 = async () => ['1.1.1.1'], resolve6 = async () => [], routeFor } = {}) => {
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  store.setGroups([])
  store.setProfile({ routing: { fallbackDefault: 'direct', policies: [] }, dns: { split: true, mode: 'off' } })
  store.setSubscriptions([{ id: 's1', name: '机场', urls: ['https://example.com/sub'], enabled: true }])
  store.setNodes([{ tag: 'HK-01', originalTag: 'HK-01', type: 'vless', server: 'hk.example.com', server_port: 443, subscriptionId: 's1', source: 'sharelink',
    fields: { uuid: '11111111-1111-1111-1111-111111111111', flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'www.apple.com', reality: { enabled: true, public_key: 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo', short_id: 'ab' } } } }])
  const paths = createPaths('/opt/open-box')
  const ctx = createMockContext({ files: { [paths.singbox]: 'x' } })
  const calls = []
  ctx.exec = async (cmd, args = []) => {
    if (cmd === paths.singbox && args[0] === 'tools' && args[1] === 'fetch') {
      const config = JSON.parse(ctx.files[args[3]])
      const call = { via: args[5], url: args[6], outbounds: config.outbounds.map((o) => o.tag), strategy: config.dns.strategy }
      calls.push(call)
      return exec(call)
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const app = express()
  registerNodeInfoRoutes(app, {
    ctx, paths, store, platform: 'darwin', resolve4, resolve6,
    countryOf: async (ip) => (ip === '1.1.1.1' ? 'HK' : ''),
    systemDnsReader: async () => ['223.5.5.5'],
    routeFor: routeFor || (async () => ({ outbound: 'direct', chain: ['direct'] })),
    outboundsFor: async ({ upstream }) => ({ via: upstream, outbounds: [{ type: 'vless', tag: upstream }], dnsServers: [] }),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/openbox/node-info`
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(`${base}/${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() }
  }
  return { ctx, paths, calls, call, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('节点本身:协议(类型 + reality + flow)、服务器和端口、解析出的地址;入口 IP 的国家单独查,查过之后节点本身里也带上;找不到的节点 404', async () => {
  const t = await setup({ exec: () => ({ code: 1, stderr: '' }), resolve6: async () => ['2606:4700::1'] })
  try {
    const r = await t.call(encodeURIComponent('HK-01'))
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.protocol, ['vless', 'reality', 'xtls-rprx-vision'])
    assert.equal(r.body.server, 'hk.example.com')
    assert.equal(r.body.port, 443)
    assert.deepEqual(r.body.addresses, { v4: ['1.1.1.1'], v6: ['2606:4700::1'] })
    assert.equal(r.body.entryCountry, '', '国家还没查过:不等它')
    assert.deepEqual((await t.call(`${encodeURIComponent('HK-01')}/entry-country`)).body, { ip: '1.1.1.1', country: 'HK' })
    assert.equal((await t.call(encodeURIComponent('HK-01'))).body.entryCountry, 'HK')
    assert.equal((await t.call('nope')).status, 404)
  } finally {
    await t.close()
  }
})

test('出口:经这个节点取 ping0.cc/geo,proxycheck 和 RDAP 按目标分流的线路取;注册国和属地一致是原生;缓存命中不再查,刷新有最短间隔', async () => {
  const t = await setup({
    exec: ({ url }) => {
      if (url === EXIT_GEO_URLS.v4) return { code: 0, stdout: '154.61.45.43\n美国 加利福尼亚 帕萨迪纳 — BasicBrix\nAS174\nCogent Communications\n' }
      if (url === EXIT_GEO_URLS.v6) return { code: 0, stdout: '2001:db8::7\n美国\nAS174\nCogent Communications\n' }
      if (url === proxycheckUrl('154.61.45.43')) return { code: 0, stdout: JSON.stringify({ status: 'ok', '154.61.45.43': { proxy: 'no', type: 'Hosting', risk: 12, isocode: 'US', devices: { subnet: 7 } } }) }
      if (url === rdapUrl('154.61.45.43')) return { code: 0, stdout: JSON.stringify({ country: 'SC' }) }
      return { code: 1, stderr: 'unexpected url' }
    },
    // proxycheck.io 按目标分流走代理(落在「美国」),RDAP 直连
    routeFor: async (_deps, { server }) => (server === 'proxycheck.io' ? { outbound: '美国', chain: ['美国', 'US-01'] } : { outbound: 'direct', chain: ['direct'] }),
  })
  try {
    const r = await t.call(`${encodeURIComponent('HK-01')}/exit`, 'POST', {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ip, '154.61.45.43')
    assert.equal(r.body.asn, 'AS174')
    assert.equal(r.body.asnOwner, 'Cogent Communications')
    assert.equal(r.body.ipType, 'hosting')
    assert.equal(r.body.risk, 12)
    assert.equal(r.body.devices, 7)
    assert.equal(r.body.country, 'US')
    assert.equal(r.body.registeredCountry, 'SC')
    assert.equal(r.body.native, false, '注册在塞舌尔、用在美国:广播 IP')
    assert.equal(r.body.ipv6, '2001:db8::7', 'ipv6.ping0.cc 查得通:有 IPv6 出口')
    const byUrl = Object.fromEntries(t.calls.map((c) => [c.url, c]))
    assert.equal(byUrl[EXIT_GEO_URLS.v4].via, 'HK-01', '出口固定经这个节点')
    assert.equal(byUrl[EXIT_GEO_URLS.v6].via, 'HK-01')
    assert.equal(byUrl[proxycheckUrl('154.61.45.43')].via, '美国', 'proxycheck.io 按目标分流')
    assert.equal(byUrl[rdapUrl('154.61.45.43')].via, 'direct')
    assert.equal(byUrl[EXIT_GEO_URLS.v4].strategy, 'ipv4_only', '地址族策略和内核一样')
    assert.equal(Object.keys(t.ctx.files).filter((f) => f.includes('node-info-')).length, 0, '临时配置里有凭据,用完就删')
    const again = await t.call(`${encodeURIComponent('HK-01')}/exit`, 'POST', { refresh: true })
    assert.equal(again.body.cached, true, '刚查过,刷新也不再去打 ping0.cc')
    assert.equal(t.calls.length, 4)
  } finally {
    await t.close()
  }
})

test('出口:经节点取不到 ping0.cc 就报错;proxycheck / RDAP 失败只缺那几项', async () => {
  const fail = await setup({ exec: () => ({ code: 1, stderr: 'FATAL[0000] Get "https://ping0.cc/geo": dial tcp: i/o timeout\n' }) })
  try {
    const r = await fail.call(`${encodeURIComponent('HK-01')}/exit`, 'POST', {})
    assert.equal(r.status, 502)
    assert.match(r.body.error, /经这个节点访问 ping0\.cc 失败:dial tcp: i\/o timeout/)
  } finally {
    await fail.close()
  }
  const partial = await setup({ exec: ({ url }) => (url === EXIT_GEO_URLS.v4 ? { code: 0, stdout: '1.1.1.1\n中国 香港\nAS13335\nCloudflare\n' } : { code: 1, stderr: 'refused' }) })
  try {
    const r = await partial.call(`${encodeURIComponent('HK-01')}/exit`, 'POST', {})
    assert.equal(r.status, 200)
    assert.equal(r.body.ip, '1.1.1.1')
    assert.equal(r.body.country, 'HK', 'proxycheck 失败时国家按随包 geoip 查')
    assert.equal(r.body.risk, null)
    assert.equal(r.body.native, null)
    assert.deepEqual(Object.keys(r.body.errors).sort(), ['proxycheck', 'rdap'])
    assert.equal(r.body.ipv6, '', '查不通 ipv6.ping0.cc:没有 IPv6 出口')
  } finally {
    await partial.close()
  }
})
