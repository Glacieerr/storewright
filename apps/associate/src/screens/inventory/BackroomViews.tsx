import { useEffect, useMemo, useState } from 'react';
import { suggestBins } from '@storewright/algorithms/replenish';
import { gtin14, parseDeliveryNote, parseGs1, type DeliveryNote } from '@storewright/domain';
import { binIndex, caseRecalled, planogramByItem, resolveScan, type LiveCase, type LiveReceipt, type StoreStatic } from '@storewright/ops';
import { ai, labelUrl, type DockSlot } from '../../api';
import { feedback } from '../../feedback';
import { clock, t } from '../../i18n';
import { useLive } from '../../live';
import { QtyInput } from '../../ui/QtyInput';
import { ScanBox } from '../../ui/ScanBox';
import { toast } from '../../ui/Toasts';
import { ZoneChip } from '../../ui/ZoneChip';
import { SopTip } from '../../ui/SopTip';

const DIFF_TEXT = { SHORT: '短少', OVER: '多出', DAMAGED: '损坏' } as const;

/** 送货单和到货通知比对（决策记录 0024 · G3）：每个商品应到几箱、送货单上几箱、批号和保质期；确认后按送货单收货 */
function NoteCompare({ r, note, onDone }: { r: LiveReceipt; note: DeliveryNote; onDone: () => void }) {
  const { client, run } = useLive();
  const byGtin = new Map([...planogramByItem(client.statics as StoreStatic).values()].map((p) => [p.gtin, p.name]));
  const gtins = [...new Set([...r.expected.map((l) => l.gtin), ...note.lines.map((l) => l.gtin)])];
  const rows = gtins.map((g) => {
    const exp = r.expected.find((l) => l.gtin === g);
    const got = note.lines.filter((l) => l.gtin === g);
    const n = got.reduce((a, l) => a + l.cases, 0);
    return { g, name: exp?.name ?? byGtin.get(g) ?? g, expected: exp?.cases ?? 0, onNote: n, lots: got };
  });
  const diff = rows.filter((x) => x.expected !== x.onNote).length;
  // 按实际点到的收（决策记录 0026）：默认是送货单上的数，可以改；破损的单独记，进待检区
  const [actual, setActual] = useState<Record<string, number>>({});
  const [broken, setBroken] = useState<Record<string, number>>({});
  // 送货单上的商品已经收过：再按送货单收会重复入库（流程梳理发现，决策记录 0025）
  const itemOf = new Map([...planogramByItem(client.statics as StoreStatic).values()].map((p) => [p.gtin, p.itemId]));
  const already = note.lines.some((l) => {
    const id = r.expected.find((x) => x.gtin === l.gtin)?.itemId ?? itemOf.get(l.gtin);
    const got = id ? r.received[id] : undefined;
    return !!got && got.cases + got.damaged > 0;
  });
  return (
    <div className="card note-compare">
      <h3 className="section-title">{note.order && note.order !== r.id ? t('送货单 {0}（和这张收货单 {1} 不一致，请核对）', note.order, r.id) : t('送货单比对')}</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('商品')}</th>
              <th>{t('应到')}</th>
              <th>{t('送货单')}</th>
              <th>{t('批号 / 保质期')}</th>
              <th>{t('实收')}</th>
              <th>{t('破损')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.g} className={x.expected !== x.onNote ? 'warn-text' : ''}>
                <td>{x.name}</td>
                <td className="mono">{x.expected}</td>
                <td className="mono">{x.onNote}</td>
                <td className="mono lot-cell">
                  {x.lots.map((l, i) => (
                    <span key={i}>
                      {l.lot}
                      {l.expiry ? <small>{l.expiry}</small> : null}
                    </span>
                  ))}
                </td>
                <td>
                  <input className="note-qty" type="number" inputMode="numeric" min={0} value={actual[x.g] ?? x.onNote} aria-label={t('{0} 实收几箱', x.name)} onChange={(e) => setActual((m) => ({ ...m, [x.g]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                </td>
                <td>
                  <input className="note-qty" type="number" inputMode="numeric" min={0} value={broken[x.g] ?? 0} aria-label={t('{0} 破损几箱', x.name)} onChange={(e) => setBroken((m) => ({ ...m, [x.g]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">{diff ? t('{0} 个商品和到货通知不一致：按实际点到的收，关闭收货单时会记下差异。', diff) : t('和到货通知一致。')}</p>
      {already && <p className="banner warn">{t('送货单上的商品已经收过一部分：再按送货单收会重复入库，请逐箱扫描补收。')}</p>}
      <div className="actions">
        <button onClick={onDone}>{t('取消')}</button>
        <button
          className="primary"
          disabled={already}
          onClick={async () => {
            // 每个商品按实际点到的收：好的进可售，破损的进待检区；同一个商品有几批时，差的数记在最后一批上
            let n = 0;
            for (const row of rows) {
              const got = Math.max(0, actual[row.g] ?? row.onNote);
              const bad = Math.min(got, broken[row.g] ?? 0);
              let good = got - bad;
              const lots = row.lots.length ? row.lots : [{ gtin: row.g, cases: good, lot: undefined, expiry: undefined }];
              for (const [i, l] of lots.entries()) {
                const k = i === lots.length - 1 ? good : Math.min(good, l.cases);
                good -= k;
                if (k > 0 && (await run({ type: 'ReceiveCases', receiptId: r.id, gtin: row.g, cases: k, ...(l.lot ? { lot: l.lot } : {}), ...(l.expiry ? { expiry: l.expiry } : {}) }, { quiet: true }))) n += k;
              }
              if (bad > 0 && (await run({ type: 'ReceiveCases', receiptId: r.id, gtin: row.g, cases: bad, damaged: true }, { quiet: true }))) n += bad;
            }
            toast(t('按送货单收了 {0} 箱（带批号和保质期）', n), 'ok');
            onDone();
          }}
        >
          {t('按送货单收货')}
        </button>
      </div>
      <p className="note">{t('没有二维码的送货单、只印了日期的标签要拍照读文字，需要视觉模型（可选，需要下载）；接上后用同一个入口。')}</p>
    </div>
  );
}

/** 收货：ASN → 卡车到店 → 扫描箱上原有条码，自动生成内部箱号并批量打印标签 → 关闭时与 ASN 比较（决策 I-01、I-02） */
export function ReceiveView() {
  const { client, auth } = useLive();
  const [open, setOpen] = useState<string | undefined>();
  const receipts = Object.values(client.state.receipts).sort((a, b) => b.createdAt - a.createdAt);
  // 卸货门计划（决策记录 0022 · A3）：每辆车预计几点开始卸、要等多久
  const [plan, setPlan] = useState<DockSlot[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void ai.docks(auth).then((x) => alive && setPlan(x.plan)).catch(() => undefined);
    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [auth, client.version]);
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
        const slot = plan.find((d) => d.receiptId === x.id);
        const late = x.firstExpectedAt !== undefined && x.expectedAt !== undefined ? Math.round((x.expectedAt - x.firstExpectedAt) / 60_000) : 0;
        return (
          <button key={x.id} className="row-btn card" onClick={() => setOpen(x.id)}>
            <span className="mono strong">{x.id}</span>
            <span>{x.supplier}</span>
            <span className="muted">
              {x.closedAt ? t('已关闭') : x.arrivedAt ? t('收货中 {0}/{1} 箱', got, expected) : x.expectedAt !== undefined ? t('在途 · {0} 箱 · 预计 {1}', expected, clock(x.expectedAt)) : t('在途 · {0} 箱', expected)}
              {!x.closedAt && !x.arrivedAt && late >= 5 && ` · ${t('晚 {0} 分钟', late)}`}
              {!x.closedAt && slot && slot.waitMin >= 1 && ` · ${t('卸货门：{0} 开始卸，要等 {1} 分钟', clock(slot.startAt), Math.round(slot.waitMin))}`}
            </span>
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
  // 批号和保质期（决策记录 0024 · C4）：扫箱上的 GS1 码时自动填，也可以手填
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  // 送货单（决策记录 0024 · G3）：扫送货单上的二维码，和到货通知比对，再按送货单一次收完
  const [note, setNote] = useState<DeliveryNote | undefined>();
  // 刚收的箱子（打印这几张标签）、关闭收货单的确认（决策记录 0026）
  const [lastCases, setLastCases] = useState<string[]>([]);
  const [closing, setClosing] = useState(false);
  const onScan = (raw: string) => {
    const dn = /\n|\(400\)/.test(raw) ? parseDeliveryNote(raw) : undefined;
    if (dn) {
      feedback('ok');
      setNote(dn);
      return;
    }
    const gs = parseGs1(raw);
    const gsGtin = gs?.gtin;
    if (gs && gsGtin) {
      const l = r.expected.find((x) => x.gtin === gsGtin) ?? [...byItem.values()].find((p) => p.gtin === gsGtin);
      if (!l) {
        feedback('error');
        return toast(t('商品目录里没有这个条码'), 'error');
      }
      feedback('ok');
      setLine({ gtin: gsGtin, name: l.name });
      setCases(gs.count ?? 1);
      setDamaged(false);
      setLot(gs.lot ?? '');
      setExpiry(gs.expiry ?? '');
      return;
    }
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
    setLot('');
    setExpiry('');
  };
  return (
    <div className="session">
      <button className="link" onClick={onBack}>
        ← {t('返回收货单')}
      </button>
      <h2>
        {r.id} · {r.supplier}
      </h2>
      {/* 第一次扫箱就算卡车到了（决策记录 0026）：「卡车已到」可以不点 */}
      {!r.arrivedAt && (
        <button className="block" onClick={() => void run({ type: 'ArriveTruck', receiptId: r.id })}>
          {t('卡车已到（扫第一箱时也会自动记下）')}
        </button>
      )}
      {!r.closedAt && <ScanBox label={t('扫描箱上原有条码，或送货单上的二维码')} onScan={onScan} />}
      {lastCases.length > 0 && (
        <p className="note">
          <a href={labelUrl(auth, `receipt/${r.id}?cases=${lastCases.join(',')}`)} target="_blank" rel="noreferrer">
            {t('打印刚收的 {0} 张箱标签', lastCases.length)}
          </a>
        </p>
      )}
      {!r.closedAt && !note && (
        <p className="note">
          {t('送货单上有二维码时扫一下，和到货通知比对后可以一次收完（带批号和保质期）。')}{' '}
          <button className="link" onClick={() => void ai.deliveryNote(auth, r.id).then((x) => setNote(parseDeliveryNote(x.text))).catch((e: unknown) => toast(String(e), 'error'))}>
            {t('演示：读取这车的送货单')}
          </button>
        </p>
      )}
      {note && !r.closedAt && <NoteCompare r={r} note={note} onDone={() => setNote(undefined)} />}
      {line && !r.closedAt && (
        <div className="card">
          <p className="strong">{line.name}</p>
          <QtyInput value={cases} onChange={setCases} min={1} max={200} label={t('收几箱')} />
          <label className="toggle">
            <input type="checkbox" checked={damaged} onChange={(e) => setDamaged(e.target.checked)} />
            {t('有破损（进入待检区）')}
          </label>
          <SopTip sopId="damaged-case" when={damaged} />
          <div className="actions">
            <input value={lot} placeholder={t('批号（可选）')} aria-label={t('批号（可选）')} onChange={(e) => setLot(e.target.value)} />
            <input type="date" value={expiry} aria-label={t('保质期（可选）')} onChange={(e) => setExpiry(e.target.value)} />
          </div>
          <button
            className="primary block"
            onClick={async () => {
              const before = new Set(Object.keys(client.state.cases));
              if (await run({ type: 'ReceiveCases', receiptId: r.id, gtin: line.gtin, cases, damaged, ...(lot.trim() ? { lot: lot.trim() } : {}), ...(expiry ? { expiry } : {}) })) {
                // 记下刚收的箱子，给出打印这几张标签的链接（决策记录 0026：以前按钮写着打印却不打印）
                setLastCases(Object.values(client.state.cases).filter((c) => c.receiptId === r.id && !before.has(c.id)).map((c) => c.id));
                toast(t('已收 {0} 箱，可以打印箱标签了', cases), 'ok');
                setLine(undefined);
              }
            }}
          >
            {t('收货 {0} 箱', cases)}
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
          {[...r.expected.map((l) => ({ itemId: l.itemId, name: l.name, cases: l.cases })), ...Object.keys(r.received).filter((id) => !r.expected.some((l) => l.itemId === id)).map((id) => ({ itemId: id, name: byItem.get(id)?.name ?? id, cases: 0 }))].map((l) => {
            const got = r.received[l.itemId];
            return (
              <tr key={l.itemId}>
                <td>
                  {l.name}
                  {/* 到货通知里没有的商品也列出来（决策记录 0026） */}
                  {!r.expected.some((x) => x.itemId === l.itemId) && <small className="muted"> · {t('通知里没有')}</small>}
                </td>
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
        {r.arrivedAt && !r.closedAt && !closing && <button onClick={() => setClosing(true)}>{t('关闭收货单')}</button>}
      </div>
      {/* 关闭前确认（决策记录 0026）：关了就不能再收这张单 */}
      {closing && !r.closedAt && (
        <div className="confirm-row">
          <span>{closeSummary(r)}</span>
          <button className="primary" onClick={() => void run({ type: 'CloseReceipt', receiptId: r.id }).then(() => setClosing(false))}>
            {t('确认关闭')}
          </button>
          <button onClick={() => setClosing(false)}>{t('取消')}</button>
        </div>
      )}
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

/** 关闭收货单前的小结：短少、多出、破损 */
function closeSummary(r: LiveReceipt): string {
  let short = 0;
  let over = 0;
  let damaged = 0;
  for (const l of r.expected) {
    const got = (r.received[l.itemId]?.cases ?? 0) + (r.received[l.itemId]?.damaged ?? 0);
    if (got < l.cases) short += l.cases - got;
    if (got > l.cases) over += got - l.cases;
  }
  for (const [id, v] of Object.entries(r.received)) {
    damaged += v.damaged;
    if (!r.expected.some((l) => l.itemId === id)) over += v.cases + v.damaged;
  }
  return short || over || damaged ? t('关了就不能再收这张单：短少 {0} 箱、多出 {1} 箱、破损 {2} 箱，会记下差异', short, over, damaged) : t('关了就不能再收这张单：和到货通知一致');
}

/** 上架：扫描箱子 → 系统建议库位（大类分区内最空的）→ 扫描库位确认；待检箱子处置为可售 / 退供应商 / 报废（决策 I-03、I-05） */
export function PutAwayView() {
  const { client, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const strict = !!s.settings?.requireScan;
  const [caseId, setCaseId] = useState<string | undefined>();
  // 待检转可售要选库位（决策记录 0026）；整托上架：先扫几箱，再扫一个库位
  const [toSellable, setToSellable] = useState(false);
  const [pallet, setPallet] = useState<string[] | undefined>();
  const pending = Object.values(s.cases)
    .filter((c) => c.state === 'RECEIVED' || (c.status === 'QA' && c.state === 'STORED'))
    .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
  const c: LiveCase | undefined = caseId ? s.cases[caseId] : undefined;
  const p = c ? planogramByItem(st).get(c.itemId) : undefined;
  const status = toSellable ? 'SELLABLE' : (c?.status ?? 'SELLABLE');
  const suggestions = useMemo(() => {
    if (!c) return [];
    const rules = st.bins.filter((b) => b.status === status);
    return suggestBins(rules, (code) => s.bins[code]?.length ?? 0, { tempZone: p?.tempZone ?? 'AMBIENT', chemical: p?.chemical ?? false, area: p?.area ?? 'GM' }, 3, status);
  }, [c, p, st, s, status, client.version]);
  const recalled = !!c && caseRecalled(s, c);

  const place = async (binCode: string, tap?: boolean) => {
    // 整托：同一个库位依次放进去，放不下时停下
    if (pallet?.length) {
      let n = 0;
      for (const id of pallet) {
        if (!(await run({ type: 'PutAwayCase', caseId: id, binCode, ...(tap ? { tap: true } : {}) }, { quiet: true }))) break;
        n++;
      }
      toast(n === pallet.length ? t('整托 {0} 箱放进了 {1}', n, binCode) : t('放进了 {0} 箱，{1} 放不下了，剩下的换一个库位', n, binCode), n === pallet.length ? 'ok' : 'error');
      setPallet(n === pallet.length ? [] : pallet.slice(n));
      setCaseId(undefined);
      return;
    }
    if (!c) return;
    const ok = toSellable ? await run({ type: 'ChangeCaseStatus', caseId: c.id, status: 'SELLABLE', binCode, ...(tap ? { tap: true } : {}) }) : await run({ type: 'PutAwayCase', caseId: c.id, binCode, ...(tap ? { tap: true } : {}) });
    if (ok) {
      setCaseId(undefined);
      setToSellable(false);
    }
  };
  const onScan = (raw: string) => {
    const r = resolveScan(s, st, raw);
    if (r.kind === 'case') {
      if (pallet) {
        const x = s.cases[r.caseId];
        if (!x || x.state !== 'RECEIVED') return toast(t('这一箱不用上架'), 'error');
        if (!pallet.includes(r.caseId)) setPallet([...pallet, r.caseId]);
        return setCaseId(r.caseId);
      }
      setToSellable(false);
      return setCaseId(r.caseId);
    }
    if (r.kind === 'bin') {
      if (!c && !pallet?.length) return toast(t('请先扫描箱子'), 'error');
      return void place(r.code);
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
  };
  const dispose = (status: 'SELLABLE' | 'RTV' | 'SCRAP') => {
    if (!c || !p) return;
    const zone = p.tempZone === 'CHILLED' ? 'CHL' : p.tempZone === 'FROZEN' ? 'FRZ' : 'AMB';
    // 检验合格放回可售：选一个库位、扫库位标签放进去（决策记录 0026：以前自动选库位，记录和实际可能不一样）
    if (status === 'SELLABLE') {
      setToSellable(true);
      return;
    }
    void run({ type: 'ChangeCaseStatus', caseId: c.id, status, binCode: `${status}-${zone}` }).then((ok) => ok && setCaseId(undefined));
  };
  return (
    <div className="stage">
      <div className="row-line">
        <ScanBox label={pallet ? t('整托：扫箱子，最后扫库位（已扫 {0} 箱）', pallet.length) : c ? (strict ? t('扫描库位标签') : t('扫描库位标签（或点建议库位）')) : t('扫描箱标签')} onScan={onScan} />
      </div>
      <label className="toggle">
        <input type="checkbox" checked={!!pallet} onChange={(e) => setPallet(e.target.checked ? [] : undefined)} />
        <span>{t('整托上架：先扫这一托的几箱，再扫一个库位')}</span>
      </label>
      {pallet && pallet.length > 0 && (
        <p className="note">
          {t('这一托：{0}', pallet.map((id) => s.cases[id]?.name ?? id).join('、'))}{' '}
          <button className="link" onClick={() => setPallet([])}>
            {t('清空')}
          </button>
        </p>
      )}
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
          {c.status === 'QA' && c.state === 'STORED' && !toSellable ? (
            <div className="actions">
              {/* 召回中的商品不能放回可售（决策记录 0025） */}
              <button className="primary" disabled={recalled} title={recalled ? t('召回中，不能放回可售') : undefined} onClick={() => dispose('SELLABLE')}>
                {t('检验合格：可售')}
              </button>
              <button onClick={() => dispose('RTV')}>{t('退供应商')}</button>
              <button className="danger" onClick={() => dispose('SCRAP')}>
                {t('报废')}
              </button>
            </div>
          ) : (
            <>
              <h4>{toSellable ? t('放回可售：选一个库位，扫库位标签放进去') : t('建议库位')}</h4>
              <div className="chips">
                {suggestions.map((code) => (
                  <button key={code} className="chip mono" disabled={strict} onClick={() => void place(code, true)}>
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
            <button className={`row-btn${x.id === caseId ? ' selected' : ''}`} disabled={strict} onClick={() => setCaseId(x.id)}>
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
  const st = client.statics as StoreStatic;
  const strict = !!s.settings?.requireScan;
  const [counted, setCounted] = useState<Record<string, number>>({});
  // 扫到的库位标签（手动确认时是 '*'）；数的时候发现的、记录里没有的商品（决策记录 0026）
  const [atBin, setAtBin] = useState<string | undefined>();
  const [extra, setExtra] = useState<Record<string, string>>({});
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
    for (const [id, name] of Object.entries(extra)) if (!items.has(id)) items.set(id, name);
    const byGtin = new Map([...planogramByItem(st).values()].map((p) => [p.gtin, p]));
    const onScan = (raw: string) => {
      const r = resolveScan(s, st, raw);
      if (r.kind === 'bin') {
        if (r.code !== mine.binCode) {
          feedback('error');
          return toast(t('库位不对：应该是 {0}', mine.binCode), 'error');
        }
        feedback('ok');
        return setAtBin(r.code);
      }
      // 记录里没有的商品：扫商品条码或箱子加一行
      const p = r.kind === 'item' ? (byGtin.get(r.gtin) ?? [...byGtin.values()].find((x) => gtin14(x.gtin) === gtin14(r.gtin))) : r.kind === 'case' ? planogramByItem(st).get(r.itemId) : undefined;
      if (p && atBin) {
        if (!items.has(p.itemId)) {
          setExtra((m) => ({ ...m, [p.itemId]: p.name }));
          toast(t('加了一行：{0}（记录里没有）', p.name), 'info');
        }
        return;
      }
      feedback('error');
      toast(atBin ? t('无法识别：{0}', raw) : t('先扫库位标签 {0}', mine.binCode), 'error');
    };
    return (
      <div className="session">
        <h2>
          {t('盘点库位 {0}', mine.binCode)} <span className="tag">{t(COUNT_REASON[mine.reason] ?? mine.reason)}</span>
        </h2>
        <ScanBox label={atBin ? t('扫描记录里没有的商品（可选）') : t('到库位 {0}，扫描库位标签开始', mine.binCode)} onScan={onScan} />
        {!atBin && !strict && (
          <button className="link" onClick={() => setAtBin('*')}>
            {t('没有库位标签？手动确认已到库位（演示）')}
          </button>
        )}
        {atBin && (
          <>
            <p className="note">{t('逐个商品数一数有几箱，不显示系统数量（盲盘）。可以直接输入数字。')}</p>
            <ul className="tote-list">
              {[...items.entries()].map(([itemId, name]) => (
                <li key={itemId} className="count-row">
                  <span>
                    {name}
                    {extra[itemId] && <small className="muted"> · {t('记录里没有')}</small>}
                  </span>
                  <QtyInput value={counted[itemId] ?? 0} onChange={(v) => setCounted((m) => ({ ...m, [itemId]: v }))} label={t('{0} 有几箱', name)} />
                </li>
              ))}
            </ul>
            <button
              className="primary block"
              onClick={async () => {
                const results = [...items.keys()].map((itemId) => ({ itemId, counted: counted[itemId] ?? 0 }));
                if (await run({ type: 'CompleteCount', countId: mine.id, results, ...(atBin !== '*' ? { binCode: atBin } : { tap: true }) })) {
                  const done = client.state.counts[mine.id];
                  const diff = (done?.results ?? []).filter((r) => r.counted !== r.expected).length;
                  toast(diff ? t('已提交，{0} 个商品的记录已修正', diff) : t('已提交，记录一致'), 'ok');
                  setCounted({});
                  setExtra({});
                  setAtBin(undefined);
                }
              }}
            >
              {t('提交盘点')}
            </button>
          </>
        )}
        {/* 盘点放回队列（决策记录 0026） */}
        <button className="link" onClick={() => void run({ type: 'ReleaseCount', countId: mine.id }).then((ok) => ok && setAtBin(undefined))}>
          {t('放回队列')}
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
