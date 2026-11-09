import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AgentTrace } from '../../../src/ops/trace';
import type { Layout } from '../../../src/world/layout';
import { Agents3D, type Picked } from './agents3d';
import { buildStoreModel, setExteriorMode, type StoreModel } from './storeModel';

/**
 * 门店的三维孪生视图：和二维俯视图回放同一份轨迹、同一个时刻。
 * 场景全部由代码生成；可以导出 glTF（用 Blender 等软件打开继续加工）。
 */
export type Preset = 'overview' | 'mfc' | 'hub' | 'floor' | 'checkout' | 'staging';
export const PRESET_LABELS: Record<Preset, string> = { overview: '全景', mfc: '货格仓', hub: '自提中心', staging: '暂存间', floor: '卖场', checkout: '出口' };

/** 相机目标点（布局坐标 x、z）和相机相对目标的偏移 */
const PRESETS: Record<Preset, { target: [number, number, number]; offset: [number, number, number] }> = {
  overview: { target: [42, 0, 34], offset: [48, 62, 74] },
  mfc: { target: [40, 3, 12], offset: [16, 22, 28] },
  hub: { target: [9, 1, 32], offset: [26, 20, 16] },
  staging: { target: [12, 1, 24], offset: [22, 18, 16] },
  floor: { target: [40, 1, 36], offset: [20, 16, 20] },
  checkout: { target: [39, 1, 50], offset: [16, 12, 18] },
};

export class StoreView3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private labels: CSS2DRenderer;
  private model: StoreModel | undefined;
  private labelGroup = new THREE.Group();
  readonly agents = new Agents3D();
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private t = 0;
  private timeDirty = true;
  private running = false;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number; dur: number } | undefined;
  private mode: 'cutaway' | 'exterior' = 'cutaway';
  /** 鼠标停在人 / 机器人 / 车辆上时回调 */
  onHover: ((p: (Picked & { x: number; y: number }) | undefined) => void) | undefined;
  showLabels = true;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

    this.scene.background = new THREE.Color('#dde7ef');
    this.scene.fog = new THREE.Fog('#dde7ef', 220, 650);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.3, 2500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 420;
    this.controls.screenSpacePanning = false;

    // 天光 + 太阳（投影覆盖整个门店）
    this.scene.add(new THREE.HemisphereLight('#e4efff', '#b7a588', 1.15));
    const sun = new THREE.DirectionalLight('#fff3e0', 2.1);
    sun.position.set(42 + 45, 85, 34 + 35);
    sun.target.position.set(42, 0, 34);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -60;
    sc.right = 60;
    sc.top = 60;
    sc.bottom = -60;
    sc.near = 10;
    sc.far = 260;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    // 周边的草地
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#94b07a', roughness: 1 }));
    grass.position.set(42, -0.03, 35);
    grass.receiveShadow = true;
    this.scene.add(grass);
    this.scene.add(this.agents.group, this.labelGroup);

    this.renderer.domElement.addEventListener('pointermove', (e) => this.hover(e));
    this.renderer.domElement.addEventListener('pointerleave', () => this.onHover?.(undefined));
    new ResizeObserver(() => this.resize()).observe(host);
    this.focus('overview', false);
  }

  setLayout(layout: Layout): void {
    if (this.model) {
      this.scene.remove(this.model.group);
      this.model.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
    }
    this.model = buildStoreModel(layout);
    this.scene.add(this.model.group);
    setExteriorMode(this.model, this.mode);
    this.agents.mfcTop = this.model.mfcTop || 4.6;
    // 标签
    for (const c of [...this.labelGroup.children]) {
      this.labelGroup.remove(c);
      (c as CSS2DObject).element.remove();
    }
    for (const l of this.model.labels) {
      const div = document.createElement('div');
      div.className = `lbl3d ${l.kind}`;
      div.textContent = l.text;
      const o = new CSS2DObject(div);
      o.position.set(l.x, l.y, l.z);
      this.labelGroup.add(o);
    }
    this.labelGroup.visible = this.showLabels;
    this.timeDirty = true;
  }

  setAgents(agents: AgentTrace[]): void {
    this.agents.setAgents(agents);
    this.timeDirty = true;
  }

  setTime(t: number): void {
    if (t !== this.t) {
      this.t = t;
      this.timeDirty = true;
    }
  }

  /** 显示的类别变了：下一帧重画人和机器人 */
  invalidate(): void {
    this.timeDirty = true;
  }

  setMode(mode: 'cutaway' | 'exterior'): void {
    this.mode = mode;
    if (this.model) setExteriorMode(this.model, mode);
  }

  setLabels(on: boolean): void {
    this.showLabels = on;
    this.labelGroup.visible = on;
  }

  /** 相机飞到某个视角 */
  focus(p: Preset, animate = true): void {
    const spec = PRESETS[p];
    const to = new THREE.Vector3(spec.target[0] + spec.offset[0], spec.target[1] + spec.offset[1], spec.target[2] + spec.offset[2]);
    const tTo = new THREE.Vector3(...spec.target);
    if (!animate) {
      this.camera.position.copy(to);
      this.controls.target.copy(tTo);
      this.controls.update();
      return;
    }
    this.tween = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo, start: performance.now(), dur: 900 };
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

  /** 画一帧（播放器每帧调用 setTime，这里按需更新人和机器人） */
  frame(): void {
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.start) / this.tween.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, e);
      this.controls.target.lerpVectors(this.tween.tFrom, this.tween.tTo, e);
      if (k >= 1) this.tween = undefined;
    }
    this.controls.update();
    if (this.timeDirty) {
      this.agents.update(this.t);
      this.timeDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
    if (this.showLabels) this.labels.render(this.scene, this.camera);
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private hover(e: PointerEvent): void {
    if (!this.onHover) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    const p = this.agents.pick(this.ray);
    this.onHover(p ? { ...p, x: e.clientX - r.left, y: e.clientY - r.top } : undefined);
  }

  /** 导出当前门店和此刻的人、机器人为 glTF 二进制（.glb） */
  async exportGlb(): Promise<Blob> {
    const exporter = new GLTFExporter();
    const root = new THREE.Group();
    if (this.model) root.add(this.model.group.clone(true));
    // 实例化的人和机器人在导出时展开成普通网格
    const agents = this.agents.group.clone(true);
    root.add(agents);
    const data = (await exporter.parseAsync(root, { binary: true, onlyVisible: true })) as ArrayBuffer;
    return new Blob([data], { type: 'model/gltf-binary' });
  }
}
