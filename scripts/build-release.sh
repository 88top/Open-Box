#!/bin/sh
# Open-Box 发布打包脚本(POSIX sh,不依赖 bash;OpenWrt 上不会跑这个脚本,
# 但保持 POSIX 兼容以便在任意构建机——本机 macOS / GitHub Actions ubuntu-latest——
# 都能用 sh 直接执行,不引入 bashism)。
#
# 用法: sh scripts/build-release.sh <x64|arm64> <outdir>
#
# 产出 <outdir>/open-box-<version>-linux-<arch>.tar.gz 与同名 .sha256(留档用),
# 以及内容完全一致但文件名不带版本号的 <outdir>/open-box-linux-<arch>.tar.gz 与
# 同名 .sha256(install.sh / update.sh 靠这份稳定资产名通过
# github.com/<repo>/releases/latest/download/<asset> 直链拿最新版,不查询
# api.github.com——见 Important 5;两者内容字节级相同,只是文件名不同)。
# tarball 解开后即 /opt/open-box 的内容:
#   node/            musl Node 运行时(bin/node、lib/ 里是捆绑的 musl 版
#                    libstdc++.so.6 / libgcc_s.so.1,见下方 Critical 1)
#   panel/dist/      前端构建产物
#   panel/server/    corepack pnpm deploy --prod 产出的自包含后端
#   bin/sing-box     钦定版本 sing-box 二进制
#   openwrt/         initd/ 与 luci/(供安装脚本铺到系统路径)
#   uninstall.sh     卸载脚本(供 LuCI 兜底页与离线卸载调用)
#   update.sh        升级脚本(供 LuCI 兜底页一键升级调用;支持 --detach 后台执行)
#   meta.json        {version, singboxVersion, nodeVersion, arch, builtAt}
#
# 关键事实,不要"简化"掉:OpenWrt 用 musl libc,官方 nodejs.org 的 linux-x64/arm64
# 二进制是 glibc 链接的,在路由器上起不来。必须用 unofficial-builds 的 musl 构建。
# sing-box 的架构命名和 Node 不同:x64 → amd64,arm64 → arm64,不要写反。
#
# sing-box 同样有这个坑:SagerNet 发布的不带后缀的 `sing-box-<ver>-linux-<arch>.tar.gz`
# 是动态链接 glibc 的(还附带 libcronet.so,实测 `file` 显示
# `interpreter /lib64/ld-linux-x86-64.so.2`),在 OpenWrt 上同样起不来。必须用带
# `-musl` 后缀的资产(`sing-box-<ver>-linux-<arch>-musl.tar.gz`),实测为 statically
# linked,不依赖任何动态链接器。
#
# 还有一层更深的坑(P6 终审 Critical 1):x64 的 musl Node 二进制本身又动态依赖
# `libstdc++.so.6`(`DT_NEEDED`:libstdc++.so.6 / libgcc_s.so.1 /
# libc.musl-x86_64.so.1),而 OpenWrt 官方 `DEFAULT_PACKAGES` 只带 `libgcc`、
# **不带 `libstdcpp`**——stock x86_64 镜像上 musl 加载器会直接报
# "Error loading shared library libstdc++.so.6",面板被 procd 无限重启。arm64
# 的 Node 不需要 libstdc++(其 C++ 运行时是静态链接进二进制的),但为防上游哪天
# 改成动态链接,两个架构都统一从 Alpine 拿 musl 版 libstdc++ / libgcc 塞进
# `node/lib/`,并配合 `openwrt/initd/openbox-panel` 里的
# `LD_LIBRARY_PATH=/opt/open-box/node/lib` 生效。
#
# 打包前会用 dt-needed.py(见同目录,纯 Python,不依赖 readelf/objdump——这两个
# 工具在 macOS 上要么没有要么对交叉架构 ELF 不可靠)解析 node 二进制的真实
# DT_NEEDED,任何一条"既不在 node/lib/ 里、也不属于 OpenWrt 默认可用集"的依赖都
# 会让构建直接失败——上游把 Node 换成依赖更多动态库的构建时,这里会当场炸,而不是
# 装到用户路由器上才发现面板起不来。
#
# 经验证:musl 的动态链接器(ldso/dynlink.c)把所有形如 `libc.*` /
# `libpthread.*` / `librt.*` / `libm.*` / `libdl.*` / `libutil.*` / `libxnet.*`
# 的 DT_NEEDED 名字都当成"指向 libc 自身"的保留名直接自解析,不做文件查找——这解释
# 了为什么 arm64 版 Node 的 DT_NEEDED 里出现的是字面量 `libc.so` 而不是
# `libc.musl-aarch64.so.1`:两者都无需在 node/lib/ 或系统里能找到同名文件,守卫的
# 允许集必须把这两种写法都算作"OpenWrt 默认可用"。

