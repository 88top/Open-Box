import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import express from 'express'
import { registerTimezoneRoutes } from './timezone.mjs'
import { createMockContext } from '../system/context.mjs'

const savedTz = process.env.TZ
after(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

const startApp = async (ctx, platform) => {
  const app = express()
  registerTimezoneRoutes(app, { ctx, platform })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/openbox/system/timezone`
  return { base, close: () => new Promise((resolve) => server.close(resolve)) }
}

// 假的 uci:zonename / timezone 读出来的是最近一次 set 进去的值
const fakeUci = (zonename, posix) => {
  const state = { zonename, posix }
  return createMockContext({
    execResults: {
      'uci -q get system.@system[0].zonename': () => ({ stdout: state.zonename }),
      'uci -q get system.@system[0].timezone': () => ({ stdout: state.posix }),
      'uci set system.@system[0].zonename=Europe/London': () => { state.zonename = 'Europe/London'; return { code: 0 } },
      'uci set system.@system[0].timezone=GMT0BST,M3.5.0/1,M10.5.0': () => { state.posix = 'GMT0BST,M3.5.0/1,M10.5.0'; return { code: 0 } },
    },
  })
}

test('GET:当前时区、偏移、路由器本地时间和可选名单', async () => {
  const app = await startApp(fakeUci('Asia/Shanghai', 'CST-8'), 'openwrt')
  try {
    const body = await (await fetch(app.base)).json()
    assert.equal(body.zone, 'Asia/Shanghai')
    assert.equal(body.offset, '+08:00')
    assert.match(body.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(body.platform, 'openwrt')
    assert.ok(body.zones.includes('Europe/London'))
    assert.equal(body.countries['Europe/London'], 'GB')
  } finally {
    await app.close()
  }
})

test('PUT:不认识的时区回 400、不动系统;认识的改完返回新时区', async () => {
  const ctx = fakeUci('Asia/Shanghai', 'CST-8')
  const app = await startApp(ctx, 'openwrt')
  try {
    const bad = await fetch(app.base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: 'Mars/Olympus' }) })
    assert.equal(bad.status, 400)
    assert.equal(ctx.calls.some((c) => c.args[0] === 'set'), false)
    const ok = await fetch(app.base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: 'Europe/London' }) })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.zone, 'Europe/London')
    assert.ok(ctx.calls.some((c) => c.cmd === '/etc/init.d/system' && c.args[0] === 'reload'))
    assert.equal(process.env.TZ, 'Europe/London')
  } finally {
    await app.close()
  }
})
