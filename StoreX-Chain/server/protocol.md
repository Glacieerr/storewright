# 孪生服务的接口

孪生服务在服务器上跑全链路仿真（得到当天的计划）、调度台（排好月台门、收货口和车辆）和闭环孪生（现场 + 孪生），按可以加速的真实时间一分钟一分钟往前走，把现场的车辆位置、感知数据和孪生的建议推给外部系统，并接收外部系统的决定和指令。虚幻引擎（`engines/ue5/`）、MATLAB（`engines/matlab/`）和浏览器都按这份接口接入。

```bash
npx tsx server/twinServer.ts --port 8787 --gen g3 --seed 1 --level normal --policy safe --speed 10 --start 4 --region default --load normal
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port`、`--host` | 8787、127.0.0.1 | 监听地址（默认只监听本机；`--host` 不是本机时必须设 `--token`，否则拒绝启动，见「安全」） |
| `--token <密钥>` | 不要密钥 | 访问密钥（也可以用环境变量 `STOREX_TOKEN`，免得出现在进程列表里）：设了以后改状态的接口和 WebSocket 指令都要带 |
| `--allow-origin <来源,来源>` | 不回跨域头 | 允许的浏览器来源（比如 `http://localhost:5173`）：只有这些来源回跨域头、能改状态、能连 WebSocket |
| `--insecure` | 关 | 不只听本机又没有密钥时照样启动（会警告；只在可信的网络里用） |
| `--gen` | g3 | 方案：g1 上一代、g2 StoreX、g3 StoreX 全链路 |
| `--seed` | 1 | 仿真和现场状况的编号（同一个编号每次一样） |
| `--level` | normal | 现场状况：normal 平常的一天、rough 多事的一天 |
| `--policy` | safe | 孪生建议的自动执行范围：manual 全部人工确认、safe 低风险的自动执行、auto 全部自动执行 |
| `--speed` | 10 | 每秒走几分钟（10 = 一天约 2.4 小时走完；可以用 `/api/control` 改） |
| `--start` | 4 | 从当天几点开始（之前的部分启动时快速跑过；实时接入 live、watch 默认 0） |
| `--region` | default | 区域：`default` 默认区域、`random-编号` 随机区域，或自定义的写法（和网页地址里的 `?region=` 一样）；海岸、河、城区、道路、铁路、港口、机场、物流园和门店的位置都按这个区域 |
| `--load` | normal | 负荷档位：normal 平常、peak 高峰、high 高负荷、extreme 极限（需求、班轮、班列、航班一起加；设施用默认配置） |

测试客户端：`npx tsx server/client.ts 8787`（查健康、模型、状态、建议卡，用 WebSocket 收几帧，批准一张待处理的建议卡）。

## 坐标

- 服务里的位置都是「沙盘坐标」：单位米，x 向东、z 向南、y 向上（three.js 的右手系）。区域的距离压缩成 1/10（1 公里画成 100 米），建筑和车辆按真实尺寸。
- 车头朝向 `heading`：度，0 = 向东（+x），90 = 向南（+z），从上往下看顺时针。
- **虚幻引擎**（厘米、左手系、Z 向上）：`X = x × 100`，`Y = z × 100`，`Z = y × 100`，`Yaw = heading`。x 向东、z 向南在左手系里正好是 X 向东、Y 向南，朝向不用换号。
- 车辆的位置是车道级的：和网页三维用同一套道路网（车道、路口、立交、环岛）、同一套停靠点（月台门、门店收货口、车场）和运动规划（开过门再倒车靠上），所以虚幻引擎里画的位置和网页一样。位置取的是车头（领先点）；倒车时 `reversing = true`，朝向仍然是车头的方向。

## REST

