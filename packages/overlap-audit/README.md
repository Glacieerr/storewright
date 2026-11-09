# @storewright/overlap-audit · 车辆重叠审计

**统计仿真的一天里车身矩形在哪里重叠——变多了就让检查失败。** 给所有「很多车在动」的东西当回归门槛：交通仿真、物流和港口孪生、城市建造类游戏、机器人车队。

纯 TypeScript，零依赖。[English](README.en.md)

> 属于 [Storewright](../../README.md) 开源作品集项目；[StoreX 全链路](../../StoreX-Chain/README.md)用它审计区域孪生里的每一辆车（在 `StoreX-Chain/` 里运行 `npm run overlaps`）。本项目与任何零售商、企业无隶属关系。

## 为什么

「一辆车从另一辆车里穿过去」这种画面问题很容易引入、又很难发现：排程的时刻改了一点、加了一个路口、挂车长了一点。单元测试一般抓不到，因为什么都没「出错」——只是画面不对。这个库把它变成一个能跟踪的数：每隔几秒取一次所有车身，统计两两重叠，按区域和车型对归类，把静止的重叠（两辆排队的车画到了一起）和行驶的重叠（一辆车开过另一辆）分开，再和上限比。哪个区域变多了，退出码就是 1。

单位是 **「车对 × 秒」**：两辆车重叠 10 秒记 10；三辆车两两都重叠 1 秒记 3。

## 在代码里用

```ts
import { OverlapAuditor, StillTracker, quadKey, hitched, checkLimits, formatReport, type Body } from '@storewright/overlap-audit';

const auditor = new OverlapAuditor<{ name: string; layer: string }>({
  // 牵引车和自己的挂车在牵引座那里本来就贴在一起，不算碰撞
  ignore: (a, b) => a.data?.layer === b.data?.layer && (hitched(a.shape as number[], b.shape as number[]) || hitched(b.shape as number[], a.shape as number[])),
  // 每次重叠记在你的世界里的哪个区域（返回 undefined 不记）
  area: (a) => areaOf(a.shape),
});
const still = new StillTracker();
for (let t = 0; t < 86400; t += 2) {
  const bodies: Body<{ name: string; layer: string }>[] = sampleYourScene(t); // { type, shape：四个角或 OBB, data }
  for (const b of bodies) b.still = still.mark(quadKey(b.data!.name, b.shape as number[])); // 也可以自己给 still
  auditor.step(t, bodies, 2); // 每次取样代表 2 秒
  still.next();
}
const report = checkLimits(auditor.tally, { junction: { static: 0, moving: 120 }, yard: { static: 10, moving: 900 } });
console.log(formatReport(report, { unit: 'pair-seconds' }));
process.exitCode = report.over ? 1 : 0;
```

能直接跑的例子见 [`examples/basic.ts`](examples/basic.ts)。

**车身。** 两种写法：四个角展平 `[x0, z0, x1, z1, x2, z2, x3, z3]`，顺序是后 A、前 A、前 B、后 B；或者 OBB `{ cx, cz, ux, uz, hl, hw }`（中心、单位朝向向量、半长、半宽）。`obbFromHeading(cx, cz, heading, hl, hw)` 按角度做一个（默认 `atan2(dx, dz)`，`{ yaw: true }` 按 three.js 的 yaw），`obbToQuad` 互换。

**钩子。** `skip(a, b)` 在精确检验之前跳过（便宜的过滤）；`ignore(a, b)` 在确认重叠以后忽略（例如 `hitched`）；`area(a, b)` 给出区域或 undefined；`pair(a, b)` 给出车型对的名字（默认两种车型排序后用「 × 」连起来）；`onOverlap(o)` 每记一次重叠调用一次（打印例子、找热点）。给 `tally` 可以让几个审计记进同一份报告；`touching: true` 时只是贴着也算重叠。

**粗筛。** 均匀网格把每个车身登记进它的包围盒碰到的每一格，所以不管格子多大都不会漏掉（默认 30 米，只影响快慢），两两的顺序稳定。

## 在命令行里用

任何引擎导出 JSON 轨迹就能审计：

```bash
npx tsx packages/overlap-audit/src/cli.ts trajectories.json --step 1 --limits limits.json   # 在本仓库里
overlap-audit trajectories.json --step 1 --limits limits.json                              # 从打好的包安装以后
```

退出码 0：都在上限以内；1：有区域超了；2：输入有误。`--json` 输出 JSON，`--from` / `--to` 限定时段，`--touching` 贴着也算。文件格式（英文说明里有完整的例子）：

- `vehicles[].frames`：`(x, z)` 是矩形中心（`"anchor": "rear"` 时是车尾那条边的中点）；位置线性插值，朝向按较短的那一边转；车从第一帧出现到最后一帧消失。
- `snapshots`：直接给的车身（中心、朝向、尺寸，或者 `quad`），一直有效到下一个快照。
- 同一个 `group` 的车身（一辆铰接车的牵引车和挂车）互相不算。
- `areas`：重叠记在包含两个中心连线中点的第一个多边形里，都不包含记 `other`；没给区域就都记 `all`。
- 和上一次取样比位移不到 1 厘米算没动。
- `heading`：`"atan2"`（0 朝 +z，π/2 朝 +x）或 `"yaw"`（three.js 的写法，0 朝 +x）。

上限文件：`{ "junction": { "static": 0, "moving": 2 }, "yard": { "static": 25, "moving": 1 } }`。试一下自带的例子：`npm run audit:example -w @storewright/overlap-audit`。

## 安装

在本仓库里：`import … from '@storewright/overlap-audit'`（工作区包）。在别的项目里：在仓库根目录运行 `npm run pack:libs`，再 `npm install ./dist-pkg/storewright-overlap-audit-0.1.0.tgz`（编译好的 JavaScript、类型声明和 `overlap-audit` 命令）。需要 Node.js 22 以上。

## 接口

| 部分 | 导出 |
|---|---|
| 几何 | `quadsOverlap`、`obbsOverlap`、`shapesOverlap`、`obbFromHeading`、`obbToQuad`、`quadAabb`、`obbAabb`、`shapeAabb`、`quadCenter`、`quadHeading`、`hitched`、`isObb`；类型 `Quad`、`OBB`、`AABB`、`Shape`、`OverlapOptions` |
| 粗筛 | `forEachCandidatePair`、`candidatePairs` |
| 审计 | `OverlapAuditor`、`OverlapTally`、`StillTracker`、`quadKey`、`defaultPair`；类型 `Body`、`Overlap`、`Counts`、`AuditorOptions` |
| 上限 | `checkLimits`、`formatReport`；类型 `Limits`、`LimitRow`、`LimitReport` |
| 轨迹 | `auditTrajectories`、`bodiesAt`、`trajectorySpan`、`validateTrajectories`、`inPolygon`；类型 `TrajectoryFile`、`TrajVehicle`、`SnapBody`、`Frame` |

## 测试

```bash
npm test -w @storewright/overlap-audit     # 分离轴和精确的相交面积一致、网格和暴力两两比较一致、钩子、上限、命令行退出码
npm run typecheck -w @storewright/overlap-audit
```

## 许可证

[AGPL-3.0-only](../../LICENSE)，和项目其余部分一样。变更记录：[CHANGELOG.md](CHANGELOG.md)。
