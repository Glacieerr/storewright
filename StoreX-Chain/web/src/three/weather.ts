import * as THREE from 'three';
import { t as tr } from '../i18n';

/**
 * 天气：只改三维画面（天空、雾、雨、路面湿不湿、海面的浪、光线），不影响仿真。
 *
 * - 自动：按当天的编号排一天的天气，每小时一个状态（晴、多云、午后阵雨、清早海雾、阴雨），之间平滑过渡；
 *   演练里的「机场关闭」（风暴）整天是台风天，「需求突增」（风暴预警引发抢购）傍晚开始转大雨、起风。
 * - 手动：晴 / 多云 / 雨 / 雾 / 台风。
 * - 画面：天空的颜色、雾的浓淡（能见度）；雨丝跟着镜头（一条线段一滴雨，位置在着色器里按时间算，不占 CPU），监控画面里也有；
 *   下过雨路面、机场道面和铺装地面变暗、发亮，雨停以后几个小时慢慢干；风大时雨丝斜、海面起浪（海面的法线按时间扰动）；
 *   台风天播放时偶尔打闪（暂停时不打）。
 * - weatherFactor：天气对路上车速的影响（晴 1、雨约 0.85、雾约 0.75、台风 0.6），给社会车流以后接。
 */
export type WeatherMode = 'auto' | 'clear' | 'cloudy' | 'rain' | 'fog' | 'storm';
export const WEATHER_MODES: WeatherMode[] = ['auto', 'clear', 'cloudy', 'rain', 'fog', 'storm'];
export const WEATHER_LABEL: Record<WeatherMode, string> = { auto: tr('自动'), clear: tr('晴'), cloudy: tr('多云'), rain: tr('雨'), fog: tr('雾'), storm: tr('台风') };

/** 某个时刻的天气：雨、雾、云量、风都是 0–1；wet 是地面湿的程度 */
export interface WeatherState {
  rain: number;
  fog: number;
  cloud: number;
  wind: number;
  wet: number;
}

const CLEAR: WeatherState = { rain: 0, fog: 0, cloud: 0.15, wind: 0.1, wet: 0 };
const MANUAL: Record<Exclude<WeatherMode, 'auto'>, WeatherState> = {
  clear: CLEAR,
  cloudy: { rain: 0, fog: 0.05, cloud: 0.78, wind: 0.2, wet: 0 },
  rain: { rain: 0.7, fog: 0.15, cloud: 0.92, wind: 0.3, wet: 1 },
  fog: { rain: 0, fog: 0.9, cloud: 0.6, wind: 0.05, wet: 0.35 },
  storm: { rain: 1, fog: 0.35, cloud: 1, wind: 1, wet: 1 },
};

/**
 * 0–1 的确定性随机数（同一个编号每次一样）。编号先充分打散（murmur3 的收尾混合）再做种子：
 * 相邻的编号直接做种子时，头一个数挤在一起，连着好几天抽到同一种天气。
 */
