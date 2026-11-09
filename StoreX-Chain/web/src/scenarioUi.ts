import './ux.css';
import { clockText, parseScenario, scenarioUrl, type ParseResult, type Scenario } from '../../src/scenario';
import { GEN_LABEL, LOAD_LABEL } from '../../src/sim/config';
import { appApi } from './appBus';
import { DRILLS } from './drills';
import { isEn, t as tr, tx } from './i18n';

/**
 * 场景的界面：顶栏「分享」（复制链接、导出 / 导入场景文件）、「场景库」（精选场景，点一下套用）、不打扰的提示条。
 * 场景怎么套用、现在的设置怎么写成场景，都在 main.ts 的 AppApi 里（web/src/appBus.ts）。
 * Share popover, scenario library dialog and toasts. Applying and capturing scenarios lives in main.ts (AppApi).
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

// —— 提示条 ——
let toasts: HTMLElement | undefined;
export function toast(title: string, opts: { kind?: 'info' | 'warn' | 'error'; items?: string[]; ms?: number } = {}): void {
  if (typeof document === 'undefined') return;
  if (!toasts) {
    toasts = document.createElement('div');
    toasts.className = 'ux-toasts';
    toasts.setAttribute('role', 'status');
    toasts.setAttribute('aria-live', 'polite');
    document.body.append(toasts);
  }
  const el = document.createElement('div');
  el.className = `ux-toast ${opts.kind ?? 'info'}`;
  const items = opts.items?.length ? `<ul>${opts.items.slice(0, 8).map((x) => `<li>${esc(tx(x))}</li>`).join('')}${opts.items.length > 8 ? `<li>${esc(tr('还有 {n} 条', { n: opts.items.length - 8 }))}</li>` : ''}</ul>` : '';
  el.innerHTML = `<button type="button" aria-label="${esc(tr('关闭'))}">×</button>${esc(title)}${items}`;
  el.querySelector('button')?.addEventListener('click', () => el.remove());
  toasts.append(el);
  const ms = opts.ms ?? (opts.kind === 'error' ? 12000 : opts.items?.length ? 9000 : 4000);
  setTimeout(() => el.remove(), ms);
}

/** 场景文件 / 链接的检查结果：错误逐条列出，提醒单独一条 */
export function showIssues(r: Pick<ParseResult, 'errors' | 'warnings'>, what: string): void {
  if (r.errors.length) toast(tr('{what}有 {n} 处不对，没有套用：', { what, n: r.errors.length }), { kind: 'error', items: r.errors });
  if (r.warnings.length) toast(tr('{what}里有 {n} 处忽略了：', { what, n: r.warnings.length }), { kind: 'warn', items: r.warnings });
}

// —— 场景库 ——
export interface LibraryEntry {
  id: string;
  title: string;
  titleEn: string;
  description: string;
  descriptionEn: string;
}

let indexMemo: Promise<LibraryEntry[]> | undefined;
/** 场景库的目录（相对页面的 scenarios/index.json；部署到任何子路径都能用） */
export function loadLibraryIndex(): Promise<LibraryEntry[]> {
  indexMemo ??= fetch('scenarios/index.json')
    .then((r) => (r.ok ? (r.json() as Promise<{ scenarios: LibraryEntry[] }>) : Promise.reject(new Error(String(r.status)))))
    .then((d) => d.scenarios)
    .catch((e: unknown) => {
      indexMemo = undefined;
      throw e;
    });
  return indexMemo;
}

