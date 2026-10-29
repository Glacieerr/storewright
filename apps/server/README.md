# @storewright/server

The store hub and its Node backend: command API, event store, realtime push, scheduling, the twin service, the store AI service and the local assistant. The hub does not depend on the transport, so the in-browser demo runs the same code.

门店中枢和它的 Node 后端：命令接口、事件存储、实时推送、排程、孪生服务、门店 AI 服务和本地助手。中枢与传输方式无关，浏览器内演示跑的是同一份代码。

## What's inside · 主要内容

- `src/hub.ts`: `Hub`, every endpoint (commands, realtime connections, labels, demo, AI, twin). It must not import Node-only modules. · 全部接口的处理逻辑（命令、实时连接、标签、演示、AI、孪生），不能引用 Node 专有的模块。
- `src/runtime.ts`: one store's runtime: in-memory state, a serial command queue (decide, write, apply, push) and subscribers. · 一家店的运行时：内存中的状态、串行的命令队列（校验、写入、应用、推送）、订阅者。
- `src/storage.ts`, `src/platform.ts`: the `HubStorage` and `HubPlatform` interfaces, with the in-memory storage and pure TypeScript SHA-256 used in the browser. · 存储和平台接口，以及浏览器用的内存存储和纯 TypeScript 的 SHA-256。
- `src/main.ts`, `src/app.ts`: the entry point and the Fastify shell (HTTP, WebSocket, the associate app's static files, MQTT). · 启动入口和 Fastify 外壳（HTTP、WebSocket、员工端静态文件、MQTT）。
- `src/db.ts`, `src/eventStore.ts`: embedded PGlite, or PostgreSQL when `DATABASE_URL` is set; append-only events with optimistic concurrency (`sqlStorage`). · 嵌入式 PGlite，设置 `DATABASE_URL` 时改用 PostgreSQL；只追加的事件表，乐观并发。
- `src/twin.ts`: `TwinService` (telemetry, alert rules, replay, health, pushes every 2 s to viewers) and `EquipmentSim` for the demo store. · 孪生服务（遥测、告警规则、回放、健康度，每 2 秒推送给查看端）和演示门店的设备仿真。
- `src/ai.ts`, `src/aiOps.ts`: `AiService`, one model registry per store, trained on simulated history, with promotion and rollback, plus the live parts of the second round (pick time, demand outlook, foresight, nudges). · 门店 AI 服务：每家店一份模型仓库，用仿真历史训练，可以上线和回滚；以及第二轮的实时部分（拣货时长、订单量展望、运营预警、建议中枢）。
- `src/assistant/`: the local assistant: read-only tools, keyword rules and a naive Bayes intent classifier for template mode, an optional local LLM over an OpenAI-compatible API, and an evaluation set. · 本地助手：只读查询工具，模板模式的关键词规则和朴素贝叶斯意图分类器，可选的本地语言模型（OpenAI 兼容接口），评测集。
- `src/demo.ts`, `src/autopilot.ts`, `src/storeSim.ts`: the demo store, auto operations (virtual customers and staff on a second track), and in-store sales with shelf-sensor readings. · 演示门店、自动运营（虚拟顾客和员工的第二条线）、店内销售和货架传感器读数的仿真。
- `src/brief.ts`, `src/review.ts`, `src/foodsafety.ts`: opening brief, closing review and weekly report, food safety log. · 开店简报、打烊复盘和周报、食品安全记录。
- `src/sensing.ts`, `src/mqttBridge.ts`: shelf-sensor and equipment readings over HTTP and MQTT (`MQTT_URL`). · 货架传感器和设备读数的 HTTP、MQTT 接入。
- `src/loadtest.ts`, `src/bench.ts`, `src/llmEval.ts`: large-store capacity test, sync latency measurement, local LLM against template mode. · 大型店容量测试、同步延迟测量、本地语言模型和模板模式的对比。

## Use · 用法

Run from the repo root. The backend serves the associate app's build, so build that first; then open http://localhost:8787. · 在仓库根目录运行。后端会提供员工端的构建产物，所以先构建员工端，再打开 http://localhost:8787 。

```bash
npm run build:associate
```

```bash
npm run server
```

Run the home-improvement store and a 300-person store as well. Other settings are environment variables listed in `src/main.ts` (`PORT`, `DATABASE_URL`, `HTTPS`, `LLM_URL`, ...). · 同时运行家居建材店和 300 人的大型店。其他设置是环境变量，见 `src/main.ts`。

```bash
STORES=demo,hardware,large npm run server
```

Run the capacity test, then this app's tests. · 运行容量测试，然后运行这个应用的测试。

```bash
npm run loadtest -w @storewright/server
```

```bash
npx vitest run apps/server
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/ops` (including `/server` and `/client`), `@storewright/twin`, `@storewright/ai`, `@storewright/labels`, `@storewright/store-config` (including `/validate`), `@storewright/domain`, `@storewright/algorithms`, `@storewright/synth`, `@storewright/sim-engine`; third-party Fastify, PGlite, `pg`, `mqtt`
- **Used by · 使用它的地方：** `@storewright/associate` imports `/hub`, `/storage` and `/platform` to run the hub in the browser; the end-to-end tests start `src/main.ts`. · 员工端引用这三个入口，在浏览器里运行中枢；端到端测试启动 `src/main.ts`。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#3-architecture) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [08 Live operations](../../docs/08-live-operations.md): architecture, sync protocol, interfaces, running it, capacity · 架构、同步协议、接口、运行、容量
- [13 Demo & deployment](../../docs/13-demo-and-deployment.md): the store hub, one code base run two ways (§2) · 门店中枢：同一份代码，两种运行方式（第 2 节）
- [10 Store AI](../../docs/10-store-ai.md): the store AI service (§7) · 门店 AI 服务（第 7 节）
- [14 Digital twin](../../docs/14-digital-twin.md): interfaces and push (§8) · 接口与推送（第 8 节）
- Decisions [0008](../../docs/decisions/0008-phase3-plan.md) (Phase 3), [0012](../../docs/decisions/0012-phase7.md) (Phase 7), [0014](../../docs/decisions/0014-handoff-rules-and-scale.md) (large-store capacity), [0016](../../docs/decisions/0016-digital-twin.md) (digital twin) · 决策记录：Phase 3、Phase 7、大型店容量、数字孪生
- Decisions [0010](../../docs/decisions/0010-roadmap-and-phase5-plan.md) (store AI), [0021](../../docs/decisions/0021-store-ai-batch1.md)–[0024](../../docs/decisions/0024-store-ai-batch4.md) (second round of store AI) · 决策记录：门店 AI、门店 AI 第二轮
