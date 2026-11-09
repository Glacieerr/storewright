# 术语表 · Glossary

Chinese–English glossary of the domain terms used in the StoreX Chain web app, the reports and the twin server. The English terms are the ones used in [README.en.md](../README.en.md), [protocol.en.md](../server/protocol.en.md), [DATA.md](results/DATA.md) and the assistant's tool descriptions; abbreviations are the common industry ones. All names of places, vessels, flights and companies in the project are synthetic.

本表收录网页、报告和孪生服务里用到的领域术语，中英对照。英文用法和英文 README、协议英文版、数据字典以及值班助手工具说明保持一致。本项目与任何零售商、企业无隶属关系。

## 网络和货流 · Network and flows

| 中文 | English | Note |
|---|---|---|
| 全链路 | end-to-end chain | From port, rail, airport and highway to the store shelf |
| 综合店 | comprehensive store | The single large store of part 3 (a StoreX fresh-food store plus a general-merchandise hall) |
| 百货日用馆 | general-merchandise hall | The non-food part of the comprehensive store |
| 配送中心 | distribution center (DC) | In the logistics park; dry (常温) and cold (冷链) sides |
| 冷链中心 | cold-chain center | The cold side of the DC |
| 仓储中心 | warehousing hub | Port logistics center, air cargo terminal, logistics park, store parking and receiving yard |
| 货源 | source (of supply) | Ocean, rail, air, regional fresh, bakery, long-haul road |
| 货流规划 | flow plan | Which product families go direct to the store and which through the DC |
| 商品族 | product family | Planning unit for flows, stock and forecasts (e.g. dairy, frozen, beverages) |
| 温区：常温 / 冷藏 / 冷冻 | temperature zone: ambient / chilled / frozen | |
| 长途整车 | long-haul truckload (FTL) | Domestic and cross-border trucking into the region |
| 直送门店 | direct store delivery (DSD) | Long-haul truckloads delivered straight to the store |
| 进配送中心 | via the DC | |
| 越库 | cross-docking | Goods pass through the DC without being stored |
| 区域生鲜 | regional fresh produce | From the inland growing area, collected at night |
| 中央面包房 | central bakery | |
| 集货 | consolidation / collection run | |
| 配送车 | delivery truck | DC → store |
| 多温区配送车 | multi-temperature truck | Ambient, chilled and frozen compartments in one truck |
| 电动配送车 | electric delivery truck (EV) | |
| 线上配送车 | online delivery van | |
| 面包车 / 小货车 | van | |
| 排线 | route planning | Daily delivery routes (savings algorithm) |
| 节约法 | savings algorithm (Clarke–Wright) | |
| 回程顺路装货 | backhaul | Picking up from suppliers on the way back |
| 装载率 | fill rate (load factor) | |
| 补货周期 | replenishment interval | |
| 供应商管理库存 | vendor-managed inventory (VMI) | |
| 共享销售数据 | shared sales data | DC and suppliers see the store's forecast and promotion calendar |
| 多门店网络 | multi-store network | The network planning page (1–12 stores) |
| 选址 | facility location | |
| 候选仓 | candidate DC | |
| 扩建 | expansion | |
| 库存分配 | inventory allocation | Who gets what when stock is short |
| 跨境 | cross-border | |
| 清关：申报、审核、查验、放行 | customs clearance: declaration, review, inspection, release | |
| 预清关 | pre-clearance | |
| 单证 | documents | Required shipping and customs documents |
| 关税 / 增值税 | duty / VAT | |
| 到岸成本 | landed cost | |
| 过桥采购 | bridge buying | Short-term purchase to cover a gap |
| 备用供应商 | backup supplier | |

## 港口 · Port

