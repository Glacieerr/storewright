import { t as tr } from './i18n';

/**
 * 练习抽屉（教学沙盘）：顶栏「练习」按钮、关闭按钮、Esc；第一次打开时才加载 teachPanel 模块（不拖慢首屏）。
 * 别的模块发 'storex:open-teach'（detail.exercise = 'ex03' 可选）也会打开它，并让面板直接打开那一道练习。
 * Teaching drawer host: lazily loads ./teachPanel on first open; listens for 'storex:open-teach'.
 */
type PanelModule = { mountTeachPanel(host: HTMLElement): void; openExercise?: (id: string) => void };

export function mountTeachHost(): { open(exercise?: string): Promise<void>; close(): void } {
  const drawer = document.getElementById('teach');
  const body = document.getElementById('teach-body');
  const btn = document.getElementById('teach-btn');
  const closeBtn = document.getElementById('teach-close');
  let mod: Promise<PanelModule> | undefined;
  if (body) body.dataset.loading = tr('正在载入练习…');

  const close = () => {
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    btn?.setAttribute('aria-expanded', 'false');
    btn?.focus();
  };
  const open = async (exercise?: string) => {
    if (!drawer || !body) return;
    drawer.hidden = false;
    btn?.setAttribute('aria-expanded', 'true');
    if (!mod) {
      mod = import('./teachPanel') as Promise<PanelModule>;
      try {
        (await mod).mountTeachPanel(body);
      } catch (e) {
        mod = undefined;
        body.textContent = tr('练习面板没能载入：{err}', { err: String(e) });
        return;
      }
    }
    const m = await mod;
    if (exercise) m.openExercise?.(exercise);
    (closeBtn as HTMLElement | null)?.focus();
  };

  btn?.addEventListener('click', () => (drawer && !drawer.hidden ? close() : void open()));
  closeBtn?.addEventListener('click', close);
  drawer?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.addEventListener('storex:open-teach', (e) => {
    const id = (e as CustomEvent<{ exercise?: string } | undefined>).detail?.exercise;
    void open(typeof id === 'string' ? id : undefined);
  });
  return { open, close };
}
