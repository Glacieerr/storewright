# Support · 支持

Storewright (part 1), StoreX (part 2) and StoreX Chain (part 3) are the author's portfolio projects. They are provided as the licenses allow, **without technical support and without any warranty** (see the [License section of the README](README.md#license--许可证)). This page says where to look when something is unclear or broken.

Storewright（第一部分）、StoreX（第二部分）和 StoreX 全链路（第三部分）是作者的作品集项目，按许可证原样提供，**不提供技术支持，也不提供任何保证**（见 [README 的「许可证」一节](README.md#license--许可证)）。遇到不清楚或出错的地方，可以按下面的顺序找。

## Before you ask · 提问之前

- **Read the part's README and documents.** · **先看对应部分的 README 和文档。**
  - Storewright: [README](README.md) ([English](README.en.md) · [中文](README.zh-CN.md)), [documentation map · 文档导航](docs/README.md)
  - StoreX: [StoreX/README.md](StoreX/README.md), [StoreX/docs/](StoreX/docs/)
  - StoreX 全链路: [StoreX-Chain/README.md](StoreX-Chain/README.md), [StoreX-Chain/docs/](StoreX-Chain/docs/), twin-server protocol · 孪生服务协议 [StoreX-Chain/server/protocol.md](StoreX-Chain/server/protocol.md)
- **Run the checks on your copy** (Node.js 22 is what CI uses; see [.nvmrc](.nvmrc)). · **在自己的副本上跑一遍自检**（CI 用 Node.js 22，见 [.nvmrc](.nvmrc)）。

  ```bash
  npm ci
  npm run check                      # Storewright
  npm run check -w StoreX            # StoreX
  npm run check -w StoreX-Chain      # StoreX 全链路
  npm run docs:check -w StoreX-Chain # 文档里的数字和结果一致
  ```

- **Search the existing issues.** · **搜一下已有的 issue。**

## Where to go · 去哪里

| Situation · 情况 | Where · 去哪里 |
|---|---|
| Something is broken or differs from the documentation · 出错了，或者和文档说的不一样 | An issue with the **Bug report** form · 用 **Bug report** 表单开 issue |
| An idea or an improvement · 想法或改进建议 | An issue with the **Feature request** form · 用 **Feature request** 表单开 issue |
| A question about how something works or why it is designed that way · 怎么用、为什么这样设计 | The part's documents first; then an issue with the closest form · 先看对应部分的文档；还有疑问就用最接近的表单开 issue |
| A security vulnerability · 安全漏洞 | Report it privately as described in [SECURITY.md](SECURITY.md), never in a public issue · 按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开的 issue |
| Behavior that breaks the code of conduct · 违反行为准则的行为 | See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · 见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

Code pull requests are not accepted for now; see [CONTRIBUTING.md](CONTRIBUTING.md). · 暂不接受代码 pull request，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## What to include · 写些什么

- Which part, and whether it happened in the online demo or on your own copy. · 哪个部分；是在线演示还是自己的副本。
- Operating system, browser and its version, and the GPU for 3D problems; the Node.js version and commit when you run it locally. · 操作系统、浏览器和版本，三维相关的问题再写显卡；本地运行时写 Node.js 版本和提交号。
- Steps to reproduce, what you expected and what happened, and any error in the browser console or the terminal. · 复现步骤、期望的结果和实际的结果，以及浏览器控制台或命令行里的报错。
- **Public information only**, as in [CONTRIBUTING.md](CONTRIBUTING.md): nothing taken from an employer or another company, and no code. · **只写公开信息**（和 [CONTRIBUTING.md](CONTRIBUTING.md) 一样）：不要贴任何来自雇主或其他公司的内容，也不要贴代码。

## Replies · 回复

The project is maintained by one person in their spare time. Replies are best effort, with no promised response time. · 本项目由一个人在业余时间维护，尽力回复，不承诺回复时间。
