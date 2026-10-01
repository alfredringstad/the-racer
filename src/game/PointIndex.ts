/** Points bucketed in a grid for cheap "what's in this rectangle" queries. */
export class PointIndex<T extends { x: number; y: number }> {
  private readonly buckets = new Map<string, T[]>();

  constructor(
    readonly items: T[],
    private readonly cell = 128,
  ) {
    for (const it of items) {
      const key = `${Math.floor(it.x / cell)},${Math.floor(it.y / cell)}`;
      let list = this.buckets.get(key);
      if (!list) this.buckets.set(key, (list = []));
      list.push(it);
    }
  }

  query(x0: number, y0: number, x1: number, y1: number): T[] {
    const out: T[] = [];
    for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++)
      for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++)
        for (const it of this.buckets.get(`${cx},${cy}`) ?? []) if (it.x >= x0 && it.x < x1 && it.y >= y0 && it.y < y1) out.push(it);
    return out;
  }
}