所有接口返回 JSON。默认不回跨域头（`--allow-origin` 列的浏览器来源才回，见「安全」）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, t, clock }`，t 是当天 0 点起的秒 |
| GET | `/api/model` | 静态的模型：方案、种子、现场状况、区域 `region` 和负荷档位 `load`、坐标说明、门店（中心、朝向、4 个收货口的位置）、配送中心 38 樘月台门的位置、道路节点、商品族（温区、货源、是否直送门店）、当天的车辆和对应的作业编号 |
| GET | `/api/state` | 此刻：`t`、`clock`、`speed`、`paused`、累计指标 `kpi`、路上每辆车 `vehicles`、门和收货口被谁占着 `doors`、门店每个商品族的库存（孪生估计 `est` / 现场实际 `truth`）、待处理的建议卡数 |
| GET | `/api/messages?since=0&limit=1000` | 现场发出的感知数据（从第 since 条起），返回 `{ next, total, msgs }`，下次用 next 接着取 |
| GET | `/api/recommendations` | 当天的全部建议卡（见下面的结构） |
| GET | `/api/vehicle?vid=19` | 一辆车的详细信息：此刻的位置和状态，加上从哪来、到哪去、计划出发 / 到达、下一站和预计到达、载重、货物、每个停靠站的计划和预计到达（结构见下） |
| POST | `/api/approve` | `{ key, option? }`：批准一张待处理的建议卡（不给 option 就执行推荐的做法），此刻生效 |
| POST | `/api/reject` | `{ key }`：否决一张待处理的建议卡 |
| POST | `/api/command` | 一条指令（结构见下），直接发给现场，此刻生效 |
| POST | `/api/control` | `{ speed?, paused? }`：改速度、暂停 / 继续 |
| GET / POST | `/api/assistant?q=…&role=…`（POST 用 `{ question, role }`） | 值班助手：和网页同一个助手，读服务里此刻的计划、闭环和四个仓储中心（港口物流中心、机场货站、物流园、门店）的作业计划；`role` 是提问人的角色（结构见下） |
| GET | `/api/assistant/tools` | 值班助手的查询工具（名字、说明、参数的 JSON Schema），以后接语言模型时直接用 |
| GET | `/api/watch` | 此刻要关注的事（紧急的在前），能处理的附带提议 |
| GET | `/api/handover?shift=dawn\|day\|mid\|night` | 交接班报告（不给 shift 写此刻的班；班次刚开始半小时内写刚结束的那一班），带 Markdown |
| GET | `/api/review` | 建议复盘：到此刻处理完的建议卡，孪生预测的和现场实际的比，按类别统计 |
| GET | `/api/kpi` | 分层看板：集团、区域、设施、作业四层指标此刻的值和状态（ok / warn / alarm / na，和网页的默认阈值一样；服务里没有设施监控，港口闸口、堆场、月台门那几项是 na） |

### 车辆（`/api/state` 的 `vehicles[]`、WebSocket 的 `tick`）

```json
{ "vid": 19, "id": "M04", "kind": "reefer", "label": "多温区配送车 · 24 托",
  "x": 252.08, "z": -261.84, "heading": 135, "reversing": false,
  "act": "开往综合店", "delayMin": 47, "temp": 2.3, "state": "抛锚",
  "from": "物流园配送中心", "to": "综合店", "depart": 27000, "arrive": 30720,
  "next": "综合店", "nextPlan": 28980, "eta": 31800,
  "load": "24 托 · 3,100 件 · 6.2 吨", "kg": 6200, "cargo": "冷藏、冷冻、常温" }
```

- `kind`：truck 常温车 / 长途整车、reefer 冷藏和多温区车、ev 电动配送车、van 线上配送车和面包车、drayage 集装箱拖车、train 火车、ship 船、plane 飞机；
- `delayMin`：比计划晚了多少分钟；`temp`：冷机车的货温（°C）；`state`：抛锚、等救援车、等月台门、等收货口、按指令晚点到（空 = 正常）；
- `from` / `to`：出发地、最终目的地；`depart`：计划出发时刻；`arrive`：计划到达最后一站的时刻（都是当天 0 点起的秒）；
- `next`：下一个要到的地方；`nextPlan`：计划到达那里的时刻；`eta`：预计到达——去门店的那一站用孪生按感知数据的估计（考虑路况、收货口有没有空），其余按定位算出的延误顺延；
- `load`：载重（托盘、件数、吨；火车、船、飞机是箱数 / 板数）；`kg`：重量（公斤，能算的才有）；`cargo`：装的什么货；
- 孪生派出来的车（救援车、追加补货车）的 `vid` 接在当天车辆的后面。

`/api/vehicle?vid=19` 在上面这些字段之外再给 `stops`：每个停靠站的 `name`、计划到达 `plan`、还没到的站的预计到达 `eta`、是否已经过了 `passed`。港口、机场、物流园、门店收货区的设备和作业进度（岸桥、龙门吊、平台车、月台门、叉车、堆垛机等）在网页的「设施监控」面板里看，按同一份计划在浏览器里算。

### 感知数据（`msgs[]`）

| kind | 字段 | 频率 |
| --- | --- | --- |
| `gps` | vid, x, z | 每辆车每分钟（有几米误差） |
| `event` | vid, ev（depart / arrive / leave / fault / fixed / ack / done / eta）, place?, code?, note?, fam?, units?, eta? | 发生时；长途车（直送门店、进配送中心）进区域前 4 小时起每小时报一次 `eta`（预计进区域的时刻，当天的秒） |
| `temp` | vid, air, product, set, door, cool | 冷机车每 5 分钟 |
| `load` | vid, door, done, total | 装车时每 5 分钟（扫描托盘） |
| `door` | door（C01…、D01…、S01-1…S01-4）, open, vid | 靠上 / 离开时 |
| `pos` | store, fam, units | 每 15 分钟每个商品族 |
| `stock` | store, fam, units | 每小时每个商品族 |
| `traffic` | id, x, z, r, factor, until, text, end? | 事故 / 施工开始和结束 |
| `soc` | vid, soc | 电动车每 10 分钟 |

WebSocket 推送时不带 gps 和 pos（量太大），要全部数据用 `/api/messages` 取。

### 建议卡（`/api/recommendations`、WebSocket 的 `cards`）

```json
{ "key": "breakdown:19", "kind": "breakdown", "t": 27300, "clock": "07:35",
  "title": "M04 抛锚", "text": "…", "status": "proposed", "best": "wait",
  "options": [
    { "key": "rescue", "label": "派救援车接走车上的货", "late": 0, "hot": 0, "short": 0, "cost": 238,
      "note": "救援车约 53 分钟后到，转运 30 分钟", "auto": false, "hasCommands": true },
    { "key": "wait", "label": "等修好（约 1.5 小时）", "late": 0, "hot": 0, "short": 0, "cost": 0,
      "note": "门店合计晚 0 分钟", "auto": true, "hasCommands": false } ] }
