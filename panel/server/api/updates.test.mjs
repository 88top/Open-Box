import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerUpdateRoutes } from './updates.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { compareVersions, fetchLatestVersion, fetchReleaseNote, parseKeyValues } from '../system/updater.mjs'
import { runScheduledTasks } from '../system/scheduler.mjs'
import { createStore } from '../store/openbox-store.mjs'

const paths = createPaths('/opt/open-box')

const startApp = async (ctx, store, fetchImpl) => {
  const app = express()
  registerUpdateRoutes(app, { store, ctx, paths, fetchImpl })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

test('版本比较:只看前三段;git describe 的开发版和同号 tag 相等', () => {
  assert.ok(compareVersions('v0.2.0', 'v0.1.55-112-gbffc3d5') > 0)
  assert.equal(compareVersions('v0.1.55', 'v0.1.55-112-gbffc3d5'), 0)
  assert.ok(compareVersions('v0.1.54', 'v0.1.55') < 0)
  assert.deepEqual(parseKeyValues('pid=12\nstage=downloading\nbytes=10\nmessage=a=b'), { pid: '12', stage: 'downloading', bytes: '10', message: 'a=b' })
})

test('fetchLatestVersion:从 releases/latest 的 302 跳转里取 tag,直连失败退到镜像', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.startsWith('https://github.com/')) throw new Error('offline')
    return { status: 302, headers: new Map([['location', 'https://github.com/timeflysoon/Open-Box/releases/tag/v0.2.3']]), url: '' }
  }
  const r = await fetchLatestVersion(fetchImpl, { mirrors: ['https://mirror.test/'] })
  assert.equal(r.latest, 'v0.2.3')
  assert.equal(r.via, 'https://mirror.test/')
  assert.equal(calls.length, 2)
})

test('GET /update/status + POST /update/run:读 meta/通道/状态文件,发起时调 update.sh --detach --mirror', async () => {
  const ctx = createMockContext({
    files: {
      [paths.metaPath]: JSON.stringify({ version: 'v0.1.55', singboxVersion: '1.13.14' }),
      [paths.channelPath]: 'mirror\nhttps://ghfast.top/\n',
      [paths.updateStatusPath]: 'pid=9\nstage=done\nbytes=\ntotal=\nmessage=ok\n',
      [paths.updateScript]: '#!/bin/sh\n',
    },
  })
  // 探最新 tag 的 fetch:第一次 offline(不带 --expect),第二次给 302(带 --expect)
  let online = false
  const fetchImpl = async () => {
    if (!online) throw new Error('offline')
    return { status: 302, headers: new Map([['location', 'https://github.com/timeflysoon/Open-Box/releases/tag/v0.2.3']]), url: '' }
  }
  const { base, close } = await startApp(ctx, { getProfile: () => ({}) }, fetchImpl)
  try {
    const st = await (await fetch(`${base}/api/openbox/update/status`)).json()
    assert.equal(st.version, 'v0.1.55')
    assert.deepEqual(st.channel, { mode: 'mirror', prefix: 'https://ghfast.top/' })
    assert.equal(st.status.stage, 'done')
    assert.equal(st.status.running, false)
    const run = await fetch(`${base}/api/openbox/update/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'mirror' }) })
    assert.equal(run.status, 200)
    const call = ctx.calls.find((c) => c.cmd === 'sh')
    assert.deepEqual(call.args, [paths.updateScript, '--detach', '--mirror'])
    online = true
    ctx.calls.length = 0
    await fetch(`${base}/api/openbox/update/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'direct' }) })
    assert.deepEqual(ctx.calls.find((c) => c.cmd === 'sh').args, [paths.updateScript, '--detach', '--direct', '--expect', 'v0.2.3'])
    const bad = await fetch(`${base}/api/openbox/update/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'x' }) })
    assert.equal(bad.status, 400)
  } finally {
    await close()
  }
})

test('POST /update/run:已有更新在跑 → 409', async () => {
  const ctx = createMockContext({ files: { [paths.updateStatusPath]: 'stage=downloading\n', [paths.updateScript]: '' } })
  const { base, close } = await startApp(ctx, { getProfile: () => ({}) })
  try {
    const r = await fetch(`${base}/api/openbox/update/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 409)
  } finally {
    await close()
  }
})

