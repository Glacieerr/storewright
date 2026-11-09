# 怎么扩展 · Extending StoreX Chain

> 适用于第三部分 StoreX 全链路。[系统设计 §13](04-system-design.md#13-怎么扩展) 列了扩展的要点，先列出不改代码也能用的接口，再把最常见的七种扩展写成步骤，每种都按「要改的文件 → 最小示例 → 测试和自检」来写。示例照着现有代码的结构写；示例里新起的名字（`cold-hub`、`late40`、`battery`、`parseGate`、`terrain`……）只是举例。术语见[术语表](glossary.md)，结果数据的字段见 [DATA.md](results/DATA.md)。
>
> 本项目与任何零售商、企业无隶属关系；扩展时同样只用公开资料和合成数据（见仓库根目录的 [CONTRIBUTING.md](../../CONTRIBUTING.md) 和 [COMPLIANCE.md](../../COMPLIANCE.md)）。

## 不改代码也能用的接口 · Using it without changing the code

想把这个项目的某一块拿去用，先看这几个现成的接口（不用 fork、不用改源码）：

| 想做的事 · Goal | 用什么 · Use | 文档 · Docs |
|---|---|---|
| 在自己的游戏、仿真或物流项目里画卡车进场、排队、从司机一侧倒车靠台、甩挂 · Truck yards and dock reversing in your own project | npm 库 `@storewright/yard`（零依赖、纯 TypeScript；`npm run pack:libs` 打出安装包） | [packages/yard](../../packages/yard/README.md)（[English](../../packages/yard/README.en.md)） |
| 检查任何引擎导出的车辆轨迹有没有车身重叠 · Audit vehicle overlaps in trajectories from any engine | npm 库和命令行 `@storewright/overlap-audit`（JSON 轨迹格式） | [packages/overlap-audit](../../packages/overlap-audit/README.md)（[English](../../packages/overlap-audit/README.en.md)） |
| 不开网页、按设定跑一次全链路，拿到指标 · Run the chain headless and get the indicators | 场景文件 + `npm run sim -- scenario 场景.json --json` | [07-scenarios.md](07-scenarios.md) |
| 分享、复现孪生里的某一个时刻 · Share or reproduce a moment in the twin | 分享链接 / 场景文件（附 JSON Schema） | [07-scenarios.md](07-scenarios.md) |
| 让外部引擎（虚幻引擎、MATLAB、自己的系统）接收车辆位置、感知数据、发回指令 · Connect an external engine | 孪生服务的 REST / WebSocket 接口 | [server/protocol.md](../server/protocol.md)（[English](../server/protocol.en.md)） |
| 拿自己的助手或大模型和内置的值班助手同题比较 · Compare your assistant or an LLM | 值班台基准的数据集和评分器（`npm run bench -- score`） | [benchmark.md](benchmark.md)（[English](benchmark.en.md)） |
| 用别的路径求解器核对、对比 · Check another routing solver | CVRPLIB 例子和最优解 + `npm run validate -- check` | [08-validation.md](08-validation.md) |
| 上课 · Teach a course | 教学沙盘的练习和批改命令行（`npm run teach`） | [teaching/](teaching/README.md) |

## 0. 开始之前 · Before you start

- 命令都在 `StoreX-Chain/` 下运行；依赖用仓库根目录装好的（先在根目录 `npm install`，Node.js 22 或更高）。
- 每次改完至少跑 `npm run check`（类型检查 + 单元测试）。
- **`docs/results/` 是生成的：** 只能由 `npm run reports` 写，不要手改。结果变了以后跑 `npm run docs:sync`，按 `data.json` 更新文档里标出来的数字（`<!--n:路径|小数位|单位-->`），再用 `npm run docs:check` 确认。
- **默认区域冻结：** 默认区域（`DEFAULT_REGION`、`DEFAULT_OPTIONS`）的生成方式和仿真结果不能变。新东西只在随机、自定义区域里出现，或者对默认区域不产生任何差别。检查办法：改完跑 `npm run reports`，`docs/results/data.json` 里除了 `runtime`（用时）不应该有变化，除非这次改动本来就要改变结果（那就在说明里写清楚，并跑 `docs:sync`）。
- 三维的改动：开着开发服务器（`npm run dev`）跑 `node scripts/check3d.mjs`；车辆运动的改动跑 `npm run overlaps`。

## 1. 加一个设施卸货场 · Add a facility yard

卸货场引擎（独立的程序库 [`@storewright/yard`](../../packages/yard/README.md)，在仓库根目录的 `packages/yard`）负责车道布置、倒车路线、铰接运动和排程；门店、配送中心和冷链中心、港口拆装箱库和保税库、机场货站的卸货口用的都是它（[系统设计 §8.6](04-system-design.md)）。一个场地分三步接进来：按场地尺寸排出布置（`planYard`），登记到区域里（`defineYardSite`），交给它当天的全部访问（`setSiteVisits`）。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| 设施自己的模块（`src/hub/*.ts`，或三维的 `web/src/three/ops/*.ts`） | 写场地的输入 `YardInput` 和坐标系 `YardFrame`，登记场地，交访问 |
| `src/region/frames.ts`、`src/region/regionGen.ts` 的 `LOCAL` | 设施有新的占地时：坐标系和占地范围（生成器按它检查放不放得下） |
| `packages/yard/src/index.ts` | 一般不用改：`planYard`、`defineYardSite`、`setSiteVisits`、`simVisitId`、`simVisitFor`、`siteSchedule` 就是对外的接口 |

**最小示例**（照 `src/hub/airport.ts` 的 `registerLandsideYard` 和 `web/src/three/stores.ts` 的写法）

```ts
import { defineYardSite, planYard, setSiteVisits, simVisitId, type YardFrame, type YardInput, type YardVisit } from '@storewright/yard';

// 场地的局部坐标（米）：墙在 z = 0，门沿墙排开（x），场地往 +z 伸出 depth
const input: YardInput = {
  doors: [{ x: 10, id: 'K01' }, { x: 14.5, id: 'K02', cold: true, kinds: ['reefer'] }],
  x0: -20,
  x1: 60,
  depth: 45,
  side: 'right', // 进场道路在 +x 头
};
const plan = planYard(input);

// 放进区域：原点（沙盘米）和绕 y 轴转的角（three.js 的 yaw）
const frame: YardFrame = { origin: { x: 1200, z: -340 }, yaw: Math.PI / 2 };
defineYardSite({ key: 'cold-hub', frame, plan, doors: plan.doors.map((d, i) => ({ id: d.id, index: i, kinds: d.kinds })) });

// 当天的全部访问：背景车和仿真车都放进来，同一个场地只有一份排程，画面里的车互相让
const visits: YardVisit[] = [
  { id: simVisitId(42, 3), vehicle: 'reefer', door: 1, arrive: 6 * 3600, dockAt: 6 * 3600 + 300, leaveAt: 7 * 3600 },
];
setSiteVisits('cold-hub', visits);
```

- `key` 要和仿真里这个地点 / 停靠点对得上（现有的有 `store`、`dc-dry`、`dc-cold`、`air-landside`、`port-cfs-box`、`port-cfs-truck`……），运动规划按它把仿真车开进场地。
- 仿真车的访问编号用 `simVisitId(vid, stop)`，时刻最好用 `simVisitFor(key, vid, stop, vehicle, door, t0, t1)` 算（和运动规划算的一样）；场地没登记的仿真车，运动规划会自己补上。
- 场地要在排车辆之前登记（机场的做法：道路网摆地点时登记一次，货站排计划时换了机位数再登记）。布置或访问一变，版本号加一，排程缓存和运动规划自动重算；换区域、测试前用 `clearYardSites()` 清空。
- `YardInput` 的其他可选项：`from`（进场道路从墙后还是从远端来）、`access`（喇叭口专用通道或信号灯路口）、`queue`（待命车位）、`drop`（甩挂车位）、`alignAt`（挂车最晚在离墙多远处摆正，默认 24 米）、`sectionSpan`、`road`。

**测试和自检**

- `packages/yard/test/yard.test.ts`（布置、排程，在库里，`npm test -w @storewright/yard`）和 `tests/yardMotion.test.ts`（倒车、铰接运动）：给新场地加一条用例，排一天检查每辆车都靠上了门、没有两辆车同时占一个门。
- `npm run overlaps`：按区域统计车辆重叠（超过 `scripts/overlaps.mjs` 里 `LIMITS` 的上限时退出码 1）。
- 开着 `npm run dev` 跑 `node scripts/check3d.mjs`（页面报错、瞬移、帧时间）。

## 2. 加一个仓储中心模型 · Add a warehousing-hub model (HubDay)

仓储中心的作业模型按当天的仿真轨迹、设施配置和负荷档位排出一份 `HubDay`（`src/hub/types.ts`）：有哪些区（`HubZone`），每件货或每辆车按先后走过哪些区、各占用多久（`HubFlow`），每 5 分钟的占用，指标和几句提示。三维按它画，值班助手按它回答（`get_hub`、`trace_own_cargo`、`hub_bottlenecks`、`plan_appointments`），两边是同一份（[系统设计 §8.5](04-system-design.md)）。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| `src/hub/types.ts` | `HubKey` 加一个键（现在是 `port`、`airport`、`park`、`store`） |
| `src/hub/<新模块>.ts` | 作业模型：输入（车辆轨迹、种子、负荷档位的背景车流……）→ `HubDay`；纯数据，不依赖 three.js |
| `src/assistant/hubs.ts` | `HUB_LABEL`、`HUB_FAC`（都是 `Record<HubKey, …>`，漏了 TypeScript 会报错） |
| `src/assistant/entities.ts` | `hubKeyOf`：问题里怎么认出这个设施 |
| `src/assistant/opsTools.ts` | `get_hub` 等工具参数里的 `enum` 加上新键 |
| `server/twinServer.ts` | `hubPlans()` 里加一行 `add('…', () => …)` |
| `web/src/main.ts` | `hubDays()` 里加上网页这一侧的计划 |
| `src/assistant/evalFixtures.ts` | 评测用的固定仓储中心数据（评测题要用到新设施时） |

**最小示例**（照 `src/assistant/evalFixtures.ts` 的 `day()`、`trucks()` 写：车先到先服务排队，生成「排队 → 月台」两步）

```ts
import { tallyOccupancy, type HubDay, type HubFlow, type HubZone } from './types';

export function planColdHub(input: { trucks: { id: string; arrive: number; svc: number; cold: boolean }[]; doors: number }): HubDay {
  const zones: HubZone[] = [
    { key: 'queue', label: '排队车道', kind: 'queue', capacity: 6, unit: '车' },
    { key: 'docks', label: '月台', kind: 'dock', capacity: input.doors, unit: '门' },
  ];
  const free = new Array<number>(input.doors).fill(0);
  const flows: HubFlow[] = input.trucks.map((tk) => {
    let j = 0;
    for (let k = 1; k < free.length; k++) if ((free[k] as number) < (free[j] as number)) j = k;
    const start = Math.max(tk.arrive + 60, free[j] as number); // 过闸登记 1 分钟，再等空出来的门
    free[j] = start + tk.svc;
    return {
      id: tk.id, label: tk.id, own: false, units: 1, unit: '车', kind: 'vehicle', cold: tk.cold, carrierIn: tk.id,
      steps: [
        { zone: 'queue', t0: tk.arrive, t1: start, act: start > tk.arrive + 60 ? '排队等月台' : '过闸、登记' },
        { zone: 'docks', t0: start, t1: start + tk.svc, act: '靠台装卸' },
      ],
    };
  });
  const kpi: HubDay['kpi'] = [{ key: 'trucks', label: '到场车辆', value: flows.length, unit: '辆', better: 'lower' }];
  // key 要先加进 HubKey
  return { key: 'cold', label: '冷链中心', zones, flows, occupancy: tallyOccupancy(zones, flows), kpi, notes: [] };
}
```

孪生服务里（`server/twinServer.ts` 的 `hubPlans()`，排不出来时只打印原因、不影响别的设施）：

```ts
add('冷链中心', () => planColdHub({ trucks: …, doors: 4 }));
```

- 时刻都是当天 0 点起的秒；占用 5 分钟一格、共 26 小时（`HUB_SLOT`、`HUB_SLOTS`），用 `tallyOccupancy` 从 `flows` 数出来。
- 仿真里的车，`carrierIn` / `carrierOut` 写调度台的作业编号：值班助手按它把排队时间接到那一趟车上（迟到归因里的「仓储中心排队」）。`own: true` 标本店的货或车（`trace_own_cargo` 只追这些）。
- 网页和孪生服务要用同一个模型、同样的输入，画面和回答才对得上；做不到时像机场货站那样在服务里估算，并在 `server/protocol.md` 写明。

**测试和自检**

- 照 `tests/hubPark.test.ts` 写一份：用 `runChain(withLoad(scenarioFor('g3', seed), level))` 的轨迹排一天，检查不超容量、每件货的步骤首尾相接、平常和极限负荷都排得出、同一个种子每次一样。
- `tests/serverHubs.test.ts`（服务里的仓储中心计划）。
- 值班助手：在 `src/assistant/evalSet.ts` 的 `hub` 类加题，跑 `npm run assistant:eval`。

## 3. 在看板上加一个指标 · Add a KPI to the board

分层看板（`src/assistant/kpiBoard.ts`）分集团、区域、设施、作业四层，每个指标有「注意」「告警」两道阈值。注意它和仿真指标是两回事：仿真指标在 `src/analysis/kpi.ts` 的 `KPIS`（进 `data.json` 的 `kpis`，见 [DATA.md](results/DATA.md)），看板指标在 `KPI_DEFS`。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| `src/assistant/kpiBoard.ts` | `KPI_DEFS` 加一行：`key`、`level`、`label`、`unit`、`better`、默认阈值 `warn` / `alarm`、`rel?`、`digits?`、`get(x)` |
| `src/assistant/context.ts`、`types.ts` | 指标要的数据在值班助手的上下文（`AssistCtx`）里还没有时 |
| 调用 `evaluate` 的地方 | `rel: true` 的指标要的 `summary` / `base`（18 周平均、方案的基准）由调用方给：网页的看板面板（`web/src/kpiPanel.ts`）和孪生服务的 `/api/kpi`（`server/twinServer.ts`） |

**最小示例**（照现有的 `late20` 写）

```ts
// 现有的一行
{ key: 'late20', level: 'op', label: '晚 20 分钟以上的车', unit: '辆', better: 'lower', warn: 1, alarm: 3, digits: 0, get: (x) => moving(x).filter((r) => (r.delayMin ?? 0) >= 20).length },
// 新加的一行：换 key、label 和取值
{ key: 'late40', level: 'op', label: '晚 40 分钟以上的车', unit: '辆', better: 'lower', warn: 1, alarm: 3, digits: 0, get: (x) => moving(x).filter((r) => (r.delayMin ?? 0) >= 40).length },
```

- `get` 返回 `undefined`（或不是有限数）时状态是 `na`；`rel: true` 时阈值是「比基准差百分之几」（服务水平、准时率按百分点）。
- 网页上可以改阈值（存在本机浏览器里，覆盖 `defaultThresholds()`）；告警、确认和往上报都由 `AlertBook` 处理，不用另写。网页的看板和 `/api/kpi` 都遍历 `KPI_DEFS`，新指标两边自动出现。
- README 和[系统设计 §10.5](04-system-design.md) 写了指标的个数，加了以后一起改。

**测试和自检**

- `tests/assistant.test.ts`：`evaluate` 返回 `KPI_DEFS.length` 个值、告警按时往上报；给新指标加一条用例，构造上下文让它分别落在 ok、warn、alarm。
- `npm run check`。

## 4. 给值班助手加一个意图和工具 · Add an assistant intent and tool

一个问题在值班助手里依次经过：换错别字和别称（`normalize.ts`）→ 认参数（`entities.ts`）→ 护栏（`guards.ts`：批准还是否决、角色声明、超出范围）→ 意图（`intent.ts`：`ruleIntent` 的规则先判，没命中的交给分类器）→ 按意图调工具（`index.ts` 的 `route()`）→ 只读的查询工具（`tools.ts`、`opsTools.ts`）→ 提议过规则表（`policy.ts`）→ 四段式回答和数字核对（`grounding.ts`）。详见[系统设计 §10](04-system-design.md#10-ai-综合管理和运营控制)。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| `src/assistant/intent.ts` | `Intent` 加一类；`corpus()` 里用 `ex(intent, heads, bodies, tails)` 加模板说法；要时在 `ruleIntent` 加明确的规则、在 `CUES` 加说法检查；`HOLDOUT`（另外写的留出集，不进训练）加几句新类的说法 |
| `src/assistant/tools.ts` 或 `opsTools.ts` | 在 `TOOLS` / `OPS_TOOLS` 加一个 `ToolDef`：`name`、英文的 `description`、参数的 JSON Schema、`run(ctx, args, mem)` 返回 `ToolResult` |
| `src/assistant/index.ts` | `route()` 的 `switch (intent)` 加一个 `case` |
| `src/assistant/policy.ts` | 工具会给出提议（`proposals`）时：提议都要过 `checkProposal` / `applyPolicy`；新的硬性规定加在 `HARD` 和 `RULES`（「有哪些规定」按 `RULES` 回答） |
| `src/assistant/guards.ts` | 新意图牵涉批准 / 否决、角色或超出范围的判断时 |
| `src/assistant/knowledge.ts` | 新的处理办法（资料库，`search_knowledge` 查它） |
| `src/assistant/evalSet.ts` | 评测题（`EvalItem`） |

**最小示例**（照 `intent.ts`、`tools.ts`、`index.ts`、`evalSet.ts` 的现有写法）

```ts
// intent.ts：加一类，再加模板说法（heads × bodies × tails 展开）
export type Intent = /* …现有的… */ | 'policy' | 'battery';
ex('battery', ['', '现在', '请问'], ['电动车电量够不够', '哪辆电动车快没电了', '电动配送车还剩多少电'], ['', '？']);

// tools.ts：加一个只读工具；description 用英文，按语言模型调用工具的格式写
{ name: 'get_battery', description: 'State of charge of the electric delivery trucks now, lowest first.', parameters: { type: 'object', properties: {} }, run: (c) => battery(c) },

function battery(ctx: AssistCtx): ToolResult {
  // 数据从上下文取：车辆行 ctx.rows、闭环 ctx.twin、调度台 ctx.board
  const lines: string[] = [];
  const list: Record<string, unknown>[] = [];
  // …按电量排序，写 lines 和 list…
  return result('get_battery', {}, lines.join('\n'), TWIN_CITE, { followups: ['现在有什么风险'] }, { list });
}

// index.ts 的 route()
case 'battery':
  return [run('get_battery')];

// evalSet.ts：每类意图、换说法各至少一题（编号不要和已有的重复）
{ id: 'I90', cat: 'intent', q: '电动车电量够不够', intent: 'battery', tools: ['get_battery'] },
{ id: 'P90', cat: 'paraphrase', q: '哪辆电动配送车快没电了', intent: 'battery' },
```

- **工具只读。** 要改东西只返回 `proposals`（带 `requests`，即执行它要调的接口），由人点「确认执行」；工具里绝不改调度台和建议卡（评测每题都核对「什么都没改」）。
- **数字核对。** 回答里的每个数字、时刻、编号都要在工具结果里找得到出处：写进 `text` 的数和放进 `data` 的是同一份。
- 新工具自动出现在 `GET /api/assistant/tools`（服务列出 `TOOLS`），网页和孪生服务用的是同一个助手。
- **盲测题（`evalBlind.ts`、`evalBlind2.ts`、`evalBlind3.ts`）和留出集不能拿来调**规则、语料和分类器：改完照常跑，成绩如实记录。
- README 和系统设计 §10.1 写了意图和工具的个数，加了以后一起改。

**测试和自检**

- `npm run assistant:eval`：重新生成 `docs/results/assistant-eval.md`；标准问题要全部通过，数字核对没有缺出处的。
- `npm test`：`tests/assistantEval.test.ts`（按门槛检查评测）、`tests/assistantClf.test.ts`（分类器和留出集）、`tests/assistantGuards.test.ts`（护栏）、`tests/assistant.test.ts`。

## 5. 加一个数据适配器 · Add a data adapter

适配器（`server/adapters/`）把外部系统的数据换成孪生的感知数据（`Msg`，见 `src/twin/types.ts`），把孪生的指令换成外部系统的指令；同一个孪生可以吃记录、外部文件、实时推送或盯着的目录（[protocol.md](../server/protocol.md) 的「对接真实系统」，英文版 [protocol.en.md](../server/protocol.en.md)）。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| `server/adapters/<新>.ts` | `parseXxx(text, refs): Parsed`：逐条检查，好的换成 `FeedItem`（`{ m: Msg, src }`），坏的写进 `rejected`（`{ at, reason }`），服务不因坏数据停下；要发指令时再写 `xxxInstruction(cmd, refs)`；要写样例时写 `xxxFromMsgs(msgs, refs)` |
| `server/adapters/common.ts` | `AdapterName`、`ADAPTER_LABEL` 加一项；`adapterOf` 按文件名认接口 |
| `server/adapters/source.ts` | `parseAs` 接上新接口 |
| `server/adapters/live.ts` | `INGEST_ADAPTERS` 加上才能 `POST /api/ingest/<名字>`；`RANK` 定同一批里的先后 |
| `server/adapters/outbox.ts` | 孪生的指令要发给这个系统时 |
| `server/adapters/samples.ts` | 用模拟的一天写一份样例（合成数据） |
| `server/protocol.md`、`server/protocol.en.md` | 格式、字段和感知数据的对应（中文版是准） |

**最小示例**（照 `wms.ts` 的 `parseWms` 写；闸口系统是举例）

```ts
import { csvSplit } from './wms';
import { fromTs, type Parsed, type Refs } from './common';

/** 闸口系统：CSV，列 ts,gate,vehicle_ref,dir（第一行是表头） */
export function parseGate(text: string, refs: Refs): Parsed {
  const out: Parsed = { items: [], vehicles: [], rejected: [] };
  const lines = text.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const at = `第 ${i + 1} 行`;
    const [ts, gate, ref, dir] = csvSplit(lines[i] as string);
    const t = fromTs(ts);
    if (t === undefined) {
      out.rejected.push({ at, reason: '时间格式不对' });
      continue;
    }
    const vid = refs.vid(ref);
    if (vid === undefined) {
      out.rejected.push({ at, reason: '不认识的车辆编号' });
      continue;
    }
    out.items.push({ src: 'gate', m: { kind: 'event', t, vid, ev: dir === 'in' ? 'arrive' : 'leave', place: gate } });
  }
  return out;
}
```

- 时间用合成的日期（`FEED_DATE`，`fromTs` / `toTs` 换算），经纬度用 `fromLatLon` / `toLatLon` 按原点换成沙盘坐标；车辆编号用调度台的作业编号（`Refs` 负责对应）。
- 拒收的原因写成能看懂的话（「时间格式不对」「不认识的车辆编号」……），`/api/adapters` 会按原因计数。
- 样例数据一律合成；报文格式是本项目的约定时要写明，不能写成任何真实系统的实施指南。

**测试和自检**

- `tests/adapters.test.ts`：照「换算：模拟的数据 → 外部系统的格式 → 感知数据」加往返测试（一条不少、数值在误差以内），照「坏数据：跳过并记下原因，不影响好的」加坏数据测试；有指令时检查每种指令恰好换成一种外部指令。
- `npx tsx server/adapters/samples.ts` 重新生成样例，再用 `--source feed:server/adapters/samples` 跑一遍。

## 6. 加一个三维车辆模型 · Add a 3D vehicle model

所有公路车辆按截面放样建模，尺寸和运动学参数只有一份表：`web/src/three/vehicles/specs.ts`（纯数据，不依赖 three.js，收货场引擎和测试也用它）。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| `web/src/three/vehicles/specs.ts` | `ModelKey` 加一个键；`MODEL_SPECS` 加一项：`label`、`length` / `width` / `height`（米）、`axles`、`lamps`、`wheel`，铰接车加 `kingpin`，拖车加 `hitch` |
| `web/src/three/vehicles/trucks.ts` 或 `cars.ts` | 建模函数（零件坐标；`coarse` = 远处的简模），在 `truckModel` 的 `switch` 里接上（乘用车在 `CAR_SPECS`） |
| `specs.ts` 的 `BODY_DIMS` / `RIG_DIMS` | 收货场引擎或运动规划要用它的尺寸时 |

**最小示例**（现有的 `boxTruck`：新车型复制一份，改尺寸、车轴和车灯）

```ts
// specs.ts
export type ModelKey = /* …现有的… */ | 'boxTruck' /* | 新车型 */;

boxTruck: {
  label: '平头厢式货车',
  length: 7.6,
  width: 2.3,
  height: 3.4,
  wheel: 'truck',
  axles: [
    { x: 6.5, r: 0.44, half: 0.98, steer: true },
    { x: 2.2, r: 0.44, half: 0.9, dual: true },
  ],
  lamps: { tail: [-0.02, 1.25, 1.02], back: [-0.02, 1.0, 0.98], rearTurn: [-0.02, 1.5, 1.02], frontTurn: [7.6, 1.18, 0.98], head: [7.62, 1.0, 0.75], k: 0.95 },
  // …
},

// trucks.ts：建模函数，再接进 truckModel(key, coarse) 的 switch
export function boxTruck(coarse: boolean): Geo {
  const b = new MeshBuilder();
  const s = MODEL_SPECS.boxTruck;
  // …按截面放样车身和驾驶室，车轮按 s.axles 摆…
  return b.finish(0);
}
case 'boxTruck':
  return boxTruck(coarse);
```

- 零件坐标：原点在车尾、车头朝 +x、地面 y = 0、z 向车辆右侧为正，车轴和车灯左右对称。
- 尺寸取公开资料里常见车型的通用外形，**不画任何品牌**；外廓不超过公开的限值（半挂车 13.75 米、铰接列车 17.1 米、长头铰接列车 18.1 米、宽 2.55 米、高 4.0 米，见 `specs.ts` 开头的说明）。
- **现有车型的长度和牵引销位置不要改：** 运动规划、收货场引擎（`VEHICLE_DIMS`）和设施的作业动画都按这些数排车位、倒车、算车长。

**测试和自检**

- `tests/vehicles.test.ts`：外形尺寸在公开的常见范围里、和尺寸表一致；车轮贴地、车灯在车头车尾；铰接车和收货场引擎一致、车组不超长；远近两级模型都有、三角形数在预算以内。新车型要加进这些检查的范围表。
- 开着 `npm run dev` 跑 `node scripts/check3d.mjs`；车用到收货场或设施里时再跑 `npm run overlaps`。

## 7. 加一个区域选项 · Add a region option

区域生成器在 `src/region/regionGen.ts`：默认区域用固定的 `DEFAULT_OPTIONS`，随机区域按编号抽，自定义区域按指定的项（没指定的按编号随机）。网页地址里的写法是 `default`、`random-42`、`custom-7~sea.S~river.1~…`。**默认区域冻结：** 新选项只给随机、自定义区域用，默认区域没有这一项，生成方式和仿真结果完全不变。

**要改的文件**

| 文件 | 做什么 |
|---|---|
| `src/region/regionGen.ts` | `RegionOptions` 加一个**可选**字段和它的中文名表；`randomOptions` 用一串新的随机数抽它；`OPT_KEYS` 加网页地址里的短名；`regionSpecFrom` 只接受认识的值；`generateRegion` 只在不是默认区域时用（`!fixed`） |
| `web/src/regionDialog.ts` | 区域对话框里的选择项 |
| `web/src/three/planMap.ts` | 规划图的图例或说明要提到它时 |

**最小示例**（照 `riverForm` 的写法；`terrain` 是举例）

```ts
export type Terrain = 'flat' | 'hills';
export const TERRAIN_LABEL: Record<Terrain, string> = { flat: '平原', hills: '丘陵' };

export interface RegionOptions {
  // …现有各项…
  /** 只有随机、自定义区域有（默认区域没有这一项，生成方式和原来一样） */
  terrain?: Terrain;
}

// randomOptions(seed)：新选项用另一串随机数，原有各项按编号抽到的和以前一样
const r3 = rng(seed * 15485863 + 29);
const terrain = pickOf(r3, ['flat', 'hills'] as const);
// …return { …现有各项…, terrain };

// OPT_KEYS：网页地址里的短名
['terrain', 'ter'],

// regionSpecFrom：只认识的值才收；最后那条「方向」分支也要排除这个键
else if (key === 'terrain' && v in TERRAIN_LABEL) options.terrain = v as Terrain;

// generateRegion(spec)：只在随机、自定义区域里用
if (!fixed && o.terrain === 'hills') {
  // …
}
```

- `resolveOptions` 对默认区域直接返回 `DEFAULT_OPTIONS` 的副本：不要往 `DEFAULT_OPTIONS` 里加新字段，也不要改 `fixed` 那条路径。
- 随机区域：现有各项用的随机数串不要动（`r`、`r2` 抽的顺序一变，所有随机编号的区域都会变）。

**测试和自检**

- `tests/region.test.ts`：同一个规格每次一样、网页地址的写法来回转不变、干道只在路口相交、设施不重叠也不出区域、换区域以后全链路跑得通；给新选项的取值各加一个自定义区域。
- `tests/regionPure.test.ts`、`tests/landuse.test.ts`：默认区域单独搭和搭过随机区域以后再搭一样，默认区域的仿真规划不变。
- `npm run reports`：`docs/results/data.json` 除了 `runtime` 不应该有变化（见第 0 节）。

## 8. 写进文档 · Documenting the change

- 功能写进中文 README 和[系统设计](04-system-design.md)；文档里的结果数字用 `<!--n:路径|小数位|单位-->` 标出来，跑 `npm run docs:sync` 填数（路径的写法见 [DATA.md](results/DATA.md)）。
- 孪生服务的接口变了：改 [server/protocol.md](../server/protocol.md)，再同步英文版 [server/protocol.en.md](../server/protocol.en.md)。
- 新的界面用语加进[术语表](glossary.md)。
