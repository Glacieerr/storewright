import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { backroomLayout } from '@storewright/store-config';
import { useApp } from '../state/store';
import { clock, setPlaying, setSpeed } from '../state/clock';
import { t } from '../i18n';
import { framePositions } from './framePositions';
import { useSiteLayout } from './useSite';

/**
 * 自动镜头巡游：像宣传片一样在几个机位之间循环——门店全景环绕、停车场推近、跟拍拣货员、
 * 暂存区摇臂、后仓、路口、俯瞰。每个镜头约 9 秒，镜头之间 1.5 秒交叉过渡；字幕说明画面里发生的事。
 * 开启时切到 3D 视角、30 倍速播放，关闭后恢复原来的视角和倍速。
 */

interface Pose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

interface Shot {
  caption: string;
  dur: number;
  pose: (k: number, out: Pose) => void;
}

const BLEND = 1.5;
const smooth = (x: number) => x * x * (3 - 2 * x);

export function CinematicDirector() {
  const on = useApp((s) => s.cinematic);
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const timeline = useApp((s) => s.timeline);
  const lang = useApp((s) => s.lang);
  const site = useSiteLayout();
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; enabled: boolean } | null;

  const shots = useMemo<Shot[]>(() => {
    const f0 = geo.floors[0];
    const minX = f0?.minX ?? 0;
    const maxX = f0?.maxX ?? 60;
    const minZ = f0?.minZ ?? 0;
    const maxZ = f0?.maxZ ?? 40;
    const c = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const lot = geo.lot;
    const R = Math.max(maxX - minX, maxZ - lot.edgeZ) * 0.75 + 30;
    const ps = lot.pickupSign;
    const sp = model.config.layout.points.staging;
    const b = backroomLayout(model.config);
    const roadZ = (site.roadTopZ + site.roadBottomZ) / 2;
    const ix = [...site.intersections].sort((a, q) => Math.abs(a.x - c.x) - Math.abs(q.x - c.x))[0];
    // 跟拍：找一名正在走动的拣货员（找不到时沿通道飞过）
    const pickers = (timeline?.associates ?? []).filter((a) => a.role === 'pick').map((a) => a.id);
    const chase = { id: '' as string, angle: 0 };
    return [
      {
        caption: t('门店全景：线上订单在店内拣货、暂存，顾客到停车场取货'),
        dur: 10,
        pose: (k, o) => {
          const a = -2.2 + k * 0.55;
          o.pos.set(c.x + Math.cos(a) * R, R * 0.5, c.z - 10 + Math.sin(a) * R);
          o.look.set(c.x, 0, c.z - 12);
        },
      },
      {
        caption: t('停车场：取货顾客停进专用车位，交付员推车送到车边'),
        dur: 9,
        pose: (k, o) => {
          const e = smooth(k);
          // 从停车场外侧推近线上取货车位，背景是交付门口
          o.pos.set(ps.x + 26 - 12 * e, 14 - 6 * e, ps.z - 30 + 10 * e);
          o.look.set(ps.x + 2 * e, 0.8, ps.z - 3);
        },
      },
      {
        caption: t('拣货员推着拣货车按路线拣货，一车同时拣几张订单'),
        dur: 10,
        pose: (k, o) => {
          if (!chase.id || !framePositions.has(chase.id)) chase.id = pickers.find((id) => framePositions.has(id)) ?? '';
          const p = chase.id ? framePositions.get(chase.id) : undefined;
          if (p) {
            const a = 0.8 + k * 0.9;
            o.look.set(p.x, p.y + 1, p.z);
            o.pos.set(p.x + Math.sin(a) * 14, p.y + 11, p.z + Math.cos(a) * 14);
          } else {
            o.pos.set(minX + (maxX - minX) * (0.2 + 0.5 * k), 9, minZ + 4);
            o.look.set(minX + (maxX - minX) * (0.25 + 0.5 * k), 0, (minZ + maxZ) / 2);
          }
        },
      },
      {
        caption: t('暂存区：拣好的框按温区放进暂存格位，等顾客到店'),
        dur: 9,
        pose: (k, o) => {
          const e = smooth(k);
          o.look.set(sp.x + 6, 0.8, sp.y + 5);
          o.pos.set(sp.x - 10 + 4 * e, 16 - 8 * e, sp.y - 12 + 2 * e);
        },
      },
      {
        caption: t('后仓：卡车到货，叉车把托盘放进货架，夜班再推到货架上架'),
        dur: 10,
        pose: (k, o) => {
          const e = smooth(k);
          const zc = (b.zone.z0 + b.zone.z1) / 2;
          o.look.set((b.zone.x0 + b.zone.x1) / 2 + 6 * e, 1.5, zc);
          o.pos.set(b.mainAisleX + 8 - 4 * e, 12 - 4 * e, b.zone.z0 - 8 + 4 * e);
        },
      },
      {
        caption: t('周边道路：信号灯、左转箭头、变道和过马路的行人'),
        dur: 10,
        pose: (k, o) => {
          const x = ix ? ix.x : c.x;
          const a = -0.9 + k * 0.7;
          o.look.set(x, 1, roadZ);
          o.pos.set(x + Math.sin(a) * 34, 16 - 6 * k, roadZ + Math.cos(a) * -34);
        },
      },
      {
        caption: t('俯瞰：所有人和车都来自同一次仿真，数据面板里的每个数字都能在画面中找到'),
        dur: 10,
        pose: (k, o) => {
          const a = k * 0.6;
          o.look.set(c.x, 0, c.z - 15);
          o.pos.set(c.x + Math.sin(a) * 8, R * 1.15, c.z - 15 - Math.cos(a) * 8 - 6);
        },
      },
    ];
    // lang 变化时重新生成字幕
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, model, site, timeline, lang]);

  const state = useRef({ i: 0, t: 0, from: { pos: new THREE.Vector3(), look: new THREE.Vector3() } as Pose, cur: { pos: new THREE.Vector3(), look: new THREE.Vector3() } as Pose, started: false });
  const saved = useRef<{ view: string; speed: number; playing: boolean } | null>(null);

  // 开始 / 结束：切换视角、倍速，记下原来的设置
  useEffect(() => {
    const app = useApp.getState();
    if (on) {
      saved.current = { view: app.view, speed: clock.speed, playing: clock.playing };
      if (app.view !== '3d') app.setView('3d');
      setSpeed(30);
      setPlaying(true);
      state.current.started = false;
    } else if (saved.current) {
      const s = saved.current;
      saved.current = null;
      setSpeed(s.speed);
      setPlaying(s.playing);
      if (s.view !== useApp.getState().view) useApp.getState().setView(s.view as never);
      useApp.setState({ cinematicCaption: undefined });
    }
  }, [on]);

  useFrame((_, delta) => {
    if (!on || !shots.length || !(camera instanceof THREE.PerspectiveCamera)) return;
    const st = state.current;
    if (controls) controls.enabled = false;
    if (!st.started) {
      // 从当前镜头位置平滑过渡到第一个镜头
      st.started = true;
      st.i = 0;
      st.t = 0;
      st.from.pos.copy(camera.position);
      st.from.look.copy(controls?.target ?? new THREE.Vector3());
      useApp.setState({ cinematicCaption: { text: shots[0]?.caption ?? '', i: 0, n: shots.length } });
    }
    st.t += Math.min(delta, 0.1);
    let shot = shots[st.i] as Shot;
    if (st.t > shot.dur) {
      // 下一个镜头：当前画面作为过渡起点
      st.from.pos.copy(st.cur.pos);
      st.from.look.copy(st.cur.look);
      st.i = (st.i + 1) % shots.length;
      st.t = 0;
      shot = shots[st.i] as Shot;
      useApp.setState({ cinematicCaption: { text: shot.caption, i: st.i, n: shots.length } });
    }
    shot.pose(Math.min(1, st.t / shot.dur), st.cur);
    const w = smooth(Math.min(1, st.t / BLEND));
    camera.position.lerpVectors(st.from.pos, st.cur.pos, w);
    const look = st.from.look.clone().lerp(st.cur.look, w);
    camera.lookAt(look);
    if (controls) controls.target.copy(look);
    if (w >= 1) {
      st.cur.pos.copy(camera.position);
    }
  });

  // 退出时把镜头控制还给用户
  useEffect(() => {
    if (!on && controls) controls.enabled = true;
  }, [on, controls]);

  return null;
}
