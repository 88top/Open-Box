import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

// update.sh / install.sh 里 2026-09-30 按代码审查补的几处(审查第六、七、八、九、十四、十五项):把函数原样抽出来,
// 配上假的 curl / 下载函数单独跑;整条升级流程在开发路由器 / ubuntu23 上用发布前验收工具实测(scripts/release-verify/)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const update = read('scripts/update.sh')
const install = read('scripts/install.sh')
const fn = (text, name) => {
  const m = text.match(new RegExp(`^${name}\\(\\) \\{[^]*?^\\}`, 'm'))
  assert.ok(m, `抽不出 ${name}`)
  return m[0]
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openbox-update-script-'))
const sh = (script, env = {}) => spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } })

// 假 curl:按请求的 URL 给不同的响应头。直连 github.com 不通(返回失败),经镜像前缀的回 302 到某个 tag
const fakeCurlDir = (body) => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\nfor a in "$@"; do url="$a"; done\n${body}\n`, { mode: 0o755 })
  return dir
}

test('探最新版本号:直连不通、镜像通道时经镜像问;wget / curl 两种都认 Location 里的 tag', () => {
  const dir = fakeCurlDir(`case "$url" in
  https://github.com/*) exit 7 ;;
  https://mirror.test/https://github.com/*) printf 'HTTP/2 302\\r\\nlocation: https://github.com/timeflysoon/Open-Box/releases/tag/v0.1.266\\r\\n\\r\\n' ;;
esac`)
  const script = `DOWNLOADER=curl; REPO=timeflysoon/Open-Box; CHANNEL=mirror; MIRROR_PREFIX=https://mirror.test
${fn(update, 'build_url')}
${fn(update, 'resolve_latest_tag_from')}
LATEST_URL="https://github.com/$REPO/releases/latest"
echo "direct=[$(resolve_latest_tag_from "$LATEST_URL")]"
echo "mirror=[$(resolve_latest_tag_from "$(build_url "$LATEST_URL")")]"`
  const r = sh(script, { PATH: `${dir}:${process.env.PATH}` })
  assert.match(r.stdout, /direct=\[\]/)
  assert.match(r.stdout, /mirror=\[v0\.1\.266\]/)
  // 主流程:直连探不到就标记直连不通(后面的校验文件不先试直连),镜像通道再经镜像问
  const block = update.slice(update.indexOf('if [ -z "$EXPECT_VERSION" ] && [ "$ROLLBACK_MODE" = "0" ]; then\n  EXPECT_VERSION=$(resolve_latest_tag_from'))
  assert.match(block.slice(0, 600), /TRUSTED_DIRECT_BROKEN=1/)
  assert.match(block.slice(0, 600), /resolve_latest_tag_from "\$\(build_url "\$LATEST_URL"\)"/)
  // 探版本号要排在选镜像之后(镜像没选好就没法经镜像问)
  assert.ok(update.indexOf('EXPECT_VERSION=$(resolve_latest_tag_from "$LATEST_URL")') > update.indexOf('  select_builtin_mirror\nfi'))
  assert.ok(install.indexOf('  resolve_latest_tag_now\n  set_asset_urls') > install.indexOf('  select_builtin_mirror\nfi'))
})

test('校验文件先直连取:直连通就用直连的;直连回的不是哈希(被劫持成网页)或者不通就走镜像,之后不再先试直连', () => {
  for (const [f, text] of [['update.sh', update], ['install.sh', install]]) {
    const dir = tmp()
    const script = `CHANNEL=mirror; MIRROR_PREFIX=https://mirror.test; TRUSTED_DIRECT_BROKEN=0; D='${dir}'
build_url() { printf 'https://mirror.test/%s\\n' "$1"; }
fetch_to_file_probe() { echo "probe $1" >> "$D/log"; case "$1" in *good*) printf '%064d  a.tar.gz\\n' 0 > "$2" ;; *html*) echo '<html>blocked</html>' > "$2" ;; *) return 7 ;; esac; }
fetch_to_file() { echo "mirror $1" >> "$D/log"; printf '%064d  a.tar.gz\\n' 1 > "$2"; }
${fn(text, 'valid_sha_file')}
${fn(text, 'fetch_to_file_trusted')}
fetch_to_file_trusted https://github.com/good.sha256 "$D/1" sha && head -c 8 "$D/1" && echo
fetch_to_file_trusted https://github.com/html.sha256 "$D/2" sha && head -c 8 "$D/2" && echo
fetch_to_file_trusted https://github.com/good.sha256 "$D/3" sha && head -c 8 "$D/3" && echo`
    const r = sh(script)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split('\n'), ['00000000', '00000000', '00000000'].map((x, i) => (i === 0 ? x : '00000000')), `${f}`)
    const log = fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n')
    assert.deepEqual(log, ['probe https://github.com/good.sha256', 'probe https://github.com/html.sha256', 'mirror https://mirror.test/https://github.com/html.sha256', 'mirror https://mirror.test/https://github.com/good.sha256'], `${f}:直连回网页就改走镜像,之后不再先试直连`)
  }
})

