import type { Board } from '../src/sim/board';
import type { WVehicle } from '../src/sim/trace';
import { BUILDS } from '../web/src/three/fleet';
import { buildMotion, doorPlace, leadU, legAt, trackAt, type Motion } from '../web/src/three/motion';
import { registerPlaces } from '../web/src/three/places';
import { RoadNet } from '../web/src/three/roadnet';
import type { Site } from '../web/src/three/stores';

/**
 * 车辆的车道级位置：和网页三维用同一套道路网（车道、路口、立交）、同一套停靠点和运动规划，
 * 所以服务发给虚幻引擎的位置和网页里画的一样。位置是沙盘坐标（米）：x 向东、z 向南。
 */
export interface Pose {
  x: number;
  z: number;
  /** 车头朝向（度）：0 = 向东，90 = 向南（从上往下看顺时针）；位置 x、z 是车头（前保险杠中间），倒车时也是 */
  heading: number;
  /** 正在倒车（倒进收货口、月台门） */
  reversing: boolean;
  /** 这一段在做什么（计划里的说明） */
  act: string;
}

type BuildKey = keyof typeof BUILDS;
function buildKey(v: WVehicle): BuildKey | undefined {
  const outside = /供应商|生鲜集货|空运|长途/.test(v.label);
  switch (v.kind) {
    case 'truck':
      return outside ? 'plainDry' : 'ownDry';
    case 'reefer':
      return outside ? 'plainReefer' : 'ownReefer';
    case 'ev':
      return 'ev';
    case 'van':
      return /面包/.test(v.label) ? 'vanBakery' : 'vanOnline';
    case 'drayage':
      return 'drayage';
    default:
      return undefined;
  }
}

export class Poses {
  readonly net = new RoadNet();
  readonly sites: Map<string, Site>;
  private motions = new WeakMap<WVehicle, { m: Motion; L: number } | null>();

  constructor(private board: Board) {
    this.sites = registerPlaces(this.net);
  }

  setBoard(board: Board): void {
    this.board = board;
    this.motions = new WeakMap();
  }

  /** 第 vid 辆车（计划轨迹 v）在计划时刻 tau 的位置 */
  pose(vid: number, v: WVehicle, tau: number): Pose | undefined {
    let mm = this.motions.get(v);
    if (mm === undefined) {
      mm = this.build(vid, v);
      this.motions.set(v, mm);
    }
    if (!mm) return undefined;
    const leg = legAt(mm.m, tau);
    if (!leg) return undefined;
    // 领先点 u 是沿路径走在最前面的那一点：前进时是车头；倒车时是车尾，车头在后面 L 米、朝着路径的反方向
    const u = leadU(leg, tau);
    const front = leg.rev ? u - mm.L : u;
    const p = trackAt(leg.track, front);
    const q = trackAt(leg.track, leg.rev ? front - 2 : front + 2);
    return { x: round(p.x), z: round(p.z), heading: round(((Math.atan2(q.z - p.z, q.x - p.x) * 180) / Math.PI + 360) % 360), reversing: !!leg.rev, act: leg.act ?? '' };
  }

  private build(vid: number, v: WVehicle): { m: Motion; L: number } | null {
    const key = buildKey(v);
    if (!key) return null;
    const byVehicle = this.board.ops.find((o) => o.vehicle === vid);
    const resolve = (k: string) => {
      if (k === 'DC') return doorPlace(byVehicle?.door);
      const d = byVehicle?.docks?.[k];
      return d ? `${k}#${d + 1}` : undefined;
    };
    const loopTo = (store: string, k: number) => {
      const node = [...this.net.edgeArcs.keys()].find((x) => x.startsWith(`${store}|`))?.split('|')[1];
      if (!node) return undefined;
      const nb = [...this.net.edgeArcs.keys()].filter((x) => x.startsWith(`${node}|`)).map((x) => x.split('|')[1] as string).filter((x) => !/^S\d\d$/.test(x));
      return nb.length ? nb[k % nb.length] : node;
    };
    return { m: buildMotion(v, this.net, { L: BUILDS[key].L, resolve, yard: vid, lane: 0, loopTo }), L: BUILDS[key].L };
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
