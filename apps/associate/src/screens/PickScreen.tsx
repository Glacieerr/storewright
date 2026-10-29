import { useEffect, useMemo, useRef, useState } from 'react';
import { activeWalkOf, avoidFrozen, openWalks, pickBlockedItems, pickRows, resolveScan, sellableCases, walkOrder, walkOrderFor, walkRemaining, type LineFlag, type LiveWalk, type NotFoundReason, type PickRow, type WalkCheck } from '@storewright/ops';
import { parseVoiceCommand } from '@storewright/ai';
import { assistant, labelUrl, substitutes, type SubstituteSuggestion } from '../api';
import { feedback } from '../feedback';
import { clock, duration, getLang, t } from '../i18n';
import { useLive, useNow } from '../live';
import { gtinTail, locationParts, locationText } from '../format';
import { QtyInput } from '../ui/QtyInput';
import { ScanBox } from '../ui/ScanBox';
import { toast } from '../ui/Toasts';
import { ZoneChip } from '../ui/ZoneChip';
import { SopTip } from '../ui/SopTip';

/** 拣货：领取批次 → 扫描绑定框 → 按路线顺序逐行拣货 → 送到暂存区 */
export function PickScreen({ onDone }: { onDone: () => void }) {
  const { client, auth } = useLive();
  const walk = activeWalkOf(client.state, auth.actor);
  return walk ? <WalkView walk={walk} onDone={onDone} /> : <WalkList />;
}

