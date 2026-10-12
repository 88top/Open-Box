import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { buildMonthView, parseDhcpLeases, registerTrafficRoutes } from './traffic.mjs'
import { createMockContext } from '../system/context.mjs'
import { DatabaseSync } from 'node:sqlite'
import { createTrafficCollector, createTrafficStore } from '../system/traffic-collector.mjs'

test('统计接口读取未落盘增量，反复查询不写盘；flush 后总量、排行、小时与下钻完全一致', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const store = createTrafficStore(db)
  let writes = 0
  const add = store.add
  store.add = (rows) => { writes++; add(rows) }
  const now = () => new Date(2026, 8, 3, 12)
  const collector = createTrafficCollector({ store, now })
  const c = (id, n, host, node = '节点') => ({ id, upload: n, download: n * 10, chains: [node], metadata: { sourceIP: '10.0.0.9', host } })
  collector.applySnapshot({ uploadTotal: 0, downloadTotal: 0, connections: [] })
  collector.applySnapshot({ uploadTotal: 100, downloadTotal: 1000, connections: [c('a', 90, 'a.com'), c('b', 10, 'b.com')] })
  collector.flush()
  collector.applySnapshot({ uploadTotal: 530, downloadTotal: 5300, connections: [c('a', 90, 'a.com'), c('b', 400, 'b.com'), c('new', 40, 'c.com', '直连')] })
  const changes = db.prepare('SELECT total_changes() AS n').get().n
  const app = await startApp(collector, now)
  t.after(app.close)
  const queries = ['traffic/month?month=2026-09', 'traffic/month?month=2026-09&direct=0', 'traffic/day?day=2026-09-03&limit=1', 'traffic/day?day=2026-09-03&hour=12', 'traffic/day?day=2026-09-03&direct=0', 'traffic/drill?day=2026-09-03&kind=client&key=10.0.0.9&by=host&limit=1', 'traffic/drill?day=2026-09-03&kind=host&key=b.com&by=node', 'clients']
  const read = () => Promise.all(queries.map(async (q) => { const r = await fetch(`${app.base}/api/openbox/${q}`); assert.equal(r.status, 200); return r.json() }))
  const before = await read()
  assert.equal(before[0].total.up, 530)
  assert.equal(before[1].total.up, 490)
  assert.equal(before[2].hosts[0].key, 'b.com', '持久化排行之外的旧行，加入增量后应升到第一位')
  assert.equal(before[2].hosts[0].up, 400, '必须合并持久化的 10 和新增的 390')
  assert.equal(before[2].hostsCount, 3)
  assert.equal(before[5].count, 3)
  assert.equal(before[5].rows[0].key, 'b.com')
  assert.deepEqual(await read(), before)
  assert.equal(writes, 1)
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes, 'HTTP 查询不得修改数据库')
  const pending = collector.pendingSize
  store.add = () => { throw new Error('disk full') }
  assert.equal(collector.flush(), 0)
  assert.equal(collector.pendingSize, pending)
  assert.deepEqual(await read(), before, '写失败后内存统计仍可读')
  store.add = add
  collector.flush()
  assert.equal(collector.pendingSize, 0)
  assert.deepEqual(await read(), before, '落盘后不能重复计算或丢失增量')
})

