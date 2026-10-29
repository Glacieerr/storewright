import * as THREE from 'three';
import { styleUniforms } from '../style/uniforms';
import { NOISE_GLSL } from '../style/glsl';

/**
 * 卡通风格的水面（不需要反射贴图）：
 * - 颜色随离岸距离由浅绿松石色过渡到深蓝绿；
 * - 两层错开流动的噪声做出水纹，河里沿水流方向流动；
 * - 菲涅尔：斜着看时映出天空的地平线色；太阳方向的高光点；
 * - 岸边一圈白色泡沫，外面还有一道一道向岸边推进的浪线；
 * - 下雨时水面出现一圈圈涟漪；夜里变暗，天色变化时一起变化。
 * 顶点属性：aSdf（到水边线的距离，水里为正）、aFlow（流速，米/秒）。
 */

const VERT = /* glsl */ `
attribute float aSdf;
attribute vec2 aFlow;
attribute float aFoam;
varying float vSdf;
varying vec2 vFlow;
varying float vFoam;
varying vec3 vWorld;
#include <common>
#include <fog_pars_vertex>
void main() {
  vSdf = aSdf;
  vFlow = aFlow;
  vFoam = aFoam;
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uDepthRange;
uniform float uFoamWidth;
uniform float uWaves;
uniform vec3 swHorizon;
uniform vec3 swSkyTop;
uniform vec3 swSunDir;
uniform vec3 swSunColor;
uniform float swNight;
uniform float swTime;
uniform float swRain;
uniform float swSnow;
varying float vSdf;
varying vec2 vFlow;
varying float vFoam;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>
${NOISE_GLSL}

float rainRings( vec2 p, float t ) {
  vec2 cell = floor( p );
  float acc = 0.0;
  for ( int j = -1; j <= 1; j ++ )
  for ( int i = -1; i <= 1; i ++ ) {
    vec2 c = cell + vec2( float( i ), float( j ) );
    vec2 o = swHash22( c );
    float ph = fract( t * ( 0.6 + 0.5 * o.x ) + o.y );
    float d = length( p - c - o );
    float r = ph * 0.9;
    acc += ( 1.0 - ph ) * smoothstep( 0.06, 0.0, abs( d - r ) );
  }
  return acc;
}

void main() {
  float s = vSdf;
  if ( s < -0.35 ) discard;
  vec2 p = vWorld.xz;
  float t = swTime;
  vec2 drift = vFlow * t;
  float depthK = smoothstep( 0.0, uDepthRange, s );
  vec3 col = mix( uShallow, uDeep, depthK );
  // 水纹：两层噪声，一层随水流漂移
  float n1 = swNoise( p * 0.32 - drift * 0.32 + vec2( t * 0.025, 0.0 ) );
  float n2 = swNoise( p * 0.75 - drift * 0.75 + vec2( 0.0, t * 0.04 ) + 11.0 );
  float n3 = swNoise( p * 1.9 - drift * 1.9 + vec2( t * 0.09, -t * 0.05 ) + 3.0 );
  vec3 N = normalize( vec3( ( n1 - 0.5 ) * 0.22 + ( n3 - 0.5 ) * 0.08, 1.0, ( n2 - 0.5 ) * 0.22 + ( n3 - 0.5 ) * 0.06 ) );
  vec3 V = normalize( cameraPosition - vWorld );
  // 菲涅尔：映出天色
  float fres = pow( 1.0 - max( dot( V, N ), 0.0 ), 3.0 );
  vec3 sky = mix( swHorizon, swSkyTop, 0.35 );
  col = mix( col, sky, clamp( 0.1 + fres * 0.6, 0.0, 0.7 ) );
  // 卡通水纹：细细的亮线（噪声的等值线），近处清楚、远处淡出
  float nn = n1 * 0.55 + n2 * 0.45;
  float band = smoothstep( 0.6, 0.625, nn ) * ( 1.0 - smoothstep( 0.625, 0.655, nn ) );
  col += vec3( 0.85, 0.95, 1.0 ) * band * 0.1 * ( 1.0 - swNight * 0.7 );
  // 波峰略深、波谷略亮，水面有起伏感
  col *= 0.94 + 0.12 * n2;
  // 太阳高光：一颗颗闪烁的亮点
  vec3 R = reflect( -V, N );
  float spec = pow( max( dot( R, normalize( swSunDir ) ), 0.0 ), 90.0 );
  float glint = smoothstep( 0.3, 0.55, spec * ( 0.6 + 0.8 * n3 ) );
  col += swSunColor * glint * 1.6 * ( 1.0 - swNight ) * ( 1.0 - 0.6 * swRain );
  // 岸边泡沫与向岸推进的浪线
  float fn = swNoise( p * 1.6 + vec2( t * 0.12, t * 0.07 ) );
  float edge = 1.0 - smoothstep( 0.0, uFoamWidth, s + ( fn - 0.5 ) * 0.25 );
  float waveCoord = s * 2.4 - t * 0.9 + swNoise( p * 0.25 ) * 5.0;
  float waveLine = smoothstep( 0.86, 0.97, sin( waveCoord ) ) * ( 1.0 - smoothstep( 0.3, 2.6, s ) ) * smoothstep( 0.3, 0.6, fn ) * uWaves;
  float foam = max( edge * smoothstep( 0.3, 0.5, fn + edge * 0.45 ), waveLine * 0.8 );
  // 流动的河面上还有一些顺流的白色细纹
  float streak = smoothstep( 0.78, 0.86, swNoise( vec2( p.x * 0.9, p.y * 0.25 ) - drift * vec2( 0.9, 0.25 ) ) ) * length( vFlow ) * 0.35;
  foam = max( foam, streak );
  // 跌水下方翻起的白沫：细碎的泡沫顺流散开
  float bub = swNoise( p * 4.2 - drift * 2.6 ) * 0.6 + swNoise( p * 9.0 - drift * 3.5 + 5.0 ) * 0.4;
  foam = max( foam, vFoam * smoothstep( 0.62 - vFoam * 0.35, 0.8 - vFoam * 0.3, bub ) );
  col = mix( col, vec3( 0.95, 0.98, 1.0 ), clamp( foam, 0.0, 1.0 ) * 0.92 );
  if ( swRain > 0.02 ) col += vec3( 0.8, 0.9, 1.0 ) * rainRings( p * 1.3, t ) * 0.35 * swRain;
  // 夜里变暗；冬天积雪时水面偏灰
  col *= mix( 1.0, 0.32, swNight );
  col = mix( col, col * 0.85 + vec3( 0.08, 0.09, 0.1 ), swSnow * 0.5 );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterOptions {
  shallow: THREE.ColorRepresentation;
  deep: THREE.ColorRepresentation;
  depthRange: number;
  foamWidth: number;
  waves: number;
}

export function makeWaterMaterial(o: WaterOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uShallow: { value: new THREE.Color(o.shallow) },
        uDeep: { value: new THREE.Color(o.deep) },
        uDepthRange: { value: o.depthRange },
        uFoamWidth: { value: o.foamWidth },
        uWaves: { value: o.waves },
      },
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
  });
}

/** 合并后的 uniforms 会被复制一份；共享的风格参数要在复制之后再接上 */
export function linkStyle(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  for (const k of ['swHorizon', 'swSkyTop', 'swSunDir', 'swSunColor', 'swNight', 'swTime', 'swRain', 'swSnow'] as const) m.uniforms[k] = styleUniforms[k];
  return m;
}

const CASCADE_FRAG = /* glsl */ `
uniform float swTime;
uniform float swNight;
uniform vec3 swHorizon;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  // 跌水：沿 v 方向（向下）快速流动的白色水帘，中间透出一点水色
  float n = swNoise( vec2( vUv.x * 18.0, vUv.y * 3.0 - swTime * 3.2 ) );
  float m = swNoise( vec2( vUv.x * 7.0 + 3.0, vUv.y * 1.5 - swTime * 2.1 ) );
  vec3 water = mix( vec3( 0.36, 0.72, 0.74 ), swHorizon, 0.25 );
  float white = smoothstep( 0.35, 0.75, n * 0.6 + m * 0.4 + vUv.y * 0.35 );
  vec3 col = mix( water, vec3( 0.97, 0.99, 1.0 ), white );
  col *= mix( 1.0, 0.35, swNight );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function makeCascadeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { swTime: styleUniforms.swTime, swNight: styleUniforms.swNight, swHorizon: styleUniforms.swHorizon },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: CASCADE_FRAG,
    side: THREE.DoubleSide,
  });
}
