import { Component, lazy, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { sceneAccess } from './capture';
import { useApp } from '../state/store';
import { advance, clock } from '../state/clock';
import { env, updateEnv } from './environment';
import { fixedWeather, weatherAt, weatherPlan } from '../sim/weatherPlan';
import { Ground } from './Ground';
import { Shelves } from './Shelves';
import { Staging } from './Staging';
import { Associates, BackroomCrew, framePositions } from './Actors';
import { LiveFleet } from './LiveFleet';
import { DockDoors } from './DockDoors';
import { Areas } from './Areas';
import { Warehouse } from './Warehouse';
import { Shoppers } from './InStoreShoppers';
import { Surroundings } from './Surroundings';
import { CameraRig, cameraState } from './CameraRig';
import { armMenu } from './contextTarget';
import { AutoServiceCenters } from './AutoService';
import { Facilities } from './Facilities';
import { Handles } from './Handles';
import { Storefront } from './Storefront';
import { Connectors } from './Connectors';
import { BuildingShell } from './BuildingShell';
import { IncidentFx } from './IncidentFx';
import { WeatherFx } from './WeatherFx';
import { Fixtures } from './Fixtures';
import { Vehicles } from './Fleet';
import { StreetPedestrians } from './StreetPedestrians';
import { CartAttendants } from './CartAttendants';
import { StoreDetails } from './StoreDetails';
import { CinematicDirector } from './Cinematic';
import { LiveOverlay } from './LiveOverlay';
import { TwinSensors } from './TwinSensors';
import { EditPlane, EditPreview } from './EditTools';
import { SCENE } from './palette';
import { t } from '../i18n';
import { installToonStyle } from './style/toonStyle';
import { styleUniforms } from './style/uniforms';
import { PostFX } from './style/PostFX';
import { SkyDome } from './style/Sky';
import { updateLights } from './style/lights';

// 卡通着色补丁要在任何材质编译之前装好
installToonStyle();

/** 开发时地址栏带 ?gallery：在场景上方摆出所有车型和小船（检查外形用，不进入正式构建） */
const VehicleGallery = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('gallery') ? lazy(() => import('./debug/VehicleGallery')) : null;

/** 昼夜光照：太阳方向与颜色、环境光、天空颜色随仿真时钟变化；高画质时太阳投射阴影 */
function DayNight() {
  const sun = useRef<THREE.DirectionalLight>(null);
  const amb = useRef<THREE.AmbientLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const scene = useThree((s) => s.scene);
  const getThree = useThree((s) => s.get);
  const geo = useApp((s) => s.simGeo);
  const quality = useApp((s) => s.quality);
  const target = useMemo(() => new THREE.Object3D(), []);
  const { center, half } = useMemo(() => {
    const f = geo.floors[0];
    const maxZ = f?.maxZ ?? 40;
    const c = new THREE.Vector3((geo.lot.minX + geo.lot.maxX) / 2, 0, (geo.lot.edgeZ + maxZ) / 2);
    return { center: c, half: Math.max(geo.lot.maxX - geo.lot.minX, maxZ - geo.lot.edgeZ) / 2 + 25 };
  }, [geo]);
  const season = useApp((s) => s.site.season ?? 'autumn');
  const weather = useApp((s) => s.site.weather ?? 'clear');
  const siteSeed = useApp((s) => s.site.seed);
  const fog = useMemo(() => new THREE.Fog('#c9cfd6', 0, 0), []);
  // 「多变」天气：按季节和种子生成一天的计划，逐帧取当前时刻的状态
  const plan = useMemo(() => (weather === 'dynamic' ? weatherPlan(siteSeed, season) : undefined), [weather, siteSeed, season]);
  const state = useMemo(() => fixedWeather(weather === 'dynamic' ? 'clear' : weather), [weather]);
  useFrame((root) => {
    updateEnv(clock.time, env, season, plan ? weatherAt(plan, clock.time, state) : state);
    const s = sun.current;
    const a = amb.current;
    const h = hemi.current;
    if (!s || !a || !h) return;
    target.position.copy(center);
    target.updateMatrixWorld();
    s.position.copy(center).addScaledVector(env.sunDir, 180);
    s.color.copy(env.sunColor);
    s.intensity = env.sunIntensity;
    a.color.copy(env.ambientColor);
    a.intensity = env.ambient;
    h.color.copy(env.hemiSky);
    h.groundColor.copy(env.hemiGround);
    h.intensity = env.hemiIntensity;
    scene.background = env.background;
    // 共享的风格参数：天色、太阳、轮廓光、风、雨雪
    const u = styleUniforms;
    u.swTime.value = root.clock.elapsedTime;
    u.swSkyTop.value.copy(env.skyTop);
    u.swHorizon.value.copy(env.background);
    u.swSunDir.value.copy(env.sunDir);
    u.swSunColor.value.copy(env.sunColor);
    u.swNight.value = env.night;
    u.swRain.value = env.rain;
    u.swSnow.value = env.snowCover;
    u.swWind.value = 0.8 + 1.2 * Math.min(1, env.rain + env.snow * 0.6);
    u.swRimColor.value.copy(env.rim);
    updateLights(env.night);
    u.swRimStrength.value = 0.3 * (1 - 0.4 * env.night) * (1 - 0.5 * Math.min(1, env.cloud + env.rain));
    const cam = getThree().camera;
    const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
    // 正交相机离场景很远（约 300 米），雾的距离要加上这段，否则整个画面都是雾
    const base = ortho ? cam.position.distanceTo(new THREE.Vector3(cameraState.target.x, 0, cameraState.target.z)) : 0;
    if (env.fogFar > 0) {
      fog.color.copy(env.background);
      fog.near = base + env.fogNear;
      fog.far = base + env.fogFar;
      scene.fog = fog;
    } else if (!ortho) {
      // 透视视角：远处一点淡淡的空气透视，远景融进地平线
      fog.color.copy(env.background);
      fog.near = 240;
      fog.far = 1700;
      scene.fog = fog;
    } else scene.fog = null;
  });
  return (
    <>
      <primitive object={target} />
      <ambientLight ref={amb} />
      <hemisphereLight ref={hemi} />
      <directionalLight
        ref={sun}
        target={target}
        castShadow={quality === 'high'}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={20}
        shadow-camera-far={420}
        shadow-bias={-0.0004}
        shadow-normalBias={0.05}
      />
    </>
  );
}

/** 登记 three.js 状态；地址栏带 ?debug 时也挂到 window.__sw.three 便于调试 */
function DebugBridge() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    sceneAccess.get = get;
    const w = window as unknown as { __sw?: Record<string, unknown> };
    if (w.__sw) w.__sw.three = get;
  }, [get]);
  return null;
}

