import { describe, expect, it } from 'vitest';
import { addArea, addDock, addRun, AREA_KINDS, goLiveCheck, backroomLayout, maxDocks, upperStock, yardSettings, DEFAULT_YARD_OFFSET, materializeAreas, moveArea, moveDock, rectsOverlap, removeArea, removeDock, resizeArea, storeAreas, backroomRoute, createTemplate, distributeRuns, fitsInside, formatSlotCode, GENERATOR_PRESETS, generateStoreConfig, moveRuns, moveStaging, pasteRuns, planRun, randomGeneratorParams, rotateRun, runSpan, StoreModel, templateParams, validateStoreConfig, walkSegments } from './index';

describe('门店模板', () => {
  for (const t of ['small', 'medium', 'large'] as const) {
    it(`${t} 模板通过结构与语义校验，所有货位可达`, () => {
      const res = validateStoreConfig(createTemplate(t));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.model.unreachableLocations()).toEqual([]);
        expect(res.model.stagingSlots.length).toBeGreaterThan(0);
      }
    });
  }

  it('家居建材模板（第二个行业）：同一个 schema，没有冷链，沿墙是板材和建材，默认打开包裹中转', () => {
    const c = createTemplate('hardware');
    const res = validateStoreConfig(c);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model.unreachableLocations()).toEqual([]);
    expect(c.industry).toBe('HARDWARE');
    expect(c.catalog.categories.some((x) => x.tempZone !== 'AMBIENT')).toBe(false);
    expect(c.staging.racks.every((r) => r.tempZone === 'AMBIENT')).toBe(true);
    expect(c.layout.runs.find((r) => r.id === 'F1-PRD')?.categoryIds).toEqual(['lumber']);
    expect(c.modules).toMatchObject({ parcelHub: true, mto: false, gm: true });
    expect(c.hours.openMin).toBe(6 * 60);
    // 超市模板不受影响：没有 industry 字段
    expect(createTemplate('medium').industry).toBeUndefined();
  });

  it('大型模板有两层，二楼经电梯可达', () => {
    const m = new StoreModel(createTemplate('large'));
    const f2 = [...m.locations.values()].find((l) => l.floorId === 'F2');
    expect(f2).toBeDefined();
    if (f2) expect(Number.isFinite(m.distance(m.stagingNode, f2.nodeId))).toBe(true);
  });

  it('最短路径的长度等于距离', () => {
    const m = new StoreModel(createTemplate('small'));
    const loc = [...m.locations.values()][50];
    if (!loc) throw new Error('no location');
    const path = m.path(m.stagingNode, loc.nodeId);
    let d = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as number;
      const b = path[i] as number;
      d += m.adjacency[a]?.find((e) => e.to === b)?.w ?? Number.NaN;
    }
    expect(d).toBeCloseTo(m.distance(m.stagingNode, loc.nodeId), 6);
  });

  it('引用不存在的类别时校验失败', () => {
    const cfg = createTemplate('small');
    cfg.layout.runs[0]?.categoryIds.push('does-not-exist');
    const res = validateStoreConfig(cfg);
    expect(res.ok).toBe(false);
  });

  it('两条通道挪得太近时报告货架重叠', () => {
    const cfg = createTemplate('small');
    const a2 = cfg.layout.runs.find((r) => r.id === 'F1-A02');
    const a3 = cfg.layout.runs.find((r) => r.id === 'F1-A03');
    if (!a2 || !a3) throw new Error('template changed');
    a2.start.x = a3.start.x - 1.2;
    a2.end.x = a3.end.x - 1.2;
    const res = validateStoreConfig(cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.message.includes('货架重叠'))).toBe(true);
  });

  it('暂存格位编码可自定义（决策 S-01）', () => {
    expect(formatSlotCode('{zone}-{rack}-{level}-{slot}', { zone: 'AMB', rack: 3, level: 2, slot: 16 }, 2)).toBe('AMB-03-02-16');
    expect(formatSlotCode('{zone}{rack}/{slot}', { zone: 'FRZ', rack: 1, level: 1, slot: 4 }, 3)).toBe('FRZ001/004');
  });

  it('尺寸判断允许旋转', () => {
    expect(fitsInside({ l: 40, w: 27, h: 24 }, { l: 53, w: 35, h: 28 })).toBe(true);
    expect(fitsInside({ l: 60, w: 40, h: 12 }, { l: 53, w: 35, h: 28 })).toBe(false);
  });
});