```

- `kind`：late 预计迟到、temp 温度将超标、breakdown 车辆抛锚、door 月台门要等、stockout 门店将缺货；
- 每个做法都有孪生推演的结果：迟到分钟、超温分钟、缺货分钟（按商品族累计）、多花的钱（美元）；推荐的是合计分（迟到 + 超温 × 2 + 缺货 × 1.5 + 钱 ÷ 12）最低的；`auto` = 低风险，「低风险的自动执行」时自动执行；
- `status`：proposed 待处理、done 已执行（`by` = auto / user，`chosen` = 执行的做法）、rejected 否决、resolved 问题自己没了、expired 没处理而问题真的发生了。

### 指令（`/api/command` 的请求体、WebSocket 的 `cmd`）

| kind | 字段 | 说明 |
| --- | --- | --- |
| `notifyStore` | store, until | 通知门店把收货截止顺延到 until（秒） |
| `resequence` | vid, order | 车上剩下的门店按新顺序送 |
| `rescue` | vid | 派救援车接走抛锚车 / 冷机坏了的车上的货 |
| `driverCheck` | vid | 提醒司机停车检查车门密封 |
| `setpoint` | vid, delta | 远程调冷机设定温度（相对标准值，最多 −2 °C） |
| `reassignDoor` | vid, door | 把要等门的车改到别的月台门 |
| `restock` | fam, units | 配送中心追加一趟小车给门店补某个商品族 |
| `divert` | vid, to（store / DC） | 长途进配送中心的车改直送门店，或直送车改送配送中心 |
| `hold` | vid, until | 让车晚点到（在路边等到 until） |

### 值班助手（`/api/assistant`）

```json
{ "t": 39600, "clock": "11:00", "q": "批准第一条", "intent": "approve", "confidence": 1,
  "text": "要执行的是：执行「通知综合店顺延收货」（DS-BEV-2 到综合店预计晚 231 分钟）。…",
  "cites": ["闭环孪生（现场的感知数据和孪生的估计）"],
  "links": [{ "kind": "card", "key": "late:2:S01", "label": "看建议卡" }],
  "proposals": [{ "id": "p12", "title": "执行「通知综合店顺延收货」（…）", "effect": "推演结果：多花 $25；不处理的话迟到 231 分钟。…",
                  "risk": "high", "cost": 25, "actions": [{ "kind": "decide", "key": "late:2:S01", "action": "approve", "option": "notify" }],
                  "requests": [{ "method": "POST", "path": "/api/approve", "body": { "key": "late:2:S01", "option": "notify" } }] }],
  "followups": ["为什么推荐第一条"], "tools": [{ "name": "propose_decision", "args": { "keys": ["late:2:S01"], "action": "approve" } }] }
```

- 助手只读：要改的只给提议，`requests` 是执行它要调的接口，由调用方（人确认以后）去调；调度台的修法要重新仿真，服务里不能执行；
- `intent` 是意图（规则 + 逻辑回归分类，朴素贝叶斯只留着做对比；拿不准时问一句），`tools` 是调用了哪些查询工具；数字全部来自工具的结果；
- 服务里没有设施监控（港口、机场、物流园的设备在网页里按计划算），问设施时只回答和它有关的作业。

每个回答还按四段给出（网页的助手面板就按这四段排）：

```json
{ "q": "DS-BEV-2 为什么晚了", "intent": "rootcause",
  "conclusion": "DS-BEV-2 到店开始卸货时（10:09）按计划在走，没有晚（比计划差不到 1 分钟）。",
  "basis": { "tools": [{ "name": "explain_delay", "cite": "闭环孪生（现场的感知数据和孪生的估计）：每分钟的延误、车载终端事件、路况、调度指令" }],
             "asOf": 38160, "quality": { "level": "good", "label": "良好", "text": "…" } },
  "certainty": { "value": 0.88, "level": "高", "intent": 0.98, "data": 1, "model": 0.9, "notes": ["原因按每分钟的延误增量逐分钟归因…"] },
  "next": [{ "text": "可以接着问：「现在有什么风险」" }],
  "grounding": { "total": …, "grounded": …, "missing": [] },
  "entities": { "vehicles": ["DS-BEV-2"], "fams": [], "doors": [] },
  "data": [{ "…": "各个工具返回的结构化结果" }] }
