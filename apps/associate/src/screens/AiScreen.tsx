import { useEffect, useState } from 'react';
import { AI_MODES, AI_MODULES, OVERRIDE_REASONS, type AiMode, type AiModule, type OverrideReason, type Reason } from '@storewright/ai';
import { adoptionRate, aiModeOf, canManageAi, openRecs, planogramByItem, recentRecs, roleOf, type LiveRec, type OpsState, type StoreStatic } from '@storewright/ops';
import { ai, type AiModelInfo, type AiSummary } from '../api';
import { clock, t } from '../i18n';
import { useLive } from '../live';
import { toast } from '../ui/Toasts';
import { AskPanel } from './AskPanel';

/**
 * AI（决策记录 0010）：带班负责人和控制台查看并处理 AI 建议、设置各模块的运行模式、查看模型版本与回测指标。
 * 每条建议都显示预测区间、置信度、主要理由和其他模型的预测；否决时必须选原因。
 */

export const MODULE_TEXT: Record<AiModule, string> = {
  FORECAST: '订单量预测',
  ETA: '到店时间',
  AVAILABILITY: '可售概率',
  SUBSTITUTION: '替代推荐',
  STAFFING: '人员调配',
  REPLENISH: '补货优先级',
  COUNT: '按风险盘点',
  MTO: '熟食开始时间',
  RETURNS: '退货去向',
};
/** 退货去向的硬性规则（决策 RT-02） */
export const RETURN_BLOCK_TEXT: Record<string, string> = {
  COLD_CHAIN: '冷藏、冷冻、热食退回后一律不能回架',
  NOT_SEALED: '食品、日用品和个护只有未开封才能回架',
  DAMAGED: '损坏的商品不能回架',
  CHEMICAL_OPENED: '开封或损坏的化学品只能走危险品回收',
  CHEMICAL_TRASH: '化学品不能按普通垃圾报废',
};
export const ROLE_TEXT: Record<string, string> = { PICK: '拣货', STAGE: '暂存', HANDOFF: '交付', LEAD: '带班负责人', BACKROOM: '后仓', RESTOCK: '补货', DELI: '熟食', pick: '拣货', stage: '暂存', handoff: '交付' };
const DISPOSITION_TEXT: Record<string, string> = { RESTOCK: '可售回架', DISPOSE: '报废', HAZMAT: '危险品回收', VENDOR: '退供应商' };
const MODE_TEXT: Record<AiMode, string> = { SHOW: '只显示', CONFIRM: '需确认', AUTO: '自动执行' };
const STATUS_TEXT: Record<LiveRec['status'], string> = {
  OPEN: '待处理',
  ACCEPTED: '已采纳',
  OVERRIDDEN: '已否决',
  DISMISSED: '已忽略',
  EXPIRED: '已过期',
  SUPERSEDED: '已被取代',
  AUTO_APPLIED: '已自动执行',
};
const REASON_TEXT: Record<OverrideReason, string> = {
  WRONG_DATA: '数据不对',
  LOCAL_KNOWLEDGE: '我知道系统不知道的情况',
  NO_STAFF: '人手不够',
  CUSTOMER_REQUEST: '顾客要求',
  DISAGREE: '不同意',
  OTHER: '其他',
};
const KIND_TEXT: Record<string, string> = {
  'feature-glm': '已知因素回归',
  'eta-reported': '只信导航',
  'eta-fixed': '导航 + 高峰与天气',
  'eta-hierarchical': '导航 + 高峰与天气 + 顾客习惯',
  'availability-bayes': '只看沉默（朴素贝叶斯）',
  'availability-logistic': '逻辑回归（沉默 + 估算 + 确认时间）',
  'count-abc': 'ABC 周期 + 事件触发',
  'count-risk': '按风险排序',
  'queue-sim': '短时排队估算',
  'sub-rule': '名称规则',
  'sub-similarity': '属性相似度',
  'sub-learned': '学习排序',
  'seasonal-naive': '同时段上周值',
  'hour-of-week-mean-4': '近 4 周同时段平均',
  'seasonal-es': '季节性指数平滑',
  'prep-standard': '标准制作时长',
  'prep-model': '菜品系数 + 厨房负载',
  'returns-rule': '固定规则',
  'returns-model': '再售概率（逻辑回归）+ 规则',
};
const MODEL_STATUS_TEXT: Record<AiModelInfo['status'], string> = { CHAMPION: '当前版本', CANDIDATE: '候选', RETIRED: '已退役', REJECTED: '未通过' };
const NOTE_TEXT: Record<string, string> = { NOT_BEST: '同一批中不是最好的', ROLLED_BACK: '已回滚', FORCED: '人工上线' };
const HOLIDAY_TEXT: Record<string, string> = {
  NEW_YEAR: '元旦',
  MEMORIAL_DAY: '阵亡将士纪念日',
  INDEPENDENCE_DAY: '独立日',
  LABOR_DAY: '劳动节',
  THANKSGIVING: '感恩节',
  CHRISTMAS: '圣诞节',
};
const ZONE_TEXT: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻', HOT: '热食' };
const WEEKDAY = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const METRIC_TEXT: Record<string, string> = {
  wape: '加权误差 WAPE',
  mae: '平均绝对误差',
  bias: '偏差',
  coverage80: '80% 区间覆盖率',
  absBias: '偏差绝对值',
  coverageGap: '覆盖率偏离 80%',
  maeRepeat: '老顾客的平均绝对误差',
  brier: 'Brier 分数',
  auc: 'AUC',
  ece: '校准误差',
  precision: '提醒的精确率',
  recall: '提醒的召回率',
  avgInaccurate: '平均不准的记录数',
  meanDetectDays: '发现错误的平均天数',
  hitRate: '盘点命中率',
  acceptTop1: '推荐第一名的期望接受率',
  ndcg3: '前三名排序质量（NDCG@3）',
  accuracy: '判断正确率',
  falseRestock: '误判回架的比例',
  missedResale: '可售却报废的比例',
};
const EVAL_TEXT: Record<string, string> = {
  'orders-hourly': '回测：每次只用当时已有的数据训练，预测之后 7 天，滚动多次后汇总。',
  'eta-arrival': '评估：按时间先后，前 70% 训练，之后逐条预测，预测完再把这次到店计入顾客习惯。',
  'shelf-availability': '评估：按天切分，前 70% 的天数训练，之后的每个商品-小时预测「货架上找不找得到」。',
  'count-risk': '评估：同样的每日盘点数量下，两种策略面对完全相同的出错事件（公共随机数）。',
  substitution: '评估：前 70% 的替代记录训练，之后每条记录比较各方法选出的第一名，用顾客真实的接受概率计算。',
  'mto-prep': '评估：前 70% 的制作记录训练，之后逐条预测实际制作时长（模拟数据中有菜品差异与厨房繁忙的影响）。',
  'returns-disposition': '评估：前 70% 的退货记录训练，之后比较「回架」判断与这件商品实际能否再售。',
};
/** 模型族：标题、显示的指标、主指标 */
const FAMILIES: Array<{ id: string; title: string; metrics: string[]; primary: string; minutes: boolean }> = [
  { id: 'orders-hourly', title: '订单量预测模型', metrics: ['wape', 'mae', 'bias', 'coverage80'], primary: 'wape', minutes: false },
  { id: 'eta-arrival', title: '到店时间修正模型', metrics: ['mae', 'maeRepeat', 'bias', 'coverage80'], primary: 'mae', minutes: true },
  { id: 'shelf-availability', title: '可售概率模型', metrics: ['brier', 'auc', 'ece', 'precision', 'recall'], primary: 'brier', minutes: false },
  { id: 'count-risk', title: '按风险盘点模型', metrics: ['avgInaccurate', 'meanDetectDays', 'hitRate'], primary: 'avgInaccurate', minutes: false },
  { id: 'substitution', title: '替代推荐模型', metrics: ['acceptTop1', 'ndcg3'], primary: 'acceptTop1', minutes: false },
  { id: 'mto-prep', title: '熟食制作时长模型', metrics: ['mae'], primary: 'mae', minutes: true },
  { id: 'returns-disposition', title: '退货去向模型', metrics: ['accuracy', 'falseRestock', 'missedResale'], primary: 'accuracy', minutes: false },
];
const PERCENT_METRICS = new Set(['wape', 'coverage80', 'ece', 'precision', 'recall', 'hitRate', 'acceptTop1', 'accuracy', 'falseRestock', 'missedResale']);

