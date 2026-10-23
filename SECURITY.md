# Security · 安全

## Reporting a vulnerability · 报告漏洞

Please report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability. You will get a reply as soon as possible.

请通过 GitHub 私下报告安全问题：打开仓库的 **Security** 页，选择 **Report a vulnerability**。请不要为漏洞开公开的 issue，我们会尽快回复。

## Scope · 范围

- Supported: the latest version on the `main` branch. · 支持范围：`main` 分支上的最新版本。
- **By design, the demo has no real sign-in:** you pick an identity from the roster, and the in-browser demo keeps all data in your own browser. A production deployment needs real authentication, roles and session expiry (see [docs/08](docs/08-live-operations.md) §7); missing sign-in in the demo is not a vulnerability. · **演示版本按设计没有真正的登录：** 从名单里选身份，浏览器内演示的数据只在你自己的浏览器里。正式部署需要真正的登录、角色权限和会话过期（见 [docs/08](docs/08-live-operations.md) 第 7 节），演示没有登录不算漏洞。
- Reports about data handling, the event store, label generation, the realtime protocol or the build and deployment configuration are welcome. · 欢迎报告数据处理、事件存储、标签生成、实时协议、构建与部署配置方面的问题。