set -eu

# 在 macOS 上打包时,BSD tar 会把 com.apple.provenance 之类的扩展属性写成 PAX 头,
# 路由器上的 GNU/busybox tar 解包时每个文件都报一句 "Ignoring unknown extended header
# keyword"。无害,但满屏警告吓人,关掉。
export COPYFILE_DISABLE=1

NODE_VERSION="24.18.0"

# ---- 供应链固定:版本号旁边固定对应资产的 sha256,下载后(含缓存命中时)校验,
# 不匹配就构建失败。避免"每次发版都重新下载却从不校验"的静默供应链口子——
# 这些哈希是筛查时从各自的官方发布源现取现算的(见下方各资产的 URL),下次升级
# 版本号务必同步重新计算并写入,不要凭旧哈希手改版本号。----
NODE_SHA256_X64="b818a0c3857272329cad4d575abf49e5060215858c9c3015437366f8adc7b85d"
NODE_SHA256_ARM64="b32d834975b3b38cf3226e220d3e1fcb5959047f0b2e184fffb709d9a69ed434"

# Alpine 的 musl 版 libstdc++ / libgcc(见文件头 Critical 1 说明)。latest-stable
# 仓库里 x86_64 与 aarch64 目前恰好是同一个包版本,但两个架构的资产是分别构建的
# 独立二进制,哈希必须分开固定,不能假设永远同版本号就直接共用。
ALPINE_GCC_PKG_VERSION="15.2.0-r5"
ALPINE_LIBSTDCPP_SHA256_X86_64="14c987b556f5385a5db18376e788c75f37d85321b8dc1920d926ea7daac1d6f6"
ALPINE_LIBSTDCPP_SHA256_AARCH64="2302e766d4e4926038ec166ecb85837ee884576115236ddb565e3a5fca4a11d7"
ALPINE_LIBGCC_SHA256_X86_64="393dcd32629f06d7d85409c272d142d0c082772d10b87ef55ee82f47de3be637"
ALPINE_LIBGCC_SHA256_AARCH64="369aaa6e9d099a737bad6dd3e6c2fe7bb1547ca26d22b94ee0411228f709b403"

usage() {
  echo "usage: $0 <x64|arm64> <outdir>" >&2
  exit 1
}

[ "$#" -eq 2 ] || usage
ARCH="$1"
OUTDIR_ARG="$2"

case "$ARCH" in
  x64)
    SINGBOX_ARCH="amd64"
    ALPINE_ARCH="x86_64"
    NODE_SHA256="$NODE_SHA256_X64"
    ALPINE_LIBSTDCPP_SHA256="$ALPINE_LIBSTDCPP_SHA256_X86_64"
    ALPINE_LIBGCC_SHA256="$ALPINE_LIBGCC_SHA256_X86_64"
    ;;
  arm64)
    SINGBOX_ARCH="arm64"
    ALPINE_ARCH="aarch64"
    NODE_SHA256="$NODE_SHA256_ARM64"
    ALPINE_LIBSTDCPP_SHA256="$ALPINE_LIBSTDCPP_SHA256_AARCH64"
    ALPINE_LIBGCC_SHA256="$ALPINE_LIBGCC_SHA256_AARCH64"
    ;;
  *)
    echo "ERROR: unsupported arch '$ARCH' (expected x64 or arm64)" >&2
    exit 1
    ;;
esac

command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: 需要 python3 来解析构建产物的 DT_NEEDED(见 dt-needed.py,构建期依赖守卫)" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
. "$SCRIPT_DIR/singbox-tcp-dns-hotfix/versions.sh"
export SINGBOX_SOURCE_SHA256
PANEL_DIR="$ROOT/panel"
CACHE_DIR="$ROOT/.build-cache"

mkdir -p "$CACHE_DIR" "$OUTDIR_ARG"
OUTDIR=$(CDPATH= cd -- "$OUTDIR_ARG" && pwd)