function rng(seed: number): () => number {
  let a = (seed | 0) ^ 0x5bd1e995;
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  a = (a ^ (a >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 自动天气里一天的类型 */
export type DayKind = 'clear' | 'cloudy' | 'shower' | 'fog' | 'drizzle';
export const DAY_KIND_LABEL: Record<DayKind, string> = { clear: tr('晴'), cloudy: tr('多云'), shower: tr('午后阵雨'), fog: tr('清早大雾'), drizzle: tr('阴雨') };
/** 每 10 天一轮：4 天晴、2 天多云、2 天午后阵雨、1 天清早大雾、1 天阴雨 */
const ROUND: readonly DayKind[] = ['clear', 'clear', 'clear', 'clear', 'cloudy', 'cloudy', 'shower', 'shower', 'fog', 'drizzle'];
const varied = (a: readonly DayKind[]) => a.every((k, i) => i === 0 || k !== a[i - 1]);
function shuffle(a: DayKind[], r: () => number): DayKind[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as DayKind, a[i] as DayKind];
  }
  return a;
}

/** 第 b 轮（编号 10b+1 到 10b+10）的顺序：按轮的编号打乱，相邻两天不一样；第一轮的头一天（默认的那一天）是晴天 */
function roundOrder(b: number): DayKind[] {
  const r = rng(0x3c6ef372 ^ b);
  for (let tries = 0; tries < 2000; tries++) {
    const a = shuffle([...ROUND], r);
    if (varied(a) && (b > 0 || a[0] === 'clear')) return a;
  }
  return ['clear', 'cloudy', 'clear', 'shower', 'clear', 'fog', 'cloudy', 'clear', 'shower', 'drizzle'];
}

/**
 * 一天的天气类型。编号是一组组独立的样本日子（不是日历上连着的天），所以按轮排：每 10 个编号里各种天气的天数固定，
 * 顺序打乱，相邻的两个编号天气类型不一样（轮和轮接上的地方也不一样）；默认的那一天（编号 1）是晴天。
 */
export function dayKind(seed: number): DayKind {
  const s = Math.max(1, Math.floor(seed));
  const b = Math.floor((s - 1) / 10);
  const a = roundOrder(b);
  // 这一轮的头一天和上一轮的最后一天一样：前 9 天重新打乱，直到不重样；最后一天不动（下一轮按它接），所以不用往前一轮轮地追
  const last = b > 0 ? roundOrder(b - 1)[9] : undefined;
  if (last !== undefined && a[0] === last) {
    const r = rng(0x7f4a7c15 ^ b);
    for (let tries = 0; tries < 2000; tries++) {
      const c = [...shuffle(a.slice(0, 9), r), a[9] as DayKind];
      if (varied(c) && c[0] !== last) return c[(s - 1) % 10] as DayKind;
    }
  }
  return a[(s - 1) % 10] as DayKind;
}

/** 一天每个整点的天气（0–24 点，25 个）：按编号定天气类型（dayKind），再按钟点安排雨、雾、云 */
export function daySchedule(seed: number, drill?: string): WeatherState[] {
  const r = rng(seed);
  // 第一个数抽了类型（dayKind），往后的数排钟点
  r();
  const hours = Array.from({ length: 25 }, () => ({ ...CLEAR }));
  const bump = (h0: number, h1: number, f: (h: number, k: number) => void) => {
    for (let h = Math.max(0, Math.floor(h0)); h <= Math.min(24, Math.ceil(h1)); h++) f(h, (h - h0) / Math.max(1e-6, h1 - h0));
  };
  const bell = (k: number) => Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, k))));
  if (drill === 'airportClosed') {
    // 风暴：整天台风天，午后最猛
    bump(0, 24, (h) => Object.assign(hours[h] as WeatherState, { rain: 0.8 + 0.2 * Math.sin((Math.PI * h) / 24), fog: 0.35, cloud: 1, wind: 0.85 + 0.15 * Math.sin((Math.PI * h) / 24) }));
  } else if (drill === 'demandSurge') {
    // 风暴预警：白天转阴，傍晚起风下雨，夜里越来越大
    bump(0, 24, (h) => Object.assign(hours[h] as WeatherState, { cloud: Math.min(1, 0.45 + h / 30), wind: Math.min(1, 0.2 + Math.max(0, h - 15) / 9) }));
    bump(17, 24, (h, k) => Object.assign(hours[h] as WeatherState, { rain: Math.min(1, 0.2 + k * 0.8), fog: 0.1 + 0.2 * k }));
  } else {
    const kind = dayKind(seed);
    // 默认的那一天：晴，几朵薄云（固定，不随随机数变）
    const cloudBase = seed === 1 ? 0.28 : 0.1 + r() * 0.2;
    bump(0, 24, (h) => ((hours[h] as WeatherState).cloud = cloudBase));
    // 海边城市：差不多一半的日子清早有一点海雾（默认的那一天没有）
    if (r() < 0.45 && seed !== 1) bump(4, 9, (h, k) => ((hours[h] as WeatherState).fog = Math.max((hours[h] as WeatherState).fog, 0.35 * bell(k))));
    if (kind === 'clear') {
      /* 晴 */
    } else if (kind === 'cloudy') {
      const c = 0.6 + r() * 0.25;
      bump(0, 24, (h) => ((hours[h] as WeatherState).cloud = c));
    } else if (kind === 'shower') {
      // 午后阵雨：云从上午开始积，13–18 点之间下三个钟头
      const start = 13 + Math.floor(r() * 3);
      const peak = 0.55 + r() * 0.4;
      bump(10, 20, (h, k) => ((hours[h] as WeatherState).cloud = Math.max((hours[h] as WeatherState).cloud, 0.85 * bell(k * 0.9 + 0.05))));
      bump(start, start + 3, (h, k) => Object.assign(hours[h] as WeatherState, { rain: peak * bell(k), wind: 0.2 + 0.3 * bell(k) }));
    } else if (kind === 'fog') {
      // 清早大雾，9–10 点散
      bump(3, 10, (h, k) => ((hours[h] as WeatherState).fog = Math.max((hours[h] as WeatherState).fog, 0.9 * (k < 0.7 ? 1 : (1 - k) / 0.3))));
    } else {
      // 阴雨天：时大时小
      bump(0, 24, (h) => Object.assign(hours[h] as WeatherState, { cloud: 0.92, rain: 0.25 + 0.45 * r(), fog: 0.15, wind: 0.25 }));
    }
  }
  // 地面：下雨就湿，雨停以后每小时干掉一部分
  let wet = 0;
  for (const s of hours) {
    wet = Math.max(s.rain > 0.12 ? Math.min(1, s.rain * 1.6) : 0, wet * 0.62);
    s.wet = wet;
  }
  return hours;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
