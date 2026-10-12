import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerProfileRoutes, validateProfilePatch, reservedPolicyNames } from './profile.mjs'
import { createStore, DEFAULT_PROFILE } from '../store/openbox-store.mjs'

const memStore = () => {
  const m = new Map()
  return createStore({
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, v),
    del: (k) => m.delete(k),
  })
}

// 起一个绑定临时端口的最小 express app,注册待测路由,返回 baseUrl 供 fetch 打真实 HTTP 请求;
// close() 必须在 finally 里调用,防止测试遗留监听中的 server。
const startApp = async (storeOverride) => {
  const store = storeOverride || memStore()
  const app = express()
  registerProfileRoutes(app, { store })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const { port } = server.address()
  return {
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const putJson = (baseUrl, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// -------- validateProfilePatch 单测 --------

test('validateProfilePatch 空 patch 通过', () => {
  assert.equal(validateProfilePatch({}), null)
})

test('validateProfilePatch ipv6 非布尔 → 报错', () => {
  assert.ok(validateProfilePatch({ ipv6: 'yes' }))
})

test('validateProfilePatch 只碰 ipv6 不要求提供 dns（部分 patch 只校验出现的字段）', () => {
  assert.equal(validateProfilePatch({ ipv6: false }), null)
})

// GitHub #482:全局的可接受状态码(内核 tcp19),写法和内核一样;空 / * = 不限
test('validateProfilePatch testExpectedStatus 写法不对 → 报错;空、*、状态码和范围通过', () => {
  for (const bad of ['abc', '99', '300-200', 204]) assert.ok(validateProfilePatch({ testExpectedStatus: bad }), String(bad))
  for (const ok of ['', '*', '204', '200-399/204']) assert.equal(validateProfilePatch({ testExpectedStatus: ok }), null, ok)
})

test('validateProfilePatch updates.openbox.days 必须是 1-30 的整数', () => {
  assert.ok(validateProfilePatch({ updates: { openbox: { days: 0 } } }))
  assert.ok(validateProfilePatch({ updates: { openbox: { days: 31 } } }))
  assert.equal(validateProfilePatch({ updates: { openbox: { days: 7 } } }), null)
})

test('validateProfilePatch dns.mode 非法值 → 报错', () => {
  assert.ok(validateProfilePatch({ dns: { mode: 'foo' } }))
})

test('validateProfilePatch dns.mode 合法值（off/hijack/dnsmasq）通过', () => {
  assert.equal(validateProfilePatch({ dns: { mode: 'dnsmasq' } }), null)
  assert.equal(validateProfilePatch({ dns: { mode: 'hijack' } }), null)
  assert.equal(validateProfilePatch({ dns: { mode: 'off' } }), null)
})

test('validateProfilePatch dns 非对象 → 报错', () => {
  assert.ok(validateProfilePatch({ dns: 'nope' }))
})

test('validateProfilePatch routing 非对象 → 报错', () => {
  assert.ok(validateProfilePatch({ routing: 'nope' }))
})

test('validateProfilePatch 非对象 patch → 报错', () => {
  assert.ok(validateProfilePatch(null))
  assert.ok(validateProfilePatch('nope'))
})

// -------- Important 5:规则集 tag 内容校验 --------
// policies[].rulesets 最终原样进入生成配置的 rule_set.path,并作为参数传给
// `sing-box rule-set match`(execFile 无 shell,非命令注入,但属任意路径读取尝试 + 配置损坏)。

test('validateProfilePatch dns.direct / dns.proxy 只收裸 IP 或上游 DNS 记号 wan:域名、带协议 / 端口 / 路径、空串的报错;协议只认 udp / tcp;地区只认 cn / intl', () => {
  assert.equal(validateProfilePatch({ dns: { direct: '223.5.5.5', proxy: '1.1.1.1' } }), null)
  assert.equal(validateProfilePatch({ dns: { direct: '2400:3200::1' } }), null)
  assert.match(validateProfilePatch({ dns: { proxy: 'dns.google' } }), /dns\.proxy/)
  assert.match(validateProfilePatch({ dns: { proxy: 'https://1.1.1.1/dns-query' } }), /dns\.proxy/)
  assert.match(validateProfilePatch({ dns: { direct: '223.5.5.5:53' } }), /dns\.direct/)
  // 上游 DNS(系统的上游 DNS)记成 wan,主上游、备用都能用;同一侧最多一条
  assert.equal(validateProfilePatch({ dns: { direct: 'wan', proxy: '1.1.1.1', directExtras: [{ server: '119.29.29.29' }], proxyExtras: [{ server: 'wan' }] } }), null)
  assert.equal(validateProfilePatch({ dns: { proxy: 'wan' } }), null)
  assert.match(validateProfilePatch({ dns: { direct: 'wan', directExtras: [{ server: 'wan' }] } }), /repeat/)
  assert.match(validateProfilePatch({ dns: { direct: 'WAN' } }), /dns\.direct/)
  assert.match(validateProfilePatch({ dns: { direct: '' } }), /dns\.direct/)
  assert.match(validateProfilePatch({ dns: { proxy: '' } }), /dns\.proxy/)
  assert.match(validateProfilePatch({ dns: { direct: '   ' } }), /dns\.direct/)
  for (const region of ['cn', 'intl']) assert.equal(validateProfilePatch({ dns: { region } }), null, region)
  assert.match(validateProfilePatch({ dns: { region: 'CN' } }), /dns\.region/)
  assert.match(validateProfilePatch({ dns: { proxy: 1 } }), /dns\.proxy/)
  for (const protocol of ['udp', 'tcp']) {
    assert.equal(validateProfilePatch({ dns: { directProtocol: protocol, proxyProtocol: protocol } }), null, protocol)
  }
  assert.match(validateProfilePatch({ dns: { directProtocol: 'doh' } }), /dns\.directProtocol/)
  assert.match(validateProfilePatch({ dns: { directProtocol: 'tls' } }), /dns\.directProtocol/)
  assert.match(validateProfilePatch({ dns: { proxyProtocol: 'https' } }), /dns\.proxyProtocol/)
  assert.equal(validateProfilePatch({ dns: { directPort: 5353, proxyPort: 1 } }), null)
  assert.match(validateProfilePatch({ dns: { directPort: 0 } }), /dns\.directPort/)
  assert.match(validateProfilePatch({ dns: { proxyPort: '53' } }), /dns\.proxyPort/)
  assert.match(validateProfilePatch({ dns: { proxyPort: 70000 } }), /dns\.proxyPort/)
  assert.match(validateProfilePatch({ dns: { proxyProtocol: '' } }), /dns\.proxyProtocol/)
})

// -------- HTTP 路由集成测试 --------

test('GET /api/openbox/profile 返回默认 profile（地区种子已翻译成站点集）', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await fetch(`${baseUrl}/api/openbox/profile`)
    assert.equal(res.status, 200)
    const body = await res.json()
    // 除了 routing.policies / fallbackDefault,其余和默认档案一致
    const { routing, ...rest } = body.profile
    const { routing: defRouting, ...defRest } = DEFAULT_PROFILE
    assert.deepEqual(rest, defRest)
    assert.deepEqual({ ...routing, policies: undefined, fallbackDefault: undefined },
                     { ...defRouting, policies: undefined, fallbackDefault: undefined })
    // 全新安装的默认:中国站点直连,其余走代理
    assert.deepEqual(routing.policies.map((p) => [p.name, p.default, p.rulesets]),
                     [['中国大陆·直连', 'direct', ['geosite-cn', 'geoip-cn']]])
    assert.equal(routing.fallbackDefault, 'proxy')
  } finally {
    await close()
  }
})

test('PUT /api/openbox/profile 深合并后返回并持久化,未提及字段保留', async () => {
  const { baseUrl, store, close } = await startApp()
  try {
    const res = await putJson(baseUrl, '/api/openbox/profile', { ipv6: false, dns: { mode: 'dnsmasq' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.profile.ipv6, false)
    assert.equal(body.profile.dns.mode, 'dnsmasq')
    assert.equal(body.profile.dns.direct, 'wan') // 未提及字段保留(默认是上游 DNS)

    assert.deepEqual(store.getProfile(), body.profile) // 已落库
  } finally {
    await close()
  }
})

test('PUT 只碰 ipv6 的部分 patch 不因缺 dns 报错,且不影响 dns', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await putJson(baseUrl, '/api/openbox/profile', { ipv6: false })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.profile.ipv6, false)
    assert.equal(body.profile.dns.mode, 'dnsmasq') // 未提及,保留默认
  } finally {
    await close()
  }
})