log() {
  echo "[build-release] $*" >&2
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 去掉 ELF 里的调试信息和符号表。官方 musl Node 带着 debug_info / .symtab 发布,不去掉会让安装包
# 多出约 17MB(未压缩;同一份 Node 去符号后与上游发布包的 node 只差几十字节)。
# 不同架构要用能读该架构 ELF 的 strip:CI(ubuntu x86_64)上 arm64 需要 aarch64-linux-gnu-strip
# (apt 包 binutils-aarch64-linux-gnu,见 release.yml)。CI 里去不掉就直接失败,本地试跑只警告。
strip_elf() {
  _se_file="$1"
  _se_label="$2"
  _se_before=$(wc -c < "$_se_file" | tr -d ' ')
  case "$ARCH" in
    arm64) _se_tools="aarch64-linux-gnu-strip llvm-strip strip" ;;
    *) _se_tools="strip llvm-strip x86_64-linux-gnu-strip" ;;
  esac
  for _se_tool in $_se_tools; do
    command -v "$_se_tool" >/dev/null 2>&1 || continue
    cp "$_se_file" "$_se_file.stripping"
    if "$_se_tool" --strip-unneeded "$_se_file.stripping" >/dev/null 2>&1; then
      _se_after=$(wc -c < "$_se_file.stripping" | tr -d ' ')
      if [ "$_se_after" -lt "$_se_before" ]; then
        mv "$_se_file.stripping" "$_se_file"
        chmod +x "$_se_file"
        log "已去符号 $_se_label ($_se_tool): $_se_before -> $_se_after 字节"
        return 0
      fi
    fi
    rm -f "$_se_file.stripping"
  done
  if [ -n "${CI:-}" ]; then
    echo "ERROR: 无法对 $_se_label 去符号(找不到能处理 $ARCH ELF 的 strip),拒绝发布体积异常的安装包" >&2
    exit 1
  fi
  log "警告: 未能对 $_se_label 去符号,安装包会多出约 17MB(本地试跑可忽略)"
  return 0
}

# 下载前先用 Range 请求探活(比 HEAD 更可靠:GitHub/S3 的预签名下载链接常常只对
# GET 方法签名,HEAD 会被拒绝而 GET 能成功);探活失败或下载失败都直接非零退出,
# 不留半成品。命中本地缓存(.build-cache/)时跳过网络请求,但——无论是缓存命中
# 还是刚下载完——都会校验 sha256;不匹配直接构建失败(供应链完整性,见 Important
# 6):不这样做的话,缓存目录一旦被污染(或者版本号改了但哈希没跟着改)就会被
# 无声无息地打进产物里,谁都不会发现。
fetch_cached() {
  url="$1"
  dest="$2"
  label="$3"
  expected_sha256="$4"

  if [ -s "$dest" ]; then
    log "命中缓存: $label ($(basename -- "$dest"))"
  else
    log "探活: $label"
    if ! curl -fsSL -o /dev/null --range 0-0 "$url"; then
      echo "ERROR: $label 不可达: $url" >&2
      exit 1
    fi

    log "下载: $label"
    tmp="$dest.part"
    rm -f "$tmp"
    if ! curl -fsSL -o "$tmp" "$url"; then
      rm -f "$tmp"
      echo "ERROR: 下载失败: $label ($url)" >&2
      exit 1
    fi
    mv "$tmp" "$dest"
  fi

  actual_sha256=$(sha256_of "$dest")
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    rm -f "$dest"
    echo "ERROR: $label 的 sha256 不匹配,已删除该文件(供应链校验失败,拒绝使用)" >&2
    echo "  URL:  $url" >&2
    echo "  期望: $expected_sha256" >&2
    echo "  实际: $actual_sha256" >&2
    echo "  如果是有意升级版本号,请重新下载并把新的 sha256 写回脚本顶部。" >&2
    exit 1
  fi
}

# ---- 版本号:优先用调用方传入的 OPENBOX_VERSION(CI 里由 tag 提供),
# 本地试跑则退化为 git describe,再退化为固定占位符。----
VERSION="${OPENBOX_VERSION:-}"
if [ -z "$VERSION" ] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  VERSION=$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || true)
fi
[ -z "$VERSION" ] && VERSION="0.0.0-dev"

log "打包 open-box $VERSION,目标 linux-$ARCH(sing-box 架构名: $SINGBOX_ARCH)"