const startApp = async (collector, now, extra = {}) => {
  const app = express()
  registerTrafficRoutes(app, { collector, now, ...extra })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

const fakeCollector = () => {
  const data = {
    '2026-09-03': {
      total: { up: 100, down: 900, conns: 7 },
      node: [{ key: 'A', up: 60, down: 500, conns: 4 }, { key: '直连', up: 10, down: 100, conns: 2 }],
      host: [{ key: 'a.com', up: 70, down: 600, conns: 6 }],
      client: [{ key: '10.0.0.209', up: 60, down: 500, conns: 5 }, { key: '10.0.0.7', up: 10, down: 100, conns: 1 }],
    },
    // 小时明细(day 写成「天@小时」)
    '2026-09-03@13': { total: { up: 7, down: 60, conns: 1 }, node: [{ key: 'A', up: 7, down: 60, conns: 1 }], host: [], client: [] },
  }
  let flushed = 0
  const drills = []
  return {
    flushed: () => flushed,
    flush() { flushed += 1 },
    store: {
      month(month) {
        return Object.entries(data).filter(([d]) => d.startsWith(month)).map(([day, v]) => ({ day, ...v.total }))
      },
      dayTotal(day) { return data[day]?.total || null },
      hours(day) {
        return Array.from({ length: 24 }, (_, hour) => ({ hour, ...(data[`${day}@${String(hour).padStart(2, '0')}`]?.total || { up: 0, down: 0, conns: 0 }) }))
      },
      day(day, kind, limit) { return (data[day]?.[kind] || []).slice(0, limit) },
      daySum(day, kind) {
        const rows = data[day]?.[kind] || []
        return { n: rows.length, up: rows.reduce((s, r) => s + r.up, 0), down: rows.reduce((s, r) => s + r.down, 0) }
      },
      // 「统计直连流量」关掉时用到:直连这一行按天 / 按月 / 按小时
      nodeRow(day, key) { return (data[day]?.node || []).find((r) => r.key === key) || null },
      monthNode(month, key) {
        return Object.entries(data).filter(([d]) => d.startsWith(month) && !d.includes('@')).map(([day, v]) => ({ day, ...(v.node.find((r) => r.key === key) || { up: 0, down: 0, conns: 0 }) }))
      },
      nodeHours(day, key) {
        const m = new Map()
        for (const [d, v] of Object.entries(data)) {
          if (!d.startsWith(`${day}@`)) continue
          const r = (v.node || []).find((x) => x.key === key)
          if (r) m.set(Number(d.slice(11)), r)
        }
        return m
      },
      drill(day, kind, key, by, limit) {
        drills.push({ day, kind, key, by, limit })
        // 直连 × 站点 / 终端 的交叉行:直连那 10/100 全落在 a.com 和 10.0.0.7 上
        if (day === '2026-09-03' && kind === 'node' && key === '直连') {
          const rows = by === 'host' ? [{ key: 'a.com', up: 10, down: 100, conns: 2 }] : by === 'client' ? [{ key: '10.0.0.7', up: 10, down: 100, conns: 1 }] : []
          return { rows: rows.slice(0, limit), count: rows.length, sum: { up: 10, down: 100 } }
        }
        if (day === '2026-09-03' && kind === 'host' && key === 'a.com' && by === 'node') {
          const rows = [{ key: 'A', up: 60, down: 500, conns: 4 }, { key: '直连', up: 10, down: 100, conns: 2 }]
          return { rows: rows.slice(0, limit), count: rows.length, sum: { up: 70, down: 600 } }
        }
        if (day !== '2026-09-03' || kind !== 'host' || key !== 'a.com') return { rows: [], count: 0 }
        const rows = by === 'client'
          ? [{ key: '10.0.0.209', up: 60, down: 500, conns: 5 }, { key: '10.0.0.7', up: 10, down: 100, conns: 1 }]
          : [{ key: 'A', up: 70, down: 600, conns: 6 }]
        return { rows: rows.slice(0, limit), count: rows.length }
      },
    },
    drills,
  }
}

test('buildMonthView:整月补零;日均按已过天数（往月整月、当月到今天、未来 0）', () => {
  const rows = [{ day: '2026-09-03', up: 100, down: 900, conns: 7 }]
  const cur = buildMonthView('2026-09', rows, '2026-09-10')
  assert.equal(cur.days.length, 30)
  assert.deepEqual(cur.days[2], { day: '2026-09-03', up: 100, down: 900, conns: 7 })
  assert.deepEqual(cur.days[0], { day: '2026-09-01', up: 0, down: 0, conns: 0 })
  assert.equal(cur.avgDays, 10)
  assert.deepEqual(cur.avg, { up: 10, down: 90 })
  assert.equal(buildMonthView('2026-08', [], '2026-09-10').avgDays, 31)
  assert.equal(buildMonthView('2026-10', [], '2026-09-10').avgDays, 0)
})

test('GET /traffic/month:缺参数用当月,格式错 400,读取不触发磁盘 flush', async () => {
  const collector = fakeCollector()
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10))
  try {
    const r = await fetch(`${base}/api/openbox/traffic/month`)
    const body = await r.json()
    assert.equal(body.month, '2026-09')
    assert.equal(body.today, '2026-09-03')
    assert.deepEqual(body.total, { up: 100, down: 900, conns: 7 })
    assert.equal(collector.flushed(), 0)
    assert.equal((await fetch(`${base}/api/openbox/traffic/month?month=2026-13`)).status, 400)
    assert.equal((await fetch(`${base}/api/openbox/traffic/month?month=2026/09`)).status, 400)
  } finally {
    await close()
  }
})

