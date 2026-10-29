import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LAMP_LAYOUT, TOW, TOW_KINDS, towGeometry, TRAILER_WHEELS, trailerGeometry, vehicleGeometry, VEHICLE_LENGTH, VEHICLE_TYPES, WHEEL_LAYOUT, wheelGeometry, SEMI } from './vehicles';
import { boatGeometry, BOAT_SPEC, type BoatKind } from './vehicles/boats';

const box = (g: { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry }) => {
  const b = new THREE.Box3();
  for (const geo of [g.paint, g.detail]) {
    if (!geo.getAttribute('position')?.count) continue;
    geo.computeBoundingBox();
    if (geo.boundingBox) b.union(geo.boundingBox);
  }
  return b;
};

describe('车辆与船的模型（决策记录 0018）', () => {
  it('每种车型的外形尺寸与公开尺寸一致（车长、车宽、车高），车轮在车身范围内，车灯在车头车尾', () => {
    for (const type of VEHICLE_TYPES) {
      const g = vehicleGeometry(type);
      expect(g.paint.getAttribute('position').count).toBeGreaterThan(100);
      expect(g.detail.getAttribute('color').count).toBe(g.detail.getAttribute('position').count);
      const b = box(g);
      const size = b.getSize(new THREE.Vector3());
      // 半挂车只量牵引车（牵引销前 6.4 米、后 1.3 米）
      const len = type === 'semi' ? SEMI.kingpinToFront + 1.3 : VEHICLE_LENGTH[type];
      // 后视镜、拖车钩座、尾板等小部件会伸出一点
      expect(Math.abs(size.z - len) / len).toBeLessThan(0.08);
      // 车宽含后视镜（房车、半挂车的大后视镜伸出车身较多）
      expect(size.x).toBeLessThan(type === 'semi' || type === 'rv' ? 3.45 : 2.5);
      expect(size.x).toBeGreaterThan(1.6);
      expect(size.y).toBeGreaterThan(1.3);
      expect(size.y).toBeLessThan(4.2);
      for (const w of WHEEL_LAYOUT[type]) {
        expect(w.z).toBeGreaterThan(b.min.z);
        expect(w.z).toBeLessThan(b.max.z);
        expect(Math.abs(w.x) + w.w / 2).toBeLessThan(size.x / 2 + 0.12);
      }
      const lamp = LAMP_LAYOUT[type];
      expect(Math.abs(lamp.front - b.max.z)).toBeLessThan(0.35);
      if (type !== 'semi') expect(Math.abs(lamp.rear - b.min.z)).toBeLessThan(0.35);
    }
  });

  it('53 英尺挂车与拖车：长度、车轴位置与运动学参数一致', () => {
    for (const kind of ['dry', 'reefer'] as const) {
      const b = box(trailerGeometry(kind));
      expect(b.min.z).toBeCloseTo(-SEMI.kingpinToRear, 0);
      expect(b.max.y).toBeCloseTo(4.1, 0);
    }
    const axle = TRAILER_WHEELS.reduce((n, w) => n + w.z, 0) / TRAILER_WHEELS.length;
    expect(-axle).toBeCloseTo(SEMI.kingpinToAxle, 1);
    for (const kind of TOW_KINDS) {
      const b = box(towGeometry(kind));
      expect(b.max.z).toBeLessThan(0.3);
      expect(Math.abs(-b.min.z - TOW[kind].length) / TOW[kind].length).toBeLessThan(0.15);
      const ax = TOW[kind].wheels.reduce((n, w) => n + w.z, 0) / TOW[kind].wheels.length;
      expect(-ax).toBeCloseTo(TOW[kind].axle, 0);
    }
  });

  it('车轮：单位半径与宽度，轮胎外圈贴着半径 1，两侧都有轮毂', () => {
    for (const kind of ['car', 'truck'] as const) {
      const g = wheelGeometry(kind);
      g.computeBoundingBox();
      const b = g.boundingBox as THREE.Box3;
      expect(b.max.y).toBeCloseTo(1, 1);
      expect(b.max.x).toBeLessThanOrEqual(0.52);
      expect(b.min.x).toBeGreaterThanOrEqual(-0.52);
    }
  });

  it('小船：长度与船宽按公开尺寸，吃水线以上有船体', () => {
    for (const kind of Object.keys(BOAT_SPEC) as BoatKind[]) {
      const b = box(boatGeometry(kind));
      const size = b.getSize(new THREE.Vector3());
      const spec = BOAT_SPEC[kind];
      // 舷外机、舵等伸出船尾，长度允许多出 1.2 米
      expect(size.z).toBeGreaterThan(spec.length * 0.95);
      expect(size.z).toBeLessThan(spec.length + 1.2);
      expect(size.x).toBeGreaterThan(spec.beam * 0.85);
      expect(b.max.y).toBeGreaterThan(spec.waterline + 0.1);
    }
  });
});