test('面板健康检查:/api/health 应答 ok 才算起来;一直不应答到时限就判失败', () => {
  const dir = tmp()
  const counter = path.join(dir, 'n')
  const curl = fakeCurlDir(`n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${counter}'
[ "$n" -ge 3 ] && printf '{"ok":true,"dbPath":"/x"}' || exit 7`)
  const root = tmp()
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'data/panel-port'), '3036\n')
  const script = (wait) => `set -eu; DOWNLOADER=curl; INSTALL_ROOT='${root}'
sleep() { :; }
${fn(update, 'panel_healthy')}
if panel_healthy ${wait}; then echo healthy; else echo unhealthy; fi`
  assert.match(sh(script(30), { PATH: `${curl}:${process.env.PATH}` }).stdout, /healthy/)
  assert.equal(fs.readFileSync(counter, 'utf8').trim(), '3')
  fs.writeFileSync(counter, '-1000')
  assert.match(sh(script(0), { PATH: `${curl}:${process.env.PATH}` }).stdout, /unhealthy/)
})

test('升级顺序:新 Node 在停服务之前试;新面板应答 /api/health 之后才删旧版本,起不来就整体回退、把旧版本的内核拉起来', () => {
  const at = (needle) => {
    const i = needle === 'if ! panel_healthy' ? update.lastIndexOf(needle) : update.indexOf(needle)
    assert.ok(i >= 0, `update.sh 里找不到:${needle}`)
    return i
  }
  assert.ok(at('openbox_node_smoke "$STAGE_DIR"') < at('write_status committing "" "" ""'))
  assert.ok(at('openbox_glibc_node "$STAGE_DIR"') < at('write_status committing "" "" ""'))
  assert.ok(at('# ---- swap:end ----') < at('if ! panel_healthy'))
  // 新组件换进来之后、面板应答之前不删旧版本(换入之前清掉上一次失败留下的 .old 是另一回事)
  const afterSwapIn = update.slice(at('mv "$STAGE_DIR/$comp" "$INSTALL_ROOT/$comp"'), at('if ! panel_healthy'))
  assert.doesNotMatch(afterSwapIn, /safe_rm_rf "\$INSTALL_ROOT\/\$comp\.old"/)
  const health = update.slice(at('if ! panel_healthy'), at('restart_core\n\nwrite_status done'))
  assert.match(health, /rollback_components/)
  assert.match(health, /restart_core/)
  assert.match(health, /safe_rm_rf "\$INSTALL_ROOT\/\$comp\.old"/)
  // 回退时连升级 / 卸载脚本一起换回去
  assert.match(fn(update, 'rollback_components'), /for _rb in update\.sh uninstall\.sh/)
})