# 内核来源(OPENBOX_KERNEL_SOURCE):
#   upstream(默认)= 取上游 Latest Release 里现成的内核(scripts/fetch-upstream-kernel.sh)。
#                   上游内核带着一批未公开的补丁(直连应答放行、出站热替换等),面板的部分功能依赖它。
#   build         = 从本仓库补丁源码自己编译(scripts/singbox-tcp-dns-hotfix/build.sh),没有那批补丁。
# CI 可传入同一轮已准备好的目录(OPENBOX_KERNEL_BUILD_DIR)以复用,里面须有且仅有本架构的一个内核包。
KERNEL_SOURCE=${OPENBOX_KERNEL_SOURCE:-upstream}
KERNEL_BUILD_DIR=${OPENBOX_KERNEL_BUILD_DIR:-"$CACHE_DIR/kernel-build"}
if [ -z "${OPENBOX_KERNEL_BUILD_DIR:-}" ]; then
  case "$KERNEL_SOURCE" in
    upstream) sh "$SCRIPT_DIR/fetch-upstream-kernel.sh" "$SINGBOX_ARCH" "$KERNEL_BUILD_DIR" ;;
    build) sh "$SCRIPT_DIR/singbox-tcp-dns-hotfix/build.sh" "$SINGBOX_ARCH" "$KERNEL_BUILD_DIR" ;;
    *) echo "ERROR: OPENBOX_KERNEL_SOURCE 只能是 upstream 或 build,收到:$KERNEL_SOURCE" >&2; exit 1 ;;
  esac
fi
KERNEL_BUNDLE=""
_kb_count=0
for _kb in "$KERNEL_BUILD_DIR"/sing-box-*-linux-"$SINGBOX_ARCH"-musl; do
  [ -d "$_kb" ] || continue
  KERNEL_BUNDLE=$_kb
  _kb_count=$((_kb_count + 1))
done
if [ "$_kb_count" -ne 1 ]; then
  echo "ERROR: $KERNEL_BUILD_DIR 里应有且仅有一个 linux-$SINGBOX_ARCH 内核包,实际 $_kb_count 个" >&2
  exit 1
fi
# meta.json 里的 singboxVersion 以内核包自己记录的版本为准(上游版本变了,这里自动跟着变)
SINGBOX_VERSION=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$KERNEL_BUNDLE/BUILD-INFO.json")
[ -n "$SINGBOX_VERSION" ] || { echo "ERROR: 读不到内核版本" >&2; exit 1; }
if python3 -c 'import json,sys;sys.exit(0 if "build_inputs" in json.load(open(sys.argv[1])) else 1)' "$KERNEL_BUNDLE/BUILD-INFO.json"; then
  # 本仓库自己编译的内核:补丁/构建脚本的哈希必须与当前检出一致
  python3 "$SCRIPT_DIR/singbox-tcp-dns-hotfix/manifest.py" verify "$KERNEL_BUNDLE" "$SINGBOX_ARCH" "$SINGBOX_VERSION"
else
  # 上游内核:二进制哈希、架构、版本要与它自带的 BUILD-INFO 记录一致(下载时已核对过发布清单)
  python3 - "$KERNEL_BUNDLE" "$SINGBOX_ARCH" "$SINGBOX_VERSION" <<'PY'
import hashlib, json, sys
from pathlib import Path
bundle, arch, version = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
info = json.loads((bundle / 'BUILD-INFO.json').read_text())
assert info['version'] == version and info['arch'] == arch, 'Kernel version/architecture mismatch'
assert info['binary_sha256'] == hashlib.sha256((bundle / 'sing-box').read_bytes()).hexdigest(), 'Kernel binary checksum mismatch'
assert (bundle / 'LICENSE').is_file(), 'Missing kernel license'
print(f'Verified upstream kernel: {version} {arch} {info["binary_sha256"]}')
PY
fi
log "内核:$SINGBOX_VERSION(来源 $KERNEL_SOURCE)"

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/open-box-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT INT TERM

mkdir -p "$STAGE/node/lib" "$STAGE/panel" "$STAGE/bin" "$STAGE/openwrt"

