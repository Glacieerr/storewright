# @storewright/associate

The associate app, a PWA for pick, stage, handoff, inventory, business modules and AI, plus the demo console and the in-browser demo, where the store hub runs inside the browser.

员工作业端（PWA）：拣货、暂存、交付、库存、扩展模块和 AI，加上演示控制台，以及门店中枢在浏览器里运行的浏览器内演示。

## What's inside · 主要内容

- `src/App.tsx`, `src/live.tsx`, `src/api.ts`: sign-in, the tab bar by role (pick, stage, handoff, inventory, modules, AI, more) and the connection through `LiveClient`. · 登录、按岗位显示的标签栏（拣货、暂存、交付、库存、扩展模块、AI、更多）、通过 `LiveClient` 的连接。
- `src/screens/`: `PickScreen.tsx`, `StageScreen.tsx`, `HandoffScreen.tsx`, `InventoryScreen.tsx` with `inventory/` (replenishment, backroom retrieval, receiving, put-away, counts, shelf checks, areas), `ext/` (deli, returns, oversized, parcel hub), `AiScreen.tsx`, `ScheduleScreen.tsx`, `FieldScreen.tsx`, `TwinCard.tsx` (equipment and alerts) and `ConsoleScreen.tsx` (the demo console stands in for the order platform, customers and drivers). · 各个页面：拣货、暂存、交付、库存（补货、后仓补取、收货、上架、盘点、核对货架、区域）、扩展模块（熟食、退货、大件、包裹）、AI、排班、现场应对、设备与告警、演示控制台（代替订单平台、顾客和司机）。
- `src/ui/`: the scan box (hardware scanner, camera or typing), the camera scanner (BarcodeDetector, or jsQR as a fallback), nudges, "next up", the on-duty team and store settings. · 扫码框（扫码枪、摄像头或手动输入）、摄像头扫码（BarcodeDetector，不支持时用 jsQR）、提醒、「下一步」、在岗人员、门店设置。
- `src/rejects.ts`: rejection codes from the operations core turned into UI text. · 把作业核心的拒绝代码转成界面文字。
- `src/i18n/`: the Chinese source strings are the keys and `en.ts` is the English dictionary; `i18n.test.ts` fails when a Chinese string in the source has no English entry. · 中文原文就是键，`en.ts` 是英文字典；源码里的中文没有英文译文时，`i18n.test.ts` 会失败。
- `src/demo/`: the in-browser demo: `hubWorker.ts` runs the hub in a SharedWorker (or a dedicated Worker as a fallback), `idbStorage.ts` keeps data in IndexedDB, `transport.ts` routes `/api` and WebSocket traffic to the hub, `showcase.ts` is the showcase page, `bridge.ts` lets the simulator reach the same hub. · 浏览器内演示：在 SharedWorker（不支持时用专用 Worker）里运行中枢、IndexedDB 保存数据、把 `/api` 和 WebSocket 转给中枢、展示页、让模拟器连到同一个中枢的桥接页面。
- `index.html`, `showcase.html`, `bridge.html`, `label.html`: the four entry pages; `public/` holds the web app manifest and the service worker. · 四个入口页面；`public/` 里是 PWA 清单和 service worker。

## Use · 用法

Run from the repo root. The dev server runs on http://localhost:5174 and forwards `/api` to the backend on port 8787. · 在仓库根目录运行。开发服务器在 http://localhost:5174 ，`/api` 转发到 8787 端口的后端。

```bash
npm run associate
```

Build for the backend (`apps/associate/dist`, served by `npm run server`), or build the in-browser demo (`apps/associate/dist-demo`). · 为后端构建（`apps/associate/dist`，由 `npm run server` 提供），或者构建浏览器内演示（`apps/associate/dist-demo`）。

```bash
npm run build:associate
```

```bash
npm run build:demo
```

Type-check and test this app. In the demo, `?as=A01` or `?as=console` opens as that person, `?store=hardware` picks the home-improvement store, and `?demo` switches a normal build to the in-browser hub. · 检查类型、运行测试。演示里 `?as=A01` 或 `?as=console` 直接以这个身份打开，`?store=hardware` 换成家居建材店，`?demo` 让常规构建改用浏览器内的中枢。

```bash
npm run typecheck -w @storewright/associate
```

```bash
npx vitest run apps/associate
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/ops` (including `/client` and `/hub-link`), `@storewright/twin`, `@storewright/ai`, `@storewright/domain`, `@storewright/algorithms/replenish`, `@storewright/server` (`/hub`, `/storage`, `/platform` for the in-browser hub); third-party React, jsQR
- **Used by · 使用它的地方：** `@storewright/server` serves its build; the simulator opens its `bridge.html` in a hidden iframe; `scripts/build-site.mjs` and `e2e/static-server.mjs` serve the demo build; the end-to-end tests. · 后端提供它的构建产物；模拟器在隐藏的 iframe 里打开 `bridge.html`；演示站点的组装脚本和静态服务；端到端测试。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#5-live-operations) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [08 Live operations](../../docs/08-live-operations.md): the associate app and the realtime backend · 员工作业端与实时后端
- [09 Backroom & replenishment](../../docs/09-backroom-replenishment.md) and [12 Business modules](../../docs/12-business-modules.md) (§5) · 后仓库存与补货；扩展业务模块（第 5 节）
- [13 Demo & deployment](../../docs/13-demo-and-deployment.md): connections in the browser (§3), showcase and URL parameters (§4) · 浏览器里的连接（第 3 节）、展示页与地址参数（第 4 节）
- [16 Operation flows](../../docs/16-operation-flows.md): what people tap and scan in every workflow · 每条流程里按什么、扫什么
- Decisions [0008](../../docs/decisions/0008-phase3-plan.md) (Phase 3), [0012](../../docs/decisions/0012-phase7.md) (in-browser demo), [0015](../../docs/decisions/0015-v1-release.md) (every browser, accessibility), [0025](../../docs/decisions/0025-team-view-dispatch.md) (on-duty team), [0026](../../docs/decisions/0026-flow-fixes.md) (flow fixes) · 决策记录：Phase 3；浏览器内演示；所有浏览器和无障碍；在岗人员；修复卡点
