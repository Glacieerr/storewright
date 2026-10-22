import { opaqueLabelId } from '@storewright/domain';
import { ev } from '../events';
import type { OpsState, OversizedTask } from '../types';
import { no, yes, type OpsModule } from './framework';

/**
 * 大件（工作流设计 4.3，决策 GM-01～GM-03、P-07）：
 * - 锁单时由分框算法分出的大件（单件过重、超出框内径、同品合计过重）生成大件任务；
 * - 员工领取一单的大件时输入这一趟能装载的件数，剩下的留给别人；
 * - 先扫后打：扫描商品条码后打印这一件的标签（显示 1/3、2/3、3/3），一件一签；
 * - 暂存在大件区（区域级位置）。需要两人搬运的件在界面上标出。
 */

const COMMANDS = new Set(['ClaimOversized', 'ReleaseOversized', 'ScanOversized', 'StageOversized'] as const);

export const oversizedModule: OpsModule = {
  id: 'oversized',
  commands: COMMANDS,
  decide(s, env, ctx) {
    const { cmd, actor } = env;
    switch (cmd.type) {
      case 'ClaimOversized': {
        const open = Object.values(s.oversized)
          .filter((p) => p.orderId === cmd.orderId && p.status === 'OPEN')
          .sort((a, b) => a.index - b.index);
        if (!open.length) return no('NOTHING_TO_CLAIM');
        // 指定了件（按装载建议领取）时只领这些件里还没人领的；否则按顺序领前 maxPieces 件
        const ids = Array.isArray(cmd.pieceIds) ? cmd.pieceIds : [];
        const chosen = ids.length ? open.filter((p) => ids.includes(p.id)) : open;
        if (!chosen.length) return no('NOTHING_TO_CLAIM');
        const n = Math.max(1, Math.min(chosen.length, Math.round(cmd.maxPieces)));
        return yes([ev('OversizedClaimed', { orderId: cmd.orderId, pieceIds: chosen.slice(0, n).map((p) => p.id) })]);
      }
      case 'ReleaseOversized': {
        const mine = cmd.pieceIds.map((id) => s.oversized[id]).filter((p): p is OversizedTask => !!p && p.status === 'CLAIMED' && p.associateId === actor);
        if (!mine.length) return no('PIECE_NOT_YOURS');
        return yes([ev('OversizedReleased', { pieceIds: mine.map((p) => p.id) })]);
      }
      case 'ScanOversized': {
        const p = s.oversized[cmd.pieceId];
        if (!p) return no('PIECE_NOT_FOUND');
        if (p.status !== 'CLAIMED') return no('PIECE_STATE', { status: p.status });
        if (p.associateId !== actor) return no('PIECE_NOT_YOURS');
        const item = ctx.itemByGtin(cmd.code.trim());
        if (!item || item.id !== p.itemId) return no('CASE_WRONG_ITEM');
        return yes([ev('OversizedLabeled', { pieceId: p.id, labelId: opaqueLabelId(p.id, 1) })]);
      }
      case 'StageOversized': {
        const p = s.oversized[cmd.pieceId];
        if (!p) return no('PIECE_NOT_FOUND');
        if (p.status !== 'LABELED') return no('PIECE_STATE', { status: p.status });
        if (p.associateId !== actor) return no('PIECE_NOT_YOURS');
        const area = cmd.area.trim().toUpperCase();
        if (ctx.statics.oversizedAreas?.length && !ctx.statics.oversizedAreas.includes(area)) return no('SLOT_NOT_FOUND');
        return yes([ev('OversizedStaged', { pieceId: p.id, area })]);
      }
      default:
        return no('INVALID_ORDER');
    }
  },
  apply(s, e) {
    switch (e.type) {
      case 'OversizedPiecesCreated':
        for (const p of e.payload.pieces) s.oversized[p.pieceId] = { id: p.pieceId, orderId: e.payload.orderId, lineId: p.lineId, itemId: p.itemId, name: p.name, gtin: p.gtin, index: p.index, count: p.count, weightKg: p.weightKg, teamLift: p.teamLift, status: 'OPEN' };
        return true;
      case 'OversizedClaimed':
        for (const id of e.payload.pieceIds) {
          const p = s.oversized[id];
          if (p) {
            p.status = 'CLAIMED';
            p.associateId = e.actor;
          }
        }
        return true;
      case 'OversizedReleased':
        for (const id of e.payload.pieceIds) {
          const p = s.oversized[id];
          if (p) {
            p.status = 'OPEN';
            delete p.associateId;
          }
        }
        return true;
      case 'OversizedLabeled': {
        const p = s.oversized[e.payload.pieceId];
        if (p) {
          p.status = 'LABELED';
          p.labelId = e.payload.labelId;
        }
        return true;
      }
      case 'OversizedStaged': {
        const p = s.oversized[e.payload.pieceId];
        if (p) {
          p.status = 'STAGED';
          p.area = e.payload.area;
          p.stagedAt = e.at;
        }
        return true;
      }
      default:
        return false;
    }
  },
};

/** 每单的大件进度（交付看板与大件页使用） */
export function oversizedByOrder(s: OpsState): Map<string, OversizedTask[]> {
  const m = new Map<string, OversizedTask[]>();
  for (const p of Object.values(s.oversized)) {
    const list = m.get(p.orderId) ?? [];
    list.push(p);
    m.set(p.orderId, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.index - b.index);
  return m;
}
