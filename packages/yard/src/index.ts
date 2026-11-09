/**
 * @storewright/yard — truck-yard and loading-dock motion engine (pure TypeScript, no dependencies, deterministic).
 *
 * - {@link planYard} lays out one-way lanes in front of a dock wall: the court lane along the doors, an exit lane, a staging
 *   lane with numbered slots and a top lane, plus drop-trailer stalls, markings and the junction with the street.
 * - {@link yardRoute} gives one vehicle its whole path: gate → staging slot → U-turn → court lane → pull past the door with the
 *   cab swung out → reverse from the driver's side until the trailer is square and docked → straight pull-out → exit.
 *   Articulated rigs are modelled as tractor + semi-trailer (kingpin kinematics), rigid trucks by their rear axle.
 * - {@link scheduleYard} turns hard times from your simulation (arrive / dock / leave) into one schedule for the whole yard:
 *   first come first served, one manoeuvring vehicle per wall section, exits first, never two vehicles at one door, drop-and-hook
 *   with a yard shunter. {@link poseAt} samples any vehicle at any moment for rendering.
 * - An optional site registry ({@link defineYardSite}, {@link setSiteVisits}, {@link siteSchedule}) caches one schedule per site.
 *
 * Local frame: the dock wall is z = 0, doors sit at x along it, the yard extends towards +z; heading = atan2(dx, dz)
 * (0 = facing +z, away from the wall). Units are metres and seconds. See README.en.md for a walkthrough.
 */
/**
 * 收货场 / 月台场地引擎（第一部分 Storewright 的卸货场模板，推广到区域里每一面月台墙）：门店收货场、物流园配送中心和冷链中心的月台、
 * 港口拆装箱库和保税库的两面月台、机场货站陆侧的收货口都用这一套。纯函数，不依赖 three.js，结果是确定的。
 *
 * ── 怎么用（场地搭建者）──
 * 1. 本地坐标：月台墙在 z = 0，门在墙上的 x 处，场地朝 +z 伸出去；车头朝向 heading = atan2(dx, dz)（0 = 朝 +z，背对墙）。
 *    场地放进区域：defineYardSite({ key, frame: { origin, yaw }, plan, doors }) 登记，yawOf(frame, heading) 换成 three.js 的 yaw
 *    （车模车头朝 +x，和 fleet.ts 一样），toWorld / toLocal 换坐标（和 stores.ts 的 toWorld 一样：yaw 就是绕 y 轴转的角）。
 * 2. planYard(input) 排车道：从墙往外依次是靠台车道（向 +x）、驶离车道（向 −x）、待命车道（向 −x，画车位，先到的在 −x 头）、
 *    顶部车道（向 +x）；全是右侧通行的单向绕行，半挂车从司机一侧（左侧）倒车靠台。进场道路（后勤通道）在场地的左头或右头，
 *    从墙后面上来（from: 'back'，像门店：通道沿着楼的侧面）或从场地远端下来（from: 'front'，像物流园：大门在场地外沿）；
 *    接路口可以是喇叭口的专用通道（access: 'drive'，路缘半径 15 米）或信号灯路口的支路（'street'）。
 *    进深不够画全套时退成紧凑布置（没有顶部车道，或者排队排在进场道路上），plan.level 和 plan.notes 说明。
 *    要画的东西都在 plan 里：车道线、虚线、箭头、停止线、待命车位框、甩挂车位框、「货车入口」牌、水泥地坪的范围、喇叭口的沥青面。
 * 3. yardRoute(plan, door, vehicle) 给一辆车在场里的整套路线：进场点 → 待命车道（slotS(j) 是第 j 个车位在车道上的距离）
 *    → 掉头 → 靠台车道 → 驶过门、车头外摆 → 从司机一侧倒车靠台（挂车在离墙 24 米外摆正）→ 笔直拉出、挂车越过两边车头再转弯 → 驶离。
 *    半挂车的位置是牵引销，单体车（厢式货车、面包车、单独的牵引车）是后轴中心；footprint(vehicle, pose) 给车身的矩形。
 * 4. scheduleYard(plan, visits) 按仿真的时刻排场内的动作：visits 带仿真给的硬时刻（arrive 到进场点、dockAt 开始装卸、
 *    leaveAt 开始拉出）。先到先进（待命车道单列，按进场顺序排），场地里按区段同一时间只有一辆车在调车（门少的场地就是整个场地一辆），
 *    驶离优先，同一个门不会同时有两辆车；调车放进仿真给的时间窗，多出来的时间停在倒车起点打双闪；窗口太短时压缩到下限并标 tight。
 *    poseAt(timeline, t, out) 取任一时刻的位姿（半挂车带挂车航向、倒车、双闪、刹车），渲染直接用。
 *    甩挂（drop-and-hook）：visits 里 mode = 'drop' 的车把挂车甩在甩挂车位就走，场内牵引车按 dockAt 把挂车拖到门、装卸完拖回车位，
 *    取挂的车（mode = 'hook'）来车位挂上就走；shunterRoute 给场内牵引车「车位 → 门」「门 → 车位」的路线。
 *    同一个场地一天一份排程：场地搭建者用 setSiteVisits(key, visits) 登记全部访问（背景车和仿真车），仿真车的编号是 simVisitId(vid, stop)
 *    （vid 是 WVehicle.id；stop 是这辆车在这个地点停留的第一段轨迹的下标，紧接着的同一个地点的停留算一次），时刻用 simVisitFor 算：
 *    仿真的到达时刻车头在进场点、仿真的离开时刻车头在驶出点。siteSchedule(key) / siteTimeline(key, id) 取结果（缓存，访问或布置变了才重算）；
 *    运动规划（web/src/three/motion.ts）按门编号（三维地点键，或调度台的 D12、C05）找到门以后，道路段在进场点结束，场内按时间线走；
 *    地点的 path 要在进场点结束，leave（或 exit）要从驶出点开始。场地没登记某一辆时运动规划自己补上（addSimVisit）。
 *    siteSummary / yardSummaries 给每个场地 tight、lateDock、lateExit 的汇总（看板、值班助手读）。
 * 5. 检查（测试和场地搭建者都用）：checkRoute 查倒车、拉出时车身碰不碰两边门口停着的车，铰接角，挂车摆正的位置，
 *    牵引车车头进不进待命车道，转弯半径；checkPlan 查车道顺序、车位在场地里。
 */