```

- `conclusion` 一句话结论；`basis` 用了哪些工具、数据截至几点（当天的秒）、数据质量；`certainty` 把握 = 意图分类的把握 × 数据质量 × 模型验证；`next` 下一步做什么、要谁批；
- `grounding` 是数字核对：回答里的每个数字、时刻、编号都要在工具结果（或问题、规则表）里找到出处，`missing` 不为空就是缺陷（评测见 [`docs/results/assistant-eval.md`](../docs/results/assistant-eval.md)）；
- 问题缺了车、建议卡或仓储中心时回 `clarify: { question, options }`，不猜；超出范围的回 `declined: true` 并说明能做什么；要求跳过确认、审批的回 `refused: true`，提议照样要人确认；
- `role` 取 `dispatcher`（调度员，默认）、`manager`（站长）、`regional`（区域经理）、`viewer`（只读），不认识的按默认；提议里的 `need` 是要谁执行或批准，`checks` 是给出提议前按规则表（`src/assistant/policy.ts`：角色和金额、冷链等待、数据质量、批量）检查的结果，违反硬性规定的提议不给出，数据较差时 `manualOnly: true`（只能人工逐条核实后执行）；
- 服务里有四个仓储中心当天的作业计划，第一次问到时排一次：港口物流中心（`src/hub/port.ts`）、物流园（`src/hub/park.ts`，车停哪个门按调度台的作业，`src/hub/doors.ts`，和网页同一份对应）、门店停车场和收货场（先跑一天门店仿真，`src/hub/storeDay.ts`；停车场里的车流不排，停车时段按车位安排）和网页按同一套模型排；机场货站没有三维的机坪排程，当天的航班和板的进出按 `src/hub/airportEstimate.ts` 估（数和网页会差一点）。`get_hub`、`trace_own_cargo`、`hub_bottlenecks`、`plan_appointments` 都能查这四个；门店的预约错峰用收货场的场地排程器（`@storewright/yard`（`packages/yard`））算挪之前、挪之后，其他设施用先到先服务的排队模型估，回答里写明是哪个。
- `what_if` 也推演临时扰动：某趟车（或班轮、班列、航班，接它的车跟着顺延）晚 N 分钟、某个月台门停用一段时间、一段路封闭。用服务里闭环孪生同一份现场输入，同一个随机种子跑两遍（都不采取措施），比到当天结束的迟到、超温、缺货、等门分钟和成本；只读，不执行任何东西。
- 角色只按请求里的 `role` 算：问题里说「我是经理」「领导授权了」「出了事我担着」「回头补签」不改变角色，带着这类说法要执行、批准的回 `refused: true` 并说明；批准还是否决按问题里的说法定，说不清的先问。

## WebSocket：`ws://主机:端口/ws`

服务推送：

- `{ "type": "hello", "model": …, "state": … }`：连上时发一次；
- `{ "type": "tick", "t", "clock", "kpi", "vehicles", "doors" }`：每走一分钟（按速度，最多每 250 毫秒一次）；
- `{ "type": "msgs", "msgs": [...] }`：新的感知数据（不含 gps、pos）；
- `{ "type": "cards", "cards": [...] }`：状态变了的建议卡；
- `{ "type": "reply", "ok", "card"?, "error"? }`：对客户端消息的回复。

客户端可以发：

```json
{ "type": "approve", "key": "breakdown:19", "option": "rescue" }
{ "type": "reject", "key": "temp:20" }
{ "type": "command", "cmd": { "kind": "restock", "fam": "DAIRY", "units": 2000 } }
{ "type": "control", "speed": 60, "paused": false }
{ "type": "ingest", "adapter": "wms", "data": "ts,event,site,door,vehicle_ref,done,total,family,units\n…", "token": "<密钥>" }
```

`ingest` 是实时接入（数据来源是 live、watch 时才收），见「对接真实系统」的「实时接入」。

## 安全

- **只听本机**：默认 `--host 127.0.0.1`。`--host` 不是本机（127.0.0.1、localhost、::1）又没有设 `--token` 时拒绝启动；确实要在没有密钥的情况下对外开放，加 `--insecure`（启动时警告）。对外开放最好再放到有 HTTPS 的反向代理后面。
- **访问密钥**：`--token <一长串随机字符>`（或环境变量 `STOREX_TOKEN`）。设了以后，改状态的接口——`POST /api/approve`、`/api/reject`、`/api/command`、`/api/control`——要带请求头 `Authorization: Bearer <密钥>`（或 `x-ingest-token: <密钥>`），没带或不对回 401；WebSocket 的指令（approve、reject、command、control）要么连接时带（最好放在请求头里；没法设请求头的客户端可以写在网址里 `ws://主机:端口/ws?token=<密钥>`，只在本机或 TLS 上这样用，UE 插件把它写进 ServerUrl 就行），要么每条消息里带 `"token": "<密钥>"`，否则回 `{ "type": "reply", "ok": false }`。只读的查询（状态、模型、消息、值班助手）不要密钥。实时接入（`/api/ingest/*`、WebSocket 的 ingest）用 `--ingest-token`，没单独设就用访问密钥。
- **浏览器来源**：默认不回跨域头（以前的 `access-control-allow-origin: *` 去掉了）。浏览器发来的请求（带 `Origin` 请求头的）改状态、连 WebSocket 时，来源要在 `--allow-origin` 列表里（服务自己的地址也算），否则回 403；列表里的来源才回跨域头。本机脚本（`server/client.ts`）、UE 插件、MATLAB 客户端不带浏览器来源，照常能用。
- **请求体和参数**：JSON 请求体上限 64 KB（超过回 413），不是 JSON 对象回 400；网址里的数字参数（`since`、`limit`、`vid`）不是数回 400。
- 本机默认（只听本机、不设密钥）的用法和以前一样：`server/client.ts`、UE 插件（`ws://127.0.0.1:8787/ws`）、MATLAB（`http://127.0.0.1:8787`）不用改；设了密钥时，`server/client.ts` 和 MATLAB 要加上 `Authorization` 请求头（MATLAB 用 `weboptions('HeaderFields', {'Authorization', 'Bearer <密钥>'})`）。

## 可选的大模型模式