| 中文 | English | Note |
|---|---|---|
| 港口 | port (container terminal) | |
| 班轮 | liner | The store's weekly sailing |
| 支线船 | feeder | |
| 泊位 | berth | |
| 岸线 / 码头 | quay | |
| 岸桥 | quay crane (ship-to-shore crane) | |
| 堆场 | container yard (CY) | |
| 龙门吊 | gantry crane | Yard cranes (rail-mounted at the rail terminal) |
| 集卡 / 场内集卡 | yard truck / terminal truck | |
| 集装箱拖车 / 短驳 | drayage | Container moves between port, rail and DC |
| 底盘车 / 集装箱骨架车 | chassis (skeletal trailer) | |
| 闸口 | gate | |
| 进闸 / 出闸 | gate in / gate out | |
| 卸船 / 装船 | discharge / load | |
| 提箱预约 | pickup appointment | |
| 堆场停留 | dwell (container dwell time) | KPI `dwell`, days |
| 滞箱费 | demurrage | KPI `demurrage`, USD per day |
| 港口物流中心 | port logistics center | Between the container yard and the gate |
| 拆装箱库 | container freight station (CFS) | |
| 拼箱 / 整箱 | LCL / FCL | Less-than / full container load |
| 保税库 | bonded warehouse | |
| 海关查验场 | customs inspection area | |
| 锚地 | anchorage | |
| 航道 | channel | |
| 拖轮 | tug | |
| 冷藏箱 | reefer container | |
| 40 尺箱 / 20 尺箱 | 40-ft / 20-ft container | |
| 箱号 | container number (ISO 6346) | |
| 港口铁路接驳 | port rail shuttle | |

## 空运 · Air cargo

| 中文 | English | Note |
|---|---|---|
| 机场货站 | air cargo terminal | |
| 货运航班 / 货机 | freighter flight / freighter | |
| 机位 | stand | |
| 机坪 | apron | |
| 跑道 / 滑行道 | runway / taxiway | |
| 空侧 / 陆侧 | airside / landside | |
| 集装板 | ULD (unit load device) | |
| 拆板 / 组板 | breakdown / build-up | |
| 板车 | dolly | |
| 升降平台车 | high loader (main-deck loader) | |
| 牵引车（机坪） | tug (apron tractor) | |
| 集装板立体库 / 堆垛车 | ULD storage system / elevating transfer vehicle (ETV) | |
| 散货货架 | bulk cargo racking | |
| 危险品库 / 贵重品库 | dangerous-goods store / valuables store | |
| 海关监管区 | customs-controlled area | |
| 安检 X 光机 | X-ray screening | All export cargo is screened |
| 备降机场 | alternate airport | |

## 铁路和物流园 · Rail and logistics park

| 中文 | English | Note |
|---|---|---|
| 洲际铁路班列 | intercontinental block train | |
| 物流园 | logistics park | Rail terminal, transload warehouse, DC |
| 铁路货运站 | rail freight terminal | |
| 装卸线 | loading track | |
| 平车 | flatcar | |
| 转运仓 | transload warehouse | Rail ↔ truck for other shippers' boxes |
| 甩挂 / 甩挂区 | drop-and-hook / drop yard (trailer pool) | |
| 登记亭 | check-in kiosk | At the park entrance |
| 等候场 | holding area | |

## 配送中心和卸货场 · DC and truck yard

| 中文 | English | Note |
|---|---|---|
| 月台门 | dock door | 38 at the DC (C = cold, D = dry) |
| 登车桥 | dock leveler | |
| 卷帘门 | roll-up door | |
| 暂存道 | staging lane | |
| 立体库 / 堆垛机 | automated storage and retrieval system (AS/RS) / stacker crane | |
| 货到人拣选 | goods-to-person picking | |
| 拆零 | each picking (piece picking) | |
| 码垛 | palletizing | |
| 周转箱 | tote | |
| 托盘 / 箱 / 件 | pallet / case / unit | |
| 卸货场 | truck yard | `packages/yard`（`@storewright/yard`） |
| 收货场 | receiving yard | The store's truck yard |
| 收货口 | receiving dock (store) | S01-1…S01-4 |
| 待命车位 | staging stall | Where trucks wait for a door |
| 靠台 / 驶离 | dock (back in) / pull out | |
| 倒车 | reversing | `reversing` in the protocol |
| 等门 / 等收货口 | door wait / dock wait | |
| 半挂车 / 牵引车 | semitrailer / tractor | |
| 平头 / 长头牵引车 | cab-over / conventional (long-nose) tractor | |
| 厢式货车 | box truck | |
| 冷藏车 / 冷藏挂车 | reefer truck / reefer trailer | |
| 场内牵引车 | yard shunter (terminal tractor) | |
| 铰接 | articulated | |
| 牵引销 / 鞍座 | kingpin / fifth wheel | |
| 转弯半径 | turning radius | |
| 喇叭口 | flared entrance | |