import { PREP, SWING_WAIT } from './consts';
import { TimedPath } from './path';
import { laneDrive, yardRoute } from './routes';
import { scheduleYard } from './sched';

/** A point on the ground plane (metres, local or world). 地面上的点（米）。 */
export interface Pt {
  x: number;
  z: number;
}

/**
 * 场内的车型：半挂车（常温、冷藏）、集卡（骨架车拉集装箱）、单体厢式货车、面包车、场内牵引车（拖着挂车）
 * Vehicle classes: semi-trailer rig (dry, reefer), container chassis rig, rigid box truck, van, yard shunter (with a trailer).
 */
export type YardVehicle = 'semi' | 'reefer' | 'chassis' | 'truck' | 'van' | 'shunter';

/**
 * 铰接车的尺寸（米，从牵引销量）：牵引车车头在前 front 处、车尾在后 tractorRear 处；挂车前端在前 trailerFront 处、车尾在后 rear 处、车轴组中心在后 axle 处
 * Articulated rig dimensions in metres, measured from the kingpin: tractor front / rear, trailer front / rear, trailer axle group.
 */
export interface RigDims {
  kind: 'rig';
  front: number;
  tractorRear: number;
  trailerFront: number;
  rear: number;
  axle: number;
  width: number;
  /** 牵引车前轴到牵引销（≈ 后轴）的距离，算前轮转角用 */
  wheelbase: number;
}
/**
 * 单体车的尺寸（米）：车长、车宽、轴距、后轴到车尾
 * Rigid vehicle dimensions in metres: length, width, wheelbase, rear overhang (rear axle to tail).
 */
export interface BodyDims {
  kind: 'body';
  length: number;
  width: number;
  wheelbase: number;
  rearOverhang: number;
}
export type VehicleDims = RigDims | BodyDims;

/**
 * 一辆车此刻的位姿：铰接车 (x, z) 是牵引销、heading 是牵引车、trailer 是挂车；单体车 (x, z) 是后轴中心，trailer = heading
 * Pose at one moment: for rigs (x, z) is the kingpin, `heading` the tractor and `trailer` the trailer; for rigid vehicles (x, z) is the rear-axle centre and trailer = heading.
 */