// 天空（也是雾的颜色）：晴天白天、阴、雾、雨、台风，夜里晴、夜里阴雨
const SKY = { day: new THREE.Color('#dce7f0'), cloud: new THREE.Color('#c3cbd3'), fog: new THREE.Color('#d3d7da'), rain: new THREE.Color('#99a3ad'), storm: new THREE.Color('#6c7680'), night: new THREE.Color('#223049'), nightWet: new THREE.Color('#141a24') };
const smooth = (k: number) => k * k * (3 - 2 * k);

/** 天气的名字和能见度（真实公里） */
export function describe(s: WeatherState): { name: string; visKm: number } {
  const visKm = 20 / (1 + 30 * s.fog * s.fog + 4 * s.rain + 2 * s.wind * s.rain);
  const name =
    s.wind > 0.7 && s.rain > 0.6
      ? tr('台风')
      : s.rain > 0.75
        ? tr('大雨')
        : s.rain > 0.45
          ? tr('中雨')
          : s.rain > 0.12
            ? tr('小雨')
            : s.fog > 0.6
              ? tr('大雾')
              : s.fog > 0.28
                ? tr('轻雾')
                : s.cloud > 0.85
                  ? tr('阴')
                  : s.cloud > 0.5
                    ? tr('多云')
                    : tr('晴');
  return { name, visKm };
}

/** 对路上车速的影响（社会车流以后按它减速） */
export function speedFactor(s: WeatherState): number {
  let f = Math.min(1 - 0.2 * s.rain, 1 - 0.28 * s.fog);
  if (s.wind > 0.7 && s.rain > 0.6) f = Math.min(f, 0.6);
  return Math.max(0.5, f);
}

