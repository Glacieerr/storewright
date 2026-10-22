import { describe, expect, it } from 'vitest';
import { addRun, backroomLayout, backroomRoute, createTemplate, distributeRuns, fitsInside, formatSlotCode, GENERATOR_PRESETS, generateStoreConfig, moveRuns, moveStaging, pasteRuns, planRun, randomGeneratorParams, rotateRun, runSpan, StoreModel, templateParams, validateStoreConfig, walkSegments } from './index';

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

  it('模板的后仓设置为默认值，后仓不改变店内行走网络；叉车路线起止正确', () => {
    const t = createTemplate('medium');
    expect(t.backroom).toEqual({ extraDepthM: 0, rackRows: 0, rackLevels: 3, docks: 3, forklifts: 1, palletJacks: 2 });
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