test('GET /traffic/day:节点/域名明细 + 未采样差额;非法日期 400', async () => {
  const collector = fakeCollector()
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10))
  try {
    const r = await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03`)
    const body = await r.json()
    assert.equal(typeof body.nowHour, 'number')
    assert.equal(body.nodes.length, 2)
    assert.equal(body.hostsCount, 1)
    assert.deepEqual(body.other, { up: 30, down: 300 })
    const empty = await (await fetch(`${base}/api/openbox/traffic/day?day=2026-09-02`)).json()
    assert.deepEqual(empty.total, { up: 0, down: 0, conns: 0 })
    assert.deepEqual(empty.nodes, [])
    assert.equal((await fetch(`${base}/api/openbox/traffic/day?day=2026-09-32`)).status, 400)
    assert.equal((await fetch(`${base}/api/openbox/traffic/day`)).status, 400)
  } finally {
    await close()
  }
})

test('GET /traffic/day:访问终端按来源 IP,能从 DHCP 租约翻出主机名', async () => {
  const collector = fakeCollector()
  const ctx = createMockContext({ files: { '/tmp/dhcp.leases': '1757000000 00:15:5d:03:0a:28 10.0.0.209 WIN11-VM 01:00:15:5d:03:0a:28\n1757000000 aa:bb:cc:dd:ee:ff 10.0.0.7 * *\n' } })
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10), { ctx, paths: { dhcpLeases: '/tmp/dhcp.leases' } })
  try {
    const body = await (await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03`)).json()
    assert.equal(body.clientsCount, 2)
    assert.deepEqual(body.clients[0], { key: '10.0.0.209', up: 60, down: 500, conns: 5, name: 'WIN11-VM' })
    assert.equal(body.clients[1].name, '')
  } finally {
    await close()
  }
})

test('GET /traffic/drill:一条记录按另一维拆;按终端拆时带主机名;参数校验 400', async () => {
  const collector = fakeCollector()
  const ctx = createMockContext({ files: { '/tmp/dhcp.leases': '1757000000 00:15:5d:03:0a:28 10.0.0.209 WIN11-VM 01:00:15:5d:03:0a:28\n' } })
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10), { ctx, paths: { dhcpLeases: '/tmp/dhcp.leases' } })
  try {
    const q = (s) => fetch(`${base}/api/openbox/traffic/drill?${s}`)
    const byClient = await (await q('day=2026-09-03&kind=host&key=a.com&by=client')).json()
    assert.equal(byClient.count, 2)
    assert.deepEqual(byClient.rows[0], { key: '10.0.0.209', up: 60, down: 500, conns: 5, name: 'WIN11-VM' })
    assert.equal(byClient.rows[1].name, '')
    assert.equal(collector.flushed(), 0)
    const byNode = await (await q('day=2026-09-03&kind=host&key=a.com&by=node&limit=1')).json()
    assert.deepEqual(byNode.rows, [{ key: 'A', up: 60, down: 500, conns: 4 }])
    assert.deepEqual(collector.drills.at(-1), { day: '2026-09-03', kind: 'host', key: 'a.com', by: 'node', limit: 1 })
    // 空 key(来源不明的终端)也能查
    assert.equal((await q('day=2026-09-03&kind=client&key=&by=host')).status, 200)
    assert.equal((await q('day=2026-09-32&kind=host&key=a.com&by=client')).status, 400)
    assert.equal((await q('day=2026-09-03&kind=host&key=a.com&by=host')).status, 400)
    assert.equal((await q('day=2026-09-03&kind=total&key=&by=host')).status, 400)
    assert.equal((await q('day=2026-09-03&kind=host&key=a.com')).status, 400)
  } finally {
    await close()
  }
})

test('parseDhcpLeases:主机名为 * 的不算', () => {
  const m = parseDhcpLeases('1 m1 10.0.0.2 pc 01\n1 m2 10.0.0.3 * *\nbad line\n')
  assert.deepEqual([...m.entries()], [['10.0.0.2', 'pc']])
})

