import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { applyBackup, buildBackup, BACKUP_FORMAT, registerBackupBodyParser, registerBackupRoutes } from './backup.mjs'
import { registerSubscriptionRoutes } from './subscriptions.mjs'
import { createStore } from '../store/openbox-store.mjs'

const memStore = () => {
  const m = new Map()
  return createStore({
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, v),
    del: (k) => m.delete(k),
  })
}

const seed = (store) => {
  store.setProfile({ dns: { mode: 'hijack' }, routing: { policies: [{ name: 'AI', enabled: true, rulesets: ['geosite-openai'] }] }, traffic: { keepMonths: 12 } })
  store.setGroups([{ name: '香港-自动', type: 'urltest', members: [] }])
  store.setSubscriptions([{ id: 's1', name: '机场', url: 'https://x/sub' }, { id: 's2', name: '手动', kind: 'paste' }])
  // 节点记录的真实形状:没有 id,靠 tag 认
  store.setNodes([{ tag: 'HK-01', type: 'shadowsocks', server: '1.1.1.1', subscriptionId: 's1' }, { tag: 'US-01', type: 'tuic', server: '2.2.2.2', subscriptionId: 's2' }])
}

test('buildBackup:带档案和节点组,订阅 / 节点可选;不带密码、clash 密钥这类和机器绑定的东西', () => {
  const store = memStore()
  seed(store)
  store.getClashSecret()
  const full = buildBackup(store, { now: () => new Date(Date.UTC(2026, 8, 5, 12, 0, 0)), openboxVersion: 'v0.1.108' })
  assert.equal(full.format, BACKUP_FORMAT)
  assert.equal(full.version, 1)
  assert.equal(full.exportedAt, '2026-09-05T12:00:00.000Z')
  assert.equal(full.openboxVersion, 'v0.1.108')
  assert.equal(full.profile.dns.mode, 'hijack')
  // normalizeGroups 会把内置的直连 / 拒绝也带上,自定义组在中间
  assert.ok(full.groups.some((g) => g.name === '香港-自动'))
  assert.equal(full.subscriptions.length, 2)
  assert.equal(full.nodes.length, 2)
  assert.ok(!('clashSecret' in full) && !('password' in full) && !('deployState' in full))
  const slim = buildBackup(store, { subscriptions: false })
  assert.equal(slim.subscriptions, undefined)
  assert.equal(slim.nodes, undefined)
  assert.equal(slim.profile.dns.mode, 'hijack')
  assert.deepEqual(full.includes, { subscriptions: true, chainProxies: true, clientRoutes: true, servers: true })
  // 没单独说链式代理时沿用以前的规矩:跟着订阅走
  assert.deepEqual(slim.includes, { subscriptions: false, chainProxies: false, clientRoutes: true, servers: true })
})

test('终端分流 / 共享网络可选:不勾就从档案里去掉;导入这种文件不动现有的终端分流 / 共享网络', () => {
  const src = memStore()
  seed(src)
  src.setProfile({ clientRoutes: [{ id: 'c1', sources: ['10.0.0.9'], outbound: 'AI' }], servers: [{ id: 'sv1', name: '家里', protocol: 'shadowsocks', port: 8388 }] })
  const full = buildBackup(src)
  assert.equal(full.profile.clientRoutes.length, 1)
  assert.equal(full.profile.servers.length, 1)
  const partial = buildBackup(src, { clientRoutes: false, servers: false })
  assert.equal(partial.profile.clientRoutes, undefined)
  assert.equal(partial.profile.servers, undefined)
  assert.deepEqual(partial.includes, { subscriptions: true, chainProxies: true, clientRoutes: false, servers: false })
  // 导出时删的是拷贝,库里的没动
  assert.equal(src.getProfile().clientRoutes.length, 1)

  const dst = memStore()
  dst.setProfile({ clientRoutes: [{ id: 'keep', sources: ['10.0.0.1'], outbound: '直连' }], servers: [{ id: 'keepsv', name: '留着', protocol: 'vless', port: 443 }] })
  const r = applyBackup(dst, JSON.parse(JSON.stringify(partial)))
  assert.equal(r.error, undefined)
  assert.equal(dst.getProfile().clientRoutes[0].id, 'keep', '文件里没有终端分流,现有的不动')
  assert.equal(dst.getProfile().servers[0].id, 'keepsv', '文件里没有共享网络,现有的不动')
  assert.equal(dst.getProfile().dns.mode, 'hijack', '档案其他部分照样覆盖')
})

