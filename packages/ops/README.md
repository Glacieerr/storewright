# @storewright/ops

The live operations core: `decide` checks a command and returns events or a rejection code, `applyEvent` applies events to the state, and views read the state. All of it is pure functions, shared by the server, the associate app and the simulator.

实时作业核心：`decide` 校验命令，返回事件或拒绝代码；`applyEvent` 把事件应用到状态上；视图从状态计算界面要用的数据。全部是纯函数，服务端、员工端和模拟器共用。

## What's inside · 主要内容

- `src/types.ts`, `src/commands.ts`, `src/events.ts`: the state (plain JSON that can be sent as a snapshot), commands (what a device or the scheduler wants to do) and events (immutable facts). · 状态（普通 JSON，可以直接作为快照发送）、命令（设备或排程器想做的事）、事件（不可变的事实）。
- `src/decide.ts`: command handling, exported through `@storewright/ops/server`. It reads no clock, draws no random numbers and does not change the state; locking, tote assignment, pick walks and trips call `@storewright/algorithms`. · 命令处理，经 `@storewright/ops/server` 导出。不读时钟、不取随机数、不修改状态；锁单分框、生成拣货批次、组合行程调用 `@storewright/algorithms`。
- `src/apply.ts`: `applyEvent` applies one event in place; `replay` rebuilds the state from an event stream. · `applyEvent` 原地应用一条事件；`replay` 从事件流还原状态。
- `src/views.ts`: read models such as the handoff board, staging occupancy, slot suggestions and pick lists. · 读模型：交付看板、暂存占用、格位建议、拣货清单等。
- `src/client.ts` (`@storewright/ops/client`): `LiveClient`, a snapshot plus numbered events, resync on gaps, and an outbox for commands made offline. · 实时客户端：快照加事件序号，序号不连续时重同步，离线时命令进发件箱。
- `src/hubLink.ts` (`@storewright/ops/hub-link`): messages and fetch and WebSocket stand-ins between a page and the in-browser store hub. · 页面和浏览器内门店中枢之间的消息，以及 fetch 和 WebSocket 的替身。
- `src/projection.ts`: device snapshots that leave out the totes, labels and walks of orders finished more than 60 minutes ago. · 发给设备的快照：完成超过 60 分钟的订单，不再发出它们的框、标签和批次。
- `src/inventory.ts`: receiving, put-away, backroom retrieval, counts, shelf stock and replenishment. · 收货、上架、后仓补取、盘点、货架存量和补货。
- `src/modules/`: pluggable modules (`mto.ts` made-to-order deli, `returns.ts`, `oversized.ts`, `parcel.ts` parcel hub). A module command is refused when the store has that module switched off. · 可插拔的扩展模块：熟食现做、退货、大件、包裹中转。门店没有打开某个模块时，它的命令被拒绝。
- Store AI on the operations side: `ai.ts` (recommendations and the SHOW, CONFIRM and AUTO modes), `nudges.ts`, `nextTask.ts`, `assist.ts`, `coldchain.ts`, `capacity.ts`, `safety.ts`, `expiry.ts`, `fieldops.ts`, `maintenance.ts`. · 门店 AI 在作业侧的部分：建议和三种运行模式、提醒、「下一步」、AI 估计、冷链拆批、时段产能、负荷与安全、临期、召回与突发状况、报修。
- People and settings: `staff.ts` (role moves), `roster.ts` (schedules, absences, cover), `alerts.ts` (equipment alerts), `settings.ts` (for example "require scanning"), `scan.ts`, `driverCancel.ts`, `notes.ts`. · 人员与设置：调岗、排班与补位、设备告警、门店设置（例如「要求扫码」）、扫码解析、司机取消窗口、门店经验。
- `src/*.test.ts`: operations, inventory, modules, cold chain, store AI, field operations and the hub link. · 测试：作业、库存、扩展模块、冷链、门店 AI、现场应对、中枢连接。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/ops
```

Type-check the whole repo. · 检查整个仓库的类型。

```bash
npm run typecheck
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`, `@storewright/store-config`, `@storewright/algorithms` (including `/replenish` and `/planogram`), `@storewright/ai`; the tests also use `@storewright/synth` · 测试还用到 `@storewright/synth`
- **Used by · 使用它的模块：** `@storewright/twin`; `@storewright/server` (including `/server`); `@storewright/associate` and `@storewright/simulator` (the main entry, `/client` and `/hub-link`)

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#5-live-operations) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [08 Live operations](../../docs/08-live-operations.md): architecture (§2), sync protocol (§3) · 架构（第 2 节）、同步协议（第 3 节）
- [09 Backroom & replenishment](../../docs/09-backroom-replenishment.md) · 后仓库存与补货
- [12 Business modules](../../docs/12-business-modules.md): module framework (§2), the four modules (§3) · 模块框架（第 2 节）、四个模块（第 3 节）
- [16 Operation flows](../../docs/16-operation-flows.md): every workflow step by step · 逐个岗位梳理每条流程
- Decisions [0008](../../docs/decisions/0008-phase3-plan.md) (Phase 3), [0009](../../docs/decisions/0009-phase4-plan.md) (Phase 4), [0011](../../docs/decisions/0011-phase6-plan.md) (modules), [0014](../../docs/decisions/0014-handoff-rules-and-scale.md) (pickup codes, driver cancellation, device snapshots) · 决策记录：Phase 3；Phase 4；扩展模块；取货码、司机取消和设备快照
- Decisions [0021](../../docs/decisions/0021-store-ai-batch1.md), [0022](../../docs/decisions/0022-store-ai-batch2.md), [0023](../../docs/decisions/0023-store-ai-batch3.md), [0024](../../docs/decisions/0024-store-ai-batch4.md) (store AI), [0025](../../docs/decisions/0025-team-view-dispatch.md) (on-duty team), [0026](../../docs/decisions/0026-flow-fixes.md) (flow fixes, store settings) · 决策记录：门店 AI 四批；在岗人员与调配；修复卡点和门店设置