test('GET /clients:租约里的设备 + 今天流量里的来源 IP', async () => {
  const collector = fakeCollector()
  // 第三行是 dnsmasq 的 DHCPv6 租约(Debian / Ubuntu):第二列是 IAID,不能当 MAC 给终端分流挑
  const leases = '1 AA:BB:CC:DD:EE:01 10.0.0.209 WIN11 01\nduid 00:01:00:01:2c:5f:aa:bb\n1 1234567 fd00::209 WIN11 00:01:00:01\n'
  const ctx = createMockContext({ files: { '/tmp/dhcp.leases': leases } })
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10), { ctx, paths: { dhcpLeases: '/tmp/dhcp.leases' } })
  try {
    const body = await (await fetch(`${base}/api/openbox/clients`)).json()
    // 租约里的设备带 MAC(终端分流「不进内核」按它放行),只在流量里见过的没有
    assert.deepEqual(body.clients, [
      { ip: '10.0.0.209', name: 'WIN11', mac: 'aa:bb:cc:dd:ee:01' },
      { ip: 'fd00::209', name: 'WIN11', mac: '' },
      { ip: '10.0.0.7', name: '', mac: '' },
    ])
  } finally {
    await close()
  }
})

test('GET /traffic/day:Debian / Ubuntu 上路由器自己的地址按平台认(不问 ubus、按地址猜局域网口)', async () => {
  const collector = fakeCollector()
  const ctx = createMockContext({ execResults: { 'ip -4 -o addr': { code: 0, stdout: '2: enp1s0    inet 10.0.0.7/24 brd 10.0.0.255 scope global enp1s0\n' } } })
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10), { ctx, paths: { platform: 'systemd' } })
  try {
    const body = await (await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03`)).json()
    assert.deepEqual(body.clients.find((r) => r.key === '10.0.0.7').self, { iface: 'enp1s0', kind: 'lan' })
    assert.equal(body.clients.find((r) => r.key === '10.0.0.209').self, undefined)
  } finally {
    await close()
  }
})

test('readLocalAddresses:问 netifd 哪个逻辑接口占着这个设备,eth0 是 wan 就标 wan;问不到按设备名猜', async () => {
  const { readLocalAddresses } = await import('../system/local-subnets.mjs')
  const ctx = createMockContext({ execResults: {
    'ip -4 -o addr': { code: 0, stdout: '2: eth0    inet 192.168.3.35/24 brd 192.168.3.255 scope global eth0\n3: br-lan    inet 10.0.0.1/24 brd 10.0.0.255 scope global br-lan\n' },
    // wan6 和 wan 共用 eth0(顺序故意把 wan6 放前面):要留 wan
    'ubus call network.interface dump': { code: 0, stdout: JSON.stringify({ interface: [{ interface: 'wan6', l3_device: 'eth0', device: 'eth0' }, { interface: 'wan', l3_device: 'eth0', device: 'eth0' }, { interface: 'lan', l3_device: 'br-lan', device: 'br-lan' }] }) },
  } })
  const out = await readLocalAddresses(ctx)
  assert.deepEqual(out, [
    { iface: 'eth0', address: '192.168.3.35', prefix: 24, kind: 'wan', logical: 'wan' },
    { iface: 'br-lan', address: '10.0.0.1', prefix: 24, kind: 'lan', logical: 'lan' },
  ])
  const noUbus = createMockContext({ execResults: { 'ip -4 -o addr': { code: 0, stdout: '5: pppoe-wan0    inet 10.65.3.225 peer 10.65.0.1/32 scope global pppoe-wan0\n' } } })
  assert.deepEqual(await readLocalAddresses(noUbus), [{ iface: 'pppoe-wan0', address: '10.65.3.225', kind: 'wan' }])
})

test('GET /traffic/day?hour=13:明细换成那个小时的,总量取小时桶;drill 也按小时;hour 非法 400', async () => {
  const collector = fakeCollector()
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10))
  try {
    const body = await (await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03&hour=13`)).json()
    assert.equal(body.hour, 13)
    assert.deepEqual(body.total, { up: 7, down: 60, conns: 1 })
    assert.deepEqual(body.nodes, [{ key: 'A', up: 7, down: 60, conns: 1 }])
    assert.equal(body.hostsCount, 0)
    assert.equal(body.hours.length, 24)
    assert.equal(body.hourDetailKeepDays, 7)
    const whole = await (await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03`)).json()
    assert.equal(whole.hour, null)
    assert.equal(whole.nodes.length, 2)
    assert.equal((await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03&hour=24`)).status, 400)
    await fetch(`${base}/api/openbox/traffic/drill?day=2026-09-03&kind=host&key=a.com&by=client&hour=13`)
    assert.equal(collector.drills.at(-1).day, '2026-09-03@13')
  } finally {
    await close()
  }
})

