/**
 * 配送线路：节约法（Clarke–Wright）。每家店是一个点，从配送中心出发、回到配送中心；
 * 合并两条线路省下的里程 = d(中心, i) + d(中心, j) − d(i, j)，按省得多少从大到小合并，
 * 不超过车的托盘数和停靠点数。超过一车的店先单独派整车。
 */
export interface Job {
  store: string;
  pallets: number;
}

export interface Route {
  stops: Job[];
  pallets: number;
}

export function planRoutes(jobs: readonly Job[], cap: number, maxStops: number, dist: (a: string, b: string) => number, depot: string): Route[] {
  const routes: Route[] = [];
  const rest: Job[] = [];
  // 超过一车的部分先派整车
  for (const j of jobs) {
    let p = j.pallets;
    while (p > cap) {
      routes.push({ stops: [{ store: j.store, pallets: cap }], pallets: cap });
      p -= cap;
    }
    if (p > 0) rest.push({ store: j.store, pallets: p });
  }
  if (!rest.length) return routes;
  // 每家店一条线路，再按节约值合并（只合并线路两端的点）
  const own: Route[] = rest.map((j) => ({ stops: [j], pallets: j.pallets }));
  const routeOf = new Map<string, Route>(rest.map((j, i) => [j.store, own[i] as Route]));
  const savings: { i: string; j: string; s: number }[] = [];
  for (let a = 0; a < rest.length; a++)
    for (let b = a + 1; b < rest.length; b++) {
      const i = (rest[a] as Job).store;
      const j = (rest[b] as Job).store;
      savings.push({ i, j, s: dist(depot, i) + dist(depot, j) - dist(i, j) });
    }
  savings.sort((x, y) => y.s - x.s || x.i.localeCompare(y.i) || x.j.localeCompare(y.j));
  for (const { i, j, s } of savings) {
    if (s <= 0) break;
    const ri = routeOf.get(i) as Route;
    const rj = routeOf.get(j) as Route;
    if (ri === rj || ri.pallets + rj.pallets > cap || ri.stops.length + rj.stops.length > maxStops) continue;
    const iEnd = (ri.stops[ri.stops.length - 1] as Job).store === i;
    const iStart = (ri.stops[0] as Job).store === i;
    const jEnd = (rj.stops[rj.stops.length - 1] as Job).store === j;
    const jStart = (rj.stops[0] as Job).store === j;
    let merged: Job[] | undefined;
    if (iEnd && jStart) merged = [...ri.stops, ...rj.stops];
    else if (jEnd && iStart) merged = [...rj.stops, ...ri.stops];
    else if (iEnd && jEnd) merged = [...ri.stops, ...[...rj.stops].reverse()];
    else if (iStart && jStart) merged = [...[...ri.stops].reverse(), ...rj.stops];
    if (!merged) continue;
    const nr: Route = { stops: merged, pallets: ri.pallets + rj.pallets };
    for (const st of merged) routeOf.set(st.store, nr);
  }
  const seen = new Set<Route>();
  for (const j of rest) {
    const r = routeOf.get(j.store) as Route;
    if (!seen.has(r)) {
      seen.add(r);
      routes.push(r);
    }
  }
  return routes;
}

/** 线路总里程（配送中心 → 各店 → 配送中心） */
export function routeKm(r: Route, dist: (a: string, b: string) => number, depot: string): number {
  let km = 0;
  let at = depot;
  for (const s of r.stops) {
    km += dist(at, s.store);
    at = s.store;
  }
  return km + dist(at, depot);
}
