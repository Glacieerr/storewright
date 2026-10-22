import { useEffect, useRef, useState } from 'react';
import type { TempZone } from '@storewright/domain';
import { backroomLayout, stagingRacks, type StoreConfig } from '@storewright/store-config';
import { useApp } from '../state/store';
import { copySelected, deleteSelected, distributeSelected, duplicateSelected, editFloor, hasClipboard, paste, patchSelected, rotateSelected, selectAllOnFloor } from '../state/editOps';
import { ZONE_LABEL } from '../scene/palette';
import { ROAD_STYLE_LABEL, SITE_LAYOUT_LABEL, type RoadStyle, type SiteLayoutKind } from '../scene/site';
import { GeneratorPanel } from './GeneratorPanel';
import { getLang, t, translate } from '../i18n';

const ZONES: TempZone[] = ['AMBIENT', 'CHILLED', 'FROZEN'];

/** 由暂存货架数量反推规模倍数（常温订单货架数 = 8 × 规模） */
function stagingScaleOf(d: StoreConfig): number {
  const amb = d.staging.racks.filter((r) => r.zoneCode === 'AMB').length;
  return Math.max(0.5, Math.min(3, Math.round((amb / 8) * 2) / 2));
}

/** 编辑操作的提示，几秒后淡出 */
function EditNotice({ text }: { text: string }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setShown(false), 6000);
    return () => window.clearTimeout(id);
  }, []);
  return shown ? (
    <p className="edit-notice" role="status">
      {translate(text)}
    </p>
  ) : null;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function EditorPanel() {
  const draft = useApp((s) => s.draft);
  const issues = useApp((s) => s.draftIssues);
  const runId = useApp((s) => s.editRunId);
  const sel = useApp((s) => s.editSel);
  const tool = useApp((s) => s.editTool);
  const notice = useApp((s) => s.editNotice);
  useApp((s) => s.floor);
  const canUndo = useApp((s) => s.history.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const status = useApp((s) => s.status);
  const applied = useApp((s) => s.config === s.draft || s.config.configVersion === s.draft?.configVersion);
  const site = useApp((s) => s.site);
  const fileRef = useRef<HTMLInputElement>(null);
  const app = useApp.getState;
  if (!draft) return null;
  const run = sel.length > 1 ? undefined : draft.layout.runs.find((r) => r.id === runId);
  const fid = editFloor();
  const floorCfg = draft.layout.floors.find((f) => f.id === fid);

  const update = (fn: (d: StoreConfig) => void) => app().updateDraft(fn);
  const patchRun = (fn: (r: StoreConfig['layout']['runs'][number]) => void) =>
    update((d) => {
      const r = d.layout.runs.find((x) => x.id === runId);
      if (r) fn(r);
    });

  const importFile = async (f: File) => {
    try {
      app().loadDraft(JSON.parse(await f.text()));
    } catch {
      useApp.setState({ draftIssues: [{ path: '', message: t('文件不是有效的 JSON') }] });
    }
  };

  const orphanCats = draft.catalog.categories.filter((c) => c.fulfillmentType !== 'MTO' && !draft.layout.runs.some((r) => r.categoryIds.includes(c.id)));

  return (
    <section className="editor">
      <div className="editor-bar">
        <span className={`live-status ${issues.length ? 'bad' : !applied || status === 'running' ? 'busy' : 'ok'}`}>
          {t(issues.length ? '有问题，暂未应用' : !applied || status === 'running' ? '正在应用并重新仿真…' : '✓ 已实时应用到仿真')}
        </span>
        <div className="spacer" />
        <button onClick={() => app().undo()} disabled={!canUndo} title={t('撤销（⌘Z / Ctrl+Z）')}>
          {t('↶ 撤销')}
        </button>
        <button onClick={() => app().redo()} disabled={!canRedo} title={t('重做（⇧⌘Z / Ctrl+Y）')}>
          {t('↷ 重做')}
        </button>
      </div>
      <div className="edit-tools">
        <div className="chips" role="group" aria-label={t('编辑楼层')}>
          {draft.layout.floors.map((f) => (
            <button key={f.id} className={`chip ${fid === f.id ? 'active' : ''}`} onClick={() => app().setFloor(f.id)}>
              {f.name}
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label={t('编辑工具')}>
          <button className={`chip ${tool === 'select' ? 'active' : ''}`} onClick={() => app().setEditTool('select')} title={t('点选、Shift 多选、拖动移动')}>
            {t('⬚ 选择')}
          </button>
          <button className={`chip ${tool === 'draw' ? 'active' : ''}`} onClick={() => app().setEditTool(tool === 'draw' ? 'select' : 'draw')} title={t('在地面上拖出一条通道（N）')}>
            {t('＋ 画通道')}
          </button>
          <button className="chip" onClick={selectAllOnFloor} title="⌘A / Ctrl+A">
            {t('全选本层')}
          </button>
          <button className="chip" onClick={() => paste()} disabled={!hasClipboard()} title="⌘V / Ctrl+V">
            {t('粘贴')}
          </button>
        </div>
      </div>
      {notice && <EditNotice key={notice.seq} text={notice.text} />}
      <p className="hint">
        {tool === 'draw'
          ? t('在地面上按住拖出一条通道：两端会吸附到附近的走廊或通道上（绿点接上、红点没接上）；只点一下则在该处放一条竖向通道并延伸到前后走廊。Esc 退出画通道。')
          : t('点选货架通道，Shift / ⌘ 点选可多选；按住选中的通道拖动即可一起移动，松开后两端吸附到走廊上。方向键微调 0.1 米（Shift 1 米），T 旋转 90°，⌘C / ⌘V 复制粘贴，Delete 删除。每次通过校验的修改约 0.4 秒后自动应用，仿真不中断。')}
      </p>

      {sel.length > 1 && (
        <div className="form">
          <h3>{t('已选中 {0} 条通道', sel.length)}</h3>
          <label>
            <span>{t('温区')}</span>
            <select value="" onChange={(e) => e.target.value && patchSelected((r) => (r.tempZone = e.target.value as TempZone))}>
              <option value="">{t('（批量设置）')}</option>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {ZONE_LABEL[z]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('层数')}</span>
            <select value="" onChange={(e) => e.target.value && patchSelected((r) => (r.levels = Number(e.target.value)))}>
              <option value="">{t('（批量设置）')}</option>
              {[2, 3, 4, 5, 6, 7].map((v) => (
                <option key={v} value={v}>
                  {t('{0} 层', v)}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button onClick={rotateSelected}>{t('旋转 90°')}</button>
            <button onClick={distributeSelected} title={t('首尾两条不动，中间的等距排开')}>
              {t('等距排列')}
            </button>
            <button onClick={copySelected}>{t('复制')}</button>
            <button onClick={duplicateSelected}>{t('复制到旁边')}</button>
            <button className="danger" onClick={deleteSelected}>
              {t('删除')}
            </button>
          </div>
        </div>
      )}

      {run ? (
        <div className="form">
          <h3>{run.label ?? run.id}</h3>
          <label>
            <span>{t('名称')}</span>
            <input value={run.label ?? ''} onChange={(e) => patchRun((r) => (r.label = e.target.value))} />
          </label>
          <label>
            <span>{t('温区')}</span>
            <select value={run.tempZone} onChange={(e) => patchRun((r) => (r.tempZone = e.target.value as TempZone))}>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {ZONE_LABEL[z]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('货架段数')}</span>
            <input type="number" min={1} max={40} value={run.bays} onChange={(e) => patchRun((r) => (r.bays = Math.max(1, Number(e.target.value) || 1)))} />
          </label>
          <label>
            <span>{t('层数')}</span>
            <input type="number" min={1} max={8} value={run.levels} onChange={(e) => patchRun((r) => (r.levels = Math.max(1, Number(e.target.value) || 1)))} />
          </label>
          <fieldset>
            <legend>{t('商品类别')}</legend>
            <div className="cats">
              {draft.catalog.categories
                .filter((c) => c.fulfillmentType !== 'MTO')
                .map((c) => (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={run.categoryIds.includes(c.id)}
                      onChange={(e) =>
                        patchRun((r) => {
                          r.categoryIds = e.target.checked ? [...r.categoryIds, c.id] : r.categoryIds.filter((x) => x !== c.id);
                        })
                      }
                    />
                    {getLang() === 'en' ? c.name : c.nameZh}
                  </label>
                ))}
            </div>
          </fieldset>
          <div className="row">
            <button onClick={rotateSelected} title="T">
              {t('旋转 90°')}
            </button>
            <button onClick={duplicateSelected} title="⌘D / Ctrl+D">
              {t('复制到旁边')}
            </button>
            <button onClick={copySelected} title="⌘C / Ctrl+C">
              {t('复制')}
            </button>
            <button className="danger" onClick={deleteSelected} title="Delete">
              {t('删除')}
            </button>
          </div>
        </div>
      ) : sel.length > 1 ? null : (
        <p className="muted">{t('还没有选中货架通道。')}</p>
      )}

      {floorCfg && (
        <div className="form">
          <h3>{t('{0} 楼层', floorCfg.name)}</h3>
          <label>
            <span>{t('宽 × 深（米）')}</span>
            <span className="inline">
              <input type="number" min={20} max={300} value={Math.round(floorCfg.widthM * 10) / 10} onChange={(e) => update((d) => d.layout.floors.forEach((f) => f.id === fid && (f.widthM = Math.min(300, Math.max(20, Number(e.target.value) || f.widthM)))))} />
              <input type="number" min={20} max={300} value={Math.round(floorCfg.depthM * 10) / 10} onChange={(e) => update((d) => d.layout.floors.forEach((f) => f.id === fid && (f.depthM = Math.min(300, Math.max(20, Number(e.target.value) || f.depthM)))))} />
            </span>
          </label>
          <p className="hint">
            {t('本层 {0} 条货架通道。画通道、粘贴都放在当前楼层；在 1F 复制后切到 2F 再粘贴即可跨楼层复制。', draft.layout.runs.filter((r) => r.floorId === fid).length)}
          </p>
        </div>
      )}

      <GeneratorPanel />

      <div className="form">
        <h3>{t('暂存格位编码')}</h3>
        <label>
          <span>{t('编码规则')}</span>
          <input value={draft.staging.codePattern} onChange={(e) => update((d) => (d.staging.codePattern = e.target.value))} />
        </label>
        <label>
          <span>{t('数字位数')}</span>
          <input type="number" min={1} max={4} value={draft.staging.pad} onChange={(e) => update((d) => (d.staging.pad = Math.min(4, Math.max(1, Number(e.target.value) || 2))))} />
        </label>
        <p className="hint">{t('可用占位符：')}{'{zone}'} {'{rack}'} {'{level}'} {'{slot}'}{t('，例如 AMB-03-02-16。')}</p>
      </div>

      <div className="form">
        <h3>{t('附属设施')}</h3>
        {draft.facilities.length === 0 && <p className="muted">{t('还没有附属设施。')}</p>}
        <ul className="facility-list">
          {draft.facilities.map((f) => (
            <li key={f.id}>
              <strong>{t(f.kind === 'AUTO_SERVICE' ? '汽车服务中心' : f.kind === 'GARDEN_CENTER' ? '园艺中心' : '药房')}</strong>
              {f.kind !== 'PHARMACY' && (
                <select
                  value={f.side}
                  onChange={(e) =>
                    update((d) => {
                      const side = e.target.value as 'LEFT' | 'RIGHT';
                      const me = d.facilities.find((q) => q.id === f.id);
                      const other = d.facilities.find((q) => q.id !== f.id && q.kind !== 'PHARMACY' && q.side === side);
                      if (other && other.kind !== 'PHARMACY' && me && me.kind !== 'PHARMACY') other.side = me.side;
                      if (me && me.kind !== 'PHARMACY') me.side = side;
                    })
                  }
                >
                  <option value="LEFT">{t('左侧')}</option>
                  <option value="RIGHT">{t('右侧')}</option>
                </select>
              )}
              {f.kind === 'AUTO_SERVICE' && (
                <span className="muted">
                  {t('机油 {0} · 轮胎 {1}', f.oilBays, f.tireBays)}
                </span>
              )}
              {f.kind === 'PHARMACY' && (
                <span className="staff-adjust">
                  <button aria-label={t('减少柜台')} onClick={() => update((d) => d.facilities.forEach((q) => q.id === f.id && q.kind === 'PHARMACY' && (q.counters = Math.max(1, q.counters - 1))))}>
                    −
                  </button>
                  <span className="mono">{f.counters}</span>
                  <button aria-label={t('增加柜台')} onClick={() => update((d) => d.facilities.forEach((q) => q.id === f.id && q.kind === 'PHARMACY' && (q.counters = Math.min(4, q.counters + 1))))}>
                    ＋
                  </button>
                  <span className="muted"> {t('柜台')}</span>
                </span>
              )}
              <button className="link" onClick={() => update((d) => (d.facilities = d.facilities.filter((q) => q.id !== f.id)))}>
                {t('移除')}
              </button>
            </li>
          ))}
        </ul>
        <div className="chips">
          {(() => {
            const used = new Set(draft.facilities.flatMap((q) => (q.kind === 'PHARMACY' ? [] : [q.side])));
            const freeSide = !used.has('LEFT') ? 'LEFT' : !used.has('RIGHT') ? 'RIGHT' : undefined;
            const has = (k: string) => draft.facilities.some((q) => q.kind === k);
            return (
              <>
                {!has('AUTO_SERVICE') && freeSide && (
                  <button className="chip" onClick={() => update((d) => d.facilities.push({ id: 'AUTO-1', kind: 'AUTO_SERVICE', name: 'Auto service center', side: freeSide, oilBays: 2, tireBays: 2, carsPerDay: 0, hours: { openMin: 480, closeMin: 1140 } }))}>
                    {t('＋ 汽车服务中心')}
                  </button>
                )}
                {!has('GARDEN_CENTER') && freeSide && (
                  <button className="chip" onClick={() => update((d) => d.facilities.push({ id: 'GARDEN-1', kind: 'GARDEN_CENTER', name: 'Garden center', side: freeSide, widthM: 18, depthM: 22 }))}>
                    {t('＋ 园艺中心')}
                  </button>
                )}
                {!has('PHARMACY') && (
                  <button className="chip" onClick={() => update((d) => d.facilities.push({ id: 'PHARM-1', kind: 'PHARMACY', name: 'Pharmacy', counters: 2, patientsPerDay: 0, hours: { openMin: d.hours.openMin + 60, closeMin: Math.min(21 * 60, d.hours.closeMin) } }))}>
                    {t('＋ 药房')}
                  </button>
                )}
              </>
            );
          })()}
        </div>
        <p className="hint">{t('在场景中拖动彩色把手：顾客入口、交付门口、电梯和扶梯可以沿前走廊左右移动；设施拖到门店另一侧即换边。')}</p>
      </div>

      <div className="form">
        <h3>{t('后仓与暂存仓')}</h3>
        <label>
          <span>{t('后仓加深')}</span>
          <input
            type="number"
            min={0}
            max={40}
            value={draft.backroom.extraDepthM}
            onChange={(e) =>
              update((d) => {
                const v = Math.min(40, Math.max(0, Number(e.target.value) || 0));
                const f1 = d.layout.floors.find((f) => f.level === 0);
                if (f1) f1.depthM += v - d.backroom.extraDepthM;
                d.backroom.extraDepthM = v;
              })
            }
          />
        </label>
        <label>
          <span>{t('货架排数')}</span>
          <input type="number" min={0} max={10} value={draft.backroom.rackRows} onChange={(e) => update((d) => (d.backroom.rackRows = Math.min(10, Math.max(0, Number(e.target.value) || 0))))} />
        </label>
        <label>
          <span>{t('货架层数')}</span>
          <input type="number" min={2} max={5} value={draft.backroom.rackLevels} onChange={(e) => update((d) => (d.backroom.rackLevels = Math.min(5, Math.max(2, Number(e.target.value) || 3))))} />
        </label>
        <label>
          <span>{t('卸货门')}</span>
          <input type="number" min={1} max={4} value={draft.backroom.docks} onChange={(e) => update((d) => (d.backroom.docks = Math.min(4, Math.max(1, Number(e.target.value) || 1))))} />
        </label>
        <label>
          <span>{t('叉车 / 搬运车')}</span>
          <span className="inline">
            <input type="number" min={0} max={4} value={draft.backroom.forklifts} onChange={(e) => update((d) => (d.backroom.forklifts = Math.min(4, Math.max(0, Number(e.target.value) || 0))))} />
            <input type="number" min={0} max={6} value={draft.backroom.palletJacks} onChange={(e) => update((d) => (d.backroom.palletJacks = Math.min(6, Math.max(0, Number(e.target.value) || 0))))} />
          </span>
        </label>
        <label>
          <span>{t('暂存仓规模')}</span>
          <select
            value={stagingScaleOf(draft)}
            onChange={(e) =>
              update((d) => {
                d.staging.racks = stagingRacks(Number(e.target.value));
              })
            }
          >
            {[0.5, 1, 1.5, 2, 2.5, 3].map((v) => (
              <option key={v} value={v}>
                {t('{0} 倍', v)}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          {t('库存仓库：{0} 个托盘位（{1} 排 × {2} 层）。货架排数 0 表示按后仓深度放满。没有叉车时货只能用搬运车卸下、堆在收货区，进不了高层货架。线上订单暂存仓的规模决定暂存格位数。', backroomLayout(draft).capacity, backroomLayout(draft).rows.length, draft.backroom.rackLevels)}
        </p>
      </div>

      <div className="form">
        <h3>{t('营业时间与停车场')}</h3>
        <label>
          <span>{t('营业时间')}</span>
          <span className="inline">
            <select value={draft.hours.openMin / 60} onChange={(e) => app().setHours(Number(e.target.value) * 60, draft.hours.closeMin)}>
              {[5, 6, 7, 8, 9, 10].map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
            <span className="muted">{t('至')}</span>
            <select value={draft.hours.closeMin / 60} onChange={(e) => app().setHours(draft.hours.openMin, Number(e.target.value) * 60)}>
              {[17, 18, 19, 20, 21, 22, 23, 24].map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </span>
        </label>
        <label>
          <span>{t('停车排数')}</span>
          <input type="number" min={0} max={5} value={draft.outdoor.parkingRows} onChange={(e) => update((d) => (d.outdoor.parkingRows = Math.min(5, Math.max(0, Number(e.target.value) || 0))))} />
        </label>
        <label>
          <span>{t('取货车位')}</span>
          <input type="number" min={0} max={30} value={draft.outdoor.pickupBays} onChange={(e) => update((d) => (d.outdoor.pickupBays = Math.min(30, Math.max(0, Number(e.target.value) || 0))))} />
        </label>
        <p className="hint">{t('营业时间决定线上订单的取货时段、员工排班和到店客流；0 表示停车场按门店宽度自动确定。')}</p>
      </div>

      <div className="form">
        <h3>{t('周边环境')}</h3>
        <label>
          <span>{t('道路风格')}</span>
          <select value={site.style} onChange={(e) => app().setSite({ style: e.target.value as RoadStyle })}>
            {(Object.keys(ROAD_STYLE_LABEL) as RoadStyle[]).map((k) => (
              <option key={k} value={k}>
                {ROAD_STYLE_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('地块')}</span>
          <select value={site.layout ?? 'auto'} onChange={(e) => app().setSite({ layout: e.target.value as SiteLayoutKind })}>
            {(Object.keys(SITE_LAYOUT_LABEL) as SiteLayoutKind[]).map((k) => (
              <option key={k} value={k}>
                {SITE_LAYOUT_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!site.roadWorks} onChange={(e) => app().setSite({ roadWorks: e.target.checked })} />
          {t('主路有一段施工（限速、锥桶）')}
        </label>
        <label>
          <span>{t('随机种子')}</span>
          <span className="inline">
            <input type="number" min={1} max={99999} value={site.seed} onChange={(e) => app().setSite({ seed: Math.max(1, Number(e.target.value) || 1) })} />
            <button onClick={() => app().setSite({ seed: 1 + Math.floor(Math.random() * 99999) })} title={t('随机生成新的周边道路和建筑')}>
              {t('🎲 随机')}
            </button>
          </span>
        </label>
        <label>
          <span>{t('道路拥堵')}</span>
          <select value={site.traffic} onChange={(e) => app().setSite({ traffic: Number(e.target.value) })}>
            <option value={0}>{t('关闭（与 Phase 1 实验一致）')}</option>
            <option value={1}>{t('一般城市')}</option>
            <option value={2}>{t('严重拥堵')}</option>
          </select>
        </label>
        <div className="row">
          <button
            onClick={() => {
              const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)] as T;
              app().setSite({
                style: pick(Object.keys(ROAD_STYLE_LABEL) as RoadStyle[]),
                seed: 1 + Math.floor(Math.random() * 99999),
                layout: pick(['standard', 'corner', 'strip'] as SiteLayoutKind[]),
                roadWorks: Math.random() < 0.35,
                traffic: pick([0, 1, 1, 2]),
              });
            }}
          >
            {t('🎲 周边全部随机')}
          </button>
        </div>
        <p className="hint">{t('道路风格、地块、施工和种子只改变画面（施工会让背景车流在那一段慢下来）；拥堵强度会推迟顾客和司机的到店时间，并重新仿真。')}</p>
      </div>

      <div className={`validation ${issues.length ? 'bad' : 'ok'}`}>
        {issues.length ? (
          <>
            <strong>{t('有 {0} 个问题，修正后自动应用：', issues.length)}</strong>
            <ul>
              {issues.slice(0, 6).map((i, k) => (
                <li key={k}>{translate(i.message)}</li>
              ))}
            </ul>
          </>
        ) : (
          <strong>{t('✓ 配置校验通过')}</strong>
        )}
        {orphanCats.length > 0 && <p className="hint">{t('提示：{0} 目前没有放在任何货架上，仿真中不会出现这些商品。', orphanCats.map((c) => (getLang() === 'en' ? c.name : c.nameZh)).join(t('、')))}</p>}
      </div>

      <div className="row">
        <button onClick={() => download(`storewright-layout-v${draft.configVersion}.json`, JSON.stringify(draft, null, 2))}>{t('导出 JSON')}</button>
        <button onClick={() => fileRef.current?.click()}>{t('导入 JSON')}</button>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
      </div>
      <div className="row">
        <button className="primary" onClick={() => app().exitEdit(true)} title={issues.length ? t('草稿有问题：将保留最后一次通过校验的布局') : undefined}>
          {t('完成编辑')}
        </button>
        <button onClick={() => app().exitEdit(false)}>{t('撤销全部修改')}</button>
      </div>
    </section>
  );
}
