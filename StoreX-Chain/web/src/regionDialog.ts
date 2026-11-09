import { COAST_LABEL, DIR8, DIR_LABEL, FORM_LABEL, PORT_LABEL, resolveOptions, RIVER_FORM_LABEL, SIZE_LABEL, STORE_LABEL, type CityForm, type CoastType, type RegionOptions, type RegionSpec, type RiverForm } from '../../src/region/regionGen';
import { t as tr, tx } from './i18n';

/**
 * 自定义区域：城市形态、海岸的样子、海在哪一侧、河（有没有、有没有支流）、城市多大、港口在海岸的哪一段、机场和物流园在城市的哪个方向多远、
 * 常年风向（跑道顺着它）、铁路从哪个方向出区域、两个高速出口的方向、门店在市中心还是城郊——每一项都可以指定，不指定的按编号随机。
 * 下面实时显示按当前设置会生成什么（明显不合理的，比如出口朝着海，会自动挪开）。
 */
type Field = { key: keyof RegionOptions; label: string; options: [string, string][] };

const dirOpts: [string, string][] = DIR8.map((d) => [d, tx(DIR_LABEL[d])]);
const FIELDS: Field[] = [
  { key: 'form', label: tr('城市形态'), options: (Object.keys(FORM_LABEL) as CityForm[]).map((k) => [k, tx(FORM_LABEL[k])]) },
  { key: 'coast', label: tr('海岸'), options: (Object.keys(COAST_LABEL) as CoastType[]).map((k) => [k, tx(COAST_LABEL[k])]) },
  { key: 'sea', label: tr('海在城市的哪一侧'), options: dirOpts },
  { key: 'river', label: tr('河'), options: [['1', tr('有一条河穿过城区入海')], ['0', tr('没有河')]] },
  { key: 'riverForm', label: tr('河的样子（有河时）'), options: (Object.keys(RIVER_FORM_LABEL) as RiverForm[]).map((k) => [k, tx(RIVER_FORM_LABEL[k])]) },
  { key: 'wind', label: tr('常年风向（风从哪边来，跑道顺着它）'), options: dirOpts },
  { key: 'size', label: tr('城市规模'), options: (['S', 'M', 'L'] as const).map((k) => [k, tx(SIZE_LABEL[k])]) },
  { key: 'port', label: tr('港口在海岸的哪一段'), options: (['left', 'center', 'right'] as const).map((k) => [k, tx(PORT_LABEL[k])]) },
  { key: 'airport', label: tr('机场在城市的哪个方向'), options: dirOpts },
  { key: 'airportFar', label: tr('机场离城市'), options: [['0', tr('近（12–16 公里）')], ['1', tr('远（16–21 公里）')]] },
  { key: 'park', label: tr('物流园在城市的哪个方向'), options: dirOpts },
  { key: 'parkFar', label: tr('物流园离城市'), options: [['0', tr('近（12–16 公里）')], ['1', tr('远（16–21 公里）')]] },
  { key: 'rail', label: tr('洲际铁路往哪个方向出区域'), options: dirOpts },
  { key: 'domestic', label: tr('国内长途（含内陆产区）的高速出口'), options: dirOpts },
  { key: 'border', label: tr('跨境长途的高速出口'), options: dirOpts },
  { key: 'store', label: tr('门店在哪里'), options: (['center', 'urban', 'suburb'] as const).map((k) => [k, tx(STORE_LABEL[k])]) },
];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export class RegionDialog {
  private draft: Partial<RegionOptions>;
  private seed: number;

  constructor(
    private readonly root: HTMLElement,
    current: RegionSpec,
    private readonly onApply: (spec: RegionSpec) => void,
  ) {
    this.draft = { ...(current.mode === 'custom' ? current.options : {}) };
    this.seed = current.seed;
    root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'clear') {
        this.draft = {};
        this.render();
      } else if (act === 'apply') {
        this.close();
        this.onApply({ mode: 'custom', seed: this.seed, options: { ...this.draft } });
      }
    });
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      if (el.id === 'rg-seed') {
        this.seed = Math.max(1, Math.min(999999, Math.round(Number(el.value)) || 1));
        this.render();
        return;
      }
      const key = el.dataset.opt as keyof RegionOptions | undefined;
      if (!key) return;
      const d = this.draft as Record<string, unknown>;
      if (el.value === '') delete d[key];
      else if (key === 'river' || key === 'airportFar' || key === 'parkFar') d[key] = el.value === '1';
      else d[key] = el.value;
      this.render();
    });
  }

  open(seed: number): void {
    this.seed = seed;
    this.render();
    this.root.hidden = false;
  }

  close(): void {
    this.root.hidden = true;
  }

  private render(): void {
    const o = resolveOptions({ mode: 'custom', seed: this.seed, options: this.draft });
    const val = (k: keyof RegionOptions) => {
      const v = this.draft[k];
      return v === undefined ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    };
    const fields = FIELDS.map((f) => {
      const cur = val(f.key);
      return `<label class="rg-field"><span>${esc(f.label)}</span><select data-opt="${f.key}"><option value=""${cur === '' ? ' selected' : ''}>${tr('按编号随机')}</option>${f.options.map(([v, t]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    }).join('');
    const summary = [
      ...(o.form ? [tx(FORM_LABEL[o.form])] : []),
      ...(o.coast ? [tx(COAST_LABEL[o.coast])] : []),
      tr('海在{dir}边', { dir: tx(DIR_LABEL[o.sea]) }),
      o.river ? (o.riverForm ? tx(RIVER_FORM_LABEL[o.riverForm]) : tr('有河')) : tr('没有河'),
      ...(o.wind ? [tr('{dir}风', { dir: tx(DIR_LABEL[o.wind]) })] : []),
      tx(SIZE_LABEL[o.size]),
      // 港口的说法按整句查（英文里「正对市区」和「左手边」的句式不同）
      tx(`港口在${PORT_LABEL[o.port]}`),
      tr('机场在{dir}（{v2}）', { dir: tx(DIR_LABEL[o.airport]), v2: o.airportFar ? tr('远') : tr('近') }),
      tr('物流园在{dir}（{v2}）', { dir: tx(DIR_LABEL[o.park]), v2: o.parkFar ? tr('远') : tr('近') }),
      tr('铁路往{dir}', { dir: tx(DIR_LABEL[o.rail]) }),
      tr('国内长途出口在{dir}', { dir: tx(DIR_LABEL[o.domestic]) }),
      tr('跨境出口在{dir}', { dir: tx(DIR_LABEL[o.border]) }),
      tr('门店在{store}', { store: tx(STORE_LABEL[o.store]) }),
    ].join(' · ');
    this.root.innerHTML = `
      <div class="ad-box rg-box" role="dialog" aria-label="${tr('自定义区域')}">
        <header class="ad-head">
          <b>${tr('自定义区域')}</b>
          <span class="ad-tools">${tr('编号')} <input id="rg-seed" type="number" min="1" max="999999" value="${this.seed}"><button class="chip" data-act="clear" title="${tr('每一项都改回按编号随机')}">${tr('全部按编号随机')}</button><button class="primary" data-act="apply">${tr('生成这个区域')}</button><button class="tk-min" data-act="close" title="${tr('关闭')}">✕</button></span>
        </header>
        <p class="fc-muted">${tr('每一项都可以指定，没指定的按编号随机。方向是从市中心看过去；港口在海岸上，站在市区面朝大海分左右。高速出口和铁路不会朝着海，物流园在内陆。')}</p>
        <div class="rg-grid">${fields}</div>
        <p class="rg-sum"><b>${tr('按现在的设置：')}</b>${esc(summary)}</p>
      </div>`;
  }
}
