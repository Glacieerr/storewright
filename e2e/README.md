# e2e

End-to-end tests, accessibility checks and the step-by-step walkthrough, written with Playwright. They drive the built apps in real browsers, against the real backend and against the in-browser demo site. The folder has no `package.json` of its own and is outside the npm workspaces; the root `package.json` runs it.

端到端测试、无障碍检查和逐步走查，用 Playwright 编写。在真实浏览器里操作构建好的应用，分别连真实后端和浏览器内演示站点。这个目录没有自己的 `package.json`，不在 npm 工作区里，由根目录的 `package.json` 运行。

## What's inside · 主要内容

- `live.spec.ts`: the real backend, one browser context per person (like separate phones), scans typed with Enter like a hardware scanner. A pickup order across four devices, an AI recommendation, the replenishment loop, the returns hard rule. · 真实后端，每个身份一个独立的浏览器上下文（相当于不同的手机），扫码用键盘输入加回车模拟。覆盖：一张自取订单在四台设备上走完、AI 建议、补货闭环、退货的硬性规则。
- `demo.spec.ts`: the in-browser demo site (static files, hub in a SharedWorker): tab sync, the showcase and bridge, the twin alert loop with replay and forecast, the home-improvement store, saved data and reset, narrow screens, auto operations, the phone-width simulator. · 浏览器内演示站点（静态文件，中枢在 SharedWorker 里）：标签页同步、展示页和桥接、孪生的告警闭环和回放推演、家居建材店、数据保存与重置、窄屏、自动运营、手机宽度的模拟器。
- `phones.demo.spec.ts`: the two phones inside the showcase, driven only by real clicks. · 展示页里的两部手机，全部用真实点击操作。
- `a11y.spec.ts`: accessible names, WCAG AA contrast in light and dark themes, focus styles, keyboard-only sign-in. · 可读的名称、浅色和深色主题下的 WCAG AA 对比度、焦点样式、只用键盘登录。
- `fixtures.ts`: the shared `test`; projects marked `noSharedWorker` act as browsers without SharedWorker, so the demo takes its fallback. · 共用的 test；标了 `noSharedWorker` 的项目当作不支持 SharedWorker 的浏览器，演示走退路。
- `static-server.mjs`: serves `/app/` from `apps/associate/dist-demo`, `/sim/` from `apps/simulator/dist`, and redirects `/` to the showcase. · 演示站点的静态服务：`/app/`、`/sim/` 两个构建目录，`/` 跳到展示页。
- `walkthrough/`: 22 sections (`01-signin.walk.ts` to `22-store-ai-batch4.walk.ts`); `recorder.ts` records every step with a screenshot. · 22 个部分；记录器记下每一步和截图。

## Use · 用法

Run from the repo root and build everything first. `npm run e2e` starts the backend on port 8799 with a fresh data directory and the demo site on port 4177, then runs the `live`, `demo` and `a11y` projects on the installed Chrome. · 在仓库根目录运行，先全部构建。`npm run e2e` 用新的数据目录在 8799 端口启动后端、在 4177 端口启动演示站点，然后在本机已安装的 Chrome 上跑 `live`、`demo`、`a11y` 三个项目。

```bash
npm run build:all
```

```bash
npm run e2e
```

Add WebKit, Firefox, browsers without SharedWorker, iPhone and Android (install the browsers once). · 再加上 WebKit、Firefox、不支持 SharedWorker 的浏览器、iPhone 和安卓（浏览器只需装一次）。

```bash
npx playwright install webkit firefox
```

```bash
npm run e2e:browsers
```

CI machines have no GPU, so browsers render WebGL on the CPU. To see the same slowness locally, run the Chromium projects with software rendering. · 持续集成的机器没有显卡，浏览器在 CPU 上软件渲染 WebGL；要在本机看到同样的慢，让 Chromium 项目也用软件渲染。

```bash
PW_SOFTWARE_GL=1 npm run e2e
```

Run the walkthrough (ports 8798 and 4178); the report is `experiments/results/walkthrough/report.html`. · 运行全流程走查（8798 和 4178 端口），报告在 `experiments/results/walkthrough/report.html`。

```bash
npm run walkthrough
```

## Depends on · 依赖

- **Uses · 依赖：** no `@storewright/*` imports. It drives the builds of `apps/associate` and `apps/simulator` and starts `apps/server/src/main.ts` with tsx; `@playwright/test` comes from the root, configured in `playwright.config.ts` and `playwright.walkthrough.config.ts`. · 不引用 `@storewright/*` 包。它操作员工端和模拟器的构建产物，用 tsx 启动后端；`@playwright/test` 来自根目录，配置在根目录的两个 Playwright 配置文件里。
- **Used by · 使用它的地方：** `.github/workflows/ci.yml` runs the same projects in four parallel jobs (Chromium; no-SharedWorker and Android; WebKit and iPhone; Firefox) after `npm run build:all`. · 持续集成在全部构建之后，把同样的项目分成 4 个并行任务运行。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../docs/en/overview.md#9-in-browser-demo-testing-and-capacity) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [13 Demo, E2E & deployment](../docs/13-demo-and-deployment.md): multi-browser tests (§5), the walkthrough (§5b), CI (§6) · 多浏览器端到端测试（第 5 节）、全流程走查（5b）、持续集成（第 6 节）
- [Decision 0012](../docs/decisions/0012-phase7.md): Phase 7, end-to-end tests and CI; the first walkthrough (§7) · Phase 7：端到端测试和持续集成；第一次全流程走查（第 7 节）
- [Decision 0015](../docs/decisions/0015-v1-release.md): every browser (§1), accessibility (§4) · 所有平台可用（第 1 节）、无障碍（第 4 节）
