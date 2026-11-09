# Security · 安全

## Reporting a vulnerability · 报告漏洞

Please report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability. You will get a reply as soon as possible.

请通过 GitHub 私下报告安全问题：打开仓库的 **Security** 页，选择 **Report a vulnerability**。请不要为漏洞开公开的 issue，我们会尽快回复。

## Scope · 范围

- Supported: the latest version on the `main` branch. · 支持范围：`main` 分支上的最新版本。
- **By design, the demo has no real sign-in:** you pick an identity from the roster, and the in-browser demo keeps all data in your own browser. A production deployment needs real authentication, roles and session expiry (see [docs/08](docs/08-live-operations.md) §7); missing sign-in in the demo is not a vulnerability. · **演示版本按设计没有真正的登录：** 从名单里选身份，浏览器内演示的数据只在你自己的浏览器里。正式部署需要真正的登录、角色权限和会话过期（见 [docs/08](docs/08-live-operations.md) 第 7 节），演示没有登录不算漏洞。
- Reports about data handling, the event store, label generation, the realtime protocol or the build and deployment configuration are welcome. · 欢迎报告数据处理、事件存储、标签生成、实时协议、构建与部署配置方面的问题。

## Twin server (part 3) · 孪生服务（第三部分）

- **For local use.** The StoreX Chain twin server (`StoreX-Chain/server/`, `npm run twin-server`) is a development and integration tool for your own machine. Do not expose it to the internet or to an untrusted network: it has no user accounts. · **只在本机用。** StoreX 全链路的孪生服务（`StoreX-Chain/server/`，`npm run twin-server`）是在自己电脑上开发和对接用的工具。不要把它开放到公网或不可信的网络：它没有用户体系。
- **Security model (hardening under way).** A hardening pass is under way; the intended model is documented in the Security section of the [interface document](StoreX-Chain/server/protocol.md) ([English](StoreX-Chain/server/protocol.en.md)): · **安全模型（正在加固）。** 加固正在进行，目标模型写在[接口文档](StoreX-Chain/server/protocol.md)的「安全」一节（[英文版](StoreX-Chain/server/protocol.en.md)）：
  - it listens on loopback (127.0.0.1) by default and refuses to start on any other address without a token, unless explicitly overridden; · 默认只听本机（127.0.0.1）；不是本机地址又没有密钥时拒绝启动，除非显式放行；
  - remote use requires a token: every state-changing endpoint and WebSocket command must carry it; · 给别的机器用必须设访问密钥：所有改状态的接口和 WebSocket 指令都要带；
  - no wildcard CORS: browser origins must be listed explicitly, and state-changing requests or WebSocket connections from other origins are refused; · 不用通配的跨域（`*`）：浏览器来源要显式列出，其他来源改状态的请求和 WebSocket 连接会被拒绝；
  - request bodies are size-limited. · 请求体有大小上限。
- If it must be reached from another machine, put it behind a reverse proxy with HTTPS and pass tokens through environment variables so they do not appear in the process list. · 必须从别的机器访问时，放到有 HTTPS 的反向代理后面，密钥用环境变量传，免得出现在进程列表里。
- The StoreX and StoreX Chain web apps are static pages with no backend and no sign-in. · StoreX 和 StoreX 全链路的网页是纯静态页面，没有后端，也没有登录。
- Reports about the twin server are welcome: bypassing the token, cross-site access to a running server, the live-ingest endpoints, and the adapters' parsing of external data. · 欢迎报告孪生服务的问题：绕过密钥、跨站访问正在运行的服务、实时接入接口、适配器解析外部数据。
