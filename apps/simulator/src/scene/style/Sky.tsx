import { useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { env } from '../environment';
import { styleUniforms } from './uniforms';
import { NOISE_GLSL } from './glsl';

/**
 * 天空与远景：
 * - 天空：画在所有不透明物体之后、只填没有被挡住的像素（深度测试），天顶到地平线的渐变、太阳与光晕、
 *   程序生成的云（朝阳一侧亮、背光一侧暗）、夜里的月亮和星星；
 * - 远山：两圈低多边形山脉，越远越淡（空气透视），颜色跟着天色变化；
 * - 远处地面：场地之外的大片地面，向地平线渐隐，和天空的地平线色接上。
 * 正交视角下没有真正的视线方向，按屏幕位置模拟一点透视，让背景仍然有渐变。
 */

const SKY_VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4( position.xy, 0.999999, 1.0 );
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uF;
uniform vec3 uR;
uniform vec3 uU;
uniform float uKx;
uniform float uKy;
uniform vec3 uGround;
uniform vec3 uMoonDir;
uniform float uCloud;
uniform float uGolden;
uniform float uClouds;
uniform vec3 swSkyTop;
uniform vec3 swHorizon;
uniform vec3 swSunDir;
uniform vec3 swSunColor;
uniform float swNight;
uniform float swTime;
varying vec2 vNdc;
${NOISE_GLSL}
void main() {
  vec3 dir = normalize( uF + uR * vNdc.x * uKx + uU * vNdc.y * uKy );
  float h = dir.y;
  float day = 1.0 - swNight;
  vec3 col = mix( swHorizon, swSkyTop, smoothstep( 0.0, 1.0, pow( clamp( h, 0.0, 1.0 ), 0.5 ) ) );
  // 地平线上的一圈亮带（逆光时更明显）
  vec3 sunD = normalize( swSunDir );
  float toward = max( dot( normalize( vec3( dir.x, 0.0, dir.z ) + 1e-5 ), normalize( vec3( sunD.x, 0.0, sunD.z ) + 1e-5 ) ), 0.0 );
  col += swSunColor * exp( -abs( h ) * 14.0 ) * ( 0.06 + 0.22 * uGolden * toward ) * day;
  col = mix( col, uGround, smoothstep( 0.0, -0.06, h ) );
  float sd = max( dot( dir, sunD ), 0.0 );
  col += swSunColor * ( pow( sd, 1400.0 ) * 8.0 + pow( sd, 90.0 ) * 0.45 + pow( sd, 9.0 ) * 0.1 * ( 0.5 + uGolden ) ) * day * smoothstep( -0.03, 0.02, h );
  float md = max( dot( dir, normalize( uMoonDir ) ), 0.0 );
  col += vec3( 0.86, 0.9, 1.0 ) * ( smoothstep( 0.99952, 0.99968, md ) * 1.5 + pow( md, 260.0 ) * 0.22 ) * swNight;
  if ( swNight > 0.02 && h > 0.0 ) {
    vec2 sp = dir.xz / ( dir.y + 0.4 ) * 150.0;
    vec2 cell = floor( sp );
    float r = swHash12( cell );
    vec2 c = swHash22( cell ) - 0.5;
    float d = length( fract( sp ) - 0.5 - c * 0.6 );
    float star = smoothstep( 0.09, 0.0, d ) * step( 0.982, r );
    float tw = 0.65 + 0.35 * sin( swTime * ( 1.5 + r * 4.0 ) + r * 50.0 );
    col += vec3( 1.0, 0.96, 0.88 ) * star * tw * swNight * smoothstep( 0.02, 0.3, h ) * ( 1.0 - uCloud );
  }
  if ( uClouds > 0.5 && h > 0.0 ) {
    vec2 cp = dir.xz / ( h + 0.1 ) * 1.4 + vec2( swTime * 0.004, swTime * 0.0015 );
    float n = swFbm( cp );
    float cover = mix( 0.57, 0.3, uCloud );
    float dens = smoothstep( cover, cover + 0.2, n );
    float n2 = swFbm( cp + normalize( sunD.xz + 1e-4 ) * 0.07 );
    float lit = clamp( 0.55 + ( n - n2 ) * 7.0, 0.0, 1.0 );
    vec3 cLit = mix( vec3( 1.02 ), swSunColor * 1.1, 0.3 + 0.5 * uGolden );
    vec3 cShadow = mix( swSkyTop, swHorizon, 0.6 ) * mix( 0.88, 0.7, uCloud );
    vec3 cloud = mix( cShadow, cLit, lit ) * mix( 1.0, 0.16, swNight );
    col = mix( col, cloud, dens * smoothstep( 0.0, 0.2, h ) * 0.96 );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();

function skyUniforms(clouds: boolean) {
  return {
    uF: { value: new THREE.Vector3(0, 0, -1) },
    uR: { value: new THREE.Vector3(1, 0, 0) },
    uU: { value: new THREE.Vector3(0, 1, 0) },
    uKx: { value: 1 },
    uKy: { value: 0.5 },
    uGround: { value: new THREE.Color('#9fb39a') },
    uMoonDir: { value: new THREE.Vector3(-0.4, 0.6, 0.5).normalize() },
    uCloud: { value: 0 },
    uGolden: { value: 0 },
    uClouds: { value: clouds ? 1 : 0 },
    swSkyTop: styleUniforms.swSkyTop,
    swHorizon: styleUniforms.swHorizon,
    swSunDir: styleUniforms.swSunDir,
    swSunColor: styleUniforms.swSunColor,
    swNight: styleUniforms.swNight,
    swTime: styleUniforms.swTime,
  };
}

export function SkyDome({ clouds }: { clouds: boolean }) {
  const { material, u } = useMemo(() => {
    const u = skyUniforms(clouds);
    const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, depthWrite: false, depthTest: true, fog: false });
    return { material, u };
  }, [clouds]);
  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  useFrame((state) => {
    const cam = state.camera;
    cam.matrixWorld.extractBasis(_r, _u, _f);
    _f.negate();
    u.uF.value.copy(_f);
    u.uR.value.copy(_r);
    u.uU.value.copy(_u);
    const aspect = state.size.width / Math.max(1, state.size.height);
    const ky = (cam as THREE.PerspectiveCamera).isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov) / 2) : 0.55;
    u.uKy.value = ky;
    u.uKx.value = ky * aspect;
    u.uCloud.value = Math.min(1, env.cloud + 0.6 * env.rain + 0.4 * env.snow + 0.5 * env.fog);
    u.uGolden.value = env.golden;
    u.uGround.value.copy(styleUniforms.swHorizon.value).multiplyScalar(0.82);
    // 月亮在太阳对面
    u.uMoonDir.value.set(-env.sunDir.x, Math.max(0.35, Math.abs(env.sunDir.y)), -env.sunDir.z).normalize();
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={1e6} />;
}
