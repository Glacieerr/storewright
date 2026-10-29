import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { fixedWeather, type WeatherState } from '../sim/weatherPlan';

/**
 * 昼夜：由仿真时钟决定太阳方向、光照颜色强度和天空颜色。
 * 每帧由 DayNight 组件更新一次，路灯、车灯、窗户等直接读取 env.night。
 */
export interface Env {
  /** 0 = 白天，1 = 深夜 */
  night: number;
  /** 0…1，日出日落时的暖色程度 */
  golden: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  ambient: number;
  ambientColor: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** 地平线颜色（也是雾色） */
  background: THREE.Color;
  /** 天顶颜色 */
  skyTop: THREE.Color;
  /** 轮廓光颜色 */
  rim: THREE.Color;
  /** 雾的起止距离（0 表示无雾） */
  fogNear: number;
  fogFar: number;
  /** 当前主要天气 */
  weather: string;
  season: string;
  /** 天气强度（0–1）：雨、雪、雾、云量、路面湿度、积雪 */
  rain: number;
  snow: number;
  fog: number;
  cloud: number;
  wet: number;
  snowCover: number;
}

export const env: Env = {
  night: 0,
  golden: 0,
  sunDir: new THREE.Vector3(0.4, 0.8, -0.45).normalize(),
  sunColor: new THREE.Color('#fff6e8'),
  sunIntensity: 1.5,
  ambient: 0.95,
  ambientColor: new THREE.Color('#ffffff'),
  hemiSky: new THREE.Color('#ffffff'),
  hemiGround: new THREE.Color('#d8d2c4'),
  hemiIntensity: 0.55,
  background: new THREE.Color('#cde6f6'),
  skyTop: new THREE.Color('#3f97e0'),
  rim: new THREE.Color('#e6eeff'),
  fogNear: 0,
  fogFar: 0,
  weather: 'clear',
  season: 'autumn',
  rain: 0,
  snow: 0,
  fog: 0,
  cloud: 0,
  wet: 0,
  snowCover: 0,
};

/** 各季节的日出、日落时间（小时，假设的中纬度地区） */
const DAYLIGHT: Record<string, [number, number]> = { spring: [6.3, 19.4], summer: [5.6, 20.6], autumn: [6.8, 18.6], winter: [7.3, 17.1] };
const OVERCAST = new THREE.Color('#c9cfd6');
const RAINY = new THREE.Color('#9aa6b2');
const OVERCAST_TOP = new THREE.Color('#a3afbb');
const RAINY_TOP = new THREE.Color('#7c8794');

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 卡通风格的光照：暖色阳光、偏冷的环境光（暗面带一点蓝紫），天空蓝而通透
const C = {
  daySun: new THREE.Color('#fff2dc'),
  goldSun: new THREE.Color('#ffa862'),
  moon: new THREE.Color('#9db4e0'),
  dayAmb: new THREE.Color('#dfe6ff'),
  nightAmb: new THREE.Color('#7385b8'),
  daySky: new THREE.Color('#d6e4ff'),
  nightSky: new THREE.Color('#34446a'),
  dayGround: new THREE.Color('#e0d6bd'),
  nightGround: new THREE.Color('#1f2633'),
  dayBg: new THREE.Color('#cfe6f5'),
  duskBg: new THREE.Color('#f7c7a2'),
  nightBg: new THREE.Color('#1b2948'),
  dayTop: new THREE.Color('#3d93de'),
  duskTop: new THREE.Color('#5a6fb6'),
  nightTop: new THREE.Color('#070e26'),
  dayRim: new THREE.Color('#eaf1ff'),
  goldRim: new THREE.Color('#ffd0a3'),
  nightRim: new THREE.Color('#6f82b8'),
};