## 门店 · Store

| 中文 | English | Note |
|---|---|---|
| 门店服务水平 | store service level | Share of demand met (KPI `service`) |
| 缺货 / 卖空 | stock-out / sold out | |
| 生鲜损耗 | fresh waste | Spoiled and marked-down fresh goods |
| 剩余保质期 | remaining shelf life | |
| 后仓 | backroom | |
| 停车场 | parking lot | |
| 即时取货 | instant pickup | |
| 免下车取货 | drive-through pickup | |
| 自提柜 | pickup lockers | |
| 路边取货 | curbside pickup | Previous generation |
| 无障碍车位 / 充电车位 | accessible stall / EV charging stall | |
| 购物车回收栏 | cart corral | |
| 消防车道 | fire lane | |
| 收货截止 | receiving cut-off | |

## 规划、仿真和分析 · Planning, simulation and analysis

| 中文 | English | Note |
|---|---|---|
| 方案 / 代 | generation | g1 previous generation (上一代), g2 StoreX, g3 StoreX Chain (StoreX 全链路) |
| 种子 | seed | One reproducible random run |
| 18 周 | 18-week run | Length of one simulation run |
| 置信区间 | confidence interval | `ci` in data.json: half-width of the 95% interval |
| 决策扫描 | decision sweep | Change one lever at a time |
| 需求增长 / 容量 | demand growth / capacity | |
| 压力演练 | stress drill | Port congestion, airport closure, highway closure, supplier outage, demand surge |
| 负荷档位：平常 / 高峰 / 高负荷 / 极限 | load level: normal / peak / high / extreme | |
| 投资 / 净现值 / 内部收益率 / 回收期 | capex / NPV / IRR / payback | |
| 折现率 | discount rate | |
| 库存资金 | inventory capital (working capital) | KPI `workingCapital` |
| 敏感性 / 情景 | sensitivity / scenario | |
| 预测模型 | forecast model | Rule versus learned model, picked by validation error |
| 演练 / 预案 / 韧性预案库 | drill / contingency plan / resilience playbook | |
| 本地运输排放 | local transport emissions | KPI `co2Local` |

## 调度和闭环孪生 · Dispatch and closed-loop twin

| 中文 | English | Note |
|---|---|---|
| 调度台 | dispatch board | |
| 甘特图 | Gantt chart | |
| 作业 / 资源 | job / resource | |
| 改派 | reassign | |
| 求解 | solve | Branch and bound |
| 分支定界 | branch and bound | |
| 排门 / 派车 | door assignment / vehicle dispatching | |
| 常规计划 | standing plan | Regular timetables and time windows |
| 自动排程 | auto-schedule | |
| 闭环孪生 | closed-loop twin | |
| 现场 | field | The minute-by-minute physical simulation (or real data) |
| 感知数据 | sensor data | `msgs` in the protocol |
| 指令 | command | `cmd` in the protocol |
| 建议卡 | recommendation card | `cards` in the protocol |
| 推演 | what-if simulation | |
| 自动执行范围 | automation policy | manual / safe / auto |
| 低风险 | low-risk | Options that may run automatically |
| 估计 / 真值 | estimate / ground truth | |
| 保真度 | fidelity | ETA and temperature error of the twin |
| 预计到达 | ETA | |
| 门磁 | door sensor | |
| 车载终端 | telematics unit | |
| 冷机 / 设定温度 | reefer unit / setpoint | |
| 超温 | over-temperature | |
| 抛锚 | breakdown | |
| 救援车 | rescue truck | |
| 追加补货 | top-up restock | |
| 顺延收货 | extend the receiving cut-off | |
| 通信质量 / 数据质量 | link quality / data quality | |
| 丢点 / 晚到 | dropped fixes / late data | |
| 对比回放 | split-screen comparison | |
| 现场视图 / 虚拟监控 | field view / virtual camera | |
| 监控画面识别 | camera-feed detection | |

