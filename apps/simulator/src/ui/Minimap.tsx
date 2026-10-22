import { useEffect, useRef } from 'react';
import { useApp } from '../state/store';
import { framePositions } from '../scene/framePositions';
import { cameraState } from '../scene/cameraState';
import { siteFor } from '../scene/useSite';
import { ROLE_COLOR } from '../scene/palette';
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
      g.fillStyle = s.ground.color;
      g.fillRect(0, 0, W, H);
      for (const a of s.asphalt) rect(a.x, a.z, a.w, a.d, '#9aa1a8');
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
