import '../split.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { WVehicle } from '../../../src/sim/trace';
import type { RoadNet } from './roadnet';
import type { Traffic } from './traffic';
import { Vehicles } from './vehicles';
import { t as tr } from '../i18n';

/**
 * 对比回放：三维画面分成左右两半，同一个世界、同一个时钟，左边是原来的车辆层，右边是另一组车
 * （现场 · 不用孪生、另一天……）。背景车流、港口、机场、铁路站、物流园和收货口的作业两边共用（按左边那一组排的，
 * 右边的标题下面写明）。
 *
 * 每一帧画两次：左半边只显示左边的车，右半边只显示右边的车（剪裁到各自的半边）。右边那次不再算阴影图
 * （用左边那次算好的），车辆在对比时不投影，免得一边的车在另一边留下影子。镜头默认联动（同一个镜头）；
 * 取消联动时右边有自己的镜头，在右半边拖动只转右边。右边每几帧画一次由画质的档位定（quality.ts；画布保留上一次的内容）。
 * 右半边也能悬停、点选（按右边的镜头和右边的车辆层拾取），车头标签、选中作业的停靠点标签画在右半边自己的标签层上。
 */
export interface SplitSide {
  list: WVehicle[];
  resolve: (vehicle: number, key: string) => string | undefined;
  shift?: { delays: (Float32Array | undefined)[]; ends: number[] };
  /** 和左边是同一天的计划（班列的箱、机场画的飞机可以共用；同一个下标是同一个作业） */
  sameDay: boolean;
}
export type SplitPair = 'loop' | 'loopOpen' | 'planField' | 'days';
export const PAIR_LABEL: Record<SplitPair, string> = { loop: tr('现场 · 用孪生 ↔ 不用孪生'), loopOpen: tr('现场 · 不用孪生 ↔ 用孪生'), planField: tr('计划 ↔ 现场 · 用孪生'), days: tr('这一天 ↔ 另一天') };

export interface SplitHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  host: HTMLElement;
  left: Vehicles;
  net: RoadNet;
  geos: ReadonlyMap<string, THREE.BufferGeometry> | undefined;
  /** 选中作业路线的线材质（右边自己选中的车也用它） */
  routeMat: LineMaterial;
  invalidate(): void;
  /** 对比条上换了对比的两边、另一天的编号 */
  onPair(pair: SplitPair, seed: number): void;
  /** 只属于左边的东西（左边选中作业的路线）：右边是另一天时右半边不画 */
  leftOnly(): readonly THREE.Object3D[];
  /** 取消联动时盖在右半边上的拖动区域：悬停、点选也要接到它上面 */
  bind(el: HTMLElement): void;
  /** 点了右边的车头标签 */
  pickTag(vehicle: number): void;
}

/** 车头标签离地多高：船、飞机、火车、公路车辆各不一样（远镜头时车放大，标签跟着抬高） */
export function tagHeight(layer: Vehicles, i: number, t: number, scale: number): number {
  const kind = layer.items[i]?.kind;
  return kind === 'ship' ? 46 : kind === 'plane' ? 22 + layer.altitudeOf(i, t) : kind === 'train' ? 9 * Math.min(2, Math.max(1, scale / 3)) : 6 * Math.min(7, scale);
}

const v2 = new THREE.Vector2();
const v3 = new THREE.Vector3();