const fileMemo = new Map<string, Promise<ParseResult>>();
/** 读场景库里的一个场景（检查规则和导入的文件一样） */
export function loadLibraryScenario(id: string): Promise<ParseResult> {
  let p = fileMemo.get(id);
  if (!p) {
    p = fetch(`scenarios/${encodeURIComponent(id)}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => parseScenario(j))
      .catch((e: unknown) => {
        fileMemo.delete(id);
        return { errors: [tr('场景库里没有找到「{id}」（{err}）', { id, err: String(e) })], warnings: [] };
      });
    fileMemo.set(id, p);
  }
  return p;
}

const titleOf = (s: { title?: string; titleEn?: string }) => (isEn() ? s.titleEn || s.title : s.title || s.titleEn) ?? '';
const descOf = (s: { description?: string; descriptionEn?: string }) => (isEn() ? s.descriptionEn || s.description : s.description || s.descriptionEn) ?? '';

/** 场景卡片上的标签：区域、方案、负荷、演练、时刻、导览 / 练习 */
function tagsOf(s: Scenario): string[] {
  const out: string[] = [];
  const r = s.region ?? 'default';
  out.push(r === 'default' ? tr('默认区域') : r.startsWith('random-') ? tr('随机区域 {n}', { n: r.slice(7) }) : tr('自定义区域'));
  if (s.gen && s.gen !== 'g3') out.push(tx(GEN_LABEL[s.gen]));
  if (s.load && s.load !== 'normal') out.push(tx(LOAD_LABEL[s.load]));
  if (s.drill && s.drill !== 'none') out.push(tx(DRILLS.find((d) => d.key === s.drill)?.label ?? s.drill));
  if (s.facilities && Object.keys(s.facilities).length) out.push(tr('改过设施'));
  if (s.time !== undefined) out.push(clockText(s.time));
  return out;
}

async function applyWithNote(s: Scenario): Promise<void> {
  const api = appApi();
  if (!api) {
    toast(tr('页面还在准备，稍等一下再试'), { kind: 'warn' });
    return;
  }
  await api.applyScenario(s);
}

// —— 分享框 ——
function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 现在的分享链接（保留网址里不属于场景的参数，比如界面语言） */
export function shareUrl(s?: Scenario): string {
  const api = appApi();
  const sc = s ?? api?.currentScenario() ?? {};
  return scenarioUrl(`${location.origin}${location.pathname}`, sc, new URLSearchParams(location.search));
}

async function copyText(text: string, input?: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 没有剪贴板权限（http、旧浏览器）：选中文字让用户自己复制
    if (input) {
      input.focus();
      input.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }
    return false;
  }
}

export interface ScenarioUi {
  openShare(): void;
  openLibrary(): void;
  importFile(): void;
}

export function mountScenarioUi(): ScenarioUi {
  const shareBtn = document.getElementById('share-btn') as HTMLButtonElement | null;
  const libBtn = document.getElementById('library-btn') as HTMLButtonElement | null;
  let pop: HTMLElement | undefined;
  let modal: HTMLElement | undefined;
  let lastFocus: HTMLElement | null = null;

  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.hidden = true;
  document.body.append(file);
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (f.size > 256 * 1024) {
      toast(tr('场景文件太大（最多 256 KB）'), { kind: 'error' });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(await f.text());
    } catch (e) {
      toast(tr('不是合法的 JSON：{err}', { err: String(e).slice(0, 160) }), { kind: 'error' });
      return;
    }
    const r = parseScenario(json);
    showIssues(r, tr('场景文件'));
    if (!r.scenario) return;
    closePop();
    toast(tr('已导入场景{title}', { title: titleOf(r.scenario) ? `「${titleOf(r.scenario)}」` : '' }));
    await applyWithNote(r.scenario);
  };

  const closePop = () => {
    pop?.remove();
    pop = undefined;
    shareBtn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e: Event) => {
    if (pop && !pop.contains(e.target as Node) && e.target !== shareBtn) closePop();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePop();
      shareBtn?.focus();
    }
  };

  const openShare = () => {
    if (pop) return closePop();
    const api = appApi();
    if (!api) {
      toast(tr('页面还在准备，稍等一下再试'), { kind: 'warn' });
      return;
    }
    const url = shareUrl();
    pop = document.createElement('div');
    pop.className = 'ux-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', tr('分享此刻'));
    pop.innerHTML = `<h4>${esc(tr('分享此刻'))}</h4>
      <p>${esc(tr('链接里有区域、方案、日子、负荷、演练、设施改动、时刻和镜头：别人打开看到的就是你现在看到的。'))}</p>
      <div class="ux-link"><input type="text" readonly aria-label="${esc(tr('分享链接'))}" value="${esc(url)}" /><button type="button" class="ux-btn primary" data-act="copy">${esc(tr('复制链接'))}</button></div>
      <div class="ux-row">
        <button type="button" class="ux-btn" data-act="export">${esc(tr('导出场景文件'))}</button>
        <button type="button" class="ux-btn" data-act="import">${esc(tr('导入场景文件'))}</button>
        <button type="button" class="ux-btn" data-act="library">${esc(tr('打开场景库'))}</button>
      </div>`;
    document.body.append(pop);
    const r = shareBtn?.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.top = `${Math.round((r?.bottom ?? 56) + 8)}px`;
    pop.style.left = `${Math.round(Math.max(12, Math.min(innerWidth - w - 12, (r ? r.right : innerWidth) - w)))}px`;
    shareBtn?.setAttribute('aria-expanded', 'true');
    const input = pop.querySelector('input') as HTMLInputElement;
    input.onfocus = () => input.select();
    pop.querySelector<HTMLButtonElement>('[data-act="copy"]')?.addEventListener('click', async () => {
      const ok = await copyText(input.value, input);
      toast(ok ? tr('链接已复制') : tr('没能自动复制：链接已选中，请按 Ctrl+C / ⌘C'), { kind: ok ? 'info' : 'warn' });
    });
    pop.querySelector<HTMLButtonElement>('[data-act="export"]')?.addEventListener('click', () => {
      const s = appApi()?.currentScenario();
      if (!s) return;
      const stamp = s.time !== undefined ? clockText(s.time).replace(':', '') : 'now';
      downloadJson(`storex-chain-scenario-${s.gen ?? 'g3'}-${stamp}.json`, s);
      toast(tr('场景文件已导出'));
    });
    pop.querySelector<HTMLButtonElement>('[data-act="import"]')?.addEventListener('click', () => file.click());
    pop.querySelector<HTMLButtonElement>('[data-act="library"]')?.addEventListener('click', () => {
      closePop();
      openLibrary();
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
    });
    (pop.querySelector('[data-act="copy"]') as HTMLButtonElement).focus();
  };

  const closeModal = () => {
    modal?.remove();
    modal = undefined;
    libBtn?.setAttribute('aria-expanded', 'false');
    lastFocus?.focus();
  };

  const openLibrary = () => {
    if (modal) return;
    lastFocus = document.activeElement as HTMLElement | null;
    modal = document.createElement('div');
    modal.className = 'ux-modal';
    modal.innerHTML = `<div class="ux-dialog" role="dialog" aria-modal="true" aria-labelledby="ux-lib-title">
      <div class="ux-dialog-head"><h3 id="ux-lib-title">${esc(tr('场景库'))}</h3><button type="button" class="ux-btn" data-act="close">${esc(tr('关闭'))}</button></div>
      <p>${esc(tr('精选的几个场景：点一下就切到那个区域、负荷、演练、时刻和镜头。换区域或设施时会重新载入页面。也可以从「分享」导入自己的场景文件。'))}</p>
      <div class="ux-cards" aria-busy="true"><span class="note">${esc(tr('正在读取场景库…'))}</span></div>
    </div>`;
    document.body.append(modal);
    libBtn?.setAttribute('aria-expanded', 'true');
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    modal.querySelector<HTMLButtonElement>('[data-act="close"]')?.addEventListener('click', closeModal);
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
      // 焦点留在对话框里
      if (e.key === 'Tab' && modal) {
        const f = [...modal.querySelectorAll<HTMLElement>('button')];
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });
    (modal.querySelector('[data-act="close"]') as HTMLButtonElement).focus();
    const box = modal.querySelector('.ux-cards') as HTMLElement;
    void loadLibraryIndex()
      .then(async (list) => {
        const parsed = await Promise.all(list.map((e) => loadLibraryScenario(e.id)));
        box.removeAttribute('aria-busy');
        box.innerHTML = '';
        list.forEach((e, i) => {
          const s = parsed[i]?.scenario;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ux-card';
          b.dataset.id = e.id;
          const tags = s ? tagsOf(s) : [];
          const extra = s?.tour ? `<i class="hot">${esc(tr('导览'))}</i>` : s?.exercise ? `<i class="hot">${esc(tr('练习'))}</i>` : '';
          b.innerHTML = `<b>${esc(titleOf(e))}</b><span>${esc(descOf(e))}</span><span class="ux-tags">${extra}${tags.map((x) => `<i>${esc(x)}</i>`).join('')}</span>`;
          b.disabled = !s;
          b.onclick = async () => {
            if (!s) return;
            closeModal();
            toast(tr('切到场景「{title}」', { title: titleOf(e) }));
            await applyWithNote({ ...s, id: e.id });
          };
          box.append(b);
        });
      })
      .catch((err: unknown) => {
        box.innerHTML = `<span class="note">${esc(tr('场景库没读出来：{err}', { err: String(err) }))}</span>`;
      });
  };

  if (shareBtn) shareBtn.onclick = openShare;
  if (libBtn) libBtn.onclick = openLibrary;
  return { openShare, openLibrary, importFile: () => file.click() };
}