test('applyBackup:导进一个空库,档案 / 组 / 订阅 / 节点都在;老文件里的 rulesetDir 不落库;挂在不存在订阅上的节点丢掉', () => {
  const src = memStore()
  seed(src)
  const file = JSON.parse(JSON.stringify(buildBackup(src)))
  file.profile.rulesetDir = '/somewhere/else'
  file.nodes.push({ tag: '孤儿', type: 'vless', subscriptionId: 'missing' })
  file.nodes.push('not an object')
  file.nodes.push({ subscriptionId: 's1' })

  const dst = memStore()
  const r = applyBackup(dst, file)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.imported, { profile: true, groups: file.groups.length, subscriptions: 2, nodes: 2, subscriptionsMode: 'replace', panelSettings: 0, backgroundImage: false })
  assert.equal(dst.getProfile().dns.mode, 'hijack')
  assert.equal(dst.getProfile().traffic.keepMonths, 12)
  assert.equal(dst.getProfile().routing.policies[0].name, 'AI')
  assert.equal(dst.getProfile().rulesetDir, undefined, '本机路径是退役字段,不跟着文件走')
  assert.ok(dst.getGroups().some((g) => g.name === '香港-自动'))
  assert.deepEqual(dst.getSubscriptions().map((s) => s.id), ['s1', 's2'])
  assert.deepEqual(dst.getNodes().map((n) => n.tag), ['HK-01', 'US-01'], '没 tag 的、挂在不存在订阅上的都丢掉')
})

test('applyBackup 追加模式:现有订阅留着,文件里的加到后面;同一条订阅（id 相同）以文件里的为准、节点跟着换;档案照样覆盖', () => {
  const store = memStore()
  seed(store)
  const file = JSON.parse(JSON.stringify(buildBackup(store)))
  // 文件里 s1 改了名、节点换了一批;s2 没变;另外多一条新订阅 s3
  file.profile.dns.mode = 'off'
  file.subscriptions[0].name = '机场（新）'
  file.nodes = [{ tag: 'HK-02', type: 'shadowsocks', subscriptionId: 's1' }, { tag: 'US-01', type: 'tuic', subscriptionId: 's2' }, { tag: 'JP-01', type: 'vless', subscriptionId: 's3' }]
  file.subscriptions.push({ id: 's3', name: '第三家' })
  const r = applyBackup(store, file, { subscriptionsMode: 'append' })
  assert.equal(r.error, undefined)
  assert.equal(r.imported.subscriptionsMode, 'append')
  assert.equal(store.getProfile().dns.mode, 'off', '档案不分模式,一律覆盖')
  assert.deepEqual(store.getSubscriptions().map((s) => `${s.id}:${s.name}`), ['s1:机场（新）', 's2:手动', 's3:第三家'])
  assert.deepEqual(store.getNodes().map((n) => n.tag).sort(), ['HK-02', 'JP-01', 'US-01'], 's1 的旧节点 HK-01 换成了 HK-02,没有重复')
  assert.match(applyBackup(store, file, { subscriptionsMode: 'merge' }).error || '', /replace \/ append/)
})

