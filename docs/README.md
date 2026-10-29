# Documentation map · 文档导航

Where to start, by what you want to do. Most design documents are in Chinese; the English entry points are marked. · 按你想做的事选择从哪里开始。大部分设计文档是中文，英文入口已标出。

## Start here · 从这里开始

| If you want to · 如果你想 | Read · 看这里 |
|---|---|
| See what it is in five minutes · 五分钟了解项目 | [README](../README.md) (bilingual · 双语) → in-browser demo · 浏览器内演示 (`npm run build:site`, `npm run demo:site`) |
| Use the system · 使用这套系统 | [操作指南](guide/operation-guide.zh-CN.md) · [Operation guide](guide/operation-guide.en.md) |
| Evaluate the project (reviewers, hiring) · 评估项目（评审、招聘） | [项目报告](project/project-report.zh-CN.md) · [Project report](project/project-report.en.md) |
| Know why it exists and where it goes · 了解为什么做、做到了什么、以后做什么 | [项目目的、达成的目标与未来展望](project/purpose-and-outlook.zh-CN.md) · [Purpose, results and outlook](project/purpose-and-outlook.en.md) |
| Read the design in English · 看英文的设计摘要 | [Technical overview](en/overview.md) |
| Work on the code · 改代码 | [CONTRIBUTING](../CONTRIBUTING.md), each module's README · 各模块的 README (`apps/*`, `packages/*`, `e2e/`) |
| Check compliance · 查看合规 | [Compliance statement · 合规声明](../COMPLIANCE.md), [Third-party notices · 第三方组件声明](../THIRD_PARTY_NOTICES.md), [Security · 安全](../SECURITY.md), [LICENSE](../LICENSE) (AGPL-3.0), [LICENSE-docs](../LICENSE-docs) (CC BY 4.0) |

## Design documents · 设计文档（中文）

| # | Document · 文档 | What it covers · 内容 |
|---|---|---|
| 01 | [工作流设计](01-workflow-design.md) | Workflow design and public research · 工作流设计与公开调研 |
| 02 | [可行性论证](02-feasibility.md) | Feasibility · 可行性论证 |
| 03 | [尖锐问题清单与决议](03-open-questions.md) | Phase 0 questions and decisions, incl. the information boundary (G-02) · Phase 0 的问题与决定，包括信息边界（G-02） |
| 04 | [技术栈组合方案](04-tech-stack.md) | Tech stack and why · 技术栈与理由 |
| 05 | [效益评估与路线图](05-evaluation-and-roadmap.md) | How results are proven honestly; phases · 如何诚实地证明效益；分阶段路线图 |
| 06 | [Phase 1 成果](06-phase1-results.md) | First simulation results · 第一轮仿真结果 |
| 07 | [运营模拟器](07-simulator.md) | Planning twin and 3D world · 规划孪生与三维世界 |
| 08 | [实时作业](08-live-operations.md) | Associate app and realtime backend · 员工作业端与实时后端 |
| 09 | [后仓库存与补货](09-backroom-replenishment.md) | Backroom, retrieval, replenishment, sensing · 后仓、补取、补货与感知 |
| 10 | [门店 AI](10-store-ai.md) | Local-first AI design, ethics · 本地优先的 AI 设计、伦理边界 |
| 11 | [AI 效益报告](11-ai-results.md) | AI evaluation and model cards · AI 评估与模型卡片 |
| 12 | [扩展模块与第二个行业](12-business-modules.md) | Modules and the home-improvement store · 扩展模块与家居建材店 |
| 13 | [演示、测试与部署](13-demo-and-deployment.md) | In-browser demo, end-to-end tests, CI, hosting · 浏览器内演示、端到端测试、持续集成、部署 |
| 14 | [数字孪生](14-digital-twin.md) | Live, replay, forecast, telemetry and alerts · 实时、回放、推演、遥测与告警 |
| 15 | [门店 AI 路线图](15-store-ai-roadmap.md) | Second round of store AI · 门店 AI 第二轮 |
| 16 | [操作流程](16-operation-flows.md) | Every workflow step by step as built · 按现在的代码逐步梳理每条流程 |

## More · 其他

- [Decision records · 决策记录](decisions/) (0001–0027)
- [Pseudocode · 伪代码](pseudocode/): tote assignment, pick-walk partition, a simulated day · 分框、分批与路线、一天的仿真
- [Results · 结果](results/): comparison and sensitivity reports · 对比与敏感性报告
- [Label samples · 标签样本](samples/labels.md)
- [Shelf sensing prototype · 货架传感原型](hardware/shelf-sensing-prototype.md)

This project is not affiliated with any retailer or company. · 本项目与任何零售商、企业无隶属关系。