test('防降级:探到的版本比装着的旧就不升;下载到的包比装着的旧就中止(--rollback 除外)', () => {
  assert.match(update, /if \[ "\$ROLLBACK_MODE" = "0" \] && \[ -n "\$EXPECT_VERSION" \] && \[ -n "\$OLD_VERSION" \] && version_less_than "\$EXPECT_VERSION" "\$OLD_VERSION"; then/)
  assert.match(update, /if \[ "\$ROLLBACK_MODE" = "0" \] && \[ -n "\$OLD_VERSION" \] && version_less_than "\$NEW_VERSION" "\$OLD_VERSION"; then\n\s*die "/)
  // 装着的 Node 跑不起来就不走组件升级(清单那一步要用它),改用完整安装包
  assert.match(update, /if \[ "\$\(openbox_node_try "\$INSTALL_ROOT" "\$\(cat "\$INSTALL_ROOT\/data\/node-preload" 2>\/dev\/null \|\| true\)"\)" = "ok" \]; then\n\s*\. "\$INSTALL_ROOT\/panel\/server\/system\/update-components\.sh"/)
})

// 一份 PATH:/usr/bin、/bin 里的命令都链进来,只缺 names 里的(模拟 #406 那种连 setsid / nohup 都没有的固件)
const pathWithout = (names) => {
  const dir = tmp()
  for (const src of ['/usr/bin', '/bin']) {
    for (const f of fs.readdirSync(src)) {
      if (names.includes(f) || fs.existsSync(path.join(dir, f))) continue
      try { fs.symlinkSync(path.join(src, f), path.join(dir, f)) } catch { /* 同名的已链过 */ }
    }
  }
  return dir
}

test('后台派发:没有 setsid 时双重 fork,有 nohup 套上、连 nohup 都没有也照样把 worker 派出去(#406)', async () => {
  const start = update.indexOf('    # 没有 setsid 的极简固件:双重 fork')
  const end = update.indexOf('  info "升级已在后台启动')
  assert.ok(start > 0 && end > start, '抽不出派发的最后一档')
  const block = update.slice(start, end) // else 分支的正文 + 收尾的 fi
  for (const missing of [['setsid', 'busybox'], ['setsid', 'busybox', 'nohup']]) {
    const dir = tmp()
    const worker = path.join(dir, 'worker.sh')
    fs.writeFileSync(worker, `echo "ran $OPENBOX_UPDATE_DISPATCHED $OPENBOX_UPDATE_EXPECT" > "${dir}/ran"\n`)
    const script = `set -eu\ninfo() { :; }\nCHANNEL_OVERRIDE=; CLI_MIRROR_PREFIX=; EXPECT_VERSION=v9.9.9; UPDATE_LOG="${dir}/update.log"\nif false; then :\nelse\n${block}`
    const r = spawnSync('/bin/sh', ['-c', script, worker], { encoding: 'utf8', env: { PATH: pathWithout(missing) } })
    assert.equal(r.status, 0, `${missing.join('/')} 都没有时派发失败:${r.stderr}`)
    let ran = ''
    for (let i = 0; i < 100 && !ran; i++) {
      if (fs.existsSync(path.join(dir, 'ran'))) ran = fs.readFileSync(path.join(dir, 'ran'), 'utf8').trim()
      else await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(ran, 'ran 1 v9.9.9', `缺 ${missing.join('/')} 时 worker 没跑起来;日志:${fs.existsSync(path.join(dir, 'update.log')) ? fs.readFileSync(path.join(dir, 'update.log'), 'utf8') : ''}`)
  }
})

test('systemd 上挪不出面板的 cgroup 就拒绝后台升级,不退回 setsid(停面板时会被一起结束)', () => {
  const dispatch = update.slice(update.indexOf('systemd-run --scope --quiet true'), update.indexOf('elif command -v setsid >/dev/null 2>&1; then'))
  assert.match(dispatch, /grep -q 'openbox-panel\\\.service' \/proc\/self\/cgroup/)
  assert.match(dispatch, /stage=failed/)
  assert.match(dispatch, /die "/)
})

test('全新安装:解包之后失败把这次铺下的东西撤掉(保留 data);重跑时认出上次没装完的残留,清掉接着装', () => {
  const root = tmp()
  for (const d of ['data', 'node/bin', 'panel', 'openwrt/bin']) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, 'data/keep'), 'x')
  fs.writeFileSync(path.join(root, 'meta.json'), '{}')
  fs.writeFileSync(path.join(root, '.node-glibc.123'), 'tmp')
  const common = `set -eu; INSTALL_ROOT='${root}'; PLATFORM=systemd; CLI_LINK=/nonexistent/open-box
info() { echo "INFO $*"; }
systemctl() { :; }
${fn(install, 'safe_rm_rf')}
`
  // 半成品(有文件、没有面板服务文件):清掉接着装
  const half = sh(`${common}${fn(install, 'check_existing_install')}\ndie() { echo "DIE $*"; exit 1; }\ncheck_existing_install && echo passed`)
  assert.match(half.stdout, /上次没装完的残留/)
  assert.match(half.stdout, /passed/)
  assert.deepEqual(fs.readdirSync(root).sort(), ['data'])
  assert.ok(fs.existsSync(path.join(root, 'data/keep')))
  // 装到一半失败:cleanup_partial_install 只在 INSTALL_PARTIAL=1 时动手
  for (const d of ['node/bin', 'panel']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const partial = sh(`${common}${fn(install, 'cleanup_partial_install')}\nINSTALL_PARTIAL=0; cleanup_partial_install; ls '${root}' | tr '\\n' ' '; echo; INSTALL_PARTIAL=1; cleanup_partial_install; ls '${root}' | tr '\\n' ' '`)
  assert.equal(partial.status, 0, partial.stderr)
  const [before, after] = partial.stdout.trim().split('\n')
  assert.match(before, /node/)
  assert.equal(after.trim(), 'data')
  // die 里真的调了它,解包成功之后打开、装完之后关掉
  assert.match(fn(install, 'die'), /cleanup_partial_install/)
  assert.ok(install.indexOf('INSTALL_PARTIAL=1') > install.indexOf('if ! extract_tgz "$TMP_DL/$ASSET" "$INSTALL_ROOT"; then'))
  assert.ok(install.lastIndexOf('INSTALL_PARTIAL=0') > install.indexOf('"$PANEL_SVC" start ||'))
})

// GPT 复核第三项:升级时复用的运行时在暂存目录里是指向现有安装的链接;glibc Node 那一步不能顺着链接去改还没提交的现有安装
test('glibc Node:node 是指向现有安装的链接时不替换、不下载(install / update 两份一样)', () => {
  for (const text of [update, install]) {
    const root = tmp(), live = tmp()
    fs.mkdirSync(path.join(live, 'bin'))
    fs.writeFileSync(path.join(live, '.flavor'), 'glibc 24.18.0\n') // .flavor 还在,node/bin/node 丢了
    fs.symlinkSync(live, path.join(root, 'node'))
    fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ nodeVersion: '24.18.0', arch: 'x64' }))
    const script = `D='${root}'
fetch_to_file() { echo "fetch $1" >> "$D/fetch.log"; return 7; }
${fn(text, 'openbox_glibc_node')}
openbox_glibc_node "$D"; echo "rc=$?"`
    const r = sh(script)
    assert.match(r.stdout, /指向现有安装的链接/)
    assert.match(r.stdout, /rc=1/)
    assert.equal(fs.existsSync(path.join(root, 'fetch.log')), false, '不该去下载')
    assert.deepEqual(fs.readdirSync(live).sort(), ['.flavor', 'bin'])
    assert.deepEqual(fs.readdirSync(path.join(live, 'bin')), [])
  }
})

