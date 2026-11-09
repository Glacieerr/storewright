import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AgentTrace } from '../../../../StoreX/src/ops/trace';
import type { Layout } from '../../../../StoreX/src/world/layout';
import { Agents3D } from '../../../../StoreX/web/src/three/agents3d';
import { buildStoreModel, setExteriorMode, type StoreModel } from '../../../../StoreX/web/src/three/storeModel';
import type { WVehicle } from '../../../src/sim/trace';
import { FREIGHT_LEN, Vehicles, type PickedVehicle } from './vehicles';
import type { ShipPose } from './motion';
import { clearSimVisits } from '@storewright/yard';
import { FRAMES, RAIL, RAIL_DC_INDEX, SEA_BERTH } from '../../../src/region/region';
import { currentFacilities } from '../../../src/facility/state';
import { dirToWorld, toLocal as frameToLocal, toWorld as frameToWorld, type Frame } from '../../../src/region/frames';
import { setFlagshipDocks, toWorld } from './stores';
import { Traffic, TrafficPlanner, type TrafficData } from './traffic';
import { buildBusStops } from './buses';
import { NightLights } from './lamps';
import { attachLod } from './lod';
import { PedLayer, planPeds, type PedData } from './peds';
import type { TrafficRequest } from '../trafficWorker';
import { buildWorld, P, type World } from './world';
import { PlanMap } from './planMap';
import { PortOps, type GateTrip } from './ops/port';
import { AirportOps } from './ops/airport';
import { ExtTrucks } from './ops/extTrucks';
import { seaY, setTideDay } from './tide';
import { DcOps } from './ops/dc';
import { StoreDocks } from './ops/storeDocks';
import { StoreSiteView } from './store';
import { drain, Poly, STORE_BOX, type Steps } from './ops/kit';
import { RailYard, TRAIN_BOX, WAGONS, wagonBack, type RailWork } from './ops/rail';
import { detect, drawDetections, type VisionObject, type VisionResult } from './vision';
import { SplitScreen, tagHeight, type SplitPair, type SplitSide } from './split';
import { dcDoorsWorld } from './places';
import { describe, speedFactor, Weather, type WeatherMode, type WeatherState } from './weather';
import { FrameBudget, TIER_LABEL, TIERS, type QualityMode, type QualityTier } from './quality';
import { t as tr, tx } from '../i18n';


/**
 * 区域数字孪生的三维视图：整个湾区（港口、机场、高速、铁路、物流园、城区和综合店）+ 当天的车船飞机。
 * 综合店中间放的是 StoreX 的门店模型，镜头拉近时店里的员工、机器人和顾客按 StoreX 的仿真回放（和区域用同一个时钟）。
 * 场景全部由代码生成，可以导出 glTF（.glb），用 Blender 等软件继续加工。
 */
export type RegionPreset = 'overview' | 'port' | 'airport' | 'dc' | 'flagship';
export const REGION_PRESETS: { key: RegionPreset; label: string }[] = [
  { key: 'overview', label: tr('全景') },
  { key: 'port', label: tr('港口') },
  { key: 'airport', label: tr('机场') },
  { key: 'dc', label: tr('物流园') },
  { key: 'flagship', label: tr('综合店') },
];
/** 镜头预设：港口、机场、物流园的目标点和镜头方向按各自的局部坐标写，跟着设施的坐标系转；综合店跟着店的朝向 */
const PRESETS: Record<Exclude<RegionPreset, 'flagship'>, { target: [number, number, number]; offset: [number, number, number]; frame?: 'port' | 'airport' | 'park' }> = {
  overview: { target: [280, 0, -60], offset: [-300, 4900, 4300] },
  port: { target: [-1840, 0, 1380], offset: [620, 430, 640], frame: 'port' },
  airport: { target: [2200, 0, 1150], offset: [-460, 380, 700], frame: 'airport' },
  dc: { target: [1190, 0, -1400], offset: [-420, 330, 560], frame: 'park' },
};

/** 港口、机场里别家的船和货机（不在区域车辆层里，不参与仿真）：在哪里、编号（港口船期里的下标 / 机场的航班编号） */
export interface ExtTarget {
  src: 'port' | 'air';
  id: number;
}
/** 别家的船、货机此刻的说明：船名或航班号、船型或机型、在做什么 */
export interface ExtCard {
  name: string;
  type: string;
  act: string;
}

export type Hover = { kind: 'vehicle'; picked: PickedVehicle; x: number; y: number; half?: 'right' } | { kind: 'agent'; agent: AgentTrace; act?: string; x: number; y: number } | { kind: 'ext'; target: ExtTarget; card: ExtCard; x: number; y: number };