test('定时器:Open-Box 自身更新按「每隔几天」探,间隔内不重复探;到期探到已是最新也记 lastAt', async () => {
  const ctx = createMockContext({ files: { [paths.metaPath]: JSON.stringify({ version: 'v0.1.60' }), [paths.updateScript]: '' } })
  let probes = 0
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'HEAD') { probes++; return { status: 302, headers: new Map([['location', 'https://github.com/timeflysoon/Open-Box/releases/tag/v0.1.60']]), url: '' } }
    throw new Error('unexpected')
  }
  const store = { getProfile: () => ({ updates: { geo: { auto: false }, openbox: { auto: true, hour: 4, days: 7, channel: 'auto' } } }) }
  await runScheduledTasks({ store, ctx, paths, fetchImpl, now: new Date(2026, 8, 3, 4, 5) })
  assert.equal(probes, 1)
  const state = JSON.parse(await ctx.readFile(paths.scheduleStatePath))
  assert.ok(state.openboxLastAt)
  // 第 3 天到点:未到 7 天间隔,不探
  await runScheduledTasks({ store, ctx, paths, fetchImpl, now: new Date(2026, 8, 6, 4, 5) })
  assert.equal(probes, 1)
  // 第 8 天到点:再探
  await runScheduledTasks({ store, ctx, paths, fetchImpl, now: new Date(2026, 8, 11, 4, 5) })
  assert.equal(probes, 2)
})

test('定时器:订阅到点自动重拉;同一天不重复、没到 N 天不拉;节点变了且内核在跑就在线换进内核,不重启', async () => {
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  store.setProfile({ updates: { geo: { auto: false }, openbox: { auto: false } } })
  store.setSubscriptions([{ id: 's1', name: 'A', url: 'http://a', urls: ['http://a'], format: 'sharelink', nodeCount: 0, renameOptions: {}, autoUpdate: { enabled: true, days: 3, hour: 4 }, createdAt: 1, updatedAt: 1 }])
  store.setNodes([])
  const ctx = createMockContext({ execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } } })
  let fetched = 0
  const subscriptionFetchImpl = async () => { fetched += 1; return { ok: true, status: 200, text: async () => 'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@example.com:8388#HK-01' } }
  const applied = []
  const hotApplier = { runNow: async () => { applied.push(1); return { ok: true, changed: 3 } } }
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  const base = { store, ctx, paths, fetchImpl: async () => { throw new Error('不该用系统 fetch 拉订阅') }, subscriptionFetchImpl, hotApplier, lookup }

  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 3, 30) })
  assert.equal(fetched, 0, '没到点')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 4, 2) })
  assert.equal(fetched, 1)
  assert.equal(store.getSubscriptions()[0].nodeCount, 1)
  assert.equal(applied.length, 1, '节点从 0 变 1,在线换一次')
  assert.equal(ctx.calls.some((c) => /restart/.test(c.args.join(' '))), false, '不重启内核')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 4, 40) })
  assert.equal(fetched, 1, '同一天不重复')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 6, 4, 1) })
  assert.equal(fetched, 1, '每 3 天一次,第二天不拉')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 8, 4, 1) })
  assert.equal(fetched, 2, '第 3 天到点再拉')
  assert.equal(applied.length, 1, '节点没变就什么都不做')
  const state = JSON.parse(await ctx.readFile(paths.scheduleStatePath))
  assert.ok(state.subscriptions.s1.lastAt)
})

test('定时器:订阅「每隔几小时」从上一次拉取算起;刚保存的不马上拉,到点就拉不看几点,拉失败也等下一个间隔(#14)', async () => {
  const m = new Map()
  const store = createStore({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) })
  store.setProfile({ updates: { geo: { auto: false }, openbox: { auto: false } } })
  const savedAt = new Date(2026, 8, 5, 10, 20).getTime()
  store.setSubscriptions([{ id: 's1', name: 'A', url: 'http://a', urls: ['http://a'], format: 'sharelink', nodeCount: 0, renameOptions: {}, autoUpdate: { enabled: true, mode: 'hours', hours: 6 }, createdAt: savedAt, updatedAt: savedAt }])
  store.setNodes([])
  const ctx = createMockContext({ execResults: { '/etc/init.d/openbox status': { code: 0, stdout: 'running' } } })
  let fetched = 0
  let fail = false
  const subscriptionFetchImpl = async () => {
    fetched += 1
    if (fail) throw new Error('boom')
    return { ok: true, status: 200, text: async () => 'ss://YWVzLTI1Ni1nY206c2VjcmV0cHc=@example.com:8388#HK-01' }
  }
  const hotApplier = { runNow: async () => ({ ok: true, changed: 1 }) }
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
  const base = { store, ctx, paths, fetchImpl: async () => { throw new Error('不该用系统 fetch 拉订阅') }, subscriptionFetchImpl, hotApplier, lookup }

  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 10, 21) })
  assert.equal(fetched, 0, '刚保存过,从保存时间算起,不拉')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 16, 18) })
  assert.equal(fetched, 0, '差 2 分钟没到 6 小时')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 16, 20) })
  assert.equal(fetched, 1, '到 6 小时就拉,不看几点')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 16, 21) })
  assert.equal(fetched, 1, '下一分钟不重复')
  fail = true
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 22, 20) })
  assert.equal(fetched, 2, '再过 6 小时再拉')
  await runScheduledTasks({ ...base, now: new Date(2026, 8, 5, 22, 21) })
  assert.equal(fetched, 2, '拉失败不每分钟重试,等下一个间隔')
  const state = JSON.parse(await ctx.readFile(paths.scheduleStatePath))
  assert.match(state.subscriptions.s1.result, /^error:/)
})