describe('门店生成器', () => {
  it('随机生成的门店（各种规模、层数、附属设施）都通过结构与语义校验', () => {
    let twoFloors = 0;
    let withAuto = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const params = randomGeneratorParams(seed);
      const res = validateStoreConfig(generateStoreConfig(params));
      if (!res.ok) throw new Error(`种子 ${seed}：${res.issues.map((i) => i.message).join('；')}`);
      if (params.secondFloor) twoFloors++;
      if (params.autoService) withAuto++;
    }
    expect(twoFloors).toBeGreaterThan(3);
    expect(withAuto).toBeGreaterThan(3);
  });

  it('模板就是预设参数：用模板参数生成与模板完全相同', () => {
    for (const t of ['small', 'medium', 'large'] as const) expect(generateStoreConfig(templateParams(t), t)).toEqual(createTemplate(t));
  });

  it('可以去掉二楼、加上汽车快修中心', () => {
    const p = templateParams('large');
    p.secondFloor = null;
    const single = generateStoreConfig(p);
    expect(single.layout.floors).toHaveLength(1);
    expect(single.layout.connectors).toHaveLength(0);
    const m = templateParams('medium');
    m.autoService = { side: 'RIGHT', oilBays: 2, tireBays: 1 };
    const withAuto = generateStoreConfig(m);
    expect(withAuto.facilities[0]?.kind).toBe('AUTO_SERVICE');
    expect(validateStoreConfig(withAuto).ok).toBe(true);
  });

  it('同一侧两个附属设施、没有工位时校验失败；旧版配置缺少 facilities 时按空处理', () => {
    const preset = GENERATOR_PRESETS.find((p) => p.id === 'large-auto');
    if (!preset) throw new Error('缺少「大型店 + 汽车服务」预设');
    const c = generateStoreConfig(preset.params());
    const f = c.facilities[0];
    if (!f) throw new Error('预设应带有汽车快修中心');
    const bad = { ...c, facilities: [f, { ...f, id: 'AUTO-2', oilBays: 0, tireBays: 0 }] };
    const res = validateStoreConfig(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeGreaterThanOrEqual(2);
    const legacy: Record<string, unknown> = { ...createTemplate('small') };
    delete legacy.facilities;
    const parsed = validateStoreConfig(legacy);
    expect(parsed.ok && parsed.config.facilities).toEqual([]);
  });
});

describe('楼层连接、营业时间与汽车用品位置', () => {
  it('二楼可以配置 1–3 部电梯和 0–2 组扶梯，全部落在走廊上；员工的行走网络不使用扶梯', () => {
    for (let elevators = 1; elevators <= 3; elevators++) {
      for (let escalators = 0; escalators <= 2; escalators++) {
        const p = templateParams('large');
        p.secondFloor = { gmAisles: 8, bays: 14, levels: 5, elevators, escalators };
        const res = validateStoreConfig(generateStoreConfig(p));
        if (!res.ok) throw new Error(res.issues.map((i) => i.message).join('；'));
        const kinds = res.config.layout.connectors.map((c) => c.kind);
        expect(kinds.filter((k) => k === 'ELEVATOR')).toHaveLength(elevators);
        expect(kinds.filter((k) => k === 'ESCALATOR')).toHaveLength(escalators);
        for (const c of res.config.layout.connectors) {
          const [a, b] = res.model.connectorNodes.get(c.id) ?? [-1, -1];
          const linked = (res.model.adjacency[a] ?? []).some((e) => e.to === b);
          expect(linked).toBe(c.kind !== 'ESCALATOR');
        }
      }
    }
  });

  it('有汽车服务中心时，汽车用品通道在一楼靠近它的一侧，二楼不再重复', () => {
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const p = templateParams('large');
      p.autoService = { side, oilBays: 2, tireBays: 2 };
      const c = generateStoreConfig(p);
      const f1Aisles = c.layout.runs.filter((r) => r.floorId === 'F1' && r.kind === 'AISLE').sort((a, b) => a.start.x - b.start.x);
      const auto = side === 'LEFT' ? f1Aisles[0] : f1Aisles[f1Aisles.length - 1];
      expect(auto?.categoryIds).toContain('automotive');
      expect(c.layout.runs.some((r) => r.floorId === 'F2' && r.categoryIds.includes('automotive'))).toBe(false);
      expect(validateStoreConfig(c).ok).toBe(true);
    }
  });

  it('营业时间和停车场设置写入配置；模板保持 Phase 1 的结构（一部电梯、无附属设施、7:00–22:00）', () => {
    const p = templateParams('medium');
    p.hours = { openMin: 8 * 60, closeMin: 21 * 60 };
    p.parking = { rows: 3, pickupBays: 20 };
    const c = generateStoreConfig(p);
    expect(c.hours).toEqual({ openMin: 480, closeMin: 1260 });
    expect(c.outdoor).toEqual({ parkingRows: 3, pickupBays: 20 });
    const large = createTemplate('large');
    expect(large.layout.connectors.map((x) => x.kind)).toEqual(['ELEVATOR']);
    expect(large.facilities).toEqual([]);
    expect(large.hours).toEqual({ openMin: 420, closeMin: 1320 });
  });
});