export class RegionView {
  private incidents: { mesh: THREE.Mesh; t0: number; t1: number }[] = [];
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly world: World;
  readonly vehicles = new Vehicles();
  /** 港口作业：岸桥、堆场龙门吊、场内集卡、闸口和外来集卡（按当天的班轮排的计划） */
  readonly port = new PortOps();
  /** 机场作业：货机的进近、滑行、地面作业（舱门、平台车、板车）、推出、起飞 */
  readonly airport = new AirportOps();
  /** 港口、机场的外来货车（从高速口或货车等候区开来、进出闸口和收货口、开走） */
  readonly ext: ExtTrucks;
  /** 物流园：月台门、叉车、暂存道、立体库、货到人、道闸 */
  readonly dc = new DcOps();
  /** 综合店收货区：卷帘门、调平板、电动搬运车、收货台上的暂存托盘 */
  readonly storeDocks = new StoreDocks();
  /** 综合店的店前停车场、即时取货区、收货场（停车场里的车和人、收货场排程、值班助手的数据） */
  readonly storeSite: StoreSiteView | undefined;
  private storeGen: 'gen1' | 'storex' = 'storex';
  /** 铁路站的龙门吊：物流园货运站西段（港口来的班列）、东段（洲际班列），港口铁路站 */
  readonly railDcW: RailYard;
  readonly railDcE: RailYard;
  readonly railPort: RailYard;
  private readonly railLine: Poly;
  private readonly railStation: number;
  private lastFrameAt = performance.now();
  private seed = 1;
  /** 负荷档位的背景流量倍数 */
  private load = 1;
  /** 社会车流（停车场的道闸按它抬杆） */
  private traffic: Traffic | undefined;
  /** 社会车流在后台线程里算（一两秒）：第几次请求（只用最新的结果）、路边的公交站（第一次算好以后画上） */
  private trafficWorker: Worker | undefined;
  /** 行人（和社会车流一起在后台线程里算好） */
  readonly peds = new PedLayer();
  private readonly lights: NightLights;
  /** 上一次算社会车流时用的天气车速系数（逗号连起来，比较用） */
  private weatherKey = '';
  private trafficReq = 0;
  private busStopMesh: THREE.Object3D | undefined;
  /** 本店班轮的车辆下标（港口监控面板用） */
  shipVid: number | undefined;
  /** 对比回放：右半边的另一组车（关着是 undefined）；Blender 的车辆零件（右边的车辆层也用） */
  private split: SplitScreen | undefined;
  private fleetGeos: ReadonlyMap<string, THREE.BufferGeometry> | undefined;
  /** 对比条上换了对比的两边、另一天的编号 */
  onSplitPair: ((pair: SplitPair, seed: number) => void) | undefined;
  readonly agents = new Agents3D();
  private labels: CSS2DRenderer;
  private labelGroup = new THREE.Group();
  private labelObjs: { o: CSS2DObject; kind: string }[] = [];
  private store: StoreModel | undefined;
  private storeGroup = new THREE.Group();
  private storeCenter = new THREE.Vector3();
  /** 物流园的屋顶剖切按局部坐标判断：每帧把镜头位置换到局部坐标放在这里 */
  private dcCam = new THREE.PerspectiveCamera();
  /** 镜头拉近综合店时显示剖面（看得见店里），拉远时是完整外观 */
  private storeMode: 'cutaway' | 'exterior' = 'exterior';
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  /** 天气（只改画面）：雨、雾、云、风，路面湿不湿；闪电时天光临时加亮 */
  readonly weather = new Weather();
  private baseHemi = 1;
  private night = 0;
  private flash = 0;
  /** 正在播放（台风天的闪电只在播放时打） */
  private playing = false;
  /** 帧时间预算和自动画质；画质低时监控画面隔几帧重画一次（其余的帧贴上一次画好的） */
  private readonly budget: FrameBudget;
  private qTier: QualityTier = 'high';
  private labelLevel: 1 | 2 = 2;
  private frameAt = performance.now();
  private monitorTick = 0;
  private readonly monitorRT: THREE.WebGLRenderTarget[] = [];
  private readonly blit = { scene: new THREE.Scene(), cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat: new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }) };
  private debugEl: HTMLElement | undefined;
  private readonly drawSize = new THREE.Vector2();
  private debugAt = 0;
  /** 画质换了一档（自动或手动）：工具栏上显示 */
  onQuality: ((tier: QualityTier, mode: QualityMode) => void) | undefined;
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private t = 3 * 3600;
  private running = false;
  private dirty = true;
  private lastScale = -1;
  private lastLight = -1;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number; dur: number } | undefined;
  /** 跟随的车辆（点一下车辆开始跟随，拖动画面停止）；或者港口、机场里别家的船、货机 */
  private follow: number | undefined;
  private followExt: ExtTarget | undefined;
  /** 选中作业：车的整趟路线（屏幕上固定粗细的线）和停靠点标签 */
  private routeLines: Line2[] = [];
  private routeMat = new LineMaterial({ color: 0xffb000, linewidth: 4, worldUnits: false, transparent: true, opacity: 0.95, depthTest: false });
  private stopLabels: CSS2DObject[] = [];
  /** 月台门的排程（调度台给的），每帧按时刻给门上方的灯上色 */
  private doorBookings: { door: string; t0: number; t1: number; mode: 'load' | 'unload'; conflict: boolean }[] = [];
  showLabels = true;
  /** 实时跟踪：每辆车头顶的编号和预计到达 */
  showTags = true;
  private tagGroup = new THREE.Group();
  private tags = new Map<number, CSS2DObject>();
  onHover: ((h: Hover | undefined) => void) | undefined;
  onFollow: ((v: { label: string } | undefined) => void) | undefined;
  /** 点了一辆车（调度台选中它的作业）；没设时点车就是跟随 */
  onPick: ((vehicle: number) => void) | undefined;
  /** 对比回放时点了右半边的车或它的标签（下标是右边那一组的）；没设时跟随它 */
  onPickRight: ((vehicle: number) => void) | undefined;
  /** 跟随的是右半边的车 */
  private followRight = false;
  /** 左边选中的作业和停靠点标签（对比时右边是同一天，跟着选中同一个作业） */
  private sel: { id: number | undefined; marks: { text: string; pos: THREE.Vector3 }[] } = { id: undefined, marks: [] };

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'view3d-canvas';
    host.append(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'view3d-labels';
    host.append(this.labels.domElement);

    this.scene.background = new THREE.Color('#dce7f0');
    this.scene.fog = new THREE.Fog('#dce7f0', 5000, 16000);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 30000);
    // 车辆按离主镜头的远近画精模或简模（监控画面按各自的机位，见 renderMonitors）
    Vehicles.defaultEyes = [this.camera.position];
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 9000;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => {
      this.tween = undefined;
    });
    this.controls.addEventListener('change', () => {
      this.dirty = true;
    });

    this.hemi = new THREE.HemisphereLight('#e4efff', '#a9a28c', 1.15);
    this.sun = new THREE.DirectionalLight('#fff3e0', 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.world = buildWorld();
    this.scene.add(this.world.group);
    // 综合店的站点：停车场、取货区、收货场的地面算停车场（下雨一起变湿），灯杆的光交给夜里的灯光
    const flagSite = [...this.world.sites.values()].find((x) => x.st.flagship) ?? [...this.world.sites.values()][0];
    if (flagSite) {
      this.storeSite = new StoreSiteView(flagSite, this.world.net);
      // 停车场的车流排好了：社会车流按这一天顾客的车重算
      this.storeSite.onPlan = () => this.trafficSoon();
      this.scene.add(this.storeSite.group);
      this.world.parking.group.add(this.storeSite.surface);
      this.world.lights.push(...this.storeSite.lamps);
      this.storeDocks.siteInfo = (t) => this.storeSite?.info(t);
    }
    // 天气：找到要「湿」的路面和地面、给海面加浪；雨丝跟着镜头
    this.weather.attach(this.world.group, this.world.roads.group, this.world.parking.group);
    this.weather.addWet(this.airport.paveMat, 0.7, 0.3, true);
    this.scene.add(this.weather.group);
    // 画质：手机（触屏或窄屏）从「中」开始；监控画面贴图用的全屏方块
    const phone = (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) || window.innerWidth < 760;
    this.budget = new FrameBudget(phone);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blit.mat);
    quad.frustumCulled = false;
    this.blit.scene.add(quad);
    this.applyQuality(this.budget.tier);
    if (new URLSearchParams(location.search).get('debug') === '1') {
      this.debugEl = document.createElement('div');
      this.debugEl.className = 'view3d-debug';
      host.append(this.debugEl);
    }
    this.scene.add(this.vehicles.group);
    // 港口、机场、物流园的作业按局部坐标画，放进各自的坐标系节点（区域生成器决定位置和朝向）
    this.world.frames.port.inner.add(this.port.group);
    this.world.frames.airport.inner.add(this.airport.group);
    this.ext = new ExtTrucks(this.world.net);
    // 物流园的外来车：路上、门外排队由外来货车层画（物流园的计划变了跟着重排）
    this.dc.onPlan = () => this.ext.setPark(this.dc.parkTrips());
    this.scene.add(this.ext.group);
    this.scene.add(this.peds.group);
    // 夜里的路灯、停车场灯杆、物流园高杆灯的光；大批量实例按镜头远近开关（lod.ts，每个镜头各算各的）
    this.lights = new NightLights(this.world.lights);
    this.scene.add(this.lights.group);
    this.world.frames.park.inner.add(this.dc.group);
    attachLod(this.scene);
    // 机场给的飞机姿态是局部的：换到区域里（位置转过去，朝向加上坐标系的转角）
    this.vehicles.planePose = (vid, t) => {
      const p = this.airport.pose(vid, t);
      if (!p) return p;
      const w = frameToWorld(FRAMES.airport, { x: p.x, z: p.z });
      return { ...p, x: w.x, z: w.z, yaw: p.yaw + FRAMES.airport.rot };
    };
    // 铁路站：沿铁路折线取两段直线做龙门吊的轨道（箱位在铁路南侧 / 港口站的东侧）
    const rail = RAIL.map(P);
    this.railLine = new Poly(rail.map((p) => ({ x: p.x, z: p.z })));
    this.railStation = this.railLine.cum[RAIL_DC_INDEX] as number;
    const S = this.railLine.at(this.railStation);
    const west = this.railLine.at(this.railStation - 215);
    const east = this.railLine.at(this.railStation + 215);
    const port0 = this.railLine.at(0);
    const port1 = this.railLine.at(215);
    // 物流园货运站两段站台（港口来的班列、洲际班列），装卸线的股数按设施配置；港口铁路站泊位多时也加一股
    const fac = currentFacilities();
    this.railDcW = new RailYard('物流园货运站 · 港口班列站台', west, S, fac.dc.railTracks, { truckLane: true });
    this.railDcE = new RailYard('物流园货运站 · 洲际班列站台', S, east, fac.dc.railTracks, { truckLane: true });
    this.dc.attachRail(this.railDcW, this.railDcE, this.world.net);
    this.railPort = new RailYard('港口铁路站', port0, port1, fac.port.berths >= 3 ? 2 : 1);
    this.scene.add(this.railDcW.group, this.railDcE.group, this.railPort.group, this.storeDocks.group);
    this.vehicles.cargo = (v, t) => (v.kind === 'train' ? this.trainCargo(v.id, t) : v.kind === 'drayage' ? this.port.dray(v.id, t) : undefined);
    this.vehicles.trainBoxColor = (v, k) => this.railDcW.boxColor(v.id, k) ?? this.railDcE.boxColor(v.id, k) ?? this.railPort.boxColor(v.id, k);
    this.storeGroup.name = 'flagship';
    this.storeGroup.position.copy(this.world.flagship.origin).setY(0.16);
    this.storeGroup.rotation.y = this.world.flagship.rotation;
    this.storeCenter = this.storeGroup.localToWorld(new THREE.Vector3(42, 0, 35));
    this.scene.add(this.storeGroup);
    this.agents.group.position.copy(this.storeGroup.position);
    this.agents.group.rotation.y = this.storeGroup.rotation.y;
    this.scene.add(this.agents.group);
    this.scene.add(this.labelGroup);
    this.tagGroup.name = 'vehicle-tags';
    this.scene.add(this.tagGroup);
    for (const l of this.world.labels) this.addLabel(l.text, l.pos, l.kind);

    this.bindPointer(this.renderer.domElement);
    new ResizeObserver(() => this.resize()).observe(host);
    this.focus('overview', false);
    // 社会车流：第一帧画出来以后在后台线程里算一整天
    setTimeout(() => this.resimTraffic(), 60);
  }

  /** 社会车流按负荷档位的倍数重算一整天（平常 9,000 趟）：在后台线程里算，算好换上；后台线程用不了就在这里算 */
  private resimTraffic(): void {
    // 机场、港口的作业还在分段排：排完再算（当天的仿真车在场地里的时刻要等机场登记完才定下来，和一口气排完时同一份输入）
    if (this.plansPending) {
      this.trafficAfterPlans = true;
      return;
    }
    const id = ++this.trafficReq;
    const trips = Math.round(9000 * this.load);
    const use = (tr: Traffic, peds?: PedData) => {
      if (id !== this.trafficReq) return;
      this.peds.setData(peds);
      this.vehicles.setTraffic(tr);
      this.split?.setTraffic(tr);
      this.traffic = tr;
      if (!this.busStopMesh && tr.busStops.length) {
        this.busStopMesh = buildBusStops(tr.busStops);
        this.world.group.add(this.busStopMesh);
      }
      this.dirty = true;
    };
    const weather = this.weatherFactors();
    this.weatherKey = weather.join(',');
    // 当天的仿真车在路上的行驶：背景车让它们（跟在后面、红灯前排在后面）；综合店顾客的车在干道和进店路上的行驶也一样
    const trucks = [...this.vehicles.truckRuns(), ...(this.storeSite?.roadRuns() ?? [])];
    const local = () => {
      const tr = new TrafficPlanner(this.world.net);
      tr.simulate(trips, undefined, weather, trucks);
      use(tr, planPeds({ net: this.world.net, traffic: tr, crosswalks: tr.crosswalks(), lots: this.world.net.lots, density: Math.sqrt(this.load) }));
    };
    try {
      this.trafficWorker ??= new Worker(new URL('../trafficWorker.ts', import.meta.url), { type: 'module' });
      this.trafficWorker.onmessage = (e: MessageEvent<{ id: number; data?: TrafficData; peds?: PedData; error?: string }>) => {
        if (e.data.id !== this.trafficReq) return;
        if (e.data.data) use(Traffic.from(e.data.data), e.data.peds);
        else {
          console.warn('社会车流的后台线程出错，改在主线程算', e.data.error);
          local();
        }
      };
      const req: TrafficRequest = { id, region: new URLSearchParams(location.search).get('region'), facilities: currentFacilities(), trips, weather, trucks };
      this.trafficWorker.postMessage(req);
    } catch {
      local();
    }
  }

  /**
   * 负荷档位的背景流量倍数（别家的船和航班、外来集卡、社会车流）：平常 1。
   * 在 setVehicles 之前调，机场、港口按它排当天的背景作业。
   */
  setLoad(k: number): void {
    if (Math.abs(k - this.load) < 1e-6) return;
    this.load = k;
    this.trafficSoon();
  }

  /** 过一会儿重算社会车流（换负荷档位、换一天的车、现场视图的延误常常接连着来，合成一次） */
  private trafficTimer: ReturnType<typeof setTimeout> | undefined;
  private trafficSoon(): void {
    clearTimeout(this.trafficTimer);
    this.trafficTimer = setTimeout(() => this.resimTraffic(), 150);
  }

  /** 机场货站库内各区的名字（ETV 立体库、拆组板区、冷库、危险品库、贵重品库、安检、海关监管区）：换一天时按货站的布局重摆 */
  private setTermLabels(): void {
    for (const l of this.labelObjs.filter((x) => x.kind === 'term')) this.labelGroup.remove(l.o);
    this.labelObjs = this.labelObjs.filter((x) => x.kind !== 'term');
    this.airport.group.updateWorldMatrix(true, false);
    for (const z of this.airport.zoneLabels()) this.addLabel(z.text, this.airport.group.localToWorld(new THREE.Vector3(z.x, z.y, z.z)), 'term');
  }

  private addLabel(text: string, pos: THREE.Vector3, kind: string, onClick?: () => void): void {
    text = tx(text); // 英文界面：地名、设施名按字典翻译
    const div = document.createElement('div');
    div.className = `lbl3d ${kind === 'big' ? 'big' : ''} lbl-${kind}`;
    div.textContent = text;
    if (onClick) {
      div.classList.add('clickable');
      div.addEventListener('click', onClick);
    }
    const o = new CSS2DObject(div);
    o.position.copy(pos);
    this.labelGroup.add(o);
    this.labelObjs.push({ o, kind });
  }

  /** 综合店：StoreX 的门店模型（上一代用 Storewright 那一代的布局） */
  setStoreLayout(layout: Layout): void {
    if (this.store) {
      this.storeGroup.remove(this.store.group);
      this.store.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.labelObjs = this.labelObjs.filter((x) => {
        if (x.kind !== 'inner' && x.kind !== 'innerBig') return true;
        this.labelGroup.remove(x.o);
        x.o.element.remove();
        return false;
      });
    }
    this.store = buildStoreModel(layout);
    setExteriorMode(this.store, 'exterior');
    // StoreX 模型自带的格子停车场、卸货场和取货车道的地面、标线藏起来（综合店的站点另外画，store/）
    this.store.group.traverse((o) => {
      if (o.name === 'asphalt' || o.name === 'markings' || o.name === 'lanes') o.visible = false;
    });
    this.storeGen = layout.generation === 'gen1' ? 'gen1' : 'storex';
    this.storeGroup.add(this.store.group);
    this.agents.mfcTop = this.store.mfcTop || 4.6;
    this.storeGroup.updateMatrixWorld(true);
    for (const l of this.store.labels) if (!/^(停车场|卸货场|自提柜取货|免下车取货)$/.test(l.text)) this.addLabel(l.text, this.storeGroup.localToWorld(new THREE.Vector3(l.x, l.y, l.z)), l.kind === 'big' ? 'innerBig' : 'inner');
    this.dirty = true;
  }

  /** 综合店里的人和机器人（StoreX 的仿真轨迹）；店外的货车和配送车由区域仿真画，这里去掉 */
  setStoreAgents(agents: AgentTrace[]): void {
    // 顾客的车、取货的车由店前停车场画（store/cars.ts，按同样的时刻），店外几个点挪到新停车场的位置上
    this.storeSite?.setAgents(agents, this.storeGen);
    this.storeAgentsShown = (this.storeSite ? this.storeSite.remapAgents(agents) : agents).filter((a) => a.kind !== 'truck' && a.kind !== 'van' && a.kind !== 'car');
    this.agents.setAgents(this.storeAgentsShown);
    this.dirty = true;
  }

  /** 综合店里画着的员工、机器人（门店模型的轨迹，门店坐标）：演示导览找「进后仓、上架」用 */
  private storeAgentsShown: AgentTrace[] = [];
  get storeAgents(): readonly AgentTrace[] {
    return this.storeAgentsShown;
  }

  /**
   * 镜头飞到一个点（区域坐标，米）：offset 是镜头相对目标点的位置，ms 是飞过去用的毫秒；不再跟随原来的车。
   * 演示导览用（预设镜头之外的任意位置）。
   */
  flyTo(target: { x: number; y?: number; z: number }, offset: { x: number; y: number; z: number }, ms = 1200): void {
    this.setFollow(undefined);
    const tTo = new THREE.Vector3(target.x, target.y ?? 0, target.z);
    const to = tTo.clone().add(new THREE.Vector3(offset.x, offset.y, offset.z));
    this.tween = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo, start: performance.now(), dur: ms };
    this.dirty = true;
  }

  /** 演示导览在三维里标一个点（本店的箱、岸桥、货架）：不给就去掉 */
  private tourLabel: CSS2DObject | undefined;
  setTourMark(m?: { text: string; x: number; y: number; z: number }): void {
    if (this.tourLabel) {
      this.labelGroup.remove(this.tourLabel);
      this.tourLabel.element.remove();
      this.tourLabel = undefined;
    }
    if (m) {
      const div = document.createElement('div');
      div.className = 'lbl3d lbl-stop lbl-tour';
      div.textContent = m.text;
      const o = new CSS2DObject(div);
      o.position.set(m.x, m.y, m.z);
      this.labelGroup.add(o);
      this.tourLabel = o;
    }
    this.dirty = true;
  }

  /** 港口局部坐标的点、方向 → 区域坐标（导览的镜头用） */
  portToWorld(x: number, z: number): { x: number; z: number } {
    return frameToWorld(FRAMES.port, { x, z });
  }
  portDirToWorld(x: number, z: number): { x: number; z: number } {
    return dirToWorld(FRAMES.port, { x, z });
  }

  /** 综合店门店坐标（门店模型里员工的 x、y）→ 区域坐标；dir：门店坐标里的方向 → 区域坐标的方向 */
  storeToWorld(x: number, y: number): THREE.Vector3 {
    return this.storeGroup.localToWorld(new THREE.Vector3(x, 0, y));
  }
  storeDirToWorld(x: number, y: number): THREE.Vector3 {
    return new THREE.Vector3(x, 0, y).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.storeGroup.rotation.y);
  }

  /** 当天的车辆；resolve：仿真的地点 → 调度台排的月台门、门店卸货口（车开到那里装卸） */
  /** 当天的编号（设施作业的计划按它排，同一个编号每次一样） */
  setSeed(seed: number): void {
    this.seed = seed;
    this.storeSite?.setSeed(seed);
    setTideDay(seed);
    this.weather.setSeed(seed);
    this.lastLight = -1;
    this.weatherTraffic();
  }

  /** 每个钟点的天气车速系数（0–24 点）：社会车流按它开，雨天、雾天慢下来 */
  private weatherFactors(): number[] {
    return Array.from({ length: 25 }, (_, h) => Math.round(speedFactor(this.weather.stateAt(Math.min(24 * 3600, h * 3600 + 1800))) * 100) / 100);
  }

  /** 天气变了（模式、演练、日子）：车速系数不一样就重算社会车流 */
  private weatherTraffic(): void {
    const key = this.weatherFactors().join(',');
    if (key === this.weatherKey) return;
    const first = this.weatherKey === '';
    this.weatherKey = key;
    // 第一次在场景搭好以后由 build 算（那时还没有后台线程的结果）
    if (!first || this.traffic) this.resimTraffic();
  }

  /** 设施作业一口气排完（和以前一样，对照、排查用）：网址里加 ?syncplans=1 */
  private readonly syncPlans = new URLSearchParams(location.search).get('syncplans') === '1';
  /** 机场、港口（含物流中心）和外来货车当天的作业还在分段排：排完以前这几处先空着，画面上有一个小提示；导览、值班助手等它排完再读 */
  plansPending = false;
  /** 设施作业排完了（换了一天的车以后）：main.ts 清掉按旧计划算的缓存、让等着的导览开始 */
  onPlans?: () => void;
  private dayJob = 0;
  private planHint: HTMLElement | undefined;
  private trafficAfterPlans = false;

  setVehicles(list: WVehicle[], resolve: (vehicle: number, key: string) => string | undefined = () => undefined, flagship: 'storex' | 'gen1' = 'storex', palletsOf: (vid: number) => number | undefined = () => undefined): void {
    // 第一次（画面上还没有车）：门店收货场、物流园、运动规划当场排完，第一帧就带着车（这时「仿真中」还盖着画面）；
    // 以后换一天的车（换负荷、换日子、调度台改计划）：这几样也放进下面的分段排，换的时候画面不卡
    const first = !this.vehicles.items.length;
    // 换一天的车：运动规划上一天补进场地排程的仿真车访问清掉（下面按这一天的车重新登记）
    clearSimVisits();
    setFlagshipDocks(this.world.net, this.world.sites, flagship);
    // 收货场先排（收货场引擎的先到先进）：门店收货场当天的访问先登记，仿真车的运动按同一份排程
    const store = this.storeSite?.setTrucksSteps(list, resolve, palletsOf);
    if (store && (first || this.syncPlans)) drain(store);
    // 物流园的场地和当天的访问也在运动规划之前登记（门店、机场的已经登记了）：仿真车的运动按同一份场地排程。
    // 物流园、车辆层在调用时就换上这一天的车（清单、船、火车），返回的分段接着排物流园的计划、公路车辆的运动
    const job = ++this.dayJob;
    const seed = this.seed;
    const load = this.load;
    const park = this.dc.setDaySteps(list, resolve, palletsOf, seed, load);
    const motion = this.vehicles.planSteps(list, { net: this.world.net, resolve });
    // 社会车流按这一天的仿真车重算（背景车让它们；设施作业还在排时等排完再算）
    this.trafficSoon();
    // 换了一天的车：接下来几秒在排设施作业、算车流，帧时间不算进自动画质
    this.budget.settle();
    // 收货区的卷帘门、搬运车按收货场排出来的靠稳、拉出时刻动；铁路站当天的装卸
    const docks = (): void => {
      this.storeDocks.setDay(this.world.sites, list, resolve, palletsOf, (vid, t0) => this.storeSite?.yardTimes(vid, t0));
      this.setRailDay(list);
    };
    // 港口：本店班轮的靠泊时段和本店的箱数
    const ship = list.find((v) => v.kind === 'ship' && /班轮/.test(v.label));
    const berth = ship?.segs.find((sg) => /靠泊/.test(sg.act ?? ''));
    this.shipVid = ship?.id;
    // 机场、港口、外来货车：排一天要两三秒。默认分段排（先画出带着车的第一帧、时钟先走，排完一段让出主线程一下）；
    // ?syncplans=1 时和以前一样一口气排完（车辆的运动也是），外来货车画出第一帧以后再排
    if (this.syncPlans) {
      drain(park);
      drain(motion);
      docks();
      this.setPlansPending(false);
      const { trips, docks: airDocks } = drain(this.facilityDay(list, seed, load, ship, berth));
      drain(this.vehicles.convoySteps(() => this.t));
      setTimeout(() => {
        if (job !== this.dayJob) return;
        this.ext.setDay(trips, airDocks, seed);
        this.dirty = true;
      }, 80);
    } else if (first) {
      drain(park);
      drain(motion);
      docks();
      this.startDayJob(job, this.dayJobSteps(list, seed, load, ship, berth));
    } else this.startDayJob(job, this.switchSteps(store, park, motion, docks, list, seed, load, ship, berth));
    this.setFollow(undefined);
    this.dirty = true;
  }

  /**
   * 换一天的车时的分段排：门店收货场 → 物流园 → 公路车辆的运动（一辆一段）→ 收货区、铁路站 → 和第一次一样的设施作业。
   * 先后和一口气排完时一样，结果也一样；公路车辆排完以前不画（画面上有「正在排」的提示）。
   */
  private *switchSteps(store: Steps | undefined, park: Steps, motion: Steps, docks: () => void, list: WVehicle[], seed: number, load: number, ship: WVehicle | undefined, berth: { t0: number; t1: number } | undefined): Steps {
    if (store) yield* store;
    yield;
    yield* park;
    yield* motion;
    docks();
    yield;
    yield* this.dayJobSteps(list, seed, load, ship, berth);
  }

  /**
   * 机场、港口当天的作业，先后和以前一口气排完时一样：机场 → 港口（船期、岸桥、堆场、物流中心）→ 港口外来集卡的行程。
   * 港口按本店班轮实际的航迹（区域车辆层画的那条船）给别家的船排避让。
   */
  private *facilityDay(list: WVehicle[], seed: number, load: number, ship: WVehicle | undefined, berth: { t0: number; t1: number } | undefined): Steps<{ trips: GateTrip[]; docks: ReturnType<AirportOps['dockVisits']> }> {
    // 机场：货运航班，加上本店的空运冷藏车（在货站冷链门装车的时段排进货站的计划）
    const airTrucks = list.filter((v) => v.segs.some((sg) => sg.act === '在机场货站装车')).map((v) => ({ vid: v.id, v }));
    yield* this.airport.daySteps(list.filter((v) => v.kind === 'plane').map((v) => ({ vid: v.id, v })), seed, load, airTrucks);
    this.setTermLabels();
    yield;
    const drays = list.flatMap((v) => {
      const sg = v.kind === 'drayage' ? v.segs.find((x) => x.act === '在港口堆场装箱') : undefined;
      return sg ? [{ vid: v.id, t0: sg.t0, t1: sg.t1, label: v.label }] : [];
    });
    // 过路的背景船（匀速）：换到港口的局部坐标，别家的船进出港、抛锚都避开它们
    const passing = list
      .filter((v) => v.kind === 'ship' && /背景/.test(v.label))
      .flatMap((v) =>
        v.segs
          .filter((sg) => sg.pts.length >= 4)
          .map((sg) => ({ t0: sg.t0, t1: sg.t1, pts: Array.from({ length: sg.pts.length / 2 }, (_, k) => frameToLocal(FRAMES.port, { x: sg.pts[2 * k] as number, z: sg.pts[2 * k + 1] as number })) })),
      );
    // 本店班轮：任意时刻的姿态和进出港的航线（换到港口的局部坐标），别家的船按它避让、锚位离它远一点
    const sp: ShipPose = { x: 0, z: 0, dir: 0, moving: false, act: undefined, tug: '', side: 1, turn: 0 };
    const shipPose = (vid: number) => (t: number, o: { x: number; z: number; h: number }): boolean => {
      if (!this.vehicles.shipPoseAt(vid, t, sp)) return false;
      const l = frameToLocal(FRAMES.port, { x: sp.x, z: sp.z });
      o.x = l.x;
      o.z = l.z;
      o.h = sp.dir + FRAMES.port.rot;
      return true;
    };
    const shipPath = (ship?.segs ?? []).filter((sg) => /进港|离港/.test(sg.act ?? '')).flatMap((sg) => Array.from({ length: sg.pts.length / 2 }, (_, k) => frameToLocal(FRAMES.port, { x: sg.pts[2 * k] as number, z: sg.pts[2 * k + 1] as number })));
    // 本店班轮在引航站停船的时段（进港引航员登船、出港下船）：港口的引航艇按它来回
    const pilots: [number, number][] = [];
    if (ship) {
      let open: number | undefined;
      for (let tt = 0; tt <= 86400; tt += 20) {
        const on = this.vehicles.shipPoseAt(ship.id, tt, sp) && /引航员/.test(sp.act ?? '');
        if (on && open === undefined) open = tt;
        if (!on && open !== undefined) {
          pilots.push([open, tt]);
          open = undefined;
        }
      }
    }
    yield* this.port.daySteps({ seed, drays, traffic: load, passing, ...(ship && berth ? { ship: { vid: ship.id, berth: [berth.t0, berth.t1] as [number, number], storeBoxes: Number(/约 (\d+) 个/.exec(ship.label)?.[1] ?? 5), label: ship.label, pose: shipPose(ship.id), path: shipPath, pilots } } : {}) });
    yield;
    // 外来货车：港口每一趟外来集卡、机场每一次收货口装卸，接上来去的路（等候区、高速口）
    const trips = yield* this.port.gateTripsSteps();
    const docks = this.airport.dockVisits();
    return { trips, docks };
  }

  /**
   * 分段排的一天：物流园按调度台送来的作业编号、月台门预约重排一次 → 机场、港口 → 调度台的作业编号套上港口（和以前同一个先后）→ 外来货车。
   * 物流园和机场、港口互不相干（各自的场地登记、各自的计划），先排后排结果一样。
   */
  private *dayJobSteps(list: WVehicle[], seed: number, load: number, ship: WVehicle | undefined, berth: { t0: number; t1: number } | undefined): Steps {
    yield* this.dc.flushSteps();
    yield;
    const { trips, docks } = yield* this.facilityDay(list, seed, load, ship, berth);
    this.port.hold(false);
    yield;
    yield* this.ext.daySteps(trips, docks, seed, () => this.t);
    yield;
    // 收货场的登记都到齐了：每辆车的收货场停靠按最终的排程排好（一辆一段，下一帧不用一下子全排），排车队间距
    yield* this.vehicles.convoySteps(() => this.t);
  }

  /**
   * 一段一段地排（每段约 30 毫秒，段与段之间让出主线程：画面接着画、时钟接着走、点得动）。
   * 先让带着车的第一帧画出来再开始；又换了一天的车（job 变了）就不再排这一份。
   */
  private startDayJob(job: number, steps: Steps): void {
    this.dc.defer();
    this.port.hold(true);
    this.ext.hold();
    this.setPlansPending(true);
    const SLICE_MS = 30;
    let started = false;
    const tick = (): void => {
      if (job !== this.dayJob) return;
      const t0 = performance.now();
      try {
        for (;;) {
          if (steps.next().done) return this.endDayJob(job);
          if (performance.now() - t0 > SLICE_MS) break;
        }
      } catch (err) {
        console.error('设施作业没排出来', err);
        this.vehicles.pending = false;
        this.dc.flush();
        this.port.hold(false);
        this.ext.waiting = false;
        return this.endDayJob(job);
      }
      // 排的这几秒帧时间偏长，不算进自动画质
      this.budget.settle();
      setTimeout(tick, 0);
    };
    const start = (): void => {
      if (started) return;
      started = true;
      tick();
    };
    requestAnimationFrame(() => setTimeout(start, 0));
    // 页面在后台（不画帧）时也照样排
    setTimeout(start, 150);
  }

  private endDayJob(job: number): void {
    if (job !== this.dayJob) return;
    this.setPlansPending(false);
    this.budget.settle();
    this.dirty = true;
    if (this.trafficAfterPlans) {
      this.trafficAfterPlans = false;
      this.trafficSoon();
    }
    this.onPlans?.();
  }

  private convoyAt = 0;
  private convoyBusy = false;
  /** 车队间距重排（分段，每段约 30 毫秒；又换了一天就不排了）；?syncplans=1 时一口气排完 */
  private rerunConvoy(): void {
    const job = this.dayJob;
    const steps = this.vehicles.convoySteps(() => this.t);
    if (this.syncPlans) {
      drain(steps);
      this.dirty = true;
      return;
    }
    this.convoyBusy = true;
    const tick = (): void => {
      if (job !== this.dayJob) {
        this.convoyBusy = false;
        return;
      }
      const t0 = performance.now();
      try {
        for (;;) {
          if (steps.next().done) {
            this.convoyBusy = false;
            this.dirty = true;
            return;
          }
          if (performance.now() - t0 > 30) break;
        }
      } catch (err) {
        console.error('车队间距没排出来', err);
        this.convoyBusy = false;
        return;
      }
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  }

  /** 画面上的小提示：设施作业还在排（读屏软件也读得到） */
  private setPlansPending(on: boolean): void {
    this.plansPending = on;
    if (on && !this.planHint) {
      const el = document.createElement('div');
      el.className = 'view3d-plan-hint';
      el.setAttribute('role', 'status');
      Object.assign(el.style, { position: 'absolute', bottom: '86px', left: '50%', transform: 'translateX(-50%)', zIndex: '6', width: 'max-content', maxWidth: 'calc(100% - 20px)', padding: '4px 10px', borderRadius: '6px', background: 'rgba(0, 0, 0, 0.6)', color: '#fff', font: '12px/1.4 system-ui, sans-serif', pointerEvents: 'none' });
      this.host.append(el);
      this.planHint = el;
    }
    if (!this.planHint) return;
    this.planHint.hidden = !on;
    if (on) this.planHint.textContent = tr('正在排当天车辆和设施的作业…');
  }

  /**
   * 铁路站当天的装卸：港口来的班列在港口铁路站装箱（发车前）、到物流园货运站西段卸箱；洲际班列在东段卸箱（整列 12 箱，本店的几箱是蓝色）。
   * 平车的位置按列车停站时的车头位置往后排（和区域车辆层画的一致）。
   */
  private setRailDay(list: WVehicle[]): void {
    const port: RailWork[] = [];
    const dcW: RailWork[] = [];
    const dcE: RailWork[] = [];
    const initial: Parameters<RailYard['setDay']>[1] = [];
    for (const v of list) {
      if (v.kind !== 'train') continue;
      const pre = v.segs.find((sg) => sg.act === '在港口铁路站装箱');
      const unload = v.segs.find((sg) => sg.act === '在货运站卸箱');
      const dwell = v.segs.find((sg) => /在物流园货运站/.test(sg.act ?? ''));
      const wag = (yard: RailYard, sHead: number, dirn: 1 | -1, n: number, color: (k: number) => string, store: (k: number) => boolean) =>
        Array.from({ length: Math.min(WAGONS, n) }, (_, i) => {
          const p = this.railLine.at(sHead - dirn * wagonBack(i + 1));
          return { u: yard.uv(p.x, p.z).u, color: color(i + 1), store: store(i + 1), id: `SXCU ${String(700000 + v.id * 20 + i + 1)}` };
        });
      if (pre || unload) {
        const n = Number(/(\d+) 箱/.exec(v.label)?.[1] ?? 1);
        if (pre) {
          const w = { vid: v.id, label: v.label, t0: pre.t0, t1: pre.t1, mode: 'load' as const, wagons: wag(this.railPort, FREIGHT_LEN, 1, n, () => STORE_BOX, () => true) };
          port.push(w);
          // 要装的箱当天一早就在港口铁路站的箱位上（从码头堆场转过来）
          w.wagons.forEach((wg) => initial.push({ u: wg.u + 6, v: this.railPort.firstRowV, tier: 0, color: STORE_BOX, store: true, id: wg.id, until: Infinity }));
          void initial;
        }
        if (unload) dcW.push({ vid: v.id, label: v.label, t0: unload.t0, t1: unload.t1, mode: 'unload', wagons: wag(this.railDcW, this.railStation, 1, n, () => STORE_BOX, () => true) });
      }
      if (dwell) {
        const mine = Number(/本店 (\d+) 箱/.exec(v.label)?.[1] ?? 0);
        dcE.push({ vid: v.id, label: v.label, t0: dwell.t0, t1: dwell.t1, mode: 'unload', wagons: wag(this.railDcE, this.railStation, -1, WAGONS, (k) => (k <= mine ? STORE_BOX : (TRAIN_BOX[(v.id + k) % TRAIN_BOX.length] as string)), (k) => k <= mine) });
      }
    }
    this.railPort.setDay(port, initial);
    this.railDcW.setDay(dcW);
    this.railDcE.setDay(dcE);
  }

  /** 列车平车上此刻有几个箱：在港口装、到物流园卸 */
  private trainCargo(vid: number, t: number): number | undefined {
    const dc = this.railDcW.cargo(vid, t) ?? this.railDcE.cargo(vid, t);
    const port = this.railPort.cargo(vid, t);
    if (port === undefined) return dc;
    if (dc === undefined) return port;
    const w = this.railDcW.window(vid);
    return w && t >= w[0] ? dc : port;
  }

  setDoorBookings(list: { door: string; t0: number; t1: number; mode: 'load' | 'unload'; conflict: boolean }[]): void {
    this.doorBookings = list;
    this.dc.setBookings(list);
    this.dirty = true;
  }

  private updateDoorLights(): void {
    const { mesh, index } = this.world.doorLights;
    const state = new Map<number, string>();
    for (const b of this.doorBookings) {
      if (this.t < b.t0 || this.t > b.t1) continue;
      const i = index.get(b.door);
      if (i === undefined) continue;
      state.set(i, state.has(i) || b.conflict ? '#e03c31' : b.mode === 'load' ? '#3d8ff0' : '#f08c1e');
    }
    const c = new THREE.Color();
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, c.set(state.get(i) ?? '#3a3d42'));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  setTime(t: number): void {
    if (t !== this.t) {
      this.t = t;
      this.dirty = true;
    }
  }

  /** 闭环孪生的现场：车按实际的延误画（见 VehicleLayer.setTimeShift） */
  setTimeShift(s?: { delays: (Float32Array | undefined)[]; ends: number[] }): void {
    this.vehicles.setTimeShift(s);
    this.trafficSoon();
    this.dirty = true;
  }

  /**
   * 对比回放：画面分成左右两半，右半边画另一组车（同一个世界、同一个时钟）；side 不给就回到单画面。
   * pair、seed 只是给对比条显示（比什么、另一天的编号）。
   */
  setSplit(side: SplitSide | undefined, pair: SplitPair = 'loop', seed = 1): void {
    // 右边换了一组（或者关了）：跟随的右边的车不在了
    if (this.followRight) this.setFollow(undefined);
    if (!side) {
      this.split?.dispose();
      this.split = undefined;
    } else {
      if (this.split) this.split.setSide(side, pair, seed);
      else
        this.split = new SplitScreen(
          {
            renderer: this.renderer,
            scene: this.scene,
            camera: this.camera,
            controls: this.controls,
            host: this.host,
            left: this.vehicles,
            net: this.world.net,
            geos: this.fleetGeos,
            routeMat: this.routeMat,
            invalidate: () => (this.dirty = true),
            onPair: (p, sd) => this.onSplitPair?.(p, sd),
            leftOnly: () => this.routeLines,
            bind: (el) => this.bindPointer(el),
            pickTag: (i) => this.pickRight(i),
          },
          side,
          pair,
          seed,
          this.traffic,
        );
      this.split.setEvery(TIERS[this.qTier].splitEvery);
      this.split.setVisible(this.showLabels, this.showTags);
      // 同一天：左边选中的作业右边也选中（同一个下标）
      if (this.split.sameDayPair) this.split.select(this.sel.id, this.sel.marks, false);
    }
    this.resize();
  }

  /** 对比回放右边的车头标签（页面按右边那一组的跟踪信息给） */
  setSplitTags(list: { i: number; text: string; cls: string }[]): void {
    this.split?.setTags(list);
  }

  /** 对比回放右边的车辆层（页面算右边的跟踪信息用）；没开对比是 undefined */
  get splitVehicles(): Vehicles | undefined {
    return this.split?.right;
  }

  /** 对比回放右边是另一天时，在右边选中一辆车：光圈、路线、停靠点标签只画在右半边；focus：镜头跟随它 */
  selectRight(id: number | undefined, focus: boolean, marks: { text: string; pos: THREE.Vector3 }[] = []): void {
    if (!this.split) return;
    this.split.select(id, marks, true);
    if (focus && id !== undefined && this.split.right.poseOf(id)) this.setFollow(id, true);
  }

  /** 点了右半边的车或它的标签：交给页面（同一天等于点左边同一个作业，另一天在右边选中它）；没设时跟随它 */
  private pickRight(i: number): void {
    if (this.onPickRight) this.onPickRight(i);
    else this.setFollow(i, true);
  }

  /** 对比回放两边的标题和此刻的指标 */
  setSplitLabels(left: { title: string; kpi: string }, right: { title: string; kpi: string }): void {
    this.split?.setLabels(left, right);
  }

  get splitOn(): boolean {
    return !!this.split;
  }

  /** 现场的路况：事故 / 施工的路段画一个红圈，只在它发生的时段里显示 */
  setIncidents(list: { x: number; z: number; r: number; t0: number; t1: number; text: string }[]): void {
    for (const m of this.incidents) {
      this.scene.remove(m.mesh);
      m.mesh.geometry.dispose();
    }
    this.incidents = list.map((x) => {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(x.r * 0.82, x.r, 48), new THREE.MeshBasicMaterial({ color: '#d03b2a', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x.x, 1.2, x.z);
      mesh.visible = false;
      mesh.name = `incident:${x.text}`;
      this.scene.add(mesh);
      return { mesh, t0: x.t0, t1: x.t1 };
    });
    this.dirty = true;
  }

  /** 显示的类别变了：下一帧重画车辆 */
  invalidate(): void {
    this.dirty = true;
  }

  /** 实时跟踪的标签：每辆车一个（编号 + 预计到达或在做什么），每帧跟着车走；点一下等于在三维里点这辆车 */
  setTags(list: { i: number; text: string; cls: string }[]): void {
    const keep = new Set<number>();
    for (const tg of list) {
      keep.add(tg.i);
      let o = this.tags.get(tg.i);
      if (!o) {
        const div = document.createElement('div');
        div.addEventListener('click', () => {
          if (this.onPick) this.onPick(tg.i);
          else this.setFollow(tg.i);
        });
        o = new CSS2DObject(div);
        this.tagGroup.add(o);
        this.tags.set(tg.i, o);
      }
      const el = o.element;
      if (el.textContent !== tg.text) el.textContent = tg.text;
      const cls = `vtag ${tg.cls}`;
      if (el.className !== cls) el.className = cls;
    }
    for (const [i, o] of this.tags)
      if (!keep.has(i)) {
        this.tagGroup.remove(o);
        o.element.remove();
        this.tags.delete(i);
      }
    this.placeTags();
    this.dirty = true;
  }

  setTagsVisible(on: boolean): void {
    this.showTags = on;
    this.tagGroup.visible = on;
    this.split?.setVisible(this.showLabels, on);
    this.dirty = true;
  }

  private placeTags(): void {
    const scale = Math.max(1, this.distance() / 330);
    for (const [i, o] of this.tags) {
      const p = this.vehicles.poseOf(i);
      o.visible = !!p;
      if (p) o.position.set(p.x, tagHeight(this.vehicles, i, this.t, scale), p.y);
    }
  }

  private roadIndex: { cls: string; name: string; pts: { x: number; z: number }[]; box: [number, number, number, number] }[] | undefined;
  /** 某个位置在哪条路上（实时跟踪的位置说明）：环城高速、放射干道、内环路、几号立交、港口高速…… */
  roadAt(x: number, z: number): string | undefined {
    if (!this.roadIndex) {
      const ring = new Map<string, number>([...this.world.net.icIds].map((id, k) => [id, k + 1]));
      const hw = (a: string, b: string) => {
        const ends = `${a} ${b}`;
        if (/PORT/.test(ends)) return tr('港口高速');
        if (/AIR/.test(ends)) return tr('机场高速');
        if (/\bDC\b|BAKERY/.test(ends)) return tr('物流园高速');
        if (/NORTH|MAP_N/.test(ends)) return tr('国内长途高速');
        if (/EAST|MAP_E/.test(ends)) return tr('跨境长途高速');
        return tr('高速公路');
      };
      this.roadIndex = this.world.net.lines.map((l) => {
        const rid = /^(R\d)/.exec(l.name ?? '')?.[1];
        const name =
          l.cls === 'ring' ? tr('绕城快速路') : l.cls === 'elevated' ? tr('高架快速路') : l.cls === 'ramp' || l.cls === 'under' ? tr('绕城快速路 {v1} 号立交', { v1: rid ? (ring.get(rid) ?? '') : '' }).replace('  ', ' ') : l.cls === 'highway' ? (l.name && !/^R\d/.test(l.name) ? tx(l.name) : hw(l.ja, l.jb)) : l.cls === 'service' ? tr('园区道路') : (l.name ?? tr('城市道路'));
        const xs = l.pts.map((p) => p.x);
        const zs = l.pts.map((p) => p.z);
        return { cls: l.cls, name, pts: l.pts.map((p) => ({ x: p.x, z: p.z })), box: [Math.min(...xs) - 40, Math.max(...xs) + 40, Math.min(...zs) - 40, Math.max(...zs) + 40] as [number, number, number, number] };
      });
    }
    let best: string | undefined;
    let bd = 40;
    for (const r of this.roadIndex) {
      if (x < r.box[0] || x > r.box[1] || z < r.box[2] || z > r.box[3]) continue;
      for (let k = 1; k < r.pts.length; k++) {
        const a = r.pts[k - 1] as { x: number; z: number };
        const b = r.pts[k] as { x: number; z: number };
        const vx = b.x - a.x;
        const vz = b.z - a.z;
        const l2 = vx * vx + vz * vz || 1;
        const f = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
        const d = Math.hypot(x - (a.x + vx * f), z - (a.z + vz * f));
        if (d < bd) {
          bd = d;
          best = r.name;
        }
      }
    }
    return best;
  }

  setLabels(on: boolean): void {
    this.showLabels = on;
    this.labelGroup.visible = on;
    this.split?.setVisible(on, this.showTags);
    this.dirty = true;
  }

  /** 规划图：用地、货运通道、生活圈、噪声区和图例；打开时城区的楼和树藏起来 */
  private planMap: PlanMap | undefined;
  planOn = false;
  setPlanMap(on: boolean): void {
    if (on && !this.planMap) {
      this.planMap = new PlanMap(this.world.zoning.landuse, this.host);
      this.scene.add(this.planMap.group);
      for (const l of this.planMap.labels) this.addLabel(l.text, l.pos, 'plan');
    }
    this.planOn = on;
    this.planMap?.setVisible(on);
    this.world.zoning.group.visible = !on;
    this.dirty = true;
  }

  focus(p: RegionPreset, animate = true): void {
    this.setFollow(undefined);
    let tTo: THREE.Vector3;
    let to: THREE.Vector3;
    if (p === 'flagship') {
      // 综合店：从收货区那一侧斜着看过去
      tTo = this.storeCenter.clone();
      const o = new THREE.Vector3(62, 0, 108).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.storeGroup.rotation.y);
      to = tTo.clone().add(new THREE.Vector3(o.x, 70, o.z));
    } else {
      const spec = PRESETS[p];
      const f: Frame | undefined = spec.frame ? FRAMES[spec.frame] : undefined;
      // 港口：泊位多了码头变长，镜头对准码头的中间、按码头的长度拉远
      const L = p === 'port' ? this.port.layout : undefined;
      const k = L ? Math.max(1, (L.x1 - L.x0) / 760) : 1;
      const tx = L ? (L.x0 + L.x1) / 2 : spec.target[0];
      const tw = f ? frameToWorld(f, { x: tx, z: spec.target[2] }) : { x: tx, z: spec.target[2] };
      const ow = f ? dirToWorld(f, { x: spec.offset[0] * k, z: spec.offset[2] * k }) : { x: spec.offset[0], z: spec.offset[2] };
      tTo = new THREE.Vector3(tw.x, spec.target[1], tw.z);
      to = tTo.clone().add(new THREE.Vector3(ow.x, spec.offset[1] * k, ow.z));
    }
    if (!animate) {
      this.camera.position.copy(to);
      this.controls.target.copy(tTo);
      this.controls.update();
      this.dirty = true;
      return;
    }
    this.tween = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo, start: performance.now(), dur: 1200 };
  }

  /** 选中车辆的整趟路线（区域坐标）：飞机用机场作业里真实的进近、滑行、推出和起飞路径，别的车用车辆层的路线 */
  private routeFor(id: number): { x: number; y: number; z: number }[][] {
    const air = this.vehicles.items[id]?.kind === 'plane' ? this.airport.route(id) : [];
    if (!air.length) return this.vehicles.routeOf(id);
    return air.map((part) => part.map((p) => {
      const w = frameToWorld(FRAMES.airport, { x: p.x, z: p.z });
      return { x: w.x, y: p.y, z: w.z };
    }));
  }

  /** 正在跟随的车（车辆层里的下标；没在跟随、跟随的是对比回放右边的车或别家的船和货机时是 undefined）：分享链接用 */
  get followed(): number | undefined {
    return this.followRight || this.followExt ? undefined : this.follow;
  }

  /** 跟随一辆车（right：对比回放右半边的车，按右边的车辆层） */
  setFollow(id: number | undefined, right = false): void {
    this.follow = id;
    this.followRight = right && id !== undefined && !!this.split;
    this.followExt = undefined;
    this.onFollow?.(id === undefined ? undefined : (this.followRight ? this.split?.right : this.vehicles)?.items[id]);
  }

  /** 跟随港口、机场里别家的一条船、一架货机 */
  setFollowExt(tg: ExtTarget): void {
    this.follow = undefined;
    this.followExt = tg;
    const c = this.extCard(tg);
    this.onFollow?.(c ? { label: `${c.name} · ${c.type}` } : undefined);
  }

  /** 别家的船、货机此刻的说明 */
  extCard(tg: ExtTarget): ExtCard | undefined {
    return tg.src === 'port' ? this.port.callCard(tg.id, this.t) : this.airport.card(tg.id, this.t);
  }

  /** 跟随别家的船、货机时横幅上的字（此刻在做什么，随时间变）；没在跟随它们返回 undefined */
  followText(): string | undefined {
    const tg = this.followExt;
    const c = tg ? this.extCard(tg) : undefined;
    return tg && c ? tr('跟随：{name} · {type} · {act}（别家的{v4}，不参与仿真）', { name: c.name, type: c.type, act: c.act, v4: tg.src === 'port' ? tr('船') : tr('航班') }) : undefined;
  }

  /** 别家的船、货机此刻在区域里的位置 */
  private extPose(tg: ExtTarget): { x: number; z: number } | undefined {
    if (tg.src === 'port') {
      const p = this.port.callPose(tg.id, this.t);
      return p ? frameToWorld(FRAMES.port, { x: p.x, z: p.z }) : undefined;
    }
    const p = this.airport.pose(tg.id, this.t);
    return p ? frameToWorld(FRAMES.airport, { x: p.x, z: p.z }) : undefined;
  }

  /**
   * 选中一辆车（调度台里选中的作业）：脚下画光圈、整趟路线画成橙色的线、停靠点挂标签；
   * focus：车此刻在场就跟随，不在场就把镜头移到路线上。
   */
  selectVehicle(id: number | undefined, focus: boolean, marks: { text: string; pos: THREE.Vector3 }[] = []): void {
    this.vehicles.selected = id === undefined ? [] : [id];
    for (const l of this.routeLines) {
      this.scene.remove(l);
      l.geometry.dispose();
    }
    this.routeLines = [];
    for (const o of this.stopLabels) {
      this.labelGroup.remove(o);
      o.element.remove();
    }
    this.stopLabels = [];
    if (id !== undefined) {
      for (const part of this.routeFor(id)) {
        if (part.length < 2) continue;
        const g = new LineGeometry();
        g.setPositions(part.flatMap((p) => [p.x, p.y + 1.2, p.z]));
        const line = new Line2(g, this.routeMat);
        line.computeLineDistances();
        line.renderOrder = 3;
        this.scene.add(line);
        this.routeLines.push(line);
      }
      for (const m of marks) {
        const div = document.createElement('div');
        div.className = 'lbl3d lbl-stop';
        div.textContent = m.text;
        const o = new CSS2DObject(div);
        o.position.copy(m.pos);
        this.labelGroup.add(o);
        this.stopLabels.push(o);
      }
      if (focus) {
        const pose = this.vehicles.poseOf(id);
        if (pose) this.setFollow(id);
        else {
          const route = this.routeFor(id).flat();
          const p = route[Math.floor(route.length / 2)];
          if (p) {
            const tTo = new THREE.Vector3(p.x, 0, p.z);
            const off = this.camera.position.clone().sub(this.controls.target);
            if (off.length() > 1500) off.setLength(1500);
            this.tween = { from: this.camera.position.clone(), to: tTo.clone().add(off), tFrom: this.controls.target.clone(), tTo, start: performance.now(), dur: 900 };
          }
        }
      }
    }
    // 对比回放右边是同一天：右边也选中同一个作业（光圈、停靠点标签；路线两边共用）
    this.sel = { id, marks };
    if (this.split?.sameDayPair) this.split.select(id, marks, false);
    this.dirty = true;
  }

  show(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    const loop = () => {
      if (!this.running) return;
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  hide(): void {
    this.running = false;
  }

  /** 镜头离目标的距离：车辆放大、标签显示、阴影范围都按它 */
  private distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  frame(): void {
    if (this.tween) {
      // 系统设置了「减少动态」：镜头不飞（focus、flyTo、看车都一样），直接切到终点
      const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const k = reduce ? 1 : Math.min(1, (performance.now() - this.tween.start) / this.tween.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, e);
      this.controls.target.lerpVectors(this.tween.tFrom, this.tween.tTo, e);
      if (k >= 1) this.tween = undefined;
      this.dirty = true;
    }
    if (this.follow !== undefined || this.followExt) {
      const v = this.follow !== undefined ? (this.followRight ? this.split?.right : this.vehicles)?.poseOf(this.follow) : undefined;
      const e = this.followExt ? this.extPose(this.followExt) : undefined;
      const p = v ? { x: v.x, y: v.y } : e ? { x: e.x, y: e.z } : undefined;
      if (p) {
        // 跟随右边的车、右边的镜头没联动：只动右边的镜头
        if (!(this.followRight && this.split?.followTo(p.x, p.y))) {
          const to = new THREE.Vector3(p.x, 0, p.y);
          const delta = to.sub(this.controls.target).multiplyScalar(0.15);
          this.controls.target.add(delta);
          this.camera.position.add(delta);
        }
        this.dirty = true;
      }
    }
    this.controls.update();
    const dist = this.distance();
    // 帧时间：自动画质按最近几秒的 95% 分位数升降档（页面在后台时不算）
    const fnow = performance.now();
    if (!document.hidden) this.budget.push(fnow - this.frameAt, fnow);
    this.frameAt = fnow;
    const tier = this.budget.tick(fnow);
    if (tier) this.applyQuality(tier);
    // 雨丝、海浪每帧动（真实时间）；台风天打闪时天光临时加亮
    const fl = this.weather.update(dist, fnow / 1000, this.night, this.renderer.getDrawingBufferSize(this.drawSize), this.playing);
    if (fl !== this.flash) {
      this.flash = fl;
      this.hemi.intensity = this.baseHemi + fl * 1.8;
    }
    if (this.debugEl && fnow - this.debugAt > 500) {
      this.debugAt = fnow;
      this.debugEl.textContent = `${tr('帧时间 {p50} / {p95} 毫秒（中位数 / 95%）\n画质 {tier}{v4} · 像素密度 {getPixelRatio} · 阴影', { p50: this.budget.p50.toFixed(1), p95: this.budget.p95.toFixed(1), tier: TIER_LABEL[this.qTier], v4: this.budget.mode === 'auto' ? tr('（自动）') : '', getPixelRatio: this.renderer.getPixelRatio() })} ${this.sun.castShadow ? this.sun.shadow.mapSize.x : tr('关')}`;
    }
    const scale = Math.max(1, dist / 330);
    // 排完以后收货场的排程又变了（调度台改了预约）：车队间距按新的排程分段重排（每秒看一次）
    if (!this.plansPending && !this.convoyBusy && fnow - this.convoyAt > 1000) {
      this.convoyAt = fnow;
      if (this.vehicles.convoyStale()) this.rerunConvoy();
    }
    if (this.dirty || Math.abs(scale - this.lastScale) > 0.02) {
      this.vehicles.update(this.t, scale);
      this.split?.update(this.t, scale);
      // 机场按局部坐标判断镜头远近（拉近货站时打开屋面、画库内）
      const ac = frameToLocal(FRAMES.airport, { x: this.camera.position.x, z: this.camera.position.z });
      this.airport.update(this.t, scale, { x: ac.x, y: this.camera.position.y, z: ac.z });
      this.ext.update(this.t, scale);
      this.peds.update(this.t, dist, this.controls.target);
      const now = performance.now();
      const realDt = Math.min(0.5, (now - this.lastFrameAt) / 1000);
      this.lastFrameAt = now;
      const gate = this.dc.gates;
      const busy = this.vehicles.items.some((v, i) => {
        if (v.kind === 'train' || v.kind === 'ship' || v.kind === 'plane') return false;
        const q = this.vehicles.poseOf(i);
        return !!q && Math.hypot(q.x - ((gate[0] as { x: number }).x + (gate[1] as { x: number }).x) / 2, q.y - (gate[0] as { z: number }).z) < 16;
      });
      // 物流园按局部坐标判断镜头远近（拉近时屋顶打开）：给它一个换到局部坐标的镜头位置
      const lc = frameToLocal(FRAMES.park, { x: this.camera.position.x, z: this.camera.position.z });
      this.dcCam.position.set(lc.x, this.camera.position.y, lc.z);
      this.dc.update(this.t, this.dcCam, [busy, busy], realDt, (vid, t) => this.vehicles.planT(vid, t), scale);
      this.storeDocks.update(this.t, (vid, t) => this.vehicles.planT(vid, t));
      this.storeSite?.update(this.t, dist < 2600 && this.controls.target.distanceTo(this.storeCenter) < 1600);
      this.railDcW.update(this.t);
      this.railDcE.update(this.t);
      this.railPort.update(this.t);
      for (const m of this.incidents) m.mesh.visible = this.t >= m.t0 && this.t < m.t1;
      this.updateDoorLights();
      const sp = this.shipVid !== undefined ? this.vehicles.poseOf(this.shipVid) : undefined;
      // 本店班轮的姿态换到港口的局部坐标（甲板上的箱按局部坐标画）
      const lp = sp ? frameToLocal(FRAMES.port, { x: sp.x, z: sp.y }) : undefined;
      const pc = frameToLocal(FRAMES.port, { x: this.camera.position.x, z: this.camera.position.z });
      this.port.update(this.t, sp && lp ? { x: lp.x, y: lp.z, dir: sp.dir + FRAMES.port.rot } : undefined, { x: pc.x, y: this.camera.position.y, z: pc.z });
      // 潮汐：海面跟着涨落（船、拖轮在港口作业和车辆层里跟着浮起来）
      const sea = this.world.group.getObjectByName('sea');
      if (sea) sea.position.y = seaY(this.t);
      // 信号灯按时刻变色，铁路道口在火车靠近时放下栏杆
      this.world.roads.update(this.t, (p, r) => this.vehicles.items.some((v, i) => {
        if (v.kind !== 'train') return false;
        const q = this.vehicles.poseOf(i);
        return !!q && Math.hypot(q.x - p.x, q.y - p.z) < r;
      }));
      // 停车场的道闸：背景车流过道闸时抬杆
      const tr = this.vehicles.traffic ? this.traffic : undefined;
      this.world.parking.update((key) => (!!tr && tr.barrierRaised(key, this.t)) || this.ext.barrierRaised(key, this.t));
      this.lastScale = scale;
      const nearStore = this.controls.target.distanceTo(this.storeCenter) < 700 && dist < 900;
      this.agents.group.visible = nearStore;
      if (nearStore) this.agents.update(this.t);
      const mode = nearStore && dist < 260 ? 'cutaway' : 'exterior';
      if (mode !== this.storeMode && this.store) {
        this.storeMode = mode;
        setExteriorMode(this.store, mode);
        this.world.stores.setCutaway(mode === 'cutaway');
      }
      this.updateLabels(dist);
      this.placeTags();
      this.updateLight(dist);
      this.dirty = false;
    }
    if (this.split) this.split.render(this.leftInset, this.rightInset);
    else this.renderer.render(this.scene, this.camera);
    if (this.showLabels) this.labels.render(this.scene, this.camera);
    if (this.monitorsOn) this.renderMonitors();
  }

  // ———————————————————————— 虚拟监控 ————————————————————————

  private monitors: { cam: THREE.PerspectiveCamera; dist: number; el: HTMLElement; cv: HTMLCanvasElement; info: HTMLElement; kind: 'store' | 'dc' | 'port'; label: string; anchors: { x: number; z: number }[]; res?: VisionResult }[] = [];
  /** 监控识别：上一次算到的时刻、每个目标上一次的位置（判断停着没有） */
  private visionAt = -Infinity;
  private readonly visionLast = new Map<number, { x: number; z: number; t: number }>();
  private monitorsOn = false;

  /**
   * 虚拟监控：几个固定机位（门店收货区、配送中心月台、港口泊位）从同一个三维场景渲染的小画面，叠在三维视图右上角。
   * 接入真实摄像头时，这几个画面换成视频流，和三维里同一个位置对齐（视频融合）。
   */
  setMonitors(on: boolean): void {
    this.monitorsOn = on;
    // 机位关着也建好（识别结果给值班助手和看板用），只是不画
    if (!this.monitors.length && this.world.sites.size) {
      const site = [...this.world.sites.values()][0];
      const berth = P(SEA_BERTH);
      const dcAt = (x: number, y: number, z: number) => {
        const p = frameToWorld(FRAMES.park, { x, z });
        return new THREE.Vector3(p.x, y, p.z);
      };
      const dcL = { x: FRAMES.park.o.x, z: FRAMES.park.o.z };
      const off = dirToWorld(FRAMES.port, { x: 140, z: -120 });
      const spots: { label: string; kind: 'store' | 'dc' | 'port'; pos: THREE.Vector3; target: THREE.Vector3; anchors: { x: number; z: number }[] }[] = [];
      if (site) spots.push({ label: tr('{name} · 收货区（{docks} 个收货口）', { name: tx(site.st.name), docks: site.st.docks }), kind: 'store', pos: toWorld(site, 30, -150, 15), target: toWorld(site, -3, -89, 3), anchors: site.docks.map((d) => ({ x: d.door.x, z: d.door.z })) });
      // 冷链中心的月台门（全链路的多温区车在这里装车）和旁边的干货门
      spots.push({ label: tr('配送中心 · 冷链月台门'), kind: 'dc', pos: dcAt(dcL.x + 170, 20, dcL.z - 75 + 70), target: dcAt(dcL.x + 235, 3, dcL.z - 75), anchors: dcDoorsWorld() });
      spots.push({ label: tr('集装箱港口 · 本店班轮的泊位'), kind: 'port', pos: berth.clone().add(new THREE.Vector3(off.x, 70, off.z)), target: berth.clone(), anchors: [] });
      for (const s of spots) {
        const cam = new THREE.PerspectiveCamera(48, 16 / 9, 2, 6000);
        cam.position.copy(s.pos);
        cam.lookAt(s.target);
        cam.updateMatrixWorld();
        const el = document.createElement('div');
        el.className = 'mon-label';
        el.innerHTML = `<span class="rec"></span>${s.label}<small>${tr('虚拟监控 · 从三维孪生渲染')}</small><small class="mon-vision-info"></small>`;
        // 识别框画在叠在画面上的画布上
        const cv = document.createElement('canvas');
        cv.className = 'mon-vision';
        Object.assign(cv.style, { position: 'absolute', pointerEvents: 'none' });
        this.host.append(el, cv);
        this.monitors.push({ cam, dist: s.pos.distanceTo(s.target), el, cv, info: el.querySelector('.mon-vision-info') as HTMLElement, kind: s.kind, label: s.label, anchors: s.anchors });
      }
    }
    for (const m of this.monitors) {
      m.el.hidden = !on;
      m.cv.hidden = !on;
    }
    this.dirty = true;
  }

  /** 监控画面里的目标：自己的车船（真实尺寸的位置）、外来集卡、社会车流；靠台、排队按位置和是否停着判断 */
  private visionObjects(m: (typeof this.monitors)[number], t: number): VisionObject[] {
    const out: VisionObject[] = [];
    const cx = m.cam.position.x;
    const cz = m.cam.position.z;
    const near = (x: number, z: number) => Math.hypot(x - cx, z - cz) < (m.kind === 'port' ? 900 : 450);
    const SIZE: Record<string, [string, number, number, number]> = { truck: ['半挂车', 16.5, 2.6, 4], reefer: ['冷藏车', 12, 2.6, 3.8], ev: ['电动厢式车', 9, 2.5, 3.4], van: ['面包车', 5.5, 2, 2.4], drayage: ['集装箱拖车', 16.5, 2.6, 4.2], ship: ['集装箱船', 200, 32, 40], train: ['火车', 300, 3, 4.5], plane: ['货机', 50, 50, 15], bus: ['公交车', 12, 2.5, 3.2], boxTruck: ['厢式货车', 7.6, 2.3, 3.4] };
    const add = (id: number, kind: string, x: number, z: number, yaw: number, moving: boolean | undefined) => {
      const sz = SIZE[kind] ?? (['小汽车', 4.6, 1.8, 1.5] as [string, number, number, number]);
      // 停着没有：自己的车有「在动」的标记，其余按和上一次的位置比
      let still = moving === false;
      if (moving === undefined) {
        const last = this.visionLast.get(id);
        still = !!last && t > last.t && Math.hypot(x - last.x, z - last.z) / (t - last.t) < 0.3;
        this.visionLast.set(id, { x, z, t });
      }
      const atDock = m.anchors.length ? Math.min(...m.anchors.map((a) => Math.hypot(a.x - x, a.z - z))) : Infinity;
      const truckish = kind !== 'ship' && kind !== 'train' && kind !== 'plane' && sz[1] > 5;
      const dock = truckish && atDock < 5 ? 'ok' : truckish && atDock < 10 && still ? 'off' : undefined;
      out.push({ id, cls: sz[0], x, y: 0, z, yaw, len: sz[1], wid: sz[2], hgt: sz[3], ...(dock ? { dock } : {}), ...(!dock && still && truckish ? { queued: true } : {}) });
    };
    this.vehicles.items.forEach((v, i) => {
      const p = this.vehicles.poseOf(i);
      if (p && near(p.x, p.y)) add(i, v.kind, p.x, p.y, p.dir, p.moving);
    });
    for (let i = 0; i < this.ext.count; i++) {
      const p = this.ext.poseAt(i, t);
      // 外来集卡和社会车流的朝向是 three.js 的转角（atan2(−dz, dx)），识别按沙盘的 atan2(dz, dx)，取反
      if (p && near(p.x, p.z)) add(100000 + i, 'drayage', p.x, p.z, -p.yaw, undefined);
    }
    const tr = this.traffic;
    if (tr) {
      const tp = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
      for (const ci of tr.activeAt(t)) {
        const c = tr.cars[ci];
        if (!c || !tr.pose(c, t, tp) || !near(tp.x, tp.z)) continue;
        add(200000 + ci, c.kind === 2 ? 'bus' : c.kind === 3 ? 'boxTruck' : c.kind === 4 ? 'truck' : 'car', tp.x, tp.z, -tp.yaw, undefined);
      }
    }
    return out;
  }

  /**
   * 监控识别的结果（每个机位：画面里认出几辆车、几辆在排队、靠台的车里几辆靠好了、几辆没对准）。
   * 监控画面开着时跟着画面算；关着时问到才算一次（同一个时刻不重复算）。
   */
  cameraDetections(): { label: string; kind: 'store' | 'dc' | 'port'; vehicles: number; queued: number; docked: number; misaligned: number }[] {
    if (!this.monitors.length) this.setMonitors(this.monitorsOn);
    if (Math.abs(this.t - this.visionAt) >= 1) {
      this.vehicles.update(this.t, 1);
      for (const [k, m] of this.monitors.entries()) m.res = detect(m.cam, this.visionObjects(m, this.t), this.t, k + 1);
      this.vehicles.update(this.t, this.lastScale);
      this.visionAt = this.t;
    }
    return this.monitors.map((m) => ({ label: m.label, kind: m.kind, vehicles: m.res?.vehicles ?? 0, queued: m.res?.queued ?? 0, docked: m.res?.docked ?? 0, misaligned: m.res?.misaligned ?? 0 }));
  }

  private renderMonitors(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const w = Math.round(Math.min(280, Math.max(150, size.x * 0.24)));
    const h = Math.round((w * 9) / 16);
    const dpr = this.renderer.getPixelRatio();
    // 每个机位先画进自己的离屏画面，再贴到三维右上角；画质低时隔几帧才重画一次，其余的帧贴上一次画好的
    const fresh = this.monitorTick++ % TIERS[this.qTier].monitorEvery === 0;
    // 车辆在远镜头时放大，监控是近景：按真实尺寸重画一次车辆，画完再恢复；
    // 雨丝和雾按各自的机位摆（画完恢复主镜头的雾，雨丝下一帧再按主镜头摆）
    if (fresh) this.vehicles.update(this.t, 1, this.monitors.map((mm) => mm.cam.position));
    const fog = this.scene.fog as THREE.Fog;
    const mainFog = { near: fog.near, far: fog.far };
    this.renderer.setScissorTest(true);
    this.monitors.forEach((m, k) => {
      const x = size.x - w - 10 - this.rightInset;
      const top = 10 + k * (h + 26);
      if (top + h > size.y - 40) {
        m.el.hidden = true;
        m.cv.hidden = true;
        return;
      }
      m.cv.hidden = false;
      m.el.hidden = false;
      const y = size.y - top - h;
      const rw = Math.max(1, Math.round(w * dpr));
      const rh = Math.max(1, Math.round(h * dpr));
      let rt = this.monitorRT[k];
      const resized = !rt || rt.width !== rw || rt.height !== rh;
      if (resized) {
        rt?.dispose();
        rt = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, samples: 4 });
        this.monitorRT[k] = rt;
      }
      const target = rt as THREE.WebGLRenderTarget;
      if (fresh || resized) {
        if (!fresh) this.vehicles.update(this.t, 1, this.monitors.map((mm) => mm.cam.position));
        m.cam.aspect = w / h;
        m.cam.updateProjectionMatrix();
        this.weather.aim(m.dist, rw, rh);
        Object.assign(fog, this.weather.fogRange(m.dist));
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, m.cam);
        this.renderer.setRenderTarget(null);
        // 识别：车辆这时是真实尺寸的位置，正好拿来算；画面上叠识别框，标签下面写计数
        m.res = detect(m.cam, this.visionObjects(m, this.t), this.t, k + 1);
        if (m.cv.width !== rw || m.cv.height !== rh) {
          m.cv.width = rw;
          m.cv.height = rh;
        }
        drawDetections(m.cv, m.res);
        m.info.textContent = `${tr('识别：{vehicles} 个目标', { vehicles: m.res.vehicles })}${m.res.docked ? ` ${tr('· 已靠好 {docked}', { docked: m.res.docked })}` : ''}${m.res.misaligned ? ` ${tr('· 没对准 {misaligned}', { misaligned: m.res.misaligned })}` : ''}${m.res.queued ? ` ${tr('· 排队 {queued}', { queued: m.res.queued })}` : ''}`;
        if (!fresh) this.vehicles.update(this.t, this.lastScale);
      }
      this.renderer.setViewport(x, y, w, h);
      this.renderer.setScissor(x, y, w, h);
      this.blit.mat.map = target.texture;
      this.renderer.render(this.blit.scene, this.blit.cam);
      Object.assign(m.el.style, { left: `${x}px`, top: `${top + h}px`, width: `${w}px` });
      Object.assign(m.cv.style, { left: `${x}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    });
    if (fresh) this.visionAt = this.t;
    Object.assign(fog, mainFog);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
    if (fresh) this.vehicles.update(this.t, this.lastScale);
  }

  // ———————————————————————— 天气、画质 ————————————————————————

  /** 播放 / 暂停（台风天的闪电只在播放时打） */
  setPlaying(on: boolean): void {
    this.playing = on;
  }

  /** 天气：自动（按当天的编号和钟点）、晴、多云、雨、雾、台风 */
  setWeather(m: WeatherMode): void {
    this.weather.setMode(m);
    this.lastLight = -1;
    this.dirty = true;
    this.weatherTraffic();
  }

  /** 这一天在演练的扰动：风暴（机场关闭）整天台风天，风暴预警（需求突增）傍晚转大雨 */
  setWeatherDrill(key: string | undefined): void {
    this.weather.setDrill(key);
    this.lastLight = -1;
    this.dirty = true;
    this.weatherTraffic();
  }

  /** 此刻的天气：模式、名字、能见度（真实公里） */
  weatherInfo(): { mode: WeatherMode; name: string; visKm: number; state: WeatherState } {
    const state = this.weather.stateAt(this.t);
    const d = describe(state);
    return { mode: this.weather.mode, name: d.name, visKm: d.visKm, state };
  }

  /** 天气对路上车速的影响：晴 1、雨约 0.85、雾约 0.75、台风 0.6（给社会车流接） */
  weatherFactor(): number {
    return speedFactor(this.weather.stateAt(this.t));
  }

  /** 画质：自动或手动选一档 */
  setQuality(m: QualityMode): QualityTier {
    const tier = this.budget.setMode(m);
    this.applyQuality(tier);
    return tier;
  }

  /** 画质此刻是哪一档、帧时间（毫秒） */
  qualityInfo(): { mode: QualityMode; tier: QualityTier; p50: number; p95: number } {
    return { mode: this.budget.mode, tier: this.qTier, p50: this.budget.p50, p95: this.budget.p95 };
  }

  /** 换一档画质：像素密度、阴影（开关和大小）、监控画面的帧率、标签多少、雨滴数量 */
  private applyQuality(tier: QualityTier): void {
    this.qTier = tier;
    const q = TIERS[tier];
    this.renderer.setPixelRatio(Math.min(q.dpr, window.devicePixelRatio || 1));
    // 阴影：关的时候不让太阳投影（阴影图就不画了）；大小变了重建阴影图
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowSize) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.labelLevel = q.labels;
    this.weather.setBudget(q.rain);
    this.split?.setEvery(q.splitEvery);
    this.lastLight = -1;
    this.resize();
    this.onQuality?.(tier, this.budget.mode);
  }

  private updateLabels(dist: number): void {
    const near = this.controls.target.distanceTo(this.storeCenter);
    for (const { o, kind } of this.labelObjs) {
      // 画质低时少一点标签：区域里的小地名、店里的小标签不显示
      o.visible = kind === 'term' ? dist < 420 && o.position.distanceTo(this.controls.target) < 300 : kind === 'big' ? dist > 160 : kind === 'plan' ? this.planOn && dist > 150 : kind === 'zone' ? this.labelLevel > 1 && dist < 3200 && dist > 120 : kind === 'store' ? dist < 6000 : kind === 'innerBig' ? near < 120 && dist < 260 : kind === 'inner' ? this.labelLevel > 1 && near < 90 && dist < 140 : true;
    }
  }

  /** 时间 → 天光和太阳：夜里暗一些（仍然看得清），太阳从东边升起、西边落下；阴影范围跟着镜头 */
  private updateLight(dist: number): void {
    const h = this.t / 3600;
    // 天气按小时平滑变化：雨、雾、云、风、湿的程度也算进要不要重算光线
    const ws = this.weather.stateAt(this.t);
    const key = Math.round(h * 20) + Math.round(dist / 50) * 1000 + Math.round(this.controls.target.x / 40) * 7 + Math.round(this.controls.target.z / 40) * 13 + Math.round((ws.rain * 3 + ws.fog * 5 + ws.cloud * 7 + ws.wind * 11 + ws.wet * 13) * 20) * 1e7;
    if (key === this.lastLight) return;
    this.lastLight = key;
    const elev = Math.sin((Math.PI * (h - 6)) / 13.5);
    const day = Math.max(0, Math.min(1, elev * 1.6 + 0.2));
    this.world.zoning.setNight(1 - day, h);
    this.world.parking.setNight(1 - day);
    this.storeSite?.setNight(1 - day);
    this.lights.setNight(1 - day);
    this.port.setNight(1 - day);
    this.airport.setNight(1 - day);
    this.hemi.intensity = 0.5 + 0.6 * day;
    this.sun.intensity = 0.2 + 1.6 * Math.max(0, elev) ** 0.6;
    const bg = new THREE.Color('#223049').lerp(new THREE.Color('#dce7f0'), day);
    (this.scene.background as THREE.Color).copy(bg);
    (this.scene.fog as THREE.Fog).color.copy(bg);
    this.sun.color.set(day < 0.5 ? '#c9d6ff' : '#fff3e0');
    // 天气：阴天、雨、雾让太阳弱、阴影淡、天空灰，远处更快淡进背景（会改上面的天空、雾和光的强度）
    this.renderer.toneMappingExposure = this.weather.applyLight(this.t, day, dist, this.scene, this.sun, this.hemi).exposure;
    this.baseHemi = this.hemi.intensity;
    if (this.flash) this.hemi.intensity = this.baseHemi + this.flash * 1.8;
    this.night = 1 - day;
    const az = (Math.PI * (h - 6)) / 13.5;
    const tgt = this.controls.target;
    const R = Math.max(400, Math.min(6000, dist * 1.4));
    this.sun.position.set(tgt.x + Math.cos(az) * R * 0.8, tgt.y + Math.max(0.25, elev) * R, tgt.z + R * 0.45);
    this.sun.target.position.copy(tgt);
    const half = Math.max(140, Math.min(3200, dist * 0.75));
    const sc = this.sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 10;
    sc.far = R * 3;
    sc.updateProjectionMatrix();
  }

  /** 三维视图左边被面板挡住的宽度（像素）：画面中心往右移一半，镜头对着的东西落在没被挡住的那块中间 */
  private leftInset = 0;
  private rightInset = 0;
  setLeftInset(px: number): void {
    if (Math.abs(px - this.leftInset) < 1) return;
    this.leftInset = px;
    this.resize();
  }

  /** 右边的设施监控面板挡住多宽：画面中心往左挪一半 */
  setRightInset(px: number): void {
    if (Math.abs(px - this.rightInset) < 1) return;
    this.rightInset = px;
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    // 对比回放时标签层只盖左半边（标签、车辆编号按左边的镜头放）
    this.labels.setSize(this.split ? Math.floor(w / 2) : w, h);
    this.routeMat.resolution.set(w, h);
    this.camera.aspect = w / h;
    const shift = (this.rightInset - this.leftInset) / 2;
    if (Math.abs(shift) > 0.5) this.camera.setViewOffset(w, h, shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.split) {
      // 对比回放：每一帧画的时候按半边设镜头；路线的线宽按半边的分辨率
      this.routeMat.resolution.set(Math.floor(w / 2), h);
      this.split.resize();
    }
    this.dirty = true;
  }

  private pick(e: PointerEvent): Hover | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // 对比回放：右半边按右边的镜头拾取，车用右边的车辆层（港口、机场、店里的人两边共用，照常拾取）
    const split = this.split && !this.split.pickable(x) ? this.split : undefined;
    if (split) split.rayAt(x, y, this.ray);
    else {
      const pw = this.split ? Math.floor(r.width / 2) : r.width;
      this.pointer.set((x / pw) * 2 - 1, -(y / r.height) * 2 + 1);
      this.ray.setFromCamera(this.pointer, this.camera);
    }
    if (this.agents.group.visible) {
      const a = this.agents.pick(this.ray);
      if (a) return { kind: 'agent', agent: a.agent, ...(a.act ? { act: a.act } : {}), x, y };
    }
    // 区域车辆层的车、港口里别家的船、机场里的飞机：离镜头最近的那个
    const v = (split ? split.right : this.vehicles).pick(this.ray);
    const pc = this.port.pick(this.ray);
    const pa = this.airport.pickAny(this.ray);
    const dv = v?.dist ?? Infinity;
    const dp = pc?.dist ?? Infinity;
    const da = pa?.dist ?? Infinity;
    if (v && dv <= dp && dv <= da) return { kind: 'vehicle', picked: v, x, y, ...(split ? { half: 'right' as const } : {}) };
    if (pa && da <= dp) {
      if (pa.own) {
        const plane = this.vehicles.items[pa.vid];
        const act = this.vehicles.poseOf(pa.vid)?.act;
        return plane ? { kind: 'vehicle', picked: { v: plane, ...(act ? { act } : {}) }, x, y } : undefined;
      }
      const target: ExtTarget = { src: 'air', id: pa.vid };
      const card = this.extCard(target);
      return card ? { kind: 'ext', target, card, x, y } : undefined;
    }
    if (pc) {
      const target: ExtTarget = { src: 'port', id: pc.call };
      const card = this.extCard(target);
      return card ? { kind: 'ext', target, card, x, y } : undefined;
    }
    return undefined;
  }

  private hover(e: PointerEvent): void {
    if (!this.onHover || e.buttons) return;
    this.onHover(this.pick(e));
  }

  private click(e: PointerEvent): void {
    const h = this.pick(e);
    if (h?.kind === 'ext') {
      this.setFollowExt(h.target);
      return;
    }
    if (h?.kind !== 'vehicle') return;
    if (h.half === 'right') this.pickRight(h.picked.v.id);
    else if (this.onPick) this.onPick(h.picked.v.id);
    else this.setFollow(h.picked.v.id);
  }

  /** 悬停、点选、拖动后停止跟随：画布上；对比回放取消镜头联动时，盖在右半边上的拖动区域也接上 */
  private bindPointer(el: HTMLElement): void {
    let down: { x: number; y: number } | undefined;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.click(e);
      else if (down) this.setFollow(undefined);
      down = undefined;
    });
    el.addEventListener('pointermove', (e) => this.hover(e));
    el.addEventListener('pointerleave', () => this.onHover?.(undefined));
  }

  /** 导出整个区域和此刻的车辆、综合店为 glTF 二进制（.glb） */
  async exportGlb(): Promise<Blob> {
    // 导出器用到时才加载（单独一块，不拖慢首屏）
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const root = new THREE.Group();
    root.name = 'StoreX-Chain region';
    root.add(this.world.group.clone(true), this.vehicles.group.clone(true), this.storeGroup.clone(true));
    const data = (await exporter.parseAsync(root, { binary: true, onlyVisible: true })) as ArrayBuffer;
    return new Blob([data], { type: 'model/gltf-binary' });
  }
}
