import * as THREE from 'three';
import { BUILDING, type Category, type Layout, type Rect } from '../../../src/world/layout';
import { box, boxTiled, cyl, merge, type Part } from './models';

/**
 * 门店的三维模型：从仿真用的同一份布局生成（1 格 = 1 米）。
 * 返回的 group 原点在布局的 (0, 0) 角上，x 向右、z 向下（布局的 y），区域场景可以整体平移、旋转后放进去。
 */
export interface StoreModel {
  group: THREE.Group;
  /** 外墙、屋顶：剖面模式下矮下去 / 隐藏，外观模式下完整 */
  exterior: THREE.Object3D;
  roof: THREE.Object3D;
  labels: { text: string; x: number; y: number; z: number; kind: 'zone' | 'big' }[];
  size: { w: number; h: number };
  /** 货格仓顶面的高度（货格机器人在这个高度上跑） */
  mfcTop: number;
}

export const MFC_HEIGHT = 4.6;
const SHELF: Record<Category, { h: number; base: string; goods: string[] }> = {
  ambient: { h: 2.0, base: '#d9d3c4', goods: ['#c4523f', '#e0a13b', '#7b9b4c', '#3f6fa5', '#d8c27a', '#a3553f'] },
  household: { h: 2.0, base: '#cfd6dc', goods: ['#4f86c6', '#e8e6df', '#7cb7c9', '#c46aa0', '#9fb36b'] },
  beverage: { h: 2.0, base: '#c9d8d6', goods: ['#2f8f83', '#c43d3d', '#e3b23c', '#3d5fa8', '#7fb3d5'] },
  dairy: { h: 2.1, base: '#e9f0f7', goods: ['#ffffff', '#cfe2f3', '#f2e6b8', '#9ec5e8', '#e8d0b0'] },
  frozen: { h: 1.9, base: '#cfe0f2', goods: ['#9ec5f4', '#e3eefa', '#6da7ec', '#f0f4f8'] },
  produce: { h: 0.9, base: '#a9874e', goods: ['#6fa84a', '#e2a536', '#c9442f', '#8fbf4d', '#f0cf4a', '#7a3f8f'] },
  meat: { h: 1.3, base: '#ecdcd8', goods: ['#c4524a', '#e38b7c', '#f1d4c6', '#a8433d'] },
  bakery: { h: 1.2, base: '#c8a06a', goods: ['#d79b52', '#e9c88f', '#a8683a', '#f1dfb8'] },
};

