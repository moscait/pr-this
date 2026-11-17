import type { ArchComponent, ArchFlow } from '../../src/shared/types';

export const NODE_W = 214;
export const NODE_H = 80;
const GAP_X = 128;
const GAP_Y = 36;
const PAD = 36;

export interface NodePos {
  id: string;
  x: number;
  y: number;
  layer: number;
}

export interface EdgePath {
  flow: ArchFlow;
  d: string;
  mid: { x: number; y: number };
}

export interface Layout {
  nodes: Map<string, NodePos>;
  edges: EdgePath[];
  width: number;
  height: number;
}

/** Layered (Sugiyama-lite) layout: longest-path layering + barycenter ordering. */
export function layoutGraph(components: ArchComponent[], flows: ArchFlow[]): Layout {
  const ids = components.map((c) => c.id);
  const n = ids.length;
  const layer = new Map(ids.map((id) => [id, 0]));
  const connected = new Set(flows.flatMap((f) => [f.from, f.to]));

  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const f of flows) {
      const lf = layer.get(f.from)!;
      if (layer.get(f.to)! <= lf && lf + 1 < n) {
        layer.set(f.to, lf + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  let columns: string[][] = [];
  if (!flows.length) {
    // No flows: a tidy grid, at most 3 rows.
    const rows = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(n))));
    ids.forEach((id, i) => {
      const c = Math.floor(i / rows);
      (columns[c] ??= []).push(id);
    });
  } else {
    for (const id of ids) {
      if (!connected.has(id)) continue;
      const l = layer.get(id)!;
      (columns[l] ??= []).push(id);
    }
    columns = columns.filter(Boolean);
    // Isolated nodes go to the least crowded columns.
    for (const id of ids.filter((x) => !connected.has(x))) {
      const target = columns.reduce((best, col) => (col.length < best.length ? col : best), columns[0]);
      target.push(id);
    }
    // Barycenter ordering, two sweeps.
    const preds = new Map<string, string[]>();
    for (const f of flows) preds.set(f.to, [...(preds.get(f.to) ?? []), f.from]);
    for (let sweep = 0; sweep < 2; sweep++) {
      const rowOf = new Map<string, number>();
      columns.forEach((col) => col.forEach((id, r) => rowOf.set(id, r)));
      for (let c = 1; c < columns.length; c++) {
        const bc = (id: string) => {
          const p = (preds.get(id) ?? []).map((x) => rowOf.get(x)).filter((x): x is number => x !== undefined);
          return p.length ? p.reduce((a, b) => a + b, 0) / p.length : (rowOf.get(id) ?? 0);
        };
        columns[c].sort((a, b) => bc(a) - bc(b));
        columns[c].forEach((id, r) => rowOf.set(id, r));
      }
    }
  }

  const maxRows = Math.max(1, ...columns.map((c) => c.length));
  const innerH = maxRows * NODE_H + (maxRows - 1) * GAP_Y;
  const nodes = new Map<string, NodePos>();
  columns.forEach((col, c) => {
    const colH = col.length * NODE_H + (col.length - 1) * GAP_Y;
    const top = PAD + (innerH - colH) / 2;
    col.forEach((id, r) => nodes.set(id, { id, layer: c, x: PAD + c * (NODE_W + GAP_X), y: top + r * (NODE_H + GAP_Y) }));
  });

  let extraBottom = 0;
  const edges: EdgePath[] = flows
    .filter((f) => nodes.has(f.from) && nodes.has(f.to))
    .map((f) => {
      const a = nodes.get(f.from)!;
      const b = nodes.get(f.to)!;
      let p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number];
      if (b.layer > a.layer) {
        p0 = [a.x + NODE_W, a.y + NODE_H / 2];
        p3 = [b.x - 6, b.y + NODE_H / 2];
        const dx = (p3[0] - p0[0]) / 2;
        p1 = [p0[0] + dx, p0[1]];
        p2 = [p3[0] - dx, p3[1]];
      } else if (b.layer === a.layer) {
        const dir = b.y > a.y ? 1 : -1;
        p0 = [a.x + NODE_W, a.y + NODE_H / 2 + dir * 12];
        p3 = [b.x + NODE_W + 6, b.y + NODE_H / 2 - dir * 12];
        const bulge = 70 + Math.abs(b.y - a.y) * 0.15;
        p1 = [p0[0] + bulge, p0[1]];
        p2 = [p3[0] + bulge, p3[1]];
      } else {
        p0 = [a.x + NODE_W / 2, a.y + NODE_H];
        p3 = [b.x + NODE_W / 2, b.y + NODE_H + 6];
        const dip = 60 + (a.layer - b.layer) * 14;
        extraBottom = Math.max(extraBottom, dip);
        p1 = [p0[0], Math.max(p0[1], p3[1]) + dip];
        p2 = [p3[0], Math.max(p0[1], p3[1]) + dip];
      }
      const mid = {
        x: (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8,
        y: (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8,
      };
      return { flow: f, d: `M${p0} C${p1} ${p2} ${p3}`, mid };
    });

  const width = PAD * 2 + columns.length * NODE_W + (columns.length - 1) * GAP_X + 80;
  const height = PAD * 2 + innerH + extraBottom;
  return { nodes, edges, width, height };
}
