# dsh-tailscale-connect

让 **Tailscale tailnet 里的设备**打开这台机器上的 DeepSeek Harness Web GUI，并让 **DSH 的手机远程控制**（`@linxin666/dsh-remote-bridge` 的 `/ios/v1` 协议 + 配对二维码）在 tailnet 上可用。

插件只做四件事：

1. **tailnet-only 入口**（默认 `proxy` 模式）—— 保持 DSH 的 Web 服务绑定在 `127.0.0.1`，插件自己在 Tailscale 网卡地址（`100.64.0.0/10`）上再开一个监听，把 HTTP 与 WebSocket upgrade 反代到回环端口。局域网接口完全不开。
2. **放行 `/api` 信任围栏** —— 把远端实际使用的 `host:port` 运行时加进 `connection.trustedHosts`，否则浏览器能打开页面但所有 RPC 都 403。
3. **发布手机配对 origin** —— 把 tailnet 上的地址写进 `DSH_REMOTE_PUBLIC_BASE_URL`，`dsh-remote-bridge` 生成二维码时会优先使用它，手机扫一次就能拨号；不发布时二维码只剩裸 token。
4. **可选的 `tailscale serve` 模式** —— 想在 MagicDNS 名字上不带端口、或需要 `https://` / `wss://`（手机 App 的传输安全策略可能拒绝明文 WebSocket）时，由插件配置并校验 Serve 路由，退出时只撤销自己占用的那个端口。

## 模式

| 模式 | 监听 | 局域网 | 需要 HTTPS 证书 | 适用 |
|---|---|---|---|---|
| `proxy`（默认） | `100.x.y.z:<port>`，反代到 `127.0.0.1:<DSH 端口>` | 不暴露 | 否 | 绝大多数情况；URL 形如 `http://dsh-host.tailnet-example.ts.net:3080` |
| `serve` | 仍是 `127.0.0.1`，由 `tailscale serve` 发布 | 不暴露 | 可选（`serveSecure: true` 时需要 tailnet 已启用 HTTPS） | 想用不带端口的 MagicDNS 名，或要 `https://` / `wss://` |
| `direct`（旧名） | — | — | — | 已不可用：DSH 0.2.x 拒绝 `0.0.0.0` 绑定；插件会告警并回落到 `proxy` |

## 安全模型

- `proxy` / `serve` 模式下 DSH 自身仍只监听回环；tailnet 设备是本机之外唯一能到达入口的网络。
- `proxy` 在 socket 层再做一次来源校验：只接受 Tailscale CGNAT / ULA 地址与回环，其余一律 403。
- `/api` 仍然需要 DSH 的进程令牌（启动时打印的带 `?token=` 链接）换来的签名 Cookie；仅仅知道地址并不能调用 RPC。
- 手机配对令牌（`/remote-bridge/pair/token`）依旧只在回环可铸造；tailnet 客户端只能拨已经拿到的一次性票据，不能自己 mint。
- 真正的访问控制边界仍然是 **Tailscale ACL**：建议在 tailnet policy 里只允许你自己的设备访问这台机器的目标端口。

## 安装

插件是一个标准 DSH bundle（`dsh.bundle.patch`），安装后需要重启 `dsh web`：

```sh
# 直接从 GitHub
dsh plugin --profile web add github:Shirakawa-Kotone/dsh-tailscale-connect

# 或从本地 checkout
dsh plugin --profile web add link:~/dev/DSH-Plugins/DSH-tailscale
```

npm 包名为 `dsh-tailscale-connect`；仓库内的 `.github/workflows/publish.yml` 会在 GitHub Release 发布时用 `NPM_TOKEN` secret 自动发布，维护者添加一次 secret 即可。

首次启动后看日志里有没有：

```
dsh tailscale: mode=proxy host=dsh-host.tailnet-example.ts.net ipv4=100.64.0.1
dsh tailscale: tailnet listener on 100.64.0.1:3080 -> http://127.0.0.1:3080
dsh tailscale: open http://dsh-host.tailnet-example.ts.net:3080/?token=...
dsh tailscale: pairing origin published: DSH_REMOTE_PUBLIC_BASE_URL=http://dsh-host.tailnet-example.ts.net:3080
```

