import { useEffect, useRef, useState } from 'react';
import { goLiveCheck, validateStoreConfig, type GoLiveItem } from '@storewright/store-config';
import { useApp } from '../state/store';
import { getProject, saveProject } from './projects';
import { AREA_NAME } from '../ui/areaNames';
import { t, translate } from '../i18n';

/**
 * 打开「你的商店」的门店时，顶栏下方的项目栏（决策记录 0013）：项目名、自动保存、
 * 搭建步骤（点一下打开编辑器的对应部分）、开业检查、全天仿真、实时沙盒。
 */

const STEPS: Array<[string, string]> = [
  ['卖场货架', ''],
  ['后仓与收货区域', '区域与卸货门'],
  ['暂存', '后仓与暂存仓'],
  ['设施', '附属设施'],
  ['停车与营业时间', '营业时间与停车场'],
  ['场地环境', '周边环境'],
];

function checkText(i: GoLiveItem): string {
  const p = i.params;
  const area = (k: unknown) => t(AREA_NAME[String(k)] ?? String(k));
  switch (i.code) {
    case 'CONFIG_ISSUE':
      return translate(String(p.message));
    case 'AREA_MISSING':
      return i.level === 'error' ? t('缺少「{0}」区域', area(p.kind)) : t('建议加一个「{0}」区域', area(p.kind));
    case 'COLD_STORAGE':
      return p.kind === 'COOLER' ? t('卖场有冷藏商品，但后仓没有冷藏库') : t('卖场有冷冻商品，但后仓没有冷冻库');
    case 'STAGING_CAPACITY':
      return t('暂存区约能放 {0} 个框，高峰时预计需要 {1} 个', p.have ?? 0, p.need ?? 0);
    case 'PICKUP_BAYS':
      return t('线上取货车位 {0} 个，高峰时预计需要 {1} 个', p.have ?? 0, p.need ?? 0);
    case 'DOCKS':
      return t('卸货门 {0} 个', p.have ?? 0);
    case 'REEFER_DOOR':
      return t('没有冷藏卸货门：冷藏车只能停普通门，建议把一个卸货门设为冷藏门');
    case 'RACK_CAPACITY':
      return t('后仓托盘位 {0} 个', p.have ?? 0);
    case 'HOURS':
      return t('营业时间只有 {0} 小时', p.hours ?? 0);
  }
}

function GoLiveDialog({ onClose }: { onClose: () => void }) {
  const draft = useApp((s) => s.draft);
  const config = useApp((s) => s.config);
  const sizing = useApp((s) => s.sizing);
  const cfg = draft ?? config;
  const v = validateStoreConfig(cfg);
  const items = goLiveCheck(cfg, sizing?.ordersPerDay ?? 246, v.ok ? [] : v.issues);
  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  return (
    <div className="ys-modal" role="dialog" aria-modal aria-label={t('开业检查')}>
      <div className="ys-modal-card golive">
        <h3>{t('开业检查')}</h3>
        <p className={errors ? 'ys-error' : 'muted'}>
          {errors ? t('有 {0} 个问题要先解决，另有 {1} 条建议。', errors, warns) : warns ? t('可以开业，另有 {0} 条建议。', warns) : t('可以开业。')}
        </p>
        <ul className="golive-list">
          {items.map((i, k) => (
            <li key={k} className={i.level}>
              <span aria-hidden>{i.level === 'ok' ? '✓' : i.level === 'warn' ? '!' : '✕'}</span>
              {checkText(i)}
            </li>
          ))}
        </ul>
        <p className="muted">{t('按日订单量 {0} 张估算高峰（约占全天 11%）。', sizing?.ordersPerDay ?? 246)}</p>
        <button className="primary" onClick={onClose}>
          {t('知道了')}
        </button>
      </div>
    </div>
  );
}

export function ProjectBar() {
  const project = useApp((s) => s.project);
  const config = useApp((s) => s.config);
  const mode = useApp((s) => s.mode);
  const [saved, setSaved] = useState<number | undefined>();
  const [check, setCheck] = useState(false);
  // 手机上项目栏收成一行（门店名称 + 这个开关），点开才显示搭建步骤和操作（样式里的 .pb-more）
  const [more, setMore] = useState(false);
  const [name, setName] = useState(project?.name ?? '');
  const first = useRef(true);
  useEffect(() => setName(project?.name ?? ''), [project?.id, project?.name]);

  // 自动保存：门店配置变了（编辑器应用了修改）就写回项目
  useEffect(() => {
    if (!project) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const id = window.setTimeout(() => {
      void getProject(project.id).then(async (p) => {
        if (!p) return;
        await saveProject({ ...p, config, updatedAt: Date.now() });
        setSaved(Date.now());
      });
    }, 800);
    return () => window.clearTimeout(id);
  }, [config, project]);

  if (!project) return null;
  const app = useApp.getState;
  const open = (section: string) => {
    if (app().mode !== 'edit') app().enterEdit();
    app().setTab('edit');
    // 等编辑器渲染出来再滚到对应的部分
    window.setTimeout(() => {
      const label = section ? t(section) : '';
      const h = label ? [...document.querySelectorAll('.editor h3')].find((x) => x.textContent?.startsWith(label)) : document.querySelector('.editor');
      h?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 120);
  };
  const rename = (n: string) => {
    const v = n.trim();
    if (!v || v === project.name) return;
    useApp.setState({ project: { ...project, name: v } });
    void getProject(project.id).then((p) => p && saveProject({ ...p, name: v, updatedAt: Date.now() }));
  };

  return (
    <div className={more ? 'project-bar open' : 'project-bar'} role="region" aria-label={t('你的商店')}>
      <span className="pb-tag">{t('你的商店')}</span>
      <input className="pb-name" value={name} aria-label={t('门店名称')} onChange={(e) => setName(e.target.value)} onBlur={() => rename(name)} onKeyDown={(e) => e.key === 'Enter' && rename(name)} />
      <button className="pb-toggle" aria-expanded={more} onClick={() => setMore(!more)}>
        {t('搭建步骤')} <span aria-hidden>{more ? '▴' : '▾'}</span>
      </button>
      <span className="muted pb-saved pb-more">{saved ? t('已自动保存 {0}', new Date(saved).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) : t('修改会自动保存')}</span>
      <nav className="pb-steps pb-more" aria-label={t('搭建步骤')}>
        {STEPS.map(([label, section], i) => (
          <button key={label} onClick={() => open(section)}>
            <i>{i + 1}</i>
            {t(label)}
          </button>
        ))}
        <button className="pb-check" onClick={() => setCheck(true)}>
          <i>✓</i>
          {t('开业检查')}
        </button>
      </nav>
      <span className="pb-actions pb-more">
        {mode === 'edit' ? (
          <button className="primary" onClick={() => app().exitEdit(true)}>
            {t('完成搭建，跑全天仿真')}
          </button>
        ) : (
          <button onClick={() => open('')}>{t('继续搭建')}</button>
        )}
        <button onClick={() => window.open(`../app/showcase.html?project=${encodeURIComponent(project.id)}`, '_blank', 'noopener')}>{t('实时沙盒')}</button>
        <button className="link" onClick={() => app().closeProject()}>
          {t('我的门店')}
        </button>
      </span>
      {check && <GoLiveDialog onClose={() => setCheck(false)} />}
    </div>
  );
}
