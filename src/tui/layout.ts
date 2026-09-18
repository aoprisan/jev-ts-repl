/** Rectangles and the constraint solver the panes are laid out with. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Constraint =
  | { kind: "length"; value: number }
  | { kind: "min"; value: number }
  | { kind: "percentage"; value: number };

export const length = (value: number): Constraint => ({ kind: "length", value });
export const min = (value: number): Constraint => ({ kind: "min", value });
export const percentage = (value: number): Constraint => ({ kind: "percentage", value });

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Split `total` columns (or rows) between constraints: fixed sizes first, then percentages, and
 * whatever is left over goes to the flexible `min` segments.
 */
export function solve(total: number, constraints: readonly Constraint[]): number[] {
  const sizes = constraints.map((c) => {
    switch (c.kind) {
      case "length":
        return Math.min(c.value, total);
      case "percentage":
        return Math.min(Math.floor((c.value * total) / 100), total);
      case "min":
        return c.value;
    }
  });
  const flexible = constraints.map((c, i) => (c.kind === "min" ? i : -1)).filter((i) => i >= 0);

  const sum = () => sizes.reduce((a, b) => a + b, 0);
  const spare = total - sum();
  if (spare > 0 && flexible.length > 0) {
    const share = Math.floor(spare / flexible.length);
    for (const i of flexible) sizes[i] = (sizes[i] ?? 0) + share;
    const last = flexible[flexible.length - 1];
    if (last !== undefined) sizes[last] = (sizes[last] ?? 0) + (spare - share * flexible.length);
  }
  // Too little room: shrink the flexible segments first, then everything else, never below zero.
  let over = sum() - total;
  for (const group of [flexible, sizes.map((_, i) => i).reverse()]) {
    for (const i of group) {
      if (over <= 0) break;
      const take = Math.min(over, sizes[i] ?? 0);
      sizes[i] = (sizes[i] ?? 0) - take;
      over -= take;
    }
  }
  // Anything still unassigned goes to the last flexible segment, else the last one.
  const left = total - sum();
  if (left > 0) {
    const target = flexible[flexible.length - 1] ?? sizes.length - 1;
    if (target >= 0) sizes[target] = (sizes[target] ?? 0) + left;
  }
  return sizes;
}

export function vertical(area: Rect, constraints: readonly Constraint[]): Rect[] {
  const sizes = solve(area.height, constraints);
  const out: Rect[] = [];
  let y = area.y;
  for (const height of sizes) {
    out.push({ x: area.x, y, width: area.width, height });
    y += height;
  }
  return out;
}

export function horizontal(area: Rect, constraints: readonly Constraint[]): Rect[] {
  const sizes = solve(area.width, constraints);
  const out: Rect[] = [];
  let x = area.x;
  for (const width of sizes) {
    out.push({ x, y: area.y, width, height: area.height });
    x += width;
  }
  return out;
}

/** A centred rectangle covering `percentX` x `percentY` of `area`. */
export function centered(area: Rect, percentX: number, percentY: number): Rect {
  const [, middle] = vertical(area, [
    percentage(Math.floor((100 - percentY) / 2)),
    percentage(percentY),
    percentage(Math.floor((100 - percentY) / 2)),
  ]);
  const [, center] = horizontal(middle ?? area, [
    percentage(Math.floor((100 - percentX) / 2)),
    percentage(percentX),
    percentage(Math.floor((100 - percentX) / 2)),
  ]);
  return center ?? area;
}