test('applyBackup:不带订阅的文件不动现有订阅;格式不对、版本不认识、档案不合法都拒绝且不落库', () => {
  const store = memStore()
  seed(store)
  const slim = JSON.parse(JSON.stringify(buildBackup(store, { subscriptions: false })))
  slim.profile.dns.mode = 'off'
  assert.equal(applyBackup(store, slim).error, undefined)
  assert.equal(store.getProfile().dns.mode, 'off')
  assert.equal(store.getSubscriptions().length, 2, '文件里没有订阅就不碰')

  assert.match(applyBackup(store, { hello: 1 }).error, /不是 Open-Box/)
  assert.match(applyBackup(store, { format: BACKUP_FORMAT, version: 99, profile: {} }).error, /版本/)
  const bad = JSON.parse(JSON.stringify(buildBackup(store)))
  bad.profile.dns.mode = 'nonsense'
  assert.match(applyBackup(store, bad).error, /档案不合法/)
  assert.equal(store.getProfile().dns.mode, 'off', '校验不过就什么都不改')
  // 组名和站点集同名:和 PUT /groups、PUT /profile 一样拦下
  const clash = JSON.parse(JSON.stringify(buildBackup(store)))
  clash.groups = [{ name: 'AI', type: 'urltest', members: [] }]
  assert.match(applyBackup(store, clash).error, /档案不合法/)
})

