import * as THREE from 'three';

/**
 * 远近分级：大批量的实例（楼、树、路灯、行道树、夜里的灯光）按地块分成几块 InstancedMesh，每块有自己的包围球，
 * 镜头看不到的块不画（three.js 的视锥剔除）；标了 lodFar 的块（行道树、路灯这些小东西）镜头离得比这远就整块不画。
 * 每次画之前按这次画面的镜头决定（主画面、对比回放的另一半、监控画面各按各的镜头）。
 */
export interface ChunkItem {
  m: THREE.Matrix4;
  c?: THREE.Color;
}

/** 一批实例按 cell 米一格分块；far：镜头离这块多远就不画（不给就只做视锥剔除） */
export function chunkInstances(geo: THREE.BufferGeometry, mat: THREE.Material, list: readonly ChunkItem[], name: string, o: { cell?: number; cast?: boolean; receive?: boolean; far?: number } = {}): THREE.Group {
  const cell = o.cell ?? 400;
  const group = new THREE.Group();
  group.name = name;
  const buckets = new Map<string, ChunkItem[]>();
  for (const it of list) {
    const e = it.m.elements;
    const k = `${Math.floor((e[12] as number) / cell)},${Math.floor((e[14] as number) / cell)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(it);
  }
  for (const items of buckets.values()) {
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => {
      im.setMatrixAt(i, it.m);
      if (it.c) im.setColorAt(i, it.c);
    });
    im.castShadow = !!o.cast;
    im.receiveShadow = !!o.receive;
    im.name = name;
    im.computeBoundingSphere();
    if (o.far) im.userData.lodFar = o.far;
    group.add(im);
  }
  return group;
}

interface LodItem {
  o: THREE.Object3D;
  c: THREE.Vector3;
  r: number;
  far: number;
}

/** 场景里标了 lodFar 的块：每次画之前按镜头的远近开关。返回重新收集的函数（场景里换了东西以后调） */
export function attachLod(scene: THREE.Scene): () => void {
  let items: LodItem[] = [];
  const collect = () => {
    items = [];
    scene.updateMatrixWorld();
    scene.traverse((o) => {
      const far = o.userData.lodFar as number | undefined;
      if (!far) return;
      // 实例的包围球在 InstancedMesh 上，点云的在几何体上
      const bs = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).boundingSphere : ((o as THREE.Points).geometry?.boundingSphere ?? null);
      if (!bs) return;
      items.push({ o, c: bs.center.clone().applyMatrix4(o.matrixWorld), r: bs.radius, far });
    });
  };
  const cam = new THREE.Vector3();
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (...args: Parameters<THREE.Scene['onBeforeRender']>) {
    prev.apply(this, args);
    args[2].getWorldPosition(cam);
    for (const it of items) it.o.visible = cam.distanceTo(it.c) - it.r < it.far;
  };
  collect();
  return collect;
}
