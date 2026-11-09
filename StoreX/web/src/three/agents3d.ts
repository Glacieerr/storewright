import * as THREE from 'three';
import type { AgentKind, AgentTrace } from '../../../src/ops/trace';
import { TraceCursor, type Pose } from '../tracePos';
import { CAR_COLORS, MODELS, SHIRTS } from './models';

/**
 * 三维里的人、机器人和车辆：每一类一个 InstancedMesh，每帧按轨迹回放的位置和朝向更新。
 * 员工衣服按工作内容上色（线上履约蓝、门店员工橙、机器人值班紫），顾客衣服和车辆颜色按编号固定。
 */
type Slot = 'body' | 'head' | 'mfcBot' | 'amr' | 'scanner' | 'scrubber' | 'cart' | 'loader' | 'pallet' | 'truck' | 'van' | 'car';

const KIND_SLOT: Partial<Record<AgentKind, Slot>> = {
  mfcBot: 'mfcBot',
  amr: 'amr',
  scanner: 'scanner',
  scrubber: 'scrubber',
  cart: 'cart',
  loader: 'loader',
  pallet: 'pallet',
  truck: 'truck',
  van: 'van',
  car: 'car',
};
const ONLINE = new Set<AgentKind>(['picker', 'dispenser', 'porter', 'decanter', 'freshPicker', 'handoff']);
const FLOOR = new Set<AgentKind>(['stocker', 'receiver', 'cashier', 'host']);
const CAPACITY: Record<Slot, number> = { body: 900, head: 900, mfcBot: 48, amr: 12, scanner: 4, scrubber: 6, cart: 8, loader: 4, pallet: 4, truck: 16, van: 8, car: 260 };

export interface Picked {
  agent: AgentTrace;
  act?: string;
}

export class Agents3D {
  readonly group = new THREE.Group();
  private meshes = new Map<Slot, THREE.InstancedMesh>();
  /** 每个 InstancedMesh 的第几个实例是哪个人（拾取用） */
  private owners = new Map<Slot, number[]>();
  private agents: AgentTrace[] = [];
  private cursor = new TraceCursor([]);
  private poses: (Pose | undefined)[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly col = new THREE.Color();
  /** 货格机器人在货格顶上跑的高度 */
  mfcTop = 4.6;
  /** 不显示的类别（图例开关） */
  hidden = new Set<string>();

  constructor() {
    this.group.name = 'agents';
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    const geos: Record<Slot, THREE.BufferGeometry> = {
      body: MODELS.personBody(),
      head: MODELS.personHead(),
      mfcBot: MODELS.mfcBot(),
      amr: MODELS.amr(),
      scanner: MODELS.scanner(),
      scrubber: MODELS.scrubber(),
      cart: MODELS.cart(),
      loader: MODELS.loader(),
      pallet: MODELS.pallet(),
      truck: MODELS.truck(),
      van: MODELS.van(),
      car: MODELS.car(),
    };
    for (const slot of Object.keys(geos) as Slot[]) {
      const mesh = new THREE.InstancedMesh(geos[slot], mat, CAPACITY[slot]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (slot === 'body' || slot === 'car') {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[slot] * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = slot;
      this.meshes.set(slot, mesh);
      this.owners.set(slot, []);
      this.group.add(mesh);
    }
  }

  setAgents(agents: AgentTrace[]): void {
    this.agents = agents;
    this.cursor = new TraceCursor(agents);
    this.poses = new Array(agents.length);
  }

  /** 图例分组（和二维一致） */
  static groupKey(kind: AgentKind): string {
    if (kind === 'shopper') return 'shopper';
    if (ONLINE.has(kind)) return 'online';
    if (FLOOR.has(kind) || kind === 'robotTech') return 'floor';
    if (kind === 'mfcBot') return 'mfc';
    if (kind === 'amr' || kind === 'cart' || kind === 'loader' || kind === 'pallet') return 'robots';
    if (kind === 'scanner' || kind === 'scrubber') return 'clean';
    return 'vehicle';
  }

  update(t: number): void {
    const counts = new Map<Slot, number>();
    for (const o of this.owners.values()) o.length = 0;
    const put = (slot: Slot, i: number, pose: Pose, y: number, scale = 1) => {
      const mesh = this.meshes.get(slot) as THREE.InstancedMesh;
      const n = counts.get(slot) ?? 0;
      if (n >= CAPACITY[slot]) return -1;
      this.e.set(0, -pose.dir, 0);
      this.q.setFromEuler(this.e);
      this.v.set(pose.x, y, pose.y);
      this.s.setScalar(scale);
      this.m.compose(this.v, this.q, this.s);
      mesh.setMatrixAt(n, this.m);
      (this.owners.get(slot) as number[])[n] = i;
      counts.set(slot, n + 1);
      return n;
    };
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i] as AgentTrace;
      const pose = this.cursor.pose(i, t);
      this.poses[i] = pose;
      if (!pose || this.hidden.has(Agents3D.groupKey(a.kind))) continue;
      const slot = KIND_SLOT[a.kind];
      if (slot) {
        const n = put(slot, i, pose, slot === 'mfcBot' ? this.mfcTop : 0);
        if (slot === 'car' && n >= 0) (this.meshes.get('car') as THREE.InstancedMesh).setColorAt(n, this.col.set(CAR_COLORS[a.id % CAR_COLORS.length] as string));
        continue;
      }
      // 人：身体 + 头
      const n = put('body', i, pose, 0);
      put('head', i, pose, 0);
      if (n >= 0) {
        const c = a.kind === 'shopper' ? (SHIRTS[a.id % SHIRTS.length] as string) : ONLINE.has(a.kind) ? '#2a78d6' : a.kind === 'robotTech' ? '#6250d6' : '#eb6834';
        (this.meshes.get('body') as THREE.InstancedMesh).setColorAt(n, this.col.set(c));
      }
    }
    for (const [slot, mesh] of this.meshes) {
      mesh.count = counts.get(slot) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // 实例在动：拾取时重新算包围球
      mesh.boundingSphere = null;
    }
  }

  /** 鼠标拾取：返回射线碰到的第一个人 / 机器人 / 车辆 */
  pick(ray: THREE.Raycaster): Picked | undefined {
    const hits = ray.intersectObjects([...this.meshes.values()].filter((m) => m.count > 0), false);
    for (const h of hits) {
      const mesh = h.object as THREE.InstancedMesh;
      if (h.instanceId === undefined) continue;
      const idx = (this.owners.get(mesh.name as Slot) as number[])[h.instanceId];
      if (idx === undefined) continue;
      const agent = this.agents[idx] as AgentTrace;
      const pose = this.poses[idx];
      return { agent, ...(pose?.act ? { act: pose.act } : {}) };
    }
    return undefined;
  }

  /** 当前时刻在场的、正在干活的数量（侧栏用） */
  count(pred: (a: AgentTrace, p: Pose) => boolean): number {
    let n = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const p = this.poses[i];
      if (p && pred(this.agents[i] as AgentTrace, p)) n++;
    }
    return n;
  }
}
