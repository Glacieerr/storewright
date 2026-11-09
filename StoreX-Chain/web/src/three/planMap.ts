import * as THREE from 'three';
import '../planMap.css';
import { currentRegion } from '../../../src/region/network';
import { LAND, L, type LandUsePlan } from '../../../src/region/landuse';
import { FORM_LABEL, COAST_LABEL, SIZE_LABEL } from '../../../src/region/regionGen';
import type { Km } from '../../../src/region/region';
import { t as tr, tx } from '../i18n';

/**
 * 规划图：把用地规划按规划制图的常用配色铺在沙盘上（居住黄、商业红、公共服务粉、工业棕、物流紫、绿地绿、公用设施蓝、交通灰），
 * 画上货运通道（高速、绕城快速路橙色，门店配送通道蓝色，白天限行货车的干道红色虚线）、15 分钟生活圈的范围、
 * 机场的噪声区；左上角是图例、用地结构和规划说明，片区名字在图上。打开时城区的楼和树先藏起来，看得清地块。
 */
export class PlanMap {
  readonly group = new THREE.Group();
  readonly labels: { text: string; pos: THREE.Vector3 }[] = [];
  readonly legend: HTMLElement;

  constructor(
    lu: LandUsePlan,
    host: HTMLElement,
  ) {
    this.group.name = 'plan-map';
    this.group.visible = false;
    const g = lu.grid;
    // —— 用地：一张贴图（一格一个像素），水域、农林用地透明一些 ——
    const data = new Uint8Array(g.w * g.h * 4);
    const col = new THREE.Color();
    for (let i = 0; i < g.w * g.h; i++) {
      const c = g.code[i] as number;
      if (!c || c === L.WATER) continue;
      col.set(LAND[c]?.color ?? '#000000');
      const j = i * 4;
      data[j] = Math.round(col.r * 255);
      data[j + 1] = Math.round(col.g * 255);
      data[j + 2] = Math.round(col.b * 255);
      data[j + 3] = c === L.RURAL ? 120 : 235;
    }
    const tex = new THREE.DataTexture(data, g.w, g.h, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const W = g.w * g.cell * 100;
    const H = g.h * g.cell * 100;
    const plane = new THREE.PlaneGeometry(W, H);
    // 贴图的第一行是最南（y 小），沙盘的 z 向南为正：平面躺下以后 v 方向要翻过来
    plane.rotateX(-Math.PI / 2);
    const uv = plane.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const cx = (g.x0 + (g.w * g.cell) / 2) * 100;
    const cz = -(g.y0 + (g.h * g.cell) / 2) * 100;
    plane.translate(cx, 0.078, cz);
    const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.name = 'plan-landuse';
    mesh.renderOrder = 1;
    this.group.add(mesh);

    const P = (k: Km, y = 1.2) => new THREE.Vector3(k.x * 100, y, -k.y * 100);
    const region = currentRegion();
    const node = (id: string) => region.nodes[id] as Km;
    // —— 货运通道和限行 ——
    const kinds = { freight: { color: '#e8833a', width: 16 }, delivery: { color: '#2f7fd8', width: 13 }, restricted: { color: '#d9443f', width: 9 } };
    for (const kind of ['restricted', 'freight', 'delivery'] as const) {
      const pos: number[] = [];
      for (const c of lu.corridors) {
        if (c.kind !== kind) continue;
        const e = region.edges.find((x) => (x.a === c.a && x.b === c.b) || (x.a === c.b && x.b === c.a));
        if (!e) continue;
        const pts = [node(e.a), ...(e.via ?? []), node(e.b)].map((k) => P(k, 1.4 + (kind === 'delivery' ? 0.2 : 0)));
        // 限行画虚线：每 60 米画 35 米
        let acc = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1] as THREE.Vector3;
          const b = pts[i] as THREE.Vector3;
          const len = a.distanceTo(b);
          const n = Math.max(1, Math.ceil(len / 20));
          for (let k = 0; k < n; k++) {
            const p0 = a.clone().lerp(b, k / n);
            const p1 = a.clone().lerp(b, (k + 1) / n);
            const mid = acc + (len * (k + 0.5)) / n;
            if (kind === 'restricted' && mid % 60 > 35) continue;
            ribbonSeg(pos, p0, p1, kinds[kind].width);
          }
          acc += len;
        }
      }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: kinds[kind].color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      m.renderOrder = 2;
      m.name = `plan-${kind}`;
      this.group.add(m);
    }
    // —— 生活圈（800–1,000 米的范围，沙盘上按 1 公里画）、机场噪声区 ——
    const ring = (c: Km, r: number, color: string, dashed = false) => {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 64; k++) pts.push(P({ x: c.x + Math.cos((k / 64) * Math.PI * 2) * r, y: c.y + Math.sin((k / 64) * Math.PI * 2) * r }, 1.0));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = dashed ? new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 14, gapSize: 9, transparent: true, opacity: 0.8 })) : new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
      if (dashed) line.computeLineDistances();
      line.renderOrder = 3;
      this.group.add(line);
    };
    for (const lc of lu.lifeCircles) ring(lc.c, 0.95, '#8a6d2f', true);
    const nz = lu.noise;
    const len = Math.hypot(nz.b.x - nz.a.x, nz.b.y - nz.a.y) || 1;
    const u = { x: (nz.b.x - nz.a.x) / len, y: (nz.b.y - nz.a.y) / len };
    const nrm = { x: -u.y, y: u.x };
    for (const [ext, half, color] of [
      [nz.ext70, nz.half70, '#e08a2e'],
      [nz.ext75, nz.half75, '#c2412f'],
    ] as const) {
      const outline: Km[] = [];
      const at = (t: number, s: number) => ({ x: nz.a.x + u.x * t + nrm.x * s, y: nz.a.y + u.y * t + nrm.y * s });
      const hw = (beyond: number) => half * (1 - (0.55 * beyond) / ext);
      outline.push(at(-ext, hw(ext)), at(0, half), at(len, half), at(len + ext, hw(ext)), at(len + ext, -hw(ext)), at(len, -half), at(0, -half), at(-ext, -hw(ext)), at(-ext, hw(ext)));
      const geo = new THREE.BufferGeometry().setFromPoints(outline.map((k) => P(k, 1.1)));
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 30, gapSize: 16 }));
      line.computeLineDistances();
      line.renderOrder = 3;
      this.group.add(line);
    }
    // —— 片区、中心的名字 ——
    for (const d of lu.districts) if (d.area > 2) this.labels.push({ text: d.name, pos: P(d.at, 60) });
    this.labels.push({ text: tr('70 分贝噪声区'), pos: P({ x: (nz.a.x + nz.b.x) / 2 + nrm.x * (nz.half70 + 0.6), y: (nz.a.y + nz.b.y) / 2 + nrm.y * (nz.half70 + 0.6) }, 40) });

    // —— 图例、用地结构、规划说明 ——
    const used = new Set<number>();
    for (let i = 0; i < g.code.length; i++) used.add(g.code[i] as number);
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    const items = LAND.map((c, i) => ({ c, i })).filter(({ c, i }) => c.code && used.has(i) && i !== L.WATER);
    const o = region.options;
    // 区域选项、用地分类、用地结构、规划说明是区域生成器给的中文：英文界面按字典翻
    const form = o.form ? tx(FORM_LABEL[o.form]) : tr('自由生长');
    const coast = o.coast ? tx(COAST_LABEL[o.coast]) : tr('曲折海岸');
    this.legend = document.createElement('div');
    this.legend.className = 'plan-legend';
    this.legend.hidden = true;
    this.legend.innerHTML = `
      <header><b>${tr('规划图')}</b><span>${esc(tx(SIZE_LABEL[o.size]))} · ${esc(form)} · ${esc(coast)}${region.river?.branches?.length ? ` ${tr('· 有支流')}` : ''}${region.islands?.length ? ` ${tr('· {length} 座岛', { length: region.islands.length })}` : ''}</span></header>
      <ul class="pl-classes">${items.map(({ c }) => `<li><i style="background:${c.color}"></i>${esc(c.code)} ${esc(tx(c.label))}</li>`).join('')}</ul>
      <ul class="pl-lines">
        <li><i class="ln" style="background:#e8833a"></i>${tr('货运通道（高速、绕城快速路、工业物流区的干道）')}</li>
        <li><i class="ln" style="background:#2f7fd8"></i>${tr('门店配送通道（全天通行）')}</li>
        <li><i class="ln dash" style="color:#d9443f"></i>${tr('白天限行货车（6:00–23:00）')}</li>
        <li><i class="ring"></i>${tr('15 分钟生活圈（{length} 个）', { length: lu.lifeCircles.length })}</li>
        <li><i class="ln dash" style="color:#e08a2e"></i>${tr('机场噪声区（不放居住、学校、医院）')}</li>
      </ul>
      <h4>${tr('城市建设用地结构')}</h4>
      <table class="pl-stats">${lu.stats
        .filter((s) => s.km2 > 0)
        .map((s) => `<tr><td>${esc(tx(s.group))}</td><td>${esc(tx(s.label))}</td><td class="bar"><span style="width:${Math.min(100, Math.round(s.share * 200))}%"></span></td><td>${Math.round(s.share * 100)}%</td></tr>`)
        .join('')}</table>
      <details><summary>${tr('规划说明（{length} 条）', { length: lu.rules.length })}</summary><ol>${lu.rules.map((x) => `<li>${esc(tx(x))}</li>`).join('')}</ol>
      <p class="pl-note">${tr('用地分类按 GB 50137-2011，居住区按 GB 50180-2018 的生活圈组织；比例、半径、噪声区、限行时段等是按公开资料取的假设参数，不对应哪一座城市。沙盘把距离压缩成 1/10，规划图上的距离按沙盘上的公里算。')}</p></details>`;
    host.append(this.legend);
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
    this.legend.hidden = !on;
  }
}

/** 一段带子（两个三角形）：从 a 到 b，宽 w，平放 */
function ribbonSeg(out: number[], a: THREE.Vector3, b: THREE.Vector3, w: number): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (w / 2);
  const nz = (dx / l) * (w / 2);
  out.push(a.x + nx, a.y, a.z + nz, b.x + nx, b.y, b.z + nz, b.x - nx, b.y, b.z - nz);
  out.push(a.x + nx, a.y, a.z + nz, b.x - nx, b.y, b.z - nz, a.x - nx, a.y, a.z - nz);
}