// GPT 复核第四项:meta.json 换不上以前只警告、接着升,组件是新的、版本号还是旧的。现在同别的换文件失败一样整体回退;
// 回退之后把旧版本的面板和(升级前在跑的)内核拉起来——以前 swap_failed 只靠退出时的 cleanup 拉面板,内核一直停着
test('换文件途中失败(含 meta.json 换不上):整体回退,再把旧版本的面板和内核拉起来', () => {
  assert.match(update, /mv "\$STAGE_DIR\/meta\.json" "\$INSTALL_ROOT\/meta\.json" \|\| swap_failed /)
  assert.doesNotMatch(update, /meta\.json 替换失败/)
  assert.ok(update.indexOf('restart_core() {') < update.indexOf('for comp in $COMPONENTS; do\n  [ -e "$INSTALL_ROOT/$comp.old" ]'), 'restart_core 要定义在换文件之前')
  const root = tmp()
  fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'panel/server/cli'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node/bin/node'), `#!/bin/sh\necho "deploy $*" >> '${root}/log'\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'panel/server/cli/deploy.mjs'), '')
  fs.writeFileSync(path.join(root, 'panel-svc'), `#!/bin/sh\necho "panel $1" >> '${root}/log'\n`, { mode: 0o755 })
  const script = `INSTALL_ROOT='${root}'; PANEL_SVC='${root}/panel-svc'; CORE_WAS_RUNNING=1
write_status() { :; }; info() { :; }; warn() { :; }
die() { echo "die: $*"; exit 1; }
rollback_components() { echo rollback >> '${root}/log'; return 0; }
panel_healthy() { echo healthy >> '${root}/log'; return 0; }
${fn(update, 'restart_core')}
${fn(update, 'swap_failed')}
swap_failed "替换 meta.json 失败。"`
  const r = sh(script)
  assert.equal(r.status, 1)
  assert.equal(fs.readFileSync(path.join(root, 'log'), 'utf8'), `rollback\npanel start\nhealthy\ndeploy ${root}/panel/server/cli/deploy.mjs\n`)
  assert.match(r.stdout, /die: 替换 meta\.json 失败。 已把 .*整体回退到升级前的版本.*;内核已重新生成配置并启动。请检查/)
})

// #535:每日自动升级后起内核,部署脚本和刚起来的面板抢数据库写锁失败(database is locked),以前只试一次,内核停了 9 小时。
// 现在输出里有 database is locked 就隔 5 秒再试,最多 3 次;别的失败照旧只跑一次
test('升级后起内核:数据库被面板占着(database is locked)时重试,最多 3 次;别的失败不重试', () => {
  const run = (failures, message) => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'node/bin'), { recursive: true })
    fs.mkdirSync(path.join(root, 'panel/server/cli'), { recursive: true })
    // 假 node:前 failures 次按 message 失败,之后成功;每次都记一笔
    fs.writeFileSync(path.join(root, 'node/bin/node'), `#!/bin/sh
echo run >> '${root}/log'
n=$(wc -l < '${root}/log' | tr -d ' ')
if [ "$n" -le ${failures} ]; then echo "Error: ${message}" >&2; exit 1; fi
echo '{"ok":true}'
`, { mode: 0o755 })
    fs.writeFileSync(path.join(root, 'panel/server/cli/deploy.mjs'), '')
    const script = `set -eu
INSTALL_ROOT='${root}'; CORE_WAS_RUNNING=1; TMPDIR='${root}'
write_status() { :; }; info() { :; }; warn() { echo "[warn] $*"; }
panel_healthy() { return 0; }
sleep() { echo "sleep $1" >> '${root}/sleeps'; }
${fn(update, 'restart_core')}
restart_core
echo "MSG:$CORE_MSG"`
    const r = sh(script)
    const runs = fs.readFileSync(path.join(root, 'log'), 'utf8').trim().split('\n').length
    const sleeps = fs.existsSync(path.join(root, 'sleeps')) ? fs.readFileSync(path.join(root, 'sleeps'), 'utf8').trim().split('\n') : []
    return { r, runs, sleeps }
  }
  let { r, runs, sleeps } = run(1, 'database is locked')
  assert.equal(r.status, 0)
  assert.equal(runs, 2)
  assert.deepEqual(sleeps, ['sleep 5'])
  assert.match(r.stdout, /MSG:内核已重新生成配置并启动。/)
  ;({ r, runs, sleeps } = run(5, 'database is locked'))
  assert.equal(r.status, 0, 'set -eu 下失败也不能让升级脚本退出')
  assert.equal(runs, 3, '最多 3 次')
  assert.equal(sleeps.length, 2)
  assert.match(r.stdout, /MSG:内核启动失败,请到面板查看原因后重新启动。/)
  ;({ r, runs, sleeps } = run(5, 'invalid config'))
  assert.equal(runs, 1, '别的失败不重试')
  assert.deepEqual(sleeps, [])
  assert.match(r.stdout, /内核启动失败\(部署退出码 1\)/)
})