把最后那条 `open` 链接发到 tailnet 里的设备上打开即可（链接里的 token 是进程级的一次性登录令牌；打开一次后种下 30 天 Cookie）。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `tailscale-access` 行的 config（整段替换，所以要把想保留的键一起写上）：

```yaml
- id: tailscale-access
  config:
    mode: proxy
    port: 0                    # 0 = 复用 DSH 端口；也可以指定 8443 等
    bindAddress: ''            # '' = 自动选第一块 Tailscale IPv4
    hostName: ''               # '' = 用 tailscale status 的 MagicDNS 名
    tailnet: ''                # CLI 不可用时的 MagicDNS 后缀兜底
    extraTrustedHosts: []      # 额外放行给 /api 围栏的 host[:port]
    servePort: 80              # serve 模式专用
    servePath: ''              # 必须是根路径才能发布配对 origin
    serveSecure: false         # true = Serve 用 HTTPS（wss 可用）
    overwriteServe: false      # true = 允许替换别的服务的 Serve 路由
    publishPairOrigin: true
    printUrl: true
    verify: true               # 启动后自检一次 URL
    watch: true                # 每 60s 重新发现 tailnet 地址
    binaryPath: ''             # 显式 tailscale 可执行文件
    shortlink: true            # 固定短链 /t/<code>，tailnet 设备可收藏
    shortlinkPath: '/t'
    accessCode: ''             # 留空 = 自动生成并持久化；也可写死 6–64 位
    accessCodeFile: ''         # 默认 $DSH_HOME/tailscale-access.json（0600）
    accessCodeLength: 10
    rotateAccessCode: false    # true = 每次启动换一个 code
```

## 手机远程控制（配对）

前提：profile 里已启用 `web-ui-remote-bridge`（`@linxin666/dsh-remote-bridge`）。插件本身不改 bridge 的代码，只通过环境变量告诉它手机该拨哪个 origin。

- `proxy` 模式：发布 `http://<MagicDNS>:<DSH 端口>`，二维码里的 dial URL 是 `ws://<MagicDNS>:<端口>/ios/v1?token=...`。
- `serve` 模式（`servePath: ''`）：发布 `http://<MagicDNS>`（`serveSecure: true` 时是 `https://...`，二维码变 `wss://`）。
- 环境里**已经**有 `DSH_REMOTE_PUBLIC_BASE_URL` 时插件不覆盖；显式配置优先。
- `servePath` 非根路径时不发布：`dsh-remote-bridge` 只保留 URL 的 origin，前缀会被丢掉，手机就会去拨一个不服务 `/ios/v1` 的地址。

如果 iOS App 拒绝明文 `ws://`（ATS），把模式改成：

```yaml
- id: tailscale-access
  config:
    mode: serve
    servePort: 8443
    servePath: ''
    serveSecure: true
```

得到 `wss://<MagicDNS>:8443/ios/v1`。`serveSecure` 要求 tailnet 已在 Tailscale 管理台启用 HTTPS 证书。

## 固定短链（给 tailnet 设备收藏）

DSH 的启动链接带一次性进程 token，每次重启都会变，不适合收藏。插件提供一个**固定短链**：

```
http://dsh-host.tailnet-example.ts.net:3080/t/<code>
```

打开后：

1. 插件校验短码；
2. 302 到**当前进程**的带 token 的 DSH 地址；
3. DSH 正常种下 30 天 Cookie 并跳回干净地址。

所以短链本身永远不变，token 每次重启自动更新。短码首次启动时生成，写入
`$DSH_HOME/tailscale-access.json`（权限 `0600`），之后每次启动复用；日志里会打印：

```
dsh tailscale: fixed link http://dsh-host.tailnet-example.ts.net:3080/t/<code>
```

规则与安全：

- 短链 = 浏览器登录凭据，**拿到即等于拿到这台机器的 owner 权限**。只发给自己的设备，不要贴到公开地方。
- 重定向目标只允许本次发布的 tailnet 地址 / 回环地址；伪造 `Host` 不会把进程 token 重定向到外部域名。
- 短码用常量时间比较；错误码返回 404，同一来源每分钟错误超过 30 次返回 429。
- 状态端点 `/dsh-tailscale/status` 只显示 `shortlink.enabled/path/file`，不返回短码。
- 轮换：删掉 `$DSH_HOME/tailscale-access.json` 后重启；或配置一个固定的 `accessCode`；或临时设 `rotateAccessCode: true` 启动一次再改回。
- 想关闭：`shortlink: false`。已有 Cookie 的设备不受影响。

