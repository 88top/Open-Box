import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { buildDiagnostics, KERNEL_PROCESS_SCRIPT, redact, registerDiagnosticsRoutes, scrubHosts } from './diagnostics.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { configMetaPath } from '../system/deploy.mjs'

const paths = createPaths('/opt/open-box')

// 一份带各种秘密的内核配置:密码、UUID、密钥、clash 密钥、节点主机名(还会出现在直连规则里)
const config = {
  outbounds: [
    { type: 'shadowsocks', tag: 'HK', server: 'hk.example.com', server_port: 8388, method: 'aes-256-gcm', password: 'pw-secret' },
    { type: 'vless', tag: 'US', server: '203.0.113.9', server_port: 443, uuid: '11111111-2222-3333-4444-555555555555', tls: { enabled: true, server_name: 'sni.example.com', reality: { public_key: 'PUBKEY', short_id: 'abcd' } } },
    { type: 'direct', tag: '直连' },
  ],
  route: { rules: [{ domain: ['hk.example.com', '203.0.113.9'], outbound: '直连' }, { domain_suffix: ['openai.com'], outbound: 'HK' }] },
  dns: { servers: [{ tag: 'dns-direct', type: 'udp', server: '223.5.5.5' }, { tag: 'dns-proxy', type: 'https', server: 'dns.google', detour: 'HK' }], rules: [{ domain_suffix: ['openai.com'], server: 'dns-proxy' }] },
  experimental: { clash_api: { secret: 'clash-secret' } },
}
const profile = {
  dns: { mode: 'dnsmasq' }, ipv6: true,
  routing: { policies: [{ name: 'AI', ruleUrls: ['https://lists.example.com/ai.txt?token=abc'] }], custom: { rules: [] } },
  subscriptions: [{ url: 'https://airport.example.com/sub?token=xyz' }],
  clientRoutes: [{ name: '直连终端', sources: ['192.168.3.35/32'], outbound: '直连' }],
}
const mkCtx = () => createMockContext({
  files: {
    [paths.configPath]: JSON.stringify(config),
    [paths.metaPath]: JSON.stringify({ version: 'v0.1.135', singboxVersion: '1.13.14', nodeVersion: '24.18.0', builtAt: '2026-09-08T00:00:00Z' }),
    [configMetaPath(paths)]: JSON.stringify({ dnsMode: 'dnsmasq', routingHash: 'abc' }),
    '/dev/net/tun': '',
    '/etc/init.d/passwall': '#!',
  },
  execResults: {
    'ubus call system board': { code: 0, stdout: '{"model":"R68S","board_name":"x","kernel":"6.6.144","release":{"distribution":"iStoreOS","version":"24.10.8"}}' },
    'uname -m': { code: 0, stdout: 'aarch64\n' },
    'cat /proc/meminfo': { code: 0, stdout: 'MemTotal:        997888 kB\nMemFree:         100000 kB\nMemAvailable:    436700 kB\n' },
    'cat /proc/uptime': { code: 0, stdout: '12345.67 40000\n' },
    'nft list tables': { code: 0, stdout: 'table inet fw4\ntable inet sing-box\n' },
    '/etc/init.d/openbox status': { code: 0, stdout: 'running\n' },
    [`sh -c ${KERNEL_PROCESS_SCRIPT}`]: { code: 0, stdout: '20644 98304 kB /tmp/etc/passwall/bin/sing-box run -c /tmp/etc/passwall/haproxy_2001.json\n30162 103232 kB /opt/open-box/bin/sing-box run -c /opt/open-box/etc/config.json -D /opt/open-box/data\n' },
    'logread -e sing-box': { code: 0, stdout: Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\nERROR[1] \x1b[31mlookup hk.example.com: timeout\x1b[0m password=pw-secret\n' },
  },
})
const store = {
  getProfile: () => profile,
  getDeployState: () => ({ ok: false, stage: 'start', message: 'FATAL open /dev/net/tun' }),
}

test('redact:按字段名抹掉秘密、主机名换占位、URL 只留主机占位和路径提示', () => {
  const r = redact({
    password: 'p', uuid: 'u', private_key: 'k', secret: 's', short_id: 'x',
    server: 'a.example.com', server_name: 'sni.example.com',
    url: 'https://airport.example.com/sub?token=xyz', ruleUrls: ['https://l.example.com/a.txt'],
    keep: 'plain', port: 443, nested: [{ password: 'p2', ok: 1 }],
  })
  assert.deepEqual(r, {
    password: '***', uuid: '***', private_key: '***', secret: '***', short_id: '***',
    server: '<host>', server_name: '<host>',
    url: 'https://<host>/…', ruleUrls: ['https://<host>/…'],
    keep: 'plain', port: 443, nested: [{ password: '***', ok: 1 }],
  })
})

test('scrubHosts:把主机名逐个替换,正则元字符也当普通字符', () => {
  assert.equal(scrubHosts('lookup a.b.com failed; 203.0.113.9:443', ['a.b.com', '203.0.113.9']), 'lookup <node-host> failed; <node-host>:443')
})

test('诊断包:秘密和节点地址一个都不能剩,该有的信息都在', async () => {
  const bundle = await buildDiagnostics({ store, ctx: mkCtx(), paths, now: () => new Date('2026-09-08T10:00:00Z') })
  const text = JSON.stringify(bundle)
  // 秘密
  for (const leak of ['pw-secret', '11111111-2222', 'PUBKEY', 'clash-secret', 'token=abc', 'token=xyz', 'abcd']) {
    assert.ok(!text.includes(leak), `泄露了 ${leak}`)
  }
  // 节点主机名:出站里、直连规则的域名表里、日志里都不能剩
  assert.ok(!text.includes('hk.example.com') && !text.includes('203.0.113.9') && !text.includes('sni.example.com'), text)
  assert.deepEqual(bundle.kernel.config.route.rules[0].domain, ['<node-host>', '<node-host>'])
  assert.match(bundle.logs.kernel, /lookup <node-host>: timeout/)
  // DNS 段的 server 是解析器地址 / DNS 服务器 tag,排 DNS 问题要看,不脱敏
  assert.deepEqual(bundle.kernel.config.dns.servers.map((s) => s.server), ['223.5.5.5', 'dns.google'])
  assert.equal(bundle.kernel.config.dns.rules[0].server, 'dns-proxy')
  // 出站的 server / SNI 照样是占位
  assert.equal(bundle.kernel.config.outbounds[0].server, '<host>')
  assert.equal(bundle.kernel.config.outbounds[1].tls.server_name, '<host>')
  // 订阅整个不出现(只有分流设置)
  assert.equal(bundle.settings.subscriptions, undefined)
  // 该有的信息
  assert.equal(bundle.format, 'open-box-diagnostics')
  assert.equal(bundle.versions.openBox, 'v0.1.135')
  assert.equal(bundle.versions.singBox, '1.13.14')
  assert.equal(bundle.system.arch, 'aarch64')
  assert.equal(bundle.system.board.model, 'R68S')
  assert.equal(bundle.system.memTotal, '975 MB')
  assert.equal(bundle.system.tunDevice, true)
  assert.deepEqual(bundle.system.conflictingPlugins, ['passwall'])
  // 面板带没带 madvise 兼容库(GitHub #290 #293)跟着面板进程自己的环境走
  assert.equal(bundle.system.nodePreload, process.env.LD_PRELOAD || null)
  assert.match(bundle.kernel.nftTables, /table inet sing-box/)
  // 进程表(#426 靠它看出 PassWall 的 sing-box 也在跑)
  assert.match(bundle.kernel.processes, /^20644 98304 kB \/tmp\/etc\/passwall\/bin\/sing-box run/m)
  assert.match(bundle.kernel.processes, /^30162 103232 kB \/opt\/open-box\/bin\/sing-box run/m)
  assert.equal(bundle.kernel.configMeta.routingHash, 'abc')
  assert.equal(bundle.settings.ipv6, true)
  assert.equal(bundle.lastDeploy.stage, 'start')
  // 日志只留最后 200 行,且终端色码已去掉
  assert.equal(bundle.logs.kernel.split('\n').length, 200)
  assert.ok(!bundle.logs.kernel.includes('\x1b['))
  assert.ok(!bundle.logs.kernel.includes('line 0\n'))
})

test('诊断包 · 节点专用解析器(#136):机场 DoH 的主机名和私有路径在配置和日志里都抹掉,别的 DNS 照旧', async () => {
  const withDoh = {
    ...config,
    dns: { ...config.dns, servers: [...config.dns.servers,
      { type: 'https', tag: 'dns-sub-abc', server: 'dns.airport-private.net', server_port: 2096, path: '/p/SeCrEtPaTh', domain_resolver: 'dns-sub-abc-bootstrap' },
      { type: 'udp', tag: 'dns-sub-abc-bootstrap', server: '223.5.5.5' }] },
  }
  const ctx = createMockContext({
    files: { [paths.configPath]: JSON.stringify(withDoh), [paths.metaPath]: '{}' },
    execResults: { 'logread -e sing-box': { code: 0, stdout: 'ERROR dns: Post "https://dns.airport-private.net:2096/p/SeCrEtPaTh": i/o timeout\n' } },
  })
  const bundle = await buildDiagnostics({ store, ctx, paths })
  const text = JSON.stringify(bundle)
  assert.ok(!text.includes('airport-private') && !text.includes('SeCrEtPaTh'), text)
  const doh = bundle.kernel.config.dns.servers.find((s) => s.tag === 'dns-sub-abc')
  assert.equal(doh.server, '<host>')
  assert.equal(doh.path, '***')
  assert.equal(doh.server_port, 2096)
  assert.equal(bundle.kernel.config.dns.servers.find((s) => s.tag === 'dns-sub-abc-bootstrap').server, '223.5.5.5')
  assert.equal(bundle.kernel.config.dns.servers.find((s) => s.tag === 'dns-proxy').server, 'dns.google')
})

test('GET /api/openbox/diagnostics 返回诊断包;读不到配置 / 命令失败也不炸', async () => {
  const app = express()
  registerDiagnosticsRoutes(app, { store, ctx: mkCtx(), paths })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/openbox/diagnostics`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).format, 'open-box-diagnostics')
  } finally {
    await new Promise((r) => server.close(r))
  }
  // 什么都没有的机器:配置、meta 都读不到,命令全失败,也得给出一个包
  const bare = await buildDiagnostics({ store: {}, ctx: createMockContext({ defaultExec: { code: 127, stdout: '', stderr: 'not found' } }), paths })
  assert.equal(bare.kernel.config, null)
  assert.equal(bare.versions.openBox, null)
  assert.equal(bare.system.tunDevice, false)
  assert.deepEqual(bare.system.conflictingPlugins, [])
})

test('诊断包 · 热切换:带上新开关的设置;开关文件和元数据逐个对账,对不上的点名;不是热切换结构时这一段是 null', async () => {
  const { flipDiagnostics, flipFlagPath, flipBypassPath } = await import('../system/flip-files.mjs')
  const { createMockContext } = await import('../system/context.mjs')
  const { createPaths } = await import('../system/paths.mjs')
  const p = createPaths('/opt/open-box')
  const meta = { flip: { mode: 'hot', bypassMode: 'dynamic', flippedAt: '2026-09-19T01:00:00.000Z', names: { 国内: 'obflip-aaa', Google: 'obflip-bbb', 其他: 'obflip-fallback' }, flags: { 'obflip-aaa': false, 'obflip-bbb': true, 'obflip-fallback': false }, bypass: { 'geoip-cn': true } } }
  const c = createMockContext({ files: {
    [flipFlagPath(p, 'obflip-aaa')]: '{"version":3,"rules":[{"domain":["obflip-off.invalid"]}]}',
    // 元数据说 ON,文件却是 OFF:翻面写到一半出过错的样子
    [flipFlagPath(p, 'obflip-bbb')]: '{"version":3,"rules":[{"domain":["obflip-off.invalid"]}]}',
    [flipBypassPath(p, 'geoip-cn')]: 'SRS',
  } })
  const d = await flipDiagnostics(c, p, meta)
  assert.equal(d.mode, 'hot')
  assert.deepEqual(d.flags.map((f) => [f.policy, f.meta, f.file]), [['国内', 'off', 'off'], ['Google', 'on', 'off'], ['其他', 'off', 'missing']])
  assert.deepEqual(d.mismatched, ['Google', '其他'])
  assert.deepEqual(d.bypass, [{ set: 'geoip-cn', meta: 'full', fileExists: true }])
  assert.equal(await flipDiagnostics(c, p, { dnsMode: 'hijack' }), null)
  assert.equal(await flipDiagnostics(c, p, null), null)
})