export class SplitScreen {
  readonly right = new Vehicles();
  private linked = true;
  private cam2: THREE.PerspectiveCamera | undefined;
  private controls2: OrbitControls | undefined;
  private pad: HTMLElement | undefined;
  private readonly bar: HTMLElement;
  private readonly labelL: HTMLElement;
  private readonly labelR: HTMLElement;
  private readonly divider: HTMLElement;
  /** 右边每几帧画一次（画质的档位给的） */
  private every = 1;
  private tick = 0;
  /** 上一帧左右被面板挡住的宽度（拾取时按它设镜头） */
  private leftInset = 0;
  private rightInset = 0;
  /** 右半边自己的标签层：车头标签、停靠点标签（按右边的镜头放） */
  private readonly labels = new CSS2DRenderer();
  private readonly labelScene = new THREE.Scene();
  private readonly tagGroup = new THREE.Group();
  private readonly tags = new Map<number, CSS2DObject>();
  private readonly stopGroup = new THREE.Group();
  /** 只在右半边画的东西：右边自己选中的车的路线 */
  private readonly rightOnly = new THREE.Group();
  private routeLines: Line2[] = [];
  /** 右边的车上一次更新的时刻和放大比例（标签的高度按它） */
  private t = 0;
  private sc = 1;
  /** 对比时关掉投影的网格（退出时恢复） */
  private readonly shadowOff: THREE.Object3D[] = [];
  private pair: SplitPair;
  private seed: number;
  /** 右边和左边是不是同一天（不是同一天时飞机不画：机场按左边那天排） */
  private sameDay = true;