// 渲染器用的是对数深度缓冲：雨的着色器也要按对数写深度，不然和场景比深度时全被挡住
const RAIN_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uFwd;
uniform vec3 uBox;
uniform float uSpeed;
uniform vec2 uWind;
uniform float uLen;
uniform vec2 uRes;
uniform float uPx;
attribute float aEnd;
attribute float aSide;
varying float vA;
void main() {
  vec3 p = position;
  float speed = uSpeed * (0.8 + 0.4 * fract(p.x * 37.13 + p.z * 17.71));
  // 雨的范围放在镜头看的方向上、镜头前面一点（镜头往下看时雨也在画面里）；水平方向按世界坐标循环（镜头动的时候雨不跟着漂），竖直方向往下落
  vec3 c = uCam + uFwd * uBox.x * 0.55;
  float x = (fract((p.x * uBox.x - c.x) / uBox.x) - 0.5) * uBox.x + c.x;
  float z = (fract((p.z * uBox.z - c.z) / uBox.z) - 0.5) * uBox.z + c.z;
  float y01 = fract(p.y - uTime * speed / uBox.y);
  vec3 top = vec3(x, (y01 - 0.5) * uBox.y + c.y, z);
  top.xz += uWind * (y01 - 0.5) * uBox.y * 0.35;
  vec3 bot = top + normalize(vec3(uWind.x, -1.0, uWind.y)) * uLen;
  vec4 ca = projectionMatrix * viewMatrix * vec4(top, 1.0);
  vec4 cb = projectionMatrix * viewMatrix * vec4(bot, 1.0);
  vA = 1.0 - 0.75 * aEnd;
  if (ca.w < 0.5 || cb.w < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // 屏幕上的方向，横着撑开 uPx 个像素
  vec2 sa = ca.xy / ca.w * uRes;
  vec2 sb = cb.xy / cb.w * uRes;
  vec2 d = sb - sa;
  float L = length(d);
  vec2 n = L > 1e-4 ? vec2(-d.y, d.x) / L : vec2(1.0, 0.0);
  vec4 cc = aEnd < 0.5 ? ca : cb;
  cc.xy += n * aSide * uPx / uRes * cc.w;
  gl_Position = cc;
  #include <logdepthbuf_vertex>
}`;
const RAIN_FS = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, uOpacity * vA);
}`;

interface WetMat {
  mat: THREE.MeshStandardMaterial;
  color: THREE.Color;
  roughness: number;
  metalness: number;
  /** 湿了以后多暗（颜色乘的系数）、多光滑 */
  dark: number;
  rough: number;
}

// 积水（只加在路面、停车场、港区和物流园的硬化地面、机场道面上）：按位置的噪声找出一块块地方，
// 朝上的面上更暗、更光滑，斜着看时映出天的颜色；雨停以后跟着地面一起干
const PUDDLE_FS = /* glsl */ `
uniform float uWet;
uniform vec3 uWetSky;
varying vec3 vWetW;
float wetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wetNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wetHash(i), wetHash(i + vec2(1.0, 0.0)), f.x), mix(wetHash(i + vec2(0.0, 1.0)), wetHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;
const PUDDLE_MASK = /* glsl */ `
  float wetPuddle = 0.0;
  if (uWet > 0.01) {
    vec3 wn = normalize(cross(dFdx(vWetW), dFdy(vWetW)));
    float wn0 = wetNoise(vWetW.xz * 0.11) * 0.65 + wetNoise(vWetW.xz * 0.37 + 17.0) * 0.35;
    wetPuddle = smoothstep(0.6, 0.72, wn0) * smoothstep(0.9, 0.98, abs(wn.y)) * uWet;
    roughnessFactor = mix(roughnessFactor, 0.06, wetPuddle);
    diffuseColor.rgb *= 1.0 - 0.3 * wetPuddle;
  }`;
const PUDDLE_SKY = /* glsl */ `
  totalEmissiveRadiance += uWetSky * (0.3 * wetPuddle * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0));`;

export class Weather {
  readonly group = new THREE.Group();
  mode: WeatherMode = 'auto';
  private seed = 1;
  private drill: string | undefined;
  private schedule: WeatherState[] = daySchedule(1);
  private readonly rain: THREE.Mesh;
  private readonly rainMat: THREE.ShaderMaterial;
  private readonly maxDrops: number;
  private budget: number;
  private wet: WetMat[] = [];
  private lastWet = -1;
  private readonly wetUniforms = { uWet: { value: 0 }, uWetSky: { value: new THREE.Color() } };
  private readonly puddled = new WeakSet<THREE.Material>();
  private seaShader: { uniforms: Record<string, THREE.IUniform> } | undefined;
  private readonly seaUniforms = { uTime: { value: 0 }, uChop: { value: 0.08 } };
  private flashUntil = 0;
  private nextFlash = 0;
  /** 这一帧主画面画几滴雨、主画面多少像素（监控画面小，按面积少画几滴，密度和主画面差不多） */
  private drops = 0;
  private mainArea = 1;
  private state: WeatherState = CLEAR;
  private readonly dayCol = new THREE.Color();
  private readonly nightCol = new THREE.Color();

  constructor(maxDrops = 12000) {
    this.maxDrops = maxDrops;
    this.budget = maxDrops;
    // 一滴雨四个顶点（上、下两头各两个，左右撑开成细长条），两个三角形
    const r = rng(20261101);
    const pos = new Float32Array(maxDrops * 4 * 3);
    const end = new Float32Array(maxDrops * 4);
    const side = new Float32Array(maxDrops * 4);
    const index = new Uint32Array(maxDrops * 6);
    for (let i = 0; i < maxDrops; i++) {
      const x = r();
      const y = r();
      const z = r();
      for (let k = 0; k < 4; k++) {
        pos.set([x, y, z], (i * 4 + k) * 3);
        end[i * 4 + k] = k < 2 ? 0 : 1;
        side[i * 4 + k] = k % 2 ? 1 : -1;
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VS,
      fragmentShader: RAIN_FS,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3(1, 0, 0) }, uBox: { value: new THREE.Vector3(160, 120, 160) }, uSpeed: { value: 110 }, uWind: { value: new THREE.Vector2() }, uLen: { value: 4 }, uRes: { value: new THREE.Vector2(800, 450) }, uPx: { value: 1 }, uColor: { value: new THREE.Color('#d4dee8') }, uOpacity: { value: 0.35 } },
      transparent: true,
      depthWrite: false,
      fog: false,
      // 四边形在屏幕上撑开的方向决定了它的正反面：两面都画
      side: THREE.DoubleSide,
    });
    this.rain = new THREE.Mesh(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 5;
    this.rain.name = 'rain';
    this.rain.visible = false;
    // 雨的范围按正在画的镜头摆（对比回放没联动时右半边是另一个镜头）
    this.rain.onBeforeRender = (_r, _s, cam) => {
      const u = this.rainMat.uniforms;
      cam.getWorldPosition((u.uCam as THREE.IUniform).value);
      cam.getWorldDirection((u.uFwd as THREE.IUniform).value);
    };
    this.group.add(this.rain);
    this.group.name = 'weather';
  }

  /**
   * 找出要「湿」的材质：道路（含人行道、标线）、停车场、港区的硬化地面和堆场、物流园；草地、城区、海滩也暗一点。
   * 海面的材质加一段浪的着色器（法线按时间和位置扰动，风越大浪越大）。
   */
  attach(world: THREE.Object3D, roads: THREE.Object3D, parking: THREE.Object3D): void {
    const seen = new Set<THREE.Material>();
    const take = (o: THREE.Object3D, dark: number, rough: number, puddles = false) =>
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
          // 自己发光的（灯）不湿；emissiveIntensity 默认是 1，要看发光的颜色是不是黑的
          if (seen.has(mat) || !(mat instanceof THREE.MeshStandardMaterial) || (mat.emissiveIntensity > 0.01 && mat.emissive.getHex() !== 0)) continue;
          seen.add(mat);
          this.wet.push({ mat, color: mat.color.clone(), roughness: mat.roughness, metalness: mat.metalness, dark, rough });
          if (puddles) this.puddles(mat);
        }
      });
    take(roads, 0.68, 0.3, true);
    take(parking, 0.7, 0.32, true);
    for (const name of ['reclaimed', 'port-yard', 'logistics-park', 'rail-structures']) {
      const o = world.getObjectByName(name);
      if (o) take(o, 0.78, 0.38, name !== 'rail-structures');
    }
    for (const name of ['land', 'city', 'beach', 'river-bank', 'airport-grass', 'port-fill']) {
      const o = world.getObjectByName(name);
      if (o) take(o, 0.86, 0.62);
    }
    const sea = world.getObjectByName('sea') as THREE.Mesh | undefined;
    const sm = sea?.material;
    if (sm instanceof THREE.MeshStandardMaterial && !this.seaShader) {
      const u = this.seaUniforms;
      sm.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSeaW;').replace('#include <project_vertex>', '#include <project_vertex>\nvSeaW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uChop;\nvarying vec3 vSeaW;')
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>
  {
    vec2 q = vSeaW.xz;
    float a = sin(q.x * 0.045 + uTime * 1.3) + sin(q.y * 0.061 - uTime * 0.9) + 0.6 * sin((q.x + q.y) * 0.13 + uTime * 2.1);
    float b = cos(q.x * 0.052 - uTime * 1.1) + sin(q.y * 0.039 + uTime * 1.7) + 0.6 * cos((q.x - q.y) * 0.11 - uTime * 1.9);
    normal = normalize(normal + uChop * 0.16 * vec3(a, 0.0, b));
  }`,
          );
        this.seaShader = shader;
      };
      sm.customProgramCacheKey = () => 'storex-sea-waves';
      sm.needsUpdate = true;
    }
  }

  /** 另外要「湿」的材质（不在 attach 找的那几块里，比如机场的道面）；puddles：也画积水 */
  addWet(mat: THREE.MeshStandardMaterial, dark: number, rough: number, puddles = false): void {
    if (this.wet.some((x) => x.mat === mat)) return;
    this.wet.push({ mat, color: mat.color.clone(), roughness: mat.roughness, metalness: mat.metalness, dark, rough });
    if (puddles) this.puddles(mat);
    this.lastWet = -1;
    this.applyWet(this.state.wet);
  }

  /** 给一个硬化地面的材质加积水（着色器里按位置算，没有贴图；地面干的时候整段跳过） */
  private puddles(mat: THREE.MeshStandardMaterial): void {
    if (this.puddled.has(mat)) return;
    this.puddled.add(mat);
    const u = this.wetUniforms;
    const prev = mat.onBeforeCompile;
    // 着色器缓存的键带上原来的（材质原来就改过着色器时不和别的混用）
    const key = `${mat.customProgramCacheKey()}|storex-puddles`;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWetW;').replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  {
    vec4 wetP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
    wetP = instanceMatrix * wetP;
    #endif
    vWetW = (modelMatrix * wetP).xyz;
  }`,
      );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${PUDDLE_FS}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${PUDDLE_MASK}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${PUDDLE_SKY}`);
    };
    mat.customProgramCacheKey = () => key;
    mat.needsUpdate = true;
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.schedule = daySchedule(seed, this.drill);
  }

  setDrill(key: string | undefined): void {
    this.drill = key && key !== 'none' ? key : undefined;
    this.schedule = daySchedule(this.seed, this.drill);
  }

  setMode(m: WeatherMode): void {
    this.mode = m;
  }

  /** 画质给的雨滴上限 */
  setBudget(n: number): void {
    this.budget = Math.max(0, Math.min(this.maxDrops, Math.round(n)));
  }

  /** t 时刻的天气（手动的模式整天一样） */
  stateAt(t: number): WeatherState {
    if (this.mode !== 'auto') return MANUAL[this.mode];
    const h = Math.max(0, Math.min(24, t / 3600));
    const i = Math.min(23, Math.floor(h));
    const a = this.schedule[i] as WeatherState;
    const b = this.schedule[i + 1] as WeatherState;
    const k = smooth(h - i);
    return { rain: lerp(a.rain, b.rain, k), fog: lerp(a.fog, b.fog, k), cloud: lerp(a.cloud, b.cloud, k), wind: lerp(a.wind, b.wind, k), wet: lerp(a.wet, b.wet, k) };
  }

  /**
   * 按 t 时刻的天气调光线、天空和雾（在 view.updateLight 算好昼夜以后调用）：
   * 阴天、下雨、起雾时太阳弱、阴影淡、天空灰；雾和雨让远处更快地淡进背景色（按镜头远近，看得清镜头对着的东西）。
   */
  applyLight(t: number, day: number, dist: number, scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): { state: WeatherState; exposure: number } {
    const s = this.stateAt(t);
    this.state = s;
    // 晴天的一点薄云不算：晴天的画面和没有天气时一样
    const cloud = Math.max(0, (s.cloud - CLEAR.cloud) / (1 - CLEAR.cloud));
    const over = Math.min(1, cloud * 0.75 + s.rain * 0.5 + s.fog * 0.45);
    const storm = s.rain * s.wind;
    sun.intensity *= Math.max(0.1, 1 - 0.85 * over);
    sun.shadow.intensity = Math.max(0.15, 1 - 0.85 * over);
    hemi.intensity *= 1 - Math.min(0.55, 0.22 * s.rain + 0.35 * storm + 0.08 * cloud);
    const dayCol = this.dayCol.copy(SKY.day).lerp(SKY.cloud, cloud * 0.9).lerp(SKY.fog, s.fog * 0.85).lerp(SKY.rain, s.rain * 0.75).lerp(SKY.storm, s.rain * s.wind);
    const bg = this.nightCol.copy(SKY.night).lerp(SKY.nightWet, Math.min(1, s.rain * 0.8 + cloud * 0.3)).lerp(dayCol, day);
    (scene.background as THREE.Color).copy(bg);
    this.wetUniforms.uWetSky.value.copy(bg);
    const fog = scene.fog as THREE.Fog;
    fog.color.copy(bg);
    const f = this.fogRange(dist);
    fog.near = f.near;
    fog.far = f.far;
    this.applyWet(s.wet);
    return { state: s, exposure: 1.05 * (1 - 0.22 * storm - 0.06 * s.rain * cloud) };
  }

  /** 雾和雨按镜头远近：镜头对着的东西还看得清，再远一点就淡进背景色（dist：镜头离它看的地方多远；监控画面按各自的机位） */
  fogRange(dist: number): { near: number; far: number } {
    const s = this.state;
    let near = 5000;
    let far = 16000;
    if (s.rain > 0) {
      near = lerp(near, Math.max(200, dist * 0.4), s.rain);
      far = lerp(far, Math.max(1600, dist * 3.2), s.rain);
    }
    if (s.fog > 0) {
      near = lerp(near, Math.max(40, dist * 0.08), s.fog);
      far = lerp(far, Math.max(500, dist * 1.7), s.fog);
    }
    return { near, far: Math.max(near + 150, far) };
  }

  private applyWet(w: number): void {
    this.wetUniforms.uWet.value = w;
    if (Math.abs(w - this.lastWet) < 0.02) return;
    this.lastWet = w;
    for (const x of this.wet) {
      x.mat.color.copy(x.color).multiplyScalar(lerp(1, x.dark, w));
      x.mat.roughness = lerp(x.roughness, Math.min(x.roughness, x.rough), w);
      x.mat.metalness = x.metalness + 0.06 * w;
    }
  }

  /**
   * 每帧：雨丝跟着镜头（大小按镜头远近）、海浪的时间、台风天的闪电（只在播放时打：暂停时画面停着，闪电也不该动）。
   * 返回闪电的亮度（0–1，view 加到天光上）。
   */
  update(dist: number, realSec: number, night: number, res: THREE.Vector2, playing: boolean): number {
    const s = this.state;
    this.seaUniforms.uTime.value = realSec;
    this.seaUniforms.uChop.value = 0.08 + 0.35 * s.rain + 0.9 * s.wind * s.wind;
    this.drops = Math.round(this.budget * Math.min(1, s.rain * 1.1));
    this.mainArea = Math.max(1, res.x * res.y);
    this.rain.visible = this.drops > 0;
    if (this.drops > 0) {
      const u = this.rainMat.uniforms;
      (u.uTime as THREE.IUniform).value = realSec;
      (u.uWind as THREE.IUniform).value.set(0.55 * s.wind, 0.25 * s.wind);
      (u.uOpacity as THREE.IUniform).value = 0.1 + 0.22 * Math.min(1, s.rain) + 0.08 * night;
      this.aim(dist, res.x, res.y);
    }
    // 台风天：播放时每十几秒打一次闪（真实时间）；暂停时不打，继续播放以后过两秒才打第一下
    if (s.wind > 0.7 && s.rain > 0.7) {
      if (!playing) {
        this.flashUntil = 0;
        this.nextFlash = Math.max(this.nextFlash, realSec + 2);
        return 0;
      }
      if (realSec > this.nextFlash) {
        this.flashUntil = realSec + 0.14;
        this.nextFlash = realSec + 8 + ((Math.sin(realSec * 12.9898) * 43758.5453) % 1 + 1) * 9;
      }
      return realSec < this.flashUntil ? 1 : 0;
    }
    return 0;
  }

  /**
   * 雨丝按一个镜头摆：雨下在镜头前面的一块里（镜头离看的地方越远这一块越大），雨丝长短、快慢、粗细跟着这块的大小和画面的像素；
   * 画面比主画面小（监控画面）就按面积少画几滴，不然小画面里全是雨。
   * 每帧按主镜头摆；监控画面画之前按监控的机位摆一次（下一帧再按主镜头摆回来）。
   */
  aim(dist: number, w: number, h: number): void {
    const u = this.rainMat.uniforms;
    this.rain.geometry.setDrawRange(0, Math.round(this.drops * Math.min(1, (w * h) / this.mainArea)) * 6);
    const box = Math.max(40, Math.min(600, dist * 0.4));
    (u.uBox as THREE.IUniform).value.set(box, box * 0.75, box);
    (u.uSpeed as THREE.IUniform).value = box * 0.75 * 1.1;
    (u.uLen as THREE.IUniform).value = box * 0.03 * (1 + this.state.wind * 0.8);
    (u.uRes as THREE.IUniform).value.set(w / 2, h / 2);
    // 小画面（监控）里雨丝细得看不见：至少按 0.8 个像素宽画
    (u.uPx as THREE.IUniform).value = Math.max(h < 600 ? 0.8 : 0.5, h / 1500);
  }

  /** 此刻（上一次 applyLight 的时刻）的天气 */
  get current(): WeatherState {
    return this.state;
  }
}