// 2026-09-30 别的路由器上全新安装:opkg update 失败(软件源不通),kmod-nft-queue 没装上,脚本提示「可稍后手动执行:
// opkg install kmod-nft-queue」,照着敲只得到 Unknown package——软件源不通时 opkg 没有包列表,什么包都不认识。
// 现在按装不上的原因提示;install / update 两份依赖检查逐字一样
test('系统依赖装不上时按原因提示:软件源不通 / 源里没有这个包 / 和内核对不上 / 其它', () => {
  const block = (text) => {
    const a = text.indexOf('DEP_TUN_DEV="${DEP_TUN_DEV:-/dev/net/tun}"')
    const b = text.indexOf('\nensure_dependencies\n', a)
    assert.ok(a >= 0 && b > a, '抽不出依赖检查')
    return text.slice(a, b)
  }
  assert.equal(block(install), block(update), 'install.sh / update.sh 的依赖检查要一模一样')
  // 一般的依赖按原因提示(看 kmod-veth 那行);kmod-nft-queue 用户 2026-10-01 定了:装不上就不管,提示不装也能用 + 手动安装命令,
  // 知道原因的在括号里补一句
  const cases = {
    'update-fail': /opkg update 没成功,软件源连不上时什么包都装不了:先检查 \/etc\/opkg\/distfeeds\.conf.*再执行:opkg update && opkg install kmod-veth/,
    unknown: /软件源里没有这个包\(第三方固件的软件源里常没有官方内核模块\):换一个自带 kmod-veth 的固件/,
    kernel: /软件源里的 kmod-veth 和本机内核版本对不上/,
    other: /可稍后手动执行:opkg update && opkg install kmod-veth/,
  }
  const queueWhy = {
    'update-fail': '(opkg update 没成功,先检查 /etc/opkg/distfeeds.conf 里的软件源地址)',
    unknown: '(固件的软件源里没有这个包,要从固件作者的软件源装)',
    kernel: '(软件源里的包和本机内核版本对不上,要从固件作者的软件源装)',
    other: '',
  }
  for (const [scenario, want] of Object.entries(cases)) {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.mkdirSync(path.join(dir, 'sys-module'))
    fs.writeFileSync(path.join(dir, 'ca.crt'), 'x')
    // 假 opkg:update 按场景成败;install 回真实 opkg 的报错原文(内核对不上那种取自 2026-09-30 香港那台 24.10.2 的输出:
    // 开头同样有 Unknown package,最后一句说架构不兼容其实是依赖没满足)
    fs.writeFileSync(path.join(dir, 'bin/opkg'), `#!/bin/sh
case "$1" in
  update) [ "$SCENARIO" = update-fail ] && exit 1; exit 0 ;;
  install)
    case "$SCENARIO" in
      update-fail|unknown) echo "Unknown package '$2'."; echo "Collected errors:"; echo " * opkg_install_cmd: Cannot install package $2." ;;
      kernel) echo "Unknown package '$2'."; echo "Collected errors:"; echo " * pkg_hash_check_unresolved: cannot find dependency kernel (= 6.12.48~a4b356d0e45f5e9f9b716937755517e3-r1) for $2"; echo " * pkg_hash_fetch_best_installation_candidate: Packages for $2 found, but incompatible with the architectures configured"; echo " * opkg_install_cmd: Cannot install package $2." ;;
      *) echo "wget returned 4." ;;
    esac
    exit 255 ;;
esac
`, { mode: 0o755 })
    // 和真实脚本一样开着 set -eu:依赖装不上只提示,脚本必须接着往下走(v0.1.267~272 在这里直接退出,#354 #358)
    const script = `set -eu
info() { echo "[info] $*"; }; warn() { echo "[warn] $*"; }
modprobe() { return 1; }; ip() { return 0; }
DEP_TUN_DEV=/dev/null DEP_SYS_MODULE='${dir}/sys-module' DEP_CA_BUNDLE='${dir}/ca.crt'
${block(install)}
ensure_dependencies
echo DEPS-DONE`
    const r = sh(script, { PATH: `${dir}/bin:/usr/bin:/bin`, SCENARIO: scenario })
    assert.match(r.stdout, /DEPS-DONE/, `${scenario}:依赖检查之后脚本退出了\n${r.stdout}`)
    const veth = r.stdout.split('\n').find((l) => l.includes('仍缺 kmod-veth')) || ''
    assert.match(veth, want, `${scenario}:${r.stdout}`)
    const line = r.stdout.split('\n').find((l) => l.includes('仍缺 kmod-nft-queue')) || ''
    assert.ok(line.endsWith(`不装也能用;要装请自行执行:opkg update && opkg install kmod-nft-queue${queueWhy[scenario]}`), `${scenario}:${line}`)
    // 只缺的那几个才提示;kmod-tun / ip netns / 证书都在
    assert.doesNotMatch(r.stdout, /仍缺 (kmod-tun|ip-full|ca-bundle)/)
    // 两个 queue 模块都没有(假 sys/module 里没有 nfnetlink_queue):只影响首包预判,不说降级纯 tun
    assert.match(line, /只影响入口的「首包预判放行」/)
    assert.doesNotMatch(line, /纯 tun/)
  }
  // 有 nfnetlink_queue、缺 nft_queue:这才会降级纯 tun
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.mkdirSync(path.join(dir, 'sys-module/nfnetlink_queue'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ca.crt'), 'x')
  fs.writeFileSync(path.join(dir, 'bin/opkg'), '#!/bin/sh\n[ "$1" = update ] && exit 0\necho "wget returned 4."; exit 255\n', { mode: 0o755 })
  const r = sh(`set -eu
info() { :; }; warn() { echo "[warn] $*"; }
modprobe() { return 1; }; ip() { return 0; }
DEP_TUN_DEV=/dev/null DEP_SYS_MODULE='${dir}/sys-module' DEP_CA_BUNDLE='${dir}/ca.crt'
${block(install)}
ensure_dependencies
echo DEPS-DONE`, { PATH: `${dir}/bin:/usr/bin:/bin` })
  assert.match(r.stdout, /DEPS-DONE/)
  assert.match(r.stdout, /仍缺 kmod-nft-queue:nftables 转发起不来,内核会自动改用纯 tun 兼容模式/)
})

// GitHub #330:选定的镜像传安装包时每次都在同一处断开(Debian 13 + ghfast.top,SSL unexpected eof),以前一次失败就退出。
// 现在按「当前通道 → 其余内置镜像 → 直连」换来源再试,成功的来源留给后面的下载
test('下载正文失败时换来源再试,成功的来源留给后面的下载(install / update 两份来源块一样)', () => {
  const blockOf = (text) => {
    const a = text.indexOf('# ---- openbox-download-sources:start ----')
    const b = text.indexOf('# ---- openbox-download-sources:end ----')
    assert.ok(a >= 0 && b > a, '抽不出下载来源块')
    return text.slice(a, b)
  }
  assert.equal(blockOf(install), blockOf(update), 'install.sh / update.sh 的下载来源块要一模一样')
  const mirrors = 'BUILTIN_MIRRORS="\nhttps://ghfast.top\nhttps://gh-proxy.com\nhttps://gh.llkk.cc\n"'
  const u = 'https://github.com/x/y/a.tgz'
  // 调用方把 IFS 设成只有换行(逐行读结果)时也要按空白拆
  const order = (setup) => sh(`${mirrors}\n${blockOf(update)}\n${setup}\nIFS='\n'\nopenbox_download_sources ${u}`).stdout.trim().split('\n')
  const builtin = ['https://ghfast.top', 'https://gh-proxy.com', 'https://gh.llkk.cc']
  assert.deepEqual(order('CHANNEL=mirror; MIRROR_PREFIX=https://ghfast.top'), [...builtin.map((m) => `${m} ${m}/${u}`), `direct ${u}`])
  assert.deepEqual(order('CHANNEL=direct; MIRROR_PREFIX='), [`direct ${u}`, ...builtin.map((m) => `${m} ${m}/${u}`)])
  assert.deepEqual(order('CHANNEL=mirror; MIRROR_PREFIX=my.mirror'), [`my.mirror https://my.mirror/${u}`, ...builtin.map((m) => `${m} ${m}/${u}`), `direct ${u}`])

  // install.sh:ghfast 断开,gh-proxy 下好,之后改用 gh-proxy
  let dir = tmp()
  let r = sh(`${mirrors}
CHANNEL=mirror; MIRROR_PREFIX=https://ghfast.top; D='${dir}'
warn() { echo "[warn] $*"; }
fetch_to_file() { echo "$1" >> "$D/tries"; case "$1" in https://ghfast.top/*) return 56 ;; esac; echo ok > "$2"; }
${blockOf(install)}
${fn(install, 'download_asset')}
download_asset ${u} "$D/out"; echo "rc=$? channel=$CHANNEL prefix=$MIRROR_PREFIX"`)
  assert.match(r.stdout, /rc=0 channel=mirror prefix=https:\/\/gh-proxy\.com/)
  assert.match(r.stdout, /\[warn\] 从 https:\/\/ghfast\.top 下载失败,换 https:\/\/gh-proxy\.com 再试/)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'tries'), 'utf8').trim().split('\n'), [`https://ghfast.top/${u}`, `https://gh-proxy.com/${u}`])
  assert.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), 'ok\n')

  // update.sh:传进来的是拼好 ghfast 前缀的地址(组件脚本就这么传);它不再重试,两个镜像也失败,直连下好,之后改用直连
  dir = tmp()
  r = sh(`${mirrors}
CHANNEL=mirror; MIRROR_PREFIX=https://ghfast.top; D='${dir}'
warn() { echo "[warn] $*"; }
download_with_progress_once() { echo "$1" >> "$D/tries"; case "$1" in https://github.com/*) echo ok > "$2"; return 0 ;; esac; return 56; }
${blockOf(update)}
${fn(update, 'download_with_progress')}
download_with_progress https://ghfast.top/${u} "$D/out" 100; echo "rc=$? channel=$CHANNEL prefix=[$MIRROR_PREFIX]"`)
  assert.match(r.stdout, /rc=0 channel=direct prefix=\[\]/)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'tries'), 'utf8').trim().split('\n'),
    [`https://ghfast.top/${u}`, `https://gh-proxy.com/${u}`, `https://gh.llkk.cc/${u}`, u])
  assert.match(r.stdout, /从 https:\/\/gh\.llkk\.cc 下载失败,换 GitHub 直连 再试/)
  // 全都失败:返回非零,调用方照旧 die
  r = sh(`${mirrors}
CHANNEL=direct; MIRROR_PREFIX=
warn() { :; }
download_with_progress_once() { return 56; }
${blockOf(update)}
${fn(update, 'download_with_progress')}
download_with_progress ${u} /dev/null 1; echo "rc=$?"`)
  assert.match(r.stdout, /rc=1/)
})

