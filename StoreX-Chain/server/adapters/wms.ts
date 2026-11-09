import { FAMILIES } from '../../src/region/products';
import { STORE } from '../../src/region/network';
import type { Cmd, Msg } from '../../src/twin/types';
import { fromTs, toTs, type Parsed, type Refs } from './common';

/**
 * 仓储和门店系统（WMS）的接口：月台门和门店收货口的门磁、装车扫描、门店盘点、收银，按 CSV 进出（进来的也可以是 JSON）。
 *
 * 列：ts,event,site,door,vehicle_ref,done,total,family,units
 * - DOOR_OPEN / DOOR_CLOSE（site = DC 或门店编号，door = C01…、D01…、S01-1…）→ door；
 * - LOAD_SCAN（装车扫描：done / total 托）→ load；
 * - STOCK_COUNT（门店盘点：货架 + 后仓的件数）→ stock；SALES（门店收银：过去 15 分钟卖出的件数）→ pos。
 * 出去（孪生的指令 → 仓储系统的任务）：改月台门（DOOR_REASSIGN）、追加补货（REPLENISH）。
 */
export const WMS_HEADER = 'ts,event,site,door,vehicle_ref,done,total,family,units';
export type WmsTask = { task: 'DOOR_REASSIGN' | 'REPLENISH'; id: string; ts: string; site: string; [k: string]: unknown };

