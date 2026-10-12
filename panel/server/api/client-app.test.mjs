import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { loadIconIndex } from '../engine/icon-index.mjs'
import { createStore } from '../store/openbox-store.mjs'
import { ROUTER_ID_KEY, lanAddresses, registerClientAppRoutes, registerPublicClientRoutes, routerId } from './client-app.mjs'
import { EGRESS_COUNTRY_KEY } from '../system/router-region.mjs'
import { BACKGROUND_IMAGE_KEY } from '../system/seed-defaults.mjs'
import { DEFAULT_SHARE_REGIONS, shareRegionsVersion } from '../engine/share-regions.mjs'
import { listTagForUrl, ruleListIpTag } from '../engine/rule-list.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { listStatePath } from '../system/rule-lists.mjs'

const setup = async ({ detectCountry, ctx = null, paths = null, publicCtx = null, publicPaths = null } = {}) => {
  const map = new Map()
  const store = createStore({ get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), del: (k) => map.delete(k) })
  const geoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-geo-'))
  fs.writeFileSync(path.join(geoDir, 'geosite-cn.srs'), Buffer.from('SRS-test'))
  const app = express()
  registerPublicClientRoutes(app, { store, geoDir, ctx: publicCtx, paths: publicPaths })
  registerClientAppRoutes(app, { store, ctx, paths, ...(detectCountry ? { detectCountry } : {}) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return {
    store, map,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('router id is generated once, stored under a protected key, and stable', async () => {
  const { store, map, close } = await setup()
  try {
    const id = routerId(store)
    assert.match(id, /^[0-9a-f]{32}$/)
    assert.equal(routerId(store), id)
    assert.equal(map.get(ROUTER_ID_KEY), id)
    assert.ok(ROUTER_ID_KEY.startsWith('openbox/'))
  } finally { await close() }
})

test('public client routes answer only for this router id', async () => {
  const { store, base, close } = await setup()
  try {
    const id = routerId(store)
    assert.equal((await fetch(`${base}/client/v1/home/${id}`)).status, 200)
    assert.equal((await fetch(`${base}/client/v1/home/${'0'.repeat(32)}`)).status, 404)
    const regions = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(regions.groups, DEFAULT_SHARE_REGIONS)
    assert.equal(regions.version, shareRegionsVersion(DEFAULT_SHARE_REGIONS))
    // 改过的地区分流:版本跟着变
    const custom = [{ ...structuredClone(DEFAULT_SHARE_REGIONS[2]) }]
    store.setProfile({ shareRegions: custom })
    const next = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(next.groups, custom)
    assert.notEqual(next.version, regions.version)
    // 规则集:只认 geosite- / geoip- 开头的名字,目录穿越和不存在的都 404
    const srs = await fetch(`${base}/client/v1/${id}/geodata/geosite-cn.srs`)
    assert.equal(srs.status, 200)
    assert.equal(Buffer.from(await srs.arrayBuffer()).toString(), 'SRS-test')
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/geoip-xx.srs`)).status, 404)
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/..%2F..%2Fetc%2Fpasswd`)).status, 404)
    assert.equal((await fetch(`${base}/client/v1/${'f'.repeat(32)}/geodata/geosite-cn.srs`)).status, 404)
  } finally { await close() }
})