test('PUT 非法 dns.mode → 400 且不写入', async () => {
  const { baseUrl, store, close } = await startApp()
  try {
    const before = store.getProfile()
    const res = await putJson(baseUrl, '/api/openbox/profile', { dns: { mode: 'bogus' } })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error)
    assert.deepEqual(store.getProfile(), before)
  } finally {
    await close()
  }
})

test('PUT 非法 ipv6 → 400 且不写入', async () => {
  const { baseUrl, store, close } = await startApp()
  try {
    const before = store.getProfile()
    const res = await putJson(baseUrl, '/api/openbox/profile', { ipv6: 'yes' })
    assert.equal(res.status, 400)
    assert.deepEqual(store.getProfile(), before)
  } finally {
    await close()
  }
})

test('GET /defaults?region=CN → 中国大陆那一档', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await fetch(`${baseUrl}/api/openbox/profile/defaults?region=CN`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.defaults.fallbackDefault, 'proxy')
    assert.equal(body.defaults.routing.fallbackDefault, 'proxy')
    // 规则不再写进档案:内置的站点集种子在 store 的 DEFAULT_PROFILE 里
    assert.ok(!('directRulesets' in body.defaults.routing))
    assert.ok(!('fallback' in body.defaults.routing))
  } finally {
    await close()
  }
})