# ---- 1. 构建前端 ----
log "使用仓库里的面板前端 dist(取自上游,不自己编译)..."
[ -f "$PANEL_DIR/dist/index.html" ] || { echo "ERROR: $PANEL_DIR/dist/index.html 不存在,请先运行 Sync upstream" >&2; exit 1; }
cp -R "$PANEL_DIR/dist" "$STAGE/panel/dist"

# ---- 2. pnpm deploy 出自包含 server ----
log "打包面板后端 (pnpm deploy --prod)..."
(cd "$PANEL_DIR" && corepack pnpm --filter=./server deploy --prod "$STAGE/panel/server")

# arm64:仓库里的 panel/server/native 是上游 x64 应用包的(amd64)。arm64 包必须换成 arm64 的原生内核,
# 并把 hardening-manifest.json 里的 core 和 native 两个文件的 sha256 同步改掉(Docker 构建和上游校验都按它核对)。
# arm64 内核由 Sync upstream 从上游 arm64 应用包取来放在 scripts/native-arm64/。
if [ "$ARCH" = arm64 ]; then
  NATIVE_ARM64="$ROOT/scripts/native-arm64"
  [ -f "$NATIVE_ARM64/openbox-core" ] && [ -f "$NATIVE_ARM64/core-build.json" ] \
    || { echo "ERROR: $NATIVE_ARM64 里没有 arm64 原生内核,请先运行 Sync upstream" >&2; exit 1; }
  log "换入 arm64 原生内核..."
  python3 - "$STAGE/panel/server" "$NATIVE_ARM64" <<'PYARM'
import hashlib, json, shutil, sys
from pathlib import Path
server = Path(sys.argv[1]); src = Path(sys.argv[2])
core = json.loads((src / 'core-build.json').read_text())
if core.get('os') != 'linux' or core.get('arch') != 'arm64':
    raise SystemExit('scripts/native-arm64 里的原生内核不是 linux/arm64: ' + json.dumps(core))
native = server / 'native'
shutil.copyfile(src / 'openbox-core', native / 'openbox-core')
(native / 'openbox-core').chmod(0o755)
shutil.copyfile(src / 'core-build.json', native / 'core-build.json')
mp = server / 'hardening-manifest.json'
m = json.loads(mp.read_text())
m['core'] = core
for name in ('native/openbox-core', 'native/core-build.json'):
    m['files'][name] = hashlib.sha256((server / name).read_bytes()).hexdigest()
mp.write_text(json.dumps(m, indent=2, ensure_ascii=False) + '\n')
print('arm64 原生内核已换入,buildID', core.get('buildID'))
PYARM
fi

# 全量 Geo 快照在构建机准备，双架构 CI 使用同一份提交；设备不访问上游。
GEO_BUNDLE="${OPENBOX_GEO_BUNDLE_DIR:-$CACHE_DIR/geodata}"
if [ -z "${OPENBOX_GEO_BUNDLE_DIR:-}" ]; then
  python3 "$SCRIPT_DIR/bundle-geodata.py" "$GEO_BUNDLE"
fi
python3 "$SCRIPT_DIR/bundle-geodata.py" --verify "$GEO_BUNDLE"
mkdir -p "$STAGE/panel/server/resources"
# pnpm deploy 可能已带上本地开发数据，必须用本次核验过的快照替换。
rm -rf "$STAGE/panel/server/resources/geodata"
cp -R "$GEO_BUNDLE" "$STAGE/panel/server/resources/geodata"
python3 "$SCRIPT_DIR/check-geodata.py" "$STAGE/panel/server/resources/geodata" "${OPENBOX_GEO_CHECK_BINARY:-$PANEL_DIR/.tools/sing-box}" "$SINGBOX_VERSION"

# ---- 3. 下载并解出 musl Node ----
NODE_TARBALL="node-v${NODE_VERSION}-linux-${ARCH}-musl.tar.xz"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_CACHE="$CACHE_DIR/$NODE_TARBALL"
fetch_cached "$NODE_URL" "$NODE_CACHE" "musl Node $NODE_VERSION ($ARCH)" "$NODE_SHA256"

log "解出 Node 运行时..."
NODE_EXTRACT_DIR="$STAGE/.node-extract"
mkdir -p "$NODE_EXTRACT_DIR"
tar -xJf "$NODE_CACHE" -C "$NODE_EXTRACT_DIR"
NODE_INNER_DIR="$NODE_EXTRACT_DIR/node-v${NODE_VERSION}-linux-${ARCH}-musl"
if [ ! -f "$NODE_INNER_DIR/bin/node" ]; then
  echo "ERROR: Node tarball 内部布局与预期不符,找不到 $NODE_INNER_DIR/bin/node" >&2
  exit 1
