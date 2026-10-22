import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { cameraState } from './CameraRig';
import { env } from './environment';

const BOX = 70;
const HEIGHT = 45;
const RAIN_N = 2600;
const SNOW_N = 3200;

function seedsFor(n: number): Float32Array {
  const seeds = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    seeds[i * 3] = (Math.random() - 0.5) * 2 * BOX;
    seeds[i * 3 + 1] = Math.random() * HEIGHT;
    seeds[i * 3 + 2] = (Math.random() - 0.5) * 2 * BOX;
  }
  return seeds;
}

/**
 * 雨、雪：在镜头目标点附近的一个盒子里循环落下（按真实时间下落，暂停时静止）。
 * 粒子数量随强度变化：多变天气时雨会慢慢下大、慢慢停下。雨用短线段，雪用缓慢飘落的点。
 */
export function WeatherFx() {
  const weather = useApp((s) => s.site.weather ?? 'clear');
  const active = weather === 'rain' || weather === 'snow' || weather === 'dynamic';
  const group = useRef<THREE.Group>(null);
  const rainMat = useRef<THREE.LineBasicMaterial>(null);

  const rain = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_N * 6), 3));
    return { geometry: g, seeds: seedsFor(RAIN_N) };
  }, []);
  const snow = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_N * 3), 3));
    return { geometry: g, seeds: seedsFor(SNOW_N) };
  }, []);

  useFrame((_, delta) => {
    const grp = group.current;
    if (!grp || !active) return;
    grp.position.set(cameraState.target.x, 0, cameraState.target.z);
    const dt = clock.playing ? Math.min(delta, 0.05) : 0;
    const t = performance.now() / 1000;
    // 雨
    const rn = Math.round(RAIN_N * Math.min(1, env.rain));
    if (rn > 0) {
      const pos = rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const s = rain.seeds;
      for (let i = 0; i < rn; i++) {
        let y = (s[i * 3 + 1] as number) - dt * 26;
        if (y < 0) y += HEIGHT;
        s[i * 3 + 1] = y;
        const x = s[i * 3] as number;
        const z = s[i * 3 + 2] as number;
        arr[i * 6] = x;
        arr[i * 6 + 1] = y;
        arr[i * 6 + 2] = z;
        arr[i * 6 + 3] = x + 0.12;
        arr[i * 6 + 4] = y + 0.9;
        arr[i * 6 + 5] = z;
      }
      pos.needsUpdate = true;
    }
    rain.geometry.setDrawRange(0, rn * 2);
    if (rainMat.current) rainMat.current.opacity = 0.25 + 0.2 * Math.min(1, env.rain);
    // 雪
    const sn = Math.round(SNOW_N * Math.min(1, env.snow));
    if (sn > 0) {
      const pos = snow.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const s = snow.seeds;
      for (let i = 0; i < sn; i++) {
        let y = (s[i * 3 + 1] as number) - dt * 1.4;
        if (y < 0) y += HEIGHT;
        s[i * 3 + 1] = y;
        arr[i * 3] = (s[i * 3] as number) + Math.sin(t * 0.8 + i) * 0.6;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = (s[i * 3 + 2] as number) + Math.cos(t * 0.6 + i * 0.7) * 0.6;
      }
      pos.needsUpdate = true;
    }
    snow.geometry.setDrawRange(0, sn);
  });

  if (!active) return null;
  return (
    <group ref={group}>
      <lineSegments geometry={rain.geometry} frustumCulled={false}>
        <lineBasicMaterial ref={rainMat} color="#c9d6e2" transparent opacity={0.45} />
      </lineSegments>
      <points geometry={snow.geometry} frustumCulled={false}>
        <pointsMaterial color="#ffffff" size={0.28} sizeAttenuation transparent opacity={0.9} />
      </points>
    </group>
  );
}
