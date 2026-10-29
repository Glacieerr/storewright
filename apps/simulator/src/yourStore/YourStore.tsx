import { useEffect, useRef, useState } from 'react';
import { generateStoreConfig, templateParams, type GeneratorParams, type StoreConfig } from '@storewright/store-config';
import { useApp } from '../state/store';
import { deleteProject, exportProject, getProject, listProjects, newProjectId, parseProjectFile, saveProject, type StoreProject } from './projects';
import { t } from '../i18n';

/**
 * 「你的商店」（决策记录 0013、0027）：访客从一块空地开始搭建自己的门店，所有内容都可以编辑，
 * 然后跑全天仿真、在实时沙盒里运营、管理区域。门店数量不限，可以复制、导出和导入。
 */

interface Wizard {
  name: string;
  industry: 'GROCERY' | 'HARDWARE';
  width: number;
  depth: number;
  floors: 1 | 2;
  stagingScale: number;
  docks: number;
  pickupBays: number;
  open: number;
  close: number;
  auto: boolean;
  garden: boolean;
  pharmacy: boolean;
}

const DEFAULT_WIZARD: Wizard = { name: '', industry: 'GROCERY', width: 70, depth: 40, floors: 1, stagingScale: 1, docks: 3, pickupBays: 12, open: 7, close: 22, auto: false, garden: false, pharmacy: false };

function floorOf(c: StoreConfig): { w: number; d: number } {
  const f = c.layout.floors[0];
  return { w: f?.widthM ?? 0, d: f?.depthM ?? 0 };
}

/** 按想要的占地找生成参数：通道数决定宽度、货架段数决定深度，分别搜索最接近的值 */
export function fitParams(w: Wizard): GeneratorParams {
  const base = templateParams(w.industry === 'HARDWARE' ? 'hardware' : 'medium');
  const p: GeneratorParams = {
    ...base,
    name: w.name || (w.industry === 'HARDWARE' ? 'My home improvement store' : 'My store'),
    stagingScale: w.stagingScale,
    secondFloor: w.floors === 2 ? { gmAisles: 6, bays: 14, levels: 5, elevators: 1, escalators: 1 } : null,
    autoService: w.auto ? { side: 'LEFT', oilBays: 2, tireBays: 2 } : null,
    garden: w.garden ? { side: 'RIGHT' } : null,
    pharmacy: w.pharmacy ? { counters: 2 } : null,
    hours: { openMin: w.open * 60, closeMin: w.close * 60 },
    parking: { rows: 0, pickupBays: w.pickupBays },
    backroom: { ...(base.backroom ?? { extraDepthM: 0, rackRows: 0, rackLevels: 3, forklifts: 1, palletJacks: 2 }), docks: w.docks },
  };
  const total = base.ambientAisles + base.frozenAisles + base.gmAislesF1;
  let best = p;
  let bestErr = Infinity;
  for (let a = 4; a <= 30; a++) {
    const k = a / total;
    const q = { ...p, ambientAisles: Math.max(2, Math.round(base.ambientAisles * k)), frozenAisles: w.industry === 'HARDWARE' ? 0 : Math.max(0, Math.round(base.frozenAisles * k)), gmAislesF1: Math.max(0, Math.round(base.gmAislesF1 * k)) };
    const err = Math.abs(floorOf(generateStoreConfig(q)).w - w.width);
    if (err < bestErr) {
      bestErr = err;
      best = q;
    }
  }
  bestErr = Infinity;
  let out = best;
  for (let b = 6; b <= 26; b++) {
    const q = { ...best, bays: b };
    const err = Math.abs(floorOf(generateStoreConfig(q)).d - w.depth);
    if (err < bestErr) {
      bestErr = err;
      out = q;
    }
  }
  return out;
}

