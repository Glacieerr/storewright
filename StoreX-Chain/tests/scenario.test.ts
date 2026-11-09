import { describe, expect, it } from 'vitest';
import { defaultFacilities } from '../src/facility/config';
import { clockText, facilitiesDiff, hasScenarioParams, mergeFacilities, mergeScenario, parseClock, parseScenario, scenarioFromSearch, scenarioToSearch, scenarioUrl } from '../src/scenario';

describe('场景文件', () => {
  it('合法的场景规整后返回，time 换成秒', () => {
    const r = parseScenario({ format: 'storex-chain/scenario', version: 1, id: 'typhoon-port', title: '台风天的港口', region: 'random-3', gen: 'g3', seed: 2, load: 'peak', drill: 'portCongestion', time: '08:30', speed: 60, play: true, camera: { preset: 'port' }, follow: 'DR-02', weather: 'storm', tour: 'container', exercise: 'ex03' });
    expect(r.errors).toEqual([]);
    expect(r.scenario?.time).toBe(8.5 * 3600);
    expect(r.scenario?.camera).toEqual({ preset: 'port' });
  });
  it('取值不对报错、不认识的字段只提醒', () => {
    const r = parseScenario({ gen: 'g9', seed: 0, load: 'huge', time: '25:00', speed: 7, camera: { position: [1, 2, 3] }, region: 'mars', facilities: { dc: { dryDoors: 99 } }, foo: 1 });
    expect(r.scenario).toBeUndefined();
    expect(r.errors.length).toBeGreaterThanOrEqual(8);
    expect(r.warnings.some((w) => w.includes('foo'))).toBe(true);
  });
  it('设施改动：按管理台的范围检查，合并、求差互逆', () => {
    const r = parseScenario({ facilities: { dc: { dryDoors: 12, down: ['SC3'] }, store: { docks: 3, staff: [{ key: 'recv', crew: { early: 2 } }] } } });
    expect(r.errors).toEqual([]);
    const d = defaultFacilities();
    const m = mergeFacilities(d, r.scenario?.facilities);
    expect(m.dc.dryDoors).toBe(12);
    expect(m.store.staff.find((x) => x.key === 'recv')?.crew.early).toBe(2);
    const diff = facilitiesDiff(d, m);
    expect(mergeFacilities(d, diff)).toEqual(m);
    expect(facilitiesDiff(d, d)).toEqual({});
  });
  it('岗位表只认这个设施已有的岗位', () => {
    expect(parseScenario({ facilities: { store: { staff: [{ key: 'nobody', crew: { early: 1 } }] } } }).errors.length).toBe(1);
  });
  it('时刻的写法', () => {
    expect(parseClock('8:05')).toBe(8 * 3600 + 300);
    expect(parseClock('08:05:30')).toBe(8 * 3600 + 330);
    expect(parseClock(-1)).toBeUndefined();
    expect(clockText(8 * 3600 + 359)).toBe('08:05');
  });
});

describe('分享链接', () => {
  it('场景 → 网址 → 场景，来回一样', () => {
    const s = parseScenario({ region: 'custom-7~sea.S~river.1', gen: 'g2', seed: 5, load: 'high', drill: 'highwayClosed', time: '14:20', speed: 300, play: false, camera: { position: [100.04, 200, -300], target: [1, 0, 2] }, follow: 'M03', weather: 'fog', tab: 'report', tour: 'container', exercise: 'ex07', facilities: { port: { gateLanes: 3 } } }).scenario!;
    const url = scenarioUrl('https://example.org/storex-chain/', s, new URLSearchParams('lang=en&debug=1&seed=9'));
    expect(url).toContain('lang=en');
    expect(url.endsWith('#report')).toBe(true);
    const u = new URL(url);
    expect(hasScenarioParams(u.search)).toBe(true);
    const back = scenarioFromSearch(u.search, u.hash);
    expect(back.errors).toEqual([]);
    expect(back.scenario).toEqual({ ...s, camera: { position: [100, 200, -300], target: [1, 0, 2] } });
  });
  it('只有区域和语言的网址不算场景；场景库编号要合法', () => {
    expect(hasScenarioParams('?region=random-3&lang=en')).toBe(false);
    expect(scenarioFromSearch('?scenario=typhoon-port').library).toBe('typhoon-port');
    expect(scenarioFromSearch('?scenario=../x').errors.length).toBe(1);
    expect(scenarioFromSearch('?fac=%%%').scenario).toBeUndefined();
  });
  it('网址参数覆盖场景库文件；镜头、设施按字段合并', () => {
    const a = parseScenario({ gen: 'g3', time: '08:00', camera: { preset: 'port' }, facilities: { dc: { dryDoors: 20 } } }).scenario!;
    const b = scenarioFromSearch('?t=09:00&fac=' + new URLSearchParams(scenarioToSearch({ facilities: { dc: { coldDoors: 6 } } })).get('fac')).scenario!;
    const m = mergeScenario(a, b);
    expect(m.time).toBe(9 * 3600);
    expect(m.camera).toEqual({ preset: 'port' });
    expect(m.facilities).toEqual({ dc: { dryDoors: 20, coldDoors: 6 } });
  });
});

describe('场景文件的 JSON Schema', () => {
  it('docs/scenario.schema.json 和常量生成的一致（改了取值范围要重新生成：npx tsx src/scenario/schema.ts --write）', async () => {
    const { readFileSync } = await import('node:fs');
    const { scenarioSchema } = await import('../src/scenario/schema');
    const file = JSON.parse(readFileSync(new URL('../docs/scenario.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(scenarioSchema());
  });
});
