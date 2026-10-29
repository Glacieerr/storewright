import * as THREE from 'three';
import { styleUniforms } from './uniforms';

/**
 * 全局卡通着色：给所有 MeshToonMaterial 加上
 * - 柔和的两段明暗（渐变贴图见 toon.ts）；
 * - 轮廓光：朝天一侧的掠射边缘泛出天空色，曲面（人物、车辆、树冠）立体感更强。
 * 通过原型上的 onBeforeCompile 注入，所有现有材质不用改代码就能用上；
 * 共享的 uniform 对象（styleUniforms）每帧更新，昼夜变化同步到所有材质。
 */

const RIM_PARS = /* glsl */ `
uniform vec3 swRimColor;
uniform float swRimStrength;
uniform float swRimPower;
`;

const RIM = /* glsl */ `
vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
{
  vec3 swView = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vViewPosition );
  float swRim = pow( 1.0 - saturate( dot( normal, swView ) ), swRimPower );
  // 只在朝上、朝天的一侧出现（像天光勾出的亮边），贴地的一面不亮
  vec3 swUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float swSky = smoothstep( -0.2, 0.6, dot( normal, swUp ) );
  outgoingLight += swRimColor * ( 0.35 + 0.65 * diffuseColor.rgb ) * swRim * swSky * swRimStrength;
}
`;

/** 给卡通材质的着色器打补丁（自定义 onBeforeCompile 的材质也可以先调用它） */
export function patchToonShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.swRimColor = styleUniforms.swRimColor;
  shader.uniforms.swRimStrength = styleUniforms.swRimStrength;
  shader.uniforms.swRimPower = styleUniforms.swRimPower;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
    .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', RIM);
}

let installed = false;

/** 在创建任何材质之前调用一次 */
export function installToonStyle(): void {
  if (installed) return;
  installed = true;
  const proto = THREE.MeshToonMaterial.prototype as THREE.MeshToonMaterial;
  proto.onBeforeCompile = function (shader) {
    patchToonShader(shader);
  };
  proto.customProgramCacheKey = function () {
    return 'sw-toon-1';
  };
}
