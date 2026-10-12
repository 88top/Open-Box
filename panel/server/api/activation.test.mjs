import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import express from 'express'
import { createStore } from '../store/openbox-store.mjs'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { ACTIVATION_KEY, ACTIVATION_TEXT_MAX, checkActivationCode, registerActivationRoutes } from './activation.mjs'

const paths = createPaths('/opt/open-box')

const setup = async ({ meta = { version: 'v0.1.263' }, kernel = 'sing-box version 1.14.1-openbox-tcp11\n' } = {}) => {
  const map = new Map()
  const store = createStore({ get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), del: (k) => map.delete(k) })
  const ctx = createMockContext({
    files: meta ? { [paths.metaPath]: JSON.stringify(meta) } : {},
    execResults: kernel ? { [`${paths.singbox} version`]: { code: 0, stdout: kernel } } : {},
    defaultExec: { code: 1, stdout: '', stderr: '' },
  })
  const app = express()
  app.use(express.json())
  registerActivationRoutes(app, { store, ctx, paths })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/openbox/activation`
  const call = async (method, body) => {
    const res = await fetch(base, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() }
  }
  return { map, ctx, call, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('激活码:内置的那个对,别的都不对;前后空格不算', () => {
  assert.equal(checkActivationCode('123!23Love'), true)
  assert.equal(checkActivationCode(' 123!23Love '), true)
  assert.equal(checkActivationCode('123!23love'), false)
  assert.equal(checkActivationCode(''), false)
  assert.equal(checkActivationCode(undefined), false)
  // 面板代码里只有摘要,翻不出原文
  assert.ok(!fs.readFileSync(new URL('./activation.mjs', import.meta.url), 'utf8').includes('123!23Love'))
})

test('激活 → 改文字 → 反激活;默认值是 Open-Box 版本号和改动过的 sing-box 版本号', async () => {
  const { map, call, close } = await setup()
  try {
    const initial = await call('GET')
    assert.equal(initial.body.activated, false)
    assert.deepEqual(initial.body.defaults, { left: 'Open-Box v0.1.263', right: 'sing-box 1.14.1-openbox-tcp11' })

    const wrong = await call('POST', { code: 'nope', left: 'x' })
    assert.equal(wrong.status, 400)
    assert.equal(map.has(ACTIVATION_KEY), false)
    // 没激活不能改文字
    assert.equal((await call('PUT', { left: 'x' })).status, 400)

    const activated = await call('POST', { code: '123!23Love', left: '  我家路由器  ', right: '' })
    assert.equal(activated.status, 200)
    assert.equal(activated.body.activated, true)
    assert.equal(activated.body.left, '我家路由器')
    assert.equal(activated.body.right, '', '留空:界面显示默认值')

    const edited = await call('PUT', { left: '', right: 'x'.repeat(100) })
    assert.equal(edited.body.left, '')
    assert.equal(edited.body.right.length, ACTIVATION_TEXT_MAX)

    const off = await call('DELETE')
    assert.equal(off.body.activated, false)
    assert.equal(map.has(ACTIVATION_KEY), false)
  } finally {
    await close()
  }
})

test('默认值:版本号没有 v 前缀就补上;读不到内核版本就只写 sing-box', async () => {
  const { call, close } = await setup({ meta: { version: '0.1.263' }, kernel: '' })
  try {
    assert.deepEqual((await call('GET')).body.defaults, { left: 'Open-Box v0.1.263', right: 'sing-box' })
  } finally {
    await close()
  }
})

test('默认值:meta.json 里有内核版本就用它,不起内核进程(每次打开概览都要读)', async () => {
  const { ctx, call, close } = await setup({ meta: { version: 'v0.1.263', singboxVersion: '1.14.1-openbox-tcp11' }, kernel: '' })
  try {
    assert.deepEqual((await call('GET')).body.defaults, { left: 'Open-Box v0.1.263', right: 'sing-box 1.14.1-openbox-tcp11' })
    assert.deepEqual(ctx.calls, [])
  } finally {
    await close()
  }
})
