import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditTrajectories, bodiesAt, candidatePairs, checkLimits, formatReport, hitched, obbFromHeading, obbsOverlap, obbToQuad, OverlapAuditor, OverlapTally, quadAabb, quadKey, quadsOverlap, shapesOverlap, StillTracker, validateTrajectories, type AABB, type Body, type TrajectoryFile } from '../src/index';

/** Deterministic random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact reference: area of the intersection of two convex quads (Sutherland–Hodgman clipping). */
function interArea(a: number[], b: number[]): number {
  const pts = (q: number[]) => [0, 1, 2, 3].map((k) => [q[k * 2] as number, q[k * 2 + 1] as number] as [number, number]);
  const area = (p: [number, number][]) => p.reduce((s, [x, z], i) => s + x * (p[(i + 1) % p.length] as [number, number])[1] - (p[(i + 1) % p.length] as [number, number])[0] * z, 0) / 2;
  let subj = pts(a);
  let clip = pts(b);
  if (area(clip) < 0) clip = clip.reverse();
  if (area(subj) < 0) subj = subj.reverse();
  for (let i = 0; i < 4 && subj.length; i++) {
    const [ax, az] = clip[i] as [number, number];
    const [bx, bz] = clip[(i + 1) % 4] as [number, number];
    const side = (p: [number, number]) => (bx - ax) * (p[1] - az) - (bz - az) * (p[0] - ax);
    const out: [number, number][] = [];
    for (let k = 0; k < subj.length; k++) {
      const p = subj[k] as [number, number];
      const q = subj[(k + 1) % subj.length] as [number, number];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const u = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u]);
      }
    }
    subj = out;
  }
  return subj.length >= 3 ? Math.abs(area(subj)) : 0;
}

const randomObb = (r: () => number) => obbFromHeading(r() * 40 - 20, r() * 40 - 20, r() * Math.PI * 2, 1 + r() * 8, 0.5 + r() * 1.5);

describe('separating-axis tests', () => {
  it('agree with the exact intersection area on 4,000 random pairs', () => {
    const r = rng(7);
    let hits = 0;
    for (let n = 0; n < 4000; n++) {
      const a = randomObb(r);
      const b = randomObb(r);
      const qa = obbToQuad(a);
      const qb = obbToQuad(b);
      const ar = interArea(qa, qb);
      if (ar > 1e-6 && ar < 1e-3) continue; // too close to call with floating point
      const want = ar > 1e-6;
      if (want) hits++;
      expect(quadsOverlap(qa, qb)).toBe(want);
      expect(obbsOverlap(a, b)).toBe(want);
      expect(shapesOverlap(a, qb)).toBe(want);
    }
    expect(hits).toBeGreaterThan(300);
  });
  it('touching rectangles overlap only when asked', () => {
    const a = [0, 0, 0, 4, 2, 4, 2, 0];
    const b = [2, 0, 2, 4, 4, 4, 4, 0];
    expect(quadsOverlap(a, b)).toBe(false);
    expect(quadsOverlap(a, b, { touching: true })).toBe(true);
    const oa = obbFromHeading(1, 2, 0, 2, 1);
    const ob = obbFromHeading(3, 2, 0, 2, 1);
    expect(obbsOverlap(oa, ob)).toBe(false);
    expect(obbsOverlap(oa, ob, { touching: true })).toBe(true);
  });
  it('quad corners follow rear-A, front-A, front-B, rear-B', () => {
    const q = obbToQuad(obbFromHeading(0, 0, 0, 5, 1));
    expect(q.slice(0, 4)).toEqual([-1, -5, -1, 5]); // corner 0 → corner 1 points forward (+z)
    const y = obbFromHeading(0, 0, 0, 5, 1, { yaw: true });
    expect([y.ux, y.uz]).toEqual([1, -0]);
  });
  it('a tractor and its own trailer are hitched; a trailer behind another truck is not', () => {
    const tractor = obbToQuad(obbFromHeading(0, 10, 0, 3, 1.25));
    const trailer = obbToQuad(obbFromHeading(0, 2.6, 0, 6.8, 1.25));
    const turned = obbToQuad(obbFromHeading(0, 2.6, Math.PI / 2, 6.8, 1.25));
    expect(hitched(tractor, trailer)).toBe(true);
    expect(hitched(tractor, turned)).toBe(false);
    expect(hitched(tractor, obbToQuad(obbFromHeading(0, -10, 0, 6.8, 1.25)))).toBe(false);
  });
});

describe('grid broad phase', () => {
  it('finds exactly the pairs whose bounds intersect, for any cell size', () => {
    const r = rng(11);
    const boxes: AABB[] = Array.from({ length: 250 }, () => {
      const x = r() * 400;
      const z = r() * 400;
      const w = r() < 0.05 ? 80 * r() : 12 * r();
      return { minX: x, minZ: z, maxX: x + w, maxZ: z + w * r() };
    });
    const brute: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as AABB;
        const b = boxes[j] as AABB;
        if (!(a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ)) brute.push(`${i},${j}`);
      }
    for (const cell of [1, 7, 30, 1000]) expect(candidatePairs(boxes, cell).map((p) => p.join(','))).toEqual(brute);
  });
  it('rejects a non-positive cell size', () => {
    expect(() => candidatePairs([], 0)).toThrow();
  });
});