test('GET /defaults?region=HKMO → 香港澳门那一档', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await fetch(`${baseUrl}/api/openbox/profile/defaults?region=HKMO`)
    const body = await res.json()
    assert.equal(body.defaults.fallbackDefault, 'direct')
  } finally {
    await close()
  }
})

test('GET /defaults?region=不认识的 → 回落到中国大陆', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await fetch(`${baseUrl}/api/openbox/profile/defaults?region=US`)
    const body = await res.json()
    assert.equal(body.defaults.fallbackDefault, 'proxy')
  } finally {
    await close()
  }
})

test('GET /defaults 缺 region → 按 CN 兜底', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await fetch(`${baseUrl}/api/openbox/profile/defaults`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.defaults.fallbackDefault, 'proxy')
  } finally {
    await close()
  }
})

test('GET /defaults?region=hkmo → 大小写归一化', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await fetch(`${baseUrl}/api/openbox/profile/defaults?region=hkmo`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.defaults.fallbackDefault, 'direct')
  } finally {
    await close()
  }
})

test('PUT 校验:策略必须有名字', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await putJson(baseUrl, '/api/openbox/profile', { routing: { policies: [{ rulesets: ['geosite-google'] }] } })
    assert.equal(res.status, 400)
  } finally {
    await close()
  }
})

test('PUT 校验:策略的规则集仍然要过路径安全那道正则', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await putJson(baseUrl, '/api/openbox/profile', {
      routing: { policies: [{ name: '坏的', rulesets: ['../../etc/passwd'] }] },
    })
    assert.equal(res.status, 400)
  } finally {
    await close()
  }
})

test('PUT 校验:域名条件不限制字符（带下划线、斜杠的 CIDR 都合法）', async () => {
  const { baseUrl, close } = await startApp()
  try {
    const res = await putJson(baseUrl, '/api/openbox/profile', {
      routing: {
        policies: [{ name: '谷歌', domainSuffix: ['my_host.example.com'], ipCidr: ['8.8.8.8/32'] }],
      },
    })
    assert.equal(res.status, 200)
  } finally {
    await close()
  }
})

test('PUT 校验:兜底只收字符串;「其他」是兜底占着的名字,站点集不能重名', async () => {
  const { baseUrl, close } = await startApp()
  try {
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { routing: { fallbackDefault: 'direct' } })).status, 200)
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { routing: { fallbackDefault: 3 } })).status, 400)
    assert.equal(
      (await putJson(baseUrl, '/api/openbox/profile', {
        routing: { policies: [{ id: 'x', name: '其他', rulesets: ['geosite-cn'] }] },
      })).status,
      400,
    )
  } finally {
    await close()
  }
})

test('带地区数据的老档案写进 store 时翻译成站点集:界面看到的和内核跑的必须是同一份', async () => {
  const store = memStore()
  store.setProfile({
    routing: {
      policies: [{ id: 'g', name: '谷歌', rulesets: ['geosite-google'] }],
      regionId: 'cn',
      regions: [{ id: 'cn', name: '中国大陆', catchAll: 'proxy', rules: [{ type: 'geosite', value: 'cn', action: 'direct' }] }],
    },
  })
  const { baseUrl, close } = await startApp(store)
  try {
    const body = await (await fetch(`${baseUrl}/api/openbox/profile`)).json()
    assert.deepEqual(body.profile.routing.policies.map((p) => p.name), ['谷歌', '中国大陆·直连'])
    assert.equal(body.profile.routing.fallbackDefault, 'proxy')
    // 已经落库,再读一次不会再长出一个
    const again = await (await fetch(`${baseUrl}/api/openbox/profile`)).json()
    assert.deepEqual(again.profile.routing.policies.map((p) => p.name), ['谷歌', '中国大陆·直连'])
  } finally {
    await close()
  }
})

test('PUT 校验:测速地址必须是 http 或 https URL', async () => {
  const { baseUrl, close } = await startApp()
  try {
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { testUrl: 'http://connect.rom.miui.com/generate_204' })).status, 200)
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { directTestUrl: 'https://www.msftconnecttest.com/connecttest.txt' })).status, 200)
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { testUrl: 'gstatic.com' })).status, 400)
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { directTestUrl: 'ftp://x' })).status, 400)
  } finally {
    await close()
  }
})

