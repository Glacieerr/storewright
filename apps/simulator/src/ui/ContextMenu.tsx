import { useEffect } from 'react';
import { ROLES, type Role } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { framePositions } from '../scene/framePositions';
import { ROLE_LABEL } from '../scene/palette';
import type { MenuTarget } from '../scene/contextTarget';
import { t as tr } from '../i18n';

interface Item {
  label: string;
  run: () => void;
  danger?: boolean;
}

function itemsFor(t: MenuTarget): { title: string; items: Item[] } {
  const app = useApp.getState();
  const locate = (id: string) => {
    const p = framePositions.get(id);
    if (p) app.focusOn(p.x, p.y, p.z);
  };
  switch (t.type) {
    case 'associate': {
      const role = app.timeline?.associates.find((a) => a.id === t.id)?.role;
      return {
        title: `${role ? tr('{0}员', ROLE_LABEL[role]) : ''} ${t.id}`,
        items: [
          { label: '查看详情', run: () => app.select(t) },
          { label: '镜头跟随', run: () => (app.select(t), app.setFollow(t.id)) },
          { label: '定位', run: () => locate(t.id) },
          ...ROLES.filter((r) => r !== role).map<Item>((r: Role) => ({ label: tr('改派到{0}（从当前小时起）', ROLE_LABEL[r]), run: () => role && app.reassign(role, r) })),
        ],
      };
    }
    case 'car':
      return {
        title: app.timeline?.cars.find((c) => c.id === t.id)?.label ?? tr('车辆'),
        items: [
          { label: '查看订单', run: () => app.select(t) },
          { label: '镜头跟随', run: () => (app.select(t), app.setFollow(t.id)) },
          { label: '定位', run: () => locate(t.id) },
        ],
      };
    case 'run':
      return {
        title: app.config.layout.runs.find((r) => r.id === t.id)?.label ?? t.id,
        items: [
          { label: '查看详情', run: () => app.select(t) },
          {
            label: '编辑这条通道',
            run: () => {
              app.setTab('edit');
              app.setEditRun(t.id);
            },
          },
        ],
      };
    case 'staging':
      return { title: '暂存区', items: [{ label: '查看占用', run: () => app.select(t) }] };
    case 'facility':
      return {
        title: '汽车服务中心',
        items: [
          { label: '查看详情', run: () => app.select(t) },
          { label: '在门店定制中调整', run: () => app.setTab('edit') },
        ],
      };
    case 'ground':
      return {
        title: '地面',
        items: [
          { label: '镜头移到这里', run: () => (app.setFollow(undefined), app.focusOn(t.x, 0, t.z)) },
          { label: '取消选中', run: () => app.select(undefined) },
        ],
      };
  }
}

/** 场景右键菜单：针对点中的对象给出常用操作（改派、跟随、编辑通道……） */
export function ContextMenu() {
  const menu = useApp((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = () => useApp.getState().setMenu(undefined);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  if (!menu) return null;
  const { title, items } = itemsFor(menu.target);
  return (
    <div className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="context-title">{tr(title)}</div>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? 'danger' : ''}
          onClick={() => {
            it.run();
            useApp.getState().setMenu(undefined);
          }}
        >
          {tr(it.label)}
        </button>
      ))}
    </div>
  );
}