## 自检与排障

- 状态端点：`curl -s http://127.0.0.1:3080/dsh-tailscale/status`，返回当前 mode / urls / pairOrigin / proxy / serve 状态。tailnet 设备同样能访问这个只读端点。
- `tailscale serve status --json` 查看 Serve 路由；插件只认领自己创建或本来就精确指向本 DSH 端口的根路由。
- 页面能开但 RPC 403：说明 `connection.trustedHosts` 里没有远端 authority。看日志有没有 `connection service is not available`；确认 `@deepseek-ai/dsh-client-connection` 是启用的。
- `proxy` 模式报 `no Tailscale IPv4 address found`：先 `tailscale status` 确认在网；插件每 15s 重试一次。
- 端口被占用：`proxy` 默认复用 DSH 端口（不同 IP 可以同端口）；若仍报 `EADDRINUSE`，把 `port` 改成 8443 等。
- `serve` 模式报冲突：说明该端口上已有别的服务路由，插件默认不覆盖。换 `servePort`、改用 `proxy`，或明确设 `overwriteServe: true`。
- 退出清理：`proxy` 随插件关闭而关闭；`serve` 会执行 `tailscale serve --http=<port> off`（`serveSecure` 时 `--https`），只撤销自己那个端口，不会 `reset` 掉其它服务。

## 工作原理（实现要点）

- bundle patch **不覆盖**核心 `webserver` 行：两种模式都让 DSH 保持默认的回环绑定，插件只插入自己的运行时行。这样即使禁用本插件，也不会让 web 插件树因为缺少 `tailscaleAccess` 而 pending。
- 运行时插件只 `ctx.provide('tailscaleAccess', …)` 提供事实（`bindHost`、`trustedHosts`、URL、状态），不注入 `webServer`，避免依赖环。
- 异步部分放在 `ctx.inject(['webServer', 'connection'], …)` 里，等 `webServer.port` 真正绑定后再开监听；`ctx.effect` 负责退出清理。
- 反代保留客户端原始 `Host`（`tailscale serve` 也是这个行为），只追加 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`；WebSocket 的 `Sec-WebSocket-*` 原样透传。
- 纯函数（发现、URL 规划、Serve 分类、配对发布）与网络部分分离，`node --test` 覆盖 69 个用例。

## 版本

- **0.3.0** — 发布名改为 `dsh-tailscale-connect`（`dsh-tailscale-access` 在 npm 上已被占用）；新增固定短链 `mode 无关`：`/t/<code>` 302 到当前进程 token 链接，短码持久化在 `$DSH_HOME/tailscale-access.json`（0600）；支持显式 `accessCode`、自定义路径/长度、轮换与错误限速；重定向只走本次发布地址，防 Host 伪造 token 外泄。
- **0.2.0** — 新 `proxy` 模式（tailnet-only 反代，默认）；修正 `/api` 围栏（之前补丁打在 `web-runtime` 上，`trustedHosts` 实际未生效）；`connection.trustedHosts` 运行时注入；`serve` 模式改为先读状态、拒绝覆盖冲突路由、退出时单端口撤销；新增自检、状态端点、`serveSecure` / `overwriteServe` / `watch` 配置；测试补齐。
- **0.1.2** — 基线：`direct` / `serve` 两模式、MagicDNS 发现、`DSH_REMOTE_PUBLIC_BASE_URL` 发布。`direct` 在 DSH 0.2.x 已不可用（webserver 拒绝通配地址），0.2.0 起作为 `proxy` 的别名并告警。

## 兼容

- DSH `>= 0.2.2-rc.1`（`dsh-host-webserver` 的 `register` / `registerUpgrade` 与 `dsh-client-connection` 的 `trustedHosts` 是稳定契约）。
- Node `>= 24.9.0`。
- macOS / Linux；Windows 也能工作，`tailscale` 路径会探测常见安装位置。

## License

MIT。仓库：<https://github.com/Shirakawa-Kotone/dsh-tailscale-connect>