fi
# 只留运行 `node server/index.mjs` 真正要用到的东西:bin/node 本身 + LICENSE。
# include/(native addon 头文件)、lib/node_modules/{npm,corepack}、share/(man 页)
# 路由器上用不到,却占掉 include+lib 近 80MB——路由器 flash 紧张,不值得白白带上。
mkdir -p "$STAGE/node/bin"
cp "$NODE_INNER_DIR/bin/node" "$STAGE/node/bin/node"
chmod +x "$STAGE/node/bin/node"
strip_elf "$STAGE/node/bin/node" "node ($ARCH)"
cp "$NODE_INNER_DIR/LICENSE" "$STAGE/node/LICENSE"
rm -rf "$NODE_EXTRACT_DIR"

# ---- 4. 下载并解出 Alpine 的 musl 版 libstdc++ / libgcc(Critical 1)----
# apk 包本质是 gzip 的 tar,直接 tar -xzf 就能取出 usr/lib/ 下的 .so;不解 .PKGINFO
# 也不装 apk 工具本身。两个架构都拿,即使 arm64 当前用不上也保持产物结构一致。
ALPINE_LIBSTDCPP_PKG="libstdc++-${ALPINE_GCC_PKG_VERSION}.apk"
ALPINE_LIBGCC_PKG="libgcc-${ALPINE_GCC_PKG_VERSION}.apk"
ALPINE_BASE_URL="https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/${ALPINE_ARCH}"
ALPINE_LIBSTDCPP_CACHE="$CACHE_DIR/alpine-${ALPINE_ARCH}-${ALPINE_LIBSTDCPP_PKG}"
ALPINE_LIBGCC_CACHE="$CACHE_DIR/alpine-${ALPINE_ARCH}-${ALPINE_LIBGCC_PKG}"
fetch_cached "$ALPINE_BASE_URL/$ALPINE_LIBSTDCPP_PKG" "$ALPINE_LIBSTDCPP_CACHE" \
  "Alpine musl libstdc++ $ALPINE_GCC_PKG_VERSION ($ALPINE_ARCH)" "$ALPINE_LIBSTDCPP_SHA256"
fetch_cached "$ALPINE_BASE_URL/$ALPINE_LIBGCC_PKG" "$ALPINE_LIBGCC_CACHE" \
  "Alpine musl libgcc $ALPINE_GCC_PKG_VERSION ($ALPINE_ARCH)" "$ALPINE_LIBGCC_SHA256"

log "解出 Alpine musl libstdc++ / libgcc..."
ALPINE_EXTRACT_DIR="$STAGE/.alpine-extract"
mkdir -p "$ALPINE_EXTRACT_DIR"
tar -xzf "$ALPINE_LIBSTDCPP_CACHE" -C "$ALPINE_EXTRACT_DIR" usr/lib/
tar -xzf "$ALPINE_LIBGCC_CACHE" -C "$ALPINE_EXTRACT_DIR" usr/lib/
if [ ! -e "$ALPINE_EXTRACT_DIR/usr/lib/libstdc++.so.6" ] || [ ! -e "$ALPINE_EXTRACT_DIR/usr/lib/libgcc_s.so.1" ]; then
  echo "ERROR: Alpine apk 包内部布局与预期不符,找不到 libstdc++.so.6 / libgcc_s.so.1" >&2
  exit 1
fi
# -P 保留符号链接本身(libstdc++.so.6 -> libstdc++.so.6.0.x),不展开成两份拷贝。
cp -P "$ALPINE_EXTRACT_DIR"/usr/lib/libstdc++.so.6* "$STAGE/node/lib/"
cp -P "$ALPINE_EXTRACT_DIR"/usr/lib/libgcc_s.so.1* "$STAGE/node/lib/"
rm -rf "$ALPINE_EXTRACT_DIR"