/** 透明地面：右键空白处时登记「地面上的一点」 */
function ContextGround() {
  const mode = useApp((s) => s.mode);
  if (mode !== 'sim') return null;
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.005, 0]}
      onContextMenu={(e) => armMenu({ type: 'ground', x: e.point.x, z: e.point.z }, e)}
      // 地面也接收单击：点空白处取消选中（原来由 onPointerMissed 处理）
      onClick={(e) => {
        e.stopPropagation();
        useApp.getState().select(undefined);
      }}
    >
      <planeGeometry args={[2000, 2000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** 每帧推进播放时钟 */
function ClockDriver() {
  useFrame((_, delta) => advance(Math.min(delta, 0.1)));
  return null;
}

/** 选中标记：跟随移动中的员工和车辆 */
function SelectionMarker() {
  const ref = useRef<THREE.Mesh>(null);
  const selection = useApp((s) => s.selection);
  const geo = useApp((s) => s.geo);
  const model = useApp((s) => s.model);

  const staticPos = useMemo(() => {
    if (!selection) return undefined;
    if (selection.type === 'run') {
      const run = model.config.layout.runs.find((r) => r.id === selection.id);
      if (!run) return undefined;
      return { x: (run.start.x + run.end.x) / 2, y: geo.floorY.get(run.floorId) ?? 0, z: (run.start.y + run.end.y) / 2, r: 3 };
    }
    if (selection.type === 'staging') {
      const racks = geo.racks.filter((r) => r.tempZone === selection.id || (selection.id === 'RECOVERY' && r.purpose === 'RECOVERY') || (selection.id === 'OVERSIZED' && r.purpose === 'OVERSIZED'));
      if (!racks.length) return undefined;
      const x = racks.reduce((a, r) => a + r.x, 0) / racks.length;
      const z = racks.reduce((a, r) => a + r.z, 0) / racks.length;
      return { x, y: 0, z, r: 3 };
    }
    if (selection.type === 'facility') {
      const f = geo.facilities.find((x) => x.id === selection.id);
      if (!f) return undefined;
      return { x: (f.x0 + f.x1) / 2, y: 0, z: (f.z0 + f.z1) / 2, r: Math.max(f.x1 - f.x0, f.z1 - f.z0) * 0.6 };
    }
    return undefined;
  }, [selection, geo, model]);

  useFrame(({ clock: c }) => {
    const m = ref.current;
    if (!m) return;
    let p: { x: number; y: number; z: number } | undefined;
    let r = 0.9;
    if (selection && (selection.type === 'associate' || selection.type === 'car')) {
      p = framePositions.get(selection.id);
      r = selection.type === 'car' ? 2.6 : 0.8;
    } else if (staticPos) {
      p = staticPos;
      r = staticPos.r;
    }
    if (!p) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set(p.x, p.y + 0.06, p.z);
    const s = r * (1 + Math.sin(c.elapsedTime * 4) * 0.06);
    m.scale.set(s, s, s);
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.85, 1, 40]} />
      <meshBasicMaterial color={SCENE.select} transparent opacity={0.9} side={THREE.DoubleSide} depthTest={false} />
    </mesh>
  );
}

/** 场景出错时显示提示，不让整个界面崩溃 */
class SceneBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  override render() {
    if (this.state.error) {
      // 浏览器建不了 WebGL（关掉了硬件加速、没有显卡驱动，持续集成里的 Firefox 也是这样）：说明原因，不显示技术报错
      const noWebGL = /webgl context/i.test(this.state.error);
      return (
        <div className="overlay-note error">
          {noWebGL ? t('这个浏览器现在不能显示三维场景（WebGL 不可用，可能关掉了硬件加速），其余功能照常可以用。') : t('三维场景出错：{0}', this.state.error)}
          <button onClick={() => this.setState({ error: undefined })}>{t('重试')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Scene() {
  const quality = useApp((s) => s.quality);
  // 门店实况：只显示实时数据时隐藏仿真的员工、顾客和车辆
  const liveOnly = useApp((s) => s.liveView && s.live.status !== 'off');
  const dpr: [number, number] = quality === 'high' ? [1, 2] : quality === 'medium' ? [1, 1.5] : [1, 1];
  return (
    <SceneBoundary>
    <Canvas
      key={quality}
      dpr={dpr}
      shadows={quality === 'high'}
      // 中、高画质由后期处理抗锯齿（离屏缓冲没有多重采样），画布本身不需要
      gl={{ antialias: false }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.NeutralToneMapping;
        gl.toneMappingExposure = 1.0;
      }}
      onPointerMissed={() => useApp.getState().mode === 'sim' && useApp.getState().select(undefined)}
    >
      <DayNight />
      <SkyDome clouds={quality !== 'low'} />
      {quality !== 'low' && <PostFX quality={quality} />}
      <DebugBridge />
      <ContextGround />
      <ClockDriver />
      <CameraRig />
      <Surroundings />
      <Ground />
      <Shelves />
      <Fixtures />
      <Staging />
      {!liveOnly && <Associates />}
      {!liveOnly && <BackroomCrew />}
      <Areas />
      <DockDoors />
      <Warehouse />
      {!liveOnly && <Shoppers />}
      <AutoServiceCenters />
      <Facilities />
      <Storefront />
      <Connectors />
      <BuildingShell />
      <IncidentFx />
      <WeatherFx />
      {/* 门店实况：只显示背景车流和实况里的车辆（顾客、配送司机、到货车） */}
      {liveOnly ? <Vehicles trafficOnly /> : <Vehicles />}
      {liveOnly && <LiveFleet />}
      <StreetPedestrians />
      {!liveOnly && <CartAttendants />}
      <StoreDetails />
      <CinematicDirector />
      <LiveOverlay />
      <TwinSensors />
      <SelectionMarker />
      <EditPlane />
      <EditPreview />
      <Handles />
      {VehicleGallery && (
        <Suspense fallback={null}>
          <VehicleGallery />
        </Suspense>
      )}
    </Canvas>
    </SceneBoundary>
  );
}
