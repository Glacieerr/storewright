import { useState } from 'react';
import { nextTasksFor, replBatches, sessionKeyFor, type NextTask, type StoreStatic } from '@storewright/ops';
import { clock, t } from '../i18n';
import { useLive, useNow } from '../live';
import { navigate } from '../nav';

/**
 * 「下一步」（决策记录 0024 · D3）：手上没活时，按紧急、价值、用时、岗位技能、就近排出下一件事；
 * 「去做」带你到对应的页面，「换一个」看下一条。只推荐，可以选别的；照着做和换一个都记为反馈。
 * 直达那一条（决策记录 0026）：拣货批次、补货批次、盘点、后仓补取直接领取并打开；核对货架、交付直接打开那一个。
 */

const KIND_TEXT: Record<string, string> = { WALK: '拣货批次', STAGE: '暂存', HANDOFF: '交付', RESTOCK: '补货', EXCEPTION: '后仓补取', CHECK: '核对货架', COUNT: '盘点' };
const ZONE: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻' };
const WHY: Record<string, string> = { CUSTOMER_WAITING: '顾客在等', DUE_SOON: '快到截止', YOUR_ROLE: '你的岗位', NEARBY: '就在附近', FREEZER_REST: '冷冻区待久了，排后', STOCKOUT_RISK: '快断货了' };

export type NextTarget = 'pick' | 'stage' | 'handoff' | 'inventory';

function describe(x: NextTask): string {
  const l = x.label;
  switch (x.kind) {
    case 'WALK':
      return t('{0}，{1} 行，预计 {2} 分钟', t(ZONE[String(l.zone)] ?? String(l.zone)), Number(l.lines ?? 0), x.minutes);
    case 'STAGE':
      return t('订单 {0} 的{1}框', String(l.order ?? ''), t(ZONE[String(l.zone)] ?? ''));
    case 'HANDOFF':
      return t('订单 {0}，顾客已经等了 {1} 分钟', String(l.order ?? ''), Number(l.waiting ?? 0));
    case 'RESTOCK':
    case 'CHECK':
      return String(l.item ?? '');
    case 'COUNT':
      return t('库位 {0}', String(l.bin ?? ''));
    default:
      return String(l.item ?? x.ref);
  }
}

/** 任务在哪个页面做 */
function targetOf(x: NextTask): NextTarget {
  return x.kind === 'WALK' ? 'pick' : x.kind === 'STAGE' ? 'stage' : x.kind === 'HANDOFF' ? 'handoff' : 'inventory';
}

/**
 * 只在别的页面上提醒：最该做的事就在当前页面（例如在暂存页、待暂存的框就在下面）时不显示，免得把要做的事挤到屏幕外；
 * 「换一个」只在其他页面的任务里换；「收起」后直到最该做的事变了才再出现。
 */
export function NextTaskCard({ current, onGo }: { current: string; onGo: (to: NextTarget) => void }) {
  const { client, auth, run } = useLive();
  const now = useNow(20_000);
  const [skip, setSkip] = useState(0);
  const [hidden, setHidden] = useState<string | undefined>();
  if (auth.role === 'console' || !client.statics) return null;
  const all = nextTasksFor(client.state, client.statics, auth.actor, now, 4);
  const top = all[0];
  if (!top || targetOf(top) === current || hidden === top.ref) return null;
  const list = all.filter((x) => targetOf(x) !== current);
  const x = list[skip % list.length] as NextTask;
  const claims = x.kind === 'WALK' || x.kind === 'RESTOCK' || x.kind === 'COUNT' || x.kind === 'EXCEPTION';
  const go = async () => {
    void run({ type: 'NextTaskFeedback', kind: x.kind, ref: x.ref, taken: true }, { quiet: true });
    const s = client.state;
    switch (x.kind) {
      case 'WALK':
        if (await run({ type: 'ClaimWalk', walkId: x.ref })) onGo('pick');
        return;
      case 'RESTOCK': {
        // 领取这个任务所在的一批（同一通道、一辆推车装得下）
        const batch = replBatches(s, client.statics as StoreStatic).find((b) => b.some((r) => r.id === x.ref)) ?? [];
        if (await run({ type: 'ClaimReplenishment', taskIds: batch.length ? batch.map((r) => r.id) : [x.ref] })) {
          navigate({ inventory: 'repl' });
          onGo('inventory');
        }
        return;
      }
      case 'CHECK':
        navigate({ inventory: 'repl', checkId: x.ref });
        onGo('inventory');
        return;
      case 'COUNT':
        if (await run({ type: 'ClaimCount', countId: x.ref })) {
          navigate({ inventory: 'count' });
          onGo('inventory');
        }
        return;
      case 'EXCEPTION':
        if (await run({ type: 'ClaimException', exceptionId: x.ref })) {
          navigate({ inventory: 'exception' });
          onGo('inventory');
        }
        return;
      case 'HANDOFF':
        navigate({ sessionKey: sessionKeyFor(s, x.ref) });
        onGo('handoff');
        return;
      default:
        onGo(targetOf(x));
    }
  };
  return (
    <aside className="card next-task" aria-label={t('下一步')}>
      <p className="next-task-what">
        <span className="tag ok">{t('下一步')}</span> <b>{t(KIND_TEXT[x.kind] ?? x.kind)}</b> {describe(x)}
        {x.dueAt !== undefined && x.kind !== 'HANDOFF' && <small className="muted"> · {t('{0} 前', clock(x.dueAt))}</small>}
        {x.crossRole && <small className="muted"> · {t('跨岗位')}</small>}
      </p>
      {x.why.length > 0 && <p className="note">{x.why.map((w) => t(WHY[w] ?? w)).join(' · ')}</p>}
      <div className="next-task-actions">
        <button className="primary" onClick={() => void go()}>
          {claims ? t('领取并开始') : t('去做')}
        </button>
        {list.length > 1 && (
          <button
            onClick={() => {
              void run({ type: 'NextTaskFeedback', kind: x.kind, ref: x.ref, taken: false }, { quiet: true });
              setSkip(skip + 1);
            }}
          >
            {t('换一个')}
          </button>
        )}
        <button className="link" onClick={() => setHidden(top.ref)}>
          {t('收起')}
        </button>
      </div>
    </aside>
  );
}
