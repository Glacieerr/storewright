import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { sceneAccess } from '../capture';
import { env } from '../environment';
import type { Quality } from '../../state/store';

/**
 * 后期处理：场景先画到带深度的离屏缓冲，再依次
 * 1. 风格化：按深度找出轮廓（物体外沿）和折线（棱角、墙角），描上深色线；轻微的饱和度、冷暖分离和暗角；
 * 2. 泛光（高画质）：路灯、车灯、招牌等高亮处的光晕；
 * 3. 色调映射与 sRGB 输出；
 * 4. 抗锯齿（高画质 SMAA，中画质 FXAA）。
 * 低画质不走后期，直接渲染。截图（capture.ts）也走同一条流水线。
 */

const StylizeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.5 },
    uFar: { value: 3000 },
    uOrtho: { value: false },
    uPxScale: { value: 0.001 },
    uThickness: { value: 1 },
    uOutline: { value: 0.85 },
    uOutlineTint: { value: new THREE.Color(0.24, 0.2, 0.3) },
    uFadeNear: { value: 160 },
    uFadeFar: { value: 520 },
    uSaturation: { value: 1.1 },
    uShadowTint: { value: new THREE.Color(0.93, 0.97, 1.08) },
    uHighTint: { value: new THREE.Color(1.04, 1.01, 0.95) },
    uVignette: { value: 0.16 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uNear;
    uniform float uFar;
    uniform bool uOrtho;
    uniform float uPxScale;
    uniform float uThickness;
    uniform float uOutline;
    uniform vec3 uOutlineTint;
    uniform float uFadeNear;
    uniform float uFadeFar;
    uniform float uSaturation;
    uniform vec3 uShadowTint;
    uniform vec3 uHighTint;
    uniform float uVignette;
    varying vec2 vUv;

    // 深度缓冲值 → 到相机的距离（米）
    float linZ( float d ) {
      if ( uOrtho ) return uNear + d * ( uFar - uNear );
      return ( uNear * uFar ) / ( uFar - d * ( uFar - uNear ) );
    }

    void main() {
      vec4 col = texture2D( tDiffuse, vUv );
      vec2 px = uThickness / uResolution;
      float dC = texture2D( tDepth, vUv ).x;
      float edge = 0.0;
      if ( dC < 0.99999 ) {
        float dL = texture2D( tDepth, vUv - vec2( px.x, 0.0 ) ).x;
        float dR = texture2D( tDepth, vUv + vec2( px.x, 0.0 ) ).x;
        float dU = texture2D( tDepth, vUv + vec2( 0.0, px.y ) ).x;
        float dD = texture2D( tDepth, vUv - vec2( 0.0, px.y ) ).x;
        float zC = linZ( dC );
        // 原始深度在平面上随屏幕坐标线性变化（透视投影下也是），二阶差分只在棱角和外沿处不为零
        float dzdd = uOrtho ? ( uFar - uNear ) : zC * zC * ( uFar - uNear ) / ( uNear * uFar );
        float pw = ( uOrtho ? uPxScale : zC * uPxScale ) * uThickness;
        float sx = ( dL + dR - 2.0 * dC ) * dzdd / pw;
        float sy = ( dU + dD - 2.0 * dC ) * dzdd / pw;
        float jump = max( max( abs( linZ( dL ) - zC ), abs( linZ( dR ) - zC ) ), max( abs( linZ( dU ) - zC ), abs( linZ( dD ) - zC ) ) ) / pw;
        float convex = max( sx, sy );
        float concave = max( -sx, -sy );
        // 外沿（深度跳变大）画在近的一侧；折线两侧都画，但外沿远的一侧不画，线条保持一像素宽
        float sil = smoothstep( 3.0, 6.0, jump );
        float crease = max( smoothstep( 0.28, 0.7, convex ), smoothstep( 0.28, 0.7, concave ) * ( 1.0 - sil ) );
        // 缩小到看全景时，细小的折线变淡，只留外沿
        float zoomFade = 1.0 - smoothstep( 0.22, 0.6, pw );
        edge = max( smoothstep( 3.0, 6.0, convex ) , crease * mix( 0.35, 1.0, zoomFade ) );
        if ( ! uOrtho ) edge *= 1.0 - smoothstep( uFadeNear, uFadeFar, zC );
        edge *= uOutline;
      }
      col.rgb = mix( col.rgb, col.rgb * uOutlineTint, edge );

      // 调色：饱和度、暗部偏冷亮部偏暖、暗角
      float lum = dot( col.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      col.rgb = max( mix( vec3( lum ), col.rgb, uSaturation ), 0.0 );
      col.rgb *= mix( uShadowTint, vec3( 1.0 ), smoothstep( 0.0, 0.32, lum ) );
      col.rgb *= mix( vec3( 1.0 ), uHighTint, smoothstep( 0.35, 1.0, lum ) );
      vec2 v = ( vUv - 0.5 ) * vec2( 1.0, 0.82 );
      col.rgb *= 1.0 - uVignette * smoothstep( 0.32, 0.78, length( v ) * 1.35 );
      gl_FragColor = col;
    }
  `,
};

class StylizePass extends Pass {
  readonly uniforms = THREE.UniformsUtils.clone(StylizeShader.uniforms) as typeof StylizeShader.uniforms;
  private readonly quad: FullScreenQuad;
  constructor() {
    super();
    const material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: StylizeShader.vertexShader, fragmentShader: StylizeShader.fragmentShader, depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(material);
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.uResolution.value.set(readBuffer.width, readBuffer.height);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  override dispose(): void {
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

/** 正交相机：每个像素对应的世界尺寸（米） */
function orthoPixel(cam: THREE.OrthographicCamera, heightPx: number): number {
  return (cam.top - cam.bottom) / cam.zoom / Math.max(1, heightPx);
}

export function PostFX({ quality }: { quality: Quality }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const retina = dpr >= 1.5;

  const fx = useMemo(() => {
    const w = Math.max(1, Math.round(size.width * dpr));
    const h = Math.max(1, Math.round(size.height * dpr));
    const depthTex = () => {
      const d = new THREE.DepthTexture(w, h);
      d.type = THREE.FloatType;
      return d;
    };
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: depthTex() });
    target.texture.name = 'sw.scene';
    const composer = new EffectComposer(gl, target);
    // 复制出来的第二个缓冲和第一个共用同一张深度贴图（three.js 按 source 共享），会形成读写回环，换成独立的一张
    composer.renderTarget2.depthTexture = depthTex();
    const render = new RenderPass(scene, camera);
    const stylize = new StylizePass();
    composer.addPass(render);
    composer.addPass(stylize);
    let bloom: UnrealBloomPass | undefined;
    if (quality === 'high') {
      bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.55, 1.12);
      composer.addPass(bloom);
    }
    composer.addPass(new OutputPass());
    // 抗锯齿：标准屏用 SMAA（高画质），高分屏像素够细，用一遍 FXAA 就够了（省两遍全屏绘制）
    let fxaa: ShaderPass | undefined;
    if (quality === 'high' && !retina) composer.addPass(new SMAAPass(w, h));
    else {
      fxaa = new ShaderPass(FXAAShader);
      composer.addPass(fxaa);
    }
    return { composer, render, stylize, bloom, fxaa };
    // 画质切换时整个画布会重建（Scene 里的 key），这里只跟着画布走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, quality, retina]);

  useEffect(() => {
    fx.composer.setPixelRatio(dpr);
    fx.composer.setSize(size.width, size.height);
    fx.fxaa?.material.uniforms.resolution?.value.set(1 / Math.max(1, size.width * dpr), 1 / Math.max(1, size.height * dpr));
  }, [fx, size.width, size.height, dpr]);

  useEffect(() => {
    sceneAccess.render = () => fx.composer.render(0);
    return () => {
      if (sceneAccess.render) sceneAccess.render = undefined;
      fx.composer.dispose();
    };
  }, [fx]);

  useFrame((state, delta) => {
    const cam = state.camera;
    fx.render.camera = cam;
    const u = fx.stylize.uniforms;
    const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
    const hPx = size.height * dpr;
    u.uOrtho.value = ortho;
    if (ortho) {
      const oc = cam as THREE.OrthographicCamera;
      u.uNear.value = oc.near;
      u.uFar.value = oc.far;
      u.uPxScale.value = orthoPixel(oc, hPx);
    } else {
      const pc = cam as THREE.PerspectiveCamera;
      u.uNear.value = pc.near;
      u.uFar.value = pc.far;
      u.uPxScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / Math.max(1, hPx);
    }
    // 高分屏上线条略粗一点，和标准屏看起来一样
    u.uThickness.value = Math.max(1, dpr * 0.8);
    // 夜里线条淡一些（画面本来就暗），雨雾天也淡一些
    u.uOutline.value = 0.85 * (1 - 0.35 * env.night) * (1 - 0.4 * Math.max(env.fog, env.rain * 0.5));
    if (fx.bloom) fx.bloom.strength = 0.32 + 0.4 * env.night;
    fx.composer.render(delta);
  }, 1);

  return null;
}
