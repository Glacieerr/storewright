import { activeAlerts, type OpsState, type StoreStatic } from '@storewright/ops';
import type { LiveClient } from '@storewright/ops/client';
import { forecast, sensorsFor, type Forecast, type ForecastOptions, type SensorDef, type SensorStatus, type TwinFrame, type TwinHealth, type TwinReplay, type TwinSnapshot } from '@storewright/twin';
import { useApp } from '../state/store';
import { liveClient, setReplayState, setTwinHandler, viewNow, viewState } from './link';

/**
 * 数字孪生的查看端（决策记录 0016）：设备读数、健康度、回放和推演。
 * 和门店实况一样放在模块里，数据变化时只把 twinVersion 加一。
 * 传感器清单从门店静态数据算出（与门店中枢同一个函数），推送里只有读数。
 */

interface TwinView {
  client?: LiveClient;
  statics?: StoreStatic;
  defs: SensorDef[];
  frame?: TwinFrame;
  /** 回放可以回到的最早时间 */
  from?: number;
  demo: boolean;
  /** 迷你曲线：每个传感器最近 60 分钟的点 [时间, 读数] */
  points: Map<string, Array<[number, number]>>;
  replay?: { at: number; sensors: Map<string, number> };
  loading: boolean;
  error?: string;
}

const view: TwinView = { defs: [], demo: false, points: new Map(), loading: false };
const KEEP_MS = 60 * 60_000;

function bump(): void {
  const st = useApp.getState();
  useApp.setState({ twinVersion: st.twinVersion + 1 });
}

/** 换了门店或重新连接：清空 */
function sync(): LiveClient | undefined {
  const c = liveClient();
  if (c !== view.client) {
    view.client = c;
    view.statics = undefined;
    view.defs = [];
    view.frame = undefined;
    view.from = undefined;
    view.points = new Map();
    view.replay = undefined;
    if (c) void loadTwin();
  }
  if (c?.statics && c.statics !== view.statics) {
    view.statics = c.statics;
    view.defs = sensorsFor(c.statics);
  }
  return c;
}

export function twinView(): Readonly<TwinView> {
  sync();
  return view;
}

function addPoint(id: string, at: number, v: number): void {
  let list = view.points.get(id);
  if (!list) {
    list = [];
    view.points.set(id, list);
  }
  const last = list[list.length - 1];
  if (last && at - last[0] < 10_000) return;
  list.push([at, v]);
  while (list.length && (list[0] as [number, number])[0] < at - KEEP_MS) list.shift();
}

setTwinHandler((raw) => {
  sync();
  const f = raw as TwinFrame;
  if (!f || f.t !== 'twin') return;
  view.frame = f;
  for (const s of f.sensors) addPoint(s.id, s.at, s.v);
  bump();
});

/** 打开孪生时取一次：最近一小时的曲线、回放的起点 */
export async function loadTwin(): Promise<void> {
  const c = liveClient();
  if (!c) return;
  try {
    const snap = await c.getJson<TwinSnapshot>('/twin');
    if (c !== view.client) return;
    view.demo = snap.demo;
    view.from = snap.from;
    view.frame ??= snap.frame;
    for (const [id, buckets] of Object.entries(snap.series)) for (const b of buckets) addPoint(id, b.t, b.last);
    view.error = undefined;
  } catch (e) {
    view.error = e instanceof Error ? e.message : String(e);
  }
  bump();
}

let replaySeq = 0;

/** 回放到 t 时刻：取回那一刻的门店和设备读数，场景和面板都切过去 */
export async function replayAt(t: number): Promise<void> {
  const c = sync();
  if (!c) return;
  const seq = ++replaySeq;
  view.loading = true;
  bump();
  try {
    const r = await c.getJson<TwinReplay>(`/twin/at?t=${Math.round(t)}`);
    // 期间换了门店、发了新的回放请求，或者已经回到实时 / 推演：丢掉这个结果
    if (seq !== replaySeq || c !== view.client || useApp.getState().twin.mode !== 'replay') return;
    view.replay = { at: r.at, sensors: new Map(r.sensors.map((x) => [x.id, x.v])) };
    view.error = undefined;
    setReplayState({ at: r.at, state: r.state });
  } catch (e) {
    if (seq === replaySeq) view.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === replaySeq) {
      view.loading = false;
      bump();
    }
  }
}

/** 回到实时 */
export function endReplay(): void {
  replaySeq += 1;
  view.replay = undefined;
  view.loading = false;
  setReplayState(undefined);
  bump();
}

/** 某个传感器此刻（或回放到的时刻）的读数和状态 */
export function sensorReading(def: SensorDef, s: OpsState | undefined = viewState()): { v: number; s: SensorStatus; since?: number } | undefined {
  if (view.replay) {
    const v = view.replay.sensors.get(def.id);
    if (v === undefined) return undefined;
    return { v, s: statusOf(def, v, s) };
  }
  const x = view.frame?.sensors.find((y) => y.id === def.id);
  return x ? { v: x.v, s: x.s, ...(x.since !== undefined ? { since: x.since } : {}) } : undefined;
}

/** 回放时只有读数：按阈值和那一刻的告警推出状态 */
function statusOf(def: SensorDef, v: number, s: OpsState | undefined): SensorStatus {
  if (s && activeAlerts(s).some((a) => a.sensorId === def.id && a.severity === 'ALARM')) return 'ALARM';
  if (def.kind === 'TEMP' && def.limits) {
    const L = def.limits;
    const over = L.direction === 'MAX' ? v > L.limit - 1 : v < L.limit + 2;
    return over ? 'WARN' : 'OK';
  }
  if (def.kind === 'DOOR' && s && activeAlerts(s).some((a) => a.sensorId === def.id)) return 'WARN';
  return 'OK';
}

export function twinHealth(): TwinHealth | undefined {
  return view.frame?.health;
}

/** 设备健康（预测性维护，决策记录 0022）：回放时不显示（说的是此刻） */
export function equipmentHealth(id: string): { s: 'OK' | 'WATCH' | 'RISK' | 'STUCK'; eta?: number; slope?: number } | undefined {
  if (view.replay) return undefined;
  return view.frame?.equipment?.find((x) => x.id === id);
}

let cache: { key: string; f: Forecast } | undefined;

/** 推演（从此刻的门店出发）；同一序号、同一分钟、同样的方案只算一次 */
export function twinForecast(opts: ForecastOptions = {}): Forecast | undefined {
  const c = sync();
  const s = viewState();
  if (!c?.statics || !s) return undefined;
  const now = viewNow();
  const key = `${s.seq}|${Math.floor(now / 60_000)}|${JSON.stringify(opts)}|${view.replay ? 'r' : 'l'}`;
  if (cache?.key === key) return cache.f;
  const f = forecast(s, c.statics, now, opts);
  cache = { key, f };
  return f;
}