test('HTTP:GET /backup 按 subscriptions 参数决定带不带订阅;POST /backup/import 落库,坏文件 400', async () => {
  const store = memStore()
  seed(store)
  const app = express()
  registerBackupRoutes(app, { store, readVersion: async () => 'v0.1.108' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const full = await (await fetch(`${base}/api/openbox/backup`)).json()
    assert.equal(full.openboxVersion, 'v0.1.108')
    assert.equal(full.nodes.length, 2)
    const slim = await (await fetch(`${base}/api/openbox/backup?subscriptions=0&servers=0`)).json()
    assert.equal(slim.nodes, undefined)
    assert.equal(slim.profile.servers, undefined)
    assert.ok(Array.isArray(slim.profile.clientRoutes))

    const dst = memStore()
    const app2 = express()
    registerBackupRoutes(app2, { store: dst })
    const server2 = app2.listen(0, '127.0.0.1')
    await new Promise((r) => server2.once('listening', r))
    const base2 = `http://127.0.0.1:${server2.address().port}`
    try {
      const ok = await fetch(`${base2}/api/openbox/backup/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(full) })
      assert.equal(ok.status, 200)
      assert.deepEqual((await ok.json()).imported, { profile: true, groups: full.groups.length, subscriptions: 2, nodes: 2, subscriptionsMode: 'replace', panelSettings: 0, backgroundImage: false })
      assert.equal(dst.getNodes().length, 2)
      // 追加导入:现有的留着,文件里的加到后面;模式写错 400
      dst.setSubscriptions([{ id: 'old', name: '老订阅' }])
      dst.setNodes([{ tag: 'OLD-01', type: 'vless', subscriptionId: 'old' }])
      const app_ = await fetch(`${base2}/api/openbox/backup/import?subscriptions=append`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(full) })
      assert.equal(app_.status, 200)
      assert.deepEqual(dst.getSubscriptions().map((s) => s.id), ['old', 's1', 's2'])
      assert.deepEqual(dst.getNodes().map((n) => n.tag), ['OLD-01', 'HK-01', 'US-01'])
      const badMode = await fetch(`${base2}/api/openbox/backup/import?subscriptions=merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(full) })
      assert.equal(badMode.status, 400)
      const bad = await fetch(`${base2}/api/openbox/backup/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'x' }) })
      assert.equal(bad.status, 400)
    } finally {
      await new Promise((r) => server2.close(r))
    }
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('面板设置和背景图:导出只带 config/ 且不是密码的键;导入整份换掉面板设置、背景图给空串就清掉', () => {
  const store = memStore()
  seed(store)
  const kv = new Map([
    ['config/language', 'zh'],
    ['config/global-radius', '15'],
    ['config/access-password-hash', 'SECRET'],
    ['openbox/profile', '{}'],
  ])
  let background = 'data:image/png;base64,AAAA'
  const panelStorage = {
    readEntries: () => Object.fromEntries([...kv].filter(([k]) => !k.startsWith('openbox/') && !k.startsWith('config/access-'))),
    writeEntries: (entries) => {
      for (const k of [...kv.keys()]) if (k.startsWith('config/') && !k.startsWith('config/access-')) kv.delete(k)
      for (const [k, v] of Object.entries(entries)) kv.set(k, v)
    },
    getBackground: () => background,
    setBackground: (img) => { background = img },
  }
  const file = buildBackup(store, { panelStorage })
  assert.deepEqual(file.panelSettings, { 'config/language': 'zh', 'config/global-radius': '15' }, '密码和 openbox/* 不导')
  assert.equal(file.backgroundImage, 'data:image/png;base64,AAAA')
  // 不给 panelStorage 就不带这两块(老调用方)
  assert.equal(buildBackup(store).panelSettings, undefined)

  // 导入:文件里夹带密码键 / 非字符串值 / 别的前缀,一律丢掉;背景图空串清掉
  const incoming = JSON.parse(JSON.stringify(file))
  incoming.panelSettings = { 'config/language': 'en', 'config/theme-mode': 'dark', 'config/access-password-hash': 'EVIL', 'openbox/profile': 'x', 'config/bad': 123 }
  incoming.backgroundImage = ''
  const r = applyBackup(store, incoming, { panelStorage })
  assert.equal(r.error, undefined)
  assert.equal(r.imported.panelSettings, 2)
  assert.equal(r.imported.backgroundImage, true)
  assert.equal(kv.get('config/language'), 'en')
  assert.equal(kv.get('config/theme-mode'), 'dark')
  assert.equal(kv.get('config/global-radius'), undefined, '整份替换:文件里没有的面板设置键删掉')
  assert.equal(kv.get('config/access-password-hash'), 'SECRET', '密码不动')
  assert.equal(kv.get('openbox/profile'), '{}')
  assert.equal(background, '', '背景图空串 = 清掉')
  // 文件里没有这两块就不碰
  const plain = JSON.parse(JSON.stringify(buildBackup(store)))
  background = 'keep'
  const r2 = applyBackup(store, plain, { panelStorage })
  assert.equal(r2.imported.panelSettings, 0)
  assert.equal(r2.imported.backgroundImage, false)
  assert.equal(background, 'keep')
  assert.equal(kv.get('config/language'), 'en')
})

test('applyBackup:老版本导出的文件（地区层 / 广告拦截 / rulesetDir / DoH 上游）导入后档案里只剩现行字段', () => {
  const dst = memStore()
  const r = applyBackup(dst, {
    format: 'open-box-backup',
    version: 1,
    profile: {
      region: 'CN',
      rulesetDir: '/opt/open-box/data/rulesets',
      dns: { split: true, mode: 'dnsmasq', direct: '223.5.5.5', proxy: 'https://1.1.1.1/dns-query' },
      routing: {
        proxyTag: 'PROXY',
        regions: [{ id: 'cn', name: '中国大陆', catchAll: 'proxy', rules: [{ type: 'geosite', value: 'cn', action: 'direct' }] }],
        regionMode: 'CN',
        outboundOptions: { direct: true, reject: true, groups: true },
        policies: [{ id: 'ai', name: 'AI', rulesets: ['geosite-openai'] }],
        adBlock: false,
        adRuleset: 'geosite-category-ads-all',
        categories: [],
        directRulesets: ['geosite-cn', 'geoip-cn'],
        fallback: 'PROXY',
      },
    },
    groups: [],
  })
  assert.equal(r.error, undefined)
  const p = dst.getProfile()
  assert.equal(p.region, undefined)
  assert.equal(p.rulesetDir, undefined)
  assert.equal(p.dns.proxy, '1.1.1.1')
  for (const key of ['proxyTag', 'regions', 'regionMode', 'outboundOptions', 'adBlock', 'adRuleset', 'categories', 'directRulesets', 'fallback']) {
    assert.equal(key in p.routing, false, key)
  }
  assert.deepEqual(p.routing.policies.map((x) => x.name), ['AI', '中国大陆·直连'])
  assert.equal(p.routing.fallbackDefault, 'proxy')
  // 再导出就没有这些字段了
  const again = buildBackup(dst)
  assert.equal('rulesetDir' in again.profile, false)
  assert.equal('regions' in again.profile.routing, false)
})

// id 只认 ASCII(界面上是随机生成的),名字随便起
let chainSeq = 0
const CHAIN = (name, upstream = '香港-自动') => ({ id: `chain-${++chainSeq}`, enabled: true, name, link: 'socks5://user:pw@203.0.113.9:1080', upstream })

test('链式代理有自己的勾:和订阅互不牵连;不勾就不进文件,导入这种文件不动现有的链式代理;导入结果里报条数', () => {
  const src = memStore()
  seed(src)
  src.setProfile({ chainProxies: [CHAIN('英国-住宅')] })
  // 只要链式代理、不要订阅
  const chainOnly = buildBackup(src, { subscriptions: false, chainProxies: true })
  assert.equal(chainOnly.subscriptions, undefined)
  assert.equal(chainOnly.profile.chainProxies.length, 1)
  assert.equal(chainOnly.profile.chainProxies[0].link, 'socks5://user:pw@203.0.113.9:1080')
  assert.deepEqual(chainOnly.includes, { subscriptions: false, chainProxies: true, clientRoutes: true, servers: true })
  // 要订阅、不要链式代理
  const noChain = buildBackup(src, { chainProxies: false })
  assert.equal(noChain.subscriptions.length, 2)
  assert.equal(noChain.profile.chainProxies, undefined)
  assert.equal(src.getProfile().chainProxies.length, 1, '导出时删的是拷贝,库里的没动')

  // 导入不带链式代理的文件:这台上原有的留着
  const dst = memStore()
  seed(dst)
  dst.setProfile({ chainProxies: [CHAIN('本机-住宅')] })
  const kept = applyBackup(dst, JSON.parse(JSON.stringify(noChain)))
  assert.equal(kept.error, undefined)
  assert.equal(kept.imported.chainProxies, undefined, '文件里没有链式代理就不报这一项')
  assert.deepEqual(dst.getProfile().chainProxies.map((c) => c.name), ['本机-住宅'])
  // 导入带链式代理的文件:整份换成文件里的,摘要(类型 / 地址 / 端口)由库重算
  const replaced = applyBackup(dst, JSON.parse(JSON.stringify(chainOnly)))
  assert.equal(replaced.imported.chainProxies, 1)
  assert.deepEqual(dst.getProfile().chainProxies.map((c) => c.name), ['英国-住宅'])
  assert.deepEqual(dst.getProfile().chainProxies[0].node, { type: 'socks', server: '203.0.113.9', port: 1080 })
})

test('导入时按「导入之后」的样子核对链式代理重名:和节点 / 节点组 / 站点集撞了就整个不导,什么都不写', () => {
  // 这台上有链式代理「香港-备用」,文件(不带链式代理)里的节点组也叫这个名字
  const dst = memStore()
  seed(dst)
  dst.setProfile({ chainProxies: [CHAIN('香港-备用')] })
  const file = buildBackup((() => { const s = memStore(); seed(s); s.setGroups([{ name: '香港-自动', type: 'urltest', members: [] }, { name: '香港-备用', type: 'selector', members: [] }]); return s })(), { chainProxies: false })
  const before = JSON.stringify([dst.getProfile(), dst.getGroups(), dst.getNodes()])
  const r = applyBackup(dst, JSON.parse(JSON.stringify(file)))
  assert.match(r.error, /链式代理「香港-备用」和导入后的节点、节点组或站点集重名/)
  assert.equal(JSON.stringify([dst.getProfile(), dst.getGroups(), dst.getNodes()]), before)

  // 文件里的链式代理和这台上现有的节点重名(文件不带订阅):同样拒绝
  const src2 = memStore()
  seed(src2)
  src2.setProfile({ chainProxies: [CHAIN('HK-01')] })
  const r2 = applyBackup(dst, JSON.parse(JSON.stringify(buildBackup(src2, { subscriptions: false, chainProxies: true }))))
  assert.match(r2.error, /链式代理「HK-01」/)

  // 追加订阅:文件里的节点和这台上的链式代理重名
  const dst3 = memStore()
  seed(dst3)
  dst3.setProfile({ chainProxies: [CHAIN('JP-01')] })
  const src3 = memStore()
  seed(src3)
  src3.setSubscriptions([{ id: 's9', name: '另一家', url: 'https://y/sub' }])
  src3.setNodes([{ tag: 'JP-01', type: 'shadowsocks', server: '3.3.3.3', subscriptionId: 's9' }])
  const r3 = applyBackup(dst3, JSON.parse(JSON.stringify(buildBackup(src3, { chainProxies: false }))), { subscriptionsMode: 'append' })
  assert.match(r3.error, /链式代理「JP-01」/)

  // 不撞的正常导入
  const ok = applyBackup(dst3, JSON.parse(JSON.stringify(buildBackup(src2, { subscriptions: false, chainProxies: false }))))
  assert.equal(ok.error, undefined)
})

test('接口:chainProxies=0 不带链式代理;老前端不带这个参数时跟着 subscriptions 走', async () => {
  const store = memStore()
  seed(store)
  store.setProfile({ chainProxies: [CHAIN('英国-住宅')] })
  const app = express()
  registerBackupRoutes(app, { store })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const get = (q) => fetch(`http://127.0.0.1:${server.address().port}/api/openbox/backup${q}`).then((r) => r.json())
    assert.equal((await get('?subscriptions=1&chainProxies=0')).profile.chainProxies, undefined)
    assert.equal((await get('?subscriptions=0&chainProxies=1')).profile.chainProxies.length, 1)
    assert.equal((await get('?subscriptions=0')).profile.chainProxies, undefined)
    assert.equal((await get('')).profile.chainProxies.length, 1)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('「切换重启内核」开关已经去掉:导出的档案里没有这个键;老版本导出的备份带着它(两个老键都算)照样能导,不落库;值不是布尔的坏文件整个不导', () => {
  const src = memStore()
  seed(src)
  src.setProfile({ rejectQuic: true })
  const file = JSON.parse(JSON.stringify(buildBackup(src)))
  assert.equal('restartOnFlip' in file.profile, false)
  assert.equal('restartOnClassFlip' in file.profile, false)
  // v0.1.208 / v0.1.209 导出的(restartOnFlip)、v0.1.207 导出的(restartOnClassFlip):开关存的是什么都一样
  for (const legacy of [{ restartOnFlip: true }, { restartOnFlip: false }, { restartOnClassFlip: true }]) {
    const old = JSON.parse(JSON.stringify(file))
    Object.assign(old.profile, legacy)
    const dst = memStore()
    assert.equal(applyBackup(dst, old).error, undefined)
    assert.equal('restartOnFlip' in dst.getProfile(), false)
    assert.equal('restartOnClassFlip' in dst.getProfile(), false)
    assert.equal(dst.getProfile().rejectQuic, true, '别的设置照常导入')
  }
  const bad = JSON.parse(JSON.stringify(file))
  bad.profile.restartOnFlip = 'no'
  assert.match(applyBackup(memStore(), bad).error, /restartOnFlip must be a boolean/)
  // 导出的文件里不带任何热切换的运行态(开关文件、部署元数据都是机器上的东西)
  assert.ok(!JSON.stringify(file).includes('obflip'))
})

test('HTTP:备份超过 10 MB 也能导入——排在前面的订阅路由(10 MB 解析器)不能先把它拦成 413(#303)', async () => {
  const store = memStore()
  seed(store)
  const full = buildBackup(store, { subscriptions: true })
  // 撑到 11 MB 左右:一大把节点,每个带一段长备注
  const pad = 'x'.repeat(2000)
  full.nodes = Array.from({ length: 5600 }, (_, i) => ({ tag: `N-${i}`, type: 'ss', server: '1.2.3.4', server_port: 1000 + (i % 50000), subscriptionId: 's1', note: pad }))
  const body = JSON.stringify(full)
  assert.ok(body.length > 10 * 1024 * 1024, `测试数据要超过 10 MB,现在 ${body.length}`)
  // 和 index.mjs 一样的注册顺序:先挂备份的解析器,再挂订阅路由,最后挂备份路由
  const dst = memStore()
  const app = express()
  registerBackupBodyParser(app)
  registerSubscriptionRoutes(app, { store: dst })
  registerBackupRoutes(app, { store: dst })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/openbox/backup/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    assert.equal(res.status, 200, await res.clone().text().then((t) => t.slice(0, 200)))
    assert.equal(dst.getNodes().length, 5600)
  } finally {
    await new Promise((r) => server.close(r))
  }
})
