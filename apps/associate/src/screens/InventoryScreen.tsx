import { useState } from 'react';
import { t } from '../i18n';
import { useLive } from '../live';
import { roleOf } from '@storewright/ops';
import { CountView, PutAwayView, ReceiveView } from './inventory/BackroomViews';
import { ExceptionView } from './inventory/ExceptionView';
import { ReplenishView } from './inventory/ReplenishView';

type Section = 'repl' | 'exception' | 'receive' | 'putaway' | 'count';

const DEFAULT: Record<string, Section> = { RESTOCK: 'repl', BACKROOM: 'receive', LEAD: 'exception' };

/** 库存：补货、后仓补取、收货、上架、盘点 */
export function InventoryScreen() {
  const { client, auth } = useLive();
  const s = client.state;
  const role = roleOf(client.statics, client.state, auth.actor) ?? '';
  const [section, setSection] = useState<Section>(DEFAULT[role] ?? 'repl');
  const badge = {
    repl: Object.values(s.repl).filter((x) => x.status === 'OPEN').length + Object.values(s.checks).filter((x) => x.status === 'OPEN').length,
    exception: Object.values(s.exceptions).filter((x) => x.status === 'OPEN').length,
    receive: Object.values(s.receipts).filter((x) => !x.closedAt).length,
    putaway: Object.values(s.cases).filter((c) => c.state === 'RECEIVED').length,
    count: Object.values(s.counts).filter((c) => c.status === 'OPEN').length,
  };
  const tabs: [Section, string][] = [
    ['repl', '补货'],
    ['exception', '补取'],
    ['receive', '收货'],
    ['putaway', '上架'],
    ['count', '盘点'],
  ];
  return (
    <div className="inventory">
      <div className="segmented wide" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
            {t(label)}
            {badge[k] > 0 && <em>{badge[k]}</em>}
          </button>
        ))}
      </div>
      {section === 'repl' && <ReplenishView />}
      {section === 'exception' && <ExceptionView />}
      {section === 'receive' && <ReceiveView />}
      {section === 'putaway' && <PutAwayView />}
      {section === 'count' && <CountView />}
    </div>
  );
}
