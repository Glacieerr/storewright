import { useState } from 'react';
import { t } from '../i18n';
import { useLive } from '../live';
import { rememberedSub, rememberSub, useIntent, type InventorySection } from '../nav';
import { areaUsage, currentRole } from '@storewright/ops';
import { AreaBoard } from './inventory/AreaView';
import { CountView, PutAwayView, ReceiveView } from './inventory/BackroomViews';
import { ExceptionView } from './inventory/ExceptionView';
import { ReplenishView } from './inventory/ReplenishView';

type Section = InventorySection;

const DEFAULT: Record<string, Section> = { RESTOCK: 'repl', BACKROOM: 'receive', LEAD: 'exception' };

/** 库存：补货、后仓补取、收货、上架、盘点、区域 */
export function InventoryScreen() {
  const { client, auth } = useLive();
  const s = client.state;
  const role = currentRole(client.statics, client.state, auth.actor, client.now()) ?? '';
  // 记住上次的子页（决策记录 0026）；提醒和「下一步」可以直接打开某个子页
  const [section, setSectionState] = useState<Section>(() => (rememberedSub('inventory') as Section | undefined) ?? DEFAULT[role] ?? 'repl');
  const setSection = (k: Section) => {
    rememberSub('inventory', k);
    setSectionState(k);
  };
  useIntent('inventory', setSection);
  const badge = {
    repl: Object.values(s.repl).filter((x) => x.status === 'OPEN').length + Object.values(s.checks).filter((x) => x.status === 'OPEN').length,
    exception: Object.values(s.exceptions).filter((x) => x.status === 'OPEN').length,
    receive: Object.values(s.receipts).filter((x) => !x.closedAt).length,
    putaway: Object.values(s.cases).filter((c) => c.state === 'RECEIVED').length,
    count: Object.values(s.counts).filter((c) => c.status === 'OPEN').length,
    area: client.statics?.areas ? areaUsage(s, client.statics).filter((u) => u.alert).length : 0,
  };
  const tabs: [Section, string][] = [
    ['repl', '补货'],
    ['exception', '补取'],
    ['receive', '收货'],
    ['putaway', '上架'],
    ['count', '盘点'],
    ['area', '区域'],
  ];
  return (
    <div className="inventory">
      <div className="segmented wide" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
            <span className="seg-label">{t(label)}</span>
            {badge[k] > 0 && <em>{badge[k]}</em>}
          </button>
        ))}
      </div>
      {section === 'repl' && <ReplenishView />}
      {section === 'exception' && <ExceptionView />}
      {section === 'receive' && <ReceiveView />}
      {section === 'putaway' && <PutAwayView />}
      {section === 'count' && <CountView />}
      {section === 'area' && <AreaBoard />}
    </div>
  );
}
