import * as THREE from 'three';

/**
 * 夜里的灯光：路灯、停车场的灯杆、物流园的高杆灯亮起来——灯头一团光晕（加色混合的点，大小按距离缩放，远处至少 2 像素，
 * 从远处看城区是一片灯火），灯下的地面一圈光（加色混合的圆，中间亮、边上淡下去）。白天不画；按地块分块（看不到的块不画，
 * 地上的光圈离镜头 2.5 公里以外不画）。
 */
export interface LightSpot {
  /** 灯头的位置 */
  x: number;
  y: number;
  z: number;
  /** 地上光圈的半径（米）；0 不画光圈 */
  r: number;
  /** 地面的高度 */
  g: number;
}

// 渲染器用的是对数深度缓冲：着色器要带上 logdepthbuf 的几段，不然深度对不上、被地面挡住
const GLOW_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uScale;
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // 往镜头挪一点：光晕不被灯头自己挡掉半边
  mv.xyz += normalize(-mv.xyz) * 1.5;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * uScale / max(1.0, -mv.z), 2.0, 48.0);
  #include <logdepthbuf_vertex>
}`;
const GLOW_FS = `
#include <logdepthbuf_pars_fragment>
uniform float uNight;
uniform vec3 uColor;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 3.5) * (1.0 - smoothstep(0.7, 1.0, d));
  gl_FragColor = vec4(uColor * a * uNight, 1.0);
}`;
const POOL_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 p = vec4(position, 1.0);
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
  #include <logdepthbuf_vertex>
}`;
const POOL_FS = `
#include <logdepthbuf_pars_fragment>
uniform float uNight;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(vUv - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.0, 1.0, d);
  gl_FragColor = vec4(uColor * a * a * uNight * 0.42, 1.0);
}`;

export class NightLights {
  readonly group = new THREE.Group();
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly poolMat: THREE.ShaderMaterial;
  readonly count: number;

  constructor(spots: readonly LightSpot[], cell = 600) {
    this.group.name = 'night-lights';
    this.count = spots.length;
    const night = { value: 0 };
    const color = { value: new THREE.Color('#ffd9a3') };
    const scale = { value: 600 };
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uNight: night, uColor: color, uScale: scale, uSize: { value: 5 } },
      vertexShader: GLOW_VS,
      fragmentShader: GLOW_FS,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { uNight: night, uColor: color },
      vertexShader: POOL_VS,
      fragmentShader: POOL_FS,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const buckets = new Map<string, LightSpot[]>();
    for (const s of spots) {
      const k = `${Math.floor(s.x / cell)},${Math.floor(s.z / cell)}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(s);
    }
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const m4 = new THREE.Matrix4();
    for (const list of buckets.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list.flatMap((s) => [s.x, s.y, s.z]), 3));
      g.computeBoundingSphere();
      const pts = new THREE.Points(g, this.glowMat);
      pts.name = 'lamp-glow';
      pts.frustumCulled = true;
      // 点的大小按这次画面的镜头算（监控画面、对比回放的镜头不一样）
      pts.onBeforeRender = (renderer, _s, cam) => {
        const c = cam as THREE.PerspectiveCamera;
        const h = renderer.getRenderTarget()?.height ?? renderer.getDrawingBufferSize(TMP2).y;
        scale.value = h / (2 * Math.tan(((c.fov ?? 50) * Math.PI) / 360));
      };
      this.group.add(pts);
      const pools = list.filter((s) => s.r > 0);
      if (!pools.length) continue;
      const im = new THREE.InstancedMesh(plane, this.poolMat, pools.length);
      pools.forEach((s, i) => {
        m4.makeScale(s.r * 2, 1, s.r * 2).setPosition(s.x, s.g + 0.2, s.z);
        im.setMatrixAt(i, m4);
      });
      im.computeBoundingSphere();
      im.name = 'lamp-pools';
      im.userData.lodFar = 2500;
      im.renderOrder = 1;
      this.group.add(im);
    }
    this.group.visible = false;
  }

  /** 天黑的程度（0 白天 … 1 夜里）：傍晚开始亮 */
  setNight(n: number): void {
    const k = Math.max(0, Math.min(1, (n - 0.25) / 0.45));
    (this.glowMat.uniforms.uNight as THREE.IUniform).value = k;
    this.group.visible = k > 0.01;
  }
}
const TMP2 = new THREE.Vector2();