export interface RigPose {
  x: number;
  z: number;
  heading: number;
  trailer: number;
  reversing: boolean;
  /** 米 / 秒（倒车也是正值）、前轮转角（弧度，向左为正） */
  speed: number;
  steer: number;
}

export type YardSide = 'left' | 'right';
export type YardAccess = 'drive' | 'street';
export type YardFrom = 'back' | 'front';

/**
 * 一个门：位置、能靠哪些车（不给 = 全部）、冷库门、编号
 * A door: position along the wall, which vehicles may use it (default all), cold-store door, id.
 */
export interface YardDoorInput {
  x: number;
  kinds?: YardVehicle[];
  cold?: boolean;
  id?: string;
}
export interface YardDoor {
  x: number;
  kinds: YardVehicle[];
  cold: boolean;
  id: string;
  /** 门所在的区段（长墙分几段，每段同一时间一辆车调车） */
  section: number;
}

/** Input of {@link planYard}: doors, usable x range and depth, access side and type, optional queue, drop stalls and street. 场地布置的输入。 */
export interface YardInput {
  doors: ReadonlyArray<number | YardDoorInput>;
  /** 场地能用的 x 范围（含进场道路）和从墙算起的进深 */
  x0: number;
  x1: number;
  depth: number;
  /** 进场道路在 +x 头（right）还是 −x 头（left） */
  side: YardSide;
  /** 进场道路从墙后面上来（back，默认）还是从场地远端下来（front） */
  from?: YardFrom;
  /** 接路口：喇叭口专用通道（drive，默认）或信号灯路口的支路（street） */
  access?: YardAccess;
  /** 进场道路中心线 x、半宽（默认 4.5：一进一出两条 4.5 米车道）；不给时贴着 x0 / x1 */
  driveX?: number;
  driveHalf?: number;
  /** 进场道路在场地外还有多长（米，默认 60）：待命车位满了以后排在这段路上 */
  driveLen?: number;
  /** 待命车位（0 / 不给 = 按门数自动） */
  queue?: number;
  /** 甩挂车位 */
  drop?: number;
  /** 挂车最晚在离墙多远处摆正（默认 24 米；车越长越往外） */
  alignAt?: number;
  /** 长墙分段：每段最长多少米（默认 70）；同一段里同一时间只有一辆车调车 */
  sectionSpan?: number;
  /** 路口外的道路（可选）：中心线 z（back 时在墙后 z < 0，front 时在场地外 z > 进深）、半宽、车道离中心线多远 */
  road?: { z: number; half: number; laneOffset?: number; spanX?: [number, number] };
}

/** Paint and signs to draw (lines, arrows, stop lines, stall boxes, signs). 要画的标线和标牌。 */
export type YardMark =
  | { kind: 'line'; pts: Pt[]; color: 'white' | 'yellow'; dashed?: boolean; width: number }
  | { kind: 'arrow'; at: Pt; heading: number }
  | { kind: 'stop'; a: Pt; b: Pt }
  | { kind: 'box'; at: Pt; heading: number; w: number; d: number; label?: string }
  | { kind: 'sign'; at: Pt; heading: number; text: string };

/** A drop-trailer stall: trailer axle-group centre, heading, id. 甩挂车位。 */
export interface YardStall {
  /** 挂车停好时车轴组中心的位置、挂车车头朝向；front 是挂车前端（场内牵引车挂上它的地方） */
  x: number;
  z: number;
  heading: number;
  id: string;
}

