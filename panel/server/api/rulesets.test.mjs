import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { clearRulesetEntriesCache, policyDrillPlan, registerRulesetRoutes } from './rulesets.mjs'
import { createMockContext } from '../system/context.mjs'
import { listTagForUrl } from '../engine/rule-list.mjs'
import { createPaths } from '../system/paths.mjs'

const paths = createPaths('/opt/open-box')
const DECOMPILED = JSON.stringify({
  version: 1,
  rules: [
    { domain: ['www.google.com'], domain_suffix: ['google.com', 'gstatic.com'] },
    { ip_cidr: ['8.8.8.8/32'] },
    // 只有一个值时内核输出的是裸字符串,不是数组
    { domain_keyword: 'youtube' },
    { invert: true },
  ],
})

// 内核解码那一步用 mock ctx 顶掉:exec 只记录调用,输出文件预先摆在 files 里。
const okCtx = (over = {}) => createMockContext({
  files: {
    [`${paths.geoDir}/geosite-google.srs`]: 'binary',
    [`${paths.dataDir}/tmp/geosite-google.json`]: DECOMPILED,
    ...over,
  },
})

const startApp = async (ctx, fetchImpl) => {
  clearRulesetEntriesCache()
  const app = express()
  registerRulesetRoutes(app, { ctx, paths, fetchImpl })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('列出一个分类里的条目,按类型+值摊平', async () => {
  const ctx = okCtx()
  const { baseUrl, close } = await startApp(ctx)
  try {
    const res = await fetch(`${baseUrl}/api/openbox/rulesets/entries?tag=geosite-google`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.total, 5)
    assert.deepEqual(body.entries, [
      { type: 'domain', value: 'www.google.com' },
      { type: 'domain_suffix', value: 'google.com' },
      { type: 'domain_suffix', value: 'gstatic.com' },
      { type: 'ip_cidr', value: '8.8.8.8/32' },
      { type: 'domain_keyword', value: 'youtube' },
    ])
    // 解码交给内核自己:面板不另写一套 .srs 解析
    assert.ok(ctx.calls.some((c) => c.args.includes('decompile')))
  } finally {
    await close()
  }
})

test('搜索与分页只作用在匹配结果上', async () => {
  const { baseUrl, close } = await startApp(okCtx())
  try {
    const res = await fetch(`${baseUrl}/api/openbox/rulesets/entries?tag=geosite-google&q=GOOGLE&offset=1&limit=1`)
    const body = await res.json()
    assert.equal(body.total, 5)
    assert.equal(body.matched, 2) // www.google.com 和 google.com,大小写不敏感
    assert.deepEqual(body.entries, [{ type: 'domain_suffix', value: 'google.com' }])
  } finally {
    await close()
  }
})

test('安装包缺少分类时清楚报错，不在线下载也不修改旧数据', async () => {
  const ctx = createMockContext()
  let asked = false
  const { baseUrl, close } = await startApp(ctx, async () => { asked = true; throw new Error('no network') })
  try {
    const res = await fetch(`${baseUrl}/api/openbox/rulesets/entries?tag=geosite-openai`)
    assert.equal(res.status, 503)
    assert.match((await res.json()).message, /安装包缺少规则集/)
    assert.equal(asked, false)
    assert.equal(ctx.writes.length, 0)
  } finally { await close() }
})

test('名字不合法直接 400——tag 会被拼进下载地址和文件名', async () => {
  const { baseUrl, close } = await startApp(okCtx())
  try {
    for (const tag of ['../../etc/passwd', 'geosite-../x', 'whatever-cn', '']) {
      const res = await fetch(`${baseUrl}/api/openbox/rulesets/entries?tag=${encodeURIComponent(tag)}`)
      assert.equal(res.status, 400, tag)
    }
  } finally {
    await close()
  }
})

test('解码失败 → 503,把内核的话原样带出去', async () => {
  const ctx = createMockContext({
    files: { [`${paths.geoDir}/geosite-google.srs`]: 'binary' },
    execResults: { [`${paths.singbox} rule-set decompile --output ${paths.dataDir}/tmp/geosite-google.json ${paths.geoDir}/geosite-google.srs`]: { code: 1, stderr: 'bad magic' } },
  })
  const { baseUrl, close } = await startApp(ctx)
  try {
    const res = await fetch(`${baseUrl}/api/openbox/rulesets/entries?tag=geosite-google`)
    assert.equal(res.status, 503)
    assert.match((await res.json()).message, /bad magic/)
  } finally {
    await close()
  }
})

test('GET /policies/entries:站点集的规则集展开 + 手写条件,分档计数、搜索、分页;兜底返回空', async () => {
  const ctx = okCtx()
  const store = {
    getProfile: () => ({
      routing: {
        fallbackDefault: 'direct',
        policies: [
          { id: 'g', name: 'Google', rulesets: ['geosite-google'], domainSuffix: ['gg.example'], ipCidr: ['1.1.1.0/24'] },
        ],
      },
    }),
  }
  const app = express()
  clearRulesetEntriesCache()
  registerRulesetRoutes(app, { ctx, paths, store })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const all = await (await fetch(`${base}/api/openbox/policies/entries?name=Google`)).json()
    // 规则集 5 条(1 domain + 2 suffix + 1 cidr + 1 keyword)+ 手写 2 条
    assert.equal(all.total, 7)
    assert.deepEqual(all.counts, { all: 7, domain: 5, ip: 2 })
    assert.ok(all.entries.some((e) => e.source === 'custom' && e.content === 'gg.example'))
    assert.ok(all.entries.some((e) => e.source === 'geosite-google' && e.type === 'domain_suffix'))
    const ip = await (await fetch(`${base}/api/openbox/policies/entries?name=Google&tab=ip`)).json()
    assert.equal(ip.matched, 2)
    const q = await (await fetch(`${base}/api/openbox/policies/entries?name=Google&q=gstatic`)).json()
    assert.equal(q.matched, 1)
    const page = await (await fetch(`${base}/api/openbox/policies/entries?name=Google&limit=3`)).json()
    assert.equal(page.entries.length, 3)
    assert.equal(page.hasMore, true)
    const fb = await (await fetch(`${base}/api/openbox/policies/entries?name=${encodeURIComponent('其他')}`)).json()
    assert.equal(fb.fallback, true)
    const nf = await fetch(`${base}/api/openbox/policies/entries?name=Nope`)
    assert.equal(nf.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// 规则集链接(list-xxx)也要能展开:本地编好的域名 / IP 两份哪份有解哪份,来源写网址;一份都没有就按网址现拉
test('GET /policies/entries:规则集链接展开本地编好的那几份 .srs,只有 IP 一份也行;没编过就现拉', async () => {
  const URL_L = 'https://example.com/one-china.srs'
  const TAG_L = listTagForUrl(URL_L)
  const ctx = okCtx({
    [`${paths.rulesetDir}/${TAG_L}-ip.srs`]: 'binary',
    [`${paths.dataDir}/tmp/${TAG_L}-ip.json`]: JSON.stringify({ version: 3, rules: [{ ip_cidr: ['1.0.1.0/24', '1.0.2.0/23'] }] }),
  })
  const store = { getProfile: () => ({ routing: { fallbackDefault: 'direct', policies: [{ id: 'c', name: 'CN', ruleUrls: [URL_L], domainSuffix: ['cn'] }] } }) }
  const app = express()
  clearRulesetEntriesCache()
  registerRulesetRoutes(app, { ctx, paths, store, fetchImpl: async () => { throw new Error('本地有就不该拉网络') } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const all = await (await fetch(`${base}/api/openbox/policies/entries?name=CN`)).json()
    assert.deepEqual(all.missing, [])
    assert.deepEqual(all.counts, { all: 3, domain: 1, ip: 2 })
    assert.ok(all.entries.some((e) => e.source === URL_L && e.type === 'ip_cidr' && e.content === '1.0.1.0/24'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  // 还没部署(本地一份都没有):按网址现拉,.srs 交给内核解
  const srs = Buffer.concat([Buffer.from('SRS\x03', 'latin1'), Buffer.from('payload')])
  const ctx2 = okCtx({ [`${paths.dataDir}/tmp/penetration-${TAG_L}.srs.json`]: JSON.stringify({ version: 3, rules: [{ ip_cidr: ['9.9.9.0/24'] }] }) })
  const app2 = express()
  clearRulesetEntriesCache()
  registerRulesetRoutes(app2, { ctx: ctx2, paths, store, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => srs }) })
  const server2 = app2.listen(0, '127.0.0.1')
  await new Promise((resolve) => server2.once('listening', resolve))
  const base2 = `http://127.0.0.1:${server2.address().port}`
  try {
    const all = await (await fetch(`${base2}/api/openbox/policies/entries?name=CN`)).json()
    assert.deepEqual(all.missing, [])
    assert.ok(all.entries.some((e) => e.source === URL_L && e.content === '9.9.9.0/24'))
  } finally {
    await new Promise((resolve) => server2.close(resolve))
  }
})

// 展开清单(面板域名穿透和 App 本地展开共用):手写条件固定顺序;每个规则集列出路由器上有的那几份,
// 缺文件、不认识、不合法的都是空(界面列进「没能展开」)
test('policyDrillPlan:手写条件 + 每个规则集要解的那几份 .srs', async () => {
  const URL_A = 'https://example.com/a.list'
  const URL_B = 'https://example.com/b.list'
  const A = listTagForUrl(URL_A)
  const B = listTagForUrl(URL_B)
  const present = new Set(['geosite-google', `${A}-ip`])
  const plan = await policyDrillPlan({
    ipCidr: ['1.1.1.0/24'], domainKeyword: ['kw'], domainSuffix: ['gg.example'], domain: ['www.gg.example'],
    ruleUrls: [URL_A, URL_B],
    rulesets: ['geosite-google', 'geoip-missing', A, B, 'something-else', '../etc/passwd'],
  }, async (tag) => present.has(tag))
  assert.deepEqual(plan.custom, [
    { type: 'domain', content: 'www.gg.example' }, { type: 'domain_suffix', content: 'gg.example' },
    { type: 'domain_keyword', content: 'kw' }, { type: 'ip_cidr', content: '1.1.1.0/24' },
  ])
  assert.deepEqual(plan.rulesets, [
    { tag: 'geosite-google', source: 'geosite-google', url: '', parts: ['geosite-google'] },
    { tag: 'geoip-missing', source: 'geoip-missing', url: '', parts: [] },
    { tag: A, source: URL_A, url: URL_A, parts: [`${A}-ip`] },
    // 一份都没编出来:面板现拉网址展开,App 列进「没能展开」
    { tag: B, source: URL_B, url: URL_B, parts: [] },
    { tag: 'something-else', source: 'something-else', url: '', parts: [] },
    { tag: '../etc/passwd', source: '../etc/passwd', url: '', parts: [] },
  ])
})

test('GET /rulesets/preview:按网址拉回来解析,形状和 /rulesets/entries 一致;非 http 或 https直接 400;拉不动 503', async () => {
  clearRulesetEntriesCache()
  const ctx = createMockContext({})
  const paths = createPaths('/opt/open-box')
  let hits = 0
  const fetchImpl = async (url) => {
    hits += 1
    if (url.includes('bad')) return { ok: false, status: 502 }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('DOMAIN-SUFFIX,a.com\nb.com\nIP-CIDR,1.2.3.0/24,no-resolve\nMATCH,DIRECT\n') }
  }
  const app = express()
  registerRulesetRoutes(app, { ctx, paths, fetchImpl })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}/api/openbox/rulesets/preview`
  try {
    const ok = await (await fetch(`${base}?url=${encodeURIComponent('https://x.test/Check.list')}&limit=2`)).json()
    assert.equal(ok.total, 3)
    assert.equal(ok.matched, 3)
    assert.deepEqual(ok.entries, [{ type: 'domain_suffix', value: 'a.com' }, { type: 'domain_suffix', value: 'b.com' }])
    // 搜索走同一份缓存,不再拉第二次
    const q = await (await fetch(`${base}?url=${encodeURIComponent('https://x.test/Check.list')}&q=1.2`)).json()
    assert.equal(q.matched, 1)
    assert.equal(hits, 1)
    const bad = await fetch(`${base}?url=${encodeURIComponent('ftp://x.test/a')}`)
    assert.equal(bad.status, 400)
    const down = await fetch(`${base}?url=${encodeURIComponent('https://bad.test/a')}`)
    assert.equal(down.status, 503)
  } finally {
    await new Promise((r) => server.close(r))
  }
})