/** 日出日落随季节变化；阴天、雨雪、雾天太阳更弱、天空更灰 */
export function updateEnv(timeSec: number, out: Env = env, season = 'autumn', weather: WeatherState = fixedWeather('clear')): Env {
  const h = (((timeSec / 3600) % 24) + 24) % 24;
  const [rise, set] = DAYLIGHT[season] ?? [6.5, 19.5];
  const day = smooth(rise - 0.6, rise + 0.6, h) * (1 - smooth(set - 0.6, set + 0.6, h));
  out.night = 1 - day;
  out.weather = weather.kind;
  out.season = season;
  out.rain = weather.rain;
  out.snow = weather.snow;
  out.fog = weather.fog;
  out.cloud = weather.cloud;
  out.wet = weather.wet;
  out.snowCover = weather.snowCover;
  const p = Math.min(1, Math.max(0, (h - rise) / (set - rise)));
  const el = Math.max(0.12, Math.sin(Math.PI * p) * 1.05);
  out.golden = day * (1 - smooth(0.15, 0.45, Math.sin(Math.PI * p)));
  const az = Math.PI * p;
  if (day > 0.02) out.sunDir.set(-Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el) - 0.25).normalize();
  else out.sunDir.set(0.3, 0.9, -0.3).normalize();
  out.sunColor.copy(C.daySun).lerp(C.goldSun, out.golden).lerp(C.moon, out.night);
  out.sunIntensity = 1.5 * day * (1 - 0.35 * out.golden) + 0.32 * out.night;
  out.ambient = 0.95 * day + 0.42 * out.night;
  out.ambientColor.copy(C.dayAmb).lerp(C.nightAmb, out.night);
  out.hemiSky.copy(C.daySky).lerp(C.nightSky, out.night);
  out.hemiGround.copy(C.dayGround).lerp(C.nightGround, out.night);
  out.hemiIntensity = 0.55 * day + 0.5 * out.night;
  out.background.copy(C.dayBg).lerp(C.duskBg, out.golden).lerp(C.nightBg, out.night);
  out.skyTop.copy(C.dayTop).lerp(C.duskTop, out.golden).lerp(C.nightTop, out.night);
  out.rim.copy(C.dayRim).lerp(C.goldRim, out.golden).lerp(C.nightRim, out.night);
  // 天气：云越厚阳光越弱、天空越灰；雨雾雪拉近雾的距离（按强度连续变化，多变天气时平滑过渡）
  const w = weather;
  const dim = Math.max(0.3, 1 - 0.5 * w.cloud - 0.18 * w.rain - 0.25 * w.fog);
  if (dim < 1) {
    out.sunIntensity *= dim;
    out.golden *= dim;
    out.ambient += (1 - dim) * 0.35 * day;
    out.background.lerp(OVERCAST, 0.7 * day * Math.min(1, w.cloud));
    out.background.lerp(RAINY, 0.7 * day * Math.min(1, w.rain));
    out.skyTop.lerp(OVERCAST_TOP, 0.85 * day * Math.min(1, w.cloud));
    out.skyTop.lerp(RAINY_TOP, 0.85 * day * Math.min(1, w.rain));
  }
  const near: number[] = [];
  const far: number[] = [];
  if (w.fog > 0.02) {
    near.push(25 + (1 - w.fog) * 175);
    far.push(160 + (1 - w.fog) * 640);
  }
  if (w.rain > 0.02) {
    near.push(120 + (1 - w.rain) * 280);
    far.push(420 + (1 - w.rain) * 780);
  }
  if (w.snow > 0.02) {
    near.push(90 + (1 - w.snow) * 310);
    far.push(360 + (1 - w.snow) * 840);
  }
  out.fogNear = near.length ? Math.min(...near) : 0;
  out.fogFar = far.length ? Math.min(...far) : 0;
  return out;
}

/**
 * 夜间室内照明：给店内物体的材质加一点随夜色增强的自发光，
 * 看起来像店里亮着灯（three.js 的光源不能只照亮室内，用自发光近似）。
 */
export function useNightGlow<T extends THREE.Material & { emissive: THREE.Color }>(strength = 0.3, tint = '#fff1d6'): React.RefObject<T> {
  const ref = useRef<T>(null);
  const c = useMemo(() => new THREE.Color(tint), [tint]);
  useFrame(() => {
    ref.current?.emissive.copy(c).multiplyScalar(env.night * strength);
  });
  return ref;
}