# ---- 5. 构建期依赖守卫(Critical 1):解析 node 二进制真实的 DT_NEEDED,任何一条
# 既没被捆绑进 node/lib/、又不属于 OpenWrt 默认可用集的依赖都直接构建失败。允许集:
#   - node/lib/ 里已捆绑的文件名(见上一步)
#   - libc.musl-*(Alpine/OpenWrt 风格 soname)与字面量 libc.so(musl 动态链接器把
#     libc./libpthread./librt./libm./libdl./libutil./libxnet. 开头的 NEEDED 名字
#     都当保留名直接自解析,不做文件查找——已用 musl 官方源码交叉验证,见文件头注释)
#   - libgcc_s.so.1(OpenWrt DEFAULT_PACKAGES 自带 libgcc)
log "校验 node 的 DT_NEEDED(构建期依赖守卫)..."
NODE_NEEDED=$(python3 "$SCRIPT_DIR/dt-needed.py" "$STAGE/node/bin/node") || {
  echo "ERROR: 无法解析 $STAGE/node/bin/node 的 DT_NEEDED" >&2
  exit 1
}
BAD_NEEDED=""
OLD_IFS=$IFS
IFS='
'
set -f  # 逐行取 NEEDED 名字,禁掉通配展开,避免万一某个库名里出现 */? 之类字符被误展开
for lib in $NODE_NEEDED; do
  case "$lib" in
    libc.musl-*|libc.so|libgcc_s.so.1) ;;
    *)
      if [ ! -e "$STAGE/node/lib/$lib" ]; then
        BAD_NEEDED="$BAD_NEEDED $lib"
      fi
      ;;
  esac
done
set +f
IFS="$OLD_IFS"
if [ -n "$BAD_NEEDED" ]; then
  echo "ERROR: node($ARCH) 的以下 DT_NEEDED 依赖既未捆绑进 node/lib/,又不属于 OpenWrt 默认可用集:$BAD_NEEDED" >&2
  echo "  上游 Node 构建可能新增了动态依赖。请在 node/lib/ 里补上对应的 musl 动态库," >&2
  echo "  或者(如果确认该库属于系统默认可用集)更新本脚本里的允许名单。" >&2
  exit 1
fi
log "DT_NEEDED 校验通过($ARCH): $(printf '%s' "$NODE_NEEDED" | tr '\n' ' ')"

# ---- 6. 封装内核 ----
log "封装 sing-box $SINGBOX_VERSION..."
cp "$KERNEL_BUNDLE/sing-box" "$STAGE/bin/sing-box"
chmod +x "$STAGE/bin/sing-box"
cp "$KERNEL_BUNDLE/LICENSE" "$STAGE/bin/sing-box.LICENSE"
cp "$KERNEL_BUNDLE/BUILD-INFO.json" "$STAGE/bin/sing-box.BUILD-INFO.json"

# ---- 7. 构建期依赖守卫(P6 复审 Minor):确认 sing-box 二进制真正静态链接。
# 对封装后的二进制再检查一次,确认拷入的就是完整静态构建。dt-needed.py 解析 ELF 程序头,这里
# 复用同一份解析逻辑断言:既没有 PT_INTERP(没有指定动态链接器路径),也没有
# PT_DYNAMIC(没有动态段/DT_NEEDED 列表)——两者皆无才是真正的静态二进制。任何一个
# 存在都直接构建失败,而不是打进产物里到用户路由器上才发现起不来。
log "校验 sing-box 静态链接(构建期依赖守卫)..."
python3 "$SCRIPT_DIR/dt-needed.py" --assert-static "$STAGE/bin/sing-box" || {
  echo "ERROR: sing-box($ARCH) 不是纯静态链接(存在 PT_INTERP 或 PT_DYNAMIC 段)。" >&2
  echo "  请检查当前内核构建工具链,不能用动态链接或精简内核替代。" >&2
  exit 1
}
log "sing-box 静态链接校验通过($ARCH)。"

# ---- 8. 拷 openwrt/(initd 与 luci)----
log "拷贝 openwrt/ init 与 LuCI 文件..."
cp -R "$ROOT/openwrt/initd" "$STAGE/openwrt/initd"
cp -R "$ROOT/openwrt/luci" "$STAGE/openwrt/luci"
# 命令行 open-box 和随包 Node 的启动包装(install.sh / update.sh 会把它们铺到系统里)
cp -R "$ROOT/openwrt/bin" "$STAGE/openwrt/bin"
chmod +x "$STAGE/openwrt/bin/open-box" "$STAGE/openwrt/bin/compat/node"
# 缺 madvise 系统调用的固件用的兼容库,随内核一起从上游取回(没有就算了,只影响那类固件)
if ls "$KERNEL_BUILD_DIR"/compat/libobmadvise-*.so >/dev/null 2>&1; then
  cp "$KERNEL_BUILD_DIR"/compat/libobmadvise-*.so "$STAGE/openwrt/bin/compat/"