设了 `STOREX_LLM`（`claude` 或 `local`）时，`/api/assistant` 由大模型组织语言、调值班助手的工具回答；回答里的 `engine` 写明是哪个引擎答的（`builtin`、`claude`、`local`），出错退回内置时 `engineNote` 写原因。没设时和以前一样。设置、隐私和费用见 [docs/06-llm-option.md](../docs/06-llm-option.md)。网页面板的「本机孪生服务」引擎要服务启动时加 `--allow-origin http://localhost:5173`。

## 说明

- 服务默认只监听本机；访问密钥、浏览器来源、请求体上限见「安全」。
- 时间都是仿真那一天 0 点起的秒；一天走完后时钟停在 24 点（重启服务换一天或换现场状况）。
- 本项目与任何零售商、企业无隶属关系；数据都是合成的。

## 对接真实系统

孪生服务的数据默认来自服务里模拟的现场。`server/adapters/` 加了一层接口，让同一个孪生（同样的估计、推演、建议卡和自动执行）改吃外部系统的数据：运输管理系统（TMS）、仓储和门店系统（WMS）、港口电子数据交换（EDI）。数据可以是一份记录、一个目录里的文件，也可以由外部系统实时推进来（`/api/ingest`）或者让服务盯着一个目录读追加的部分。不管数据从哪来，上面的 REST 和 WebSocket 接口都一样。

```bash
# 记录：模拟的现场跑一天，把孪生收到的每条数据记下来（.gz 结尾的压缩）
npx tsx server/twinServer.ts --record day.jsonl.gz --start 0
# 回放：孪生在这份记录上再跑一遍（计划按记录里的方案、种子、区域、负荷、哪一天、自动执行的范围）
npx tsx server/twinServer.ts --source replay:day.jsonl.gz
# 外部系统的文件：tms*.jsonl / *.json → 运输管理，*.csv → 仓储和门店，*.edi → 港口；meta.json 写对应的计划
npx tsx server/twinServer.ts --source feed:server/adapters/samples --outbox outbox.jsonl
# 实时接入：外部系统往 /api/ingest/tms|wms|edi 推数据（live: 后面是对应计划的 meta.json，可以不写）
npx tsx server/twinServer.ts --source live:server/adapters/samples/meta.json --speed 600
# 发送脚本：把样例按数据自己的时刻推过去（每秒推 60 分钟的数据；0 = 尽快推完）
npx tsx server/adapters/send.ts --to http://127.0.0.1:8787 --from server/adapters/samples --speed 60
# 盯着一个目录：新文件从头读、已有的文件读追加的部分（目录里的 meta.json 写对应的计划）
npx tsx server/twinServer.ts --source watch:/path/to/drop-folder
# 样例数据（模拟一天写成三个接口的格式和一份记录，合计约 290 KB）
npx tsx server/adapters/samples.ts
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--source` | sim | `sim` 服务里模拟的现场（和以前完全一样）；`replay:<文件>` 一份记录；`feed:<目录>` 外部系统的文件；`live` 或 `live:<meta.json>` 外部系统实时推数据；`watch:<目录>` 盯着目录读新文件和追加的部分 |
| `--ingest-token <密钥>` | 不要密钥 | 实时接入要带的共享密钥（也可以用环境变量 `STOREX_INGEST_TOKEN`，免得出现在进程列表里）。服务不只听本机（`--host` 不是 127.0.0.1）时这是最低限度 |
| `--lateness <秒>` | 60 | live、watch：允许数据晚到多少秒，孪生最多走到「收到的最新数据的时刻 − 这么多」 |
| `--record <文件>` | 不记 | 把孪生收到的数据、新出现或改了计划的车、发出的指令写成 JSON Lines（任何来源都可以记） |
| `--outbox <文件>` | 不写 | 孪生的指令换算成外部系统的指令，追加写进这个文件（JSON Lines），`/api/outbox` 也能取 |
| `--geo-origin 纬度,经度` | 0,0 | 经纬度和沙盘坐标换算的原点（默认是合成的原点，不对应任何真实地点）；也可以写在 meta.json 的 `geoOrigin` 里 |

回放和外部系统的数据带着它对应的计划：命令行指定了 `--gen`、`--seed`、`--region`、`--load`、`--policy` 的按命令行，没指定的按记录的表头或 meta.json。live、watch 默认从 0 点开始（`--start` 指定了的先快进到那里，之前的数据算晚到）。

### 现实是记录或外部系统时

- 闭环照常一分钟一步：每一步把这一步该到的数据交给孪生（记录按孪生当时在哪一步收到；外部系统按数据自己的时刻），孪生照常估计、推演、出建议卡、按自动执行的范围发指令。
- 指令改变不了现实：记下来、换算成外部系统的指令放进发件箱。指令带来的新车（救援车、追加补货车）和改了的计划，由记录或运输管理系统的「新行程」登记给孪生。
- 接口里要的「现场」按数据推出来：车的位置按孪生估计的进度（计划时钟 = 此刻 − 估计的延误）；月台门、门店收货口按门磁；门店库存按最近一次盘点减去之后的收银；本店的箱按港口 EDI 的事件；累计的结果里，迟到按门店收货口开门（开始卸货）的时刻和收货截止比，超温按冷机读数（每 5 分钟一条），缺货按看到的库存，处理措施的钱按执行的做法推演的。
- 等月台门、等收货口按门磁推：车到了配送中心（到达事件；计划从装车、卸货开始的车按当天第一条数据算进场）或门店（到达事件），按计划该装卸的时刻到了（计划里先在场地停的往后推，门店还没开门的等到开门），它的月台门被别的车占着（门店：收货口全被别的车占着），从那时起到它自己的门（收货口）打开算等的时间；`/api/state` 里车的状态照样显示「等月台门」「等收货口」。和模拟的现场比，每辆车差 1 分钟以内（`tests/adapters.test.ts`）。收货口的个数按设施配置，数据里出现更大的编号按数据。
- 同一份记录、同样的自动执行范围、调度员不插手时，回放出的建议卡和指令和记录时完全一样（`tests/adapters.test.ts` 逐张比对）；调度员在不同的时刻批准或否决，之后就会和记录时不一样（现实还是那份记录）。

