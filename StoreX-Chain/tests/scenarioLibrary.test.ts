import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario, scenarioFromSearch, scenarioToSearch } from '../src/scenario';

/** 场景库（web/public/scenarios）：每个文件都是合法的场景，编号和文件名一致，目录和文件一一对应，中英文标题和说明都有 */
const DIR = new URL('../web/public/scenarios/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
const index = JSON.parse(readFileSync(new URL('index.json', DIR), 'utf8')) as { format: string; version: number; scenarios: { id: string; title: string; titleEn: string; description: string; descriptionEn: string }[] };

describe('场景库', () => {
  it('有 8–12 个精选场景', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.length).toBeLessThanOrEqual(12);
  });

  it.each(files)('%s 通过检查、编号和文件名一致、中英文齐全', (f) => {
    const r = parseScenario(JSON.parse(readFileSync(new URL(f, DIR), 'utf8')));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const s = r.scenario!;
    expect(s.id).toBe(f.replace(/\.json$/, ''));
    for (const k of ['title', 'titleEn', 'description', 'descriptionEn'] as const) expect(s[k]?.length ?? 0).toBeGreaterThan(1);
    // 写成分享链接再读回来，和文件一样（标题、说明、编号不进链接）
    // 链接里不写默认值（默认区域、没有演练、自动天气），比较前去掉
    const norm = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k, v]) => !(k === 'region' && v === 'default') && !(k === 'drill' && v === 'none') && !(k === 'weather' && v === 'auto')));
    const back = scenarioFromSearch(`?${scenarioToSearch(s)}`).scenario!;
    const { id: _id, title: _t, titleEn: _te, description: _d, descriptionEn: _de, ...rest } = s;
    expect(norm(back as Record<string, unknown>)).toEqual(norm(rest as Record<string, unknown>));
  });

  it('目录和文件一一对应、标题和文件里的一样', () => {
    expect(index.format).toBe('storex-chain/scenario-library');
    expect(index.version).toBe(1);
    expect(index.scenarios.map((x) => x.id).sort()).toEqual(files.map((f) => f.replace(/\.json$/, '')).sort());
    for (const e of index.scenarios) {
      const s = parseScenario(JSON.parse(readFileSync(new URL(`${e.id}.json`, DIR), 'utf8'))).scenario!;
      expect([e.title, e.titleEn, e.description, e.descriptionEn]).toEqual([s.title, s.titleEn, s.description, s.descriptionEn]);
    }
  });

  it('覆盖演练、负荷、门店、冷链、随机和自定义区域、导览', () => {
    const all = files.map((f) => parseScenario(JSON.parse(readFileSync(new URL(f, DIR), 'utf8'))).scenario!);
    expect(all.some((s) => s.drill && s.drill !== 'none')).toBe(true);
    expect(all.some((s) => s.load && s.load !== 'normal')).toBe(true);
    expect(all.some((s) => s.camera?.preset === 'flagship')).toBe(true);
    expect(all.some((s) => s.facilities?.dc?.coldDoors !== undefined)).toBe(true);
    expect(all.some((s) => s.region?.startsWith('random-'))).toBe(true);
    expect(all.some((s) => s.region?.startsWith('custom-'))).toBe(true);
    expect(all.some((s) => s.tour === 'container')).toBe(true);
  });
});