/** Output of {@link planYard}: lane positions, doors, queue slots, stalls, sections, markings and junction geometry. 场地布置的结果。 */
export interface YardPlan {
  /** full：四条车道；compact：没有顶部车道，驶离车道直接回进场道路；court：只有靠台车道，排队在进场道路上 */
  level: 'full' | 'compact' | 'court';
  notes: string[];
  side: YardSide;
  from: YardFrom;
  access: YardAccess;
  x0: number;
  x1: number;
  /** 场地外沿（从墙算起实际用到的进深） */
  z1: number;
  doors: YardDoor[];
  /** 车道几何按哪种车排（门能靠的最长的车） */
  design: YardVehicle;
  /** 进场道路：中心线、半宽；进场车道、驶离车道中心 x；在场地外的长度 */
  driveX: number;
  driveHalf: number;
  xIn: number;
  xOut: number;
  driveLen: number;
  /** 靠台车道、驶离车道、待命车道、顶部车道的中心 z（没有的车道是 NaN） */
  zCourt: number;
  zExit: number;
  zQueue: number;
  zTop: number;
  /** 门口停着的车车头连成的线、挂车必须在这条线以外摆正的位置、水泥地坪到哪 */
  noseLine: number;
  alignZ: number;
  apronZ: number;
  /** 待命车道：车位数、间距、排在最前的车车头 x、排队方向（-1 = 向 −x）；车位框的位置 */
  queue: { slots: number; pitch: number; xHead: number; dir: 1 | -1; onDrive: number };
  /** 两头掉头处：靠台掉头的起点 x、驶离掉头的起点 x、东头掉头 x（左侧进场） */
  xTurnDock: number;
  xTurnExit: number;
  xEast: number;
  /** 进场点、驶出点（进场道路和场地边的交点，车道中心） */
  gateIn: Pt;
  gateOut: Pt;
  stalls: YardStall[];
  /** 长墙的区段：x 范围 */
  sections: Array<{ x0: number; x1: number }>;
  marks: YardMark[];
  /** 喇叭口的沥青面（多边形）、路口停止线、等灯还是让行 */
  junction?: { flares: Pt[][]; stop: { a: Pt; b: Pt }; signal: boolean; yieldSec: number };
  /** 规划用的输入（复制一份） */
  input: YardInput;
}

/**
 * 一段按时间走的路径（TimedPath、带停车等待的 PathChain）
 * State sampled from a timed path (position, heading, speed, acceleration, steering, distance).
 */
export interface PathState {
  x: number;
  z: number;
  heading: number;
  speed?: number;
  accel?: number;
  steer?: number;
  dist?: number;
}
/** Anything with a duration that can be sampled at a time offset (TimedPath, PathChain). 能按时间取样的路径。 */
export interface PathLike {
  readonly duration: number;
  at(tau: number, out: PathState): void;
}

/**
 * 场内的一次访问（仿真给的硬时刻）：
 * - live（默认）：车自己排队、靠台、装卸、拉出驶离；
 * - drop：公路牵引车 arrive 时拖着挂车进来、甩在车位就走；场内牵引车在 dockAt 前把挂车拖到门、leaveAt 后拖回车位；
 *   给了 pickupAt 的，到时有空车来把它挂走；
 * - hook：一个一早就在车位里的空挂车，场内牵引车在 dockAt 前拖到门装货、leaveAt 后拖回车位，arrive 时有空车来挂走（arrive ≥ leaveAt）。
 *
 * One visit with hard times from your simulation: arrive at the gate, start loading (dockAt), start pulling out (leaveAt).
 * `live` (default): the vehicle queues, docks, works and leaves itself; `drop`: the road tractor drops the trailer in a stall
 * and leaves, a yard shunter moves it to the door and back; `hook`: an empty trailer waiting in a stall is shunted to the door,
 * loaded, shunted back and collected at `arrive`.
 */
export interface YardVisit {
  id: string;
  vehicle: YardVehicle;
  /** plan.doors 的下标（drop / hook 时是装卸这个挂车的门） */
  door: number;
  /** 到进场点的时刻、开始装卸、开始拉出（秒） */
  arrive: number;
  dockAt: number;
  leaveAt: number;
  mode?: 'live' | 'drop' | 'hook';
  /** 甩挂：挂车停哪个车位（不给就自动挑）、空车来挂走的时刻 */
  stall?: number;
  pickupAt?: number;
  /** 进场点以前的一段（道路段结束的地方 → 登记亭停一会儿 → 等候区 → 进场点）：按时刻一段段走（区域坐标） */
  pre?: YardPiece[];
  /** 整次停靠不走场地的靠台流程，按这几段走（甩挂：空车头去甩挂区挂上挂车再走）；leave 是之后开出去的路（区域坐标） */
  script?: YardPiece[];
  leave?: Pt[];
  /** 不经进场点、直接从靠台车道的起点进来（court 布置，车沿月台前的车道开过来） */
  via?: 'court';
  own?: boolean;
}