test('旧 Geo 更新接口退出服务，不下载、不重启；旧自动计划也不执行', async () => {
  const ctx = createMockContext()
  let requests = 0
  const fetchImpl = async () => { requests++; throw new Error('offline') }
  const store = { getProfile: () => ({ updates: { geo: { auto: true, hour: 4, days: 1 } } }) }
  const { base, close } = await startApp(ctx, store, fetchImpl)
  try {
    for (const [url, method] of [['check', 'GET'], ['refresh', 'POST'], ['refresh/status', 'GET']]) {
      const response = await fetch(`${base}/api/openbox/rulesets/${url}`, { method })
      assert.equal(response.status, 410)
      assert.match((await response.json()).message, /随 Open-Box 统一更新/)
    }
    await runScheduledTasks({ store, ctx, paths, fetchImpl, now: new Date(2026, 8, 12, 4) })
    assert.equal(requests, 0)
    assert.equal(ctx.calls.length, 0)
    assert.equal(ctx.writes.length, 0)
  } finally { await close() }
})

const jsonRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) })
const textRes = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text })

test('fetchReleaseNote:直连 GitHub API 只取最新那一版的说明;url 是 Release 列表(看其它版本)', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push([url, init && init.headers && init.headers['User-Agent']]); return jsonRes({ tag_name: 'v0.1.276', published_at: '2026-10-02T12:00:00Z', body: '## DNS\n- 地区页签\n' }) }
  const r = await fetchReleaseNote(fetchImpl, { latest: 'v0.1.276' })
  assert.deepEqual(r, { url: 'https://github.com/timeflysoon/Open-Box/releases', note: { version: 'v0.1.276', date: '2026-10-02T12:00:00Z', body: '## DNS\n- 地区页签' }, via: 'api' })
  assert.deepEqual(calls, [['https://api.github.com/repos/timeflysoon/Open-Box/releases/tags/v0.1.276', 'Open-Box']])
})

test('fetchReleaseNote:API 不通(镜像不代理 api.github.com)退回各来源的 release-notes.md 附件,镜像回网页的跳过;都不通给出原因', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.startsWith('https://api.github.com/')) return jsonRes({ message: 'rate limited' }, 403)
    if (url.startsWith('https://github.com/')) throw new Error('reset')
    if (url.startsWith('https://m1.test/')) return textRes('<html>Invalid input</html>')
    return textRes('## DNS\n- 地区页签\n')
  }
  const r = await fetchReleaseNote(fetchImpl, { latest: 'v0.1.276', mirrors: ['https://m1.test/', 'https://m2.test'] })
  assert.equal(r.via, 'https://m2.test/')
  assert.deepEqual(r.note, { version: 'v0.1.276', date: '', body: '## DNS\n- 地区页签' })
  assert.deepEqual(calls.slice(1), [
    'https://github.com/timeflysoon/Open-Box/releases/download/v0.1.276/release-notes.md',
    'https://m1.test/https://github.com/timeflysoon/Open-Box/releases/download/v0.1.276/release-notes.md',
    'https://m2.test/https://github.com/timeflysoon/Open-Box/releases/download/v0.1.276/release-notes.md',
  ])
  const none = await fetchReleaseNote(async () => { throw new Error('offline') }, { latest: 'v0.1.276', mirrors: [] })
  assert.deepEqual(none, { url: 'https://github.com/timeflysoon/Open-Box/releases', note: null, via: '', error: 'offline' })
  assert.equal((await fetchReleaseNote(async () => jsonRes({}), { latest: '../x' })).note, null, '版本号写法不对不去取')
})

test('GET /update/notes:按 ?latest 取最新那一版的说明;latest 写法不对就自己再探一次', async () => {
  const ctx = createMockContext({ files: { [paths.metaPath]: JSON.stringify({ version: 'v0.1.275' }) } })
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.includes('/releases/latest')) return { status: 302, headers: new Map([['location', 'https://github.com/timeflysoon/Open-Box/releases/tag/v0.1.277']]), url: '' }
    const tag = /\/releases\/tags\/([^/?]+)/.exec(url)?.[1]
    return jsonRes({ tag_name: tag, body: `- ${tag} 的改动` })
  }
  const { base, close } = await startApp(ctx, { getProfile: () => ({}) }, fetchImpl)
  try {
    const r = await (await fetch(`${base}/api/openbox/update/notes?latest=v0.1.276`)).json()
    assert.deepEqual(r.note, { version: 'v0.1.276', date: '', body: '- v0.1.276 的改动' })
    assert.ok(!seen.some((u) => u.includes('/releases/latest')), '给了 latest 就不再探')
    const r2 = await (await fetch(`${base}/api/openbox/update/notes?latest=../../x`)).json()
    assert.equal(r2.note.version, 'v0.1.277')
    assert.ok(seen.some((u) => u.includes('/releases/latest')))
  } finally {
    await close()
  }
})
