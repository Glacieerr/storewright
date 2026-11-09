import * as THREE from 'three';
import { tx } from '../i18n';

/**
 * 监控画面识别（模拟的视觉识别）：虚拟监控的每个机位，把画面里的车、船按机位的投影算出识别框、类别和置信度，
 * 再数出画面里有几辆车、几辆在排队、靠台的车有没有对准。
 *
 * 真实的识别会漏检、误检：这里按目标在画面里的大小定置信度（越小越低），小于门槛的不报；每个目标每 10 秒换一次随机数，
 * 偶尔漏掉一个、偶尔多报一个低置信度的「误检」（同样的时刻每次一样）。识别结果和系统里的数（调度台、门磁）可以对照：
 * 接真实摄像头时，把这里换成视频流上的识别模型，输出的格式不变。
 */
export interface VisionObject {
  id: number;
  /** 画框用的类别：半挂车、厢式车、小汽车、公交车、集装箱船、火车 */
  cls: string;
  x: number;
  y: number;
  z: number;
  /** 车头朝向（沙盘坐标的 atan2(dz, dx)） */
  yaw: number;
  len: number;
  wid: number;
  hgt: number;
  /** 靠台的情况：靠好了 / 没对准；在场口排队 */
  dock?: 'ok' | 'off';
  queued?: boolean;
}
export interface Detection {
  /** 画面里的框（0–1，左上角起） */
  box: [number, number, number, number];
  cls: string;
  conf: number;
  id?: number;
  note?: string;
  /** 误检 */
  fp?: boolean;
}
export interface VisionResult {
  dets: Detection[];
  /** 画面里认出几辆车（不算误检）、几辆在排队、靠台的车里几辆靠好了、几辆没对准 */
  vehicles: number;
  queued: number;
  docked: number;
  misaligned: number;
}

/** 0–1 的确定性随机数：同一个目标、同一个 10 秒，每次一样 */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77) ^ Math.imul((c | 0) + 0x165667b1, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 100000) / 100000;
}

const v = new THREE.Vector3();
/** 一个目标（有朝向的长方体）投到画面上的框；不在画面里返回 undefined */
function project(cam: THREE.Camera, o: VisionObject): [number, number, number, number] | undefined {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let behind = 0;
  for (const dl of [-0.5, 0.5])
    for (const dw of [-0.5, 0.5])
      for (const dh of [0, 1]) {
        const lx = dl * o.len;
        const lz = dw * o.wid;
        v.set(o.x + lx * c - lz * s, o.y + dh * o.hgt, o.z + lx * s + lz * c).project(cam);
        if (v.z > 1 || v.z < -1) behind++;
        x0 = Math.min(x0, v.x);
        x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y);
        y1 = Math.max(y1, v.y);
      }
  if (behind > 4) return undefined;
  // 归一化设备坐标（−1–1，y 向上）→ 画面坐标（0–1，y 向下），裁到画面里
  const bx0 = Math.max(0, (x0 + 1) / 2);
  const bx1 = Math.min(1, (x1 + 1) / 2);
  const by0 = Math.max(0, (1 - y1) / 2);
  const by1 = Math.min(1, (1 - y0) / 2);
  if (bx1 - bx0 < 0.004 || by1 - by0 < 0.004) return undefined;
  return [bx0, by0, bx1, by1];
}

/** 一个机位此刻的识别结果；seed 区分机位（误检的位置不一样） */
export function detect(cam: THREE.Camera, objs: readonly VisionObject[], t: number, seed: number): VisionResult {
  const slot = Math.floor(t / 10);
  const dets: Detection[] = [];
  let vehicles = 0;
  let queued = 0;
  let docked = 0;
  let misaligned = 0;
  for (const o of objs) {
    const box = project(cam, o);
    if (!box) continue;
    const area = (box[2] - box[0]) * (box[3] - box[1]);
    // 画面里越大越有把握；太小的（远处）不报
    const base = Math.min(0.98, 0.55 + Math.sqrt(area) * 2.2);
    const r = hash(o.id, slot, seed);
    if (base < 0.6 || r < 0.04) continue;
    const conf = Math.max(0.5, Math.min(0.99, base - 0.08 + r * 0.16));
    const note = o.dock === 'ok' ? '已靠好' : o.dock === 'off' ? '没对准' : o.queued ? '排队' : undefined;
    dets.push({ box, cls: o.cls, conf, id: o.id, ...(note ? { note } : {}) });
    vehicles++;
    if (o.queued) queued++;
    if (o.dock === 'ok') docked++;
    if (o.dock === 'off') misaligned++;
  }
  // 偶尔一个低置信度的误检（阴影、反光）
  const f = hash(seed, slot, 7);
  if (f < 0.06) {
    const x = 0.1 + hash(seed, slot, 11) * 0.7;
    const y = 0.35 + hash(seed, slot, 13) * 0.45;
    dets.push({ box: [x, y, x + 0.06, y + 0.05], cls: '小汽车', conf: 0.5 + f, fp: true });
  }
  return { dets, vehicles, queued, docked, misaligned };
}

/** 识别框画到叠在监控画面上的画布上 */
export function drawDetections(cv: HTMLCanvasElement, res: VisionResult): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${Math.max(10, Math.round(h / 14))}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const d of res.dets) {
    const [x0, y0, x1, y1] = d.box;
    const color = d.fp ? 'rgba(255,255,255,0.7)' : d.note === '没对准' ? '#ff5a4f' : d.note === '已靠好' ? '#3ddc84' : d.note === '排队' ? '#ffc53d' : '#5ab0ff';
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, h / 160);
    ctx.setLineDash(d.fp ? [4, 3] : []);
    ctx.strokeRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
    const text = `${tx(d.cls)}${d.note ? ` · ${tx(d.note)}` : ''} ${Math.round(d.conf * 100)}%`;
    const tw = ctx.measureText(text).width + 6;
    const th = Math.max(12, Math.round(h / 12));
    const ty = Math.max(th, y0 * h);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0 * w, ty - th, tw, th);
    ctx.fillStyle = color;
    ctx.fillText(text, x0 * w + 3, ty - 1);
  }
  ctx.setLineDash([]);
}
