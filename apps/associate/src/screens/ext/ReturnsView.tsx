import { useEffect, useState } from 'react';
import type { Reason } from '@storewright/ai';
import { displayName, returnBlocks, type ReturnCase, type ReturnDisposition, type ReturnLine } from '@storewright/ops';
import { returnSuggestion } from '../../api';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { ScanBox } from '../../ui/ScanBox';
import { reasonText, RETURN_BLOCK_TEXT } from '../AiScreen';

const CONDITION_TEXT: Record<ReturnLine['condition'], string> = { SEALED: '未开封', OPENED: '已开封', DAMAGED: '损坏' };
const DISPOSITION_TEXT: Record<ReturnDisposition, string> = { RESTOCK: '可售回架', DISPOSE: '报废', HAZMAT: '危险品回收', VENDOR: '退供应商' };
const DISPOSITIONS: ReturnDisposition[] = ['RESTOCK', 'DISPOSE', 'HAZMAT', 'VENDOR'];

/**
 * 退货（工作流设计 4.10）：逐件扫描并核对原订单，每件选去向；AI 给出去向建议和理由，员工决定，
 * 采纳与否计入 AI 统计。完成时发出退货完成事件（退款由外部系统处理）。
 */
export function ReturnsView() {
  const { client, run } = useLive();
  const s = client.state;
  const [open, setOpen] = useState<string | undefined>();
  const [kind, setKind] = useState<'CUSTOMER' | 'DELIVERY'>('CUSTOMER');
  const [orderId, setOrderId] = useState('');
  const r = open ? s.returns[open] : undefined;
  if (r) return <ReturnDetail r={r} onBack={() => setOpen(undefined)} />;
  const completed = Object.values(s.orders)
    .filter((o) => o.status === 'COMPLETED')
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, 20);
  const list = Object.values(s.returns).sort((a, b) => b.createdAt - a.createdAt);
  const start = async () => {
    const before = s.counters.returns;
    const ok = await run({ type: 'StartReturn', kind, ...(orderId ? { orderId } : {}) });
    if (ok) setOpen(`RT${String(before + 1).padStart(4, '0')}`);
  };
  return (
    <div className="list">
      <div className="card">
        <h2 className="section-title">{t('新退货')}</h2>
        <div className="segmented">
          <button className={kind === 'CUSTOMER' ? 'on' : ''} onClick={() => setKind('CUSTOMER')}>
            {t('顾客退货')}
          </button>
          <button className={kind === 'DELIVERY' ? 'on' : ''} onClick={() => setKind('DELIVERY')}>
            {t('配送退回')}
          </button>
        </div>
        <label className="field">
          <span>{t('原订单')}</span>
          <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">{t('没有订单（无小票退货）')}</option>
            {completed.map((o) => (
              <option key={o.id} value={o.id}>
                {o.shortCode} · {displayName(o.firstName, o.lastName.slice(0, 1))} · {clock(o.completedAt ?? o.slotStart)}
              </option>
            ))}
          </select>
        </label>
        <button className="primary block" onClick={() => void start()}>
          {t('开始退货')}
        </button>
      </div>
      {list.length > 0 && <h2 className="section-title">{t('退货单（{0}）', list.length)}</h2>}
      {list.map((x) => (
        <button key={x.id} className="row-btn card" onClick={() => setOpen(x.id)}>
          <span className="mono strong">{x.id}</span>
          <span>{x.orderId ? (s.orders[x.orderId]?.shortCode ?? x.orderId) : t('无订单')}</span>
          <span className="muted">{x.status === 'OPEN' ? t('处理中 · {0} 件', x.lines.length) : t('已完成 · 退款 ${0}', (x.refundValue ?? 0).toFixed(2))}</span>
        </button>
      ))}
    </div>
  );
}

