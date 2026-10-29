import * as THREE from 'three';
import { toonGradient } from '../toon';
import { patchToonShader } from '../style/toonStyle';
import { styleUniforms } from '../style/uniforms';
import { NOISE_GLSL } from '../style/glsl';

/**
 * 地形与草坪的卡通材质：在全局卡通着色的基础上，草地颜色按世界坐标叠加几层噪声
 * （大块的深浅、偏暖的斑块、细碎的颗粒），像手绘的草地；颜色本身来自 swGround / swGrass（季节、积雪）。
 * 地形的岸边顶点色（沙土、湿泥、水下）按 aGrass 与草地混合。
 */

const WORLD_VARYING = /* glsl */ `
varying vec3 vSwWorld;
`;

const WORLD_VERTEX = /* glsl */ `
#include <project_vertex>
{
  vec4 swW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    swW = instanceMatrix * swW;
  #endif
  vSwWorld = ( modelMatrix * swW ).xyz;
}
`;

const GRASS_FN = /* glsl */ `
vec3 swGrassColor( vec3 base, vec3 p ) {
  vec3 c = base * ( 0.86 + 0.26 * swFbm3( p.xz * 0.045 ) );
  c = mix( c, c * vec3( 1.07, 1.06, 0.84 ), smoothstep( 0.56, 0.74, swNoise( p.xz * 0.07 + 3.1 ) ) );
  c = mix( c, c * vec3( 0.9, 1.0, 1.05 ), smoothstep( 0.6, 0.8, swNoise( p.xz * 0.11 - 7.7 ) ) * 0.6 );
  return c * ( 0.94 + 0.12 * swNoise( p.xz * 0.9 ) );
}
`;

function injectWorld(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${WORLD_VARYING}`).replace('#include <project_vertex>', WORLD_VERTEX);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${WORLD_VARYING}\n${NOISE_GLSL}\n${GRASS_FN}`);
}

/** 地形：顶点色 + aGrass */
export function makeTerrainMaterial(): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: '#ffffff', vertexColors: true, gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    injectWorld(shader);
    shader.uniforms.swGround = styleUniforms.swGround;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGrass;\nvarying float vSwGrass;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvSwGrass = aGrass;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 swGround;\nvarying float vSwGrass;')
      .replace(
        '#include <color_fragment>',
        `#if defined( USE_COLOR )
          diffuseColor.rgb *= mix( vColor, swGrassColor( swGround, vSwWorld ), vSwGrass );
        #endif`,
      );
  };
  m.customProgramCacheKey = () => 'sw-terrain-1';
  return m;
}

/** 草坪、绿化带、停车场的绿岛（实例化的长方体） */
export function makeGrassMaterial(): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    injectWorld(shader);
    shader.uniforms.swGrass = styleUniforms.swGrass;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 swGrass;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= swGrassColor( swGrass, vSwWorld );');
  };
  m.customProgramCacheKey = () => 'sw-grass-1';
  return m;
}

/**
 * 带平铺贴图的卡通材质：贴图坐标取世界坐标的 xz（米）除以 tile，长方体缩放后贴图也不会被拉伸。
 * 用于沥青、人行道、广场、木板、石墙顶面等。
 */
export function makeWorldTexMaterial(map: THREE.Texture, tile: number, color: THREE.ColorRepresentation = '#ffffff'): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color, map, gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    injectWorld(shader);
    shader.uniforms.swTile = { value: 1 / tile };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float swTile;')
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vSwWorld.xz * swTile );
          diffuseColor *= sampledDiffuseColor;
        #endif`,
      );
  };
  m.customProgramCacheKey = () => `sw-worldtex-${tile}`;
  return m;
}

/**
 * 三向投影贴图：按表面朝向选择贴图坐标（顶面用 xz，侧面用 zy 或 xy），
 * 竖直的石墙、桥墩、台阶都不会出现拉伸的条纹。
 */
export function makeTriplanarMaterial(map: THREE.Texture, tile: number, color: THREE.ColorRepresentation = '#ffffff'): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color, map, gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    injectWorld(shader);
    shader.uniforms.swTile = { value: 1 / tile };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSwN;')
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        {
          vec3 swN = objectNormal;
          #ifdef USE_INSTANCING
            swN = mat3( instanceMatrix ) * swN;
          #endif
          vSwN = normalize( mat3( modelMatrix ) * swN );
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float swTile;\nvarying vec3 vSwN;')
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec3 swA = abs( vSwN );
          vec2 swUv = swA.y > 0.6 ? vSwWorld.xz : ( swA.x > swA.z ? vSwWorld.zy : vSwWorld.xy );
          diffuseColor *= texture2D( map, swUv * swTile );
        #endif`,
      );
  };
  m.customProgramCacheKey = () => `sw-triplanar-${tile}`;
  return m;
}

/**
 * 随风摆动的植物（芦苇、草丛、树冠）：顶点按高度偏移，越高摆得越多；
 * 不同位置的相位不同，像一阵阵风吹过。sway 为摆幅（米，按 1 米高计）。
 */
export function makeWindMaterial(opts: { color?: THREE.ColorRepresentation; vertexColors?: boolean; sway: number; height: number; side?: THREE.Side }): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: opts.color ?? '#ffffff', vertexColors: opts.vertexColors ?? false, gradientMap: toonGradient(), side: opts.side ?? THREE.FrontSide });
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    shader.uniforms.swTime = styleUniforms.swTime;
    shader.uniforms.swWind = styleUniforms.swWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float swTime;\nuniform float swWind;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 swBase = vec3( 0.0 );
          #ifdef USE_INSTANCING
            swBase = instanceMatrix[ 3 ].xyz;
          #endif
          swBase += modelMatrix[ 3 ].xyz;
          float swH = clamp( position.y / ${opts.height.toFixed(3)}, 0.0, 1.5 );
          float swPh = swTime * 1.7 + swBase.x * 0.21 + swBase.z * 0.17;
          float swGust = 0.6 + 0.4 * sin( swTime * 0.5 + swBase.x * 0.05 );
          vec2 swOff = vec2( sin( swPh ), cos( swPh * 0.8 + 1.3 ) * 0.6 ) * ${opts.sway.toFixed(3)} * swH * swH * swWind * swGust;
          transformed.xz += swOff;
        }`,
      );
  };
  m.customProgramCacheKey = () => `sw-wind-${opts.sway}-${opts.height}-${opts.vertexColors ? 1 : 0}`;
  return m;
}