### 实时接入（live、watch）

外部系统一边发生一边推数据，服务按数据自己的时刻交给孪生。三个入口用的是同一套接口和检查（格式见下面三节）：

| 方法 | 路径 | 正文 |
| --- | --- | --- |
| POST | `/api/ingest/tms` | 运输管理：JSON Lines（一行一条），或一个 JSON 数组 |
| POST | `/api/ingest/wms` | 仓储和门店：带表头的 CSV，或 JSON（一个数组、或一行一个对象，键和 CSV 的列名一样，`vehicle_ref` 也可以写成 `vehicleRef`） |
| POST | `/api/ingest/edi` | 港口：EDIFACT 文本（一份交换文件，可以有好几个报文） |

```bash
curl -X POST http://127.0.0.1:8787/api/ingest/tms -H 'x-ingest-token: <密钥>' --data-binary @tms.jsonl
```

```json
{ "ok": true, "adapter": "tms", "accepted": 1025, "rejected": 1,
  "reasons": [{ "at": "第 7 行", "reason": "不认识的车辆编号" }], "queued": 812, "newest": 61200 }
```

`accepted` / `rejected` 是这一批收了、拒了几条（`reasons` 最多列 20 条），`queued` 是孪生还没走到、排着队的条数，`newest` 是收到的数据里最新的时刻（秒）。状态码：401 密钥不对，404 没有这个接口，409 数据来源不是 live / watch，413 一次超过 16 MB。

WebSocket 也可以推：`{"type":"ingest","adapter":"tms","data":"…文本…","token":"<密钥>"}`（运输管理、仓储系统的 `data` 也可以直接是 JSON 数组；连接时请求头带了 `x-ingest-token` 的，消息里可以不带 `token`），回复 `{"type":"reply","ok":true,"accepted":…,…}`。

- 时间：孪生按收到的数据走，不跑到数据前面——走到「收到的最新数据的时刻 − `--lateness`（默认 60 秒）」为止；`--speed` 这时是最快的速度。数据停了孪生就停在那里（`/api/adapters` 里每个接口最后一条数据的时刻能看出谁停了）。
- 晚到、顺序乱的数据和「数据质量」通道一样处理：孪生已经走过了时刻的（晚到的）下一步交给它、按发生的时刻补记；比已经交给孪生的同一辆车的定位还旧的（过时的）不用。晚到的门磁、盘点、故障不改「现在」的状态（比已经用上的还旧）。`/api/adapters` 每个接口多了 `late`（晚到）、`outOfOrder`（比这个接口已经收到的最新一条还旧）、`stale`（过时没用上的定位）三个数。
- 时刻不在孪生这一天的（早于前一天 18 点、晚于第二天 2 点）不收，免得一条日期写错的数据把孪生的时钟带跑。
- 新行程（`trip`）要比用到它编号的记录先推（同一批里运输管理会先处理新行程）；发送脚本每一批按接口分开推，运输管理在前。
- watch：每秒读一遍目录，新文件从头读、读过的文件只读追加的部分，只交出完整的记录（整行、整个 EDIFACT 报文），半行留到下次；接着读的部分补上文件开头的 CSV 表头、EDI 服务字符串。文件被截短或换掉了从头再读；`*.json`（一个数组）整个文件读一次。推送入口在 watch 时也收。记录（`--record`）、发件箱（`--outbox`）的文件别写进盯着的目录。
- 安全：服务默认只听本机（127.0.0.1）。要让别的机器推数据，最低限度是 `--ingest-token`（一长串随机字符），推数据的请求带请求头 `x-ingest-token: <密钥>`（或 `Authorization: Bearer <密钥>`）；最好再放到有 HTTPS 的反向代理后面。密钥优先放在请求头里：WebSocket 网址上的 `?token=` 是给没法设请求头的客户端用的，只在本机或 TLS（HTTPS / WSS）上用，因为网址容易留在日志里。服务听的不是本机又没设访问密钥（`--token` 或 `STOREX_TOKEN`）时拒绝启动，除非加 `--insecure`（见「安全」）。
- 发送脚本 `server/adapters/send.ts`：把一个目录里的 `*.jsonl`、`*.csv`、`*.edi` 拆成一条条带时刻的记录，按时刻推过去。`--speed` 每秒推几分钟的数据（0 = 尽快推完），`--token` 密钥（或环境变量），`--start` / `--end` 只推几点到几点的数据，`--max` 一批最多几条（默认 2000）；推完打印每个接口收了、拒了多少和原因。