function ReturnDetail({ r, onBack }: { r: ReturnCase; onBack: () => void }) {
  const { client, run } = useLive();
  const [condition, setCondition] = useState<ReturnLine['condition']>('SEALED');
  const [qty, setQty] = useState(1);
  const o = r.orderId ? client.state.orders[r.orderId] : undefined;
  const scan = (code: string) => void run({ type: 'ScanReturnItem', returnId: r.id, code, qty, condition }).then((ok) => ok && setQty(1));
  const done = r.lines.length > 0 && r.lines.every((l) => l.disposition);
  return (
    <div className="session">
      <button className="link" onClick={onBack}>
        ← {t('返回退货单')}
      </button>
      <h2>
        {r.id} · {r.kind === 'DELIVERY' ? t('配送退回') : t('顾客退货')}
        {o && <small className="muted"> · {o.shortCode}</small>}
      </h2>
      {r.status === 'OPEN' ? (
        <>
          <div className="chips">
            {(['SEALED', 'OPENED', 'DAMAGED'] as const).map((c) => (
              <button key={c} className={`chip${condition === c ? ' on' : ''}`} onClick={() => setCondition(c)}>
                {t(CONDITION_TEXT[c])}
              </button>
            ))}
          </div>
          <div className="qty-row">
            <span className="muted">{t('数量')}</span>
            <span className="stepper">
              <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label={t('减少')}>
                −
              </button>
              <b>{qty}</b>
              <button onClick={() => setQty(Math.min(50, qty + 1))} aria-label={t('增加')}>
                +
              </button>
            </span>
          </div>
          <ScanBox onScan={scan} label={t('扫描退回的商品')} />
          {o && (
            <details className="demo-pick">
              <summary>{t('原订单商品（演示：点选代替扫描）')}</summary>
              <div className="chips">
                {o.lines.map((l) => (
                  <button key={l.lineId} className="chip" onClick={() => scan(l.gtin)}>
                    {l.name}
                  </button>
                ))}
              </div>
            </details>
          )}
        </>
      ) : (
        <p className="banner info">{t('已完成 · 退款 ${0}（由外部系统处理）', (r.refundValue ?? 0).toFixed(2))}</p>
      )}
      {r.lines.map((l, i) => (
        <ReturnLineCard key={i} r={r} line={l} index={i} />
      ))}
      {r.status === 'OPEN' && (
        <button className="primary block" disabled={!done} onClick={() => void run({ type: 'CompleteReturn', returnId: r.id })}>
          {done ? t('完成退货') : t('每件都选好去向后才能完成')}
        </button>
      )}
    </div>
  );
}

interface Suggestion {
  disposition: string;
  p?: number;
  reasons: Array<{ factor: string; value?: number }>;
  model?: string;
}

function ReturnLineCard({ r, line, index }: { r: ReturnCase; line: ReturnLine; index: number }) {
  const { auth, run } = useLive();
  const [sug, setSug] = useState<Suggestion | undefined>();
  useEffect(() => {
    if (line.disposition || r.status !== 'OPEN') return;
    let alive = true;
    returnSuggestion(auth, r.id, index)
      .then((x) => alive && setSug(x))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [auth, r.id, r.status, index, line.disposition]);
  const suggested = (sug?.disposition ?? line.aiSuggested) as ReturnDisposition | undefined;
  // 硬性规则：被禁止的去向不能选，并说明原因
  const blocks = returnBlocks(line);
  const rules = [...new Set(Object.values(blocks))];
  return (
    <div className="card">
      <div className="card-head">
        <b>
          {line.name} × {line.qty}
        </b>
        <span className="tag">{t(CONDITION_TEXT[line.condition])}</span>
        {!line.inOrder && r.orderId && <span className="tag warn">{t('不在原订单里')}</span>}
        {line.chemical && <span className="tag warn">{t('化学品')}</span>}
        {line.disposition && <span className="tag ok">{t(DISPOSITION_TEXT[line.disposition])}</span>}
      </div>
      {!line.disposition && sug && (
        <div className="ext-ai">
          <b>
            {t('AI 建议：{0}', t(DISPOSITION_TEXT[sug.disposition as ReturnDisposition] ?? sug.disposition))}
            {sug.p !== undefined && ` · ${t('能再售的概率 {0}%', Math.round(sug.p * 100))}`}
          </b>
          {sug.reasons.length > 0 && (
            <ul className="ai-reasons">
              {sug.reasons.map((x, k) => (
                <li key={k}>{reasonText(x as Reason)}</li>
              ))}
            </ul>
          )}
          {!sug.model && <small className="muted">{t('还没有训练好的模型，按固定规则建议')}</small>}
          {sug.model && <small className="muted">{sug.model}</small>}
        </div>
      )}
      {r.status === 'OPEN' && !line.disposition && rules.length > 0 && (
        <ul className="rule-notes">
          {rules.map((x) => (
            <li key={x}>{t(RETURN_BLOCK_TEXT[x] ?? x)}</li>
          ))}
        </ul>
      )}
      {r.status === 'OPEN' && (
        <div className="chips">
          {DISPOSITIONS.map((d) => (
            <button
              key={d}
              disabled={!!blocks[d]}
              title={blocks[d] ? t(RETURN_BLOCK_TEXT[blocks[d] as string] ?? '') : undefined}
              className={`chip${line.disposition === d ? ' on' : ''}${!line.disposition && suggested === d ? ' suggested' : ''}`}
              onClick={() => void run({ type: 'SetReturnDisposition', returnId: r.id, index, disposition: d, ...(suggested ? { aiSuggested: suggested } : {}) })}
            >
              {t(DISPOSITION_TEXT[d])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