else
  log "警告: 没有 libobmadvise-*.so 兼容库,缺 madvise 的固件将无法运行随包 Node"
fi

# ---- 8a. Debian / Ubuntu 的 systemd 单元与包装脚本 ----
log "拷贝 debian/ ..."
cp -R "$ROOT/debian" "$STAGE/debian"
chmod +x "$STAGE/debian/bin/"* "$STAGE/debian/shim/"*

# ---- 8b. 卸载脚本 ----
# 随产物一起铺到 /opt/open-box/uninstall.sh:LuCI 兜底页要能在「面板已经坏了、
# 也可能没有外网」的情况下调起卸载,所以不能只依赖从 GitHub 现下。
log "拷贝 uninstall.sh..."
cp "$ROOT/scripts/uninstall.sh" "$STAGE/uninstall.sh"
chmod +x "$STAGE/uninstall.sh"

# ---- 8c. 升级脚本 ----
# 同理随产物铺到 /opt/open-box/update.sh:LuCI 兜底页的一键升级只能 exec 本地
# 文件,不能到 GitHub 上现下一份脚本再跑。install.sh 解包整个 tarball 到
# $INSTALL_ROOT,这份文件会跟着自动落地,不需要 install.sh 另外处理。
log "拷贝 update.sh..."
cp "$ROOT/scripts/update.sh" "$STAGE/update.sh"
chmod +x "$STAGE/update.sh"

# ---- 9. meta.json ----
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$STAGE/meta.json" <<EOF
{
  "version": "$VERSION",
  "singboxVersion": "$SINGBOX_VERSION",
  "nodeVersion": "$NODE_VERSION",
  "arch": "$ARCH",
  "builtAt": "$BUILT_AT"
}
EOF

# 生成独立更新组件与清单，并补全 meta.json 中的 Geo 版本；完整安装包仍带齐全部组件。
python3 "$SCRIPT_DIR/release-components.py" "$STAGE" "$OUTDIR"

# ---- 10. 打包:带版本号的资产(留档)+ 不带版本号的稳定资产名(install.sh /
# update.sh 依赖它,见 Important 5——两者内容完全一致,只是文件名不同,避免
# install/update 依赖 GitHub API 查询最新版本号)----
VERSIONED_NAME="open-box-${VERSION}-linux-${ARCH}.tar.gz"
STABLE_NAME="open-box-linux-${ARCH}.tar.gz"
VERSIONED_PATH="$OUTDIR/$VERSIONED_NAME"
STABLE_PATH="$OUTDIR/$STABLE_NAME"
log "打包 $VERSIONED_NAME..."
# macOS 上的 bsdtar 会把扩展属性(com.apple.provenance 等)写成 PAX 头,路由器上的 tar
# 每解一个文件就报一句 "Ignoring unknown extended header keyword",无害但满屏都是。
# COPYFILE_DISABLE 只能挡 ._ 文件,挡不住这种头,要显式关掉 xattr / mac metadata。
TAR_NO_XATTR=""
if tar --version 2>/dev/null | grep -qi bsdtar; then
  TAR_NO_XATTR="--no-xattrs --no-mac-metadata"
elif tar --version 2>/dev/null | grep -qi "gnu tar"; then
  TAR_NO_XATTR="--no-xattrs"
fi
(cd "$STAGE" && tar $TAR_NO_XATTR -czf "$VERSIONED_PATH" node panel bin openwrt debian meta.json uninstall.sh update.sh)
cp "$VERSIONED_PATH" "$STABLE_PATH"

# ---- 11. sha256(分别对两个文件名各算一份,sha256sum -c 依赖文件名匹配)----
log "计算 sha256..."
(
  cd "$OUTDIR"
  for name in "$VERSIONED_NAME" "$STABLE_NAME"; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$name" > "$name.sha256"
    else
      shasum -a 256 "$name" > "$name.sha256"
    fi
  done
)

log "完成: $VERSIONED_PATH"
log "$(cat "$VERSIONED_PATH.sha256")"
log "稳定资产名: $STABLE_PATH"
log "$(cat "$STABLE_PATH.sha256")"
