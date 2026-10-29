import * as THREE from 'three';

/**
 * 画面风格的共享参数：所有卡通材质、水面、植被和天空引用同一组 uniform 对象，
 * 每帧由 DayNight / Sky 按昼夜和天气更新一次，改一处全场景生效。
 */
export const styleUniforms = {
  /** 轮廓光（逆光边缘的天空色） */
  swRimColor: { value: new THREE.Color('#dfe9ff') },
  swRimStrength: { value: 0.28 },
  swRimPower: { value: 3.2 },
  /** 真实时间（秒），驱动风、水波、云 */
  swTime: { value: 0 },
  /** 风力：0 静止，1 微风，2 大风（雨雪天） */
  swWind: { value: 1 },
  /** 天空地平线颜色（水面倒影、远山的空气透视） */
  swHorizon: { value: new THREE.Color('#cfe7f5') },
  swSkyTop: { value: new THREE.Color('#4aa3e6') },
  swSunDir: { value: new THREE.Vector3(0.4, 0.8, -0.45).normalize() },
  swSunColor: { value: new THREE.Color('#fff3dd') },
  /** 0 白天 … 1 深夜 */
  swNight: { value: 0 },
  /** 雨（水面涟漪）与积雪 */
  swRain: { value: 0 },
  swSnow: { value: 0 },
  /** 地面与草坪的颜色（随季节、积雪变化，由 Surroundings 每帧更新） */
  swGround: { value: new THREE.Color('#a9cf7a') },
  swGrass: { value: new THREE.Color('#9ccb6e') },
};

export type StyleUniforms = typeof styleUniforms;