## 值班助手和运营管理 · Duty assistant and operations control

| 中文 | English | Note |
|---|---|---|
| 值班助手 | duty assistant | |
| 意图 | intent | |
| 参数（车、商品族、门、时刻） | entities | |
| 查询工具 | query tool | Read-only |
| 资料库 | knowledge base | Procedures and design documents |
| 四段式回答：结论、依据、把握、下一步 | four-part answer: conclusion, basis, certainty, next step | |
| 数字核对 | grounding check | Every number must come from tool results |
| 问清楚 | clarify | |
| 超出范围 | out of scope (declined) | |
| 拒绝 | refused | Requests to skip confirmation or approval |
| 提议 / 确认执行 | proposal / confirm and execute | |
| 规则表 | policy table | `src/assistant/policy.ts` |
| 角色：只读 / 调度员 / 站长 / 区域经理 | roles: viewer / dispatcher / site manager / regional manager | |
| 审批 / 往上报 | approval / escalation | |
| 操作记录 | audit log | |
| 此刻要关注 | things to watch | `/api/watch` |
| 交接班报告 | shift handover report | |
| 建议复盘 | recommendation review | |
| 指令跟踪 | command tracking | |
| 归因 | root-cause attribution | |
| 异常检测 | anomaly detection | |
| 瓶颈 | bottleneck | |
| 预约错峰 | appointment smoothing | |
| 今日计划 | daily plan | |
| 分层看板 | tiered KPI board | Group, region, facility, operation |
| 注意 / 告警 | warn / alarm | The two thresholds |
| 集团总览 | group overview | |
| 设施监控 | facility monitor | |
| 设施管理台 | facility console | |
| 标准问题 | standard questions | Regression test of the assistant |
| 留出集 | holdout set | |
| 盲测 | blind test | |
| 朴素贝叶斯 / 逻辑回归 | naive Bayes / logistic regression | Intent classifiers |
| 弃答 | abstain | Ask instead of guessing |

## 孪生服务和数据接入 · Twin server and data integration

| 中文 | English | Note |
|---|---|---|
| 孪生服务 | twin server | |
| 沙盘坐标 | sandbox coordinates | Metres, x east, z south; regional distances at 1/10 |
| 运输管理系统 | transport management system (TMS) | |
| 仓储和门店系统 | warehouse and store systems (WMS) | |
| 电子数据交换 | electronic data interchange (EDI) | A simplified UN/EDIFACT subset defined by this project |
| 适配器 | adapter | |
| 记录 / 回放 | recording / replay | |
| 实时接入 | live ingest | |
| 盯着目录 | watch (a folder) | |
| 发件箱 | outbox | |
| 共享密钥 | shared token | |
| 新行程 | new trip | TMS `trip` record |
| 影子运行 | shadow mode | Predict and recommend without sending commands |

## 区域和三维 · Region and 3D

| 中文 | English | Note |
|---|---|---|
| 区域生成器 | region generator | |
| 默认区域 / 随机区域 / 自定义区域 | default / random / custom region | The default region is frozen |
| 城市总体规划 / 用地 | city master plan / land use | |
| 15 分钟生活圈 | 15-minute neighbourhood | |
| 绕城快速路 / 高架快速路 | bypass expressway / elevated expressway | |
| 立交 | interchange | |
| 背景交通 | background traffic | |
| 实时跟踪 | live tracking | |
| 放样 | lofting | Vehicles are modelled from cross-sections |
| 远处的简模 | far (low-detail) model | |