test('regions 顺带回共享网络服务器的 ID / 名字(按共享网络页的顺序、只要在用的、没有凭据)和服务器信息;版本只跟地区分流走', async () => {
  const { store, base, close } = await setup()
  try {
    const id = routerId(store)
    const before = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(before.nodes, [])
    // 什么都没设:名称是「Open-Box」(不带版本号),没判过出口国家就没有地区,没有图标
    assert.deepEqual(before.server, { name: 'Open-Box', icon: '', iconSvg: '', region: '', regionSvg: '', regionAuto: true })
    store.setProfile({ servers: [
      { id: 'home', enabled: true, name: 'HOME', protocol: 'shadowsocks', port: 8388, method: 'aes-256-gcm', password: 'secret-1' },
      { id: 'off', enabled: false, name: 'OFF', protocol: 'shadowsocks', port: 8389, method: 'aes-256-gcm', password: 'secret-2' },
      { id: 'hk', name: 'HK', protocol: 'shadowsocks', port: 8391, method: 'aes-256-gcm', password: 'secret-4' },
    ] })
    store.setRaw(EGRESS_COUNTRY_KEY, JSON.stringify({ ip: '1.2.3.4', country: 'CN', at: 1 }))
    const after = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(after.nodes, [{ id: 'home', name: 'HOME' }, { id: 'hk', name: 'HK' }])
    // 地区没手动选:用出口 IP 判出来的
    assert.equal(after.server.region, 'CN')
    assert.equal(after.server.regionAuto, true)
    // 国旗 App 不自带:按地区代码从图标索引带上
    assert.match(after.server.regionSvg, /^<svg/)
    // 设了服务器信息:图标 SVG 由服务端按代码从图标索引现取(国旗也有),索引里没有的代码才用保存时存的那份
    store.setProfile({ serverInfo: { name: '家里', icon: 'brand:openai', region: 'HK' } })
    const custom = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    const index = loadIconIndex()
    assert.deepEqual(custom.server, { name: '家里', icon: 'brand:openai', iconSvg: index['brand:openai'], region: 'HK', regionSvg: index.HK, regionAuto: false })
    store.setProfile({ serverInfo: { icon: 'brand:not-in-index', iconSvg: '<svg id="saved"/>' } })
    const fallback = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.equal(fallback.server.iconSvg, '<svg id="saved"/>')
    // 节点信息、服务器信息变了地区分流的版本不变(App 不用重载分流)
    assert.equal(after.version, before.version)
    assert.equal(custom.version, before.version)
    assert.ok(!JSON.stringify(after).includes('secret'))
  } finally { await close() }
})

test('regions 带面板背景的元数据(不算进地区分流的 version);background 接口回上传的图,网址 302 跳过去,没设 404', async () => {
  const { store, map, base, close } = await setup()
  try {
    const id = routerId(store)
    assert.equal((await (await fetch(`${base}/client/v1/${id}/regions`)).json()).background, null)
    assert.equal((await fetch(`${base}/client/v1/${id}/background`)).status, 404)

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    map.set('config/custom-background-image', 'local-image-1788361724032')
    map.set(BACKGROUND_IMAGE_KEY, `data:image/png;base64,${png.toString('base64')}`)
    map.set('config/dashboard-transparent', '84')
    map.set('config/blur-intensity', '16')
    const version = createHash('sha256').update(png).digest('hex').slice(0, 16)
    const regions = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(regions.background, { version, transparent: 84, blur: 16 })
    assert.equal(regions.version, shareRegionsVersion(DEFAULT_SHARE_REGIONS))

    const image = await fetch(`${base}/client/v1/${id}/background`)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('x-openbox-background-version'), version)
    assert.equal(image.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
    assert.equal((await fetch(`${base}/client/v1/${'f'.repeat(32)}/background`)).status, 404)

    // 面板填的是网址:App 跟着 302 自己去下(和浏览器一样),路由器不替它取
    map.set('config/custom-background-image', 'https://example.com/bg.jpg')
    const moved = await fetch(`${base}/client/v1/${id}/background`, { redirect: 'manual' })
    assert.equal(moved.status, 302)
    assert.match(moved.headers.get('location'), /^https:\/\/example\.com\/bg\.jpg\?v=\d{4}-\d{2}-\d{2}$/)
  } finally { await close() }
})

test('info 带服务器信息的现值、默认名称和出口国家;egress-country 按出口 IP 判一次', async () => {
  const calls = []
  const detectCountry = async ({ store }) => {
    calls.push('detect')
    const record = { ip: '8.8.8.8', country: 'US', at: 2 }
    store.setRaw(EGRESS_COUNTRY_KEY, JSON.stringify(record))
    return record
  }
  const { store, base, close } = await setup({ detectCountry, ctx: {}, paths: {} })
  try {
    const info = await (await fetch(`${base}/api/openbox/client-app/info`)).json()
    assert.deepEqual(info.serverInfo, {})
    assert.deepEqual(info.serverInfoDefaults, { name: 'Open-Box' })
    assert.equal(info.egressCountry, null)
    const detected = await (await fetch(`${base}/api/openbox/client-app/egress-country`, { method: 'POST' })).json()
    assert.deepEqual(detected, { ip: '8.8.8.8', country: 'US', at: 2 })
    assert.deepEqual(calls, ['detect'])
    store.setProfile({ serverInfo: { name: 'X' } })
    const again = await (await fetch(`${base}/api/openbox/client-app/info`)).json()
    assert.deepEqual(again.serverInfo, { name: 'X' })
    assert.deepEqual(again.egressCountry, { ip: '8.8.8.8', country: 'US', at: 2 })
  } finally { await close() }
})