/** 按时刻走的一段：drive 沿 pts（车头的路）开、back 倒车（pts 是牵引销的路）、stop 停着；bobtail = 只有牵引车（挂车不画） */
/** A scripted piece of motion by time: drive along points, reverse, or stop; `bobtail` = tractor only. 按时刻走的一段。 */
export interface YardPiece {
  kind: 'drive' | 'back' | 'stop';
  pts?: Pt[];
  t0: number;
  t1: number;
  bobtail?: boolean;
}

/** hold：在场外等候区等；pool：甩下的挂车停在甩挂车位 */
/** Segment kinds of a timeline (hold outside, approach, queue, enter, wait, reverse, prep, docked, pull-out, exit, drop, hook, shunt, pool). 时间线分段的种类。 */
export type YardSegKind = 'hold' | 'approach' | 'queue' | 'enter' | 'wait' | 'back' | 'prep' | 'docked' | 'pullout' | 'exit' | 'drop' | 'hook' | 'shunt' | 'pool';
/** One timeline segment; `hazard` = hazard lights on. 时间线的一段。 */
export interface YardSeg {
  kind: YardSegKind;
  t0: number;
  t1: number;
  /** 打双闪（倒车起点等着、靠台准备） */
  hazard?: boolean;
}

/** One visit's schedule: segments and key times (joined queue, entered, started reversing, docked, unloading, out, gone), tight / late flags. 一次访问的时间线。 */
export interface YardTimeline {
  visit: YardVisit;
  segs: YardSeg[];
  /** 进入待命车道、开始进场调车、开始倒车、靠稳、车头开到驶出点、开完整条驶离路线的时刻 */
  joinAt: number;
  enterAt: number;
  backAt: number;
  dockedAt: number;
  /** 开始装卸（靠稳、做完准备；仿真的靠台时刻是期望，不是硬的） */
  unloadAt: number;
  outAt: number;
  goneAt: number;
  /** 窗口太短压缩过（tight）、晚了几秒才靠稳 / 拉出 */
  tight: boolean;
  lateDock: number;
  lateExit: number;
  notes: string[];
}

/** Output of {@link scheduleYard}: one timeline per visit plus yard-shunter moves. 整个场地的排程。 */
export interface YardSchedule {
  plan: YardPlan;
  timelines: YardTimeline[];
  /** 场内牵引车的作业（甩挂才有） */
  shunts: Array<{ trailer: string; from: string; to: string; t0: number; t1: number }>;
  notes: string[];
}

// ———————————————————————— 场地登记（交给区域的运动规划） ————————————————————————

/**
 * 场地放进区域的坐标系：原点（沙盘米）、绕 y 轴转的角（three.js 的 yaw；本地 +x 转到 (cos yaw, −sin yaw)）
 * Placement of a yard in your world: origin and rotation about the vertical axis (three.js-style yaw; local +x maps to (cos yaw, −sin yaw)).
 */
export interface YardFrame {
  origin: Pt;
  yaw: number;
}
/** A door of a registered site: your simulation's door id, plan door index, optional road approach / leave paths. 登记场地的门。 */
export interface YardSiteDoor {
  /** 仿真里的门 / 停靠点编号（例如 C05、D12、门店收货口 1） */
  id: string;
  /** plan.doors 的下标 */
  index: number;
  kinds?: YardVehicle[];
  /** 这个门的最后一段路（区域坐标）：approach 从离开道路的地方到道路段结束的地方（进场点，或登记亭、再由 visit.pre 接到进场点）；leave 从驶出点到道路 */
  approach?: Pt[];
  leave?: Pt[];
}
/** A yard placed in the world under a key, for the optional site registry. 登记的场地。 */
export interface YardSite {
  /** 和仿真的地点 / 停靠点对应的键（store、dc-dry、dc-cold、air-landside、port-cfs-box、port-cfs-truck……） */
  key: string;
  frame: YardFrame;
  plan: YardPlan;
  doors: YardSiteDoor[];
}

const SITES = new Map<string, YardSite>();
/** 场地搭建者登记的当天全部访问（背景车和仿真车）、运动规划知道的仿真车访问（场地没登记它们时补上） */
const VISITS = new Map<string, YardVisit[]>();
const SIM_VISITS = new Map<string, Map<string, { visit: YardVisit; aliases: readonly string[] }>>();
/** 版本：场地布置或访问变了就加一，排程缓存和运动规划按它重算 */
const VERSION = new Map<string, number>();
const CACHE = new Map<string, { ver: number; sched: YardSchedule; byId: Map<string, YardTimeline> }>();
const bump = (key: string) => VERSION.set(key, (VERSION.get(key) ?? 0) + 1);