test('servers 校验:协议/端口/凭据/重复端口/保留端口', async () => {
  const { validateServers } = await import('./profile.mjs')
  const ok = [{ id: 'a', enabled: true, name: 'SS', protocol: 'shadowsocks', port: 8388, method: 'aes-256-gcm', password: 'pw' }]
  assert.equal(validateServers(ok), null)
  assert.match(validateServers([{ ...ok[0], port: 2026 }]), /reserved/)
  assert.match(validateServers([ok[0], { ...ok[0], id: 'b' }]), /duplicated/)
  assert.match(validateServers([{ ...ok[0], protocol: 'vmess' }]), /protocol/)
  assert.match(validateServers([{ ...ok[0], password: '' }]), /password/)
  assert.match(validateServers([{ id: 'v', name: 'V', protocol: 'vless', port: 8443, uuid: 'nope' }]), /uuid/)
  assert.match(validateServers([{ id: 'bad id', name: 'x', protocol: 'vless', port: 8443, uuid: '11111111-1111-4111-8111-111111111111' }]), /id/)
  // mixed:不认证可以,认证要用户名密码成对
  assert.equal(validateServers([{ id: 'm', name: 'M', protocol: 'mixed', port: 7080 }]), null)
  assert.equal(validateServers([{ id: 'm', name: 'M', protocol: 'mixed', port: 7080, username: 'u', password: 'p' }]), null)
  assert.match(validateServers([{ id: 'm', name: 'M', protocol: 'mixed', port: 7080, username: 'u' }]), /set together/)
  assert.match(validateServers([{ id: 'm', name: 'M', protocol: 'mixed', port: 7080, password: 'p' }]), /set together/)
})

test('serverInfo(设置 · 客户端的路由器标识):名称有长度上限,图标是图标代码,地区是两个大写字母或空,别的字段(包括去掉的简短说明)不收', () => {
  assert.equal(validateProfilePatch({ serverInfo: {} }), null)
  assert.equal(validateProfilePatch({ serverInfo: { name: '家里', icon: 'brand:openai', iconSvg: '<svg viewBox="0 0 24 24"/>', region: 'HK' } }), null)
  assert.equal(validateProfilePatch({ serverInfo: { name: '', icon: '', iconSvg: '', region: '' } }), null)
  for (const icon of ['CN', 'globe:asia', 'misc:arrow-right']) assert.equal(validateProfilePatch({ serverInfo: { icon } }), null)
  for (const icon of ['<b>', 'a b', 1, 'x'.repeat(81)]) assert.match(validateProfilePatch({ serverInfo: { icon } }), /icon/)
  for (const iconSvg of ['<script>alert(1)</script>', 1, `<svg>${'x'.repeat(70000)}</svg>`]) assert.match(validateProfilePatch({ serverInfo: { iconSvg } }), /iconSvg/)
  assert.match(validateProfilePatch({ serverInfo: { name: 'x'.repeat(41) } }), /name/)
  assert.match(validateProfilePatch({ serverInfo: { description: '说明' } }), /not allowed/)
  for (const region of ['cn', 'CHN', 'C1', 1]) assert.match(validateProfilePatch({ serverInfo: { region } }), /region/)
  assert.match(validateProfilePatch({ serverInfo: { other: 1 } }), /not allowed/)
  assert.match(validateProfilePatch({ serverInfo: [] }), /object/)
})

test('PUT /profile:路由器标识去掉首尾空白;共享服务器不再带图标(老数据里的丢掉)', async () => {
  const { baseUrl, store, close } = await startApp()
  try {
    const server = { id: 'home', name: 'HOME', protocol: 'shadowsocks', port: 8388, method: 'aes-256-gcm', password: 'pw', icon: 'CN', iconSvg: '<svg/>' }
    const res = await putJson(baseUrl, '/api/openbox/profile', { serverInfo: { name: '  家里 ', region: 'HK' }, servers: [server] })
    assert.equal(res.status, 200)
    const saved = store.getProfile()
    assert.deepEqual(saved.serverInfo, { name: '家里', region: 'HK' })
    assert.equal('icon' in saved.servers[0], false)
    assert.equal('iconSvg' in saved.servers[0], false)
    assert.equal(saved.servers[0].name, 'HOME')
  } finally {
    await close()
  }
})

test('bypassPorts(#183):空串或端口 / 范围写法,别的不收', () => {
  assert.equal(validateProfilePatch({ bypassPorts: '' }), null)
  assert.equal(validateProfilePatch({ bypassPorts: '21114-21119, 2233' }), null)
  assert.match(String(validateProfilePatch({ bypassPorts: '22; flush ruleset' })), /bypassPorts/)
  // 名单怎么用(#198 / #199):只认这两个值 —— 别的值落进档案会被当成黑名单,规则和界面对不上
  assert.equal(validateProfilePatch({ bypassPortsMode: 'blacklist' }), null)
  assert.equal(validateProfilePatch({ bypassPortsMode: 'whitelist' }), null)
  assert.match(String(validateProfilePatch({ bypassPortsMode: 'allow' })), /bypassPortsMode/)
  assert.match(String(validateProfilePatch({ bypassPorts: 2233 })), /bypassPorts/)
  // 白名单那份同一套写法
  assert.equal(validateProfilePatch({ bypassPortsWhitelist: '443, 8000-8100' }), null)
  assert.equal(validateProfilePatch({ bypassPortsWhitelist: '' }), null)
  assert.match(String(validateProfilePatch({ bypassPortsWhitelist: '22; flush ruleset' })), /bypassPortsWhitelist/)
})