function WalkList() {
  const { client, run, auth } = useLive();
  const now = useNow(15_000);
  // 自动运营的批次由虚拟员工处理，不在员工手机上显示
  // 含加急订单的批次（运营预警「提前开始」，决策记录 0021）排在最前；冷冻区待久了或刚做完重活的人，冷冻批次排到后面（决策记录 0023 · D5）
  const byMe = walkOrderFor(client.state, auth.actor, now);
  const walks = openWalks(client.state)
    .filter((w) => w.track !== 'AUTO')
    .sort((a, b) => byMe(a, b) || walkOrder(a, b));
  const rest = avoidFrozen(client.state, auth.actor, now);
  if (!walks.length) {
    return (
      <div className="empty">
        <p className="empty-title">{t('暂时没有可以领取的拣货批次')}</p>
        <p>{t('新的批次生成后会自动出现在这里。')}</p>
      </div>
    );
  }
  return (
    <div className="list">
      <h2 className="section-title">{t('可以领取的批次（{0}）', walks.length)}</h2>
      {rest && <p className="note">{t('你在冷冻区待得比较久（或刚做完重活）：冷冻批次排到了后面，先接常温的')}</p>}
      {walks.map((w) => {
        const rows = pickRows(client.state, w).filter((r) => !r.cancelled);
        const sec = w.ai?.sec ?? w.estimatedSec;
        const late = w.dueAt < now + sec * 1000;
        const flagged = Object.values(w.flags ?? {}).filter((f) => f.p < 0.4).length;
        return (
          <article key={w.id} className="card walk-card">
            <div className="card-head">
              <ZoneChip z={w.tempZone} />
              <span className="mono strong">{w.id}</span>
              {w.priority && <span className="tag warn-tag">{t('优先')}</span>}
              <span className={`due${late ? ' late' : ''}`}>{t('截止 {0}', clock(w.dueAt))}</span>
            </div>
            <div className="facts">
              <span>{t('{0} 个框', w.toteIds.length)}</span>
              <span>{t('{0} 个货位', w.stops.length)}</span>
              <span>{t('{0} 件', rows.reduce((n, r) => n + r.qty, 0))}</span>
              <span title={w.ai ? t('AI 按货位、商品类型、时段和熟练度组估计（标准工时 {0} 分钟）', Math.round(w.estimatedSec / 60)) : undefined}>
                {w.ai ? t('约 {0} 分钟（AI，{1}–{2}）', Math.max(1, Math.round(w.ai.sec / 60)), Math.max(1, Math.round(w.ai.low / 60)), Math.max(1, Math.round(w.ai.high / 60))) : t('约 {0} 分钟', Math.max(1, Math.round(w.estimatedSec / 60)))}
              </span>
              <span>{t('{0} 米', Math.round(w.distanceM))}</span>
            </div>
            {flagged > 0 && <p className="note warn-text">{t('{0} 行可能缺货：AI 已提前安排补货或排好替代', flagged)}</p>}
            {w.coldLimitSec !== undefined && <p className="note">{t('冷链时限 {0} 分钟：从第一件冷藏 / 冷冻商品放进框开始计时', Math.round(w.coldLimitSec / 60))}</p>}
            <button className="primary block" onClick={() => void run({ type: 'ClaimWalk', walkId: w.id })}>
              {t('领取这个批次')}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function WalkView({ walk, onDone }: { walk: LiveWalk; onDone: () => void }) {
  const { client, auth, run } = useLive();
  const s = client.state;
  const now = useNow(1000);
  // 门店要求扫码（决策记录 0026）：不显示点选代替扫码的按钮
  const strict = !!s.settings?.requireScan;
  const rows = useMemo(() => pickRows(s, walk).filter((r) => !r.cancelled), [s, walk, client.version]);
  const totes = walk.toteIds.map((id) => s.totes[id]).filter((x) => !!x && s.orders[x.orderId]?.status !== 'CANCELLED');
  const unbound = totes.filter((x) => x && !walk.bound.includes(x.id));
  const remaining = walkRemaining(s, walk);
  const doneUnits = rows.reduce((n, r) => n + r.done, 0);
  const totalUnits = rows.reduce((n, r) => n + r.qty, 0);
  // 跳过的行排到最后（决策记录 0026）：只在这台手机上记着
  const [deferred, setDeferred] = useState<Set<string>>(() => new Set());
  const rowKey = (r: PickRow) => `${r.toteId}|${r.lineId}`;
  const open = rows.filter((r) => r.done < r.qty);
  const current = open.find((r) => !deferred.has(rowKey(r))) ?? open[0];
  const [missing, setMissing] = useState<PickRow | null>(null);
  const [qtyFor, setQtyFor] = useState<{ row: PickRow; gtin?: string } | null>(null);
  const [handOver, setHandOver] = useState(false);
  const cancelledTotes = walk.toteIds.map((id) => s.totes[id]).filter((x) => !!x && s.orders[x.orderId]?.status === 'CANCELLED' && Object.keys(walk.done).some((k) => k.startsWith(`${x.id}|`)));
  // 批次里的订单被取消（决策记录 0026）：马上告诉拣货员
  const seenCancelled = useRef(cancelledTotes.length);
  useEffect(() => {
    if (cancelledTotes.length > seenCancelled.current) {
      feedback('error');
      toast(t('批次里有订单取消了：看上面的说明'), 'error');
    }
    seenCancelled.current = cancelledTotes.length;
  }, [cancelledTotes.length]);

  const cold = walk.coldStartedAt !== undefined && walk.coldLimitSec !== undefined ? walk.coldLimitSec - (now - walk.coldStartedAt) / 1000 : undefined;
  const left = remainingMin(walk, doneUnits, totalUnits, now);
  // 顺路核对（决策记录 0022 · C3）：拣过第 afterStop 站之后出现
  const stopIdx = current ? walk.stops.findIndex((x) => x.locationId === current.locationId) : walk.stops.length;
  const check = walk.checks?.find((c) => c.status === 'OPEN' && stopIdx > c.afterStop);
  const needsToteScan = (r: PickRow) => strict && !walk.bound.includes(r.toteId);
  // 拣货前补货已经上架（决策记录 0026：以前补完了这里还写「补货中」）
  const pullDone = (f?: LineFlag) => !!f?.pullTaskId && s.repl[f.pullTaskId]?.status === 'DONE';

  const onScan = (raw: string): boolean => {
    if (!client.statics) return true;
    const r = resolveScan(s, client.statics, raw);
    if (r.kind === 'label') {
      if (r.voided) {
        toast(t('这个标签已作废，请用新标签'), 'error');
        return true;
      }
      if (!walk.toteIds.includes(r.toteId)) {
        feedback('error');
        toast(t('这个框不在当前批次里'), 'error');
        return true;
      }
      if (walk.bound.includes(r.toteId)) {
        toast(t('这个框已经扫过了'), 'info');
        return true;
      }
      void run({ type: 'BindLabel', walkId: walk.id, labelId: r.labelId });
      return true;
    }
    if (r.kind === 'item' && current) {
      if (r.gtin !== current.gtin) {
        feedback('error');
        toast(t('不是这件商品：请找 {0}', current.name), 'error');
        return true;
      }
      // 这个框第一次放东西、门店要求扫码：先扫框（决策记录 0026）
      if (needsToteScan(current)) {
        feedback('error');
        toast(t('先扫一下框 {0}/{1} 的标签（第一次往这个框里放东西）', current.toteIndex, current.toteCount), 'error');
        return true;
      }
      // 多件同品：扫描一次后输入数量（决策 P-07）；关掉摄像头，在面板里填数量
      if (current.qty - current.done > 1) {
        setQtyFor({ row: current, gtin: r.gtin });
        return false;
      }
      void run({ type: 'PickItem', walkId: walk.id, toteId: current.toteId, lineId: current.lineId, qty: 1, gtin: r.gtin });
      return true;
    }
    feedback('error');
    toast(t('无法识别：{0}', raw), 'error');
    return true;
  };

  return (
    <div className="walk">
      <header className="walk-head">
        <ZoneChip z={walk.tempZone} big />
        <div>
          <div className="mono strong">{walk.id}</div>
          <div className="muted">{t('截止 {0} · 已拣 {1} / {2} 件', clock(walk.dueAt), doneUnits, totalUnits)}</div>
          {left !== undefined && <div className="muted small">{t('AI 预计还要约 {0} 分钟', left)}</div>}
        </div>
        {cold !== undefined && (
          <div className={`cold${cold < 300 || walk.coldAlerted ? ' alert' : ''}`} role="timer">
            <span>{t('冷链')}</span>
            <b className="mono">{cold > 0 ? duration(cold) : t('已超时')}</b>
          </div>
        )}
      </header>
      <div className="progress" aria-hidden>
        <i style={{ width: `${totalUnits ? (doneUnits / totalUnits) * 100 : 0}%` }} />
      </div>
      {walk.coldAlerted && <p className="banner error">{t('冷链超时：请立即把冷藏 / 冷冻框送回暂存区')}</p>}
      {/* 批次里的订单取消了（决策记录 0026）：已经拣的商品跟着框走，暂存时放进回收专区 */}
      {cancelledTotes.length > 0 && (
        <div className="banner warn">
          {cancelledTotes.map((x) =>
            x ? (
              <p key={x.id}>{t('订单 {0} 已取消：框 {1}/{2} 里已经拣的商品不用再拣，送到暂存时放进回收专区。', s.orders[x.orderId]?.shortCode ?? '', x.index, x.count)}</p>
            ) : null,
          )}
        </div>
      )}
      {/* 第一次拣冷链批次（决策记录 0024 · D4） */}
      <SopTip sopId="cold-chain" when={walk.tempZone === 'CHILLED' || walk.tempZone === 'FROZEN'} />
      {/* 已经超时也能转（流程梳理发现，决策记录 0025）：不然要逐行标缺货才能完成批次 */}
      {(walk.coldAlerted || (walk.coldRisk?.overSec ?? 0) >= 60) && current && (
        <div className="banner warn cold-risk">
          <p>
            {walk.coldAlerted
              ? t('已经超时：剩下的 {0} 行可以转给别人，先把拣好的框送回暂存。', open.length)
              : t('按现在的速度，冷链会超时约 {0} 分钟（还剩 {1} 个货位）。', Math.round((walk.coldRisk?.overSec ?? 0) / 60), walk.coldRisk?.remainingLines ?? 0)}
          </p>
          <button className="primary" onClick={() => void handOverRest(walk, s, run)}>
            {t('剩下的转给别人，先送回暂存')}
          </button>
        </div>
      )}

      {/* 贴标签（决策记录 0026）：可以先逐个扫框，也可以直接开拣，第一次往框里放东西时再扫 */}
      {unbound.length > 0 && (
        <details className="phase bind-phase" open={doneUnits === 0}>
          <summary className="section-title">{t('贴标签：已扫 {0} / {1} 个框', totes.length - unbound.length, totes.length)}</summary>
          <p className="note">{strict ? t('可以先逐个扫框；也可以直接开拣，第一次往框里放东西时先扫一下那个框。') : t('可以先逐个扫框；也可以直接开拣，第一次往框里放东西时会自动绑定。')}</p>
          <ScanBox label={t('扫描框上的标签')} onScan={onScan} />
          <ul className="tote-list">
            {totes.map((x) => {
              if (!x) return null;
              const o = s.orders[x.orderId];
              const bound = walk.bound.includes(x.id);
              return (
                <li key={x.id} className={bound ? 'done' : ''}>
                  <button className="row-btn" disabled={bound || strict} onClick={() => x.labelId && void run({ type: 'BindLabel', walkId: walk.id, labelId: x.labelId, tap: true })}>
                    <span className="check">{bound ? '✓' : ''}</span>
                    <span className="mono">{x.labelId?.replace('SW1:', '')}</span>
                    <span>{t('订单 {0}', o?.shortCode ?? '')}</span>
                    <span>{t('框 {0}/{1}', x.index, x.count)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="note">
            {!strict && <>{t('没有扫码枪时，点一下框也可以绑定（演示用）。')} </>}
            <a href={labelUrl(auth, `walk/${walk.id}`)} target="_blank" rel="noreferrer">
              {t('打印本批标签')}
            </a>
          </p>
        </details>
      )}

      {current ? (
        <section className="phase">
          {check && <WalkCheckCard key={check.itemId} walk={walk} check={check} />}
          <PickCard row={current} total={rows.length} index={rows.indexOf(current)} flag={walk.flags?.[rowKey(current)]} pullDone={pullDone(walk.flags?.[rowKey(current)])} recalled={pickBlockedItems(s).has(current.itemId)} />
          {!walk.bound.includes(current.toteId) && (
            <p className="note warn-text">
              {strict ? t('框 {0}/{1} 第一次放东西：先扫一下这个框的标签，再扫商品。', current.toteIndex, current.toteCount) : t('框 {0}/{1} 第一次放东西：放进去时会自动绑定（有扫码枪时先扫一下框）。', current.toteIndex, current.toteCount)}
            </p>
          )}
          <ScanBox label={t('扫描商品条码')} hint={t('条码尾号 {0}', gtinTail(current.gtin))} onScan={onScan} />
          <div className="actions">
            {/* 召回中的商品不能拣（流程梳理发现，决策记录 0025）；门店要求扫码时只能扫商品（决策记录 0026） */}
            {!strict && (
              <button className="primary" disabled={pickBlockedItems(s).has(current.itemId)} onClick={() => void run({ type: 'PickItem', walkId: walk.id, toteId: current.toteId, lineId: current.lineId, qty: current.qty - current.done, tap: true })}>
                {t('已拣到 {0} 件', current.qty - current.done)}
              </button>
            )}
            <button className="warn" onClick={() => setMissing(current)}>
              {t('找不到')}
            </button>
          </div>
          <div className="pick-links">
            {/* 跳过这一行（决策记录 0026）：排到最后再拣 */}
            {open.length > 1 && (
              <button className="link" onClick={() => setDeferred((d) => new Set([...d, rowKey(current)]))}>
                {t('跳过这一行，最后再拣')}
              </button>
            )}
            {/* 框装满了（决策记录 0023 · B7）：同一订单补一个框，这个框里还没拣的行挪过去 */}
            <button
              className="link"
              onClick={async () => {
                if (await run({ type: 'AddTote', walkId: walk.id, toteId: current.toteId })) toast(t('已补一个框：这个框里还没拣的商品放进新框。点下面的「打印本批标签」给新框贴标签。'), 'ok');
              }}
            >
              {t('框 {0}/{1} 装满了？加一个框', current.toteIndex, current.toteCount)}
            </button>
            {/* 新补的框也要贴标签（流程梳理发现，决策记录 0025：以前只有绑定那一步有打印入口） */}
            <a className="link" href={labelUrl(auth, `walk/${walk.id}`)} target="_blank" rel="noreferrer">
              {t('打印本批标签')}
            </a>
            {/* 中途交接（决策记录 0026）：休息、下班时把剩下的行转给别人 */}
            {walk.status === 'PICKING' &&
              !walk.coldAlerted &&
              (handOver ? (
                <span className="confirm-row">
                  <span>{t('剩下的 {0} 行转给别人，你把拣好的框送去暂存？', open.length)}</span>
                  <button className="primary" onClick={() => void handOverRest(walk, s, run).then(() => setHandOver(false))}>
                    {t('确认转出')}
                  </button>
                  <button onClick={() => setHandOver(false)}>{t('取消')}</button>
                </span>
              ) : (
                <button className="link" onClick={() => setHandOver(true)}>
                  {t('剩下的转给别人（休息、下班）')}
                </button>
              ))}
          </div>
          <VoicePanel walk={walk} row={current} onNotFound={() => setMissing(current)} />
          <UpNext rows={open.filter((r) => r !== current).slice(0, 4)} flags={walk.flags} deferred={deferred} pullDone={pullDone} />
        </section>
      ) : (
        <section className="phase center">
          {check && <WalkCheckCard key={check.itemId} walk={walk} check={check} />}
          <p className="big-ok">✓</p>
          <h2>{t('这一车拣完了')}</h2>
          <p>{t('把推车送到暂存区，逐框扫描放进格位。')}</p>
          <button
            className="primary block"
            disabled={remaining > 0}
            onClick={async () => {
              if (await run({ type: 'CompleteWalk', walkId: walk.id })) onDone();
            }}
          >
            {t('完成拣货，去暂存')}
          </button>
        </section>
      )}

      {walk.status === 'CLAIMED' && (
        <button className="link danger" onClick={() => void run({ type: 'UnclaimWalk', walkId: walk.id })}>
          {t('放弃这个批次')}
        </button>
      )}
      {missing && <NotFoundSheet walk={walk} row={missing} strict={needsToteScan(missing)} onClose={() => setMissing(null)} />}
      {qtyFor && (
        <QtySheet
          row={qtyFor.row}
          onClose={() => setQtyFor(null)}
          onConfirm={(q) => void run({ type: 'PickItem', walkId: walk.id, toteId: qtyFor.row.toteId, lineId: qtyFor.row.lineId, qty: q, ...(qtyFor.gtin ? { gtin: qtyFor.gtin } : { tap: true }) }).then(() => setQtyFor(null))}
        />
      )}
    </div>
  );
}

/** 剩下的行转给别人：没拣的行进新批次（补新框），一件没拣的框作废，提示取下哪几个 */
async function handOverRest(walk: LiveWalk, s: ReturnType<typeof useLive>['client']['state'], run: ReturnType<typeof useLive>['run']): Promise<void> {
  const empty = walk.toteIds.filter((id) => !Object.keys(walk.done).some((k) => k.startsWith(`${id}|`))).map((id) => s.totes[id]);
  if (!(await run({ type: 'HandOverLines', walkId: walk.id }))) return;
  const names = empty.map((x) => (x ? t('框 {0}/{1}', x.index, x.count) : '')).filter(Boolean);
  toast(t('剩下的行已经放进一个新批次（补了新框）。先把已经拣好的框送回暂存。') + (names.length ? t('{0} 一件没拣，取下来不用。', names.join('、')) : ''), 'ok');
}

/**
 * 语音命令（决策记录 0024 · G2）：「下一个」「找不到」「数量 3」「记一下：……」，其他的话交给门店助手。
 * 语音转文字需要本地的语音识别模型（可选下载）；没有时在这里打字代替。
 */
function VoicePanel({ walk, row, onNotFound }: { walk: LiveWalk; row: PickRow; onNotFound: () => void }) {
  const { auth, run } = useLive();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const form = useRef<HTMLFormElement>(null);
  // 打开后滚到能看见的地方、光标放进输入框（在小屏幕上表单出现在屏幕下面，看起来像没反应）
  useEffect(() => {
    if (!open) return;
    form.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    form.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [open]);
  const left = row.qty - row.done;
  const handle = async (raw: string) => {
    const c = parseVoiceCommand(raw);
    setText('');
    switch (c.kind) {
      case 'NEXT':
        await run({ type: 'PickItem', walkId: walk.id, toteId: row.toteId, lineId: row.lineId, qty: left, tap: true });
        return;
      case 'QTY':
        if (c.qty > left) return toast(t('这一行只差 {0} 件', left), 'error');
        await run({ type: 'PickItem', walkId: walk.id, toteId: row.toteId, lineId: row.lineId, qty: c.qty, tap: true });
        return;
      case 'NOT_FOUND':
        onNotFound();
        return;
      case 'NOTE':
        if (await run({ type: 'AddNote', text: c.text, tags: [t('语音')], locationId: row.locationId })) toast(t('已记下：{0}', c.text), 'ok');
        return;
      case 'ASK': {
        const r = await assistant.ask(auth, c.text, getLang()).catch(() => undefined);
        toast(r?.answer ?? t('助手暂时不可用'), 'info', 8000);
        return;
      }
      default:
        toast(t('没听懂：{0}（可以说「下一个」「找不到」「数量 3」「记一下：……」）', c.text), 'error');
    }
  };
  if (!open)
    return (
      <button className="link" onClick={() => setOpen(true)}>
        {t('语音命令')}
      </button>
    );
  return (
    <form
      ref={form}
      className="voice"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void handle(text);
      }}
    >
      <input value={text} placeholder={t('说「下一个」「找不到」「数量 3」「记一下：……」')} aria-label={t('语音命令')} onChange={(e) => setText(e.target.value)} />
      <button className="primary">{t('执行')}</button>
      <button type="button" onClick={() => setOpen(false)}>
        {t('收起')}
      </button>
      <p className="note">{t('点一下输入框，用手机键盘上的话筒说（系统自带的听写），说完点「执行」。门店的本地语音识别模型下载后可以直接说，不用点输入框。')}</p>
    </form>
  );
}

/** 顺路核对（决策记录 0022 · C3）：AI 说不准这件商品还在不在架上，拣货员路过时顺手数一下，比专门派人核对省得多 */
function WalkCheckCard({ walk, check }: { walk: LiveWalk; check: WalkCheck }) {
  const { run } = useLive();
  const [units, setUnits] = useState(0);
  const p = locationParts(check.locationId);
  return (
    <article className="card walk-check" aria-live="polite">
      <div className="card-head">
        <span className="tag ok">{t('顺手数一下')}</span>
        <span className="strong">{check.name}</span>
      </div>
      <p className="note">{t('就在附近：{0} 通道 · {1} {2} 号 · 第 {3} 层。AI 说不准它还在不在架上，数一下大约 20 秒。', p.aisle, p.side, p.bay, p.level)}</p>
      <QtyInput value={units} onChange={setUnits} label={t('货架上有几件')} />
      <div className="actions">
        <button onClick={() => void run({ type: 'SkipWalkCheck', walkId: walk.id, itemId: check.itemId })}>{t('跳过')}</button>
        <button
          className="primary"
          onClick={async () => {
            if (await run({ type: 'ConfirmShelf', itemId: check.itemId, units, walkId: walk.id })) toast(units === 0 ? t('已记录：货架上没有，系统会安排补货') : t('已记录：货架上有 {0} 件', units), 'ok');
          }}
        >
          {t('提交 {0} 件', units)}
        </button>
      </div>
    </article>
  );
}

/** 找不到的原因（决策记录 0022 · C1）：帮 AI 判断是卖完了还是放错了地方 */
const NOT_FOUND_REASONS: ReadonlyArray<[NotFoundReason, string]> = [
  ['EMPTY', '空架'],
  ['NOT_AT_LOCATION', '不在原位'],
  ['DAMAGED', '损坏'],
  ['PRICE_TAG', '价签不对'],
  ['OTHER', '其他'],
];

/** AI 预计的剩余用时（分钟）：没做的部分 × 这一批到现在的「实际 ÷ 预计」（向 1 收缩） */
function remainingMin(w: LiveWalk, done: number, total: number, now: number): number | undefined {
  if (!w.ai || !total) return undefined;
  const frac = done / total;
  const elapsed = (now - (w.claimedAt ?? now)) / 1000;
  const expected = w.ai.sec * frac;
  const ratio = expected > 30 ? elapsed / expected : 1;
  const wgt = frac / (frac + 0.3);
  const factor = Math.min(2.5, Math.max(0.5, 1 + wgt * (ratio - 1)));
  return Math.max(1, Math.round((w.ai.sec * (1 - frac) * factor) / 60));
}

/** 缺货预判的提示（决策记录 0021 · B2） */
function FlagNote({ flag, pullDone }: { flag: LineFlag; pullDone?: boolean | undefined }) {
  // 货架上最早的一批快到期（决策记录 0024 · C4）
  const dated = flag.shortDated ? <p className="flag-note">{t('注意保质期：货架上最早的一批 {0} 到期，拿后面日期更晚的', flag.shortDated)}</p> : null;
  if (flag.p >= 0.4) return dated;
  if (pullDone) return <p className="flag-note">{t('补货员已经补上了这件商品')}</p>;
  const pct = Math.round(flag.p * 100);
  if (flag.pullTaskId)
    return <p className="flag-note">{flag.readyAt !== undefined ? t('可能缺货（找得到的概率 {0}%）· 已安排补货，预计 {1} 前补上', pct, clock(flag.readyAt)) : t('可能缺货（找得到的概率 {0}%）· 已有补货任务', pct)}</p>;
  const top = flag.subs?.[0];
  return <p className="flag-note">{top ? t('多半缺货（找得到的概率 {0}%）· 首选替代：{1}{2}', pct, top.name, top.p !== undefined ? t('（预计顾客接受 {0}%）', Math.round(top.p * 100)) : '') : t('多半缺货（找得到的概率 {0}%），后仓也没有', pct)}</p>;
}

function PickCard({ row, index, total, flag, pullDone, recalled }: { row: PickRow; index: number; total: number; flag?: LineFlag | undefined; pullDone?: boolean; recalled?: boolean }) {
  const p = locationParts(row.locationId);
  return (
    <article className="pick-card" aria-live="polite">
      {/* 召回中的商品（决策记录 0024 · C5）：不能拣，按找不到处理 */}
      {recalled && <p className="banner error">{t('召回商品：不要拣，按「找不到」处理（替代或缺货）')}</p>}
      {flag && <FlagNote flag={flag} pullDone={pullDone} />}
      <div className="pick-step muted">{t('第 {0} / {1} 行', index + 1, total)}</div>
      <div className="loc">
        <div>
          <small>{t('通道')}</small>
          <b>{p.aisle}</b>
        </div>
        <div>
          <small>{p.side}</small>
          <b>{p.bay}</b>
        </div>
        <div>
          <small>{t('层')}</small>
          <b>{p.level}</b>
        </div>
      </div>
      <h3 className="item-name">{row.name}</h3>
      <div className="pick-meta">
        <span className="qty">
          ×<b>{row.qty - row.done}</b>
        </span>
        <span>
          {t('放进框 {0}/{1}', row.toteIndex, row.toteCount)} · {t('订单 {0}', row.orderShortCode)}
        </span>
      </div>
      <div className="tags">
        {row.ageRestricted && <span className="tag">21+</span>}
        {!row.allowSubstitution && <span className="tag">{t('不允许替代')}</span>}
        {row.done > 0 && <span className="tag ok">{t('已拣 {0}', row.done)}</span>}
      </div>
    </article>
  );
}

function UpNext({ rows, flags, deferred, pullDone }: { rows: PickRow[]; flags?: Record<string, LineFlag> | undefined; deferred?: ReadonlySet<string>; pullDone?: (f?: LineFlag) => boolean }) {
  if (!rows.length) return null;
  return (
    <div className="upnext">
      <h4>{t('接下来')}</h4>
      <ol>
        {rows.map((r) => {
          const f = flags?.[`${r.toteId}|${r.lineId}`];
          return (
            <li key={`${r.toteId}|${r.lineId}`}>
              <span className="mono">{locationText(r.locationId)}</span>
              <span>
                {r.name} ×{r.qty - r.done}
                {f && f.p < 0.4 && (pullDone?.(f) ? <span className="tag ok">{t('已补上')}</span> : <span className="tag warn-tag">{f.pullTaskId ? t('补货中') : t('可能缺货')}</span>)}
                {deferred?.has(`${r.toteId}|${r.lineId}`) && <span className="tag">{t('跳过了')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function QtySheet({ row, onClose, onConfirm }: { row: PickRow; onClose: () => void; onConfirm: (q: number) => void }) {
  const max = row.qty - row.done;
  const [q, setQ] = useState(max);
  return (
    <div className="sheet" role="dialog" aria-label={t('数量')}>
      <div className="sheet-body">
        <h3>{row.name}</h3>
        <p>{t('还需要 {0} 件，这次放进框里几件？', max)}</p>
        <QtyInput value={q} onChange={setQ} min={1} max={max} label={t('放进框里几件')} />
        <div className="actions">
          <button onClick={onClose}>{t('取消')}</button>
          <button className="primary" onClick={() => onConfirm(q)}>
            {t('确认')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 找不到：替代（推荐附近同类商品）/ 转后仓补取 / 标记缺货（工作流设计 4.4、4.5 节） */
function NotFoundSheet({ walk, row, strict, onClose }: { walk: LiveWalk; row: PickRow; strict: boolean; onClose: () => void }) {
  const { auth, run, client } = useLive();
  // 只有库存记录显示后仓有货时才能转后仓补取（决策 P-08）
  const backroom = client.state.suspect[row.itemId] === undefined ? sellableCases(client.state, row.itemId).length : 0;
  const [subs, setSubs] = useState<SubstituteSuggestion[] | null>(null);
  const [subModel, setSubModel] = useState<string | undefined>();
  const [reason, setReason] = useState<NotFoundReason>('EMPTY');
  const top = walk.flags?.[`${row.toteId}|${row.lineId}`]?.subs?.[0];
  const qty = row.qty - row.done;
  const base = { walkId: walk.id, toteId: row.toteId, lineId: row.lineId, qty, reason } as const;
  const finish = async (ok: Promise<boolean>) => {
    if (await ok) onClose();
  };
  return (
    <div className="sheet" role="dialog" aria-label={t('找不到')}>
      <div className="sheet-body">
        <h3>{t('找不到：{0}', row.name)}</h3>
        <SopTip sopId="substitution" />
        <p className="muted">{t('缺 {0} 件。按顾客下单时的偏好处理，不等待顾客回复。', qty)}</p>
        <div className="chips" role="radiogroup" aria-label={t('货架上是什么情况？')}>
          {NOT_FOUND_REASONS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={reason === k} className={`chip${reason === k ? ' on' : ''}`} onClick={() => setReason(k)}>
              {t(label)}
            </button>
          ))}
        </div>
        <p className="note">{t('选一下货架上的情况：AI 据此判断是卖完了还是放错了地方，放错的会请同事在附近找一找。')}</p>
        {/* AI 已经排好的首选替代（决策记录 0026）：一下选定，不用再点开列表 */}
        {row.allowSubstitution && top && subs === null && (
          <button className="block primary" disabled={strict} onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'SUBSTITUTED', substitute: { name: top.name, gtin: top.gtin, rank: 1, model: 'flag' } }))}>
            {t('换成 AI 首选：{0}', top.name)}
            {top.p !== undefined && <small className="sub-why">{t('预计顾客接受 {0}%', Math.round(top.p * 100))}</small>}
          </button>
        )}
        {strict && row.allowSubstitution && <p className="note warn-text">{t('这个框还没扫：先关掉这个面板，扫一下框 {0}/{1} 的标签，再换替代品。', row.toteIndex, row.toteCount)}</p>}
        {row.allowSubstitution ? (
          subs === null ? (
            <button
              className="block"
              onClick={() =>
                void substitutes(auth, row.itemId).then((r) => {
                  setSubs(r.items);
                  setSubModel(r.model);
                })
              }
            >
              {t('查看替代商品')}
            </button>
          ) : subs.length ? (
            <ul className="subs">
              {subs.map((x, i) => (
                <li key={x.itemId}>
                  <button
                    className={`row-btn${subModel && i === 0 ? ' ai-top' : ''}`}
                    disabled={strict}
                    onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'SUBSTITUTED', substitute: { name: x.name, gtin: x.gtin, ...(subModel ? { rank: i + 1, model: subModel } : {}) } }))}
                  >
                    <span>
                      {subModel && i === 0 && <span className="tag ok">{t('AI 推荐')}</span>}
                      {x.name}
                      {x.locationId && <small className="sub-why">{t('货位 {0}', locationText(x.locationId))}</small>}
                      {x.p !== undefined && <small className="sub-why">{[t('预计顾客接受 {0}%', Math.round(x.p * 100)), ...(x.reasons ?? []).map(subReason)].join(' · ')}</small>}
                    </span>
                    <span className="mono">${x.unitPrice.toFixed(2)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">{t('附近没有合适的替代商品')}</p>
          )
        ) : (
          <p className="note">{t('顾客不允许替代这件商品')}</p>
        )}
        <button className="block" disabled={!backroom} onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'EXCEPTION' }))}>
          {backroom ? t('后仓有 {0} 箱：转后仓补取', backroom) : t('库存记录显示后仓没有')}
        </button>
        {/* 小屏幕上内容比面板高：标记缺货和取消固定在面板底部，不用滚动也能点到 */}
        <div className="sheet-foot">
          <button className="block warn" onClick={() => void finish(run({ type: 'ReportNotFound', ...base, resolution: 'SHORT' }))}>
            {t('标记缺货')}
          </button>
          <button className="link" onClick={onClose}>
            {t('取消')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 替代推荐的理由（AI 排序时） */
function subReason(r: { factor: string; value?: number }): string {
  switch (r.factor) {
    case 'SAME_STEM':
      return t('同一种商品');
    case 'SAME_BRAND':
      return t('同品牌');
    case 'SAME_FLAVOR':
      return t('口味相同');
    case 'FLAVOR_CHANGE':
      return t('口味不同');
    case 'SAME_SIZE':
      return t('规格相同');
    case 'SIZE_CHANGE':
      return t('规格不同');
    case 'ORGANIC_DOWNGRADE':
      return t('不是有机');
    case 'PRICE_UP':
      return t('贵 {0}%', r.value ?? 0);
    case 'PRICE_DOWN':
      return t('便宜 {0}%', Math.abs(r.value ?? 0));
    default:
      return r.factor;
  }
}