/**
 * 登记一个场地（同一个键再登记就替换）
 * Register (or replace) a site in the registry.
 */
export function defineYardSite(site: YardSite): YardSite {
  SITES.set(site.key, site);
  bump(site.key);
  return site;
}
/** Look up a registered site. 按键找场地。 */
export function yardSite(key: string): YardSite | undefined {
  return SITES.get(key);
}
/** All registered sites. 全部登记的场地。 */
export function yardSites(): YardSite[] {
  return [...SITES.values()];
}
/**
 * 清空登记（换区域、测试用）
 * Clear the registry (switching maps, tests).
 */
export function clearYardSites(): void {
  for (const k of SITES.keys()) bump(k);
  SITES.clear();
  VISITS.clear();
  SIM_VISITS.clear();
  CACHE.clear();
}

/**
 * 场地当天的全部访问（场地搭建者登记）：背景车和仿真车都在里面，同一个场地只有一份排程，画面里的车互相让。
 * 仿真车的编号用 simVisitId(vid, stop)，时刻最好用 simVisitFor 算（和运动规划算的一样）。
 * Set all of a site's visits for the day (background and simulated vehicles share one schedule, so they give way to each other).
 */
export function setSiteVisits(key: string, visits: YardVisit[]): void {
  VISITS.set(key, [...visits]);
  bump(key);
}
/**
 * 仿真车访问的编号：vid 是车辆下标，stop 是这辆车在这个地点停留的那一段轨迹的下标
 * Visit id for a simulated vehicle `vid` at its stop index `stop`.
 */
export function simVisitId(vid: number, stop: number): string {
  return `sim:${vid}:${stop}`;
}
/**
 * 运动规划知道的仿真车访问（场地没登记这一辆时用它补上；场地登记了同一个编号的就用场地的）。
 * aliases：同一次停靠的其他编号（连着几段停在同一个地点，比如先等收货时间、再卸货，场地可能按其中任何一段登记）。
 * Add a simulated vehicle's visit unless the site already registered it (or one of its aliases).
 */
export function addSimVisit(key: string, visit: YardVisit, aliases: readonly string[] = []): void {
  let m = SIM_VISITS.get(key);
  if (!m) SIM_VISITS.set(key, (m = new Map()));
  const old = m.get(visit.id)?.visit;
  if (old && old.arrive === visit.arrive && old.dockAt === visit.dockAt && old.leaveAt === visit.leaveAt && old.door === visit.door && old.vehicle === visit.vehicle) return;
  m.set(visit.id, { visit, aliases });
  bump(key);
}
/**
 * 换一天的车：清掉运动规划补的仿真车访问
 * Drop added simulation visits (all sites, or one), e.g. when a new day starts.
 */
export function clearSimVisits(key?: string): void {
  if (key === undefined) {
    for (const k of SIM_VISITS.keys()) bump(k);
    SIM_VISITS.clear();
  } else if (SIM_VISITS.delete(key)) bump(key);
}
/** Version counter of a site; bumps whenever its layout or visits change. 场地的版本号（布置或访问变了就加一）。 */
export function siteVersion(key: string): number {
  return VERSION.get(key) ?? 0;
}
/**
 * 这个场地当天的排程（缓存；场地布置或访问变了才重算）；没登记这个场地返回 undefined
 * The day's schedule of a registered site (cached until its layout or visits change).
 */
export function siteSchedule(key: string): YardSchedule | undefined {
  const site = SITES.get(key);
  if (!site) return undefined;
  const ver = siteVersion(key);
  const hit = CACHE.get(key);
  if (hit && hit.ver === ver) return hit.sched;
  const own = VISITS.get(key) ?? [];
  const ids = new Set(own.map((v) => v.id));
  const extra = [...(SIM_VISITS.get(key)?.values() ?? [])].filter((e) => !ids.has(e.visit.id) && !e.aliases.some((a) => ids.has(a))).map((e) => e.visit);
  // 按几段走的访问（甩挂：空车头去甩挂区）不占靠台车道和门，不排
  const all = [...own, ...extra].filter((v) => v.door >= 0 && v.door < site.plan.doors.length && !v.script?.length);
  const sched = scheduleYard(site.plan, all);
  CACHE.set(key, { ver, sched, byId: new Map(sched.timelines.map((tl) => [tl.visit.id, tl])) });
  return sched;
}
/**
 * 一次访问（场地登记的优先，其次运动规划补的）
 * One visit of a site (registered visits first, then added simulation visits).
 */
