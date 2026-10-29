import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Building, SiteLayout } from '../site';
import { toonGradient } from '../toon';
import { patchToonShader } from '../style/toonStyle';
import { styleUniforms } from '../style/uniforms';
import { NOISE_GLSL } from '../style/glsl';

/**
 * 周边建筑（细节适度）：
 * - 外墙用程序化立面：按楼层和开间画出窗户（窗框、玻璃里映着天色），商铺一楼是整片橱窗；
 *   入夜后一半左右的窗户亮起暖光（高画质下有光晕）；
 * - 住宅是出檐的两坡屋顶（红瓦、棕瓦、石板灰等几种）和烟囱；平顶楼有女儿墙压顶和屋顶设备；
 * - 加油站雨棚。
 */

const ROOFS = ['#b5523b', '#8a5a48', '#5f6f7d', '#9a4a3a', '#56705f', '#a8643f', '#6d6a75'];

const FACADE_VERT_PARS = /* glsl */ `
attribute float aKind;
attribute float aSeed;
attribute float aH;
varying float vKind;
varying float vSeed;
varying float vH;
varying vec3 vSwWorld;
varying vec3 vSwN;
`;

const FACADE_FRAG_PARS = /* glsl */ `
uniform float swNight;
varying float vKind;
varying float vSeed;
varying float vH;
varying vec3 vSwWorld;
varying vec3 vSwN;
vec3 swWinEmit = vec3( 0.0 );
${NOISE_GLSL}
`;

const FACADE_COLOR = /* glsl */ `
#include <color_fragment>
if ( abs( vSwN.y ) < 0.5 ) {
  float along = abs( vSwN.x ) > 0.5 ? vSwWorld.z : vSwWorld.x;
  float y = vSwWorld.y;
  float floorH = vKind < 0.5 ? 2.9 : 3.3;
  float spacing = vKind < 0.5 ? 2.6 : ( vKind < 1.5 ? 2.3 : 3.1 );
  float base = vKind < 0.5 ? 0.7 : 0.9;
  float cellU = floor( along / spacing );
  float row = floor( ( y - base ) / floorH );
  vec2 f = vec2( fract( along / spacing ), fract( ( y - base ) / floorH ) );
  bool band = y > base && y < vH - 0.8;
  vec2 hw = vKind < 0.5 ? vec2( 0.26, 0.3 ) : ( vKind < 1.5 ? vec2( 0.3, 0.3 ) : vec2( 0.34, 0.28 ) );
  vec2 d = abs( f - vec2( 0.5, 0.5 ) ) - hw;
  float win = band && max( d.x, d.y ) < 0.0 ? 1.0 : 0.0;
  float frame = band && max( d.x, d.y ) < 0.045 && win < 0.5 ? 1.0 : 0.0;
  float sill = band && abs( f.y - ( 0.5 - hw.y - 0.06 ) ) < 0.035 && abs( f.x - 0.5 ) < hw.x + 0.08 ? 1.0 : 0.0;
  // 商铺一楼：通长橱窗和招牌带
  if ( vKind > 1.5 && y < 3.3 ) {
    float g = y > 0.35 && y < 2.55 && abs( fract( along / 4.0 ) - 0.5 ) < 0.46 ? 1.0 : 0.0;
    win = g;
    frame = y > 0.3 && y < 2.62 && win < 0.5 ? 1.0 : 0.0;
    sill = y > 2.75 && y < 3.2 ? 1.0 : 0.0;
  }
  float h = swHash12( vec2( cellU, row ) + vSeed * 37.0 );
  vec3 glass = mix( vec3( 0.3, 0.4, 0.5 ), vec3( 0.66, 0.78, 0.88 ), clamp( f.y * 1.2 - 0.1, 0.0, 1.0 ) );
  glass = mix( glass, vec3( 0.95, 0.97, 1.0 ), smoothstep( 0.85, 0.95, fract( f.x * 1.3 + f.y * 0.8 ) ) * 0.35 );
  diffuseColor.rgb = mix( diffuseColor.rgb, glass * mix( 1.0, 0.3, swNight ), win );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.94, 0.93, 0.9 ), max( frame, sill ) * 0.85 );
  float lit = step( vKind > 1.5 ? 0.15 : 0.45, h ) * smoothstep( 0.35, 0.8, swNight );
  swWinEmit = mix( vec3( 1.0, 0.78, 0.48 ), vec3( 1.0, 0.92, 0.72 ), h ) * 2.4 * lit * win;
  // 墙脚一圈深色勒脚
  diffuseColor.rgb *= y < 0.45 ? 0.82 : 1.0;
}
`;