### 记录的格式（JSON Lines）

| type | 字段 | 说明 |
| --- | --- | --- |
| `meta` | version, gen, seed, level, policy, region, load, day, created | 表头：对应的计划 |
| `msg` | step, msg | 孪生在哪一步（那一步开始的时刻，秒）收到的哪条感知数据，按收到的先后 |
| `vehicle` | eff, vid, v, extra?, replan? | 新出现（救援车、追加补货车）或改了计划的车：从哪一步起生效、车辆下标、计划的轨迹 |
| `cmd` | cmd | 孪生发出的指令（只做参考，回放时不当作现实） |

### 时间、坐标和车辆编号

- 时间：外部系统用「日期 + 当地时间」（ISO 8601，不带时区，可以带毫秒），仿真那一天用合成的日期 2030-03-28（第二天凌晨就是 2030-03-29）。
- 坐标：外部系统用经纬度，按原点做等距圆柱投影换成沙盘坐标（现实的 1 米 = 沙盘的 0.1 米）。
- 车辆编号：按调度台上的作业编号（M02、DS-BEV-1、VS1……）；孪生派出来的车由「新行程」登记：救援车 `RS-原车编号`，追加补货车 `RT-商品族-下标`。门店、配送中心、港口这些地点用孪生里的编号（S01、DC、PORT……）。

### 运输管理系统（TMS，JSON Lines）

| type | 字段 | → 感知数据 |
| --- | --- | --- |
| `position` | ts, vehicleRef, lat, lon | `gps` |
| `status` | ts, vehicleRef（门店的确认是 null）, status, location?, code?, note?, family?, units? | `event`：DEPARTED → depart，ARRIVED → arrive，LEFT → leave，BREAKDOWN → fault（ENG），REEFER_FAULT → fault（COMP），REPAIRED → fixed，INSTRUCTION_ACK → ack，TASK_DONE → done |
| `eta` | ts, vehicleRef, eta, note? | `event`（eta：长途车预计进区域的时刻） |
| `reefer` | ts, vehicleRef, airTemp, productTemp, setPoint, doorOpen, compressorOn | `temp` |
| `battery` | ts, vehicleRef, soc（0–1） | `soc` |
| `incident` | ts, incidentRef, lat, lon, radiusM（现实的米）, travelFactor, until, text, cleared? | `traffic` |
| `trip` | ts, vehicleRef, kind, label, purpose（rescue / restock / replan）, forRef?, family?, units?, loadAt?, segments[{start, end, path[[lat, lon]…], act?, place?, nodes?, loop?, yaw?}] | 登记新行程或改了的计划（同一个文件里先处理） |

```json
{"type":"position","ts":"2030-03-28T09:30:00","vehicleRef":"M02","lat":0.0231877,"lon":0.0590271}
{"type":"status","ts":"2030-03-28T09:41:00","vehicleRef":"M02","status":"ARRIVED","location":"S01"}
{"type":"reefer","ts":"2030-03-28T09:45:00","vehicleRef":"M04","airTemp":3.412,"productTemp":3.902,"setPoint":3,"doorOpen":false,"compressorOn":true}
```

孪生的指令 → TMS 的调度指令（`{"type":"instruction","id":"TI-00001","ts":…,"action":…}`）：resequence → RESEQUENCE（stops），hold → HOLD_UNTIL（until），divert → DIVERT（to），rescue → DISPATCH_RESCUE，notifyStore → NOTIFY_STORE（storeRef、receiveUntil），driverCheck → DRIVER_CHECK，setpoint → REEFER_SETPOINT（deltaC）。

### 仓储和门店系统（WMS，CSV）

列：`ts,event,site,door,vehicle_ref,done,total,family,units`（第一行是表头；格子里有逗号、引号时用双引号括起来）。

| event | 用到的列 | → 感知数据 |
| --- | --- | --- |
| DOOR_OPEN / DOOR_CLOSE | site（DC 或门店编号）, door（C01…、D01…、S01-1…）, vehicle_ref | `door`（等月台门、等收货口按它推） |
| LOAD_SCAN | door, vehicle_ref, done, total（托） | `load` |
| STOCK_COUNT | site（门店）, family, units | `stock`（货架 + 后仓） |
| SALES | site（门店）, family, units | `pos`（过去 15 分钟卖出的件数） |

孪生的指令 → 仓储系统的任务：reassignDoor → `{"task":"DOOR_REASSIGN","vehicleRef":…,"door":…}`，restock → `{"task":"REPLENISH","to":"S01","family":…,"units":…}`。

### 港口电子数据交换（EDI，UN/EDIFACT 的简化子集）

按 UN/EDIFACT 的语法（UNA 服务字符串、段 `'`、元素 `+`、成分 `:`、释放字符 `?`）读写本店集装箱在港口的事件。报文类型、段的用法和代码是本项目的约定，不是任何码头、船公司的实施指南。

| 报文 | 代码 | 事件 | → 感知数据（地点 PORT，备注写事件和箱号） |
| --- | --- | --- | --- |
| CODECO | BGM 34 / 36 | 进闸 / 出闸 | `event` arrive / leave（拖车） |
| COARRI | BGM 44 / 45 | 卸船 / 装车（装上班列或拖车） | `event` done（船、班列或拖车） |
| IFTSTA | BGM 23，STS CR / HD | 海关放行 / 海关查验 | `event` done（vid = −1，不对应车辆） |

