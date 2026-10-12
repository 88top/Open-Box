import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { createMockContext } from '../system/context.mjs'
import { createPaths } from '../system/paths.mjs'
import { mergeTutorialVideos, parseChannelVideos, registerTutorialVideoRoutes, TUTORIAL_REFRESH_MIN_MS } from './tutorial-videos.mjs'

// 频道视频页的样子:新版 lockupViewModel 和老版 videoRenderer 都可能出现,新的在前
const page = (videos) => {
  const items = videos.map((v) =>
    v.old
      ? { richItemRenderer: { content: { videoRenderer: { videoId: v.id, title: { runs: [{ text: v.title }] } } } } }
      : { richItemRenderer: { content: { lockupViewModel: { contentId: v.id, metadata: { lockupMetadataViewModel: { title: { content: v.title } } } } } } },
  )
  const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: items } } } }] } } }
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script><script>var other = {};</script></html>`
}

const startApp = async ({ ctx, fetchByRoute, now }) => {
  const app = express()
  const paths = createPaths('/opt/open-box')
  registerTutorialVideoRoutes(app, { ctx, paths, store: {}, now, fetcher: { fetchByRoute } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { baseUrl, paths, close: () => new Promise((r) => server.close(r)) }
}

test('parseChannelVideos:新老两种写法都认,按页面顺序(新的在前),id 不对的丢掉;认不出页面回 null', () => {
  const html = page([
    { id: 'AAAAAAAAAA1', title: 'Open-Box 新视频' },
    { id: 'BBBBBBBBBB2', title: '别的视频', old: true },
    { id: 'bad', title: 'Open-Box 坏 id' },
  ])
  assert.deepEqual(parseChannelVideos(html), [
    { id: 'AAAAAAAAAA1', title: 'Open-Box 新视频' },
    { id: 'BBBBBBBBBB2', title: '别的视频' },
  ])
  assert.equal(parseChannelVideos('<html>同意页</html>'), null)
})

test('mergeTutorialVideos:标题带 Open-Box / openbox(大小写不管)的按发布先后接在后面;掉出页面的老条目留着;改名不再带的拿掉', () => {
  const known = [
    { id: 'OLDOLDOLD01', title: 'Open-Box 第一期' },
    { id: 'RENAMED0002', title: 'Open-Box 第二期' },
    { id: 'KEEPTITLE03', title: 'Open-Box 第三期' },
  ]
  const fresh = [
    { id: 'NEWNEWNEW05', title: 'OPENBOX 客户端来了' },
    { id: 'OTHERVID004', title: '小米 18 Fold 体验' },
    { id: 'KEEPTITLE03', title: 'Open-box 第三期(改了标题)' },
    { id: 'RENAMED0002', title: '软路由合集' },
  ]
  assert.deepEqual(mergeTutorialVideos(known, fresh), [
    { id: 'OLDOLDOLD01', title: 'Open-Box 第一期' },
    { id: 'KEEPTITLE03', title: 'Open-box 第三期(改了标题)' },
    { id: 'NEWNEWNEW05', title: 'OPENBOX 客户端来了' },
  ])
})

test('GET 没存过时回随包的那几个;POST refresh 查到就并进去、存盘;查不到回原来的 + error;一分钟内重复点不再去查', async () => {
  const ctx = createMockContext()
  let t = 1_000_000
  let calls = 0
  let reply = { ok: true, body: page([{ id: 'NEWNEWNEW05', title: 'openbox 新教程' }, { id: 'A1yFmwQLES4', title: 'Windows/macOS 来了,Open-Box 客户端' }]) }
  const { baseUrl, paths, close } = await startApp({ ctx, now: () => t, fetchByRoute: async () => { calls++; return reply } })
  try {
    const first = await (await fetch(`${baseUrl}/api/openbox/tutorial-videos`)).json()
    assert.equal(first.updatedAt, 0)
    assert.ok(first.videos.length >= 5)
    assert.equal(first.videos[0].id, 'G_7AmjfSRQ8')

    const refreshed = await (await fetch(`${baseUrl}/api/openbox/tutorial-videos/refresh`, { method: 'POST' })).json()
    assert.equal(refreshed.updatedAt, t)
    assert.equal(refreshed.videos.at(-1).id, 'NEWNEWNEW05')
    assert.equal(refreshed.videos.filter((v) => v.id === 'A1yFmwQLES4').length, 1)
    assert.ok(JSON.parse(ctx.files[`${paths.dataDir}/tutorial-videos.json`]).videos.some((v) => v.id === 'NEWNEWNEW05'))

    // 一分钟内再点:不去查
    await fetch(`${baseUrl}/api/openbox/tutorial-videos/refresh`, { method: 'POST' })
    assert.equal(calls, 1)

    // 过了一分钟、这次没连上:列表不变,带 error
    t += TUTORIAL_REFRESH_MIN_MS + 1
    reply = { ok: false, error: 'timeout' }
    const failed = await (await fetch(`${baseUrl}/api/openbox/tutorial-videos/refresh`, { method: 'POST' })).json()
    assert.match(failed.error, /timeout/)
    assert.equal(failed.videos.at(-1).id, 'NEWNEWNEW05')
  } finally {
    await close()
  }
})
