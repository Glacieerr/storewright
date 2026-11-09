# Changelog · 变更记录

All notable changes to `@storewright/yard` are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - Unreleased (date set at the first release · 首次发布时填写日期)

### Added · 新增

- First release as a standalone library, extracted from StoreX Chain (`StoreX-Chain/src/yard`), where it drives every receiving yard of the regional twin. 从 StoreX 全链路拆出来的第一个独立版本。
- Layout (`planYard`): court, exit, staging and top lanes, drop-trailer stalls, markings, junction flares; compact and court-only fallbacks. 场地布置。
- Routes (`yardRoute`, `shunterRoute`, `stallRoute`): driver-side reversing with articulated trailers, swing-out set-up scored and checked against neighbouring docked vehicles. 路线：从司机一侧倒车、挂车铰接。
- Schedule (`scheduleYard`) and sampling (`poseAt`): first come first served, one manoeuvre per wall section, exits first, one vehicle per door, drop-and-hook with a yard shunter, `tight` / lateness flags. 排程和取样。
- Optional site registry with per-site caching and summaries. 可选的场地登记。
- English doc comments on the public API; English and Chinese READMEs; a runnable example and a browser demo. 英文接口说明、中英文 README、例子和浏览器演示。
- Overload handling in `scheduleYard`: an entry-gate resource (the access road's entry lane plus its first turn), car-following on the gate and in the staging lane, off-site queueing (`hold`) instead of vehicles drawn inside each other; `QueueMotion` takes an optional `limit(t)` for car-following; `courtResources` also reports the entry gate (`G`). 超负荷时的处理：进场通道资源、跟车、在场外等候区排队。
- Overload test matrix (`test/overload.test.ts`): loads, door counts, access options, layouts and drop-and-hook, audited every second with `@storewright/overlap-audit`, plus route checks, FIFO, one manoeuvre per section, one vehicle per door, time semantics and determinism. 超负荷测试矩阵。
- `npm run bench`: scheduling time, `--mem` retained memory, `--hash` / `--check` output fingerprints. 新增 `npm run bench`：排程耗时、`--mem` 内存、`--hash` / `--check` 结果指纹。

### Changed · 变更（发布前）

- Scheduling is about 3× faster and keeps about a quarter of the memory, with identical results (timelines, segments, shunter moves and per-second poses compared by fingerprint on 292 cases, 256 of them random). On an idle laptop the overload matrix plus the demo settings take about 0.8 s instead of 2.4 s, a 24-door day of 300 visits about 0.14 s instead of 0.53 s, and a plan with its schedule retains 3–10 MB instead of 10–41 MB. How: the occupancy table keeps each resource's spans sorted by start with a running maximum of their ends (conflict checks are a binary search); drop-and-hook routes are built once per stall and door per schedule; lane drives are shared; the reversing check prepares parked vehicles once; polylines, timed paths and staging-lane motion store their samples in `Float64Array`s. `pts`, `cum`, `cumT` and `cumD` are now getters that build plain arrays on first read, so `JSON.stringify` or `Object.keys` of a path object no longer lists them. 排程快约 3 倍、内存约为原来的四分之一，结果一字不差（292 组设置按指纹逐一核对，其中 256 组随机）：空闲的笔记本电脑上，超负荷矩阵加演示设置从约 2.4 秒降到约 0.8 秒，24 个门一天 300 次到车从约 0.53 秒降到约 0.14 秒，一份布置加排程留在内存里从 10–41 MB 降到 3–10 MB。做法：占用表按资源排序、二分查冲突；甩挂路线每个车位和门只算一次；车道起步路径共用；倒车检查预先算好停着的车；折线、路径、排队运动的采样存在 `Float64Array` 里。`pts`、`cum`、`cumT`、`cumD` 改成第一次读时才生成普通数组的取值器，对路径对象做 `JSON.stringify` 或 `Object.keys` 时不再列出它们。

### Fixed · 修复（发布前）

- Overloaded yards no longer produce body overlaps (the browser demo measured 225 pair-seconds at 3 doors and 8 arrivals an hour, 86 with drop-and-hook on 6 doors, and tens of thousands at 16 an hour with drop-and-hook): 超负荷时不再有车身重叠：
  - a vehicle released from the holding area could drive onto the access road together with a new arrival, and vehicles on the approach did not car-follow; 从场外放进来的车和刚到的车同时开上进场道路、进场道路上不跟车；
  - drop-and-hook moves could drive through vehicles queued at the gate, two drops could use adjacent stalls while one was still uncoupling, and with every stall taken two trailers shared a stall; 甩挂的车穿过在进场点排队的车、摘挂时邻位同时倒车、车位不够时两个挂车挤一个车位；
  - a pull-out pushed later because the vehicle docked late was not checked against other vehicles or the next user of the door; 靠稳太晚往后挪的拉出没有避开别的车和下一个用门的车；
  - in the compact layout, exiting vehicles crossing the entry turn were not coordinated with vehicles queued there. 紧凑布置里横穿进场转弯驶离的车没有和在那里排队的车协调。
- A trailer standing on its own (in a stall, at a door, left by the bobtail) is reported with the trailer box only; before, its footprint included a phantom tractor in front of it. 单独停着的挂车的车身只有挂车（之前多算了前面一个并不存在的牵引车）。
