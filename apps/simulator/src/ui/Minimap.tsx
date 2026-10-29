import { useEffect, useRef } from 'react';
import { useApp } from '../state/store';
import { framePositions } from '../scene/framePositions';
import { cameraState } from '../scene/cameraState';
import { siteFor } from '../scene/useSite';
import { riverX } from '../scene/terrain/waterPlan';
import { GROUND_PALETTE, ROLE_COLOR, URBAN_GROUND } from '../scene/palette';
import { t } from '../i18n';

/** 画布上记录当前的映射参数，点击时反算世界坐标 */
type MapCanvas = HTMLCanvasElement & { __map?: { ox: number; oy: number; maxX: number; maxZ: number; k: number } };

const W = 200;
const H = 150;

/**
 * 小地图：俯视的门店、停车场和道路，员工和车辆的实时位置，以及当前镜头的可视范围。
 * 点击小地图把镜头移过去。方向与俯视图一致（门店在上、停车场在下）。
 */
export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const show = useApp((s) => s.minimap);

  useEffect(() => {
    if (!show) return;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;
    const draw = () => {
      const { simGeo: geo, site, timeline } = useApp.getState();
      const s = siteFor(geo, site);
      const f0 = geo.floors[0];
      const minX = geo.lot.minX - 45;
      const maxX = geo.lot.maxX + 45;
      const minZ = s.roadBottomZ - 20;
      const maxZ = (f0?.maxZ ?? 40) + 25;
      const k = Math.min(W / (maxX - minX), H / (maxZ - minZ));
      const ox = (W - (maxX - minX) * k) / 2;
      const oy = (H - (maxZ - minZ) * k) / 2;
      // 与俯视图一致：屏幕右侧是 −X，上方是 +Z
      const u = (x: number) => ox + (maxX - x) * k;
      const v = (z: number) => oy + (maxZ - z) * k;
      const rect = (x: number, z: number, w: number, d: number, color: string) => {
        g.fillStyle = color;
        g.fillRect(u(x + w / 2), v(z + d / 2), w * k, d * k);
      };
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 地面颜色与三维场景一致（按季节；城市街区是浅灰的硬质铺地）
      const season = site.season ?? 'autumn';
      g.fillStyle = s.style === 'urban' && season !== 'winter' ? URBAN_GROUND : (GROUND_PALETTE[season]?.ground ?? s.ground.color);
      g.fillRect(0, 0, W, H);
      // 水系：湖（岸线多边形）和河道（沿中心线的一条带子）
      const water = s.water;
      g.fillStyle = '#74c6d6';
      g.beginPath();
      water.lake.shore.forEach((p, i) => (i ? g.lineTo(u(p.x), v(p.z)) : g.moveTo(u(p.x), v(p.z))));
      g.closePath();
      g.fill();
      const r = water.river;
      const zs: number[] = [];
      for (let z = r.zWeir; z <= maxZ + 4; z += 2) zs.push(z);
      g.beginPath();
      zs.forEach((z, i) => (i ? g.lineTo(u(riverX(r, z) - r.half), v(z)) : g.moveTo(u(riverX(r, z) - r.half), v(z))));
      for (const z of [...zs].reverse()) g.lineTo(u(riverX(r, z) + r.half), v(z));
      g.closePath();
      g.fill();
      // 出海水道和海湾（决策记录 0019）
      const o = water.outlet;
      if (o) {
        rect(o.x, (o.z0 + o.z1) / 2, o.half * 2, o.z1 - o.z0, '#74c6d6');
        g.beginPath();
        g.ellipse(u(o.bay.cx), v(o.bay.cz), o.bay.rx * k, o.bay.rz * k, 0, 0, Math.PI * 2);
        g.fill();
      }
      for (const a of s.asphalt) rect(a.x, a.z, a.w, a.d, '#9aa1a8');
      // 出入口的喇叭口
      g.fillStyle = '#9aa1a8';
      for (const poly of s.asphaltPolys) {
        g.beginPath();
        poly.forEach((p, i) => (i ? g.lineTo(u(p.x), v(p.z)) : g.moveTo(u(p.x), v(p.z))));
        g.closePath();
        g.fill();
      }
      rect((geo.lot.minX + geo.lot.maxX) / 2, geo.lot.edgeZ / 2, geo.lot.maxX - geo.lot.minX, -geo.lot.edgeZ, '#b3b9bf');
      for (const p of geo.lot.spots.slice(0, geo.lot.pickupCount)) rect(p.x, p.z, 2.6, 5, '#f2b27a');
      for (const f of geo.floors) if (f.level === 0) rect((f.minX + f.maxX) / 2, (f.minZ + f.maxZ) / 2, f.maxX - f.minX, f.maxZ - f.minZ, '#efe7d6');
      for (const f of geo.facilities) rect((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2, f.x1 - f.x0, f.z1 - f.z0, '#e3b3ad');
      // 员工与取货车辆
      const roles = new Map((timeline?.associates ?? []).map((a) => [a.id, a.role]));
      for (const [id, p] of framePositions) {
        const role = roles.get(id);
        g.fillStyle = role ? ROLE_COLOR[role] : '#2f6fb5';
        const r = role ? 1.6 : 2.2;
        g.beginPath();
        g.arc(u(p.x), v(p.z), r, 0, Math.PI * 2);
        g.fill();
      }
      // 镜头可视范围
      const fp = cameraState.footprint;
      if (fp.length >= 3) {
        g.beginPath();
        fp.forEach((p, i) => (i ? g.lineTo(u(p.x), v(p.z)) : g.moveTo(u(p.x), v(p.z))));
        g.closePath();
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fill();
        g.strokeStyle = '#ffffff';
        g.lineWidth = 1.5;
        g.stroke();
      }
      g.fillStyle = '#e5484d';
      g.beginPath();
      g.arc(u(cameraState.target.x), v(cameraState.target.z), 2.2, 0, Math.PI * 2);
      g.fill();
      (canvas as MapCanvas).__map = { ox, oy, maxX, maxZ, k };
    };
    draw();
    const id = window.setInterval(draw, 200);
    return () => window.clearInterval(id);
  }, [show]);

  if (!show) return null;
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget as MapCanvas;
    const m = c.__map;
    if (!m) return;
    const r = c.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    // 反算：u = ox + (maxX − x)·k，v = oy + (maxZ − z)·k
    const x = m.maxX - (px - m.ox) / m.k;
    const z = m.maxZ - (py - m.oy) / m.k;
    useApp.getState().setFollow(undefined);
    useApp.getState().focusOn(x, 0, z);
  };
  return <canvas ref={ref} className="minimap" style={{ width: W, height: H }} onClick={onClick} aria-label={t('小地图：点击移动镜头')} />;
}
