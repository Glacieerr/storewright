# @storewright/yard · 卸货场引擎

**给仿真、游戏和数字孪生用的卸货场 / 月台场地引擎。** 给它一面月台墙和仿真给的硬时刻（「这辆挂车 06:42 到、06:53 开始卸、07:21 走」），它排出单向绕行的车道，算好每一个动作——排队、车头外摆、从司机一侧倒车（挂车铰接）、靠台、拉出——再给出一份互不冲突的排程，任何时刻都能取出每辆车的位姿直接画。

纯 TypeScript，零依赖，结果确定。[English](README.en.md)

> 属于 [Storewright](../../README.md) 开源作品集项目；[StoreX 全链路](../../StoreX-Chain/README.md)区域孪生里所有的卸货口（门店收货场、配送中心和冷链中心、港口拆装箱库和保税库、机场货站陆侧）都用它。本项目与任何零售商、企业无隶属关系。

## 为什么

多数仿真里的货车是瞬移到门口、或者横着滑进去的。真实的卸货场不是这样，而且差别一眼就看得出来：一辆 16.5 米的半挂车要有待命车道、约 12 米的掉头半径、车头外摆的空间，还要**从司机一侧**倒车（司机看得见挂车）；同一段墙同一时间只能有一辆车调车；要出去的车先走。这个库把这些规则写一次，场景里每个卸货场都照同一套走，谁也不会穿过谁。

## 做什么

```
 z（离墙方向）
 ▲
 │  顶部车道     ──►──►──►──►──►──►──►──►──►──►──►──►──┐
 │  待命车道     ◄── [4] [3] [2] [1] ◄──◄──◄──◄──◄──◄──┤   先到先进
 │  驶离车道     ◄──◄──◄──◄──◄──◄──◄──◄──◄──◄──◄──◄──◄─┤
 │  靠台车道     ──►──►──►──►──►──►──►──►──►──►──►──►─►│  进场道路（一进一出）
 │                 ╲ 从司机一侧倒车                      │
 ├───[D1]──[D2]──[D3]──[D4]──[D5]──[D6]──────────────────┘  月台墙 z = 0
 └──────────────────────────────────────────────────────► x
```