test('clientRoutes 校验:来源必须是 IP/网段,出口必填,id 不重复', async () => {
  const { validateClientRoutes } = await import('./profile.mjs')
  const ok = [{ id: 'tv', enabled: true, name: '电视', sources: ['10.0.0.5', '10.0.1.0/24'], outbound: '香港-自动' }]
  assert.equal(validateClientRoutes(ok), null)
  assert.match(validateClientRoutes([{ ...ok[0], sources: ['10.0.0.999'] }]), /invalid IP/)
  assert.match(validateClientRoutes([{ ...ok[0], sources: [] }]), /sources/)
  assert.match(validateClientRoutes([{ ...ok[0], outbound: '' }]), /outbound/)
  assert.match(validateClientRoutes([ok[0], { ...ok[0] }]), /duplicated/)
  // 只让这些进内核(#187):和「不进内核」一样按 MAC,不填出口;两样不能同时开
  const admit = { id: 'pc', name: '电脑', sources: ['10.0.0.20'], admit: true, macs: ['aa:bb:cc:00:00:01'] }
  assert.equal(validateClientRoutes([admit]), null)
  assert.match(validateClientRoutes([{ ...admit, match: 'mac', macs: [] }]), /when matching by MAC/)
  assert.equal(validateClientRoutes([{ ...admit, match: 'ip', macs: [] }]), null, '按 IP 的白名单')
  assert.match(validateClientRoutes([{ ...admit, macs: ['nope'] }]), /invalid MAC/)
  assert.match(validateClientRoutes([{ ...admit, bypass: true }]), /both bypass and admit/)
  assert.match(validateClientRoutes([{ ...admit, admit: 'yes' }]), /admit must be a boolean/)
})

test('站点集不能和节点组 / 内置直连拒绝 / dnsmasq 回送出站同名,也不能彼此重名——都是同一个出站命名空间', () => {
  const reserved = reservedPolicyNames([{ id: 'g1', name: 'Netflix', type: 'static', members: [] }])
  assert.ok(reserved.includes('Netflix'))
  assert.ok(reserved.includes('dnsmasq'))
  assert.ok(reserved.includes('直连') && reserved.includes('拒绝'))
  const bad = validateProfilePatch({ routing: { policies: [{ name: 'Netflix', domainSuffix: ['netflix.com'] }] } }, { reservedNames: reserved })
  assert.match(String(bad), /collides/)
  const dup = validateProfilePatch({ routing: { policies: [{ name: 'A', domainSuffix: ['a.com'] }, { name: 'A', domainSuffix: ['b.com'] }] } })
  assert.match(String(dup), /duplicated/)
  assert.equal(validateProfilePatch({ routing: { policies: [{ name: 'Hulu', domainSuffix: ['hulu.com'] }] } }, { reservedNames: reserved }), null)
})

test('validateProfilePatch routing.displayOrder 必须是字符串数组', () => {
  assert.equal(validateProfilePatch({ routing: { displayOrder: ['Speed', 'AI', '其他'] } }), null)
  assert.ok(validateProfilePatch({ routing: { displayOrder: ['Speed', 1] } }))
  assert.ok(validateProfilePatch({ routing: { displayOrder: 'Speed' } }))
})

test('validateProfilePatch 图标缩放必须是 ±20 以内的整数（站点集与兜底都一样）', () => {
  assert.equal(validateProfilePatch({ routing: { fallbackIconScale: 20, policies: [{ id: 'p', name: 'A', iconScale: -20 }] } }), null)
  assert.ok(validateProfilePatch({ routing: { fallbackIconScale: 1.5 } }))
  assert.ok(validateProfilePatch({ routing: { fallbackIconScale: 21 } }))
  assert.ok(validateProfilePatch({ routing: { policies: [{ id: 'p', name: 'A', iconScale: -21 }] } }))
  assert.ok(validateProfilePatch({ routing: { policies: [{ id: 'p', name: 'A', iconScale: '1' }] } }))
})

