import { regionMap } from '../analysis/mapSvg';
import { NODES, type Km } from '../region/region';
import { planName, type NetPlan, type Ranked } from './index';
import { NET } from './model';
import { SITE_KIND_LABEL, type NetSite, type NetStore, type SiteKind } from './sites';

/**
 * 网络规划的地图：在区域地图上画候选仓（开的实心、没开的空心虚线框）、门店（圆的大小按规模）、
 * 每天的配送线路（颜色按送货的仓的类型）和物流园到中转仓的干线（虚线）。区域外的远郊镇画在区域边上，标出离高速口多远。
 * 仓的类型只有三种颜色（物流园、新建配送中心、中转仓），哪家店由哪个仓送靠线路和标签看，不只靠颜色。
 * 带 data-tip 的元素是鼠标悬停时显示的说明（网页里用 textContent 填进提示框）。
 */
export const KIND_VAR: Record<SiteKind, string> = { park: 'var(--nw-park)', dc: 'var(--nw-dc)', xd: 'var(--nw-xd)' };

/** 标签描一圈底色（和线路、底图的字重叠时也认得出） */
const HALO = 'paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (x: number) => x.toFixed(1);

export function networkMap(plan: NetPlan, r: Ranked, scope: string): string {
  const ev = r.eval;
  const open = new Set(ev.open);
  const siteOf = (key: string) => plan.sites.find((s) => s.key === key) as NetSite;
  const storeOf = (key: string) => plan.stores.find((s) => s.key === key) as NetStore;
  const pal = (key: string) => plan.inst.pallets[plan.stores.findIndex((s) => s.key === key)] ?? 0;
  return regionMap({
    scope,
    bare: true,
    title: `网络规划：${planName(plan, r)}`,
    subtitle: `${plan.stores.length} 家店 · 每天经仓约 ${Math.round(plan.pallets)} 托 · ${ev.vehicles} 辆车每天 ${Math.round(ev.kmDay).toLocaleString('en-US')} 公里 · 虚构的区域，数字是合成的`,
    aria: `网络规划地图：${planName(plan, r)}，${plan.stores.length} 家店`,
    overlay: (P, box) => {
      const inBox = (x: number, y: number) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
      // 区域外的点：沿高速口往外的方向和区域边框的交点，往里缩一点
      const edgePoint = (st: NetStore): readonly [number, number] => {
        const via = st.outer?.via ?? 'EAST';
        const [ax, ay] = P(NODES[via] as Km);
        const [bx, by] = P(st.km);
        let t = 1;
        for (const [lim, v0, v1] of [
          [box.x + 14, ax, bx],
          [box.x + box.w - 14, ax, bx],
        ] as const)
          if (v1 !== v0 && (v1 - lim) * (v0 - lim) < 0) t = Math.min(t, (lim - v0) / (v1 - v0));
        for (const [lim, v0, v1] of [
          [box.y + 14, ay, by],
          [box.y + box.h - 14, ay, by],
        ] as const)
          if (v1 !== v0 && (v1 - lim) * (v0 - lim) < 0) t = Math.min(t, (lim - v0) / (v1 - v0));
        return [ax + (bx - ax) * t, ay + (by - ay) * t] as const;
      };
      const pos = (st: NetStore) => {
        const [x, y] = P(st.km);
        return inBox(x, y) ? ([x, y] as const) : edgePoint(st);
      };
      const line = (pts: readonly Km[]) => pts.map((p) => P(p).map(f1).join(',')).join(' ');
      let out = `<g clip-path="url(#${scope}-clip)">`;
      // 干线：物流园 → 中转仓
      for (const sh of ev.shuttles) out += `<polyline points="${line(sh.pts)}" fill="none" stroke="var(--nw-xd)" stroke-width="3" stroke-dasharray="8 5" stroke-linecap="round" opacity="0.9" data-tip="${esc(`干线：物流园 → ${siteOf(sh.site).short}，每天约 ${Math.round(sh.pallets)} 托（双挂车整车转运）`)}"/>`;
      // 配送线路：同样的一趟（整车）只画一次，提示里写一天几车
      const seen = new Map<string, { n: number; t: (typeof ev.trips)[number] }>();
      for (const t of ev.trips) {
        const k = `${t.site}|${t.full}|${t.stops.map((s) => s.key).join('>')}`;
        const hit = seen.get(k);
        if (hit) hit.n++;
        else seen.set(k, { n: 1, t });
      }
      for (const { n, t } of seen.values()) {
        const s = siteOf(t.site);
        const names = t.stops.map((x) => storeOf(x.key).name).join(' → ');
        const tip = t.full ? `${s.short}整车送${names}：每天 ${n} 车（每车 ${NET.truckPallets} 托），单趟 ${Math.round(t.km)} 公里、${t.hours.toFixed(1)} 小时` : `${s.short}拼车：${names}，${f1(t.pallets)} 托，${Math.round(t.km)} 公里、${t.hours.toFixed(1)} 小时${n > 1 ? `，每天 ${n} 趟` : ''}`;
        out += `<polyline points="${line(t.pts)}" fill="none" stroke="${KIND_VAR[s.kind]}" stroke-width="${t.full ? 2.6 : 2}" stroke-linecap="round" stroke-linejoin="round" opacity="0.72" data-tip="${esc(tip)}"/>`;
      }
      out += '</g>';
      // 区域外的远郊镇：从高速口到区域边上的一段
      for (const st of plan.stores.filter((x) => x.outer)) {
        const [ax, ay] = P(NODES[(st.outer as NonNullable<NetStore['outer']>).via] as Km);
        const [ex, ey] = pos(st);
        out += `<line x1="${f1(ax)}" y1="${f1(ay)}" x2="${f1(ex)}" y2="${f1(ey)}" stroke="var(--ink2)" stroke-width="1" stroke-dasharray="3 3"/>`;
      }
      // 候选仓：开的实心（物流园和配送中心是圆角方块，中转仓是菱形），没开的空心虚线
      for (const s of plan.sites) {
        const [x, y] = P(s.km);
        const on = open.has(s.key);
        const use = ev.sites.find((u) => u.key === s.key);
        const tip = on
          ? `${s.name}（${SITE_KIND_LABEL[s.kind]}）：每天出 ${Math.round(use?.load ?? 0)} 托 / 能力 ${use?.cap ?? 0} 托${s.kind === 'park' && ev.expanded ? '（扩建后）' : ''}，送 ${use?.stores.length ?? 0} 家店，${use?.vehicles ?? 0} 辆车`
          : `${s.name}（${SITE_KIND_LABEL[s.kind]}，候选，没选）`;
        const shape = s.kind === 'xd' ? `<rect x="${f1(x - 6.5)}" y="${f1(y - 6.5)}" width="13" height="13" rx="2" transform="rotate(45 ${f1(x)} ${f1(y)})"` : `<rect x="${f1(x - 7.5)}" y="${f1(y - 7.5)}" width="15" height="15" rx="4"`;
        out += on ? `${shape} fill="${KIND_VAR[s.kind]}" stroke="var(--bg)" stroke-width="2"/>` : `${shape} fill="var(--bg)" fill-opacity="0.7" stroke="var(--ink2)" stroke-width="1.2" stroke-dasharray="3 2"/>`;
        // 只给开着的仓写名字（没选的候选看图例和悬停说明）；中转仓在高速口旁边，名字写在左边，避开底图上高速口的标签
        if (on) {
          const name = s.kind === 'park' ? `物流园${ev.expanded ? '（扩建）' : ''}` : `${s.short}${s.kind === 'xd' ? '中转仓' : '配送中心'}`;
          out += s.kind === 'xd' ? `<text x="${f1(x - 11)}" y="${f1(y - 10)}" text-anchor="end" class="lab" style="${HALO}">${esc(name)}</text>` : `<text x="${f1(x + 11)}" y="${f1(y - 10)}" class="lab" style="${HALO}">${esc(name)}</text>`;
        }
        out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="13" fill="transparent" data-tip="${esc(tip)}"/>`;
      }
      // 门店：圆的大小按规模，深色、带一圈底色；名字在右边
      for (const st of plan.stores) {
        const [x, y] = pos(st);
        const rad = 3.5 + Math.sqrt(st.size) * 2.6;
        const site = siteOf(ev.assign[st.key] as string);
        const extra = st.outer ? `（区域外，出${st.outer.via === 'NORTH' ? '北' : '东'}面高速口 ${Math.round(st.outer.km)} 公里）` : '';
        const tip = `${st.name}${extra}：规模 ${st.size}，每天经仓 ${f1(pal(st.key))} 托，由${site.short}送`;
        out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rad)}" fill="var(--ink)" stroke="var(--bg)" stroke-width="2"/>`;
        // 靠右边的（区域外的东郊镇）名字写在左边，不出图
        const label = `${esc(st.name)}${st.outer ? ` · ${Math.round(st.outer.km)} 公里外` : ''}`;
        out += x > box.x + box.w - 170 ? `<text x="${f1(x - rad - 2)}" y="${f1(y - rad - 4)}" text-anchor="end" class="lab" style="${HALO}">${label}</text>` : `<text x="${f1(x + rad + 4)}" y="${f1(y + 4)}" class="lab" style="${HALO}">${label}</text>`;
        out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(Math.max(12, rad + 4))}" fill="transparent" data-tip="${esc(tip)}"/>`;
      }
      return out;
    },
  });
}
