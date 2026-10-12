// 后端设置「使用教程」弹窗的视频列表(用户 2026-10-12「改为动态的,检测我的 YouTube 频道,标题包含 Open-Box(大小写都不管)
// 就列出来」「或者 openbox 都可以」):
//   GET  /api/openbox/tutorial-videos           已知的列表(老的在前),马上回;updatedAt 是上次查频道成功的时间
//   POST /api/openbox/tutorial-videos/refresh   现在去查一次频道,回更新后的列表(查不到就回原来的 + error)
// 取「安格视界」频道的视频页(按目标分流判线路,和节点信息同一套取法,api/route-fetch.mjs),从页面里的 ytInitialData 认出
// 视频 id 和标题。YouTube 的 RSS 到 2026-10 已经全 404;频道页一次只列最新 30 个,所以查到的累积存在 data/tutorial-videos.json:
// 掉出前 30 的老视频照样留着;页面上出现的以页面为准(改了名跟着改、标题不再带 Open-Box 的拿掉)。没存过就从随包的那几个开始
// (defaults/tutorial-videos.json)
import express from 'express'
import fs from 'node:fs'
import { createRouteFetcher } from './route-fetch.mjs'

export const CHANNEL_VIDEOS_URL = 'https://www.youtube.com/@Ange-Digital-Life/videos'
export const TUTORIAL_TITLE_RE = /open-?box/i
// 弹窗打开时,上次查过超过这么久就再查一次(面板那边判);手动连点也至少隔这么久才真去查
export const TUTORIAL_STALE_MS = 6 * 60 * 60 * 1000
export const TUTORIAL_REFRESH_MIN_MS = 60 * 1000
// 频道页 1.3 MB 左右(大半是脚本),取的时候放宽输出上限和时限
const PAGE_MAX_BUFFER = 8 * 1024 * 1024
const PAGE_TIMEOUT_MS = 30000

const SEED_FILE = new URL('../defaults/tutorial-videos.json', import.meta.url)
const SEED = Object.freeze(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).videos)
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

// 频道视频页里的视频(新的在前):新版页面是 lockupViewModel,老版是 videoRenderer,两种都认;认不出返回 null
export const parseChannelVideos = (html) => {
  const m = String(html || '').match(/var ytInitialData = (\{.*?\});<\/script>/s)
  if (!m) return null
  let data
  try {
    data = JSON.parse(m[1])
  } catch {
    return null
  }
  const out = []
  const seen = new Set()
  const add = (id, title) => {
    const t = String(title || '').trim()
    if (!VIDEO_ID_RE.test(String(id || '')) || !t || seen.has(id)) return
    seen.add(id)
    out.push({ id, title: t })
  }
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const lockup = node.lockupViewModel
    if (lockup && typeof lockup === 'object') {
      add(lockup.contentId, lockup.metadata?.lockupMetadataViewModel?.title?.content)
    }
    const renderer = node.videoRenderer
    if (renderer && typeof renderer === 'object') {
      add(renderer.videoId, (renderer.title?.runs || []).map((r) => r.text || '').join('') || renderer.title?.simpleText)
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(data)
  return out
}

// 把这次页面上的(新的在前、所有标题)并进已知列表(老的在前):页面上没有的老条目原样留在前面;页面上标题带 Open-Box /
// openbox 的按发布先后接在后面(页面上有、标题不再带的就拿掉了)
export const mergeTutorialVideos = (known, page) => {
  const onPage = new Set(page.map((v) => v.id))
  const matched = page.filter((v) => TUTORIAL_TITLE_RE.test(v.title)).reverse()
  return [...known.filter((v) => !onPage.has(v.id)), ...matched]
}

export const registerTutorialVideoRoutes = (app, {
  ctx, paths, store, fetchImpl = globalThis.fetch, now = () => Date.now(),
  fetcher = createRouteFetcher({ ctx, paths, store, fetchImpl, name: 'tutorial-videos' }),
} = {}) => {
  const router = express.Router()
  const statePath = `${paths.dataDir}/tutorial-videos.json`
  let state = null
  let inflight = null
  let lastAttempt = 0

  const load = async () => {
    if (state) return state
    try {
      const saved = JSON.parse(await ctx.readFile(statePath))
      const videos = Array.isArray(saved.videos) ? saved.videos.filter((v) => v && VIDEO_ID_RE.test(String(v.id)) && v.title) : null
      state = { videos: videos && videos.length ? videos : [...SEED], updatedAt: Number(saved.updatedAt) || 0 }
    } catch {
      state = { videos: [...SEED], updatedAt: 0 }
    }
    return state
  }

  const refresh = async () => {
    const current = await load()
    if (now() - lastAttempt < TUTORIAL_REFRESH_MIN_MS) return { ...current }
    lastAttempt = now()
    const res = await fetcher.fetchByRoute(CHANNEL_VIDEOS_URL, null, { timeoutMs: PAGE_TIMEOUT_MS, maxBuffer: PAGE_MAX_BUFFER })
    if (!res.ok) return { ...current, error: `没连上 YouTube:${res.error}` }
    const page = parseChannelVideos(res.body)
    // 页面认不出视频(YouTube 改版、被拦到同意页):不动已知列表
    if (!page || !page.length) return { ...current, error: '没从频道页里认出视频列表' }
    state = { videos: mergeTutorialVideos(current.videos, page), updatedAt: now() }
    try {
      await ctx.mkdirp(paths.dataDir)
      await ctx.writeFile(statePath, JSON.stringify(state))
    } catch {
      // 存不下也照样把这次查到的回给面板,下次重启再从随包的开始
    }
    return { ...state }
  }

  router.get('/tutorial-videos', async (_req, res) => {
    const current = await load()
    res.json({ ...current, staleAfterMs: TUTORIAL_STALE_MS })
  })

  router.post('/tutorial-videos/refresh', async (_req, res) => {
    if (!inflight) inflight = refresh().finally(() => { inflight = null })
    try {
      res.json({ ...(await inflight), staleAfterMs: TUTORIAL_STALE_MS })
    } catch (err) {
      const current = await load()
      res.json({ ...current, staleAfterMs: TUTORIAL_STALE_MS, error: (err && err.message) || String(err) })
    }
  })

  app.use('/api/openbox', router)
}