  constructor(
    private readonly h: SplitHost,
    side: SplitSide,
    pair: SplitPair,
    seed: number,
    traffic: Traffic | undefined,
  ) {
    this.pair = pair;
    this.seed = seed;
    this.right.group.name = 'vehicles-right';
    if (h.geos) this.right.useAssets(h.geos);
    if (traffic) this.right.setTraffic(traffic);
    h.scene.add(this.right.group);
    this.rightOnly.name = 'split-right-only';
    this.rightOnly.visible = false;
    h.scene.add(this.rightOnly);
    this.labels.domElement.className = 'view3d-labels split-labels';
    this.tagGroup.name = 'vehicle-tags-right';
    this.labelScene.add(this.tagGroup, this.stopGroup);
    // 对比条：比什么、另一天的编号、镜头联动
    this.bar = document.createElement('div');
    this.bar.className = 'split-bar';
    this.bar.innerHTML = `<span class="split-title">${tr('对比回放')}</span>
      <select class="split-pair" aria-label="${tr('对比的两边')}">${(Object.keys(PAIR_LABEL) as SplitPair[]).map((k) => `<option value="${k}">${PAIR_LABEL[k]}</option>`).join('')}</select>
      <label class="split-seed" title="${tr('另一天用哪一组需求、船期和路况')}">${tr('第')} <input type="number" min="1" max="9999" value="${seed}"> ${tr('组')}</label>
      <label class="split-link"><input type="checkbox" checked> ${tr('镜头联动')}</label>`;
    const sel = this.bar.querySelector('select') as HTMLSelectElement;
    const seedIn = this.bar.querySelector('.split-seed input') as HTMLInputElement;
    sel.value = pair;
    const fire = () => h.onPair(sel.value as SplitPair, Math.max(1, Math.min(9999, Math.round(Number(seedIn.value) || 1))));
    sel.onchange = fire;
    seedIn.onchange = fire;
    (this.bar.querySelector('.split-link input') as HTMLInputElement).onchange = (e) => this.setLinked((e.target as HTMLInputElement).checked);
    this.labelL = document.createElement('div');
    this.labelL.className = 'split-label left';
    this.labelR = document.createElement('div');
    this.labelR.className = 'split-label right';
    this.divider = document.createElement('div');
    this.divider.className = 'split-divider';
    h.host.append(this.divider, this.labels.domElement, this.labelL, this.labelR, this.bar);
    this.setSide(side);
    // 对比时车辆不投影（右边那次用左边算好的阴影图，别的车的影子会留在另一边）
    for (const g of [h.left.group, this.right.group])
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.castShadow) {
          o.castShadow = false;
          this.shadowOff.push(o);
        }
      });
    this.resize();
  }

  /** 换右边的车（和对比条显示的两边）；右边的标签、选中先清掉（等调用方按新的一组重新给） */
  setSide(side: SplitSide, pair?: SplitPair, seed?: number): void {
    if (pair) this.pair = pair;
    if (seed !== undefined) this.seed = seed;
    this.right.setVehicles(side.list, { net: this.h.net, resolve: side.resolve });
    this.right.setTimeShift(side.shift);
    // 同一天：飞机由机场作业画（左右一样），班列的箱跟着铁路站；另一天：飞机也不画（机场按左边那天排的），箱按标签
    this.sameDay = side.sameDay;
    this.right.planePose = side.sameDay ? this.h.left.planePose : undefined;
    this.right.cargo = side.sameDay ? this.h.left.cargo : undefined;
    this.right.trainBoxColor = side.sameDay ? this.h.left.trainBoxColor : undefined;
    this.setTags([]);
    this.select(undefined, [], false);
    this.syncBar();
    this.h.invalidate();
  }

  /** 右边和左边是同一天（同一个下标是同一个作业：左边选中的作业右边也选中） */
  get sameDayPair(): boolean {
    return this.sameDay;
  }

  private syncBar(): void {
    (this.bar.querySelector('select') as HTMLSelectElement).value = this.pair;
    (this.bar.querySelector('.split-seed') as HTMLElement).hidden = this.pair !== 'days';
    (this.bar.querySelector('.split-seed input') as HTMLInputElement).value = String(this.seed);
  }

  setTraffic(tr: Traffic): void {
    this.right.setTraffic(tr);
    this.h.invalidate();
  }

  /** 右边每几帧画一次（画质的档位：高 1、中 2、低 3） */
  setEvery(n: number): void {
    this.every = Math.max(1, Math.round(n));
  }

  /**
   * 两边的标题和此刻的指标；右边下面写一句哪些作业是按左边那一组画的
   * （港口、机场、物流园、收货口的作业只有一份：同一天时差的是车的时刻，另一天时整天都按左边）。
   */
  setLabels(left: { title: string; kpi: string }, right: { title: string; kpi: string }): void {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = (x: { title: string; kpi: string }) => `<b>${esc(x.title)}</b><span>${esc(x.kpi)}</span>`;
    const note = this.sameDay ? tr('月台门、收货口的作业按左边的车画') : tr('港口、机场、物流园、收货口的作业按左边那一天画');
    this.labelL.innerHTML = html(left);
    this.labelR.innerHTML = `${html(right)}<small class="split-note">${note}</small>`;
  }

  /** 右边的车头标签（和左边一样：编号 → 下一站 预计到达，或者在做什么）；点一下等于在右半边点这辆车 */
  setTags(list: { i: number; text: string; cls: string }[]): void {
    const keep = new Set<number>();
    for (const tg of list) {
      keep.add(tg.i);
      let o = this.tags.get(tg.i);
      if (!o) {
        const div = document.createElement('div');
        div.addEventListener('click', () => this.h.pickTag(tg.i));
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
    this.h.invalidate();
  }

  /** 标签层的开关（和左边的「标签」「车辆编号」按钮一样） */
  setVisible(labels: boolean, tags: boolean): void {
    this.stopGroup.visible = labels;
    this.tagGroup.visible = tags;
    this.h.invalidate();
  }

  private placeTags(): void {
    for (const [i, o] of this.tags) {
      const p = this.right.poseOf(i);
      o.visible = !!p;
      if (p) o.position.set(p.x, tagHeight(this.right, i, this.t, this.sc), p.y);
    }
  }

  /**
   * 右边选中的车：脚下的光圈、停靠点标签。own：右边自己选的（另一天的车，路线也只画在右半边）；
   * 否则是跟着左边选中的同一个作业（同一天，路线两边共用左边画的那一条）。
   */
  select(id: number | undefined, marks: readonly { text: string; pos: THREE.Vector3 }[], own: boolean): void {
    this.right.selected = id === undefined ? [] : [id];
    for (const o of [...this.stopGroup.children] as CSS2DObject[]) {
      this.stopGroup.remove(o);
      o.element.remove();
    }
    for (const l of this.routeLines) {
      this.rightOnly.remove(l);
      l.geometry.dispose();
    }
    this.routeLines = [];
    if (id !== undefined && own)
      for (const part of this.right.routeOf(id)) {
        if (part.length < 2) continue;
        const g = new LineGeometry();
        g.setPositions(part.flatMap((p) => [p.x, p.y + 1.2, p.z]));
        const line = new Line2(g, this.h.routeMat);
        line.computeLineDistances();
        line.renderOrder = 3;
        this.rightOnly.add(line);
        this.routeLines.push(line);
      }
    for (const m of marks) {
      const div = document.createElement('div');
      div.className = 'lbl3d lbl-stop';
      div.textContent = m.text;
      const o = new CSS2DObject(div);
      o.position.copy(m.pos);
      this.stopGroup.add(o);
    }
    this.h.invalidate();
  }

  /** 镜头联动：联动时右边用同一个镜头；取消时右边有自己的镜头（从此刻的位置开始），在右半边拖动只转右边 */
  setLinked(on: boolean): void {
    this.linked = on;
    if (on) {
      this.controls2?.dispose();
      this.controls2 = undefined;
      this.cam2 = undefined;
      this.pad?.remove();
      this.pad = undefined;
    } else {
      const c = this.h.camera;
      this.cam2 = new THREE.PerspectiveCamera(c.fov, c.aspect, c.near, c.far);
      this.cam2.position.copy(c.position);
      this.cam2.quaternion.copy(c.quaternion);
      this.pad = document.createElement('div');
      this.pad.className = 'split-pad';
      this.h.host.append(this.pad);
      this.h.bind(this.pad);
      this.controls2 = new OrbitControls(this.cam2, this.pad);
      this.controls2.target.copy(this.h.controls.target);
      Object.assign(this.controls2, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: this.h.controls.maxPolarAngle, minDistance: this.h.controls.minDistance, maxDistance: this.h.controls.maxDistance, screenSpacePanning: false });
      this.controls2.addEventListener('change', () => this.h.invalidate());
      this.controls2.update();
    }
    this.resize();
    this.h.invalidate();
  }

  /** 取消联动时跟随右边的一辆车（右边的镜头跟着走）；联动时返回 false（主镜头跟随，两边一起动） */
  followTo(x: number, z: number): boolean {
    if (!this.cam2 || !this.controls2) return false;
    const d = v3.set(x, 0, z).sub(this.controls2.target).multiplyScalar(0.15);
    this.controls2.target.add(d);
    this.cam2.position.add(d);
    return true;
  }

  /** 右边的车（镜头联动时和左边同样的放大比例；取消联动按右边镜头的远近） */
  update(t: number, scale: number): void {
    this.controls2?.update();
    const left = this.h.left;
    // 图例的开关（种类、背景车流）两边一样
    this.right.traffic = left.traffic;
    this.right.hidden = new Set([...left.hidden, ...(this.sameDay ? [] : ['plane'])]);
    const sc = this.cam2 && this.controls2 ? Math.max(1, this.cam2.position.distanceTo(this.controls2.target) / 330) : scale;
    this.right.update(t, sc);
    this.t = t;
    this.sc = sc;
    this.placeTags();
  }

  /** 右边取消联动时镜头在动：每一帧都要重画右边的车 */
  get moving(): boolean {
    return !!this.controls2;
  }

  private setCam(c: THREE.PerspectiveCamera, w: number, h: number, shift: number): void {
    c.aspect = w / h;
    if (Math.abs(shift) > 0.5) c.setViewOffset(w, h, shift, 0, w, h);
    else c.clearViewOffset();
    c.updateProjectionMatrix();
  }

  /** 画两半；inset：左右被面板挡住的宽度（画面中心各自挪开） */
  render(leftInset: number, rightInset: number): void {
    const { renderer, scene, camera } = this.h;
    this.leftInset = leftInset;
    this.rightInset = rightInset;
    renderer.getSize(v2);
    const W = v2.x;
    const H = v2.y;
    const half = Math.floor(W / 2);
    renderer.setScissorTest(true);
    // 左边：算阴影图（车辆这时不投影，阴影图里只有世界和设施，两边通用）
    this.setCam(camera, half, H, -leftInset / 2);
    this.h.left.group.visible = true;
    this.right.group.visible = false;
    this.rightOnly.visible = false;
    renderer.setViewport(0, 0, half, H);
    renderer.setScissor(0, 0, half, H);
    renderer.render(scene, camera);
    // 右边：用左边算好的阴影图；按画质的档位隔几帧画一次（画布保留着上一次的右半边，标签也留在上一次的位置）
    if (this.tick++ % this.every === 0) {
      const c2 = this.cam2 ?? camera;
      this.setCam(c2, W - half, H, rightInset / 2);
      this.h.left.group.visible = false;
      this.right.group.visible = true;
      this.rightOnly.visible = true;
      const hide = this.sameDay ? [] : this.h.leftOnly().filter((o) => o.visible);
      for (const o of hide) o.visible = false;
      renderer.setViewport(half, 0, W - half, H);
      renderer.setScissor(half, 0, W - half, H);
      const auto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.render(scene, c2);
      renderer.shadowMap.autoUpdate = auto;
      this.labels.render(this.labelScene, c2);
      for (const o of hide) o.visible = true;
      // 镜头留在左边的设置：拾取、标签、监控画面按它
      if (c2 === camera) this.setCam(camera, half, H, -leftInset / 2);
      this.h.left.group.visible = true;
      this.right.group.visible = false;
      this.rightOnly.visible = false;
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
  }

  /** 右半边一点（相对画面左上角的像素）的拾取射线：按右边的镜头（联动时临时换成右半边的投影，算完换回左边的） */
  rayAt(x: number, y: number, ray: THREE.Raycaster): void {
    const W = this.h.host.clientWidth;
    const H = this.h.host.clientHeight;
    const half = Math.floor(W / 2);
    const c2 = this.cam2 ?? this.h.camera;
    this.setCam(c2, W - half, H, this.rightInset / 2);
    v2.set(((x - half) / Math.max(1, W - half)) * 2 - 1, -(y / H) * 2 + 1);
    ray.setFromCamera(v2, c2);
    if (c2 === this.h.camera) this.setCam(c2, half, H, -this.leftInset / 2);
  }

  /** 画面大小变了：左边的标签层只盖左半边，右边的标签层盖右半边；分隔线和右边的拖动区域跟着摆 */
  resize(): void {
    const w = this.h.host.clientWidth;
    const hh = this.h.host.clientHeight;
    const half = Math.floor(w / 2);
    this.divider.style.left = `${half}px`;
    this.labels.setSize(w - half, hh);
    this.labels.domElement.style.left = `${half}px`;
    if (this.pad) Object.assign(this.pad.style, { left: `${half}px`, width: `${w - half}px` });
  }

  /** 这一点在左半边（按左边的镜头和车辆层拾取）；在右半边返回 false */
  pickable(x: number): boolean {
    return x < Math.floor(this.h.host.clientWidth / 2);
  }

  dispose(): void {
    this.h.scene.remove(this.right.group, this.rightOnly);
    // 右边车辆层自己的几何体、材质和实例数据（Blender 的车辆零件两边共用，不释放）
    this.right.group.traverse((o) => {
      const m = o as THREE.Mesh & { isPoints?: boolean };
      if (!m.isMesh && !m.isPoints) return;
      if (m.geometry && !this.h.geos?.has(m.name)) m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat?.dispose();
      (m as unknown as { dispose?: () => void }).dispose?.();
    });
    for (const l of this.routeLines) l.geometry.dispose();
    for (const o of this.shadowOff) o.castShadow = true;
    this.h.left.group.visible = true;
    this.controls2?.dispose();
    for (const el of [this.bar, this.labelL, this.labelR, this.divider, this.pad, this.labels.domElement]) el?.remove();
  }
}