export function YourStorePage() {
  const [projects, setProjects] = useState<StoreProject[] | undefined>();
  const [wizard, setWizard] = useState<Wizard | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const file = useRef<HTMLInputElement>(null);
  const reload = () => void listProjects().then(setProjects);
  useEffect(reload, []);
  const app = useApp.getState;

  const create = async (w: Wizard) => {
    setBusy(true);
    // 让「正在生成」先显示出来
    await new Promise((r) => setTimeout(r, 30));
    const params = fitParams(w);
    const config = generateStoreConfig(params);
    if (w.industry === 'GROCERY') config.modules = { ...config.modules, mto: true, parcelHub: true, gm: true, returns: true };
    const now = Date.now();
    const p: StoreProject = { v: 1, id: newProjectId(), name: w.name || params.name, createdAt: now, updatedAt: now, config };
    await saveProject(p);
    setBusy(false);
    setWizard(undefined);
    app().openProject(p, true);
  };

  const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="your-store" role="dialog" aria-label={t('你的商店')}>
      <header className="ys-head">
        <div>
          <h2>{t('你的商店')}</h2>
          <p className="muted">{t('从一块空地开始搭建你自己门店的数字孪生：场地、建筑、货架、后仓、收货、暂存、停车，全部可以编辑；然后在规划孪生里跑全天仿真，或者在实时沙盒里运营、管理每个区域，看设备告警、回放和推演。门店保存在这台电脑的浏览器里。')}</p>
        </div>
        <div className="ys-row">
          <button onClick={() => app().setYourStore(false)}>{t('返回模拟器')}</button>
        </div>
      </header>

      <div className="ys-actions">
        <button className="primary" disabled={busy} onClick={() => setWizard({ ...DEFAULT_WIZARD })}>
          {t('新建门店')}
        </button>
        <button onClick={() => file.current?.click()}>{t('导入门店文件')}</button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            void f.text().then(async (text) => {
              const p = parseProjectFile(text);
              if (!p) return alert(t('这不是 Storewright 的门店文件'));
              await saveProject(p);
              reload();
            });
            e.target.value = '';
          }}
        />
      </div>

      {wizard && (
        <section className="ys-wizard" aria-label={t('新建门店')}>
          <h3>{t('新建门店')}</h3>
          <div className="ys-grid">
            <label>
              <span>{t('名称')}</span>
              <input id="ys-name" value={wizard.name} placeholder={t('例如：社区生鲜店')} onChange={(e) => setWizard({ ...wizard, name: e.target.value })} />
            </label>
            <label>
              <span>{t('行业')}</span>
              <select value={wizard.industry} onChange={(e) => setWizard({ ...wizard, industry: e.target.value as Wizard['industry'] })}>
                <option value="GROCERY">{t('超市')}</option>
                <option value="HARDWARE">{t('家居建材')}</option>
              </select>
            </label>
            <label>
              <span>{t('建筑宽度（米）')}</span>
              <input type="range" min={36} max={140} value={wizard.width} onChange={(e) => setWizard({ ...wizard, width: Number(e.target.value) })} />
              <b className="mono">{wizard.width} m</b>
            </label>
            <label>
              <span>{t('建筑进深（米）')}</span>
              <input type="range" min={26} max={80} value={wizard.depth} onChange={(e) => setWizard({ ...wizard, depth: Number(e.target.value) })} />
              <b className="mono">{wizard.depth} m</b>
            </label>
            <p className="ys-area">{t('一楼占地约 {0} 平方米', wizard.width * wizard.depth)}</p>
            <label>
              <span>{t('楼层')}</span>
              <select value={wizard.floors} onChange={(e) => setWizard({ ...wizard, floors: Number(e.target.value) as 1 | 2 })}>
                <option value={1}>{t('单层')}</option>
                <option value={2}>{t('两层（二楼百货）')}</option>
              </select>
            </label>
            <label>
              <span>{t('暂存区规模')}</span>
              <select value={wizard.stagingScale} onChange={(e) => setWizard({ ...wizard, stagingScale: Number(e.target.value) })}>
                {[0.5, 1, 1.5, 2, 3].map((v) => (
                  <option key={v} value={v}>
                    {t('{0} 倍', v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('卸货门')}</span>
              <input type="number" min={1} max={4} value={wizard.docks} onChange={(e) => setWizard({ ...wizard, docks: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })} />
            </label>
            <label>
              <span>{t('线上取货车位')}</span>
              <input type="number" min={2} max={30} value={wizard.pickupBays} onChange={(e) => setWizard({ ...wizard, pickupBays: Math.min(30, Math.max(2, Number(e.target.value) || 2)) })} />
            </label>
            <label>
              <span>{t('营业时间')}</span>
              <span className="ys-row">
                <input type="number" min={5} max={10} value={wizard.open} onChange={(e) => setWizard({ ...wizard, open: Math.min(10, Math.max(5, Number(e.target.value) || 7)) })} />
                <span>–</span>
                <input type="number" min={17} max={24} value={wizard.close} onChange={(e) => setWizard({ ...wizard, close: Math.min(24, Math.max(17, Number(e.target.value) || 22)) })} />
              </span>
            </label>
            <fieldset className="ys-row">
              <legend>{t('附属设施')}</legend>
              <label className="toggle">
                <input type="checkbox" checked={wizard.auto} onChange={(e) => setWizard({ ...wizard, auto: e.target.checked })} />
                {t('汽车快修')}
              </label>
              <label className="toggle">
                <input type="checkbox" checked={wizard.garden} onChange={(e) => setWizard({ ...wizard, garden: e.target.checked })} />
                {t('园艺中心')}
              </label>
              <label className="toggle">
                <input type="checkbox" checked={wizard.pharmacy} onChange={(e) => setWizard({ ...wizard, pharmacy: e.target.checked })} />
                {t('药房')}
              </label>
            </fieldset>
          </div>
          <p className="muted">{t('先按这些条件生成一家可以运行的门店，再在编辑器里逐项修改：货架的排布、后仓和收货的每个区域、卸货门、暂存货架、取货车位……全部可以改。')}</p>
          <div className="ys-row">
            <button className="primary" disabled={busy} onClick={() => void create(wizard)}>
              {busy ? t('正在生成…') : t('生成并开始搭建')}
            </button>
            <button onClick={() => setWizard(undefined)}>{t('取消')}</button>
          </div>
        </section>
      )}

      <section className="ys-list" aria-label={t('我的门店')}>
        {projects === undefined ? (
          <p className="muted">{t('正在读取…')}</p>
        ) : projects.length === 0 ? (
          <p className="ys-empty">{t('还没有门店。点「新建门店」，按占地、行业和设施生成第一家门店，然后开始搭建。')}</p>
        ) : (
          projects.map((p) => {
            const f = floorOf(p.config);
            const aisles = p.config.layout.runs.filter((r) => r.kind === 'AISLE').length;
            return (
              <article key={p.id} className="ys-card">
                <h3>{p.name}</h3>
                <p className="muted">
                  {p.config.industry === 'HARDWARE' ? t('家居建材') : t('超市')} · {f.w.toFixed(0)} × {f.d.toFixed(0)} m · {t('{0} 层', p.config.layout.floors.length)} · {t('{0} 条通道', aisles)}
                </p>
                <p className="muted">{t('最近修改 {0}', fmt(p.updatedAt))}</p>
                <div className="ys-row">
                  <button className="primary" onClick={() => app().openProject(p, true)}>
                    {t('搭建')}
                  </button>
                  <button onClick={() => app().openProject(p, false)}>{t('全天仿真')}</button>
                  <button onClick={() => window.open(`../app/showcase.html?project=${encodeURIComponent(p.id)}`, '_blank', 'noopener')}>{t('实时沙盒')}</button>
                  <button
                    onClick={() => {
                      const url = URL.createObjectURL(new Blob([exportProject(p)], { type: 'application/json' }));
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${p.name.replace(/[^\w一-鿿-]+/g, '_')}.storewright.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    {t('导出')}
                  </button>
                  <button
                    onClick={() => {
                      const now = Date.now();
                      void saveProject({ ...p, id: newProjectId(), name: t('{0} 副本', p.name), createdAt: now, updatedAt: now }).then(reload);
                    }}
                  >
                    {t('复制')}
                  </button>
                  {confirmDelete === p.id ? (
                    <>
                      <button className="danger" onClick={() => void deleteProject(p.id).then(() => (setConfirmDelete(undefined), reload()))}>
                        {t('确认删除')}
                      </button>
                      <button onClick={() => setConfirmDelete(undefined)}>{t('取消')}</button>
                    </>
                  ) : (
                    <button className="link danger" onClick={() => setConfirmDelete(p.id)}>
                      {t('删除')}
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}

/** 启动时按地址参数打开门店项目（?project=<编号>，&edit=1 进入搭建）或项目页（?yours） */
export async function loadProjectFromUrl(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const id = q.get('project');
  if (id) {
    const p = await getProject(id);
    if (p) useApp.getState().openProject(p, q.get('edit') === '1');
  } else if (q.has('yours')) useApp.getState().setYourStore(true);
}