test('validateProfilePatch 校验前置自定义分流（一行一条规则、一行一个出口）', () => {
  const ok = { routing: { custom: { rules: [{ type: 'domainSuffix', value: 'a.com', outbound: 'HK' }] } } }
  assert.equal(validateProfilePatch(ok), null)
  assert.equal(validateProfilePatch({ routing: { custom: { enabled: false } } }), null)

  const bad = (custom) => String(validateProfilePatch({ routing: { custom } }))
  assert.match(bad('x'), /routing\.custom must be an object/)
  assert.match(bad({ name: '  ' }), /name must be a non-empty string/)
  assert.match(bad({ rules: 'x' }), /rules must be an array/)
  assert.match(bad({ rules: [{ type: 'nope', value: 'a', outbound: 'HK' }] }), /type must be one of/)
  assert.match(bad({ rules: [{ type: 'domain', value: ' ', outbound: 'HK' }] }), /value is required/)
  assert.match(bad({ rules: [{ type: 'domain', value: 'a.com', outbound: '' }] }), /outbound is required/)
  assert.match(bad({ rules: [{ type: 'ruleUrl', value: 'ftp://x/y', outbound: 'HK' }] }), /must be an http\(s\) URL/)
  // 规则集名会被拼进 .srs 路径,和站点集同一道路径穿越防线
  assert.match(bad({ rules: [{ type: 'geosite', value: '../x', outbound: 'HK' }] }), /ruleset name must match/)
  // 端口:单个 / 范围 / 逗号分隔都行,写错的不收
  assert.equal(validateProfilePatch({ routing: { custom: { rules: [{ type: 'port', value: '51820, 1000-2000', outbound: 'direct' }] } } }), null)
  assert.match(bad({ rules: [{ type: 'port', value: '70000', outbound: 'HK' }] }), /ports like/)
  assert.match(bad({ rules: [{ type: 'port', value: '2000-1000', outbound: 'HK' }] }), /ports like/)
  assert.match(bad({ rules: [{ type: 'port', value: 'abc', outbound: 'HK' }] }), /ports like/)
})

test('validateProfilePatch dns.fakeIpForProxy 必须是布尔', () => {
  assert.equal(validateProfilePatch({ dns: { fakeIpForProxy: true } }), null)
  assert.equal(validateProfilePatch({ dns: { fakeIpForProxy: false } }), null)
  assert.match(validateProfilePatch({ dns: { fakeIpForProxy: 'yes' } }), /fakeIpForProxy/)
})

test('validateProfilePatch ipv6Proxy 只认 node / ipv4', () => {
  assert.equal(validateProfilePatch({ ipv6Proxy: 'node' }), null)
  assert.equal(validateProfilePatch({ ipv6Proxy: 'ipv4' }), null)
  assert.match(validateProfilePatch({ ipv6Proxy: 'off' }), /ipv6Proxy/)
})

test('validateClientRoutes:不进内核（bypass）要至少一个合法 MAC、出站可以不填;普通规则出站必填', async () => {
  const { validateClientRoutes } = await import('./profile.mjs')
  assert.equal(validateClientRoutes([{ id: 'a', name: 'Switch', sources: ['10.0.0.9'], bypass: true, macs: ['AA:BB:CC:DD:EE:FF'] }]), null)
  assert.equal(validateClientRoutes([{ id: 'a', name: 'Switch', sources: ['10.0.0.9'], bypass: true, macs: ['aa-bb-cc-dd-ee-ff'], outbound: '' }]), null)
  // 终端按 IP 或按 MAC 认,二选一:按 IP 的不进内核不用 MAC;按 MAC 的要有 MAC
  assert.equal(validateClientRoutes([{ id: 'a', name: 'Switch', sources: ['10.0.0.9'], bypass: true }]), null)
  assert.equal(validateClientRoutes([{ id: 'a', name: 'Switch', match: 'mac', sources: [], macs: ['aa:bb:cc:dd:ee:ff'], bypass: true }]), null)
  assert.match(validateClientRoutes([{ id: 'a', name: 'Switch', match: 'mac', sources: ['10.0.0.9'], bypass: true }]), /when matching by MAC/)
  assert.match(validateClientRoutes([{ id: 'a', name: 'Switch', match: 'ip', sources: [], bypass: true }]), /sources must be a non-empty/)
  assert.match(validateClientRoutes([{ id: 'a', name: 'Switch', match: 'x', sources: ['10.0.0.9'], bypass: true }]), /match must be ip or mac/)
  assert.equal(validateClientRoutes([{ id: 'a', name: 'TV', match: 'mac', macs: ['aa:bb:cc:dd:ee:ff'], outbound: '香港-自动' }]), null, '按 MAC 指定出站')
  assert.match(validateClientRoutes([{ id: 'a', name: 'Switch', sources: ['10.0.0.9'], bypass: true, macs: ['nope'] }]), /invalid MAC/)
  assert.match(validateClientRoutes([{ id: 'a', name: 'Switch', sources: ['10.0.0.9'], bypass: 'yes', macs: ['aa:bb:cc:dd:ee:ff'] }]), /bypass must be a boolean/)
  assert.match(validateClientRoutes([{ id: 'a', name: 'TV', sources: ['10.0.0.8'] }]), /outbound must be a non-empty string/)
})