test('direct=0:「统计直连流量」关掉——月 / 日总量、小时桶、节点 / 站点 / 终端列表都扣掉直连那份,drill 按出站拆时去掉直连行', async () => {
  const collector = fakeCollector()
  const { base, close } = await startApp(collector, () => new Date(2026, 8, 3, 10))
  try {
    const month = await (await fetch(`${base}/api/openbox/traffic/month?month=2026-09&direct=0`)).json()
    assert.deepEqual(month.direct, { excluded: true, tag: '直连' })
    const d3 = month.days.find((d) => d.day === '2026-09-03')
    assert.deepEqual(d3, { day: '2026-09-03', up: 90, down: 800, conns: 5 })
    assert.equal(month.total.up, 90)
    const on = await (await fetch(`${base}/api/openbox/traffic/month?month=2026-09`)).json()
    assert.equal(on.direct.excluded, false)
    assert.equal(on.days.find((d) => d.day === '2026-09-03').up, 100)

    const day = await (await fetch(`${base}/api/openbox/traffic/day?day=2026-09-03&direct=0`)).json()
    assert.deepEqual(day.total, { up: 90, down: 800, conns: 5 })
    assert.deepEqual(day.nodes.map((r) => r.key), ['A'])
    assert.deepEqual(day.hosts, [{ key: 'a.com', up: 60, down: 500, conns: 4 }])
    assert.equal(day.hostsCount, 1)
    // 10.0.0.7 的量全是直连,扣完为 0 就不列了
    assert.deepEqual(day.clients.map((r) => r.key), ['10.0.0.209'])
    assert.equal(day.clientsCount, 1)
    // 未采样差额不变:总量和节点之和同时扣掉了直连
    assert.deepEqual(day.other, { up: 30, down: 300 })
    assert.equal(day.direct.excluded, true)
    // 小时桶:13 点那格没有直连行,原样
    assert.deepEqual(day.hours[13], { hour: 13, up: 7, down: 60, conns: 1 })

    const drill = await (await fetch(`${base}/api/openbox/traffic/drill?day=2026-09-03&kind=host&key=a.com&by=node&direct=0`)).json()
    assert.deepEqual(drill.rows.map((r) => r.key), ['A'])
    assert.equal(drill.count, 1)
    assert.deepEqual(drill.sum, { up: 60, down: 500 })
    const directDrill = await (await fetch(`${base}/api/openbox/traffic/drill?day=2026-09-03&kind=node&key=%E7%9B%B4%E8%BF%9E&by=host&direct=0`)).json()
    assert.deepEqual(directDrill.rows, [])
    assert.equal(directDrill.count, 0)
  } finally {
    await close()
  }
})

test('用量接口:近 30 天和更早(合并过长尾)的日子分开给日增量;还没有老数据时 oldPerDay 按比例估', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const store = createTrafficStore(db)
  const now = () => new Date(2026, 8, 20, 12)
  const collector = createTrafficCollector({ store, now })
  const rows = (day, n) => Array.from({ length: n }, (_, i) => ({ day, kind: 'host', key: `h${String(i).padStart(4, '0')}.com`, up: 1, down: 1, conns: 1 }))
  // 近期两天各 100 行;老的一天(8 月 1 日,早于 8 月 21 日这条线)只有 10 行
  store.add([...rows('2026-09-19', 100), ...rows('2026-09-18', 100)])
  const app = await startApp(collector, now)
  t.after(app.close)
  const get = async () => (await fetch(`${app.base}/api/openbox/traffic/usage`)).json()
  const fresh = await get()
  assert.equal(fresh.days, 2)
  assert.equal(fresh.oldDays, 0)
  assert.equal(fresh.collapseAfterDays, 30)
  assert.equal(fresh.collapseKeepHosts, 300)
  assert.equal(fresh.perDay, Math.round(fresh.dayBytes / 2))
  assert.equal(fresh.oldPerDay, Math.round(fresh.perDay * 0.12), '没有合并过的日子时按实测比例估')
  store.add(rows('2026-08-01', 10))
  const mixed = await get()
  assert.equal(mixed.days, 3)
  assert.equal(mixed.oldDays, 1)
  assert.equal(mixed.perDay, fresh.perDay, '近期的日增量不被老日子摊薄')
  assert.equal(mixed.oldPerDay, mixed.oldBytes)
  assert.ok(mixed.oldPerDay < mixed.perDay / 5)
})
