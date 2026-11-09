import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EN } from '../web/src/i18n/en';
import { lookup, t, tx } from '../web/src/i18n';

/**
 * 英文界面：t('…') 用到的每一个中文原文、index.html 里 data-i18n 的文字都要在 web/src/i18n/en.ts 里有英文，
 * 占位符 {名字} 两边一致。The English dictionary covers every key used through t() in the translated files.
 */
const root = fileURLToPath(new URL('../web/', import.meta.url));
const FILES = [
  'src/main.ts',
  'src/kpiPanel.ts',
  'src/dispatch.ts',
  'src/drillLab.ts',
  'src/facilityAdmin.ts',
  'src/forecastPanel.ts',
  'src/labCharts.ts',
  'src/loopPanel.ts',
  'src/networkTab.ts',
  'src/regionDialog.ts',
  'src/report.ts',
  'src/solvePanel.ts',
  'src/trackPanel.ts',
  'src/tracking.ts',
  'src/decor.ts',
  'src/drills.ts',
  'src/facilityPanel.ts',
  'src/assistantPanel.ts',
  'src/three/view.ts',
  'src/three/split.ts',
  'src/three/weather.ts',
  'src/three/quality.ts',
  'src/three/planMap.ts',
  'src/three/vehicles.ts',
  'src/onboard.ts',
];
const HAN = /\p{Script=Han}/u;

