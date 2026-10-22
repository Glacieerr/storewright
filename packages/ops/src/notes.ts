import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { OpsState, StoreNote, StoreStatic } from './types';

/**
 * 门店经验库（Phase 5d）：员工记下「这个商品其实在端架」「冷冻暂存满了先放 F-03」之类的现场经验。
 * 人会走，经验留在系统里：本地助手回答问题时可以检索这些记录。
 * 任何员工都可以添加；作者本人、带班负责人或控制台可以删除。状态里最多保留 MAX_NOTES 条（最早的先清理），完整记录在事件流里。
 */

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

export const MAX_NOTES = 500;

type NoteCommand = Extract<OpsCommand, { type: 'AddNote' | 'RemoveNote' }>;
export const NOTE_COMMANDS = new Set<OpsCommand['type']>(['AddNote', 'RemoveNote']);
export function isNoteCommand(cmd: OpsCommand): cmd is NoteCommand {
  return NOTE_COMMANDS.has(cmd.type);
}

export function decideNote(s: OpsState, env: CommandEnvelope & { cmd: NoteCommand }, st: StoreStatic, canManage: boolean): Result {
  const { cmd, actor } = env;
  if (cmd.type === 'AddNote') {
    const text = typeof cmd.text === 'string' ? cmd.text.trim().slice(0, 300) : '';
    if (text.length < 2) return no('NOTE_EMPTY');
    const itemId = cmd.itemId && st.planogram.some((p) => p.itemId === cmd.itemId) ? cmd.itemId : undefined;
    const tags = Array.isArray(cmd.tags) ? cmd.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 20)).filter(Boolean).slice(0, 5) : [];
    const locationId = typeof cmd.locationId === 'string' && cmd.locationId.trim() ? cmd.locationId.trim().toUpperCase().slice(0, 40) : undefined;
    return yes([ev('NoteAdded', { noteId: `N${String(s.counters.notes + 1).padStart(5, '0')}`, text, tags, ...(itemId ? { itemId } : {}), ...(locationId ? { locationId } : {}) })]);
  }
  const n = s.notes[cmd.noteId];
  if (!n) return no('NOTE_NOT_FOUND');
  if (n.author !== actor && !canManage) return no('NOT_AUTHORIZED');
  return yes([ev('NoteRemoved', { noteId: n.id })]);
}

export function applyNoteEvent(s: OpsState, e: AnyOpsEvent): boolean {
  if (e.type === 'NoteAdded') {
    const p = e.payload;
    s.notes[p.noteId] = { id: p.noteId, text: p.text, tags: p.tags, author: e.actor, at: e.at, ...(p.itemId ? { itemId: p.itemId } : {}), ...(p.locationId ? { locationId: p.locationId } : {}) };
    s.counters.notes += 1;
    const ids = Object.keys(s.notes);
    if (ids.length > MAX_NOTES) {
      const old = Object.values(s.notes).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      for (const x of old.slice(0, ids.length - MAX_NOTES)) delete s.notes[x.id];
    }
    return true;
  }
  if (e.type === 'NoteRemoved') {
    delete s.notes[e.payload.noteId];
    return true;
  }
  return false;
}

/** 最新的经验记录在前 */
export function recentNotes(s: OpsState, limit = 50): StoreNote[] {
  return Object.values(s.notes)
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, limit);
}