const FAM_KEYS = new Set(FAMILIES.map((f) => f.key));
const siteOfDoor = (door: string) => (/^S\d\d-\d$/.test(door) ? door.slice(0, 3) : 'DC');
const csvCell = (s: string | number | undefined) => {
  if (s === undefined) return '';
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** 孪生的感知数据 → WMS 的 CSV（带表头；定位、车载终端的事件、冷机、电量、路况归运输管理系统） */
export function wmsFromMsgs(msgs: readonly Msg[], refs: Refs): string {
  const rows = [WMS_HEADER];
  for (const m of msgs) {
    const ts = toTs(m.t);
    if (m.kind === 'door') rows.push([ts, m.open ? 'DOOR_OPEN' : 'DOOR_CLOSE', siteOfDoor(m.door), m.door, refs.ref(m.vid), '', '', '', ''].map(csvCell).join(','));
    else if (m.kind === 'load') rows.push([ts, 'LOAD_SCAN', 'DC', m.door, refs.ref(m.vid), m.done, m.total, '', ''].map(csvCell).join(','));
    else if (m.kind === 'stock') rows.push([ts, 'STOCK_COUNT', m.store, '', '', '', '', m.fam, m.units].map(csvCell).join(','));
    else if (m.kind === 'pos') rows.push([ts, 'SALES', m.store, '', '', '', '', m.fam, m.units].map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}

/** 一行 CSV 拆成格子（双引号括起来的格子里可以有逗号和两个双引号表示的引号） */
export function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** 一条记录（CSV 的一行或 JSON 的一个对象，get 按列名取格子）→ 感知数据；坏的记下原因 */
function wmsRecord(get: (k: string) => string, at: string, refs: Refs, out: Parsed): void {
  const reject = (reason: string): void => {
    out.rejected.push({ at, reason });
  };
  const t = fromTs(get('ts'));
  if (t === undefined) return reject('时间格式不对');
  const ev = get('event');
  const int = (k: string) => {
    const v = get(k);
    return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : undefined;
  };
  if (ev === 'DOOR_OPEN' || ev === 'DOOR_CLOSE' || ev === 'LOAD_SCAN') {
    const door = get('door').toUpperCase();
    const vid = refs.vid(get('vehicle_ref'));
    if (!/^([CD]\d\d|S\d\d-\d)$/.test(door)) return reject('缺少门号或门号不对');
    if (vid === undefined) return reject('不认识的车辆编号');
    if (ev === 'LOAD_SCAN') {
      const done = int('done');
      const total = int('total');
      if (done === undefined || total === undefined || done < 0 || total <= 0 || done > total) return reject('装车进度的数值不对');
      out.items.push({ m: { kind: 'load', t, vid, door, done, total }, src: 'wms' });
    } else out.items.push({ m: { kind: 'door', t, door, open: ev === 'DOOR_OPEN', vid }, src: 'wms' });
    return;
  }
  if (ev === 'STOCK_COUNT' || ev === 'SALES') {
    const fam = get('family');
    const units = int('units');
    const store = get('site');
    if (!FAM_KEYS.has(fam)) return reject('缺少商品族或商品族不对');
    if (units === undefined || units < 0) return reject('件数不对');
    if (!/^S\d\d$/.test(store)) return reject('门店编号不对');
    out.items.push({ m: ev === 'SALES' ? { kind: 'pos', t, store, fam, units } : { kind: 'stock', t, store, fam, units }, src: 'wms' });
    return;
  }
  reject('不认识的事件');
}

/**
 * 解析 WMS 的数据：CSV（带表头），或者 JSON（一个数组，或一行一个对象；键和 CSV 的列名一样，vehicle_ref 也可以写成 vehicleRef）。
 * 坏记录跳过并记下原因（不是合法的 JSON、列数不对、时间格式不对、不认识的事件、不认识的车辆编号、缺门号、缺商品族、数值不对）。
 */
export function parseWms(text: string, refs: Refs): Parsed {
  const out: Parsed = { items: [], vehicles: [], rejected: [] };
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let rows: { at: string; raw: unknown; bad?: string }[];
    if (trimmed.startsWith('[')) {
      try {
        rows = (JSON.parse(trimmed) as unknown[]).map((raw, i) => ({ at: `#${i + 1}`, raw }));
      } catch {
        out.rejected.push({ at: '全文', reason: '不是合法的 JSON' });
        return out;
      }
    } else
      rows = trimmed
        .split('\n')
        .map((line, i) => ({ line: line.trim(), i }))
        .filter((x) => x.line && !x.line.startsWith('//'))
        .map(({ line, i }) => {
          try {
            return { at: `第 ${i + 1} 行`, raw: JSON.parse(line) as unknown };
          } catch {
            return { at: `第 ${i + 1} 行`, raw: undefined, bad: '不是合法的 JSON' };
          }
        });
    for (const row of rows) {
      const r = row.raw as Record<string, unknown> | undefined;
      if (row.bad || !r || typeof r !== 'object' || Array.isArray(r)) {
        out.rejected.push({ at: row.at, reason: row.bad ?? '不是一条记录' });
        continue;
      }
      wmsRecord(
        (k) => {
          const v = r[k] ?? (k === 'vehicle_ref' ? r.vehicleRef : undefined);
          return v === undefined || v === null ? '' : String(v).trim();
        },
        row.at,
        refs,
        out,
      );
    }
    return out;
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cols = WMS_HEADER.split(',');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = `第 ${i + 1} 行`;
    const cells = csvSplit(line);
    if (cells[0] === 'ts') {
      cols = cells.map((c) => c.trim());
      return;
    }
    if (cells.length !== cols.length) {
      out.rejected.push({ at, reason: '列数不对' });
      return;
    }
    wmsRecord((k) => (cells[cols.indexOf(k)] ?? '').trim(), at, refs, out);
  });
  return out;
}

let seq = 0;
/** 孪生的指令 → 仓储系统的任务（其余的归运输管理系统，返回 undefined） */
export function wmsTask(c: Cmd, refs: Refs): WmsTask | undefined {
  const base = { id: `WT-${String(++seq).padStart(5, '0')}`, ts: toTs(c.t), site: 'DC' };
  if (c.kind === 'reassignDoor') return { ...base, task: 'DOOR_REASSIGN', vehicleRef: refs.ref(c.vid), door: c.door };
  if (c.kind === 'restock') return { ...base, task: 'REPLENISH', to: STORE.key, family: c.fam, units: Math.round(c.units) };
  return undefined;
}
