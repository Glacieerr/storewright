import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTemplate } from '@storewright/store-config';
import { deleteProject, exportProject, getProject, listProjects, parseProjectFile, saveProject, type StoreProject } from './projects';

const project = (id: string, updatedAt: number): StoreProject => ({ v: 1, id, name: `店 ${id}`, createdAt: 1, updatedAt, config: createTemplate('small'), sizing: { ordersPerDay: 120, staffScale: 0.8 } });

describe('「你的商店」的门店项目（决策记录 0013、0027）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('导出的门店文件导回来是一家新门店：配置和规模不变，编号和时间是新的；别的 JSON 不接受', () => {
    const p = project('p1', 5);
    const back = parseProjectFile(exportProject(p));
    expect(back).toMatchObject({ v: 1, name: p.name, config: p.config, sizing: p.sizing });
    expect(back?.id).not.toBe(p.id);
    expect(back?.createdAt).toBeGreaterThan(p.createdAt);
    expect(parseProjectFile(JSON.stringify({ name: 'x', config: p.config }))).toBeUndefined();
    expect(parseProjectFile('not json')).toBeUndefined();
  });

  it('没有 IndexedDB 时退回 localStorage：保存、按最近修改排序列出、读取、删除', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    await saveProject(project('a', 10));
    await saveProject(project('b', 20));
    expect((await listProjects()).map((p) => p.id)).toEqual(['b', 'a']);
    await saveProject({ ...project('a', 30), name: '改名' });
    expect((await getProject('a'))?.name).toBe('改名');
    expect((await listProjects()).map((p) => p.id)).toEqual(['a', 'b']);
    await deleteProject('b');
    expect((await listProjects()).map((p) => p.id)).toEqual(['a']);
  });
});