test('PUT /profile chainProxies:存库时按节点内容重算摘要;名称撞上订阅节点 → 400;节点内容解析不出 → 400;存空数组即全部删除', async () => {
  const { store, baseUrl, close } = await startApp()
  try {
    store.setNodes([{ tag: 'HK-01', type: 'shadowsocks', server: 'hk.example.com', server_port: 443, fields: {}, source: 'sharelink' }])
    const entry = { id: 'c1', enabled: true, name: '住宅-美国', link: 'socks5://u:p@res.example.net:1080#x', upstream: 'HK-01', node: { type: 'fake', server: 'x', port: 1 } }
    const ok = await putJson(baseUrl, '/api/openbox/profile', { chainProxies: [entry] })
    assert.equal(ok.status, 200)
    const saved = (await ok.json()).profile.chainProxies
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0].node, { type: 'socks', server: 'res.example.net', port: 1080 }, '摘要由服务端按 link 算,不信客户端传来的')
    const clash = await putJson(baseUrl, '/api/openbox/profile', { chainProxies: [{ ...entry, name: 'HK-01', upstream: '所有-自动' }] })
    assert.equal(clash.status, 400)
    assert.match((await clash.json()).error, /已被节点、节点组或站点集占用/)
    const bad = await putJson(baseUrl, '/api/openbox/profile', { chainProxies: [{ ...entry, link: 'garbage' }] })
    assert.equal(bad.status, 400)
    assert.equal(store.getProfile().chainProxies.length, 1, '校验没过的不落库')
    const del = await putJson(baseUrl, '/api/openbox/profile', { chainProxies: [] })
    assert.deepEqual((await del.json()).profile.chainProxies, [])
  } finally {
    await close()
  }
})

// PM 2026-10-04:遇到重名不能保存。站点集和订阅节点同名、只改站点集时和已有链式代理同名(以前这两种存得进去,部署才报重名)
test('PUT /profile:站点集和订阅节点 / 已有链式代理同名 → 400,说清是谁和谁撞了', async () => {
  const { store, baseUrl, close } = await startApp()
  try {
    store.setSubscriptions([{ id: 'sub', name: '机场' }])
    store.setNodes([{ tag: 'HK-01', type: 'shadowsocks', server: 'hk.example.com', server_port: 443, fields: {}, source: 'sharelink', subscriptionId: 'sub' }])
    const policy = (name) => ({ routing: { policies: [{ id: 'p', name, default: 'direct', domainSuffix: ['a.com'] }] } })
    const node = await putJson(baseUrl, '/api/openbox/profile', policy('HK-01'))
    assert.equal(node.status, 400)
    assert.equal((await node.json()).error, '名称「HK-01」重复:订阅「机场」的节点和站点集同名,不能保存。请换一个名字')
    const entry = { id: 'c1', enabled: true, name: '住宅-美国', link: 'socks5://u:p@res.example.net:1080#x', upstream: 'HK-01' }
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { chainProxies: [entry] })).status, 200)
    const chain = await putJson(baseUrl, '/api/openbox/profile', policy('住宅-美国'))
    assert.equal(chain.status, 400)
    assert.match((await chain.json()).error, /^名称「住宅-美国」重复:链式代理和站点集同名/)
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', policy('AI'))).status, 200)
  } finally {
    await close()
  }
})


test('PUT /profile chainProxies:按 id 认出改名,节点组成员 / 故障转移页签 / 站点集默认出口 / 兜底 / 终端分流 / 别的链式代理的上游一并迁移', async () => {
  const { store, baseUrl, close } = await startApp()
  try {
    const link = 'socks5://u:p@res.example.net:1080#x'
    store.setNodes([{ tag: 'HK-01', type: 'ss', server: '1.2.3.4', server_port: 1 }])
    store.setProfile({ chainProxies: [{ id: 'c1', enabled: true, name: '住宅-旧', link, upstream: 'HK-01' }, { id: 'c2', enabled: true, name: '二级', link, upstream: '住宅-旧' }] })
    store.setGroups([
      { id: 'g-a', name: 'A', type: 'selector', mode: 'static', members: ['住宅-旧', 'HK-01'] },
      { id: 'g-f', name: 'F', type: 'failover', lanes: [{ id: 'l1', name: '主用', members: ['住宅-旧'] }, { id: 'l2', name: '备用', members: ['HK-01'] }] },
    ])
    store.setProfile({ routing: { policies: [{ id: 'p1', name: 'Video', default: '住宅-旧', rulesets: ['geosite-netflix'] }], fallbackDefault: '住宅-旧' }, clientRoutes: [{ id: 'r1', name: 'tv', sources: ['192.168.1.10'], outbound: '住宅-旧' }] })
    const res = await putJson(baseUrl, '/api/openbox/profile', { chainProxies: [{ id: 'c1', enabled: true, name: '住宅-新', link, upstream: 'HK-01' }, { id: 'c2', enabled: true, name: '二级', link, upstream: '住宅-旧' }] })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.renamed, [{ from: '住宅-旧', to: '住宅-新' }])
    assert.deepEqual(body.profile.chainProxies.map((e) => [e.name, e.upstream]), [['住宅-新', 'HK-01'], ['二级', '住宅-新']])
    assert.equal(body.profile.routing.policies[0].default, '住宅-新')
    assert.equal(body.profile.routing.fallbackDefault, '住宅-新')
    assert.equal(body.profile.clientRoutes[0].outbound, '住宅-新')
    const groups = store.getGroups()
    assert.deepEqual(groups.find((g) => g.id === 'g-a').members, ['住宅-新', 'HK-01'])
    assert.deepEqual(groups.find((g) => g.id === 'g-f').lanes.map((l) => l.members), [['住宅-新'], ['HK-01']])
  } finally {
    await close()
  }
})

