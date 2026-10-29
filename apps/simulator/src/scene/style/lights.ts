import * as THREE from 'three';
import { toonGradient } from '../toon';

/**
 * 夜里会亮的灯的共享材质：灯罩玻璃、灯笼、窗户。白天是普通的浅色，
 * 入夜后亮度超过 1（高画质下泛光通道会给它们加上光晕）。由 DayNight 每帧调用 updateLights。
 */

export const lampGlass = new THREE.MeshBasicMaterial({ color: '#f3efe2' });
export const lanternGlass = new THREE.MeshBasicMaterial({ color: '#f6e7c8' });
/** 金属灯杆（深灰绿） */
export const lampMetal = new THREE.MeshToonMaterial({ color: '#3d4a47', gradientMap: toonGradient() });

const DAY_LAMP = new THREE.Color('#e9e6dc');
const NIGHT_LAMP = new THREE.Color('#ffe4b0').multiplyScalar(3.4);
const DAY_LANTERN = new THREE.Color('#f1dfbd');
const NIGHT_LANTERN = new THREE.Color('#ffc978').multiplyScalar(3.0);

export function updateLights(night: number): void {
  lampGlass.color.copy(DAY_LAMP).lerp(NIGHT_LAMP, night);
  lanternGlass.color.copy(DAY_LANTERN).lerp(NIGHT_LANTERN, night);
}
