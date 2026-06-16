// Recherche de chemin A* sur grille (8 directions) + ligne de vue.
import { prof } from './profiler';

export interface NavGrid {
  w: number;
  h: number;
  pass: Uint8Array;      // 1 = praticable
  cost: Float32Array;    // coût du terrain (>= 1)
  fireBlock: Uint8Array; // 1 = bloque les tirs directs (rochers, bâtiments)
}

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Tas binaire min sur f.
class Heap {
  items: number[] = [];
  prio: number[] = [];
  size = 0;
  push(item: number, p: number) {
    let i = this.size++;
    this.items[i] = item; this.prio[i] = p;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.prio[par] <= this.prio[i]) break;
      this.swap(i, par); i = par;
    }
  }
  pop(): number {
    const top = this.items[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.prio[0] = this.prio[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.prio[l] < this.prio[m]) m = l;
        if (r < this.size && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  swap(a: number, b: number) {
    const ti = this.items[a]; this.items[a] = this.items[b]; this.items[b] = ti;
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
  }
}

// Buffers réutilisés entre tous les appels : sur une grande carte, allouer et
// remettre à zéro w×h flottants à chaque findPath (jusqu'à 20×/tick) était le
// principal goulot CPU/GC. On garde des tableaux persistants et un compteur de
// « génération » : une case n'est valide que si son tampon == génération
// courante, ce qui évite tout effacement O(n) par appel.
let pw = 0, ph = 0;
let sG = new Float32Array(0);      // coût g connu (valide si sStamp == gen)
let sFrom = new Int32Array(0);     // prédécesseur
let sStamp = new Int32Array(0);    // génération où la case a été découverte
let sClosed = new Int32Array(0);   // génération où la case a été fermée
let gen = 0;
const sharedHeap = new Heap();

function ensureBuffers(w: number, h: number) {
  if (w === pw && h === ph) return;
  pw = w; ph = h;
  const n = w * h;
  sG = new Float32Array(n);
  sFrom = new Int32Array(n);
  sStamp = new Int32Array(n);   // 0 ≠ gen initial (gen démarre à 1)
  sClosed = new Int32Array(n);
  gen = 0;
}

export function findPath(
  grid: NavGrid, sx: number, sy: number, tx: number, ty: number, maxExpand = 9000,
): { x: number; y: number }[] | null {
  const { w, h, pass, cost } = grid;
  sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
  tx = Math.max(0, Math.min(w - 1, Math.round(tx)));
  ty = Math.max(0, Math.min(h - 1, Math.round(ty)));

  // Si la cible est bloquée, chercher la tuile praticable la plus proche.
  if (!pass[ty * w + tx]) {
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= 10 && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = tx + dx, yy = ty + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !pass[yy * w + xx]) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = yy * w + xx; }
        }
    }
    if (best < 0) return null;
    tx = best % w; ty = Math.floor(best / w);
  }
  if (sx === tx && sy === ty) return [{ x: tx, y: ty }];

  ensureBuffers(w, h);
  gen++;
  if (gen >= 0x7fffffff) { sStamp.fill(0); sClosed.fill(0); gen = 1; }
  const G = sG, FROM = sFrom, STAMP = sStamp, CLOSED = sClosed, CUR_GEN = gen;
  const gOf = (i: number) => (STAMP[i] === CUR_GEN ? G[i] : Infinity);

  const startI = sy * w + sx, targetI = ty * w + tx;
  const heap = sharedHeap;
  heap.size = 0;
  G[startI] = 0; STAMP[startI] = CUR_GEN; FROM[startI] = -1;
  heap.push(startI, 0);
  let expanded = 0;
  let bestNode = startI, bestH = Math.hypot(tx - sx, ty - sy);

  while (heap.size > 0 && expanded < maxExpand) {
    const cur = heap.pop();
    if (CLOSED[cur] === CUR_GEN) continue;
    CLOSED[cur] = CUR_GEN;
    expanded++;
    if (cur === targetI) { bestNode = cur; break; }
    const cx = cur % w, cy = (cur / w) | 0;
    const hCur = Math.hypot(tx - cx, ty - cy);
    if (hCur < bestH) { bestH = hCur; bestNode = cur; }

    for (let d = 0; d < 8; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!pass[ni] || CLOSED[ni] === CUR_GEN) continue;
      // Pas de coupe de coin en diagonale.
      if (d >= 4 && (!pass[cy * w + nx] || !pass[ny * w + cx])) continue;
      const step = (d >= 4 ? 1.4142 : 1) * cost[ni];
      const ng = G[cur] + step;
      if (ng < gOf(ni)) {
        G[ni] = ng;
        STAMP[ni] = CUR_GEN;
        FROM[ni] = cur;
        heap.push(ni, ng + Math.hypot(tx - nx, ty - ny) * 1.001);
      }
    }
  }

  if (prof.enabled) { prof.count('path.calls', 1); prof.count('path.expanded', expanded); }

  // Reconstituer le chemin (vers la meilleure approche si cible inatteignable).
  const from = FROM;
  const end = CLOSED[targetI] === CUR_GEN ? targetI : bestNode;
  if (end === startI) return null;
  const path: { x: number; y: number }[] = [];
  let cur = end;
  while (cur !== -1 && cur !== startI) {
    path.push({ x: cur % w, y: (cur / w) | 0 });
    cur = from[cur];
  }
  path.reverse();

  // Lissage : supprimer les jalons intermédiaires en ligne droite dégagée.
  const smoothed: { x: number; y: number }[] = [];
  let i = 0;
  let px = sx, py = sy;
  while (i < path.length) {
    let j = Math.min(i + 8, path.length - 1);
    while (j > i && !lineClear(grid, px, py, path[j].x, path[j].y)) j--;
    smoothed.push(path[j]);
    px = path[j].x; py = path[j].y;
    i = j + 1;
  }
  return smoothed;
}

// Ligne praticable (pour lisser les chemins).
export function lineClear(grid: NavGrid, x0: number, y0: number, x1: number, y1: number): boolean {
  return traceLine(grid.w, grid.h, x0, y0, x1, y1, i => grid.pass[i] === 1);
}

// Ligne de tir : rien ne bloque les projectiles directs.
export function fireLineClear(grid: NavGrid, x0: number, y0: number, x1: number, y1: number): boolean {
  return traceLine(grid.w, grid.h, x0, y0, x1, y1, i => grid.fireBlock[i] === 0);
}

function traceLine(
  w: number, h: number, x0: number, y0: number, x1: number, y1: number,
  ok: (i: number) => boolean,
): boolean {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist * 2));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (!ok(y * w + x)) return false;
  }
  return true;
}