test('tun 参数校验(#236 #239):协议栈三选一,MTU / MSS 是 0 或范围内的整数;规则备注只能是字符串', async () => {
  const { validateProfilePatch } = await import('./profile.mjs')
  assert.equal(validateProfilePatch({ tun: { stack: 'gvisor', mtu: 1500, tcpMss: 1400 } }), null)
  assert.equal(validateProfilePatch({ tun: { stack: 'mixed', mtu: 0, tcpMss: 0 } }), null)
  assert.match(validateProfilePatch({ tun: { stack: 'lwip' } }), /tun\.stack/)
  assert.match(validateProfilePatch({ tun: { mtu: 500 } }), /tun\.mtu/)
  assert.match(validateProfilePatch({ tun: { mtu: 1500.5 } }), /tun\.mtu/)
  assert.match(validateProfilePatch({ tun: { tcpMss: 100 } }), /tun\.tcpMss/)
  assert.match(validateProfilePatch({ tun: 'mixed' }), /tun must be an object/)
  assert.equal(validateProfilePatch({ routing: { policies: [{ name: 'PT', domainSuffix: ['a.com'], notes: { 'domainSuffix:a.com': 'PT 站' } }] } }), null)
  assert.match(validateProfilePatch({ routing: { policies: [{ name: 'PT', domainSuffix: ['a.com'], notes: { 'domainSuffix:a.com': 1 } }] } }), /notes/)
  assert.equal(validateProfilePatch({ routing: { custom: { rules: [{ type: 'domain', value: 'a.com', outbound: 'direct', note: '内网' }] } } }), null)
  assert.match(validateProfilePatch({ routing: { custom: { rules: [{ type: 'domain', value: 'a.com', outbound: 'direct', note: 2 }] } } }), /note/)
})

test('PUT /api/openbox/profile:路由器在中国大陆时代理 DNS 不能用上游 DNS(按合并后的整份判);在中国大陆之外可以;改了地区就不再自动判', async () => {
  const { baseUrl, store, close } = await startApp()
  try {
    store.setRaw('openbox/dns-region-detect', 'pending')
    const bad = await putJson(baseUrl, '/api/openbox/profile', { dns: { proxy: 'wan' } })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /中国/)
    assert.equal(store.getRaw('openbox/dns-region-detect'), 'pending', '被挡住的请求不算用户选了地区')
    const intl = await putJson(baseUrl, '/api/openbox/profile', { dns: { region: 'intl', proxy: 'wan', proxyProtocol: 'udp' } })
    assert.equal(intl.status, 200)
    assert.equal(store.getProfile().dns.proxy, 'wan')
    assert.equal(store.getRaw('openbox/dns-region-detect'), null, '用户自己选了地区,后台自动判就不做了')
    // 只把地区切回中国、代理还是上游 DNS:挡住
    const back = await putJson(baseUrl, '/api/openbox/profile', { dns: { region: 'cn' } })
    assert.equal(back.status, 400)
    const ok = await putJson(baseUrl, '/api/openbox/profile', { dns: { region: 'cn', proxy: '1.1.1.1', proxyProtocol: 'tcp' } })
    assert.equal(ok.status, 200)
  } finally {
    await close()
  }
})

// 地区分流里的规则集链接:存了就在后台编(onShareRegionsSaved,不等它);没碰地区分流的保存不触发
test('PUT /api/openbox/profile:存了地区分流才触发 onShareRegionsSaved', async () => {
  const store = memStore()
  let calls = 0
  const app = express()
  registerProfileRoutes(app, { store, onShareRegionsSaved: () => { calls += 1 } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { ipv6: false })).status, 200)
    assert.equal(calls, 0)
    assert.equal((await putJson(baseUrl, '/api/openbox/profile', { shareRegions: [] })).status, 200)
    assert.equal(calls, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