/** 文件里 t()（含 import { t as tr } 这样的别名）的字符串常量参数 */
function keysOf(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(root + file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !/i18n['"]$/.test(st.moduleSpecifier.getText(sf))) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName ?? el.name).text === 't') names.add(el.name.text);
  }
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
      const a = n.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) out.push(a.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** index.html 里带 data-i18n 的元素：自己的文字节点和 title、aria-label 等属性 */
function htmlKeys(): string[] {
  const html = readFileSync(root + 'index.html', 'utf8');
  const out: string[] = [];
  for (const m of html.matchAll(/<([a-z][\w-]*)([^>]*\sdata-i18n[^>]*)>([^<]*)/gi)) {
    const [, , attrs = '', text = ''] = m;
    for (const a of attrs.matchAll(/\s(?:title|aria-label|placeholder|alt|content)="([^"]*)"/g)) if (HAN.test(a[1] ?? '')) out.push(a[1] as string);
    const explicit = /\sdata-i18n="([^"]+)"/.exec(attrs)?.[1];
    if (HAN.test(text)) out.push(explicit ?? text.trim());
  }
  return out;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

describe('English UI dictionary', () => {
  const used = new Map<string, string>();
  for (const f of FILES) for (const k of keysOf(f)) if (!used.has(k)) used.set(k, f);
  for (const k of htmlKeys()) if (!used.has(k)) used.set(k, 'index.html');

  it('finds the translated strings', () => {
    expect(used.size).toBeGreaterThan(1400);
  });

  it('has English for every key used through t() and data-i18n', () => {
    const missing = [...used].filter(([k]) => EN[k] === undefined).map(([k, f]) => `${f}: ${k}`);
    expect(missing, `missing English strings:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps the {placeholders} of every entry', () => {
    const bad = Object.entries(EN)
      .filter(([zh, en]) => placeholders(zh) !== placeholders(en))
      .map(([zh, en]) => `${zh} => ${en}`);
    expect(bad).toEqual([]);
  });

  it('has no Chinese left in the English text', () => {
    // 内置助手只懂中文，这一条特意保留中文的示例问法
    const allow = new Set(['可以直接问我，比如「M02 在哪」「为什么推荐第一条」「写交接班报告」。']);
    const han = Object.entries(EN)
      .filter(([zh, en]) => HAN.test(en) && !allow.has(zh))
      .map(([zh]) => zh);
    expect(han).toEqual([]);
  });

  // 运行时才出现的文字：仿真给的作业状态（含编号、地点、数字）、设施监控的值、路名和停车场名、三维地名、仿真核心的标签
  const RUNTIME = [
    '靠泊装卸',
    '卸货',
    '在配送中心卸货',
    '在综合店卸货',
    '在综合店等收货时间',
    '开往配送中心',
    '在锚地等泊位（港口拥堵）',
    '进近降落',
    '滑行到跑道头',
    '起飞',
    '离港',
    '进港',
    '班列进站',
    '在货运站卸箱',
    '在港口铁路站装箱',
    '在物流园货运站查验、卸箱',
    '送线上订单',
    '在小区送货',
    '2 号收货口卸货（12 板）',
    '卸货（6 板）',
    '装车（8 板）',
    '靠在D03号门装车',
    '冷藏库里 4 板，已装车 2 板',
    '3 辆在作业',
    '空泊位',
    '2 号泊位',
    '待命',
    '叉车不够要等的车次',
    '双发宽体货机',
    '开到 B2 箱区 3 贝',
    '面包房路',
    '综合店进店路',
    '综合店货车通道',
    '城区公共停车场 3',
    '小区停车场 12',
    '港口员工停车场',
    '往北 · 国内长途高速',
    'R2 出口匝道',
    '3 路',
    '集装箱港口',
    '物流园 · 配送中心',
    '往东 · 跨境长途（洲际公路）',
    'ETV 立体库',
    '门店服务水平（需求满足）',
    '美元 / 天',
    '克',
    '改善',
    '常温食品（畅销）',
    '调度员',
    '旺季',
    '东南',
    '大城市',
    // 闭环面板的建议卡、调度台的问题、设施的岗位和设备（i18n/extra/runtime.ts）
    'DS-BEV-1 到综合店预计晚 135 分钟',
    'M02 抛锚',
    '等修好（约 1.5 小时）',
    '收货截止顺延到 12:30（门店多排半小时人手）',
    '货物温度现在 2.7 °C，预计 04:24 超过 5 °C；司机检查过 1 次没找到问题',
    'DS-BEV-2 到综合店：直送收货截止 10:00，10:08 才开始卸货，晚 8 分钟',
    'M01 推迟到 03:25 出发',
    'M04 开往综合店遇上高峰，路上多 19 分钟',
    '叉车司机',
    '岸桥',
    '早班 6–14',
    '保税库',
    '良好',
    '车辆抛锚',
    // 导出的今日计划、交接班报告里的行（设施的区名、指令名）
    '港口物流中心：拆装箱库 · 集装箱侧月台最满在 06:40（容量的 100%）。',
    '发出指令 3 条：通知门店顺延 1、提醒司机检查 2；现场回执 2 条',
    // 高峰以上负荷的班轮、货运航班（名字里带航次、班次）
    '09:50 班轮 VS1：集装箱船（本店班轮 · 每周 4 个航次，约 3 个自己的 40 尺箱），09:50–02:50 作业',
    'FL1100 货运航班（进口果蔬、海鲜 · 每天 4 班）',
    '集装箱船（本店班轮 · 每周 2 个航次，约 6 个自己的 40 尺箱）',
  ];
  it('translates runtime text from the simulation (activities, facility values, road and parking names, 3D labels)', () => {
    const left = RUNTIME.filter((s) => {
      const en = lookup(EN, s);
      return en === undefined || HAN.test(en);
    });
    expect(left).toEqual([]);
    expect(lookup(EN, '在综合店卸货')).toBe('Unloading at Store');
    expect(lookup(EN, '2 号收货口卸货（12 板）')).toBe('Unloading at dock 2 (12 pallets)');
  });

  it('has English for every facility area and metric label (src/hub, src/site, the 3D facility panels)', () => {
    // 这些标签在设施监控、导出的今日计划和值班助手的回答里显示，按原文查字典
    const dirs = ['../src/hub/', '../src/site/', '../web/src/three/ops/'];
    const labels = new Set<string>();
    for (const d of dirs) {
      const dir = fileURLToPath(new URL(d, import.meta.url));
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts')))
        for (const m of readFileSync(dir + f, 'utf8').matchAll(/label: '([^'$]*\p{Script=Han}[^']*)'/gu)) labels.add(m[1] as string);
    }
    expect(labels.size).toBeGreaterThan(100);
    const left = [...labels].filter((s) => {
      const en = lookup(EN, s);
      return en === undefined || HAN.test(en);
    });
    expect(left).toEqual([]);
  });

  it('translates long runtime lines through nested patterns and gives up quickly on text it cannot translate', () => {
    expect(lookup(EN, '{x}')).toBeUndefined();
    expect(lookup(EN, '本班发生的事：06:20 预计迟到：DS-BEV-2 到综合店预计晚 9 分钟 → 没处理，问题发生了')).toBe(
      'This shift: 06:20 Expected late: DS-BEV-2 expected 9 min late at Store → not handled, the problem happened',
    );
    // 列表（「、」「；」连接）不受嵌套层数限制
    expect(lookup(EN, '挪 3 车：集卡 PT015 09:01 → 08:01；集卡 PT105 09:02 → 08:02；货车 AF037（冷链） 07:34 → 08:04')).toBe(
      'Move 3 trucks: Yard truck PT015 09:01 → 08:01; Yard truck PT105 09:02 → 08:02; Truck AF037 (cold chain) 07:34 → 08:04',
    );
    // 名字以 _ 结尾的占位符不跨过逗号：后面的句子不会被吞进去
    expect(lookup(EN, '06:08 到综合店，C05 门')).toBe('reaches Store at 06:08, door C05');
    const long = Array.from({ length: 40 }, (_, i) => `没有这样的说法${i}，还有一段；再来一段、又一段：第${i}句。`).join('');
    const t0 = performance.now();
    expect(lookup(EN, long)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('falls back to Chinese and fills {names} outside the browser (Chinese is the default)', () => {
    expect(t('{n} 件', { n: 3 })).toBe('3 件');
    expect(t('没有这个键 {x}', { x: 'a' })).toBe('没有这个键 a');
    expect(tx('港口')).toBe('港口');
  });
});