describe('后仓（库存仓库）', () => {
  it('后仓加深后货架排数增加；货位都在后仓区域内、互不重叠；卸货门在后墙上', () => {
    const p = templateParams('medium');
    const small = backroomLayout(generateStoreConfig(p));
    p.backroom = { extraDepthM: 18, rackRows: 0, rackLevels: 4, docks: 3, forklifts: 2, palletJacks: 2 };
    const cfg = generateStoreConfig(p);
    const big = backroomLayout(cfg);
    expect(big.rows.length).toBeGreaterThan(small.rows.length);
    expect(big.capacity).toBeGreaterThan(small.capacity);
    const seen = new Set<string>();
    for (const l of big.locations) {
      expect(l.x).toBeGreaterThanOrEqual(big.zone.x0);
      expect(l.x).toBeLessThanOrEqual(big.zone.x1);
      expect(l.z).toBeGreaterThanOrEqual(big.zone.z0);
      expect(l.z).toBeLessThanOrEqual(big.zone.z1);
      const k = `${l.x.toFixed(2)}|${l.z.toFixed(2)}|${l.level}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    for (const d of big.docks) expect(d.z).toBeCloseTo(cfg.layout.floors[0]?.depthM ?? 0);
    expect(validateStoreConfig(cfg).ok).toBe(true);
  });

  it('模板的后仓设置（中型店两台叉车），后仓不改变店内行走网络；叉车路线起止正确', () => {
    const t = createTemplate('medium');
    expect(t.backroom).toEqual({ extraDepthM: 0, rackRows: 0, rackLevels: 3, docks: 3, forklifts: 2, palletJacks: 2 });
    expect(createTemplate('small').backroom.forklifts).toBe(1);
    expect(createTemplate('large').backroom.forklifts).toBe(3);
    const b = backroomLayout(t);
    expect(b.rows.length).toBeGreaterThanOrEqual(1);
    const loc = b.locations[0];
    if (!loc) throw new Error('应至少有一个货位');
    const start = { x: (b.receiving.x0 + b.receiving.x1) / 2, z: (b.receiving.z0 + b.receiving.z1) / 2 };
    const r = backroomRoute(b, start, loc, loc.row);
    expect(r[0]).toEqual(start);
    expect(r[r.length - 1]).toEqual({ x: loc.x, z: loc.z });
  });
});

describe('布局编辑：画通道、旋转、成组移动、复制粘贴', () => {
  const setup = () => {
    const cfg = createTemplate('medium');
    const front = cfg.layout.corridors.find((c) => c.id === 'F1-C-FRONT');
    const right = cfg.layout.corridors.find((c) => c.id === 'F1-C-RIGHT');
    if (!front || !right) throw new Error('template corridors');
    const yFront = front.start.y;
    const yBack = Math.max(right.start.y, right.end.y);
    // 右侧走廊与暂存点之间的空地
    const xOpen = right.start.x + 3;
    return { cfg, yFront, yBack, xOpen };
  };
  const issues = (cfg: ReturnType<typeof createTemplate>) => {
    const v = validateStoreConfig(cfg);
    return v.ok ? [] : v.issues.map((i) => i.message);
  };

  it('在空地上拖出一条竖向通道：近端吸附到前走廊，能走到；两端都接不上时不创建', () => {
    const { cfg, yFront, yBack, xOpen } = setup();
    const res = addRun(cfg, 'F1', { x: xOpen + 0.04, y: yFront + 1.2 }, { x: xOpen, y: yBack - 2 });
    expect(res.reason).toBeUndefined();
    const run = cfg.layout.runs.find((r) => r.id === res.id);
    expect(run?.start).toEqual({ x: xOpen, y: yFront });
    expect(run?.bays).toBeGreaterThan(5);
    expect(issues(cfg)).toEqual([]);
    // 后仓里没有任何走廊
    const far = planRun(cfg, 'F1', { x: 3, y: yBack + 30 }, { x: 25, y: yBack + 30 });
    expect(far.run).toBeUndefined();
    expect(far.reason).toMatch(/走不进去/);
  });

  it('横向通道穿过竖向通道的货架段时校验报交叉；超出楼层也会报错', () => {
    const { cfg, yFront, yBack } = setup();
    const a01 = cfg.layout.runs.find((r) => r.id === 'F1-A01');
    const a04 = cfg.layout.runs.find((r) => r.id === 'F1-A04');
    if (!a01 || !a04) throw new Error('aisles');
    const mid = (yFront + yBack) / 2;
    const res = addRun(cfg, 'F1', { x: a01.start.x, y: mid }, { x: a04.start.x, y: mid + 0.3 });
    expect(res.id).toBeDefined();
    expect(runSpan(cfg.layout.runs.find((r) => r.id === res.id) as never).axis).toBe('H');
    expect(issues(cfg).some((m) => m.includes('货架交叉'))).toBe(true);

    const c2 = setup().cfg;
    const r = c2.layout.runs.find((x) => x.id === 'F1-A01');
    if (r) r.end.y = 500;
    expect(issues(c2).some((m) => m.includes('超出'))).toBe(true);
  });

  it('旋转 90° 后横竖互换且至少一端接在竖向行走线段上', () => {
    const { cfg, yFront, yBack, xOpen } = setup();
    const { id } = addRun(cfg, 'F1', { x: xOpen, y: yFront + 1 }, { x: xOpen, y: yFront + 12 });
    expect(rotateRun(cfg, id as string)).toBeUndefined();
    const r = cfg.layout.runs.find((x) => x.id === id);
    if (!r) throw new Error('run');
    const s = runSpan(r);
    expect(s.axis).toBe('H');
    const verticals = walkSegments(cfg, 'F1', new Set([r.id])).filter((w) => w.axis === 'V' && s.c >= w.lo - 0.05 && s.c <= w.hi + 0.05);
    expect(verticals.some((w) => Math.abs(w.c - s.a) < 0.01 || Math.abs(w.c - s.b) < 0.01)).toBe(true);
    expect(yBack).toBeGreaterThan(yFront);
  });

  it('成组移动：竖向通道左右移动保持接在走廊上，前后移动会吸附回去；粘贴副本到空地可用', () => {
    const { cfg, xOpen } = setup();
    const before = cfg.layout.runs.map((r) => ({ ...r, start: { ...r.start }, end: { ...r.end } }));
    const a = before.find((r) => r.id === 'F1-A01');
    if (!a) throw new Error('aisle');
    moveRuns(cfg, ['F1-A01'], -0.4, 0);
    const moved = cfg.layout.runs.find((r) => r.id === 'F1-A01');
    expect(moved?.start).toEqual({ x: a.start.x - 0.4, y: a.start.y });
    expect(moved?.end.y).toBe(a.end.y);
    moveRuns(cfg, ['F1-A01'], 0, 1.5);
    expect(cfg.layout.runs.find((r) => r.id === 'F1-A01')?.start.y).toBe(a.start.y);

    const ids = pasteRuns(cfg, [a], 'F1', xOpen - a.start.x, 0);
    expect(ids).toHaveLength(1);
    const copy = cfg.layout.runs.find((r) => r.id === ids[0]);
    expect(copy?.label).toMatch(/副本$/);
    expect(copy?.start.x).toBe(xOpen);
    expect(issues(cfg)).toEqual([]);
  });

  it('等距排列只动中间的通道；暂存点吸附到走廊上，压到货架时校验报错', () => {
    const { cfg } = setup();
    const x = (id: string) => cfg.layout.runs.find((r) => r.id === id)?.start.x as number;
    const x1 = x('F1-A01');
    const x4 = x('F1-A04');
    expect(distributeRuns(cfg, ['F1-A01', 'F1-A02'])).toMatch(/至少/);
    expect(distributeRuns(cfg, ['F1-A01', 'F1-A02', 'F1-A04'])).toBeUndefined();
    expect(x('F1-A02')).toBeCloseTo((x1 + x4) / 2, 6);
    expect(x('F1-A01')).toBe(x1);

    const c2 = setup().cfg;
    const front = c2.layout.corridors.find((c) => c.id === 'F1-C-FRONT');
    const p = moveStaging(c2, x1 + 1.6, (front?.start.y ?? 0) + 0.8);
    expect(p.y).toBe(front?.start.y);
    expect(c2.layout.points.cartDepot).toEqual(c2.layout.points.staging);
    expect(issues(c2).some((m) => m.includes('暂存区'))).toBe(true);
  });
});

describe('区域、卸货门与取货车位（决策记录 0013）', () => {
  it('默认区域：超市分出冷藏库和冷冻库，建材店分出大件区；收货区细分；暂存区按货架用途；互不重叠', () => {
    for (const tpl of ['small', 'medium', 'large', 'hardware'] as const) {
      const c = createTemplate(tpl);
      const { areas, docks, racks } = storeAreas(c);
      const kinds = new Set(areas.map((a) => a.kind));
      for (const k of ['RACKS', 'UNLOAD', 'RECEIVING_HOLD', 'QA', 'RTV', 'PALLETS', 'BALER', 'STAGING'] as const) expect(kinds.has(k), `${tpl} ${k}`).toBe(true);
      if (tpl === 'hardware') {
        expect(kinds.has('BULK')).toBe(true);
        expect(kinds.has('COOLER')).toBe(false);
      } else {
        expect(kinds.has('COOLER') && kinds.has('FREEZER')).toBe(true);
        expect(areas.find((a) => a.kind === 'COOLER')?.tempZone).toBe('CHILLED');
      }
      // 同一楼层的区域不重叠
      for (let i = 0; i < areas.length; i++)
        for (let j = i + 1; j < areas.length; j++) {
          const a = areas[i]!;
          const b = areas[j]!;
          if (a.floorId === b.floorId) expect(rectsOverlap(a, b), `${tpl}: ${a.id} × ${b.id}`).toBe(false);
        }
      for (const a of areas) {
        expect(a.capacity, a.id).toBeGreaterThan(0);
        expect(a.unit).toBe(AREA_KINDS[a.kind].unit);
      }
      expect(docks.length).toBe(c.backroom.docks);
      expect(docks.filter((d) => d.reefer)).toHaveLength(1);
      expect(racks).toHaveLength(c.staging.racks.length);
      // 托盘货架都在货架区里
      const b = backroomLayout(c);
      const rackArea = areas.find((a) => a.kind === 'RACKS')!;
      for (const l of b.locations) {
        expect(l.areaId).toBe(rackArea.id);
        expect(l.x).toBeGreaterThanOrEqual(rackArea.x0);
        expect(l.x).toBeLessThanOrEqual(rackArea.x1);
      }
    }
  });

  it('明确给出的区域、卸货门和暂存货架位置优先；货架区决定托盘货架；配置能通过校验', () => {
    const c = createTemplate('medium');
    const f = c.layout.floors[0]!;
    c.areas = [
      { id: 'R1', kind: 'RACKS', floorId: f.id, x0: 2, z0: f.depthM - 7.5, x1: 40, z1: f.depthM - 0.6 },
      { id: 'C1', kind: 'COOLER', floorId: f.id, x0: 41, z0: f.depthM - 8, x1: 50, z1: f.depthM - 0.6, capacity: 600 },
      { id: 'U1', kind: 'UNLOAD', floorId: f.id, x0: 52, z0: f.depthM - 5, x1: 72, z1: f.depthM - 0.5 },
      { id: 'S1', kind: 'STAGING', floorId: f.id, x0: 60, z0: 8, x1: 80, z1: 22 },
    ];
    c.docks = [
      { id: 'D1', x: 55, reefer: true },
      { id: 'D2', x: 62 },
      { id: 'D3', x: 69, kind: 'GRADE' },
    ];
    c.staging.racks = c.staging.racks.map((r, i) => (i < 4 ? { ...r, areaId: 'S1' } : r));
    const sa = storeAreas(c);
    expect(sa.areas.map((a) => a.id)).toEqual(['R1', 'C1', 'U1', 'S1']);
    expect(sa.areas.find((a) => a.id === 'C1')?.capacity).toBe(600);
    expect(sa.docks.map((d) => [d.id, d.x, d.kind, d.reefer])).toEqual([
      ['D1', 55, 'DOCK', true],
      ['D2', 62, 'DOCK', false],
      ['D3', 69, 'GRADE', false],
    ]);
    // 指定区域的货架排在区域里
    for (const r of sa.racks.filter((x) => x.areaId === 'S1')) {
      expect(r.x - r.length / 2).toBeGreaterThanOrEqual(60);
      expect(r.z).toBeGreaterThanOrEqual(8);
    }
    const b = backroomLayout(c);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.docks.map((d) => d.x)).toEqual([55, 62, 69]);
    const v = validateStoreConfig(c);
    expect(v.ok ? [] : v.issues.map((i) => i.message)).toEqual([]);
  });
});

describe('区域编辑（决策记录 0013）', () => {
  it('把默认区域写进配置后结果不变；新建、移动、改大小、删除区域，增删和移动卸货门；校验能发现问题', () => {
    const c = createTemplate('medium');
    const before = storeAreas(c);
    materializeAreas(c);
    const after = storeAreas(c);
    expect(after.areas.map((a) => [a.id, a.kind, a.x0, a.z1, a.capacity])).toEqual(before.areas.map((a) => [a.id, a.kind, a.x0, a.z1, a.capacity]));
    expect(after.docks.map((d) => d.x)).toEqual(before.docks.map((d) => d.x));
    expect(backroomLayout(c).capacity).toBe(backroomLayout(createTemplate('medium')).capacity);
    // 冷藏、冷冻订单货架在线上订单冷藏库、冷冻库里，其余在暂存区（决策记录 0019）
    for (const r of c.staging.racks) expect(r.areaId).toBe(r.tempZone === 'CHILLED' ? 'STAGING_COOLER-1' : r.tempZone === 'FROZEN' ? 'STAGING_FREEZER-1' : 'STAGING-1');
    expect(validateStoreConfig(c).ok).toBe(true);

    // 新建：放在空地上，不和已有区域重叠
    const id = addArea(c, 'CHARGING');
    const added = c.areas!.find((a) => a.id === id)!;
    for (const a of c.areas!) if (a.id !== id && a.floorId === added.floorId) expect(rectsOverlap(a, added), a.id).toBe(false);
    expect(validateStoreConfig(c).ok).toBe(true);

    // 移动暂存区：按区域网格摆放的暂存货架跟着走（冷库里的不动）
    const inStaging = () => storeAreas(c).racks.filter((r) => r.areaId === 'STAGING-1');
    const zs = inStaging().map((r) => r.z);
    // 往前挪（后面紧挨着连通通道和冷库）
    moveArea(c, 'STAGING-1', 0, -1);
    expect(inStaging().map((r) => Math.round((r.z + 1) * 10) / 10)).toEqual(zs.map((z) => Math.round(z * 10) / 10));
    expect(validateStoreConfig(c).ok).toBe(true);

    // 改大小：货架区变小，托盘位变少
    const rack = c.areas!.find((a) => a.kind === 'RACKS')!;
    const cap = backroomLayout(c).capacity;
    resizeArea(c, rack.id, rack.x0 + 12, rack.z1);
    expect(backroomLayout(c).capacity).toBeLessThan(cap);

    // 重叠时校验失败
    moveArea(c, id, (c.areas!.find((a) => a.kind === 'COOLER')!.x0 - added.x0), (c.areas!.find((a) => a.kind === 'COOLER')!.z0 - added.z0));
    const bad = validateStoreConfig(c);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((i) => i.message.startsWith('区域重叠'))).toBe(true);
    removeArea(c, id);
    expect(validateStoreConfig(c).ok).toBe(true);

    // 删除暂存区：货架回到默认网格（冷库里的货架不动）
    removeArea(c, 'STAGING-1');
    expect(c.staging.racks.filter((r) => r.tempZone !== 'CHILLED' && r.tempZone !== 'FROZEN').every((r) => r.areaId === undefined)).toBe(true);

    // 卸货门
    const d = addDock(c);
    expect(c.docks).toHaveLength(4);
    moveDock(c, d, 1000);
    expect(c.docks!.find((k) => k.id === d)!.x).toBeLessThanOrEqual(c.layout.floors[0]!.widthM - 2);
    moveDock(c, d, c.docks![0]!.x + 1);
    const close = validateStoreConfig(c);
    expect(close.ok).toBe(false);
    if (!close.ok) expect(close.issues.some((i) => i.message.includes('相距不到 4 米'))).toBe(true);
    removeDock(c, d);
    expect(c.docks).toHaveLength(3);
    // 没有货架区、卸货区时提醒
    c.areas = c.areas!.filter((a) => a.kind !== 'RACKS' && a.kind !== 'UNLOAD');
    const missing = validateStoreConfig(c);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['后仓至少需要一个托盘货架区', '收货至少需要一个卸货区']));
  });
});

describe('开业检查（「你的商店」，决策记录 0013）', () => {
  it('模板门店能开业；删掉卸货区、冷库、货架区后给出问题；订单量太大时暂存和车位不够', () => {
    const c = createTemplate('medium');
    const ok = goLiveCheck(c, 246);
    expect(ok.filter((i) => i.level === 'error')).toEqual([]);
    expect(ok.find((i) => i.code === 'STAGING_CAPACITY')?.level).toBe('ok');
    const busy = goLiveCheck(c, 4000);
    expect(busy.find((i) => i.code === 'STAGING_CAPACITY')?.level).not.toBe('ok');
    expect(busy.find((i) => i.code === 'PICKUP_BAYS')?.level).toBe('warn');
    materializeAreas(c);
    c.areas = c.areas!.filter((a) => a.kind !== 'UNLOAD' && a.kind !== 'COOLER' && a.kind !== 'RACKS');
    c.docks = c.docks!.map((d) => ({ ...d, reefer: false }));
    const v = validateStoreConfig(c);
    const bad = goLiveCheck(c, 246, v.ok ? [] : v.issues);
    const codes = bad.map((i) => `${i.level}:${i.code}:${i.params.kind ?? ''}`);
    expect(codes).toEqual(expect.arrayContaining(['error:AREA_MISSING:UNLOAD', 'error:AREA_MISSING:RACKS', 'warn:COLD_STORAGE:COOLER', 'warn:REEFER_DOOR:', 'error:RACK_CAPACITY:', 'error:CONFIG_ISSUE:']));
  });
});

describe('卸货门、线上订单区的连通与冷库、二楼（决策记录 0019）', () => {
  it('卸货门数量可以自定义（最多 10 个，门店太窄时少排）；随机门店的卸货门数和卸货场设置有变化', () => {
    for (const n of [1, 6, 10]) {
      const c = generateStoreConfig({ ...templateParams('medium'), backroom: { extraDepthM: 0, rackRows: 0, rackLevels: 3, docks: n, forklifts: 2, palletJacks: 2 } });
      const sa = storeAreas(c);
      expect(sa.docks).toHaveLength(Math.min(n, maxDocks(c.layout.floors[0]!.widthM)));
      // 间距 5 米，都在收货区的范围里
      const xs = sa.docks.map((d) => d.x).sort((a, b) => a - b);
      for (let k = 1; k < xs.length; k++) expect(xs[k]! - xs[k - 1]!).toBeCloseTo(5, 6);
      expect(validateStoreConfig(c).ok).toBe(true);
    }
    expect(createTemplate('small').backroom.docks).toBe(2);
    expect(createTemplate('large').backroom.docks).toBe(5);
    const docks = new Set<number>();
    const sides = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const p = randomGeneratorParams(seed);
      docks.add(p.backroom!.docks);
      sides.add(`${p.yard!.side}-${p.yard!.via}`);
      expect(validateStoreConfig(generateStoreConfig(p)).ok).toBe(true);
    }
    expect(docks.size).toBeGreaterThanOrEqual(4);
    expect(sides.size).toBeGreaterThanOrEqual(3);
    // 缺省的卸货场设置
    expect(yardSettings(createTemplate('medium'))).toEqual({ side: 'RIGHT', via: 'DRIVE', offsetM: DEFAULT_YARD_OFFSET, slots: 0, trailerStalls: 0 });
  });

  it('线上订单区：冷藏、冷冻订单货架在步入式冷库里；连通通道从暂存区通到收货区，旁边是溢流位；区域互不重叠', () => {
    for (const t of ['medium', 'large'] as const) {
      const c = createTemplate(t);
      const sa = storeAreas(c);
      const get = (k: string) => sa.areas.find((a) => a.kind === k)!;
      const cooler = get('STAGING_COOLER');
      const freezer = get('STAGING_FREEZER');
      expect(cooler.tempZone).toBe('CHILLED');
      expect(freezer.tempZone).toBe('FROZEN');
      for (const r of sa.racks) {
        const room = r.tempZone === 'CHILLED' ? cooler : r.tempZone === 'FROZEN' ? freezer : undefined;
        if (!room) continue;
        expect(r.x - r.length / 2, r.rackId).toBeGreaterThanOrEqual(room.x0);
        expect(r.x + r.length / 2, r.rackId).toBeLessThanOrEqual(room.x1);
        expect(r.z, r.rackId).toBeGreaterThanOrEqual(room.z0);
        expect(r.z, r.rackId).toBeLessThanOrEqual(room.z1);
      }
      // 冷库的格位算进暂存容量
      expect(cooler.capacity).toBeGreaterThan(0);
      const staging = get('STAGING');
      const passage = get('PASSAGE');
      const unload = sa.areas.filter((a) => a.floorId === 'F1' && (a.kind === 'UNLOAD' || a.kind === 'RECEIVING_HOLD' || a.kind === 'QA' || a.kind === 'RTV'));
      // 通道一头挨着暂存区，另一头挨着收货区
      expect(passage.z0 - staging.z1).toBeLessThan(0.5);
      expect(Math.min(...unload.map((a) => a.z0)) - passage.z1).toBeLessThan(0.5);
      expect(unload.some((a) => a.x0 < passage.x1 && a.x1 > passage.x0)).toBe(true);
      expect(passage.x1 - passage.x0).toBeGreaterThanOrEqual(3);
      expect(get('OVERFLOW').capacity).toBeGreaterThan(4);
      const f1 = sa.areas.filter((a) => a.floorId === 'F1');
      for (let i = 0; i < f1.length; i++) for (let j = i + 1; j < f1.length; j++) expect(rectsOverlap(f1[i]!, f1[j]!), `${f1[i]!.id} / ${f1[j]!.id}`).toBe(false);
    }
    // 没有冷链的建材店：没有冷库，仍有连通通道
    const hw = storeAreas(createTemplate('hardware'));
    expect(hw.areas.some((a) => a.kind === 'STAGING_COOLER')).toBe(false);
    expect(hw.areas.some((a) => a.kind === 'PASSAGE')).toBe(true);
  });

  it('两层的门店：二楼和一楼一样深、宽到货梯外侧；货梯在一楼收货区旁、二楼卸货区旁；二楼有卸货区和补货区，没有线上订单区', () => {
    const c = createTemplate('large');
    const [f1, f2] = c.layout.floors;
    expect(f2!.depthM).toBe(f1!.depthM);
    expect(f2!.widthM).toBeLessThanOrEqual(f1!.widthM);
    const lift = upperStock(c)!.lift;
    expect(f2!.widthM).toBeGreaterThan(lift.x + 1.8 + 7);
    const sa = storeAreas(c);
    const up = sa.areas.filter((a) => a.floorId === 'F2');
    expect(up.map((a) => a.kind).sort()).toEqual(['OVERSTOCK', 'UNLOAD']);
    expect(up.some((a) => AREA_KINDS[a.kind].group === 'STAGING')).toBe(false);
    const us = upperStock(c)!;
    expect(us.floorId).toBe('F2');
    // 货梯在两层都不压货架；二楼的托盘位在卸货区或补货区里
    const shelvesF2 = c.layout.runs.filter((r) => r.floorId === 'F2');
    const backF2 = Math.max(...shelvesF2.map((r) => Math.max(r.start.y, r.end.y)));
    expect(us.lift.z).toBeGreaterThan(backF2 + 1.5);
    expect(us.spots.length).toBeGreaterThan(10);
    // 一楼的后仓布局不受二楼区域影响
    const b = backroomLayout(c);
    expect(b.receiving.z1).toBeLessThanOrEqual(f1!.depthM);
    expect(b.locations.every((l) => l.areaId !== 'OVERSTOCK-2')).toBe(true);
    expect(validateStoreConfig(c).ok).toBe(true);
    // 写进配置后结果不变
    materializeAreas(c);
    expect(upperStock(c)!.spots.length).toBe(us.spots.length);
    expect(validateStoreConfig(c).ok).toBe(true);
    // 单层门店没有
    expect(upperStock(createTemplate('medium'))).toBeUndefined();
  });

  it('二楼通道 0 = 按货梯位置铺满二楼：二楼比一楼窄、货架一直排到货梯前；填了具体数字时照填的数排', () => {
    const c = createTemplate('large');
    const [f1, f2] = c.layout.floors;
    const lift = upperStock(c)!.lift;
    // 大型店一楼 90 米宽，二楼只盖到货梯旁的卸货区外侧，一楼其余部分是单层
    expect(f2!.widthM).toBeLessThan(f1!.widthM);
    expect(f2!.widthM).toBeCloseTo(lift.x + 1.8 + 7 + 2.5, 1);
    const aisles = c.layout.runs.filter((r) => r.floorId === 'F2' && r.kind === 'AISLE');
    const lastX = Math.max(...aisles.map((r) => r.start.x));
    // 最后一条通道离右墙 12 米（右侧走廊和通道）加不到一个通道间距，离货梯不远
    expect(f2!.widthM - lastX).toBeLessThan(12 + 3.2);
    expect(Math.abs(lastX - lift.x)).toBeLessThan(6);
    expect(aisles.length).toBeGreaterThan(10);
    // 每条通道都有品类（品类少于通道时相邻几条通道同一品类）
    expect(aisles.every((r) => r.categoryIds.length > 0)).toBe(true);
    // 填了具体数字：照填的数排，二楼仍然盖到货梯
    const p = templateParams('large');
    p.secondFloor = { ...p.secondFloor!, gmAisles: 6 };
    const c6 = generateStoreConfig(p);
    expect(c6.layout.runs.filter((r) => r.floorId === 'F2' && r.kind === 'AISLE')).toHaveLength(6);
    expect(c6.layout.floors[1]!.widthM).toBeGreaterThan(upperStock(c6)!.lift.x + 1.8 + 7);
    expect(validateStoreConfig(c6).ok).toBe(true);
  });
});