// 用户 2026-10-01:kmod-nft-queue 固件源装不上就不管了——提示不装也能用,给出手动安装命令,用户自己装。v0.1.267~272 会按
// 内核版本去官方 / ImmortalWrt / sbwml 的源自动找,找不到时又把整个安装 / 升级带退出了(set -e,GitHub #354 #358),已拿掉
test('kmod-nft-queue 装不上:不再去别的源找,提示不装也能用 + 手动安装命令(opkg / apk),脚本接着往下走', () => {
  const depBlock = (text) => text.slice(text.indexOf('DEP_TUN_DEV="${DEP_TUN_DEV:-/dev/net/tun}"'), text.indexOf('\nensure_dependencies\n', text.indexOf('DEP_TUN_DEV=')))
  assert.equal(depBlock(install), depBlock(update))
  for (const name of ['dep_kmod_autofetch', 'openwrt_core', 'DEP_KMOD_BUDGET']) assert.ok(!install.includes(name) && !update.includes(name), `${name} 应该已经拿掉`)
  for (const pm of ['opkg', 'apk']) {
    const dir = tmp()
    for (const d of ['bin', 'sys-module']) fs.mkdirSync(path.join(dir, d))
    fs.writeFileSync(path.join(dir, 'ca.crt'), 'x')
    // 假包管理器:update 成功,装什么都是「没有这个包」;假 curl / wget:被调用就记一笔(不该再被调用)
    fs.writeFileSync(path.join(dir, `bin/${pm}`), '#!/bin/sh\n[ "$1" = update ] && exit 0\necho "Unknown package \'$2\'."; exit 255\n', { mode: 0o755 })
    for (const dl of ['curl', 'wget']) fs.writeFileSync(path.join(dir, `bin/${dl}`), '#!/bin/sh\necho "$0 $*" >> "$D/downloads"\nexit 22\n', { mode: 0o755 })
    const r = sh(`set -eu
info() { echo "[info] $*"; }; warn() { echo "[warn] $*"; }
modprobe() { return 1; }; ip() { return 0; }
DEP_TUN_DEV=/dev/null DEP_SYS_MODULE='${dir}/sys-module' DEP_CA_BUNDLE='${dir}/ca.crt'
${depBlock(install)}
ensure_dependencies
echo DEPS-DONE`, { PATH: `${dir}/bin:/usr/bin:/bin`, D: dir })
    assert.match(r.stdout, /DEPS-DONE/, `${pm}:依赖检查之后脚本退出了\n${r.stdout}`)
    assert.equal(fs.existsSync(path.join(dir, 'downloads')), false, `${pm}:不该再去别的源下载`)
    const verb = pm === 'apk' ? 'apk add' : 'opkg install'
    const line = r.stdout.split('\n').find((l) => l.includes('仍缺 kmod-nft-queue')) || ''
    assert.ok(line.includes(`不装也能用;要装请自行执行:${pm} update && ${verb} kmod-nft-queue(固件的软件源里没有这个包`), `${pm}:${line}`)
    assert.ok(!r.stdout.includes('自动查找'), r.stdout)
  }
})


