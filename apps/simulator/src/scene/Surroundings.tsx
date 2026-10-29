import { useMemo, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { useSiteLayout } from './useSite';
import { env } from './environment';
import { t } from '../i18n';
import { Slabs } from './street/Slabs';
import { DioramaBase } from './terrain/Diorama';
import { styleUniforms } from './style/uniforms';
import { Terrain, Ponds } from './terrain/Terrain';
import { Bridge } from './terrain/Bridge';
import { Lakeside } from './terrain/Lakeside';
import { makeGrassMaterial } from './terrain/terrainMaterial';
import { Roads, cutAt } from './street/Roads';
import { StreetLights } from './street/StreetLights';
import { Signals } from './street/Signals';
import { Buildings } from './street/Buildings';
import { Trees, type TreeSpec } from './foliage/Trees';
import { Grass } from './foliage/Grass';
import { StreetProps } from './street/StreetProps';
import { BayLamps } from './street/BayLamps';
import { Railway } from './street/Railway';
import { School } from './street/School';
import type { Rect } from './site';
import { GROUND_PALETTE as GROUND, URBAN_GROUND } from './palette';

export { radialTexture } from './street/radial';

/**
 * 店外：沙盘底座（场景只到周边一圈，决策记录 0019）、地形与水系（湖、出海口、跌水、渠道、石拱桥、栈桥码头）、
 * 道路（沥青、喇叭口、人行道、标线、路灯、信号灯）、周边建筑、树木与灌木、施工路段和标签。季节、积雪统一改共享的地面颜色。
 */

const SNOWY = { ground: new THREE.Color('#eef2f3'), grass: new THREE.Color('#e6ecee') };

export function Surroundings() {
  const site = useSiteLayout();
  const geo = useApp((s) => s.simGeo);
  const floor = useApp((s) => s.floor);
  const mode = useApp((s) => s.mode);
  const siteSeed = useApp((s) => s.site.seed);
  const season = useApp((s) => s.site.season ?? 'autumn');
  const quality = useApp((s) => s.quality);
  const lot = geo.lot;
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;

  const dry = useMemo(() => {
    const p = GROUND[season] ?? (GROUND.autumn as { ground: string; grass: string });
    // 城市街区的地面是浅灰的硬质铺地，只有草坪是绿的
    const ground = new THREE.Color(site.style === 'urban' && season !== 'winter' ? URBAN_GROUND : p.ground);
    return { ground, grass: new THREE.Color(p.grass) };
  }, [season, site.style]);

  const [snow, setSnow] = useState(false);
  useFrame(() => {
    const cover = Math.min(1, env.snowCover);
    // 地形、草坪和远处地面的颜色（着色器里再叠加手绘感的深浅变化）
    styleUniforms.swGround.value.copy(dry.ground).lerp(SNOWY.ground, cover);
    styleUniforms.swGrass.value.copy(dry.grass).lerp(SNOWY.grass, cover);
    if (cover > 0.5 !== snow) setSnow(cover > 0.5);
  });

  const grassMaterial = useMemo(() => makeGrassMaterial(), []);
  const grass = useMemo(() => {
    const b = site.water.bridge;
    const cut: Rect = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, w: b.x1 - b.x0, d: b.z1 - b.z0 };
    return cutAt(site.grass, cut);
  }, [site]);
  const islands = useMemo(() => lot.islands.map((i) => ({ ...i })), [lot]);

  // 树木与灌木：原有的树之外，停车场外侧绿化带的树之间种一排灌木，郊区住宅门前也有几丛
  const trees = useMemo<TreeSpec[]>(() => {
    const out: TreeSpec[] = site.trees.map((t) => ({ ...t }));
    const zStrip = (site.roadTopZ + 2.4 + lot.edgeZ) / 2;
    for (let x = lot.minX + 8.5; x < lot.maxX - 4; x += 9) {
      if (lot.perimeterX.some((px) => Math.abs(px - x) < 11) || Math.abs(x - (lot.minX + 16)) < 2.5) continue;
      out.push({ x, z: zStrip, s: 0.9, kind: 'bush' });
    }
    if (site.style === 'suburban') {
      for (const b of site.buildings) {
        if (b.roof !== 'gable') continue;
        const k = Math.abs(Math.round(b.x * 5 + b.z * 3));
        out.push({ x: b.x - b.w / 2 - 0.8, z: b.z + (k % 2 ? 1 : -1) * (b.d / 2 - 1), s: 0.8 + (k % 3) * 0.1, kind: 'bush' });
        if (k % 3 === 0) out.push({ x: b.x + b.w / 2 + 0.8, z: b.z, s: 0.75, kind: 'bush' });
      }
    }
    for (const p of site.water.lamps) out.push({ x: p.x + 1.4, z: p.z + 0.6, s: 0.7, kind: 'bush' });
    return out;
  }, [site, lot]);

  if (!visible) return null;
  return (
    <group>
      <DioramaBase site={site} />
      <Terrain site={site} seed={siteSeed} />
      {site.water.enabled && <Bridge site={site} />}
      {site.water.enabled && <Lakeside site={site} seed={siteSeed} />}
      <Ponds ponds={site.ponds} />
      <Slabs items={grass} y={-0.1} h={0.12} color="#ffffff" receive material={grassMaterial} />
      <Slabs items={islands} y={-0.1} h={0.2} color="#ffffff" receive material={grassMaterial} />
      <Roads site={site} lot={lot} doorX={geo.door.x} />
      <StreetLights lamps={site.lamps} lotEdgeZ={lot.edgeZ} />
      <Signals site={site} />
      <Buildings site={site} snow={snow} />
      <Trees trees={trees} season={season} snow={snow} />
      {quality === 'high' && <Grass site={site} lot={lot} seed={siteSeed} season={season} snow={snow} />}
      <StreetProps site={site} lot={lot} />
      {site.railway && <Railway site={site} />}
      {site.school && <School site={site} />}
      <BayLamps lot={lot} />
      {site.works && (
        <group>
          <Slabs items={site.works.cones.map((c) => ({ x: c.x, z: c.z, w: 0.4, d: 0.4, y: -0.04, h: 0.75, color: '#f07c1f' }))} color="#ffffff" colored />
          <Slabs items={[{ x: site.works.sign.x, z: site.works.sign.z, w: 1.6, d: 0.12, y: 0.4, h: 1.1, color: '#f2c230' }]} color="#ffffff" colored />
          {mode === 'sim' && (
            <Html position={[site.works.sign.x, 2.4, site.works.sign.z]} center className="scene-label works-label">
              {t('前方施工 · 限速')}
            </Html>
          )}
        </group>
      )}
      {mode === 'sim' && (
        <Html position={[lot.pickupSign.x, 2.6, lot.pickupSign.z - 3.2]} center className="scene-label area-label pickup-label">
          <span className="label-full">{t('线上取货 · {0} 个车位', lot.pickupCount)}</span>
          <span className="label-short">{t('线上取货')}</span>
        </Html>
      )}
    </group>
  );
}