function facadeMaterial(): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonGradient() });
  m.onBeforeCompile = (shader) => {
    patchToonShader(shader);
    shader.uniforms.swNight = styleUniforms.swNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACADE_VERT_PARS}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vKind = aKind;
        vSeed = aSeed;
        vH = aH;
        {
          vec4 w = vec4( transformed, 1.0 );
          vec3 nn = objectNormal;
          #ifdef USE_INSTANCING
            w = instanceMatrix * w;
            nn = mat3( instanceMatrix ) * nn;
          #endif
          vSwWorld = ( modelMatrix * w ).xyz;
          vSwN = normalize( mat3( modelMatrix ) * nn );
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_FRAG_PARS}`)
      .replace('#include <color_fragment>', FACADE_COLOR)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += swWinEmit;');
  };
  m.customProgramCacheKey = () => 'sw-facade-1';
  return m;
}

/** 两坡屋顶：沿 X 方向延伸的三棱柱，底面 1×1，高 1 */
function gableGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(0, 1);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  g.rotateY(Math.PI / 2);
  return g;
}

const tmp = new THREE.Object3D();
const col = new THREE.Color();

function kindOf(b: Building, style: SiteLayout['style']): number {
  if (b.roof === 'gable') return 0;
  if (style === 'urban' && b.h > 7.5) return 1;
  return 2;
}

export function Buildings({ site, snow }: { site: SiteLayout; snow: boolean }) {
  const list = site.buildings;
  const facade = useMemo(() => facadeMaterial(), []);
  const wallGeo = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const n = list.length;
    const kind = new Float32Array(n);
    const seed = new Float32Array(n);
    const hh = new Float32Array(n);
    list.forEach((b, i) => {
      kind[i] = kindOf(b, site.style);
      seed[i] = ((b.x * 7.13 + b.z * 3.71) % 97) / 97;
      hh[i] = b.h;
    });
    g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    g.setAttribute('aH', new THREE.InstancedBufferAttribute(hh, 1));
    return g;
  }, [list, site.style]);
  const roofGeo = useMemo(() => gableGeometry(), []);
  const roofs = useMemo(() => list.filter((b) => b.roof === 'gable'), [list]);
  const flats = useMemo(() => list.filter((b) => b.roof === 'flat'), [list]);
  // 平顶：女儿墙压顶；城市楼房屋顶还有设备箱；住宅有烟囱
  const extras = useMemo(() => {
    const caps: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    const units: Array<{ x: number; y: number; z: number; w: number; h: number; d: number }> = [];
    for (const b of flats) {
      caps.push({ x: b.x, y: b.h + 0.18, z: b.z, w: b.w + 0.3, h: 0.36, d: b.d + 0.3 });
      if (b.w > 12 && b.d > 10) {
        units.push({ x: b.x - b.w * 0.2, y: b.h + 0.6, z: b.z + b.d * 0.15, w: 2.4, h: 1.2, d: 1.8 });
        if (b.h > 9) units.push({ x: b.x + b.w * 0.22, y: b.h + 1.1, z: b.z - b.d * 0.2, w: 2.8, h: 2.2, d: 2.8 });
      }
    }
    for (const b of roofs) {
      const along = b.w >= b.d;
      units.push({ x: b.x + (along ? b.w * 0.28 : b.w * 0.18), y: b.h + Math.min(b.w, b.d) * 0.3, z: b.z + (along ? b.d * 0.18 : b.d * 0.28), w: 0.7, h: Math.min(b.w, b.d) * 0.5, d: 0.7 });
    }
    return { caps, units };
  }, [flats, roofs]);
  const wallRef = useRef<THREE.InstancedMesh>(null);
  const roofRef = useRef<THREE.InstancedMesh>(null);
  const capRef = useRef<THREE.InstancedMesh>(null);
  const unitRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = wallRef.current;
    if (m) {
      list.forEach((b, i) => {
        tmp.position.set(b.x, b.h / 2, b.z);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(b.w, b.h, b.d);
        tmp.updateMatrix();
        m.setMatrixAt(i, tmp.matrix);
        m.setColorAt(i, col.set(b.color));
      });
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
    const r = roofRef.current;
    if (r) {
      roofs.forEach((b, i) => {
        const ridgeX = b.w >= b.d;
        const w = b.w + 0.9;
        const d = b.d + 0.9;
        tmp.position.set(b.x, b.h, b.z);
        tmp.rotation.set(0, ridgeX ? 0 : Math.PI / 2, 0);
        tmp.scale.set(ridgeX ? d : w, Math.min(b.w, b.d) * 0.42, ridgeX ? w : d);
        tmp.updateMatrix();
        r.setMatrixAt(i, tmp.matrix);
        const k = Math.abs(Math.round(b.x * 3 + b.z * 7)) % ROOFS.length;
        col.set(ROOFS[k] as string);
        if (snow) col.set('#f2f5f6');
        r.setColorAt(i, col);
      });
      r.instanceMatrix.needsUpdate = true;
      if (r.instanceColor) r.instanceColor.needsUpdate = true;
      r.computeBoundingSphere();
    }
    for (const [ref, items] of [
      [capRef, extras.caps],
      [unitRef, extras.units],
    ] as const) {
      const mm = ref.current;
      if (!mm) continue;
      items.forEach((b, i) => {
        tmp.position.set(b.x, b.y, b.z);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(b.w, b.h, b.d);
        tmp.updateMatrix();
        mm.setMatrixAt(i, tmp.matrix);
      });
      mm.instanceMatrix.needsUpdate = true;
      mm.computeBoundingSphere();
    }
  }, [list, roofs, extras, snow]);
  const canopy = site.canopies;
  return (
    <group>
      {list.length > 0 && <instancedMesh key={`w${list.length}`} ref={wallRef} args={[wallGeo, facade, list.length]} castShadow receiveShadow />}
      {roofs.length > 0 && (
        <instancedMesh key={`r${roofs.length}`} ref={roofRef} args={[roofGeo, undefined, roofs.length]} castShadow receiveShadow>
          <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      {extras.caps.length > 0 && (
        <instancedMesh key={`c${extras.caps.length}`} ref={capRef} args={[undefined, undefined, extras.caps.length]} castShadow receiveShadow>
          <boxGeometry />
          <meshToonMaterial color={snow ? '#f2f5f6' : '#d9d6cf'} gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      {extras.units.length > 0 && (
        <instancedMesh key={`u${extras.units.length}`} ref={unitRef} args={[undefined, undefined, extras.units.length]} castShadow>
          <boxGeometry />
          <meshToonMaterial color="#b9bec2" gradientMap={toonGradient()} />
        </instancedMesh>
      )}
      {canopy.map((c, i) => (
        <group key={i}>
          <mesh position={[c.x, c.h + 0.3, c.z]} castShadow receiveShadow>
            <boxGeometry args={[c.w, 0.6, c.d]} />
            <meshToonMaterial color="#eef1f3" gradientMap={toonGradient()} />
          </mesh>
          <mesh position={[c.x, c.h + 0.32, c.z]}>
            <boxGeometry args={[c.w + 0.04, 0.22, c.d + 0.04]} />
            <meshToonMaterial color="#d94f3d" gradientMap={toonGradient()} />
          </mesh>
          {[-1, 1].flatMap((sx) =>
            [-1, 1].map((sz) => (
              <mesh key={`${sx}${sz}`} position={[c.x + sx * (c.w / 2 - 2), c.h / 2, c.z + sz * (c.d / 2 - 2)]} castShadow>
                <boxGeometry args={[0.45, c.h, 0.45]} />
                <meshToonMaterial color="#c7cdd2" gradientMap={toonGradient()} />
              </mesh>
            )),
          )}
        </group>
      ))}
    </group>
  );
}