test('回退面板始终不应答时不部署内核,保留明确的手动启动提示(#557)', () => {
  const r = sh(`set -eu; CORE_WAS_RUNNING=1
panel_healthy() { return 1; }
warn() { echo "warn:$*"; }
${fn(update, 'restart_core')}
restart_core
echo "$CORE_MSG"`)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /面板尚未应答/)
  assert.match(r.stdout, /手动启动/)
})

test('安装内的旧升级脚本先取最新版:拒绝网页,镜像失败再直连,保留渠道和目标版本(#557)', () => {
  const dir = tmp()
  const script = `set -eu; TMP_PARENT='${dir}'; REPO=timeflysoon/Open-Box
CHANNEL=mirror; MIRROR_PREFIX=https://mirror.test; BUILTIN_MIRRORS=https://unused.test
CHANNEL_OVERRIDE=mirror; CLI_MIRROR_PREFIX=https://mirror.test; ROLLBACK_MODE=0; EXPECT_VERSION=v0.1.318
OPENBOX_UPDATE_RELOCATED=0
info() { :; }; write_status() { :; }; die() { echo "$*"; exit 1; }
detect_downloader() { :; }; ensure_tmp_parent() { :; }; resolve_channel() { :; }; cancel_requested() { return 1; }
fetch_to_file_probe() {
  echo "$1" >> '${dir}/urls'
  case "$1" in https://mirror.test/*) echo '<html>error</html>' > "$2" ;;
  *) printf '#!/bin/sh\\n# Open-Box 升级脚本\\nprintf "%%s\\n" "$@" > "${dir}/args"\\nprintf "%%s" "$OPENBOX_UPDATE_REFRESHED" > "${dir}/fresh"\\n' > "$2" ;; esac
}
${fn(update, 'refresh_update_script')}
refresh_update_script`
  const r = sh(script)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n'), ['--mirror', 'https://mirror.test', '--expect', 'v0.1.318'])
  assert.equal(fs.readFileSync(path.join(dir, 'fresh'), 'utf8'), '1')
  assert.equal(fs.readFileSync(path.join(dir, 'urls'), 'utf8').trim().split('\n').length, 2)
})