/** 货架侧面的贴图：几层隔板，上面摆着一排排商品（固定的伪随机颜色） */
function shelfTexture(cat: Category): THREE.CanvasTexture {
  const spec = SHELF[cat];
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = spec.base;
  g.fillRect(0, 0, 256, 128);
  let seed = cat.length * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const levels = cat === 'produce' || cat === 'bakery' ? 1 : 4;
  const lh = 128 / levels;
  for (let l = 0; l < levels; l++) {
    const y0 = l * lh;
    let x = 2;
    while (x < 254) {
      const w = 8 + Math.floor(rnd() * 14);
      g.fillStyle = spec.goods[Math.floor(rnd() * spec.goods.length)] as string;
      const top = y0 + 4 + rnd() * lh * 0.25;
      g.fillRect(x, top, Math.min(w, 254 - x), y0 + lh - 5 - top);
      x += w + 1;
    }
    g.fillStyle = 'rgba(40,40,40,0.55)';
    g.fillRect(0, y0 + lh - 4, 256, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 货格仓侧面：一格格叠起来的货箱 */
function binTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#5d6670';
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 4; x++) {
      g.fillStyle = (x + y) % 3 === 0 ? '#7d8a98' : '#6f7b88';
      g.fillRect(x * 32 + 2, y * 16 + 2, 28, 12);
    }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 货格仓顶面：机器人跑的轨道网格 */
function railTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#4b535b';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#b8c0c8';
  g.fillRect(0, 0, 64, 6);
  g.fillRect(0, 0, 6, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 自提柜的柜门 */
function lockerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#e8e8ef';
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 2; x++) {
      g.fillStyle = '#d6d3e6';
      g.fillRect(x * 64 + 3, y * 32 + 3, 58, 26);
      g.fillStyle = '#6250d6';
      g.fillRect(x * 64 + 50, y * 32 + 14, 6, 4);
    }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const OUTSIDE = 0;
const WALL = 2;

export function buildStoreModel(layout: Layout): StoreModel {
  const group = new THREE.Group();
  group.name = 'store';
  const W = layout.width;
  const H = layout.height;
  const B = BUILDING;
  const std = (opts: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...opts });
  const vc = std({ vertexColors: true });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: 'cast' | 'receive' | 'both' = 'both', name = '') => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow !== 'receive';
    m.receiveShadow = shadow !== 'cast';
    m.name = name;
    group.add(m);
    return m;
  };

  // —— 地面：停车场和卸货场是沥青，建筑里是浅色地坪 ——
  const ground = new THREE.PlaneGeometry(W, H);
  ground.rotateX(-Math.PI / 2);
  ground.translate(W / 2, 0, H / 2);
  add(ground, std({ color: '#6b6e72', roughness: 0.95 }), 'receive', 'asphalt');
  const floorParts: Part[] = [];
  const backParts: Part[] = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const c = layout.cells[y * W + x];
      if (c === OUTSIDE || c === WALL) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < W && layout.cells[y * W + x] !== OUTSIDE && layout.cells[y * W + x] !== WALL) x++;
      (y < (layout.generation === 'storex' ? 20 : 17) ? backParts : floorParts).push(box(x - x0, 0.04, 1, '#ffffff', (x0 + x) / 2, 0, y + 0.5));
    }
  }
  if (floorParts.length) add(merge(floorParts), std({ color: '#ece9e1', roughness: 0.6 }), 'receive', 'floor');
  if (backParts.length) add(merge(backParts), std({ color: '#d9d4c8', roughness: 0.8 }), 'receive', 'backroom-floor');

  // —— 区域地面颜色、车道 ——
  const zoneParts: Part[] = [];
  const laneParts: Part[] = [];
  for (const r of layout.rects) {
    if (r.kind === 'zone' || r.kind === 'checkout') zoneParts.push(box(r.w, 0.02, r.h, '#ffffff', r.x + r.w / 2, 0.04, r.y + r.h / 2));
    if (r.kind === 'lane') laneParts.push(box(r.w, 0.02, r.h, '#ffffff', r.x + r.w / 2, 0.01, r.y + r.h / 2));
  }
  if (zoneParts.length) add(merge(zoneParts), std({ color: '#dde7f3', transparent: true, opacity: 0.75 }), 'receive', 'zones');
  if (laneParts.length) add(merge(laneParts), std({ color: '#7d8085' }), 'receive', 'lanes');

  // —— 停车位、车道标线 ——
  const lines: Part[] = [];
  for (const p of layout.poi.parking) {
    lines.push(box(0.12, 0.02, 4.6, '#f2f2ee', p.x - 1.3, 0.02, p.y + 0.5));
    lines.push(box(0.12, 0.02, 4.6, '#f2f2ee', p.x + 1.7, 0.02, p.y + 0.5));
  }
  for (const b of [...layout.poi.curbsideBays, ...layout.poi.driveBays]) lines.push(box(4.4, 0.02, 0.12, '#f2d24a', b.x + 0.5, 0.03, b.y - 1));
  if (lines.length) add(merge(lines), std({ vertexColors: true, roughness: 0.6 }), 'receive', 'markings');

  // —— 墙：外墙和内墙分开（剖面模式下外墙矮下去） ——
  const outer: Part[] = [];
  const inner: Part[] = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (layout.cells[y * W + x] !== WALL) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < W && layout.cells[y * W + x] === WALL) x++;
      const isOuter = y === B.y0 || y === B.y1 || x0 === B.x0 || x - 1 === B.x1;
      (isOuter ? outer : inner).push(box(x - x0, 1, 1, '#ffffff', (x0 + x) / 2, 0, y + 0.5));
    }
  }
  const exterior = new THREE.Group();
  exterior.name = 'exterior';
  if (outer.length) {
    const m = new THREE.Mesh(merge(outer), std({ color: '#c9c4b8' }));
    m.castShadow = true;
    m.receiveShadow = true;
    exterior.add(m);
  }
  group.add(exterior);
  if (inner.length) {
    const m = add(merge(inner), std({ color: '#d6d1c6' }), 'both', 'inner-walls');
    m.scale.y = 3;
  }

  // —— 货架：按大类分组，侧面贴「商品」贴图 ——
  const byCat = new Map<Category, Rect[]>();
  for (const r of layout.rects) if (r.kind === 'shelf' && r.category) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  for (const [cat, rects] of byCat) {
    const spec = SHELF[cat];
    const geos = rects.map((r) => {
      const g = boxTiled(r.w * 0.92, spec.h, r.h * 0.92);
      g.translate(r.x + r.w / 2, spec.h / 2, r.y + r.h / 2);
      return g;
    });
    const tex = shelfTexture(cat);
    const mat = std({ map: tex, color: '#ffffff', roughness: cat === 'dairy' || cat === 'frozen' ? 0.35 : 0.8 });
    for (const g of geos) {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
  }

  // —— 固定设施：后仓货架（高货架 + 托盘）、收银台、合流台等 ——
  const racks: Part[] = [];
  const counters: Part[] = [];
  const backY = layout.generation === 'storex' ? 20 : 17;
  for (const r of layout.rects) {
    if (r.kind !== 'fixture') continue;
    if (r.y < backY && r.h === 1) {
      // 后仓货架：橙色立柱 + 三层托盘
      for (let x = r.x; x < r.x + r.w; x += 2) racks.push(box(0.12, 3.6, 0.12, '#e07a2b', x + 0.1, 0, r.y + 0.1), box(0.12, 3.6, 0.12, '#e07a2b', x + 0.1, 0, r.y + 0.9));
      for (const lvl of [0.1, 1.3, 2.5]) {
        racks.push(box(r.w, 0.1, 1, '#3d6fb0', r.x + r.w / 2, lvl, r.y + 0.5));
        for (let x = r.x + 0.6; x < r.x + r.w - 0.4; x += 1.4) racks.push(box(1.1, 0.9, 0.9, lvl === 1.3 ? '#cfb68c' : '#bfa06f', x + 0.4, lvl + 0.1, r.y + 0.5));
      }
    } else if (r.label === '合流台') {
      counters.push(box(r.w, 0.9, r.h, '#9aa3ab', r.x + r.w / 2, 0, r.y + r.h / 2));
      for (let y = r.y + 0.5; y < r.y + r.h; y += 1.2) counters.push(box(0.55, 0.3, 0.4, y % 2 < 1 ? '#2a78d6' : '#1baf7a', r.x + r.w / 2, 0.9, y));
    } else counters.push(box(r.w * 0.9, 1.0, r.h * 0.9, '#a7a39a', r.x + r.w / 2, 0, r.y + r.h / 2));
  }
  // 收银台、自助机、出口闸机
  for (const p of layout.poi.staffedLanes) counters.push(box(2.2, 0.95, 0.8, '#8d9399', p.x - 0.6, 0, p.y + 0.5), box(0.4, 0.4, 0.05, '#26313c', p.x - 1.3, 0.95, p.y + 0.5));
  for (const p of layout.poi.selfCheckouts) counters.push(box(0.8, 1.1, 0.7, '#e6e6e2', p.x + 0.5, 0, p.y + 0.5), box(0.5, 0.35, 0.05, '#2a78d6', p.x + 0.5, 1.1, p.y + 0.2));
  for (const p of layout.poi.gates) counters.push(box(0.25, 1.0, 1.4, '#1baf7a', p.x - 0.3, 0, p.y + 0.5), box(0.25, 1.0, 1.4, '#1baf7a', p.x + 1.3, 0, p.y + 0.5));
  // 货格仓站台、拆箱站：工作台 + 屏幕
  for (const p of [...layout.poi.mfcPorts, ...(layout.poi.decant ? [layout.poi.decant] : [])]) counters.push(box(1.6, 0.9, 1.2, '#7c8792', p.x + 1, 0, p.y + 0.5), box(0.05, 0.45, 0.6, '#26313c', p.x + 1.7, 0.95, p.y + 0.5), box(0.7, 0.35, 0.5, '#c8a46a', p.x + 1.3, 0.9, p.y + 0.2));
  // 充电桩
  for (const p of layout.poi.chargers) counters.push(box(0.4, 1.2, 0.3, '#3d4650', p.x + 0.5, 0, p.y - 0.3), box(0.3, 0.1, 0.05, '#1baf7a', p.x + 0.5, 1.0, p.y - 0.14));
  if (racks.length) add(merge(racks), vc, 'both', 'racks');
  if (counters.length) add(merge(counters), vc, 'both', 'counters');

  // —— 立体货格仓 ——
  let mfcTop = 0;
  const mfc = layout.rects.find((r) => r.kind === 'mfc');
  if (mfc) {
    const side = binTexture();
    side.repeat.set(mfc.w / 2, MFC_HEIGHT / 2);
    const top = railTexture();
    top.repeat.set(mfc.w, mfc.h);
    const sideMat = std({ map: side, roughness: 0.7 });
    const topMat = std({ map: top, roughness: 0.5, metalness: 0.3 });
    const g = new THREE.BoxGeometry(mfc.w, MFC_HEIGHT, mfc.h);
    g.translate(mfc.x + mfc.w / 2, MFC_HEIGHT / 2, mfc.y + mfc.h / 2);
    const m = new THREE.Mesh(g, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'mfc';
    group.add(m);
    // 四角立柱和顶部边框
    const frame: Part[] = [];
    for (const [x, z] of [
      [mfc.x, mfc.y],
      [mfc.x + mfc.w, mfc.y],
      [mfc.x, mfc.y + mfc.h],
      [mfc.x + mfc.w, mfc.y + mfc.h],
    ] as const)
      frame.push(box(0.25, MFC_HEIGHT + 0.3, 0.25, '#aab4bd', x, 0, z));
    frame.push(box(mfc.w + 0.3, 0.2, 0.25, '#aab4bd', mfc.x + mfc.w / 2, MFC_HEIGHT, mfc.y), box(mfc.w + 0.3, 0.2, 0.25, '#aab4bd', mfc.x + mfc.w / 2, MFC_HEIGHT, mfc.y + mfc.h));
    frame.push(box(0.25, 0.2, mfc.h, '#aab4bd', mfc.x, MFC_HEIGHT, mfc.y + mfc.h / 2), box(0.25, 0.2, mfc.h, '#aab4bd', mfc.x + mfc.w, MFC_HEIGHT, mfc.y + mfc.h / 2));
    add(merge(frame), vc, 'both', 'mfc-frame');
    mfcTop = MFC_HEIGHT;
  }

  // —— 自提柜 ——
  for (const r of layout.rects) {
    if (r.kind !== 'lockers') continue;
    const tex = lockerTexture();
    tex.repeat.set(r.h / 2, 1);
    const g = boxTiled(r.w * 0.9, 2.3, r.h, 2);
    g.translate(r.x + r.w / 2, 1.15, r.y + r.h / 2);
    const m = new THREE.Mesh(g, std({ map: tex, roughness: 0.5 }));
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'lockers';
    group.add(m);
    // 三个温区的色带（常温、冷藏、冷冻）
    const bands: Part[] = [];
    const third = r.h / 3;
    ['#d7a84a', '#5f8fc9', '#9fc0ea'].forEach((col, i) => bands.push(box(r.w + 0.1, 0.15, third - 0.2, col, r.x + r.w / 2, 2.3, r.y + i * third + third / 2)));
    add(merge(bands), vc, 'cast', 'locker-bands');
  }

  // —— 卸货门、出入口 ——
  const doors: Part[] = [];
  for (const d of layout.poi.docks) doors.push(box(3.2, 3.6, 0.3, '#3a4048', d.inside.x + 0.5, 0, B.y0 - 0.1), box(3.6, 0.3, 1.6, '#555b62', d.inside.x + 0.5, 1.2, B.y0 - 0.9));
  for (const p of [layout.poi.entrance, layout.poi.exit]) doors.push(box(2.4, 2.6, 0.2, '#7fb3d5', p.x + 1, 0, B.y1 + 0.5));
  if (doors.length) add(merge(doors), vc, 'both', 'doors');

  // —— 屋顶（外观模式下才显示）和周边的树 ——
  const roofGeo = new THREE.BoxGeometry(B.x1 - B.x0 + 1, 0.4, B.y1 - B.y0 + 1);
  roofGeo.translate((B.x0 + B.x1 + 1) / 2, 7.2, (B.y0 + B.y1 + 1) / 2);
  const roof = new THREE.Mesh(roofGeo, std({ color: '#b9bec4', roughness: 0.9 }));
  roof.castShadow = true;
  roof.receiveShadow = true;
  roof.name = 'roof';
  roof.visible = false;
  // 屋顶光伏板
  const pv: Part[] = [];
  for (let x = B.x0 + 3; x < B.x1 - 3; x += 4) for (let z = B.y0 + 3; z < B.y1 - 3; z += 3) pv.push(box(3.4, 0.08, 2.2, '#1f3550', x + 1.7, 7.45, z + 1.1));
  const pvMesh = new THREE.Mesh(merge(pv), std({ vertexColors: true, roughness: 0.3, metalness: 0.4 }));
  pvMesh.castShadow = true;
  roof.add(pvMesh);
  group.add(roof);
  const trees: Part[] = [];
  for (let x = 6; x <= 78; x += 6) for (const z of [57.5, 69.3]) if (z > 0 && z < H) trees.push(cyl(0.18, 0.22, 1.6, '#7a5a3a', x, 0, z), cyl(0, 1.3, 3.2, '#5e8f4e', x, 1.4, z, 8));
  add(merge(trees), vc, 'both', 'trees');

  // —— 区域名字（HTML 标签用） ——
  const labels: StoreModel['labels'] = [];
  for (const r of layout.rects) {
    if (!r.label || r.kind === 'shelf' || r.kind === 'fixture' || r.kind === 'backroom') continue;
    labels.push({ text: r.label, x: r.x + r.w / 2, y: r.kind === 'mfc' ? MFC_HEIGHT + 1.5 : r.kind === 'outside' ? 1 : 3, z: r.y + r.h / 2, kind: r.kind === 'mfc' || r.kind === 'checkout' ? 'big' : 'zone' });
  }
  for (const r of layout.rects) if (r.kind === 'shelf' && r.label) labels.push({ text: r.label, x: r.x + r.w / 2, y: SHELF[r.category as Category].h + 0.8, z: r.y + r.h / 2, kind: 'zone' });

  return { group, exterior, roof, labels, size: { w: W, h: H }, mfcTop };
}

/** 外墙高度：剖面模式 1.2 米（看得见里面），外观模式 7 米 */
export function setExteriorMode(model: StoreModel, mode: 'cutaway' | 'exterior'): void {
  model.exterior.scale.y = mode === 'exterior' ? 7 : 1.2;
  model.roof.visible = mode === 'exterior';
}
