import { useMemo, useState } from 'react';
import { suggestBins } from '@storewright/algorithms/replenish';
import { binIndex, planogramByItem, resolveScan, type LiveCase, type LiveReceipt, type StoreStatic } from '@storewright/ops';
import { labelUrl } from '../../api';
import { feedback } from '../../feedback';
import { t } from '../../i18n';
import { useLive } from '../../live';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';
import { ZoneChip } from '../../ui/ZoneChip';

const DIFF_TEXT = { SHORT: '短少', OVER: '多出', DAMAGED: '损坏' } as const;

/** 收货：ASN → 卡车到店 → 扫描箱上原有条码，自动生成内部箱号并批量打印标签 → 关闭时与 ASN 比较（决策 I-01、I-02） */
export function ReceiveView() {
  const { client } = useLive();
  const [open, setOpen] = useState<string | undefined>();
  const receipts = Object.values(client.state.receipts).sort((a, b) => b.createdAt - a.createdAt);
  const r = open ? client.state.receipts[open] : undefined;
  if (r) return <ReceiptView r={r} onBack={() => setOpen(undefined)} />;
  if (!receipts.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('没有到货通知')}</p>
        <p>{t('供应商发出 ASN 后会出现在这里（演示中由控制台发送）。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <h2 className="section-title">{t('收货单（{0}）', receipts.length)}</h2>
      {receipts.map((x) => {
        const expected = x.expected.reduce((n, l) => n + l.cases, 0);
        const got = Object.values(x.received).reduce((n, v) => n + v.cases + v.damaged, 0);
        return (
          <button key={x.id} className="row-btn card" onClick={() => setOpen(x.id)}>
            <span className="mono strong">{x.id}</span>
            <span>{x.supplier}</span>
            <span className="muted">{x.closedAt ? t('已关闭') : x.arrivedAt ? t('收货中 {0}/{1} 箱', got, expected) : t('在途 · {0} 箱', expected)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReceiptView({ r, onBack }: { r: LiveReceipt; onBack: () => void }) {
  const { client, auth, run } = useLive();
  const st = client.statics as StoreStatic;
  const byItem = planogramByItem(st);
  const [line, setLine] = useState<{ gtin: string; name: string } | undefined>();
  const [cases, setCases] = useState(1);
  const [damaged, setDamaged] = useState(false);
  const onScan = (raw: string) => {
    const res = resolveScan(client.state, st, raw);
    if (res.kind !== 'item') {
      feedback('error');
      return toast(t('请扫描箱上原有的商品条码'), 'error');
    }
    const g = res.gtin.padStart(14, '0');
    const l = r.expected.find((x) => x.gtin === g) ?? [...byItem.values()].find((p) => p.gtin === g);
    if (!l) {
      feedback('error');
      return toast(t('商品目录里没有这个条码'), 'error');
    }
    feedback('ok');
    setLine({ gtin: g, name: l.name });
    setCases(1);
    setDamaged(false);
  };
  return (
    <div className="session">
      <button className="link" onClick={onBack}>
        ← {t('返回收货单')}
      </button>
      <h2>
        {r.id} · {r.supplier}
      </h2>
      {!r.arrivedAt && (
        <button className="primary block" onClick={() => void run({ type: 'ArriveTruck', receiptId: r.id })}>
          {t('卡车已到，开始收货')}
        </button>
      )}
      {r.arrivedAt && !r.closedAt && <ScanBox label={t('扫描箱上原有条码')} onScan={onScan} />}
      {line && !r.closedAt && (
        <div className="card">
          <p className="strong">{line.name}</p>
          <div className="stepper">
            <button onClick={() => setCases((c) => Math.max(1, c - 1))}>−</button>
            <b className="mono">{cases}</b>
            <button onClick={() => setCases((c) => Math.min(200, c + 1))}>+</button>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={damaged} onChange={(e) => setDamaged(e.target.checked)} />
            {t('有破损（进入待检区）')}
          </label>
          <button
            className="primary block"
            onClick={async () => {
              if (await run({ type: 'ReceiveCases', receiptId: r.id, gtin: line.gtin, cases, damaged })) {
                toast(t('已收 {0} 箱，内部标签已生成', cases), 'ok');
                setLine(undefined);
              }
            }}
          >
            {t('收货并打印 {0} 张箱标签', cases)}
          </button>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('商品')}</th>
            <th>{t('应到')}</th>
            <th>{t('实收')}</th>
          </tr>
        </thead>
        <tbody>
          {r.expected.map((l) => {
            const got = r.received[l.itemId];
            return (
              <tr key={l.itemId}>
                <td>{l.name}</td>
                <td className="mono">{l.cases}</td>
                <td className="mono">
                  {got ? got.cases + got.damaged : 0}
                  {got?.damaged ? ` (${t('破损 {0}', got.damaged)})` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions">
        <a className="button" href={labelUrl(auth, `receipt/${r.id}`)} target="_blank" rel="noreferrer">
          {t('打印本单箱标签')}
        </a>
        {r.arrivedAt && !r.closedAt && <button onClick={() => void run({ type: 'CloseReceipt', receiptId: r.id })}>{t('关闭收货单')}</button>}
      </div>
      {r.discrepancies && (
        <div className="card">
          <h3 className="section-title">{r.discrepancies.length ? t('收货差异') : t('与 ASN 一致')}</h3>
          <ul className="plain">
            {r.discrepancies.map((d, i) => (
              <li key={i}>
                {byItem.get(d.itemId)?.name ?? d.itemId} · {t(DIFF_TEXT[d.kind])} · {t('应到 {0}，实收 {1}', d.expected, d.received)}
                {d.damaged ? ` · ${t('破损 {0}', d.damaged)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 上架：扫描箱子 → 系统建议库位（大类分区内最空的）→ 扫描库位确认；待检箱子处置为可售 / 退供应商 / 报废（决策 I-03、I-05） */
export function PutAwayView() {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const [caseId, setCaseId] = useState<string | undefined>();
  const pending = Object.values(s.cases)
    .filter((c) => c.state === 'RECEIVED' || (c.status === 'QA' && c.state === 'STORED'))
    .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
  const c: LiveCase | undefined = caseId ? s.cases[caseId] : undefined;
  const p = c ? planogramByItem(st).get(c.itemId) : undefined;
  const suggestions = useMemo(() => {
    if (!c) return [];
    const rules = st.bins.filter((b) => b.status === c.status);
    return suggestBins(rules, (code) => s.bins[code]?.length ?? 0, { tempZone: p?.tempZone ?? 'AMBIENT', chemical: p?.chemical ?? false, area: p?.area ?? 'GM' }, 3, c.status);
  }, [c, p, st, s, client.version]);

  const place = (binCode: string) => c && void run({ type: 'PutAwayCase', caseId: c.id, binCode }).then((ok) => ok && setCaseId(undefined));
  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind === 'case') return setCaseId(r.caseId);
    if (r.kind === 'bin') {
      if (!c) return toast(t('请先扫描箱子'), 'error');
      return place(r.code);
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };
  const dispose = (status: 'SELLABLE' | 'RTV' | 'SCRAP') => {
    if (!c || !p) return;
    const zone = p.tempZone === 'CHILLED' ? 'CHL' : p.tempZone === 'FROZEN' ? 'FRZ' : 'AMB';
    if (status === 'SELLABLE') {
      const bin = suggestBins(st.bins.filter((b) => b.status === 'SELLABLE'), (code) => s.bins[code]?.length ?? 0, { tempZone: p.tempZone, chemical: p.chemical, area: p.area }, 1)[0];
      if (bin) void run({ type: 'ChangeCaseStatus', caseId: c.id, status, binCode: bin }).then((ok) => ok && setCaseId(undefined));
      return;
    }
    void run({ type: 'ChangeCaseStatus', caseId: c.id, status, binCode: `${status}-${zone}` }).then((ok) => ok && setCaseId(undefined));
  };
  return (
    <div className="stage">
      <ScanBox label={c ? t('扫描库位标签（或点建议库位）') : t('扫描箱标签')} onScan={onScan} />
      {c && (
        <article className="card">
          <div className="card-head">
            {p && <ZoneChip z={p.tempZone} />}
            <span className="strong">{c.name}</span>
            <span className="mono">{c.id}</span>
          </div>
          <p>
            {t('{0} 件', c.units)} · {c.status === 'QA' ? t('待检') : t('可售')}
            {c.binCode ? ` · ${t('当前在 {0}', c.binCode)}` : ''}
          </p>
          {c.status === 'QA' && c.state === 'STORED' ? (
            <div className="actions">
              <button className="primary" onClick={() => dispose('SELLABLE')}>
                {t('检验合格：可售')}
              </button>
              <button onClick={() => dispose('RTV')}>{t('退供应商')}</button>
              <button className="danger" onClick={() => dispose('SCRAP')}>
                {t('报废')}
              </button>
            </div>
          ) : (
            <>
              <h4>{t('建议库位')}</h4>
              <div className="chips">
                {suggestions.map((code) => (
                  <button key={code} className="chip mono" onClick={() => place(code)}>
                    {code} · {binIndex(st).get(code)?.area}
                  </button>
                ))}
                {!suggestions.length && <span className="banner warn">{t('没有空余的合适库位')}</span>}
              </div>
            </>
          )}
        </article>
      )}
      <h2 className="section-title">{t('待上架 / 待检（{0}）', pending.length)}</h2>
      <ul className="tote-list">
        {pending.slice(0, 40).map((x) => (
          <li key={x.id}>
            <button className={`row-btn${x.id === caseId ? ' selected' : ''}`} onClick={() => setCaseId(x.id)}>
              <span className="mono">{x.id}</span>
              <span>{x.name}</span>
              <span className="muted">{x.status === 'QA' ? t('待检') : t('{0} 件', x.units)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const COUNT_REASON: Record<string, string> = { SCHEDULED: '周期盘点', MANUAL: '手动', EXCEPTION_NOT_FOUND: '补取没找到', DISCREPANCY: '记录不符', REPLENISH_NOT_FOUND: '补货没找到', AI_RISK: 'AI 按风险建议' };

/** 盘点：领取 → 按库位清点每个商品的箱数（盲盘，不显示系统数量）→ 提交后修正记录（决策 I-04） */
export function CountView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const [counted, setCounted] = useState<Record<string, number>>({});
  const mine = Object.values(s.counts).find((c) => c.status === 'CLAIMED' && c.associateId === auth.actor);
  const open = Object.values(s.counts)
    .filter((c) => c.status === 'OPEN')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (mine) {
    const items = new Map<string, string>();
    for (const id of s.bins[mine.binCode] ?? []) {
      const c = s.cases[id];
      if (c && c.state === 'STORED') items.set(c.itemId, c.name);
    }
    if (mine.itemId && !items.has(mine.itemId)) items.set(mine.itemId, s.cases[Object.keys(s.cases).find((k) => s.cases[k]?.itemId === mine.itemId) ?? '']?.name ?? mine.itemId);
    return (
      <div className="session">
        <h2>
          {t('盘点库位 {0}', mine.binCode)} <span className="tag">{t(COUNT_REASON[mine.reason] ?? mine.reason)}</span>
        </h2>
        <p className="note">{t('逐个商品数一数有几箱，不显示系统数量（盲盘）。')}</p>
        <ul className="tote-list">
          {[...items.entries()].map(([itemId, name]) => (
            <li key={itemId} className="count-row">
              <span>{name}</span>
              <div className="stepper small">
                <button onClick={() => setCounted((m) => ({ ...m, [itemId]: Math.max(0, (m[itemId] ?? 0) - 1) }))}>−</button>
                <b className="mono">{counted[itemId] ?? 0}</b>
                <button onClick={() => setCounted((m) => ({ ...m, [itemId]: (m[itemId] ?? 0) + 1 }))}>+</button>
              </div>
            </li>
          ))}
        </ul>
        <button
          className="primary block"
          onClick={async () => {
            const results = [...items.keys()].map((itemId) => ({ itemId, counted: counted[itemId] ?? 0 }));
            if (await run({ type: 'CompleteCount', countId: mine.id, results })) {
              const done = client.state.counts[mine.id];
              const diff = (done?.results ?? []).filter((r) => r.counted !== r.expected).length;
              toast(diff ? t('已提交，{0} 个商品的记录已修正', diff) : t('已提交，记录一致'), 'ok');
              setCounted({});
            }
          }}
        >
          {t('提交盘点')}
        </button>
      </div>
    );
  }
  if (!open.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('没有盘点任务')}</p>
        <p>{t('A 类每周、B 类每月、C 类每季度；补取或补货没找到时会立即生成。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <h2 className="section-title">{t('盘点任务（{0}）', open.length)}</h2>
      {open.map((c) => (
        <article key={c.id} className="card">
          <div className="card-head">
            <span className="mono strong">{c.binCode}</span>
            <span className="tag">{t(COUNT_REASON[c.reason] ?? c.reason)}</span>
          </div>
          <button className="primary block" onClick={() => void run({ type: 'ClaimCount', countId: c.id })}>
            {t('领取')}
          </button>
        </article>
      ))}
    </div>
  );
}
