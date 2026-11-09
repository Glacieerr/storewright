# MATLAB / Simulink：孪生的机理模型和外部模型服务

> **状态：没有在本机运行过**（作者的电脑上没有 MATLAB 许可证）。方程和孪生里的 TypeScript 版本逐行对应；`selfTest.m` 用 TypeScript 生成的参考数据核对，已经用一段逐行照抄 `reeferModel.m` 的 Python 脚本重算过参考数据，误差 5 × 10⁻¹⁰（CSV 保留 9 位小数）。在 MATLAB 里第一次用时请先跑 `selfTest`。

这里放的是闭环孪生里「模型」那一层的 MATLAB 版本，以及把 MATLAB 接进闭环的例子：

| 文件 | 说明 |
| --- | --- |
| `reeferParams.m`、`reeferModel.m`、`ambientTemp.m` | 冷机的两状态热模型（车厢空气、货物），压缩机按设定温度上下回差启停；和 `src/twin/models.ts` 的 `reeferStep` 一样 |
| `estimateLeak.m` | 用模型残差估计「解释不了的漏热」（疑似车门密封不严），和孪生收到冷机读数时做的一样 |
| `etaKalman.m`、`etaAhead.m` | 车辆延误的卡尔曼滤波（延误、增长速度），孪生里用的是同一思路的 alpha-beta 滤波 |
| `StoreXTwinClient.m` | 孪生服务的 REST 客户端（接口见 `server/protocol.md`） |
| `runModelService.m` | MATLAB 当闭环里的一个「模型服务」：从孪生服务取冷机读数，用自己的模型独立估计、往后推 60 分钟，预计超标就发「设定温度调低 2 °C」的指令给现场 |
| `buildReeferSimulink.m` | 用代码搭出同样方程的 Simulink 模型（`reefer_twin.slx`）：两个积分器、继电器模拟压缩机启停 |
| `selfTest.m`、`reference/` | 自检：同样的输入逐分钟重算，和 TypeScript 的结果比（`npx tsx engines/matlab/reference/make.ts` 重新生成参考数据） |

## 用法

```matlab
cd engines/matlab
selfTest                         % 三段情形（冷藏车密封不严、冷冻车压缩机故障、额外漏热），误差应在 1e-6 以内
mdl = buildReeferSimulink('chilled');
```

和孪生服务一起跑（先在仓库目录启动服务，开加速、多事的一天）：

```bash
npx tsx server/twinServer.ts --level rough --policy manual --speed 30 --start 4
```

```matlab
c = StoreXTwinClient("http://127.0.0.1:8787");
s = c.state();  disp(s.clock)
cards = c.recommendations();
runModelService("http://127.0.0.1:8787", 60)   % 跑 60 秒（真实时间）
```

`runModelService` 发出的指令和孪生自己的建议走的是同一条路（`/api/command` → 现场），孪生会在下一批冷机读数里看到设定温度变了——这就是闭环：外部的机理模型给出控制，现场执行，数据再回到孪生。

## 和 TypeScript 版本的对应

| MATLAB | TypeScript |
| --- | --- |
| `reeferParams`、`reeferModel` | `REEFER`、`reeferParams`、`reeferStep`（`src/twin/models.ts`） |
| `estimateLeak` | `Twin.ingest` 里 `temp` 消息的残差学习（`src/twin/twin.ts`） |
| `etaKalman`、`etaAhead` | `filterUpdate`、`filterAhead`（alpha-beta 版本） |
| `ambientTemp` | `ambient` |