describe('auditor and tally', () => {
  const sq = (x: number, z: number) => obbToQuad(obbFromHeading(x, z, 0, 2, 1));
  it('counts pair-seconds by area, pair and static / moving, with skip, ignore and area hooks', () => {
    const a = new OverlapAuditor<{ id: string }>({ skip: (x, y) => x.data?.id === 'ghost' || y.data?.id === 'ghost', ignore: (x, y) => x.type === 'tractor' && y.type === 'trailer', area: (x) => (quadAabb(x.shape as number[]).minX < 50 ? 'west' : undefined) });
    const bodies: Body<{ id: string }>[] = [
      { type: 'van', shape: sq(0, 0), still: true, data: { id: 'v1' } },
      { type: 'car', shape: sq(1, 0), still: true, data: { id: 'c1' } },
      { type: 'car', shape: sq(0.5, 1), still: false, data: { id: 'c2' } },
      { type: 'van', shape: sq(0.2, 0.2), data: { id: 'ghost' } },
      { type: 'tractor', shape: sq(20, 0), data: { id: 't' } },
      { type: 'trailer', shape: sq(20, 1), data: { id: 'tr' } },
      { type: 'van', shape: sq(100, 0), data: { id: 'east1' } },
      { type: 'van', shape: sq(100.5, 0), data: { id: 'east2' } },
    ];
    expect(a.step(0, bodies, 2)).toBe(3);
    const t = a.tally;
    expect(t.areaNames()).toEqual(['west']);
    expect(t.total('west')).toEqual({ static: 2, moving: 4 });
    expect(t.pairs('west')).toEqual([
      { pair: 'car × van', static: 2, moving: 2 },
      { pair: 'car × car', static: 0, moving: 2 },
    ]);
    expect(t.toJSON()).toEqual({ west: { 'car × van': { static: 2, moving: 2 }, 'car × car': { static: 0, moving: 2 } } });
  });
  it('still tracker compares pose keys with the previous sample', () => {
    const s = new StillTracker();
    const q = sq(3.04, 7);
    expect(s.mark(quadKey('van', q))).toBe(false);
    s.next();
    expect(s.mark(quadKey('van', sq(3.02, 7)))).toBe(true);
    s.next();
    expect(s.mark(quadKey('van', sq(4, 7)))).toBe(false);
  });
  it('limits: limited areas first, over only when enforced', () => {
    const t = new OverlapTally();
    t.add('road', 'a × b', false, 30);
    t.add('dock', 'a × a', true, 4);
    const r = checkLimits(t, { dock: { static: 2, moving: 10 }, gate: { static: 0, moving: 0 } });
    expect(r.rows.map((x) => x.area)).toEqual(['dock', 'gate', 'road']);
    expect(r.over).toBe(1);
    expect(r.rows[0]?.over).toBe(true);
    expect(checkLimits(t, { dock: { static: 2, moving: 10 } }, { enforce: false }).over).toBe(0);
    expect(formatReport(r)).toContain('1 area(s) over the limit');
  });
});

describe('trajectory files and the CLI', () => {
  const file = fileURLToPath(new URL('../examples/crossing.json', import.meta.url));
  const limits = fileURLToPath(new URL('../examples/limits.json', import.meta.url));
  const data = JSON.parse(readFileSync(file, 'utf8')) as TrajectoryFile;
  it('validates and interpolates', () => {
    expect(validateTrajectories(data)).toEqual([]);
    expect(validateTrajectories({ vehicles: [{ id: 'x', type: 't', length: -1, width: 2, frames: [] }] }).length).toBe(2);
    const b = bodiesAt(data, 10).find((x) => x.data?.id === 'north-1');
    expect(b?.data?.z).toBeCloseTo(0, 9);
    expect(bodiesAt(data, 25).filter((x) => !x.data?.id.startsWith('parked')).length).toBe(0);
  });
  it('audits the example: the crossing and the parked trailer, not the rig against itself', () => {
    const r = auditTrajectories(data, { step: 0.5, limits: JSON.parse(readFileSync(limits, 'utf8')) });
    const row = (a: string) => r.rows.find((x) => x.area === a);
    expect(r.samples).toBe(41);
    expect(row('junction')).toMatchObject({ static: 0, moving: 1.5, over: false });
    expect(row('yard')).toMatchObject({ static: 20, moving: 0.5, over: false });
    expect(r.over).toBe(0);
    expect(auditTrajectories(data, { step: 0.5, limits: { yard: { static: 0, moving: 0 } } }).over).toBe(1);
  });
  it('CLI exit codes: 0 within limits, 1 over, 2 bad input', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' });
    const ok = run([file, '--step', '0.5', '--limits', limits]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('box truck × van');
    const json = run([file, '--json']);
    expect(JSON.parse(json.stdout).rows.length).toBeGreaterThan(0);
    expect(run(['/nonexistent.json']).status).toBe(2);
  });
});
