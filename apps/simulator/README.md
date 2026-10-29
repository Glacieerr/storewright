# @storewright/simulator

The 3D digital twin, built with React Three Fiber: the live twin (sync, replay, forecast, equipment) and the planning twin (full-day simulation in a Web Worker, policy comparison, reports, store generator and editor).

三维数字孪生，用 React Three Fiber 构建：运营孪生（实时同步、回放、推演、设备）和规划孪生（在 Web Worker 里跑全天仿真、策略对比、报告、门店生成与编辑）。

## What's inside · 主要内容

- `src/App.tsx`, `src/main.tsx`: the app shell. Embedded in the showcase, it keeps only the scene, a compact top bar, the twin timeline and the twin panel. · 应用外壳。嵌在展示页里时，只保留场景、精简的顶栏、孪生时间轴和孪生面板。
- `src/sim/`: `worker.ts` runs `simulateDay` and the AI advice in a Web Worker; `client.ts` uses one worker for the main run and one for policy comparison; `weatherPlan.ts` makes the changing-weather plan that the scene and the simulation share. · 在 Web Worker 里运行全天仿真和 AI 建议；主仿真和策略对比各用一个 Worker；画面和仿真共用的多变天气计划。
- `src/state/`: the Zustand store (`store.ts`), a playback clock kept out of React state (`clock.ts`), undoable layout edits (`editOps.ts`) and scenarios saved in the browser (`scenarios.ts`). · Zustand 状态、不放进 React 状态的播放时钟、可撤销的布局编辑、保存在浏览器里的方案。
- `src/live/`: `link.ts` connects as a viewer to a backend or to the in-browser hub; `twin.ts` holds readings, health, replay and forecast. · 以查看者身份连接后端或浏览器内的中枢；设备读数、健康度、回放和推演。
- `src/scene/`: the 3D world, all generated in code with nothing downloaded: store and shelves, people, vehicles and boats (`vehicles/`), roads (`street/`), water and terrain (`terrain/`), trees and grass (`foliage/`), toon shading and post effects (`style/`), the truck yard (`yard.ts`), parking (`parking.ts`, `lot.ts`), surroundings from a seed (`site.ts`), and live overlays (`LiveOverlay.tsx`, `LiveFleet.tsx`, `TwinSensors.tsx`). · 三维世界，全部由代码生成，不下载素材：门店和货架、人物、车辆和船、道路、水面和地形、树木和草、卡通着色和后期、卸货场、停车场、按种子生成的周边，以及实况叠加层。
- `src/ui/`: panels. `DataPane.tsx` holds the data tabs (Live data, AI recommendations, Policy comparison, Scenarios & reports, Events, Customize store, Digital twin); also `TwinPanel.tsx`, `TwinTimeline.tsx`, `EditorPanel.tsx`, `AreaEditor.tsx`, `ParkingEditor.tsx`, `AiPanel.tsx`, `AiPlan.tsx`, `Tour.tsx`. · 各个面板：数据标签（实时数据、AI 建议、策略对比、方案与报告、事件、门店定制、数字孪生）、孪生面板与时间轴、编辑器、区域与车位编辑、AI 建议、导览。
- `src/i18n/`: Chinese strings are the keys, `en.ts` is the English dictionary; `i18n.test.ts` checks that the Chinese strings in the simulator and the packages have English translations. · 中文原文就是键，`en.ts` 是英文字典；`i18n.test.ts` 检查模拟器和各个包里的中文字符串都有英文译文。
- `src/yourStore/`: Your Store, loaded when opened: the project page with the new-store wizard, the project bar with build steps and the pre-opening check, and store projects saved in the browser (copy, export, import). · 「你的商店」，打开时才下载：项目页和新建门店向导、带搭建步骤和开业检查的项目栏，以及保存在浏览器里的门店项目（复制、导出、导入）。

## Use · 用法

Run from the repo root. The dev server opens on http://localhost:5173; in the "Digital twin" tab, connect to a backend (for example http://localhost:8787) to make it the live twin. · 在仓库根目录运行。开发服务器在 http://localhost:5173 ；在「数字孪生」标签里连接后端（例如 http://localhost:8787），就成为运营孪生。

```bash
npm run dev
```

Build static files into `apps/simulator/dist/` (`base: './'`, works under any sub-path). · 构建纯静态文件到 `apps/simulator/dist/`（`base: './'`，可以放在任意子路径下）。

```bash
npm run build:sim
```

Type-check and test this app. · 检查类型、运行测试。

```bash
npm run typecheck -w @storewright/simulator
```

```bash
npx vitest run apps/simulator
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/sim-engine`, `@storewright/store-config`, `@storewright/synth`, `@storewright/algorithms`, `@storewright/ai`, `@storewright/domain`, `@storewright/ops` (including `/client` and `/hub-link`), `@storewright/twin`; third-party three, React Three Fiber, drei, React, Zustand
- **Used by · 使用它的地方：** the showcase page of the in-browser demo embeds it at `/sim/`; `scripts/build-site.mjs` copies its build into `site/sim/`; the end-to-end tests and the walkthrough. · 浏览器内演示的展示页在 `/sim/` 嵌入它；组装脚本把构建产物复制到 `site/sim/`；端到端测试和走查。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#4-planning-twin-simulator) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [07 Simulator](../../docs/07-simulator.md): features, architecture, performance, store customization, tests · 功能、架构、性能、门店定制、测试
- [14 Digital twin](../../docs/14-digital-twin.md): the live and planning twins, the user interface (§9) · 两个孪生、界面（第 9 节）
- [13 Demo & deployment](../../docs/13-demo-and-deployment.md): how the showcase connects the simulator (§3, §4) · 展示页怎样连上模拟器（第 3、4 节）
- Decisions [0003](../../docs/decisions/0003-simulator.md), [0004](../../docs/decisions/0004-simulator-v2.md), [0005](../../docs/decisions/0005-simulator-v3.md), [0006](../../docs/decisions/0006-simulator-v4.md), [0007](../../docs/decisions/0007-presentation-polish.md): simulator engineering, upgrade rounds two to four, presentation polish · 模拟器的工程决策、第二到第四轮升级、展示打磨
- Decisions [0013](../../docs/decisions/0013-phase8-plan.md) (vehicles, areas, pickup bays), [0016](../../docs/decisions/0016-digital-twin.md) (digital twin), [0017](../../docs/decisions/0017-stylized-world.md) (stylized world), [0018](../../docs/decisions/0018-vehicles-and-yard.md), [0019](../../docs/decisions/0019-yard-access-deliveries-harbor.md) (vehicles, yard, surroundings), [0020](../../docs/decisions/0020-students-boats-ai-advice.md) (AI advice) · 决策记录：车辆、区域和车位；数字孪生；卡通画面；车辆、卸货场和周边；AI 建议