每个报文：`UNH`、`BGM`、`DTM+137`（报文时间）、`TDT`（运输方式 1 海运 / 2 铁路 / 3 公路，最后一个元素是车船编号）、`LOC+165`（地点）、每个箱一组 `EQD`（箱号、尺寸类型、5 重箱 / 4 空箱）+ `DTM+203`（事件时间，格式 204：年月日时分秒）+ `STS`（只有 IFTSTA）、`CNT`、`UNT`（段数）。箱号按 ISO 6346 检查校验位；样例的箱号是合成的（箱主代码 SXC）。

```
UNH+2+COARRI:D:95B:UN'
BGM+44+CO00002+9'
DTM+137:20300328023253:204'
TDT+20++1+++++VS1'
LOC+165+PORT'
EQD+CN+SXCU0860010+45G1:102:5+++5'
DTM+203:20300328023253:204'
CNT+16:1'
UNT+9+2'
```

这些事件进数据流（`/api/messages`）和接口统计；孪生的估计不按箱算。「看到的现场」按箱号记下本店每个箱现在的状态：已卸船等海关放行、海关查验中、海关已放行等装车提走、已装上班列或拖车、已出闸（事件按发生的时刻排，晚到的插回原位，重发的同一条只记一次），`/api/containers` 能查，值班助手的「港口怎么样」也多一行本店的箱。

```json
{ "t": 36000, "clock": "10:00", "source": "live", "summary": { "total": 3, "byState": { "海关已放行，等装车提走": 2, "已卸船，等海关放行": 1 } },
  "containers": [{ "id": "SXCU0860047", "state": "discharged", "label": "已卸船，等海关放行", "since": 28568, "sinceClock": "07:56",
                   "customs": "pending", "vehicle": "VS1", "events": [{ "t": 28568, "clock": "07:56", "code": "DISCHARGE", "note": "卸船" }] }] }
```

### 坏数据

每个接口逐条检查，坏的跳过并按原因计数，服务不会因此停下：不是合法的 JSON、不认识的记录类型、时间格式不对、不认识的车辆编号、坐标不对、不认识的状态、读数或数值不对、列数不对、缺门号或商品族、段数和 UNT 不符、不支持的报文类型、箱号校验位不对、文件不完整。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 多了 `source`：sim / replay / feed / live / watch |
| GET | `/api/model` | 多了 `source`：来源、文件或目录、每个文件收了几条拒了几条、在记录的文件；live、watch 还有排队的条数（queued）、收到的最新数据的时刻（newest）、允许晚到的秒数（lateness） |
| GET | `/api/adapters` | 每个接口：收了多少（accepted）、拒了多少（rejected）和原因（reasons）、最后一条数据的时刻（lastAt / lastClock）、延迟（孪生收到的时刻 − 数据的时刻，平均和最大，秒）、晚到（late）、顺序乱（outOfOrder）、过时没用上的定位（stale）、发出去多少指令（sent）；发件箱里有多少条 |
| POST | `/api/ingest/tms`、`/api/ingest/wms`、`/api/ingest/edi` | 实时接入（见上面「实时接入」） |
| GET | `/api/containers` | 本店的箱在港口的状态（数据来自外部系统、接了港口 EDI 才有） |
| GET | `/api/outbox?since=0` | 发件箱：从第 since 条以后，每条有 seq、t、adapter（tms / wms）、孪生的指令 cmd、换算好的外部指令 out；返回 `{ next, list }`，下次用 next 接着取 |

```json
{ "t": 32400, "clock": "09:00",
  "source": { "mode": "feed", "dir": "samples", "files": [{ "name": "tms.jsonl", "adapter": "tms", "accepted": 1025, "rejected": 0 }] },
  "adapters": [{ "name": "tms", "label": "运输管理（TMS）", "accepted": 1025, "rejected": 0, "reasons": {}, "lastAt": 32400, "lastClock": "09:00",
                 "latency": { "avg": 0.4, "max": 60, "unit": "秒（仿真时间：孪生收到的时刻 − 数据的时刻）" }, "late": 0, "outOfOrder": 0, "stale": 0, "sent": 1 }],
  "outbox": 1 }
```

### 现在的限制

- 时间只认合成的日期（2030-03-28 起的这一天），接真实系统要先把日期换过来；孪生只跑一天（0 点到第二天 2 点）。
- 推送没有消息编号：重发的数据会重复计入（定位除外——比已经用上的旧就不用；港口的箱事件重发只记一次），推送方要自己避免重发。
- 孪生按收到的最新时刻走：某个系统的时钟快了，别的系统的数据就会晚到；数据停了孪生也停。只有共享密钥，没有分用户的权限和 HTTPS（要放到反向代理后面）。
- 回放和外部数据模式里看不到「真值」：等门、等收货口按门磁推（进场的时刻要有到达事件，计划从门上开始的车按第一条数据算，和模拟的现场比每辆车差 1 分钟以内）；缺货按盘点和收银推，粒度是 5 分钟。
- 孪生的估计不按箱算港口作业（箱的状态只给 `/api/containers` 和值班助手看）；EDI 是本项目约定的简化子集。