const kindText = (k: string) => (KIND_TEXT[k] ? t(KIND_TEXT[k]) : k);
const noteText = (n: string) => (NOTE_TEXT[n] ? t(NOTE_TEXT[n]) : n);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 倍数 → ±百分比 */
function effectText(r: Reason): string {
  if (!r.effect) return '';
  if (r.effect.kind === 'ADD') return `${r.effect.amount >= 0 ? '+' : '−'}${Math.abs(Math.round(r.effect.amount * 10) / 10)}`;
  const d = Math.round((r.effect.amount - 1) * 100);
  return d === 0 ? '±0%' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`;
}

export function reasonText(r: Reason): string {
  const v = r.value ?? 0;
  switch (r.factor) {
    case 'WEEKDAY_FACTOR':
      return t('{0}的订单比一周平均 {1}', t(WEEKDAY[Number(r.params?.dow ?? 0)] ?? ''), effectText(r));
    case 'HOUR_SHARE':
      return t('这段时间占全天订单的 {0}%', Math.round(v));
    case 'TREND':
      return t('近期趋势 {0}', effectText(r));
    case 'BASE_LEVEL':
      return t('基础水平：每天约 {0} 单', Math.round(v));
    case 'SAME_HOUR_LAST_WEEK':
      return t('上周同一时段 {0} 单', Math.round(v));
    case 'RECENT_WEEKS_MEAN':
      return t('近几周同一时段平均 {0} 单', Math.round(v));
    case 'HOLIDAY':
      return t('{0}当天 {1}', holidayName(r), effectText(r));
    case 'HOLIDAY_EVE':
      return t('{0}前一天 {1}', holidayName(r), effectText(r));
    case 'DAY_AFTER_HOLIDAY':
      return t('节后第一天 {0}', effectText(r));
    case 'PROMO':
      return t('本周促销（覆盖 {0}% 的需求）{1}', Math.round(v), effectText(r));
    case 'STORM_WARNING_TOMORROW':
      return t('明天有风暴预警，顾客提前囤货 {0}', effectText(r));
    case 'STORM_WARNING':
      return t('今天有风暴预警 {0}', effectText(r));
    case 'HEAVY_RAIN_FORECAST':
      return t('预报大雨（{0} 毫米）{1}', Math.round(v), effectText(r));
    case 'HEAT_FORECAST':
      return t('预报高温（{0}°C）{1}', Math.round(v), effectText(r));
    case 'COLD_FORECAST':
      return t('预报严寒（{0}°C）{1}', Math.round(v), effectText(r));
    case 'REPORTED_ETA':
      return t('导航预计 {0} 分钟', Math.round(v));
    case 'TYPICAL_DELAY':
      return t('一般会比导航多用 {0} 分钟', minutesText(r));
    case 'RUSH_HOUR':
      return t('高峰时段 {0} 分钟', minutesText(r));
    case 'WEEKEND':
      return t('周末 {0} 分钟', minutesText(r));
    case 'CUSTOMER_HABIT':
      return t('这位顾客以往 {0} 次到店的习惯 {1} 分钟', Number(r.params?.visits ?? 0), minutesText(r));
    case 'NO_SALES':
      return t('已经 {0} 没有卖出（按平时应卖出约 {1} 件）', hoursText(v), Number(r.params?.expected ?? 0));
    case 'SHELF_ESTIMATE':
      return t('系统估算 {0} 件', Math.round(v));
    case 'ALMOST_EMPTY':
      return t('系统估算只剩 {0} 件', Math.round(v));
    case 'SINCE_CONFIRMED':
      return r.params?.never ? t('开门以来还没有员工到货架确认过') : t('{0}前员工确认过', hoursText(v));
    case 'VELOCITY':
      return t('平均每小时卖 {0} 件', Math.round(v * 10) / 10);
    case 'DAYS_SINCE_COUNT':
      return t('距上次盘点 {0} 天', Math.round(v));
    case 'MOVES_SINCE_COUNT':
      return t('盘点后进出 {0} 次', Math.round(v));
    case 'RECEIPT_DISCREPANCY':
      return t('最近收货有差异');
    case 'SUSPECT':
      return t('后仓补取或补货时按记录没找到');
    case 'DAMAGED':
      return r.effect ? t('包装损坏 {0}', effectText(r)) : t('有 {0} 箱损坏', Math.round(v));
    case 'HANDOFF_QUEUE':
      return t('交付区 {0} 位顾客在等，{1} 分钟内还会到 {2} 位', Math.round(v), Number(r.params?.horizon ?? 15), Number(r.params?.arriving ?? 0));
    case 'PICK_BACKLOG':
      return t('待拣约 {0} 分钟的工作量，最早 {1} 分钟后截止', Math.round(v), Number(r.params?.due ?? 0));
    case 'STAGE_BACKLOG':
      return t('{0} 框等待暂存', Math.round(v));
    case 'IDLE_IN_SOURCE':
      return t('{0}岗位有 {1} 人手上没有任务', t(ROLE_TEXT[String(r.params?.role ?? '')] ?? ''), Math.round(v));
    case 'PEAK_HOUR':
      return t('高峰在 {0} 点，预计 {1} 单', Number(r.params?.hour ?? 0), Math.round(v));
    case 'SAME_TOTAL_HOURS':
      return t('各岗位总工时与现在相同，只调整时间分布');
    case 'RECENT_LEVEL':
      return t('近期需求水平比训练期平均 {0}', effectText(r));
    case 'STANDARD_TIME':
      return t('标准制作时长 {0} 分钟', Math.round(v));
    case 'DISH_FACTOR':
      return t('这道菜实际制作通常 {0} 分钟', minutesText(r));
    case 'KITCHEN_LOAD':
      return t('厨房同时在做 {0} 单，{1} 分钟', Math.round(v), minutesText(r));
    case 'INTERCEPT':
      return t('基础再售率');
    case 'OPENED':
      return t('已开封 {0}', effectText(r));
    case 'COLD_HOURS':
      return t('冷藏冷冻商品离开冷链约 {0} 小时 {1}', Math.round(v * 10) / 10, effectText(r)) + (r.params?.assumed ? t('（没有订单，按 24 小时估计）') : '');
    case 'PERISHABLE':
      return t('易腐商品 {0}', effectText(r));
    case 'PERISHABLE_HOURS':
      return t('易腐商品交付后 {0} 小时 {1}', Math.round(v * 10) / 10, effectText(r)) + (r.params?.assumed ? t('（没有订单，按 24 小时估计）') : '');
    case 'CHEMICAL':
      return t('化学品 {0}', effectText(r));
    case 'RULE':
      return t('门店规则：{0}（模型原本建议{1}）', t(RETURN_BLOCK_TEXT[String(r.params?.reason ?? '')] ?? ''), t(DISPOSITION_TEXT[String(r.params?.original ?? '')] ?? ''));
    default:
      return r.factor;
  }
}

/** 时长：不到 1 小时显示分钟 */
function hoursText(h: number): string {
  return h < 1 ? t('{0} 分钟', Math.max(1, Math.round(h * 60))) : t('{0} 小时', Math.round(h * 10) / 10);
}

function minutesText(r: Reason): string {
  const a = Math.round((r.effect?.amount ?? 0) * 10) / 10;
  return `${a >= 0 ? '+' : '−'}${Math.abs(a)}`;
}

function holidayName(r: Reason): string {
  const c = String(r.params?.code ?? '');
  return HOLIDAY_TEXT[c] ? t(HOLIDAY_TEXT[c]) : t('节假日');
}

function recTitle(r: LiveRec, s?: OpsState, st?: StoreStatic): string {
  if (r.module === 'FORECAST' && r.prediction?.unit === 'ORDERS') return t('接下来 {0} 小时的订单量', Number(r.action.params?.window ?? 0));
  if (r.module === 'ETA') {
    const o = s?.orders[r.target];
    return t('{0} 的到店时间', o ? `${o.firstName} ${o.lastName.slice(0, 1)}.` : r.target);
  }
  if (r.module === 'AVAILABILITY') return t('{0} 可能不在货架上', st ? (planogramByItem(st).get(r.target)?.name ?? r.target) : r.target);
  if (r.module === 'COUNT') return t('建议盘点库位 {0}', r.target);
  if (r.module === 'STAFFING' && r.action.kind === 'MOVE_ASSOCIATE') {
    const name = st?.roster.find((a) => a.id === r.target)?.name ?? r.target;
    return t('建议把 {0} 从{1}调到{2}', name, t(ROLE_TEXT[String(r.action.params?.from ?? '')] ?? ''), t(ROLE_TEXT[String(r.action.params?.to ?? '')] ?? ''));
  }
  if (r.module === 'STAFFING' && r.action.params?.plan) return t('今天的排班建议');
  if (r.module === 'MTO') return t('{0} 的开始时间', s?.mto[r.target]?.name ?? r.target);
  return t(MODULE_TEXT[r.module]);
}

function unitText(unit: string): string {
  return unit === 'ORDERS' ? t('单') : unit === 'MINUTES' ? t('分钟') : '';
}

/** 预测值的显示：概率显示为百分比 */
function valueText(unit: string, v: number): string {
  return unit === 'PROBABILITY' ? pct(v) : String(Math.round(v));
}

export function AiScreen() {
  const [tab, setTab] = useState<'recs' | 'ask' | 'modes' | 'models'>('recs');
  const { client } = useLive();
  const open = openRecs(client.state).length;
  const tabs: [typeof tab, string][] = [
    ['recs', '建议'],
    ['ask', '问答'],
    ['modes', '模式与统计'],
    ['models', '模型'],
  ];
  return (
    <div className="ai">
      <div className="segmented wide" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(label)}
            {k === 'recs' && open > 0 && <em>{open}</em>}
          </button>
        ))}
      </div>
      {tab === 'recs' ? <RecsView /> : tab === 'ask' ? <AskPanel /> : tab === 'modes' ? <ModesView /> : <ModelsView />}
    </div>
  );
}

function RecsView() {
  const { client } = useLive();
  const open = openRecs(client.state);
  const recent = recentRecs(client.state, 10);
  return (
    <div className="list">
      {open.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{t('暂时没有待处理的建议')}</p>
          <p>{t('AI 每小时会发出一次订单量预测；带班负责人可以在「模型」里立即预测。')}</p>
        </div>
      ) : (
        open.map((r) => <RecCard key={r.id} rec={r} />)
      )}
      {recent.length > 0 && (
        <>
          <h2 className="section-title">{t('最近处理')}</h2>
          <section className="card">
            <ul className="plain ai-history">
              {recent.map((r) => (
                <li key={r.id}>
                  <span className="mono">{clock(r.issuedAt)}</span> {recTitle(r, client.state, client.statics)}
                  {r.prediction && (
                    <b>
                      {' '}
                      · {valueText(r.prediction.unit, r.prediction.value)} {unitText(r.prediction.unit)}
                    </b>
                  )}
                  <span className={`tag ${r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED' ? 'ok' : ''}`}>{t(STATUS_TEXT[r.status])}</span>
                  {r.reason && <span className="muted">{t(REASON_TEXT[r.reason])}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function RecCard({ rec }: { rec: LiveRec }) {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState<OverrideReason | undefined>();
  const [note, setNote] = useState('');
  const p = rec.prediction;
  const info = rec.action.kind === 'INFO';
  const vsUsual = p?.baseline ? (p.value - p.baseline) / p.baseline : undefined;
  return (
    <article className="card ai-rec">
      <div className="card-head">
        <span className="tag">{t(MODULE_TEXT[rec.module])}</span>
        <span className="strong">{recTitle(rec, client.state, client.statics)}</span>
        <span className="due">{p?.from !== undefined && p.to !== undefined ? `${clock(p.from)}–${clock(p.to)}` : ''}</span>
      </div>
      {p && (
        <div className="ai-big">
          <b>{valueText(p.unit, p.value)}</b>
          <span>
            {p.unit === 'PROBABILITY' ? (rec.module === 'COUNT' ? t('记录不准的概率') : t('货架上找得到的概率')) : unitText(p.unit)}
            {rec.module === 'STAFFING' && p.unit === 'MINUTES' && <small>{t('调动后预计的平均等待')}</small>}
            {p.low !== undefined && p.high !== undefined && <small>{t('80% 区间 {0}–{1}', Math.round(p.low), Math.round(p.high))}</small>}
          </span>
          {vsUsual !== undefined && p.unit === 'ORDERS' && (
            <em className={vsUsual >= 0 ? 'up' : 'down'}>{t('比近 4 周同时段 {0}', `${vsUsual >= 0 ? '+' : '−'}${Math.abs(Math.round(vsUsual * 100))}%`)}</em>
          )}
          {p.unit === 'MINUTES' && p.baseline !== undefined && rec.module === 'ETA' && <em className={p.value >= p.baseline ? 'up' : 'down'}>{t('顾客报 {0} 分钟', Math.round(p.baseline))}</em>}
          {p.unit === 'MINUTES' && p.baseline !== undefined && rec.module === 'STAFFING' && <em className="down">{t('调动前 {0} 分钟', Math.round(p.baseline * 10) / 10)}</em>}
        </div>
      )}
      {rec.module === 'STAFFING' && rec.action.params?.plan && <StaffPlanTable rec={rec} />}
      {p?.breakdown && p.breakdown.unit === 'LINES' && (
        <p className="note">
          {t(
            '预计商品行：{0}',
            Object.entries(p.breakdown.values)
              .map(([z, n]) => `${ZONE_TEXT[z] ? t(ZONE_TEXT[z]) : z} ${n}`)
              .join(' · '),
          )}
        </p>
      )}
      <div className="ai-conf" title={t('置信度')}>
        <span>{t('置信度 {0}', pct(rec.confidence))}</span>
        <i style={{ width: pct(rec.confidence) }} />
      </div>
      <h3 className="ai-sub">{t('主要理由')}</h3>
      <ul className="plain ai-reasons">
        {rec.reasons.map((r) => (
          <li key={r.factor}>
            <span>{reasonText(r)}</span>
            <i style={{ width: pct(Math.max(0.04, r.weight)) }} />
          </li>
        ))}
      </ul>
      {rec.alternatives.length > 0 && (
        <p className="note">
          {t(
            '其他模型：{0}',
            rec.alternatives.map((a) => `${kindText(String(a.action.params?.model ?? ''))} ${valueText(p?.unit ?? '', Number(a.action.params?.value ?? 0))}`).join(' · '),
          )}
        </p>
      )}
      <p className="note">
        {t('模型 {0} v{1} · {2} · {3}', rec.model.id, rec.model.version, kindText(rec.model.kind), t(MODE_TEXT[rec.mode]))}
      </p>
      {can &&
        (overriding ? (
          <div className="ai-override">
            <p className="strong">{info ? t('哪里不准？') : t('为什么不采纳？')}</p>
            <div className="chips">
              {OVERRIDE_REASONS.map((r) => (
                <button key={r} className={`chip${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>
                  {t(REASON_TEXT[r])}
                </button>
              ))}
            </div>
            <input className="ai-note" value={note} maxLength={200} placeholder={t('补充说明（可选）')} onChange={(e) => setNote(e.target.value)} />
            <div className="actions">
              <button onClick={() => setOverriding(false)}>{t('取消')}</button>
              <button
                className="primary"
                disabled={!reason}
                onClick={() => reason && void run({ type: 'OverrideRecommendation', recId: rec.id, reason, ...(note.trim() ? { note: note.trim() } : {}) })}
              >
                {t('提交')}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button className="primary" onClick={() => void run({ type: 'AcceptRecommendation', recId: rec.id })}>
              {info ? t('有用') : t('采纳')}
            </button>
            <button onClick={() => setOverriding(true)}>{info ? t('不准') : t('否决')}</button>
            <button className="link" onClick={() => void run({ type: 'DismissRecommendation', recId: rec.id }, { quiet: true })}>
              {t('忽略')}
            </button>
          </div>
        ))}
    </article>
  );
}

function ModesView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const isConsole = auth.role === 'console';
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  return (
    <div className="list">
      <StaffView />
      <h2 className="section-title">{t('运行模式')}</h2>
      <p className="note">{t('只显示：AI 给出信息；需确认：员工采纳后才执行；自动执行：AI 直接执行并记录。锁定的模块只有门店管理员可以修改。')}</p>
      {AI_MODULES.map((m) => {
        const cur = aiModeOf(s, m);
        const st = s.aiModes[m];
        const locked = !!st?.locked;
        const stats = s.aiStats[m];
        const rate = adoptionRate(stats);
        return (
          <section key={m} className="card ai-mode">
            <div className="card-head">
              <span className="strong">{t(MODULE_TEXT[m])}</span>
              {locked && <span className="tag">{t('已锁定')}</span>}
              <span className="due">{stats ? t('发出 {0} 条 · 采纳率 {1}', stats.issued, rate === undefined ? '—' : pct(rate)) : t('还没有建议')}</span>
            </div>
            <div className="segmented">
              {AI_MODES.map((mode) => (
                <button key={mode} className={cur === mode ? 'on' : ''} disabled={!can || (locked && !isConsole)} onClick={() => void run({ type: 'SetAiMode', module: m, mode }, { quiet: true })}>
                  {t(MODE_TEXT[mode])}
                </button>
              ))}
            </div>
            {isConsole && (
              <button className="link" onClick={() => void run({ type: 'SetAiMode', module: m, mode: cur, locked: !locked }, { quiet: true })}>
                {locked ? t('解锁') : t('锁定')}
              </button>
            )}
            {stats && stats.OVERRIDDEN > 0 && (
              <p className="note">
                {t(
                  '否决原因：{0}',
                  Object.entries(stats.reasons)
                    .sort((a, b) => b[1] - a[1])
                    .map(([r, n]) => `${t(REASON_TEXT[r as OverrideReason] ?? r)} ×${n}`)
                    .join(' · '),
                )}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 人员：当前岗位、临时调动、固定名单（锁定后 AI 不会建议调动这个人） */
function StaffView() {
  const { client, auth, run } = useLive();
  const st = client.statics as StoreStatic;
  const s = client.state;
  const can = canManageAi(st, auth.actor);
  const people = st.roster.filter((a) => a.role !== 'LEAD');
  return (
    <>
      <h2 className="section-title">{t('人员')}</h2>
      <p className="note">{t('可以把员工临时调到别的作业岗位；锁定的员工属于固定名单，AI 不会建议调动。')}</p>
      <section className="card">
        <ul className="plain staff-list">
          {people.map((a) => {
            const role = roleOf(st, s, a.id) ?? a.role;
            const locked = !!s.staffLocks[a.id];
            return (
              <li key={a.id}>
                <span className="strong">{a.name}</span>
                <span className="tag">{t(ROLE_TEXT[role] ?? role)}</span>
                {s.roles[a.id] && <span className="tag">{t('临时')}</span>}
                {locked && <span className="tag">{t('固定')}</span>}
                {can && (
                  <span className="staff-actions">
                    {(['PICK', 'STAGE', 'HANDOFF'] as const)
                      .filter((r) => r !== role)
                      .map((r) => (
                        <button key={r} className="chip" onClick={() => void run({ type: 'ChangeRole', associateId: a.id, role: r }, { quiet: true })}>
                          {t('调到{0}', t(ROLE_TEXT[r] ?? r))}
                        </button>
                      ))}
                    {s.roles[a.id] && (
                      <button className="chip" onClick={() => void run({ type: 'ChangeRole', associateId: a.id, role: a.role }, { quiet: true })}>
                        {t('回到{0}', t(ROLE_TEXT[a.role] ?? a.role))}
                      </button>
                    )}
                    <button className="link" onClick={() => void run({ type: 'LockAssociate', associateId: a.id, locked: !locked }, { quiet: true })}>
                      {locked ? t('取消固定') : t('固定')}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function ModelsView() {
  const { client, auth } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const [data, setData] = useState<AiSummary | undefined>();
  const [busy, setBusy] = useState(false);
  const load = () =>
    ai
      .models(auth)
      .then(setData)
      .catch((e: unknown) => toast(String(e), 'error'));
  useEffect(() => {
    void load();
  }, []);
  const act = async (fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(ok(r as never), 'ok');
      await load();
    } catch (e) {
      toast(String(e).includes('nothing_to_roll_back') ? t('没有可以回滚的版本') : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <p className="muted center">{t('正在载入模型…')}</p>;
  const trained = (r: { promoted: boolean; best: number }) => (r.promoted ? t('v{0} 已上线', r.best) : t('v{0} 没有通过上线检查，保留当前版本', r.best));
  return (
    <div className="list">
      {FAMILIES.map((f) => (
        <FamilySection key={f.id} family={f} models={data.models.filter((m) => m.id === f.id)} />
      ))}
      {can && (
        <div className="actions ai-actions">
          <button className="primary" disabled={busy} onClick={() => void act(() => ai.forecast(auth), () => t('已发出预测'))}>
            {t('立即预测')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.scan(auth), (r: { shelves: number; counts: number }) => t('发出 {0} 条核对货架、{1} 条盘点建议', r.shelves, r.counts))}>
            {t('立即检查货架与盘点风险')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.retrain(auth), trained)}>
            {t('重新训练')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.retrain(auth, ['seasonal-naive']), trained)}>
            {t('用较弱的模型测试上线检查')}
          </button>
          <button className="link danger" disabled={busy} onClick={() => void act(() => ai.rollback(auth), (r: { champion?: number }) => t('已回滚到 v{0}', r.champion ?? 0))}>
            {t('回滚订单量模型')}
          </button>
        </div>
      )}
    </div>
  );
}

function metricText(k: string, v: number | undefined, minutes: boolean): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  if (k === 'ece') return `${(v * 100).toFixed(1)}%`;
  if (PERCENT_METRICS.has(k)) return pct(v);
  if (k === 'meanDetectDays') return t('{0} 天', v.toFixed(1));
  if (k === 'brier' || k === 'auc' || k === 'ndcg3') return v.toFixed(3);
  if (k === 'avgInaccurate') return v.toFixed(1);
  return minutes && (k === 'mae' || k === 'maeRepeat' || k === 'bias') ? t('{0} 分钟', v.toFixed(1)) : v.toFixed(2);
}

function FamilySection({ family, models }: { family: (typeof FAMILIES)[number]; models: AiModelInfo[] }) {
  const champ = models.find((m) => m.status === 'CHAMPION');
  const latest = [...models].sort((a, b) => b.trainedAt - a.trainedAt || b.version - a.version);
  const lastGate = latest.find((m) => m.gate && m.gate.checks.length > 0);
  return (
    <>
      <h2 className="section-title">{t(family.title)}</h2>
      {champ && (
        <section className="card">
          <div className="card-head">
            <span className="strong">{t('当前版本 v{0}', champ.version)}</span>
            <span className="tag ok">{kindText(champ.kind)}</span>
            <span className="due">{new Date(champ.trainedAt).toLocaleDateString()}</span>
          </div>
          <p className="note">
            {family.id === 'substitution'
              ? t('仿真预训练：合成替代记录（顾客有忠于品牌、对价格敏感、坚持有机等模型看不到的偏好）')
              : family.id === 'shelf-availability'
              ? t('仿真预训练：{0} 天的合成货架真实存量（含模型看不到的整批丢失、放错位置和零星损耗）', champ.data.days)
              : family.id === 'count-risk'
                ? t('仿真预训练：{0} 天的后仓记录（前一半用 ABC 周期盘点积累训练数据，后一半两种策略对比）', champ.data.days)
                : family.minutes
              ? t('仿真预训练：最近 {0} 天的合成到店记录（顾客习惯、高峰、天气，以及模型看不到的顺路办事）', champ.data.days)
              : champ.data.source === 'SIM'
                ? t('仿真预训练：用本店配置生成 {0} 天合成历史（含模型看不到的本地活动和一次需求变化）', champ.data.days)
                : t('合成历史 {0} 天，其中真实营业日 {1} 天（合成数据权重 {2}）', champ.data.days, champ.data.liveDays ?? 0, champ.data.simWeight ?? 1)}
          </p>
          <div className="facts">
            {family.metrics.map((k) => (
              <span key={k}>
                {t(METRIC_TEXT[k] ?? k)} <b>{metricText(k, champ.metrics[k], family.minutes)}</b>
              </span>
            ))}
          </div>
          <p className="note">{t(EVAL_TEXT[family.id] ?? '')}</p>
        </section>
      )}
      {lastGate?.gate && (
        <section className="card">
          <div className="card-head">
            <span className="strong">{t('最近一次上线检查：v{0}', lastGate.version)}</span>
            <span className={`tag ${lastGate.gate.passed ? 'ok' : ''}`}>{lastGate.gate.passed ? t('通过') : t('未通过')}</span>
          </div>
          <ul className="plain">
            {lastGate.gate.checks.map((c) => (
              <li key={c.metric}>
                {t(
                  '{0} · {1}：候选 {2}，当前版本 {3}（{4}）',
                  c.rule === 'PRIMARY' ? t('主指标') : t('护栏'),
                  t(METRIC_TEXT[c.metric] ?? c.metric),
                  fmt(c.candidate),
                  fmt(c.champion),
                  `${c.change >= 0 ? '+' : ''}${pct(c.change)}`,
                )}
                <span className={`tag ${c.ok ? 'ok' : ''}`}>{c.ok ? '✓' : '✗'}</span>
              </li>
            ))}
          </ul>
          <p className="note">{t('新版本必须让主指标至少改善 1%，且护栏指标不明显变差，才会替换当前版本。对比时，当前版本在同一份数据上重新回测。')}</p>
        </section>
      )}
      <section className="card">
        <ul className="plain ai-versions">
          {latest.slice(0, 8).map((m) => (
            <li key={m.version}>
              <span className="mono">v{m.version}</span> {kindText(m.kind)} · {t(METRIC_TEXT[family.primary] ?? family.primary)} {metricText(family.primary, m.metrics[family.primary], family.minutes)}
              <span className={`tag ${m.status === 'CHAMPION' ? 'ok' : ''}`}>{t(MODEL_STATUS_TEXT[m.status])}</span>
              {m.note && <span className="muted">{noteText(m.note)}</span>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function fmt(v: number): string {
  return Number.isFinite(v) ? (Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2)) : '—';
}

/** 排班建议：各岗位每小时的建议人数（与当前的差别标出颜色） */
function StaffPlanTable({ rec }: { rec: LiveRec }) {
  const prm = rec.action.params ?? {};
  const first = Number(prm.first ?? 0);
  const rows = (['pick', 'stage', 'handoff'] as const).map((r) => ({ r, values: String(prm[r] ?? '').split(',').map(Number), current: Number(prm[`current${r[0]!.toUpperCase()}${r.slice(1)}`] ?? 0) }));
  const n = rows[0]?.values.length ?? 0;
  return (
    <div className="plan-wrap">
      <table className="plan">
        <thead>
          <tr>
            <th />
            {Array.from({ length: n }, (_, i) => (
              <th key={i}>{first + i}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, values, current }) => (
            <tr key={r}>
              <th>{t(ROLE_TEXT[r] ?? r)}</th>
              {values.map((v, i) => (
                <td key={i} className={v > current ? 'more' : v < current ? 'less' : ''}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">{t('数字是建议的在岗人数；比现在多的标绿色，比现在少的标灰色。')}</p>
    </div>
  );
}