// 面板 / LuCI 的旧 worker 把渠道放在环境里，取到最新脚本后又通过 argv 接力。
// 最新脚本必须能真正解析这两份记录，不能只用打印 argv 的假脚本验接力。
const channelScan = update.slice(update.indexOf('_probe_or_cancel_scan=0'), update.indexOf('\nif [ "$_probe_or_cancel_scan"', update.indexOf('_probe_or_cancel_scan=0')))
const updateArgs = update.slice(update.indexOf('DETACH=0\n'), update.indexOf('\n# --detach 转发子进程'))
const parseUpdateArgs = (args, env = {}) => spawnSync('sh', ['-c', `set -eu
die() { echo "$*" >&2; exit 1; }
${channelScan}
${updateArgs}
printf 'channel=%s\\nprefix=%s\\nexpect=%s\\nrollback=%s\\n' "$CHANNEL_OVERRIDE" "$CLI_MIRROR_PREFIX" "$EXPECT_VERSION" "$ROLLBACK_MODE"`, 'update-test', ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('渠道显式参数优先于旧 worker 的环境记录，命令行里的双渠道仍拒绝', () => {
  const inherited = { OPENBOX_UPDATE_CHANNEL_OVERRIDE: 'mirror', OPENBOX_UPDATE_MIRROR_PREFIX: 'https://old.test' }
  for (const [args, expected] of [
    [['--direct'], 'channel=direct\nprefix='],
    [['--mirror'], 'channel=mirror\nprefix='],
    [['--mirror', 'https://new.test'], 'channel=mirror\nprefix=https://new.test'],
  ]) {
    const r = parseUpdateArgs([...args, '--expect', 'v0.1.319'], inherited)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.startsWith(expected + '\n'), r.stdout)
    assert.match(r.stdout, /expect=v0\.1\.319/)
  }
  const worker = parseUpdateArgs([], inherited)
  assert.equal(worker.status, 0, worker.stderr)
  assert.match(worker.stdout, /channel=mirror\nprefix=https:\/\/old\.test/)
  for (const args of [['--direct', '--mirror'], ['--mirror', '--direct']]) {
    const r = parseUpdateArgs(args, inherited)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /不能与/)
  }
  for (const args of [['--probe', 'direct'], ['--cancel']]) {
    const r = parseUpdateArgs(args, inherited)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^channel=\nprefix=\n/)
  }
})

test('后台 worker 获取最新脚本后实际重新解析，直连、内置镜像、指定镜像均可接力', () => {
  for (const [channel, prefix, rollback] of [['direct', '', '0'], ['mirror', '', '0'], ['mirror', 'https://mirror.test', '1']]) {
    const dir = tmp()
    const fresh = `#!/bin/sh\n# Open-Box 升级脚本\nset -eu\ndie() { echo "$*" >&2; exit 1; }\n${channelScan}\n${updateArgs}\nprintf 'channel=%s\\nprefix=%s\\nexpect=%s\\nrollback=%s\\n' "$CHANNEL_OVERRIDE" "$CLI_MIRROR_PREFIX" "$EXPECT_VERSION" "$ROLLBACK_MODE" > '${dir}/parsed'\n`
    fs.writeFileSync(path.join(dir, 'latest.sh'), fresh)
    const r = sh(`set -eu; TMP_PARENT='${dir}'; REPO=timeflysoon/Open-Box
CHANNEL_OVERRIDE='${channel}'; CLI_MIRROR_PREFIX='${prefix}'; ROLLBACK_MODE='${rollback}'; EXPECT_VERSION=v0.1.319
OPENBOX_UPDATE_RELOCATED=0; BUILTIN_MIRRORS=https://builtin.test
write_status() { :; }; die() { echo "$*" >&2; exit 1; }
detect_downloader() { :; }; ensure_tmp_parent() { :; }; cancel_requested() { return 1; }
${fn(update, 'resolve_channel')}
fetch_to_file_probe() { cp '${dir}/latest.sh' "$2"; }
${fn(update, 'refresh_update_script')}
refresh_update_script`, { OPENBOX_UPDATE_CHANNEL_OVERRIDE: channel, OPENBOX_UPDATE_MIRROR_PREFIX: prefix, OPENBOX_UPDATE_EXPECT: 'v0.1.319' })
    assert.equal(r.status, 0, `${channel} ${prefix}: ${r.stderr}`)
    assert.equal(fs.readFileSync(path.join(dir, 'parsed'), 'utf8'), `channel=${channel}\nprefix=${prefix}\nexpect=v0.1.319\nrollback=${rollback}\n`)
  }
})

test('真实启动顺序:后台 worker 未指定镜像前缀时，刷新脚本之前已初始化内置镜像', () => {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const fresh = `#!/bin/sh\n# Open-Box 升级脚本\nset -eu\ndie() { echo "$*" >&2; exit 1; }\n${channelScan}\n${updateArgs}\nprintf '%s\\n' "$CHANNEL_OVERRIDE" > '${dir}/parsed'\n`
  fs.writeFileSync(path.join(dir, 'latest.sh'), fresh)
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do\ncase "$1" in -o) shift; output="$1" ;; http*) echo "$1" >> '${dir}/urls' ;; esac\nshift\ndone\ncp '${dir}/latest.sh' "$output"\n`, { mode: 0o755 })
  // 执行真实文件开头直到刷新入口，避免预先在测试里赋 BUILTIN_MIRRORS 而遮住初始化顺序错误。
  const worker = path.join(dir, 'worker.sh')
  fs.writeFileSync(worker, update.slice(0, update.indexOf('\n# 走到这里,说明既不是 --probe')))
  const r = spawnSync('sh', [worker], { encoding: 'utf8', env: { ...process.env,
    PATH: `${bin}:${process.env.PATH}`, OPENBOX_TMPDIR: dir, OPENBOX_UPDATE_RELOCATED: '1',
    OPENBOX_UPDATE_REFRESHED: '0', OPENBOX_UPDATE_CHANNEL_OVERRIDE: 'mirror', OPENBOX_UPDATE_MIRROR_PREFIX: '',
  } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(path.join(dir, 'parsed'), 'utf8').trim(), 'mirror')
  assert.match(fs.readFileSync(path.join(dir, 'urls'), 'utf8'), /^https:\/\/ghfast\.top\/https:\/\/github\.com\//)
})
