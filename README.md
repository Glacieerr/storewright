# Storewright

**An integrated store-operations system for mid-size grocers, with a 2.5D / 3D operations simulator and per-store local AI. It runs entirely in your browser.**

**面向中型超市的门店一体化作业系统，配一个 2.5D / 3D 运营模拟器和每家店自己的本地 AI。整个系统可以直接在浏览器里运行。**

[Full English guide](README.en.md) · [完整中文说明](README.zh-CN.md) · [Technical overview (English)](docs/en/overview.md) · [文档目录（中文）](README.zh-CN.md#文档) · Live demo / 在线演示: *link added after deployment / 部署后补上*

![Showcase: demo console and two associate phones, all running in the browser](docs/images/showcase-en.jpg)

> This project is based on public information, common industry practice and the author's own design. **It is not affiliated with any retailer or company.** All stores, products, customers and numbers are synthetic.
>
> 本项目基于公开资料、行业通用做法和作者的独立构想设计。**本项目与任何零售商、企业无隶属关系。** 所有门店、商品、顾客和数字都是合成的。

## What it does · 能做什么

| | English | 中文 |
|---|---|---|
| Fulfilment · 履约 | Online orders flow through **pick → stage → hand off** on associate phones, with labels, cold-chain limits, staging slots, pickup bays and multi-order delivery trips. | 线上订单在员工手机上走完**拣货 → 暂存 → 交付**：标签、冷链时限、暂存格位、取货车位、多单配送行程。 |
| Backroom & shelves · 后仓与货架 | Receiving, put-away, cycle counts, backroom retrieval, shelf-stock estimates and replenishment tasks, with sensor and POS feeds. | 收货、上架、盘点、后仓补取、货架存量估算和补货任务，接入传感器和收银流水。 |
| Simulator · 模拟器 | A management-game-style 2.5D / 3D store: vehicles, people, areas and dock doors; a full-day simulation with policy comparison and reports; an editor where everything about the store can be changed. | 像模拟经营游戏一样的 2.5D / 3D 门店：车辆、人流、区域、卸货门；全天仿真、方案对比与报告；门店的一切都可以在编辑器里改。 |
| Store AI · 门店 AI | Per-store models trained locally (demand, arrival times, shelf availability, counts, substitutions, staffing), promoted only after beating simpler baselines; every recommendation explains why. | 每家店在本机训练自己的模型（订单量、到店时间、可售概率、盘点、替代、排班），比简单方法好才上线；每条建议都说明理由。 |
| One core everywhere · 一套核心 | An event-sourced core shared by the server, the phones and the simulator; the same store hub runs on Node or inside the browser. | 事件溯源的作业核心，服务端、手机和模拟器共用；同一个门店中枢既能跑在服务器上，也能跑在浏览器里。 |
| Scale · 容量 | Tested with a 300-person store: 300 devices connect in 0.09 s; at 50 commands a second, everyone sees each change within about 15 ms. | 按 300 人的大型店测试：300 台设备 0.09 秒连上；每秒 50 条操作时，所有设备约 15 毫秒内看到变化。 |

<table>
<tr>
<td width="62%"><img src="docs/images/simulator-3d-en.jpg" alt="3D simulator with cutaway building, parking lot and live charts"></td>
<td><img src="docs/images/phone-ai-en.jpg" alt="Lead's phone: today's staffing recommendation with reasons"></td>
</tr>
<tr>
<td>3D simulator: cutaway building, lot, live charts · 3D 模拟器：半剖建筑、停车场、实时图表</td>
<td>A recommendation with its reasons · 带理由的 AI 建议</td>
</tr>
</table>

## Results (simulation, synthetic data) · 结果（仿真，合成数据）

| Question · 问题 | Result · 结果 |
|---|---|
| Better than a store with no dedicated system? · 比没有专门系统的门店好吗？ | Overweight / crush-risk / chemical-mix totes 11–19% → **0**; average wait **−15%**; time orders sit at the door **−81%**; labor +4.9% · 超重、压坏、混装框 11–19% → **0**；平均等待 **−15%**；订单在门口停留 **−81%**；工时 +4.9% |
| Does AI help with the same labor? · 工时不变，AI 有用吗？ | Average wait **−13%**, 90th-percentile wait **−23%**, late orders 2.41% → **0.69%** · 平均等待 **−13%**，90 分位等待 **−23%**，迟到订单 2.41% → **0.69%** |
| Does it transfer to another industry? · 能迁移到别的行业吗？ | Yes, as a home-improvement store; the payoff shifts from batching to safety and AI staffing · 能，迁到家居建材店；收益从分批转向安全和 AI 排班 |

Evidence level B: simulation under stated assumptions, not a claim about any real store. · 证据等级 B：在列明的假设下仿真得到，不代表任何真实门店。

## Quick start · 快速开始

Requires Node.js 20 or later. · 需要 Node.js 20 或更高版本。

```bash
npm install
```

```bash
npm run build:site
```

```bash
npm run demo:site
```

Open http://127.0.0.1:4177/ for the showcase (console, two phones, live store and full-day simulation, all in the browser). · 打开 http://127.0.0.1:4177/ 就是展示页（控制台、两部手机、门店实况和全天仿真，全部在浏览器里运行）。

| Command · 命令 | What it does · 作用 |
|---|---|
| `npm run dev` | Simulator only · 只开模拟器（http://localhost:5173） |
| `npm run server` | Real backend with the associate app · 真实后端和员工作业端（http://localhost:8787） |
| `npm run check` | Type checks + 218 unit and property tests · 类型检查和 218 个单元、属性测试 |
| `npm run e2e:browsers` | 51 end-to-end runs on Chromium, WebKit (Safari), Firefox, iPhone, Android and browsers without SharedWorker, plus accessibility checks · 51 个端到端测试：Chromium、WebKit（Safari 内核）、Firefox、iPhone、安卓、不支持 SharedWorker 的浏览器，以及无障碍检查 |
| `npm run walkthrough` | 15-section step-by-step walkthrough with screenshots · 15 个部分的逐步走查，带截图 |
| `npm run loadtest -w @storewright/server` | 300-person store capacity test · 300 人大型店容量测试 |

## Browser support · 浏览器支持

Recent Chrome, Edge, Safari (macOS and iOS) and Firefox, on desktop and phones, are tested automatically. Browsers without SharedWorker (older Android browsers, some in-app browsers) fall back to one hub per page: the showcase still works, and a notice explains that separate tabs don't share a store. · 自动测试覆盖较新的 Chrome、Edge、Safari（macOS 和 iOS）、Firefox，电脑和手机都包括。不支持 SharedWorker 的浏览器（较旧的安卓浏览器、部分 App 内置浏览器）每个页面用自己的中枢：展示页照常使用，多个标签页不共用门店时会有提示。

## Repository · 仓库

```
apps/simulator    2.5D / 3D simulator and store editor · 运营模拟器和门店编辑器
apps/associate    Associate PWA, demo console, in-browser demo · 员工作业端、演示控制台、浏览器内演示
apps/server       Store hub (Node or browser) + Fastify shell, store AI service · 门店中枢（Node 或浏览器）、门店 AI 服务
apps/sim-cli      Experiments and reports · 实验与报告
packages/*        domain, store-config, synth, algorithms, sim-engine, ops, labels, ai
docs/             Design docs, decision records, results (Chinese) + English overview · 设计文档、决策记录、结果，以及英文概览
e2e/              End-to-end tests and walkthrough (Playwright) · 端到端测试和走查
```

## License · 许可证

- Code: [AGPL-3.0](LICENSE); a commercial license is also available. · 代码：[AGPL-3.0](LICENSE)，另提供商业许可。
- Documentation, pseudocode and reports: [CC BY 4.0](LICENSE-docs). · 文档、伪代码与报告：[CC BY 4.0](LICENSE-docs)。
- Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). · 参与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)。