export function siteVisit(key: string, id: string): YardVisit | undefined {
  return (VISITS.get(key) ?? []).find((v) => v.id === id) ?? SIM_VISITS.get(key)?.get(id)?.visit;
}
/**
 * 一次访问在这个场地的时间线
 * The timeline of one visit at a site.
 */
export function siteTimeline(key: string, id: string): YardTimeline | undefined {
  if (!siteSchedule(key)) return undefined;
  return CACHE.get(key)?.byId.get(id);
}

/**
 * 仿真车一次停靠的访问（运动规划和场地搭建者都用这个算，时刻才对得上）：
 * arrive = 仿真的到达时刻（车在这一刻开到进场点）；leaveAt = 仿真的离开时刻减去从门口开到驶出点的时间（车在仿真的离开时刻正好开出驶出点）；
 * dockAt = 到达后留出进场、倒车、靠台准备的时间（停留短的按停留的 45%，排不下时排程会压缩并标 tight）。
 * Build a visit from a simulated stay [t0, t1]: arrive at t0, leave the gate at t1, dock time leaves room for entry and reversing.
 */
export function simVisitFor(key: string, vid: number, stop: number, vehicle: YardVehicle, door: number, t0: number, t1: number): YardVisit | undefined {
  const site = SITES.get(key);
  if (!site) return undefined;
  const t = nominalTimes(site.plan, door, vehicle);
  const stay = Math.max(1, t1 - t0);
  const leaveAt = Math.max(t0 + stay * 0.55, t1 - t.toGate);
  const dockAt = Math.min(t0 + t.toDock, t0 + stay * 0.45, leaveAt - 30);
  return { id: simVisitId(vid, stop), vehicle, door, arrive: t0, dockAt, leaveAt, own: true };
}

const NOMINAL = new Map<string, { toDock: number; toGate: number }>();
/** 一个门、一种车的标准用时：进场点 → 靠稳并做完准备、门口 → 驶出点 */
function nominalTimes(plan: YardPlan, door: number, vehicle: YardVehicle): { toDock: number; toGate: number } {
  const key = `${plan.x0},${plan.x1},${plan.z1},${plan.zCourt},${door},${vehicle}`;
  let v = NOMINAL.get(key);
  if (!v) {
    const r = yardRoute(plan, door, vehicle);
    // 进场点起步开到待命车道排头（停一下）、再进场调车：和排程走的一样，再留 15 秒余量（排程按 5 秒一档找时刻）
    const head = r.slotS(0);
    const toHead = head > r.sGate ? new TimedPath(r.lane.slice(r.sGate, head), 3.6, false, { accel: 0.6, decel: 0.9, lat: 1.1, v0: 0, v1: 0 }).duration : 0;
    const enter = laneDrive(r, Math.max(head, 0), 0);
    const d = r.dims;
    const prep = d.kind === 'rig' ? PREP.rig : d.length > 8 ? PREP.truck : PREP.van;
    v = { toDock: toHead + enter.duration + (d.kind === 'rig' ? SWING_WAIT.rig : SWING_WAIT.body) + r.back.path.duration + prep + 15, toGate: r.exit.tGate };
    NOMINAL.set(key, v);
  }
  return v;
}

/**
 * 一个场地当天调车的情况：多少次访问、几次时间窗太紧、靠台和拉出一共晚了多少（看板、值班助手读）
 * Daily summary of a site: visits, tight windows, docking and exit lateness, held vehicles, worst cases.
 */
