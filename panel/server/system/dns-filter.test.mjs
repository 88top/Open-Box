import test from 'node:test'
import { memAvailableMb, MIN_AVAILABLE_MB } from './dns-filter.mjs'
import { createMockContext } from './context.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { createPaths } from './paths.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import dgram from 'node:dgram'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Resolver } from 'node:dns/promises'
import { WebSocket } from 'ws'
import { createRealContext } from './context-real.mjs'
import { prepareDnsFilter } from './dns-filter.mjs'
import { buildFilterConfig } from '../engine/dns-filter.mjs'
import { buildResponse, parseQuery } from './dns-rewrite-server.mjs'
import { createDnsEventParser } from './dns-filter-observer.mjs'
import { ensureRulesets } from './rulesets.mjs'

const binary = path.resolve(import.meta.dirname, '../../.tools/sing-box')
const available = await fs.access(binary).then(() => true, () => false)
const freePort = async () => { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise((r) => s.close(r)); return port }

test('native 1.14 DNS filters, exceptions, AAAA, regex, rewrite priority and observable records', { skip: !available, timeout: 20000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openbox-dns-filter-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const profile = { dns: { filter: { enabled: true, allowDomains: ['manual.ads.test'], lists: [{ id: 'list', name: 'Test list', enabled: true, url: 'https://example.com/filter.txt' }] } } }
  const raw = new Map()
  const store = { getProfile: () => profile, getRaw: (k) => raw.get(k), setRaw: (k, v) => raw.set(k, v) }
  const ctx = createRealContext(), paths = { dataDir: dir, singbox: binary }
  const body = '||ads.test^\n@@||safe.ads.test^\n||only-a.test^$dnstype=A\n||*.wild.test^\n/^ad[0-9]+\\.regex\\.test$/$denyallow=ad1.regex.test\n||local.test^'
  const artifact = await prepareDnsFilter({ store, ctx, paths, fetchImpl: async () => new Response(body) })
  const previous = raw.get('openbox/dns-filter-lists')
  await prepareDnsFilter({ store, ctx, paths, force: true, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(JSON.parse(raw.get('openbox/dns-filter-lists')).list.hash, JSON.parse(previous).list.hash)
  assert.match(JSON.parse(raw.get('openbox/dns-filter-lists')).list.error, /offline/)
  await prepareDnsFilter({ store, ctx, paths, force: true, fetchImpl: async () => new Response('/(invalid/') })
  assert.equal(JSON.parse(raw.get('openbox/dns-filter-lists')).list.hash, JSON.parse(previous).list.hash)
  assert.match(JSON.parse(raw.get('openbox/dns-filter-lists')).list.error, /正则无效/)
  const filtering = buildFilterConfig(profile, artifact)
  const upstream = dgram.createSocket('udp4')
  upstream.bind(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => upstream.close())
  upstream.on('message', (msg, peer) => {
    const query = parseQuery(msg)
    upstream.send(buildResponse(query, { answers: [{ name: query.qname, type: query.qtype, ttl: 60, data: query.qtype === 28 ? '2001:db8::1' : '192.0.2.1' }] }), peer.port, peer.address)
  })
  const port = await freePort(), api = await freePort()
  const config = { log: { level: 'warn' }, dns: { servers: [{ tag: 'up', type: 'udp', server: '127.0.0.1', server_port: upstream.address().port }], rules: [{ domain: ['local.test'], action: 'predefined', answer: ['local.test. 60 IN A 192.168.3.1'] }, ...filtering.rules], final: 'up' }, inbounds: [{ type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: port }], route: { rules: [{ inbound: ['dns-in'], action: 'hijack-dns' }], rule_set: filtering.sets }, experimental: { clash_api: { external_controller: `127.0.0.1:${api}` } } }
  const ensured = await ensureRulesets(ctx, config, { fetchImpl: async () => { throw new Error('本地过滤产物不应回源 Geo') } })
  assert.equal(ensured.ok, true, ensured.message)
  assert.deepEqual(ensured.downloaded, [])
  const file = path.join(dir, 'config.json')
  await fs.writeFile(file, JSON.stringify(config))
  const core = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; core.stderr.on('data', (d) => { output += d })
  t.after(async () => { if (core.exitCode === null) { core.kill(); await once(core, 'exit') } })
  for (let i = 0; i < 60; i++) {
    if (core.exitCode !== null) throw new Error(output)
    try { await fetch(`http://127.0.0.1:${api}/version`); break } catch { await new Promise(r => setTimeout(r, 50)) }
  }
  const rows = [], starts = []
  const parser = createDnsEventParser({ data: { start: (q) => starts.push(q), finish: (q) => rows.push(q) }, rules: config.dns.rules, names: Object.fromEntries(artifact.blocks.map(b => [b.tag, b.name])) })
  const ws = new WebSocket(`ws://127.0.0.1:${api}/logs?level=debug`)
  t.after(() => ws.terminate())
  const logs = []
  ws.on('message', (v) => { const entry = JSON.parse(v.toString()); logs.push(entry); parser.accept(entry) })
  await once(ws, 'open')
  const resolver = new Resolver({ timeout: 1000, tries: 1 }); resolver.setServers([`127.0.0.1:${port}`])
  for (const name of ['ads.test', 'sub.ads.test', 'x.wild.test', 'ad2.regex.test', 'only-a.test']) await assert.rejects(resolver.resolve4(name), { code: 'ENOTFOUND' })
  for (const name of ['safe.ads.test', 'manual.ads.test', 'wild.test', 'badads.test', 'ad1.regex.test']) assert.deepEqual(await resolver.resolve4(name), ['192.0.2.1'])
  assert.deepEqual(await resolver.resolve6('only-a.test'), ['2001:db8::1'])
  await assert.rejects(resolver.resolve6('ads.test'), { code: 'ENOTFOUND' })
  assert.deepEqual(await resolver.resolve4('local.test'), ['192.168.3.1'])
  await new Promise(r => setTimeout(r, 100))
  assert.equal(rows.filter(r => r.result === 'blocked').length, 6, JSON.stringify(logs))
  assert.equal(starts.length, 13, JSON.stringify(logs))
  assert.equal(rows.filter(r => r.result === 'allowed').length, 6, JSON.stringify(logs))
  assert.equal(rows.find(r => r.domain === 'ads.test').list, 'Test list')
})

// 用户 2026-09-30:没必要重启内核的都不重启。名单更新只换文件:集合名字固定,运行中的内核自己重新加载新内容
test('名单更新不重启内核:集合名字固定,内容没变不重编,变了原子换文件、运行中的内核自己加载;编不过的不动正在用的那份', { skip: !available, timeout: 30000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openbox-dns-filter-hot-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const profile = { dns: { filter: { enabled: true, allowDomains: [], lists: [{ id: 'hot', name: 'Hot list', enabled: true, url: 'https://example.com/hot.txt' }] } } }
  const raw = new Map()
  const store = { getProfile: () => profile, getRaw: (k) => raw.get(k), setRaw: (k, v) => raw.set(k, v) }
  const real = createRealContext()
  let compiles = 0
  const ctx = { ...real, exec: (cmd, args, opts) => { if (args[1] === 'compile') compiles += 1; return real.exec(cmd, args, opts) } }
  const paths = { dataDir: dir, singbox: binary }
  let body = '||old.test^'
  const fetchImpl = async () => new Response(body)
  const first = await prepareDnsFilter({ store, ctx, paths, fetchImpl })
  const tags = first.sets.map((s) => s.tag)
  assert.deepEqual(tags, ['dns-filter-hot-block'])
  assert.equal(compiles, 1)
  await prepareDnsFilter({ store, ctx, paths, force: true, fetchImpl })
  assert.equal(compiles, 1, '内容没变不重编')

  const filtering = buildFilterConfig(profile, first)
  const upstream = dgram.createSocket('udp4')
  upstream.bind(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => upstream.close())
  upstream.on('message', (msg, peer) => {
    const query = parseQuery(msg)
    upstream.send(buildResponse(query, { answers: [{ name: query.qname, type: query.qtype, ttl: 1, data: '192.0.2.1' }] }), peer.port, peer.address)
  })
  const port = await freePort(), api = await freePort()
  const config = { log: { level: 'warn' }, dns: { servers: [{ tag: 'up', type: 'udp', server: '127.0.0.1', server_port: upstream.address().port }], rules: filtering.rules, final: 'up', disable_cache: true }, inbounds: [{ type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: port }], route: { rules: [{ inbound: ['dns-in'], action: 'hijack-dns' }], rule_set: filtering.sets }, experimental: { clash_api: { external_controller: `127.0.0.1:${api}` } } }
  const file = path.join(dir, 'config.json')
  await fs.writeFile(file, JSON.stringify(config))
  const core = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; core.stderr.on('data', (d) => { output += d })
  t.after(async () => { if (core.exitCode === null) { core.kill(); await once(core, 'exit') } })
  for (let i = 0; i < 60; i++) {
    if (core.exitCode !== null) throw new Error(output)
    try { await fetch(`http://127.0.0.1:${api}/version`); break } catch { await new Promise(r => setTimeout(r, 50)) }
  }
  const resolver = new Resolver({ timeout: 1000, tries: 1 }); resolver.setServers([`127.0.0.1:${port}`])
  await assert.rejects(resolver.resolve4('old.test'), { code: 'ENOTFOUND' })
  assert.deepEqual(await resolver.resolve4('new.test'), ['192.0.2.1'])

  body = '||new.test^'
  const second = await prepareDnsFilter({ store, ctx, paths, force: true, fetchImpl })
  assert.deepEqual(second.sets.map((s) => s.tag), tags, '名字不变,配置不用变')
  assert.equal(compiles, 2)
  assert.deepEqual((await fs.readdir(path.join(dir, 'dns-filter'))).filter((n) => n.includes('.new.')), [], '临时文件收拾干净')
  let reloaded = false
  for (let i = 0; i < 40 && !reloaded; i++) {
    await new Promise(r => setTimeout(r, 100))
    try { await resolver.resolve4('new.test') } catch (error) { reloaded = error.code === 'ENOTFOUND' }
  }
  assert.ok(reloaded, `运行中的内核应自己加载新名单:${output}`)
  assert.deepEqual(await resolver.resolve4('old.test'), ['192.0.2.1'])
  assert.equal(core.exitCode, null, '内核一直在跑')

  const srs = path.join(dir, 'dns-filter', 'dns-filter-hot-block.srs')
  const before = await fs.readFile(srs)
  body = '/(invalid/'
  await prepareDnsFilter({ store, ctx, paths, force: true, fetchImpl })
  assert.match(JSON.parse(raw.get('openbox/dns-filter-lists')).hot.error, /正则无效/)
  assert.deepEqual(await fs.readFile(srs), before, '编不过的不顶掉正在用的那份')

  // 老版本的产物(按内容起名、没有 hashes):部署时(不带 force)用本地缓存的名单重编成固定名字,不联网
  const legacy = JSON.parse(raw.get('openbox/dns-filter-runtime'))
  delete legacy.hashes
  legacy.sets = legacy.sets.map((set) => ({ ...set, tag: `${set.tag}-0123456789abcdef` }))
  raw.set('openbox/dns-filter-runtime', JSON.stringify(legacy))
  const migrated = await prepareDnsFilter({ store, ctx, paths, fetchImpl: async () => { throw new Error('部署时不该联网') } })
  assert.deepEqual(migrated.sets.map((set) => set.tag), tags)
  assert.ok(migrated.hashes && migrated.hashes['dns-filter-hot-block'])
})

test('内存不够时不更新名单:可用内存低于门槛直接报人话,不起内核编译;读不到 /proc/meminfo 就不判', async () => {
  const low = createMockContext({ files: { '/proc/meminfo': 'MemTotal:       997888 kB\nMemFree:         38248 kB\nMemAvailable:   120000 kB\n' } })
  assert.equal(Math.round(await memAvailableMb(low)), 117)
  assert.equal(await memAvailableMb(createMockContext({})), null)
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  store.setProfile({ dns: { filter: { enabled: true, lists: [{ id: 'l1', name: '名单一', url: 'https://example.com/list.txt', enabled: true }], allowDomains: [] } } })
  await assert.rejects(
    () => prepareDnsFilter({ store, ctx: low, paths: createPaths('/opt/open-box'), force: true, fetchImpl: async () => { throw new Error('不该去下载') } }),
    (err) => /可用内存只有 117 MB/.test(err.message) && new RegExp(String(MIN_AVAILABLE_MB)).test(err.message),
  )
  assert.equal(low.calls.length, 0, '没起任何进程')
})


test('部署时名单下不来、本地又没有:只跳过那一份(记进 missing),其余照常;10 分钟内的部署不再等一遍超时,到点重试;点名更新照旧报错(GitHub #562 #565)', { skip: !available, timeout: 30000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openbox-dns-filter-missing-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const profile = { dns: { filter: { enabled: true, allowDomains: [], lists: [
    { id: 'good', name: 'Good', enabled: true, url: 'https://example.com/good.txt' },
    { id: 'anti-ad', name: 'anti-AD', enabled: true, url: 'https://example.com/anti-ad.txt' },
  ] } } }
  const raw = new Map()
  const store = { getProfile: () => profile, getRaw: (k) => raw.get(k), setRaw: (k, v) => raw.set(k, v) }
  const ctx = createRealContext()
  const paths = { dataDir: dir, singbox: binary }
  let clock = 1_000_000
  const now = () => clock
  let antiAdUp = false
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(new URL(url).pathname)
    if (url.includes('anti-ad') && !antiAdUp) throw new Error('下载超时（30 秒）')
    return new Response(url.includes('anti-ad') ? '||ad.test^' : '||good.test^')
  }
  const first = await prepareDnsFilter({ store, ctx, paths, fetchImpl, now })
  assert.deepEqual(first.missing, [{ id: 'anti-ad', name: 'anti-AD', error: '下载超时（30 秒）' }])
  assert.deepEqual(first.sets.map((s) => s.tag), ['dns-filter-good-block'], '下得来的那份照常')
  assert.equal(buildFilterConfig(profile, first).rules.length, 1, '配置生成不报「名单尚未准备好」')
  assert.match(JSON.parse(raw.get('openbox/dns-filter-lists'))['anti-ad'].error, /下载超时/, '卡片上照常标红')

  // 几分钟后又部署(重启内核):不再联网等超时,直接接着跳过
  fetched.length = 0
  clock += 5 * 60 * 1000
  const again = await prepareDnsFilter({ store, ctx, paths, fetchImpl, now })
  assert.deepEqual(fetched, [])
  assert.deepEqual(again.missing.map((m) => m.id), ['anti-ad'])

  // 点名更新这份:照旧报错给点按钮的人看;点名更新别的那份:不被它拖累
  await assert.rejects(prepareDnsFilter({ store, ctx, paths, force: 'anti-ad', fetchImpl, now }), /anti-AD: 下载超时/)
  const goodOnly = await prepareDnsFilter({ store, ctx, paths, force: 'good', fetchImpl, now })
  assert.deepEqual(goodOnly.missing.map((m) => m.id), ['anti-ad'])

  // 过了 10 分钟、网络也好了:部署时重试,补上
  antiAdUp = true
  fetched.length = 0
  clock += 11 * 60 * 1000
  const healed = await prepareDnsFilter({ store, ctx, paths, fetchImpl, now })
  assert.deepEqual(fetched, ['/anti-ad.txt'], '只重下缺的那份,有缓存的不联网')
  assert.equal(healed.missing, undefined)
  assert.deepEqual(healed.sets.map((s) => s.tag).sort(), ['dns-filter-anti-ad-block', 'dns-filter-good-block'])
  assert.equal(JSON.parse(raw.get('openbox/dns-filter-lists'))['anti-ad'].error, '')
})