test('info route gives what the share page needs to build App codes', async () => {
  const { store, base, close } = await setup()
  try {
    const info = await (await fetch(`${base}/api/openbox/client-app/info`)).json()
    assert.equal(info.routerId, routerId(store))
    assert.equal(typeof info.routerName, 'string')
    assert.ok(Number.isInteger(info.panelPort))
    assert.deepEqual(info.lanAddresses, [])
    assert.equal(info.shareRegionsCustomized, false)
    assert.deepEqual(info.shareRegions, DEFAULT_SHARE_REGIONS)
    assert.deepEqual(info.defaultShareRegions, DEFAULT_SHARE_REGIONS)
  } finally { await close() }
})

test('LAN addresses come from the LAN interfaces, IPv4 first', async () => {
  const addr4 = [
    '2: eth0    inet 203.0.113.9/24 brd 203.0.113.255 scope global eth0',
    '3: br-lan    inet 192.168.3.1/24 brd 192.168.3.255 scope global br-lan',
  ].join('\n')
  const addr6 = '3: br-lan    inet6 fd00:3::1/64 scope global'
  const ctx = {
    exec: async (cmd, args) => {
      if (cmd === 'ip') return { code: 0, stdout: args[0] === '-4' ? addr4 : addr6 }
      return { code: 1, stdout: '' }
    },
  }
  assert.deepEqual(await lanAddresses(ctx, 'openwrt'), ['192.168.3.1', 'fd00:3::1'])
  // Debian / Ubuntu:没有 netifd,按地址猜;内核的 tun 和容器网桥也是私网地址,不能当成局域网口(ubuntu23 实测过)
  const debian = {
    exec: async (cmd, args) => ({
      code: 0,
      stdout: args[0] === '-4'
        ? '2: eth0    inet 192.168.3.23/24 brd 192.168.3.255 scope global eth0\n5: openbox-tun    inet 172.19.0.1/30 scope global openbox-tun\n6: docker0    inet 172.17.0.1/16 scope global docker0'
        : '',
    }),
  }
  assert.deepEqual(await lanAddresses(debian, 'systemd'), ['192.168.3.23'])
  assert.deepEqual(await lanAddresses(null, 'openwrt'), [])
  // 读地址失败就是空,不让接口出错
  assert.deepEqual(await lanAddresses({ exec: async () => { throw new Error('no ip') } }, 'openwrt'), [])
})