export interface YardSiteSummary {
  key: string;
  visits: number;
  tight: number;
  /** 靠台晚了的秒数合计、最多的一次；拉出晚了的秒数合计 */
  lateDock: number;
  maxLateDock: number;
  lateExit: number;
  /** 在场外等候区等过的车、最长等了多久（秒） */
  held: number;
  maxHold: number;
  /** 晚得最多的几次 */
  worst: Array<{ id: string; lateDock: number; lateExit: number; own: boolean }>;
  notes: string[];
}
/** Summary of one registered site. 一个场地的汇总。 */
export function siteSummary(key: string): YardSiteSummary | undefined {
  const s = siteSchedule(key);
  if (!s) return undefined;
  const tls = s.timelines;
  const hold = (tl: YardTimeline) => tl.segs.filter((x) => x.kind === 'hold').reduce((a, x) => a + x.t1 - x.t0, 0);
  return {
    key,
    visits: tls.length,
    tight: tls.filter((tl) => tl.tight).length,
    lateDock: tls.reduce((a, tl) => a + tl.lateDock, 0),
    maxLateDock: tls.reduce((a, tl) => Math.max(a, tl.lateDock), 0),
    lateExit: tls.reduce((a, tl) => a + tl.lateExit, 0),
    held: tls.filter((tl) => hold(tl) > 0).length,
    maxHold: tls.reduce((a, tl) => Math.max(a, hold(tl)), 0),
    worst: [...tls]
      .filter((tl) => tl.lateDock > 0 || tl.lateExit > 0)
      .sort((a, b) => b.lateDock + b.lateExit - (a.lateDock + a.lateExit))
      .slice(0, 5)
      .map((tl) => ({ id: tl.visit.id, lateDock: tl.lateDock, lateExit: tl.lateExit, own: !!tl.visit.own })),
    notes: [...s.notes],
  };
}
/**
 * 所有登记了的场地的调车情况
 * Summaries of all registered sites.
 */
export function yardSummaries(): YardSiteSummary[] {
  return [...SITES.keys()].map((k) => siteSummary(k)).filter((x): x is YardSiteSummary => !!x);
}
/**
 * 按仿真的门编号找场地和门
 * Find the site and door for a door id from your simulation.
 */
export function findYardDoor(id: string): { site: YardSite; door: YardSiteDoor } | undefined {
  for (const site of SITES.values()) {
    const door = site.doors.find((d) => d.id === id);
    if (door) return { site, door };
  }
  return undefined;
}

/**
 * 本地 → 区域（沙盘米）
 * Local yard frame → world.
 */
export function toWorld(f: YardFrame, p: Pt): Pt {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return { x: f.origin.x + p.x * c + p.z * s, z: f.origin.z - p.x * s + p.z * c };
}
/**
 * 区域 → 本地
 * World → local yard frame.
 */
export function toLocal(f: YardFrame, p: Pt): Pt {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  const dx = p.x - f.origin.x;
  const dz = p.z - f.origin.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}
/**
 * 本地的车头朝向（atan2(dx, dz)）→ 区域里的 three.js yaw（车模车头朝 +x，和 fleet.ts、motion.ts 的 partPose 一样）
 * Local heading (atan2(dx, dz)) → world yaw for a model whose nose points along +x (three.js style).
 */
export function yawOf(f: YardFrame | undefined, heading: number): number {
  return heading - Math.PI / 2 + (f?.yaw ?? 0);
}
/**
 * 区域里的 three.js yaw → 本地的车头朝向
 * World yaw → local heading.
 */
export function headingOf(f: YardFrame | undefined, yaw: number): number {
  return yaw + Math.PI / 2 - (f?.yaw ?? 0);
}

export { VEHICLE_DIMS, BOBTAIL, setVehicleDims, dimsOf, lengthOf, frontOf, backOf, footprint, noseOf, rearOf, forwardRig, BodyRig, type DistRig, type ChainUnit, type ChainPose, type OBB } from './rig';
export { ForwardRig, ReverseRig, TowChain } from './rig';
export { Polyline, fillet, angDiff, minRadius, obbIntersects } from './geom';
export { TimedPath, PathChain, type Dynamics } from './path';
export { planYard } from './plan';
export { yardRoute, shunterRoute, stallRoute, laneDrive, lanePose, QueueMotion, queueTargets, type YardRoute, type ShuntRoute } from './routes';
export { scheduleYard, poseAt, courtResources, type PoseInfo, type PoseUnit } from './sched';
export { checkRoute, checkPlan, type RouteCheck } from './check';
