import { selectedModel, forecastReport } from '../analysis/forecast';
import { QUALITY_LABEL } from '../twin/channel';
import { review } from './review';
import type { AssistCtx, Basis } from './types';

/**
 * 回答的把握从哪来：数据质量、模型验证。
 *
 * - 数据质量：闭环孪生的数据通道是「良好」时为 1；「一般」「较差」按丢了多少、晚到多久打折，并在回答里写明；
 *   孪生还没跑（只有计划）时，要用现场数据的问题按 0.8 算，纯计划、资料、规则类的问题不打折。
 * - 模型验证：问到达时刻的按孪生最近的到店预测误差（保真度）；问建议卡的按复盘的命中率；问预测的按选中模型的验证误差；
 *   精确求解、计划数据、规则表为 1。
 * 把握 = 意图分类的把握 × 数据质量 × 模型验证，在回答下面写清楚每一项。
 */
export interface DataQualityNow {
  level: Basis['quality']['level'];
  label: string;
  /** 一两句话：丢了多少、平均晚到多久、最长断线多久 */
  text: string;
  /** 打折系数（要用现场数据的回答） */
  factor: number;
  /** 丢失率、平均晚到秒数、最长断线分钟（有通道统计时） */
  drop?: number;
  lateSec?: number;
  maxGap?: number;
}

export function dataQuality(ctx: AssistCtx): DataQualityNow {
  const tw = ctx.twin;
  if (!tw) return { level: 'plan', label: '只有计划', text: '闭环孪生还没跑完，只有调度台的计划，没有现场数据。', factor: 0.8 };
  const q = tw.result?.quality;
  if (!q || q.level === 'good') return { level: 'good', label: QUALITY_LABEL.good, text: '数据通道良好：定位、事件按时到达。', factor: 1 };
  const drop = q.sent ? q.dropped / q.sent : 0;
  const lateShare = q.sent ? q.late / q.sent : 0;
  // 丢得多、晚得多打得狠：一般约 0.85，较差约 0.65
  const factor = Math.max(0.5, Math.min(0.95, 1 - drop * 1.6 - lateShare * 0.6 - (q.level === 'poor' ? 0.12 : 0.04)));
  const gap = q.maxGap >= 1 ? `，最长一次 ${Math.round(q.maxGap)} 分钟收不到定位` : '';
  return {
    level: q.level,
    label: QUALITY_LABEL[q.level],
    text: `数据通道${QUALITY_LABEL[q.level]}：丢了 ${(drop * 100).toFixed(1)}% 的周期数据，${(lateShare * 100).toFixed(1)}% 晚到（平均晚 ${Math.round(q.lateSec)} 秒）${gap}；孪生按计划推算了 ${q.reckoned} 次位置。`,
    factor,
    drop,
    lateSec: q.lateSec,
    maxGap: q.maxGap,
  };
}

/** 用现场数据回答的工具（数据质量打折）；其余按计划、资料、规则回答 */
const LIVE = new Set(['get_overview', 'list_risks', 'get_vehicle', 'list_late', 'get_stock', 'get_doors', 'get_facility', 'list_cards', 'explain_card', 'what_if', 'propose_decision', 'get_kpi', 'list_incidents', 'shift_handover', 'explain_delay', 'detect_anomalies', 'get_hub', 'trace_own_cargo', 'hub_bottlenecks', 'plan_appointments', 'get_data_quality']);
export const usesLiveData = (tool: string): boolean => LIVE.has(tool);

/** 模型验证的系数和说明（这次用到的工具里最弱的那个） */
export function modelFactor(ctx: AssistCtx, tools: readonly string[]): { factor: number; note?: string } {
  let factor = 1;
  let note: string | undefined;
  const take = (f: number, n: string) => {
    if (f < factor) {
      factor = f;
      note = n;
    }
  };
  const res = ctx.twin?.result;
  for (const name of tools) {
    if ((name === 'get_vehicle' || name === 'list_late') && res) {
      const e = res.fidelitySeries.filter((x) => x.t <= ctx.t && Number.isFinite(x.eta)).pop()?.eta;
      if (e !== undefined) take(Math.max(0.6, Math.min(1, 1 - e / 40)), `到店时刻按孪生的估计，到此刻提前一小时估计的平均误差 ${e.toFixed(1)} 分钟`);
    }
    if ((name === 'explain_card' || name === 'what_if' || name === 'propose_decision' || name === 'list_cards') && res) {
      const rv = review(res, ctx.t);
      if (rv.total.n >= 5) take(0.6 + 0.4 * rv.total.hitRate, `今天有了结论的 ${rv.total.n} 张建议卡里，推演命中 ${Math.round(rv.total.hitRate * 100)}%`);
      else take(0.9, '今天有结论的建议卡还不到 5 张，推演的命中率还看不出来');
    }
    if (name === 'get_forecast') {
      const m = forecastReport() ? selectedModel('demand') : undefined;
      if (m) take(0.85, `销量预测用「${m.label}」：${m.reason}`);
      else take(0.7, '预测模型还没训练');
    }
    if (name === 'explain_delay') take(0.9, '原因按每分钟的延误增量逐分钟归因：同一分钟里有两个原因时归给更直接的那个');
    if (name === 'detect_anomalies') take(0.85, '异常按指数平滑的基线和稳健 z 分数判断，只用此刻以前的数据');
    if (name === 'get_hub' || name === 'trace_own_cargo' || name === 'hub_bottlenecks' || name === 'plan_appointments') take(0.9, '仓储中心的占用和排队按设施作业模型的计划（和三维画面同一份）');
    if (name === 'search_knowledge') take(0.85, '资料库按关键词检索，引用的段落请对照原文');
    if (name === 'plan_network') take(0.9, '网络规划按默认设定的需求增长和成本参数');
  }
  return note ? { factor, note } : { factor };
}

export const certaintyLevel = (v: number): '高' | '中' | '低' => (v >= 0.8 ? '高' : v >= 0.55 ? '中' : '低');