// 地区分流和目标分流对齐(用户 2026-10-05):域名关键词、规则集链接只发给带 rules=2 的新 App;规则集链接带路由器编好的几份,
// 下载走 geodata/<list-xxx>,只放行现在引用到的
test('regions:老 App 拿不到新类型的规则;rules=2 拿到全部,规则集链接带编好的几份(sha256 是文件字节);geodata 只放行引用到的 list-', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-share-lists-'))
  const paths = createPaths(root)
  fs.mkdirSync(paths.rulesetDir, { recursive: true })
  const compiled = 'https://lists.example.com/ai.list'
  const pending = 'https://lists.example.com/new.list'
  const tag = listTagForUrl(compiled)
  fs.writeFileSync(path.join(paths.rulesetDir, `${tag}.srs`), Buffer.from('SRS-domains'))
  fs.writeFileSync(path.join(paths.rulesetDir, `${ruleListIpTag(tag)}.srs`), Buffer.from('SRS-ips'))
  // 站点集的名单:磁盘上有,但地区组没引用,不能经这个接口拿走
  const other = listTagForUrl('https://lists.example.com/routing-only.list')
  fs.writeFileSync(path.join(paths.rulesetDir, `${other}.srs`), Buffer.from('SRS-other'))
  const state = { [tag]: { url: compiled, at: 1, counts: { domain_suffix: 3, ip_cidr: 2 }, split: 2 } }
  const ctx = createMockContext({ files: { [listStatePath(paths)]: JSON.stringify(state) } })
  const { store, base, close } = await setup({ publicCtx: ctx, publicPaths: paths })
  try {
    const id = routerId(store)
    const groups = structuredClone(DEFAULT_SHARE_REGIONS)
    groups[2].rules = [
      { type: 'domainKeyword', value: 'openai', action: 'proxy' },
      { type: 'ruleUrl', value: compiled, action: 'proxy' },
      { type: 'ruleUrl', value: pending, action: 'proxy' },
      ...groups[2].rules,
    ]
    store.setProfile({ shareRegions: groups })
    const legacy = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(legacy.groups[2].rules.map((r) => r.type), ['geosite', 'geoip'], '老 App:新类型的规则删掉')
    assert.equal(legacy.version, shareRegionsVersion(legacy.groups))

    const fresh = await (await fetch(`${base}/client/v1/${id}/regions?rules=2`)).json()
    const rules = fresh.groups[2].rules
    assert.deepEqual(rules.map((r) => r.type), ['domainKeyword', 'ruleUrl', 'ruleUrl', 'geosite', 'geoip'])
    const sha = (text) => createHash('sha256').update(text).digest('hex')
    assert.deepEqual(rules[1].sets, [
      { tag, kind: 'domain', sha256: sha('SRS-domains') },
      { tag: ruleListIpTag(tag), kind: 'ip', sha256: sha('SRS-ips') },
    ])
    assert.deepEqual(rules[2].sets, [], '还没编好的:空的,App 当这条不生效')
    assert.notEqual(fresh.version, legacy.version)

    const srs = await fetch(`${base}/client/v1/${id}/geodata/${ruleListIpTag(tag)}.srs`)
    assert.equal(srs.status, 200)
    assert.equal(Buffer.from(await srs.arrayBuffer()).toString(), 'SRS-ips')
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/${other}.srs`)).status, 404, '没被地区组引用的不给')
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/${listTagForUrl(pending)}.srs`)).status, 404, '还没编出来的 404')
    // 删掉这条规则之后,原来编好的也不再给
    store.setProfile({ shareRegions: DEFAULT_SHARE_REGIONS })
    assert.equal((await fetch(`${base}/client/v1/${id}/geodata/${tag}.srs`)).status, 404)
  } finally {
    await close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 家里局域网(用户 2026-10-08):地区分流发给 App 时每组最前面自动带「局域网网段 → 回路由器」,version 跟着变;info 带上给地区分流页显示
test('regions 每组最前面自动带家里局域网网段 → 回路由器(档案里不存);info 带 lanSubnets', async () => {
  const addr4 = '2: eth0    inet 203.0.113.9/24 scope global eth0\n3: br-lan    inet 192.168.5.1/24 brd 192.168.5.255 scope global br-lan'
  const lanCtx = { exec: async (cmd, args) => (cmd === 'ip' ? { code: 0, stdout: args[0] === '-4' ? addr4 : '' } : { code: 1, stdout: '' }) }
  const { store, base, close } = await setup({ ctx: lanCtx, publicCtx: lanCtx })
  try {
    const id = routerId(store)
    const regions = await (await fetch(`${base}/client/v1/${id}/regions?rules=2`)).json()
    const lanRule = { type: 'ipcidr', value: '192.168.5.0/24', action: 'proxy' }
    assert.deepEqual(regions.groups.map((g) => g.rules[0]), DEFAULT_SHARE_REGIONS.map(() => lanRule))
    assert.deepEqual(regions.groups.map((g) => g.rules.slice(1)), DEFAULT_SHARE_REGIONS.map((g) => g.rules))
    assert.equal(regions.version, shareRegionsVersion(regions.groups))
    assert.notEqual(regions.version, shareRegionsVersion(DEFAULT_SHARE_REGIONS))
    // 老 App(不带 rules=2)也有:ipcidr 它认得
    const legacy = await (await fetch(`${base}/client/v1/${id}/regions`)).json()
    assert.deepEqual(legacy.groups.map((g) => g.rules[0]), DEFAULT_SHARE_REGIONS.map(() => lanRule))
    const info = await (await fetch(`${base}/api/openbox/client-app/info`)).json()
    assert.deepEqual(info.lanSubnets, ['192.168.5.0/24'])
    assert.deepEqual(info.shareRegions, DEFAULT_SHARE_REGIONS)
  } finally { await close() }
})
