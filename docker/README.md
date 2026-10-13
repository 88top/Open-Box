# Open-Box Docker 旁路由

在 Linux Docker Engine 上运行，与 OpenWrt / Debian 版使用同一套面板、客户端引擎和 tcp23 内核。
容器通过 macvlan 或 ipvlan L2 获得独立局域网 IP。终端的 IPv4 网关和 DNS 指向容器后，由容器执行分流。
v0.1.323 提供 x64 和 arm64 镜像下载包，包含与同版本路由器包一致的 Go 原生配置/分流核心。镜像通过 GitHub Release 分发，下载后使用 `docker load` 加载。

Open-Box 自有程序按闭源专有软件分发，未经许可禁止复制传播、再分发、反编译及绕过授权。用户正常安装、离线使用、升级、备份和恢复不受影响；第三方开源组件继续按原许可授权。详见 [LICENSE](../LICENSE) 和 [版权范围](../COPYRIGHT.md)。

## 下载镜像

从 [v0.1.323 Release](https://github.com/timeflysoon/Open-Box/releases/tag/v0.1.323) 下载宿主对应架构的镜像和 SHA256 文件：

- x86_64 / amd64：`open-box-v0.1.323-docker-linux-x64.tar.gz`
- aarch64 / arm64：`open-box-v0.1.323-docker-linux-arm64.tar.gz`

```sh
# x64 示例；arm64 替换文件名中的 x64。
sha256sum -c open-box-v0.1.323-docker-linux-x64.tar.gz.sha256
docker load -i open-box-v0.1.323-docker-linux-x64.tar.gz
```

两种镜像均加载为 `open-box:0.1.323`；请按 Docker 宿主架构选择下载文件。
同时下载 `open-box-v0.1.323-docker-compose.tar.gz`，解包后填写 `.env`。

## 本地构建

构建机先生成同架构完整发布包，再用以下脚本封装。脚本校验安装包 SHA256、架构和 Go 核心完整性：

```sh
sh scripts/build-docker.sh x64 .build-cache/releases/v0.1.323 open-box:0.1.323
sh scripts/build-docker.sh arm64 .build-cache/releases/v0.1.323 open-box:0.1.323
```

可设置 `DOCKER_HOST=ssh://openbox-docker21` 在远程 Docker 测试机上构建。设备运行时不需要 Go 编译器或云端授权验证。

## 部署

复制本目录的 `compose.yaml` 和 `.env.example` 到宿主上的独立目录，将 `.env.example` 改名为 `.env`。
修改网卡、网段、主路由地址和容器地址。容器地址必须未占用且在 DHCP 分配池之外。

```sh
docker compose config
docker compose up -d
docker compose logs -f
```

从另一台局域网设备访问 `http://<容器IP>:2026`。查看面板密码：

```sh
docker compose exec open-box open-box password
```

在面板添加节点/订阅并启动内核。先让一台测试终端把 IPv4 网关及 DNS 改为容器 IP；
确认分流正确后，再决定是否通过主路由 DHCP 对其他终端下发这个地址。

`./etc` 保存运行配置和证书，`./data` 保存数据库、节点/订阅、规则集、统计和内核自启选择。
停止内核会关闭内核自启；启动成功后开启自启，重新创建容器仍保留。
面板和内核退出后由容器内监督进程恢复，Docker 管理整个容器的重启。

## 升级

下载并校验新版镜像，使用 `docker load` 加载后，将 `.env` 的 `OPENBOX_IMAGE` 改为对应版本，保持两份卷并重建容器：

```sh
docker compose up -d --force-recreate
```

恢复旧版本时，加载旧镜像并改回 `OPENBOX_IMAGE`，保留相同的 `./etc` 与 `./data`。本地构建镜像也通过重新构建和重建容器更新。
容器平台禁止面板内运行路由器升级脚本和自动换包，Geo 继续随镜像统一更新。

## 网络与限制

- 使用 macvlan 或 ipvlan L2；不支持 host 网络、Docker Desktop 或 rootless Docker。
  不需要 `privileged`、宿主网络挂载或 Docker socket；只添加 NET_ADMIN / NET_RAW 并映射 `/dev/net/tun`。
- 192.168.3.21 的虚拟机环境已发现 macvlan 无法接通 LAN，测试采用 ipvlan L2。
  虚拟机/交换机不允许额外 MAC 时，可在 `.env` 中设置 `OPENBOX_NETWORK_DRIVER=ipvlan`。
- 宿主通常不能直接访问自己的 macvlan / ipvlan 子接口，请从其他 LAN 设备打开面板。
  宿主可用 `docker compose exec open-box curl http://127.0.0.1:2026/api/health` 检查。
- Compose 开启 IPv4 转发，关闭 ICMP 重定向，避免同网卡进出的流量绕过旁路由。
  `OPENBOX_MASQUERADE=1` 默认对同网卡转发做 NAT；设置为 `0` 后重建容器可关闭。
- 容器 DNS 监听 TCP/UDP 53，同时保留 7853；使用纯 tun 或关闭 DNS 劫持时，主动发到容器 53 的查询仍正常解析。
- 停用内核也会停止容器的 DNS 服务。需要恢复普通网络时，把终端的网关和 DNS 指回主路由；不要在内核停止时继续让终端使用容器 DNS。
- 第一版只接管 IPv4。IPv6 默认经主路由，不会经过此容器；需要全流量接管时应由用户在主路由/终端停用 IPv6。
- 时区由 `TZ` 设置；无 dnsmasq / DHCP 接管 / LuCI / 主机时区修改 / 内置模拟 LAN 终端。
- 面板自检显示 TUN、NET_ADMIN、转发、重定向、nftables、实际截流方式和 NAT 状态。
  老 NAS 的内核和 nftables 能力尚未实机验证，不能据当前通用 Linux 测试推定全部可用。

## 当前验收范围（2026-10-13）

amd64 已在 x86_64 Linux Docker 测试机完成面板、旁路由、FakeIP、代理/直连、纯 tun、NAT 开关、异常恢复及换镜像保留配置验收，并在局域网 ipvlan L2 环境验收。
arm64 已在原生 ARM64 Linux 虚拟机的 Docker 容器中完成相同的 TUN、分流、FakeIP、NAT 开关、异常恢复及重建保留配置验收，未使用 QEMU 跨架构模拟。这证明当前镜像在该 ARM64 Linux 环境可正常转发，具体 ARM NAS 的网络驱动及内核仍需按宿主条件检查。

网络驱动行为参照 [Docker macvlan 文档](https://docs.docker.com/engine/network/drivers/macvlan/) 和
[Docker ipvlan 文档](https://docs.docker.com/engine/network/drivers/ipvlan/)。
内核对应的可重现源码及补丁见 `scripts/singbox-tcp-dns-hotfix/`，与同版本 Release 的内核源码附件一致。