- **布置 `planYard`：** 按门的位置、能用的 x 范围和进深、进场道路在哪一头（left / right）、从哪来（back：沿楼侧面从墙后上来；front：从场地远端下来）、怎么接路口（drive：喇叭口专用通道；street：信号灯路口的支路），从墙往外排出靠台车道、驶离车道、带编号车位的待命车道和顶部车道（全是右侧通行的单向绕行），再加甩挂车位、标线、箭头、停止线、标牌和喇叭口。进深不够时退成紧凑布置（没有顶部车道）或只有靠台车道（排队排在进场道路上），`plan.notes` 里说明。
- **路线 `yardRoute`：** 一辆车到一个门的整套路线：进场点 → 待命车位 → 掉头 → 靠台车道 → 驶过门、车头外摆 → 从司机一侧倒车（挂车在两边车头连线以外摆正）→ 靠稳 → 笔直拉出、挂车越过两边车头再转弯 → 驶离。铰接车按牵引销运动学（牵引车 + 半挂车，挂车走追踪曲线），单体车按后轴中心。候选动作打分并检查：倒车时不碰两边门口停着的车、铰接角不超过 65°、车头不进待命车道。
- **排程 `scheduleYard`：** 仿真给的时刻是约定。来车按顺序排队；同一段墙同一时间只有一辆车调车；驶离优先；一个门不会同时有两辆车；调车放进你给的时间窗，多出来的时间停在倒车起点打双闪，窗口太短时压缩到下限并标 `tight`。进场道路的进场车道和拐进场里的第一个转弯（进场通道）上，后面的车隔着安全距离跟车，放不下的在场外等候区排队（`hold`）；场地超负荷也不会有车叠在一起（见[局限](#局限)）。支持甩挂：公路牵引车把挂车甩在车位就走，场内牵引车把它拖到门、装卸完拖回去，再由别的车来挂走。
- **取样 `poseAt`：** 任一次访问的任一时刻：在哪一段（`queue` 排队、`back` 倒车、`docked` 靠台、`pullout` 拉出……）、牵引车和挂车的朝向、是否倒车、前轮转角、速度、双闪和刹车灯，直接拿去画。
- **场地登记（可选）：** `defineYardSite` 把场地放进你的世界（原点 + 转角），`setSiteVisits` 交给它当天的访问，`siteSchedule` 每个场地缓存一份排程、布置或访问变了才重算；`siteSummary` 给看板用的汇总（时间窗太紧、晚了多少）。

## 安装

在本仓库里它是一个工作区包（`import … from '@storewright/yard'`）。在别的项目里用：在仓库根目录打一个包再装（还没有发布到 npm）：

```bash
npm run pack:libs          # 生成 dist-pkg/storewright-yard-0.1.0.tgz（编译好的 JavaScript + 类型声明）
npm install ./dist-pkg/storewright-yard-0.1.0.tgz
```

需要 Node.js 22 以上；浏览器和 Web Worker 里也能用（不用 DOM 和 Node 的接口）。

## 五分钟上手

```ts
import { planYard, scheduleYard, poseAt, yardRoute, checkRoute, type YardVisit } from '@storewright/yard';

// 墙上 6 个门、门距 4.3 米（墙在 z = 0）；能用的 x 从 −60 到 90 米、进深 140 米；进场道路在 +x 头
const plan = planYard({ doors: [0, 4.3, 8.6, 12.9, 17.2, 21.5], x0: -60, x1: 90, depth: 140, side: 'right' });

// 每个门都能让设计车型（半挂车）顺利倒进去吗
for (let d = 0; d < plan.doors.length; d++) console.log(checkRoute(plan, yardRoute(plan, d, 'semi')).ok);

// 仿真给的硬时刻（秒）：到进场点、开始卸货、开始拉出
const visits: YardVisit[] = [
  { id: 'V1', vehicle: 'semi', door: 0, arrive: 21600, dockAt: 22080, leaveAt: 23880 },
  { id: 'V2', vehicle: 'reefer', door: 1, arrive: 22020, dockAt: 22500, leaveAt: 24300 },
];
const schedule = scheduleYard(plan, visits);

// 画：任一时刻取任一辆车
const info = poseAt(schedule.timelines[0]!, 21880);
// info.seg 是这一刻在做什么（这里是 'back' 倒车）；info.units[0].pose → { x, z, heading, trailer, reversing, speed, steer }
```

能直接跑的完整例子见 [`examples/basic.ts`](examples/basic.ts)（`npm run example -w @storewright/yard`）。[浏览器演示](demo/)用 2D 画面实时演示一个卸货场，可以调门数、进场方式、到车频率（`npm run demo -w @storewright/yard`），右上角用 [`@storewright/overlap-audit`](../overlap-audit/README.md) 实时统计车身重叠，把到车调到超负荷、打开甩挂也一直是 0。

## 约定

- **本地坐标：** 月台墙在 `z = 0`，门在墙上的 `x` 处，场地朝 `+z` 伸出去；单位是米和秒。
- **朝向：** `atan2(dx, dz)`，0 朝 `+z`（背对墙），π/2 朝 `+x`。`yawOf(frame, heading)` 换成 three.js 的 yaw（车模车头朝 `+x`）；`toWorld` / `toLocal` 在场地和你的世界之间换坐标。
- **参考点：** 铰接车（`semi`、`reefer`、`chassis`、`shunter`）是牵引销，单体车（`truck`、`van`）是后轴中心；`footprint(vehicle, pose)` 给车身的矩形。
- **车辆尺寸：** 默认值在常见的法规限值以内（半挂车 ≤ 13.75 米、铰接列车 ≤ 17.1 米、车宽 2.55 米）；排布置之前可以用 `setVehicleDims` 换成你自己车模的尺寸。
- **通行方向：** 右侧通行；铰接车从司机一侧（左侧）倒车。

## 接口

| 部分 | 导出 |
|---|---|
| 布置 | `planYard(input)` → `YardPlan`；`checkPlan(plan)`；类型 `YardInput`、`YardDoorInput`、`YardPlan`、`YardDoor`、`YardStall`、`YardMark` |
| 路线 | `yardRoute(plan, door, vehicle)` → `YardRoute`；`shunterRoute`、`stallRoute`（甩挂）；`checkRoute(plan, route)` → `RouteCheck`；`laneDrive`、`lanePose`、`queueTargets`、`QueueMotion` |
| 排程 | `scheduleYard(plan, visits)` → `YardSchedule`（`timelines`、`shunts`、`notes`）；`courtResources`；类型 `YardVisit`、`YardTimeline`、`YardSeg`、`YardSegKind`、`YardPiece` |
| 取样 | `poseAt(timeline, t)` → `PoseInfo`（`seg`、`units[]`、`hazard`、`brake`）；类型 `PoseUnit`、`RigPose` |
| 场地登记 | `defineYardSite`、`yardSite`、`yardSites`、`clearYardSites`、`setSiteVisits`、`addSimVisit`、`clearSimVisits`、`simVisitId`、`simVisitFor`、`siteSchedule`、`siteTimeline`、`siteVisit`、`siteVersion`、`siteSummary`、`yardSummaries`、`findYardDoor` |
| 坐标 | `toWorld`、`toLocal`、`yawOf`、`headingOf`；类型 `YardFrame` |
| 运动学 | `ForwardRig`、`ReverseRig`、`TowChain`、`BodyRig`、`forwardRig`、`TimedPath`、`PathChain` |
| 车辆 | `VEHICLE_DIMS`、`BOBTAIL`、`setVehicleDims`、`dimsOf`、`lengthOf`、`frontOf`、`backOf`、`noseOf`、`rearOf`、`footprint`；类型 `YardVehicle`、`RigDims`、`BodyDims`、`VehicleDims` |
| 几何 | `Polyline`、`fillet`、`angDiff`、`minRadius`、`obbIntersects` |

每个导出的函数和类型都有一句英文说明；源码里保留了更长的中文注释，写着为什么这样做。

## 确定性和开销

同样的输入永远得到同样的布置、路线和排程（没有随机数、不看时钟）。`planYard` 和 `scheduleYard` 按输入缓存结果，再问一次不花时间；返回的对象只读，不要改。一面 24 个门的墙排一天 300 次到车，在笔记本电脑的 Node.js 里约 0.15 秒。

`npm run bench -w @storewright/yard` 量排程的开销：超负荷测试矩阵的 15 组设置加上浏览器演示的 15 种选项，每次用一个内容相同的新布置对象从头排（路线也重新算），取 3 次里最快的，空闲的笔记本电脑上一共约 0.8 秒（这一版提速以前约 2.4 秒）；加 `--mem 8` 量内存，一份布置加它的排程留在内存里约 3–10 MB（14 个门、每小时 24 辆、带甩挂的最多；提速以前 10–41 MB）。几处做法：占用表按资源把时段按开始时刻排好、记着前缀最大的结束时刻，查冲突用二分；同一个门、同一种车的路线和它占用的场地资源按布置缓存，同一个车位、同一个门的甩挂路线在一次排程里只算一次；折线、按时间走的路径和排队运动的采样存在 `Float64Array` 里（`pts`、`cum`、`cumT`、`cumD` 第一次读的时候才生成普通数组）。改这些地方之前先用 `--hash a.json` 存一份指纹，改完用 `--check a.json` 比（`--random 256` 再加 256 组随机设置）：时间线、分段、甩挂作业和逐秒的位姿都要一字不差。

## 局限

- 一份布置只有一面直的月台墙（L 形的楼是两份布置）。
- 动力学是简化的：限速、加减速、转弯的侧向加速度，没有轮胎和载重模型。
- 只管场内；行人、月台前的叉车、公共道路由你自己处理（`plan.junction` 给出路口的几何，`YardVisit.pre` / `leave` 可以接上道路的路线）。
- 目前只支持右侧通行。
- 场地超负荷（来车快过门的处理能力）时，引擎不让车叠在一起，而是这样处理：
  - 进场通道（进场道路的进场车道，加上拐进场里第一条车道的那个转弯）上，前面的车车尾过了进场点 2 米，后面的车才放进来；在待命车道上跟车，车头离前车车尾至少 1.5 米，前车还没挪开就停下等。
  - 放不下的车在场外等候区排队：时间线里的 `hold` 段。这段时间车不在场里，`poseAt` 给的是进场点的位姿，只是方便接上道路；要画就画到你自己的等候区，画在进场点会和正在进场的车叠在一起。
  - 甩挂进场的车、场内牵引车、紧凑布置里横穿进场转弯驶离的车，都要等进场通道空出来；挂上 / 摘下挂车的那一两分钟也算占着场地。
  - 甩挂车位按实际时刻占用（从甩下到被挂走，没有取挂时刻就一直占着），同一个车位不会有两个挂车；车位都占着、或者空出来时已经赶不上靠台的挂车，改成司机自己靠台装卸，`notes` 里写明。
  - 靠稳太晚的车，拉出按靠稳后至少一分钟重新排（避开别的车，门一直占到那时）。时间窗因此不够的照旧压缩到下限、标 `tight`，晚了多少记在 `lateDock` / `lateExit`，`siteSummary` 汇总。
  - 进场通道放车的间隔看车长：半挂车从静止起步，大约 8–9 秒放进一辆；没有待命车道的场地（有甩挂车位，或只有靠台车道），前一辆从进场点进场、开出进场通道以后才放下一辆。来车比这更密、待命车道排满或者门处理不过来，就在场外排队、晚点。库的测试（[`test/overload.test.ts`](test/overload.test.ts)）按负荷、门数、进场方式、布置和甩挂的组合逐秒审计，车身重叠都是 0。

## 测试

```bash
npm test -w @storewright/yard        # 布置、路线、排程（先进先出、每段墙一辆车调车、车不相碰）、甩挂、坐标换算、超负荷矩阵（逐秒重叠审计）
npm run typecheck -w @storewright/yard
npm run bench -w @storewright/yard   # 排程耗时；--mem 8 量内存，--hash / --check 存、比结果指纹
```

## 许可证

[AGPL-3.0-only](../../LICENSE)，和项目其余部分一样。变更记录：[CHANGELOG.md](CHANGELOG.md)。
