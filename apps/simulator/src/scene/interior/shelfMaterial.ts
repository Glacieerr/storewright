import * as THREE from 'three';
import { toonGradient } from '../toon';
import { patchToonShader } from '../style/toonStyle';
import { NOISE_GLSL } from '../style/glsl';

/**
 * 货架的程序化外观：每段货架仍是一个实例化长方体（点选、叠加层颜色都不变），
 * 朝通道的两面在着色器里画出层板、价签条和一排排颜色各异的商品（宽窄、高低按哈希变化）；
 * 顶面、端面和踢脚板是叠加层的颜色（温区、热度、存量、选中）。
 * uTint：商品被叠加层颜色染色的程度（看热度、存量时调高，让数据颜色更醒目）。
 */

const VERT_PARS = /* glsl */ `
varying vec3 vShLocal;
varying vec3 vShN;
varying vec3 vShScale;
varying float vShSeed;
`;

const VERT = /* glsl */ `
#include <begin_vertex>
vShLocal = position;
vShN = normal;
#ifdef USE_INSTANCING
  vShScale = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
  vShSeed = fract( sin( dot( instanceMatrix[ 3 ].xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
#else
  vShScale = vec3( 1.0 );
  vShSeed = 0.0;
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform float uTint;
varying vec3 vShLocal;
varying vec3 vShN;
varying vec3 vShScale;
varying float vShSeed;
${NOISE_GLSL}
vec3 swPack( float h ) {
  vec3 c;
  if ( h < 0.12 ) c = vec3( 0.88, 0.28, 0.24 );
  else if ( h < 0.24 ) c = vec3( 0.97, 0.62, 0.2 );
  else if ( h < 0.36 ) c = vec3( 0.98, 0.85, 0.33 );
  else if ( h < 0.48 ) c = vec3( 0.38, 0.7, 0.35 );
  else if ( h < 0.6 ) c = vec3( 0.27, 0.53, 0.82 );
  else if ( h < 0.74 ) c = vec3( 0.96, 0.95, 0.91 );
  else if ( h < 0.86 ) c = vec3( 0.6, 0.4, 0.74 );
  else c = vec3( 0.66, 0.46, 0.3 );
  return pow( c, vec3( 2.2 ) );
}
`;

const FRAG = /* glsl */ `
#include <color_fragment>
{
  vec3 swFrame = diffuseColor.rgb;
  if ( abs( vShN.z ) > 0.5 ) {
    float u = ( vShLocal.x + 0.5 ) * vShScale.x;
    float v = ( vShLocal.y + 0.5 ) * vShScale.y;
    float kick = 0.14;
    if ( v > kick && v < vShScale.y - 0.04 ) {
      float levels = max( 3.0, floor( ( vShScale.y - kick ) / 0.36 ) );
      float lh = ( vShScale.y - kick ) / levels;
      float lv = floor( ( v - kick ) / lh );
      float fv = fract( ( v - kick ) / lh );
      vec3 c = mix( vec3( 0.13, 0.14, 0.16 ), swFrame * 0.5, 0.35 );
      if ( fv < 0.085 ) {
        c = fv > 0.04 ? vec3( 0.93 ) : vec3( 0.66, 0.68, 0.7 );
      } else {
        float fw = 0.15 + 0.17 * swHash12( vec2( lv, vShSeed * 31.0 ) );
        float cu = floor( u / fw );
        float fu = fract( u / fw );
        float hh = swHash12( vec2( cu, lv * 7.0 + vShSeed * 53.0 ) );
        // 同一款商品连着摆几个：按 3 个一组取颜色
        float grp = swHash12( vec2( floor( cu / 3.0 ), lv * 5.0 + vShSeed * 17.0 ) );
        float ph = 0.55 + 0.38 * swHash12( vec2( floor( cu / 3.0 ) * 3.0 + 1.0, lv + vShSeed * 11.0 ) );
        float top = 0.085 + ph * 0.88;
        if ( fu > 0.05 && fu < 0.95 && fv < top ) {
          vec3 pc = swPack( mix( grp, hh, 0.15 ) );
          float t = ( fv - 0.085 ) / ( top - 0.085 );
          float label = step( abs( t - 0.5 ), 0.14 );
          pc = mix( pc, mix( pc, vec3( 1.0 ), 0.6 ), label );
          pc *= 0.82 + 0.18 * t;
          c = pc;
        }
      }
      diffuseColor.rgb = mix( c, swFrame, uTint );
    }
  }
}
`;

export function makeShelfMaterial(): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonGradient() });
  const tint = { value: 0.12 };
  m.userData.tint = tint;
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    shader.uniforms.uTint = tint;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <begin_vertex>', VERT);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_PARS}`).replace('#include <color_fragment>', FRAG);
  };
  m.customProgramCacheKey = () => 'sw-shelf-1';
  return m;
}
