// Bakery des bâtiments en ISOMÉTRIE diamant 2:1 — style militaire industriel
// moderne (béton, acier, rouille légère, marquages peints). Chaque bâtiment est
// cuit UNE FOIS par (type, couleur d'équipe) dans un canvas hors écran, en
// vraie perspective RTS : emprise en losange, deux façades visibles (gauche SW,
// droite SE), toit éclairé, ombre portée au sol vers le sud-est.
//
// Conventions locales du bake :
//  - (u,v) ∈ [0..w]×[0..h] : coordonnées d'emprise en tuiles, coin (0,0) au
//    nord (haut de l'écran), u vers la droite-bas (est), v vers la gauche-bas ;
//  - hh : hauteur en tuiles au-dessus du sol ;
//  - lx/ly : projection locale identique à celle du runtime (proj.ts), à
//    l'échelle S px par tuile — le sprite est ensuite affiché avec un facteur
//    uniforme z/S, donc les proportions sont exactes.
//
// Couleur d'équipe : JAMAIS tout le bâtiment — uniquement bandes peintes,
// drapeaux, portes, panneaux. Aucun néon, aucun arc bleu (interdits DA).
import type { BuildingTypeId } from './data';
import { BUILDINGS } from './data';
import { mulberry32 } from './map';
import { ISO_ELEV } from './proj';

export const ISO_S = 44;                    // px par tuile dans le bake
const EL = ISO_S * ISO_ELEV;                // px par tuile de hauteur
const PAD = 14;

// Hauteur hors-tout (tuiles) par type : sert au picking (enveloppe écran) et
// au dimensionnement du canvas. Silhouettes volontairement différenciées.
export const BUILDING_HEIGHTS: Record<BuildingTypeId, number> = {
  hq: 2.6, power: 1.9, power2: 2.5, refinery: 2.3, refinery2: 2.9,
  barracks: 1.15, barracks2: 2.0, factory: 1.8, factory2: 2.4,
  radar: 2.2, radarcenter: 2.1, airport: 2.0, helipad: 1.1,
  turret: 0.9, atgun: 0.9, aa: 1.0, tech: 1.7, depot: 1.35, lab: 2.2,
};

export interface OverlayAnchor {
  kind: 'smoke' | 'steam' | 'flame' | 'beacon' | 'weld';
  u: number; v: number; h: number; s: number;   // position locale + échelle
}

export interface IsoBuildingSprite {
  canvas: HTMLCanvasElement;
  ax: number;                 // point du canvas correspondant au CENTRE de
  ay: number;                 // l'emprise, au sol
  turret?: HTMLCanvasElement; // partie rotative (tourelles) — vue de dessus
  turretMount?: { u: number; v: number; h: number };
  overlays: OverlayAnchor[];
  door?: { u: number; v: number };   // ancre de la porte (lumière de sortie)
}

// ------------------------------------------------------------------ couleurs

function shade(color: string, f: number): string {
  let r = 128, g = 128, b = 128;
  if (color.startsWith('#')) {
    r = parseInt(color.slice(1, 3), 16); g = parseInt(color.slice(3, 5), 16); b = parseInt(color.slice(5, 7), 16);
  } else {
    const m = color.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
  }
  const k = (v: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${k(r)},${k(g)},${k(b)})`;
}

/** Couleur d'équipe « peinture mate » : désaturée et assombrie — un marquage
 *  militaire peint sur le bâtiment, jamais un aplat criard ni un néon. */
function paintTeam(col: string): string {
  let r = 128, g = 128, b = 128;
  if (col.startsWith('#')) {
    r = parseInt(col.slice(1, 3), 16); g = parseInt(col.slice(3, 5), 16); b = parseInt(col.slice(5, 7), 16);
  }
  const l = r * 0.299 + g * 0.587 + b * 0.114;
  const mix = (v: number) => Math.round((v * 0.58 + l * 0.42) * 0.8);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// palette industrielle commune
const CONCRETE = '#8a8d86';
const CONCRETE_D = '#6e716b';
const STEEL = '#5b635e';
const STEEL_D = '#3c423e';
const METAL_ROOF = '#4d554f';
const DARK = '#23272393';
const HAZARD = '#b8912f';
const RUST = '#6d4a2f';
const GLASS = '#2b3438';
const CANVAS_TENT = '#4a5240';

// éclairage : toit clair, mur gauche (SW) moyen, mur droit (SE) sombre
const LIT = { top: 0.12, left: -0.14, right: -0.34 };

// ---------------------------------------------------------------------- kit

class Kit {
  c: CanvasRenderingContext2D;
  X0: number; Y0: number;
  rng: () => number;
  constructor(c: CanvasRenderingContext2D, readonly w: number, readonly h: number, hmax: number, seed: number) {
    this.c = c;
    this.X0 = this.h * ISO_S + PAD;
    this.Y0 = PAD + hmax * EL;
    this.rng = mulberry32(seed);
  }
  lx(u: number, v: number): number { return (u - v) * ISO_S + this.X0; }
  ly(u: number, v: number, hh = 0): number { return (u + v) * ISO_S * 0.5 + this.Y0 - hh * EL; }

  path(pts: [number, number, number][]) {
    const c = this.c;
    c.beginPath();
    c.moveTo(this.lx(pts[0][0], pts[0][1]), this.ly(pts[0][0], pts[0][1], pts[0][2]));
    for (let i = 1; i < pts.length; i++) c.lineTo(this.lx(pts[i][0], pts[i][1]), this.ly(pts[i][0], pts[i][1], pts[i][2]));
    c.closePath();
  }
  fillP(pts: [number, number, number][], fill: string, outline = true) {
    this.path(pts);
    this.c.fillStyle = fill;
    this.c.fill();
    if (outline) { this.c.strokeStyle = 'rgba(10,12,10,0.55)'; this.c.lineWidth = 1.4; this.c.stroke(); }
  }

  /** Ombre portée au sol (lumière NO → ombre vers +x monde, bas-droite écran). */
  shadow(u0: number, v0: number, u1: number, v1: number, height: number) {
    const c = this.c;
    const d = Math.min(1.1, 0.42 + height * 0.3);
    c.save();
    c.fillStyle = 'rgba(8,10,9,0.30)';
    this.path([[u0, v0, 0], [u1, v0, 0], [u1 + d, v0, 0], [u1 + d, v1, 0], [u0 + d, v1, 0], [u0, v1, 0]]);
    c.fill();
    c.fillStyle = 'rgba(8,10,9,0.18)';
    this.path([[u0 + 0.12, v0 + 0.12, 0], [u1 + d * 1.5, v0 + 0.2, 0], [u1 + d * 1.5, v1, 0], [u0 + 0.2, v1, 0]]);
    c.fill();
    c.restore();
  }

  /** Boîte pleine : deux murs visibles + toit. */
  box(u0: number, v0: number, u1: number, v1: number, h0: number, h1: number, base: string, opts?: { roof?: string; noOutline?: boolean; roofBorder?: boolean }) {
    const c = this.c;
    // mur gauche (SW) : arête sud (v = v1)
    const gl = c.createLinearGradient(0, this.ly(u0, v1, h1), 0, this.ly(u0, v1, h0));
    gl.addColorStop(0, shade(base, LIT.left + 0.06));
    gl.addColorStop(1, shade(base, LIT.left - 0.14));
    this.fillP([[u0, v1, h1], [u1, v1, h1], [u1, v1, h0], [u0, v1, h0]], 'transparent', false);
    c.fillStyle = gl; c.fill();
    if (!opts?.noOutline) { c.strokeStyle = 'rgba(10,12,10,0.55)'; c.lineWidth = 1.4; c.stroke(); }
    // mur droit (SE) : arête est (u = u1)
    const gr = c.createLinearGradient(0, this.ly(u1, v0, h1), 0, this.ly(u1, v0, h0));
    gr.addColorStop(0, shade(base, LIT.right + 0.05));
    gr.addColorStop(1, shade(base, LIT.right - 0.12));
    this.fillP([[u1, v0, h1], [u1, v1, h1], [u1, v1, h0], [u1, v0, h0]], 'transparent', false);
    c.fillStyle = gr; c.fill();
    if (!opts?.noOutline) { c.stroke(); }
    // MATIÈRE des murs : coulures verticales discrètes (pluie, poussière) +
    // occlusion en pied de mur — les grandes faces ne sont plus des aplats.
    const wallStreaks = (pts: [number, number, number][]) => {
      if (h1 - h0 < 0.3) return;
      c.save();
      this.path(pts); c.clip();
      const xA = this.lx(pts[0][0], pts[0][1]), xB = this.lx(pts[1][0], pts[1][1]);
      const yTopA = this.ly(pts[0][0], pts[0][1], h1), yTopB = this.ly(pts[1][0], pts[1][1], h1);
      const wallHpx = (h1 - h0) * EL;
      const nS = Math.max(2, Math.round(Math.abs(xB - xA) / 15));
      for (let i = 0; i < nS; i++) {
        const t = 0.08 + this.rng() * 0.84;
        const x = xA + (xB - xA) * t;
        const yT = yTopA + (yTopB - yTopA) * t;
        const len = wallHpx * (0.25 + this.rng() * 0.55);
        const g = c.createLinearGradient(0, yT, 0, yT + len);
        g.addColorStop(0, `rgba(18,20,16,${0.10 + this.rng() * 0.09})`);
        g.addColorStop(1, 'rgba(18,20,16,0)');
        c.fillStyle = g;
        c.fillRect(x - 0.8, yT, 1.5 + this.rng() * 1.4, len);
      }
      const yBot = Math.max(this.ly(pts[0][0], pts[0][1], h0), this.ly(pts[1][0], pts[1][1], h0));
      const gAO = c.createLinearGradient(0, yBot - wallHpx * 0.24, 0, yBot);
      gAO.addColorStop(0, 'rgba(10,12,10,0)');
      gAO.addColorStop(1, 'rgba(10,12,10,0.20)');
      c.fillStyle = gAO;
      c.fillRect(Math.min(xA, xB) - 2, yBot - wallHpx * 0.26, Math.abs(xB - xA) + 4, wallHpx * 0.3);
      c.restore();
    };
    wallStreaks([[u0, v1, h1], [u1, v1, h1], [u1, v1, h0], [u0, v1, h0]]);
    wallStreaks([[u1, v0, h1], [u1, v1, h1], [u1, v1, h0], [u1, v0, h0]]);
    // toit
    const roofCol = opts?.roof ?? shade(base, LIT.top);
    const gt = c.createLinearGradient(this.lx(u0, v1), this.ly(u0, v1, h1), this.lx(u1, v0), this.ly(u1, v0, h1));
    gt.addColorStop(0, shade(roofCol, 0.10));
    gt.addColorStop(1, shade(roofCol, -0.12));
    this.fillP([[u0, v0, h1], [u1, v0, h1], [u1, v1, h1], [u0, v1, h1]], 'transparent', false);
    c.fillStyle = gt; c.fill();
    c.strokeStyle = 'rgba(10,12,10,0.55)'; c.lineWidth = 1.4; c.stroke();
    // MATIÈRE du toit : mouchetis d'usure clair/sombre discret
    {
      c.save();
      this.path([[u0, v0, h1], [u1, v0, h1], [u1, v1, h1], [u0, v1, h1]]); c.clip();
      const nD = Math.max(3, Math.round((u1 - u0) * (v1 - v0) * 7));
      for (let i = 0; i < nD; i++) {
        const uu = u0 + this.rng() * (u1 - u0), vv = v0 + this.rng() * (v1 - v0);
        c.fillStyle = this.rng() < 0.6
          ? `rgba(14,16,12,${0.05 + this.rng() * 0.07})`
          : `rgba(240,238,225,${0.04 + this.rng() * 0.05})`;
        c.beginPath();
        c.ellipse(this.lx(uu, vv), this.ly(uu, vv, h1), 1.5 + this.rng() * 5, 1 + this.rng() * 2.6, this.rng() * 3, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
    if (opts?.roofBorder) {
      c.strokeStyle = 'rgba(255,250,235,0.16)'; c.lineWidth = 1;
      this.path([[u0 + 0.06, v0 + 0.06, h1], [u1 - 0.06, v0 + 0.06, h1], [u1 - 0.06, v1 - 0.06, h1], [u0 + 0.06, v1 - 0.06, h1]]);
      c.stroke();
    }
  }

  /** Hangar à toit à deux pentes, faîte le long de l'axe u (par défaut) ou v. */
  gable(u0: number, v0: number, u1: number, v1: number, hWall: number, hRidge: number, base: string, roof: string, axis: 'u' | 'v' = 'u') {
    const c = this.c;
    if (axis === 'v') {
      // symétrie : échange u/v en réutilisant le même code via une lambda
      const vm = (v0 + v1) / 2;
      this.box(u0, v0, u1, v1, 0, hWall, base);
      // pente éclairée (côté nord-est du faîte)
      this.fillP([[u0, v0, hWall], [u1, v0, hWall], [u1, vm, hRidge], [u0, vm, hRidge]], shade(roof, 0.14));
      this.fillP([[u0, vm, hRidge], [u1, vm, hRidge], [u1, v1, hWall], [u0, v1, hWall]], shade(roof, -0.1));
      // pignon visible (mur droit u1)
      this.fillP([[u1, v0, hWall], [u1, vm, hRidge], [u1, v1, hWall]], shade(base, LIT.right));
      c.strokeStyle = 'rgba(240,240,230,0.14)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(this.lx(u0, vm), this.ly(u0, vm, hRidge)); c.lineTo(this.lx(u1, vm), this.ly(u1, vm, hRidge)); c.stroke();
      return;
    }
    const um = (u0 + u1) / 2;
    this.box(u0, v0, u1, v1, 0, hWall, base);
    this.fillP([[u0, v0, hWall], [um, v0, hRidge], [um, v1, hRidge], [u0, v1, hWall]], shade(roof, 0.14));
    this.fillP([[um, v0, hRidge], [u1, v0, hWall], [u1, v1, hWall], [um, v1, hRidge]], shade(roof, -0.1));
    // pignon visible (mur gauche v1)
    this.fillP([[u0, v1, hWall], [um, v1, hRidge], [u1, v1, hWall]], shade(base, LIT.left - 0.04));
    c.strokeStyle = 'rgba(240,240,230,0.14)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(this.lx(um, v0), this.ly(um, v0, hRidge)); c.lineTo(this.lx(um, v1), this.ly(um, v1, hRidge)); c.stroke();
    // nervures de tôle sur les pentes
    c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = 1;
    const n = Math.max(3, Math.round((u1 - u0) * 3));
    for (let i = 1; i < n; i++) {
      const uu = u0 + ((u1 - u0) * i) / n;
      const hh2 = uu < um ? hWall + (hRidge - hWall) * ((uu - u0) / (um - u0)) : hWall + (hRidge - hWall) * ((u1 - uu) / (u1 - um));
      c.beginPath();
      c.moveTo(this.lx(uu, v0), this.ly(uu, v0, hh2));
      c.lineTo(this.lx(uu, v1), this.ly(uu, v1, hh2));
      c.stroke();
    }
  }

  /** Cylindre vertical (silo, cheminée, tour). */
  cyl(u: number, v: number, r: number, h0: number, h1: number, base: string, opts?: { openTop?: boolean; band?: string; bandAt?: number }) {
    const c = this.c;
    const cx = this.lx(u, v);
    const rx = r * ISO_S * 1.414, ry = r * ISO_S * 0.707;
    const yT = this.ly(u, v, h1), yB = this.ly(u, v, h0);
    // fût
    const g = c.createLinearGradient(cx - rx, 0, cx + rx, 0);
    g.addColorStop(0, shade(base, -0.05));
    g.addColorStop(0.32, shade(base, 0.16));
    g.addColorStop(0.62, shade(base, -0.12));
    g.addColorStop(1, shade(base, -0.4));
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - rx, yT);
    c.lineTo(cx - rx, yB);
    c.ellipse(cx, yB, rx, ry, 0, Math.PI, 0, true);
    c.lineTo(cx + rx, yT);
    c.ellipse(cx, yT, rx, ry, 0, 0, Math.PI, false);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(10,12,10,0.5)'; c.lineWidth = 1.3; c.stroke();
    // dessus
    c.fillStyle = opts?.openTop ? '#14171a' : shade(base, 0.16);
    c.beginPath(); c.ellipse(cx, yT, rx, ry, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(10,12,10,0.5)'; c.stroke();
    if (!opts?.openTop) {
      c.fillStyle = 'rgba(255,252,240,0.10)';
      c.beginPath(); c.ellipse(cx - rx * 0.25, yT - ry * 0.2, rx * 0.5, ry * 0.42, 0, 0, Math.PI * 2); c.fill();
    }
    if (opts?.band) {
      const yBand = yT + (yB - yT) * (opts.bandAt ?? 0.25);
      c.fillStyle = opts.band;
      c.fillRect(cx - rx, yBand, rx * 2, Math.max(2, (yB - yT) * 0.07));
    }
  }

  /** Tour de refroidissement (taille pincée). */
  coolTower(u: number, v: number, r: number, h: number, base: string) {
    const c = this.c;
    const cx = this.lx(u, v);
    const rx = r * ISO_S * 1.414, ry = r * ISO_S * 0.707;
    const yB = this.ly(u, v, 0), yT = this.ly(u, v, h);
    const waist = rx * 0.68, top = rx * 0.8;
    const g = c.createLinearGradient(cx - rx, 0, cx + rx, 0);
    g.addColorStop(0, shade(base, -0.02));
    g.addColorStop(0.3, shade(base, 0.2));
    g.addColorStop(0.68, shade(base, -0.1));
    g.addColorStop(1, shade(base, -0.38));
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(cx - rx, yB);
    c.bezierCurveTo(cx - waist, yB - (yB - yT) * 0.45, cx - waist, yB - (yB - yT) * 0.72, cx - top, yT);
    c.ellipse(cx, yT, top, top * 0.4, 0, Math.PI, 0, false);
    c.bezierCurveTo(cx + waist, yB - (yB - yT) * 0.72, cx + waist, yB - (yB - yT) * 0.45, cx + rx, yB);
    c.ellipse(cx, yB, rx, ry, 0, 0, Math.PI, false);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(10,12,10,0.5)'; c.lineWidth = 1.3; c.stroke();
    // gueule sombre
    c.fillStyle = '#181c1e';
    c.beginPath(); c.ellipse(cx, yT, top, top * 0.4, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(230,235,238,0.14)';
    c.beginPath(); c.ellipse(cx, yT, top * 0.78, top * 0.28, 0, 0, Math.PI * 2); c.fill();
  }

  /** Citerne horizontale (carburant) le long de u. */
  tankH(u0: number, u1: number, v: number, r: number, hBase: number, base: string) {
    const c = this.c;
    const x0 = this.lx(u0, v), x1 = this.lx(u1, v);
    const yc = this.ly((u0 + u1) / 2, v, hBase + r);
    const ry = r * EL;
    const g = c.createLinearGradient(0, yc - ry, 0, yc + ry);
    g.addColorStop(0, shade(base, 0.22));
    g.addColorStop(0.5, shade(base, -0.04));
    g.addColorStop(1, shade(base, -0.4));
    c.fillStyle = g;
    c.beginPath();
    // capsule inclinée le long de l'axe iso
    const y0 = this.ly(u0, v, hBase + r), y1 = this.ly(u1, v, hBase + r);
    c.ellipse(x0, y0, ry * 0.62, ry, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
    c.lineTo(x1, y1 - ry);
    c.ellipse(x1, y1, ry * 0.62, ry, 0, (3 * Math.PI) / 2, Math.PI / 2, false);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(10,12,10,0.5)'; c.lineWidth = 1.3; c.stroke();
    // berceaux
    c.fillStyle = STEEL_D;
    for (const uu of [u0 + 0.12, u1 - 0.12]) {
      const xx = this.lx(uu, v), yy = this.ly(uu, v, hBase);
      c.fillRect(xx - 3, yy - ry * 0.5, 6, ry * 0.7);
    }
  }

  /** Porte (quai) sur le mur gauche (SW, arête v=v1) ou droit (SE, u=u1). */
  door(side: 'left' | 'right', a0: number, a1: number, fixed: number, h: number, team: string, open = 0.12) {
    const c = this.c;
    const pts: [number, number, number][] = side === 'left'
      ? [[a0, fixed, h], [a1, fixed, h], [a1, fixed, 0], [a0, fixed, 0]]
      : [[fixed, a0, h], [fixed, a1, h], [fixed, a1, 0], [fixed, a0, 0]];
    this.fillP(pts, '#191d1b');
    // panneau légèrement entrouvert (bande claire en bas)
    const ptsGlow: [number, number, number][] = side === 'left'
      ? [[a0 + 0.03, fixed, open], [a1 - 0.03, fixed, open], [a1 - 0.03, fixed, 0], [a0 + 0.03, fixed, 0]]
      : [[fixed, a0 + 0.03, open], [fixed, a1 - 0.03, open], [fixed, a1 - 0.03, 0], [fixed, a0 + 0.03, 0]];
    this.fillP(ptsGlow, 'rgba(228,200,130,0.28)', false);
    // linteau + chevrons de danger
    const ptsL: [number, number, number][] = side === 'left'
      ? [[a0, fixed, h + 0.06], [a1, fixed, h + 0.06], [a1, fixed, h], [a0, fixed, h]]
      : [[fixed, a0, h + 0.06], [fixed, a1, h + 0.06], [fixed, a1, h], [fixed, a0, h]];
    this.fillP(ptsL, HAZARD, false);
    // trim couleur d'équipe (montants)
    for (const aa of [a0, a1]) {
      const p: [number, number, number][] = side === 'left'
        ? [[aa - 0.025, fixed, h], [aa + 0.025, fixed, h], [aa + 0.025, fixed, 0], [aa - 0.025, fixed, 0]]
        : [[fixed, aa - 0.025, h], [fixed, aa + 0.025, h], [fixed, aa + 0.025, 0], [fixed, aa - 0.025, 0]];
      this.fillP(p, paintTeam(team), false);
    }
    c.fillStyle = 'rgba(0,0,0,0.28)';
  }

  /** Fenêtres-fentes sur un mur. */
  windows(side: 'left' | 'right', a0: number, a1: number, fixed: number, h: number, n: number) {
    const c = this.c;
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * (i + 0.25)) / n;
      const t1 = a0 + ((a1 - a0) * (i + 0.7)) / n;
      const pts: [number, number, number][] = side === 'left'
        ? [[t0, fixed, h + 0.1], [t1, fixed, h + 0.1], [t1, fixed, h], [t0, fixed, h]]
        : [[fixed, t0, h + 0.1], [fixed, t1, h + 0.1], [fixed, t1, h], [fixed, t0, h]];
      this.fillP(pts, GLASS, false);
      c.fillStyle = 'rgba(235,240,235,0.18)';
      const p0 = pts[0], p1 = pts[1];
      c.fillRect(this.lx(p0[0], p0[1]), this.ly(p0[0], p0[1], p0[2]), Math.max(1.5, (this.lx(p1[0], p1[1]) - this.lx(p0[0], p0[1])) * 0.5), 1.5);
    }
  }

  /** Bande peinte couleur d'équipe sur un mur : peinture MATE désaturée,
   *  fine, avec arête basse sombre — identification discrète, pas de néon. */
  teamBand(side: 'left' | 'right', a0: number, a1: number, fixed: number, h: number, team: string) {
    const col = paintTeam(team);
    const pts: [number, number, number][] = side === 'left'
      ? [[a0, fixed, h + 0.055], [a1, fixed, h + 0.055], [a1, fixed, h], [a0, fixed, h]]
      : [[fixed, a0, h + 0.055], [fixed, a1, h + 0.055], [fixed, a1, h], [fixed, a0, h]];
    this.fillP(pts, col, false);
    // usure : la peinture est écaillée par endroits (entaille du fond)
    const c = this.c;
    c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = 1;
    const p0 = side === 'left' ? this.lx(a0, fixed) : this.lx(fixed, a0);
    const p1 = side === 'left' ? this.lx(a1, fixed) : this.lx(fixed, a1);
    const y0 = side === 'left' ? this.ly(a0, fixed, h) : this.ly(fixed, a0, h);
    const y1 = side === 'left' ? this.ly(a1, fixed, h) : this.ly(fixed, a1, h);
    c.beginPath(); c.moveTo(p0, y0); c.lineTo(p1, y1); c.stroke();
    for (let i = 0; i < 3; i++) {
      const t = 0.15 + this.rng() * 0.7;
      c.fillStyle = 'rgba(30,32,28,0.3)';
      c.fillRect(p0 + (p1 - p0) * t, y0 + (y1 - y0) * t - 2 - this.rng() * 2, 1.4 + this.rng() * 1.6, 1.4);
    }
  }

  /** Mât en treillis + optionnel drapeau d'équipe. */
  mast(u: number, v: number, h0: number, h1: number, flagCol?: string) {
    const c = this.c;
    const x = this.lx(u, v);
    const yB = this.ly(u, v, h0), yT = this.ly(u, v, h1);
    c.strokeStyle = STEEL_D; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x - 3, yB); c.lineTo(x - 1, yT); c.stroke();
    c.beginPath(); c.moveTo(x + 3, yB); c.lineTo(x + 1, yT); c.stroke();
    c.lineWidth = 1; c.strokeStyle = shade(STEEL_D, 0.15);
    const n = Math.max(3, Math.round((yB - yT) / 7));
    for (let i = 0; i < n; i++) {
      const yy = yB + ((yT - yB) * i) / n;
      const k = 3 - (2 * i) / n;
      c.beginPath(); c.moveTo(x - k, yy); c.lineTo(x + k, yy - 4); c.stroke();
    }
    if (flagCol) {
      c.fillStyle = paintTeam(flagCol);
      c.beginPath();
      c.moveTo(x + 1, yT);
      c.quadraticCurveTo(x + 9, yT + 1.5, x + 15, yT - 1);
      c.lineTo(x + 14, yT + 5.5);
      c.quadraticCurveTo(x + 8, yT + 7, x + 1, yT + 6);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1; c.stroke();
    }
  }

  /** Antenne fouet. */
  whip(u: number, v: number, h0: number, len: number) {
    const c = this.c;
    const x = this.lx(u, v), y = this.ly(u, v, h0);
    c.strokeStyle = 'rgba(200,205,200,0.8)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + 2, y - len * EL); c.stroke();
  }

  /** Parabole orientée vers le haut-droite (statique). */
  dish(u: number, v: number, h: number, r: number, base: string) {
    const c = this.c;
    const x = this.lx(u, v), y = this.ly(u, v, h);
    const R = r * ISO_S;
    c.save();
    c.translate(x, y);
    c.rotate(-0.5);
    const g = c.createLinearGradient(-R, 0, R, 0);
    g.addColorStop(0, shade(base, -0.28));
    g.addColorStop(0.55, shade(base, 0.22));
    g.addColorStop(1, shade(base, -0.05));
    c.fillStyle = g;
    c.beginPath(); c.ellipse(0, 0, R, R * 0.55, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(10,12,10,0.55)'; c.lineWidth = 1.3; c.stroke();
    c.fillStyle = shade(base, -0.35);
    c.beginPath(); c.ellipse(0, 0, R * 0.55, R * 0.3, 0, 0, Math.PI * 2); c.fill();
    // bras de focale
    c.strokeStyle = STEEL_D; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(R * 0.75, -R * 0.5); c.stroke();
    c.fillStyle = '#c9cfc9';
    c.beginPath(); c.arc(R * 0.75, -R * 0.5, 2.2, 0, Math.PI * 2); c.fill();
    c.restore();
    // pied
    c.strokeStyle = STEEL_D; c.lineWidth = 2.4;
    c.beginPath(); c.moveTo(x, this.ly(u, v, h - 0.3)); c.lineTo(x, y); c.stroke();
  }

  /** Dalle de FONDATION commune à tous les bâtiments : béton clair usé,
   *  plinthe sombre en périphérie, taches et fissures — l'assise partagée
   *  qui unifie visuellement toute la base. */
  slab(u0: number, v0: number, u1: number, v1: number) {
    const c = this.c;
    // plinthe sombre (assoit la dalle dans le sol)
    this.fillP([[u0, v0, 0], [u1, v0, 0], [u1, v1, 0], [u0, v1, 0]], 'rgba(40,42,38,0.4)', false);
    // dalle claire
    const m = 0.07;
    this.fillP([[u0 + m, v0 + m, 0], [u1 - m, v0 + m, 0], [u1 - m, v1 - m, 0], [u0 + m, v1 - m, 0]], 'rgba(158,155,142,0.72)', false);
    // joints de coulée
    c.strokeStyle = 'rgba(0,0,0,0.14)'; c.lineWidth = 1;
    const n = Math.max(1, Math.round(u1 - u0) - 1);
    for (let i = 1; i <= n; i++) {
      const uu = u0 + ((u1 - u0) * i) / (n + 1);
      c.beginPath();
      c.moveTo(this.lx(uu, v0 + m), this.ly(uu, v0 + m));
      c.lineTo(this.lx(uu, v1 - m), this.ly(uu, v1 - m));
      c.stroke();
    }
    // taches d'huile + fissures
    for (let i = 0; i < 3; i++) {
      const su = u0 + 0.2 + this.rng() * (u1 - u0 - 0.4), sv = v0 + 0.2 + this.rng() * (v1 - v0 - 0.4);
      c.fillStyle = `rgba(24,24,20,${0.1 + this.rng() * 0.12})`;
      c.beginPath();
      c.ellipse(this.lx(su, sv), this.ly(su, sv), 3 + this.rng() * 6, 2 + this.rng() * 3, this.rng() * 3, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const su = u0 + this.rng() * (u1 - u0), sv = v0 + this.rng() * (v1 - v0);
      c.beginPath();
      c.moveTo(this.lx(su, sv), this.ly(su, sv));
      c.lineTo(this.lx(su + 0.2 + this.rng() * 0.3, sv + this.rng() * 0.2), this.ly(su + 0.3, sv + 0.15));
      c.stroke();
    }
  }

  /** Dalle au sol (tarmac, parade, quai) avec bordure. */
  pad(u0: number, v0: number, u1: number, v1: number, col: string, border = 'rgba(220,220,210,0.28)') {
    this.fillP([[u0, v0, 0], [u1, v0, 0], [u1, v1, 0], [u0, v1, 0]], col, false);
    const c = this.c;
    c.strokeStyle = border; c.lineWidth = 1.4;
    this.path([[u0 + 0.05, v0 + 0.05, 0], [u1 - 0.05, v0 + 0.05, 0], [u1 - 0.05, v1 - 0.05, 0], [u0 + 0.05, v1 - 0.05, 0]]);
    c.stroke();
    // fissures/tâches
    c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const su = u0 + this.rng() * (u1 - u0), sv = v0 + this.rng() * (v1 - v0);
      c.beginPath();
      c.moveTo(this.lx(su, sv), this.ly(su, sv));
      c.lineTo(this.lx(su + 0.2 + this.rng() * 0.3, sv + this.rng() * 0.2), this.ly(su + 0.3, sv + 0.15));
      c.stroke();
    }
  }

  /** Ligne peinte au sol entre deux points monde locaux. */
  paint(u0: number, v0: number, u1: number, v1: number, col: string, lw = 2) {
    const c = this.c;
    c.strokeStyle = col; c.lineWidth = lw;
    c.beginPath();
    c.moveTo(this.lx(u0, v0), this.ly(u0, v0));
    c.lineTo(this.lx(u1, v1), this.ly(u1, v1));
    c.stroke();
  }

  /** Conteneurs / caisses empilés. */
  crates(u: number, v: number, n: number, team: string) {
    for (let i = 0; i < n; i++) {
      const du = (this.rng() - 0.5) * 0.5, dv = (this.rng() - 0.5) * 0.5;
      const s = 0.16 + this.rng() * 0.14;
      const col = this.rng() < 0.3 ? shade(paintTeam(team), -0.12) : this.rng() < 0.6 ? RUST : STEEL;
      this.box(u + du - s, v + dv - s, u + du + s, v + dv + s, 0, s * (1.2 + this.rng()), col, { noOutline: false });
    }
  }

  /** Tuyauterie surélevée entre deux points. */
  pipe(u0: number, v0: number, h0: number, u1: number, v1: number, h1: number, col = '#707a72') {
    const c = this.c;
    c.strokeStyle = shade(col, -0.3); c.lineWidth = 4.4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(this.lx(u0, v0), this.ly(u0, v0, h0)); c.lineTo(this.lx(u1, v1), this.ly(u1, v1, h1)); c.stroke();
    c.strokeStyle = shade(col, 0.12); c.lineWidth = 2;
    c.beginPath(); c.moveTo(this.lx(u0, v0), this.ly(u0, v0, h0) - 1); c.lineTo(this.lx(u1, v1), this.ly(u1, v1, h1) - 1); c.stroke();
    c.lineCap = 'butt';
  }

  /** Unités de toit (clim, extracteurs, trappes). */
  roofKit(u0: number, v0: number, u1: number, v1: number, h: number, n: number) {
    for (let i = 0; i < n; i++) {
      const uu = u0 + 0.15 + this.rng() * (u1 - u0 - 0.3);
      const vv = v0 + 0.15 + this.rng() * (v1 - v0 - 0.3);
      const s = 0.08 + this.rng() * 0.1;
      if (this.rng() < 0.6) this.box(uu - s, vv - s, uu + s, vv + s, h, h + s * 1.6, STEEL, { noOutline: true });
      else {
        const c = this.c;
        c.fillStyle = shade(METAL_ROOF, -0.25);
        c.beginPath(); c.ellipse(this.lx(uu, vv), this.ly(uu, vv, h), s * ISO_S, s * ISO_S * 0.5, 0, 0, Math.PI * 2); c.fill();
      }
    }
  }

  /** Salissures/rouille sur les murs (vieillissement). */
  grime(alpha = 0.1) {
    const c = this.c;
    c.save();
    c.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 8; i++) {
      const x = this.rng() * c.canvas.width, y = c.canvas.height * (0.4 + this.rng() * 0.5);
      const g = c.createRadialGradient(x, y, 0, x, y, 14 + this.rng() * 26);
      g.addColorStop(0, `rgba(40,30,18,${alpha * (0.5 + this.rng() * 0.8)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    }
    // lumière zénithale globale : haut du sprite légèrement plus clair
    const gl = c.createLinearGradient(0, 0, 0, c.canvas.height);
    gl.addColorStop(0, 'rgba(255,248,230,0.06)');
    gl.addColorStop(0.55, 'rgba(0,0,0,0)');
    gl.addColorStop(1, 'rgba(0,0,0,0.14)');
    c.fillStyle = gl;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.restore();
  }
}

// ------------------------------------------------------- tourelles (défenses)

function bakeTurretTop(kind: 'mg' | 'at' | 'aa', team: string): HTMLCanvasElement {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S * 2; cv.height = S * 2;
  const c = cv.getContext('2d')!;
  c.translate(S, S);
  // le canon pointe vers +x (angle 0)
  const body = (r: number, col: string) => {
    const g = c.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
    g.addColorStop(0, shade(col, 0.18));
    g.addColorStop(1, shade(col, -0.3));
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(8,10,8,0.6)'; c.lineWidth = 2; c.stroke();
  };
  const gun = (len: number, w: number) => {
    c.fillStyle = '#3a423c';
    c.fillRect(0, -w / 2, len, w);
    c.fillStyle = '#20261f';
    c.fillRect(len - 7, -w / 2 - 1.5, 7, w + 3);
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(2, -w / 2, len - 10, 1.8);
  };
  if (kind === 'mg') {
    body(15, STEEL);
    c.fillStyle = paintTeam(team); c.fillRect(-13, -2.4, 8, 4.8);
    gun(26, 4.5);
    gun(26, 4.5); c.save(); c.translate(0, 5); gun(24, 3.2); c.restore();
    c.save(); c.translate(0, -5); gun(24, 3.2); c.restore();
  } else if (kind === 'at') {
    body(17, '#565e56');
    c.fillStyle = paintTeam(team); c.fillRect(-15, -3, 9, 6);
    gun(40, 6);
    c.fillStyle = '#20261f'; c.fillRect(16, -4.4, 6, 8.8);
  } else {
    body(15, '#4c5450');
    c.fillStyle = paintTeam(team); c.fillRect(-13, -2.6, 8, 5.2);
    for (const dy of [-5.4, -1.8, 1.8, 5.4]) {
      c.save(); c.translate(0, dy); gun(30, 2.6); c.restore();
    }
  }
  return cv;
}

// --------------------------------------------------------------- assemblage

export function bakeIsoBuilding(type: BuildingTypeId, team: string): IsoBuildingSprite {
  const def = BUILDINGS[type];
  const w = def.w, h = def.h;
  const hmax = BUILDING_HEIGHTS[type] + 0.9;   // marge (antennes, drapeaux)
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((w + h) * ISO_S + PAD * 2);
  cv.height = Math.ceil(((w + h) * ISO_S) / 2 + hmax * EL + PAD * 2);
  const c = cv.getContext('2d')!;
  const K = new Kit(c, w, h, hmax, type.length * 131 + type.charCodeAt(0) * 17);
  const overlays: OverlayAnchor[] = [];
  let turret: HTMLCanvasElement | undefined;
  let turretMount: { u: number; v: number; h: number } | undefined;
  let door: { u: number; v: number } | undefined;

  switch (type) {
    case 'hq': {
      K.slab(0, 0, 3, 3);
      K.shadow(0.15, 0.15, 2.85, 2.85, 1.6);
      // bloc principal deux niveaux + aile
      K.box(0.15, 0.15, 2.4, 2.4, 0, 1.05, CONCRETE, { roofBorder: true });
      K.box(0.45, 0.45, 2.0, 2.0, 1.05, 1.75, shade(CONCRETE, -0.06), { roofBorder: true });
      K.windows('left', 0.35, 2.25, 2.4, 0.55, 4);
      K.windows('right', 0.35, 2.25, 2.4, 0.55, 4);
      K.teamBand('left', 0.15, 2.4, 2.4, 0.92, team);
      K.teamBand('right', 0.15, 2.4, 2.4, 0.92, team);
      // aile d'entrée + porte
      K.box(1.0, 2.4, 2.1, 2.95, 0, 0.55, CONCRETE_D);
      K.door('left', 1.25, 1.85, 2.95, 0.42, team);
      door = { u: 1.55, v: 2.95 };
      // tour de commandement + verrière
      K.box(2.05, 0.2, 2.85, 1.0, 0, 1.9, shade(STEEL, -0.04), { roofBorder: true });
      K.fillP([[2.12, 0.95, 1.62], [2.8, 0.95, 1.62], [2.8, 0.95, 1.34], [2.12, 0.95, 1.34]], GLASS, false);
      // mât de comm + parabole + drapeau
      K.mast(2.45, 0.6, 1.9, 2.9);
      overlays.push({ kind: 'beacon', u: 2.45, v: 0.6, h: 2.9, s: 1 });
      K.dish(0.75, 0.75, 1.95, 0.34, '#9aa39a');
      K.mast(0.4, 2.5, 0.55, 1.7, team);
      K.roofKit(0.5, 0.5, 2.0, 2.0, 1.75, 3);
      K.whip(1.9, 0.5, 1.9, 0.7);
      break;
    }
    case 'power': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.1, 0.15, 1.9, 1.85, 1.2);
      // hall turbine
      K.gable(0.1, 0.95, 1.9, 1.85, 0.62, 0.95, CONCRETE_D, METAL_ROOF, 'u');
      K.windows('left', 0.3, 1.7, 1.85, 0.3, 3);
      K.teamBand('left', 0.1, 1.9, 1.85, 0.52, team);
      // deux cheminées de refroidissement
      K.coolTower(0.55, 0.45, 0.3, 1.75, '#96938a');
      K.coolTower(1.4, 0.45, 0.3, 1.55, '#96938a');
      overlays.push({ kind: 'steam', u: 0.55, v: 0.45, h: 1.75, s: 1.1 });
      overlays.push({ kind: 'steam', u: 1.4, v: 0.45, h: 1.55, s: 0.9 });
      // poste électrique : bobines + portique
      K.box(1.55, 1.0, 1.9, 1.35, 0, 0.3, STEEL_D);
      K.pipe(0.55, 0.65, 0.9, 0.55, 1.1, 0.62);
      K.pipe(1.4, 0.65, 0.8, 1.4, 1.1, 0.62);
      door = { u: 1.0, v: 1.85 };
      break;
    }
    case 'power2': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.1, 0.1, 1.9, 1.9, 1.8);
      // hall haut à sheds + rangée de 3 cheminées fines
      K.box(0.1, 0.75, 1.9, 1.9, 0, 1.0, shade(CONCRETE, -0.1), { roofBorder: true });
      K.fillP([[0.1, 0.75, 1.0], [0.55, 0.75, 1.32], [0.55, 1.9, 1.32], [0.1, 1.9, 1.0]], shade(METAL_ROOF, 0.12));
      K.fillP([[0.72, 0.75, 1.0], [1.16, 0.75, 1.32], [1.16, 1.9, 1.32], [0.72, 1.9, 1.0]], shade(METAL_ROOF, 0.12));
      K.fillP([[1.34, 0.75, 1.0], [1.78, 0.75, 1.32], [1.78, 1.9, 1.32], [1.34, 1.9, 1.0]], shade(METAL_ROOF, 0.12));
      K.teamBand('left', 0.1, 1.9, 1.9, 0.85, team);
      K.windows('left', 0.25, 1.75, 1.9, 0.4, 4);
      for (let i = 0; i < 3; i++) {
        const u = 0.42 + i * 0.62;
        K.cyl(u, 0.4, 0.15, 0, 2.4 - i * 0.12, '#8e8a80', { band: HAZARD, bandAt: 0.16 });
        overlays.push({ kind: 'smoke', u, v: 0.4, h: 2.4 - i * 0.12, s: 0.8 });
      }
      // conduites d'alimentation
      K.pipe(0.42, 0.62, 1.0, 0.42, 1.0, 1.0);
      K.pipe(1.04, 0.62, 1.0, 1.04, 1.0, 1.0);
      // évent thermique chaud (identifiable « énergie », teinte chaude, pas de néon)
      K.fillP([[1.55, 1.0, 1.02], [1.82, 1.0, 1.02], [1.82, 1.28, 1.02], [1.55, 1.28, 1.02]], 'rgba(226,120,48,0.55)', false);
      door = { u: 1.0, v: 1.9 };
      break;
    }
    case 'refinery': {
      K.slab(0, 0, 3, 3);
      K.shadow(0.1, 0.1, 2.9, 2.9, 1.5);
      // quai de déchargement du récolteur (identifiable : entonnoir + marquages)
      K.pad(1.15, 1.9, 2.85, 2.95, 'rgba(52,54,50,0.85)', 'rgba(214,178,80,0.5)');
      K.paint(1.3, 2.42, 2.7, 2.42, 'rgba(214,178,80,0.4)', 2);
      door = { u: 2.0, v: 2.9 };
      // trémie de réception au-dessus du quai
      K.fillP([[1.45, 1.9, 1.15], [2.55, 1.9, 1.15], [2.3, 2.15, 0.6], [1.7, 2.15, 0.6]], shade(RUST, 0.05));
      K.fillP([[1.45, 1.9, 1.15], [1.7, 2.15, 0.6], [1.7, 2.4, 0.6], [1.45, 2.15, 1.15]], shade(RUST, -0.2), false);
      // hall de traitement
      K.gable(0.15, 0.85, 1.6, 2.4, 0.8, 1.2, shade(CONCRETE_D, -0.02), METAL_ROOF, 'v');
      K.teamBand('right', 0.9, 2.35, 1.6, 0.66, team);
      // deux silos de stockage + passerelle
      K.cyl(2.25, 0.6, 0.42, 0, 1.5, '#8f9188');
      K.cyl(1.25, 0.42, 0.36, 0, 1.3, '#84867e');
      K.pipe(1.25, 0.42, 1.24, 2.25, 0.6, 1.42);
      K.pipe(2.25, 0.85, 0.9, 2.1, 1.9, 0.9);
      // torchère (flamme = raffinage, lecture immédiate)
      K.cyl(0.4, 0.35, 0.07, 0, 2.05, '#6f6a60');
      overlays.push({ kind: 'flame', u: 0.4, v: 0.35, h: 2.05, s: 1 });
      overlays.push({ kind: 'smoke', u: 0.4, v: 0.35, h: 2.2, s: 0.7 });
      K.crates(0.5, 2.7, 3, team);
      break;
    }
    case 'refinery2': {
      K.slab(0, 0, 3, 3);
      K.shadow(0.1, 0.1, 2.9, 2.9, 2.0);
      // quai double + trémie élargie
      K.pad(1.0, 2.0, 2.9, 2.95, 'rgba(48,50,46,0.9)', 'rgba(214,178,80,0.55)');
      K.paint(1.15, 2.5, 2.75, 2.5, 'rgba(214,178,80,0.45)', 2);
      door = { u: 1.95, v: 2.9 };
      K.fillP([[1.2, 2.0, 1.3], [2.7, 2.0, 1.3], [2.45, 2.25, 0.7], [1.45, 2.25, 0.7]], shade(RUST, 0.02));
      // batterie de 3 grands silos reliés par portique
      K.cyl(0.6, 0.7, 0.44, 0, 2.05, '#8b8d85', { band: paintTeam(team), bandAt: 0.2 });
      K.cyl(1.55, 0.55, 0.44, 0, 2.25, '#93958c', { band: paintTeam(team), bandAt: 0.18 });
      K.cyl(2.5, 0.7, 0.44, 0, 2.05, '#8b8d85', { band: paintTeam(team), bandAt: 0.2 });
      K.pipe(0.6, 0.7, 1.95, 1.55, 0.55, 2.15);
      K.pipe(1.55, 0.55, 2.15, 2.5, 0.7, 1.95);
      // hall de craquage + colonnes fines
      K.box(0.2, 1.5, 1.15, 2.35, 0, 0.9, shade(STEEL, -0.06), { roofBorder: true });
      K.cyl(0.45, 1.75, 0.12, 0.9, 1.9, '#7d786e');
      K.cyl(0.85, 1.75, 0.12, 0.9, 1.7, '#7d786e');
      K.pipe(0.45, 1.75, 1.85, 0.85, 1.75, 1.65);
      // double torchère
      K.cyl(2.72, 1.5, 0.07, 0, 2.5, '#6f6a60');
      overlays.push({ kind: 'flame', u: 2.72, v: 1.5, h: 2.5, s: 1.25 });
      overlays.push({ kind: 'smoke', u: 2.72, v: 1.5, h: 2.66, s: 0.9 });
      overlays.push({ kind: 'steam', u: 1.55, v: 0.55, h: 2.25, s: 0.7 });
      break;
    }
    case 'barracks': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.1, 0.3, 1.9, 1.75, 0.75);
      // baraquement long à toit de tôle + auvent
      K.gable(0.1, 0.3, 1.9, 1.2, 0.55, 0.85, '#5d6154', '#575b48', 'u');
      // annexe sanitaire
      K.box(1.25, 1.3, 1.9, 1.8, 0, 0.42, CANVAS_TENT);
      // terrain d'exercice : marquages peints
      K.paint(0.25, 1.55, 1.05, 1.55, 'rgba(226,226,214,0.3)', 1.6);
      K.paint(0.25, 1.75, 1.05, 1.75, 'rgba(226,226,214,0.3)', 1.6);
      // sacs de sable à l'entrée
      for (let i = 0; i < 4; i++) {
        const uu = 0.28 + i * 0.16;
        c.fillStyle = shade('#7a6f52', i % 2 ? -0.08 : 0.04);
        c.beginPath(); c.ellipse(K.lx(uu, 1.32), K.ly(uu, 1.32, 0.05), 5.5, 3.2, 0, 0, Math.PI * 2); c.fill();
      }
      K.door('left', 0.75, 1.15, 1.2, 0.4, team);
      door = { u: 0.95, v: 1.2 };
      K.mast(1.72, 0.45, 0.85, 1.75, team);
      K.windows('left', 0.25, 0.7, 1.2, 0.28, 2);
      break;
    }
    case 'barracks2': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.1, 0.1, 1.9, 1.9, 1.3);
      // bloc d'instruction béton deux étages
      K.box(0.1, 0.35, 1.55, 1.9, 0, 1.3, CONCRETE, { roofBorder: true });
      K.windows('left', 0.3, 1.4, 1.9, 0.85, 3);
      K.windows('left', 0.3, 1.4, 1.9, 0.35, 3);
      K.windows('right', 0.55, 1.7, 1.55, 0.85, 3);
      K.teamBand('left', 0.1, 1.55, 1.9, 1.16, team);
      K.door('left', 0.6, 1.05, 1.9, 0.5, team);
      door = { u: 0.82, v: 1.9 };
      // tour de guet d'angle sur pilotis
      const twU = 1.75, twV = 0.45;
      c.strokeStyle = STEEL_D; c.lineWidth = 2.6;
      for (const [du, dv] of [[-0.14, -0.1], [0.14, -0.1], [-0.14, 0.14], [0.14, 0.14]] as const) {
        c.beginPath();
        c.moveTo(K.lx(twU + du, twV + dv), K.ly(twU + du, twV + dv, 0));
        c.lineTo(K.lx(twU + du * 0.7, twV + dv * 0.7), K.ly(twU + du * 0.7, twV + dv * 0.7, 1.28));
        c.stroke();
      }
      K.box(twU - 0.24, twV - 0.2, twU + 0.24, twV + 0.24, 1.28, 1.75, '#525a50', { roof: '#454d45' });
      K.fillP([[twU - 0.24, twV + 0.24, 1.62], [twU + 0.24, twV + 0.24, 1.62], [twU + 0.24, twV + 0.24, 1.44], [twU - 0.24, twV + 0.24, 1.44]], GLASS, false);
      overlays.push({ kind: 'beacon', u: twU, v: twV, h: 1.8, s: 0.8 });
      K.roofKit(0.3, 0.55, 1.35, 1.7, 1.3, 2);
      break;
    }
    case 'factory': {
      K.slab(0, 0, 3, 3);
      K.shadow(0.05, 0.1, 2.95, 2.9, 1.3);
      // grand hangar d'assemblage, faîte vers le quai sud
      K.gable(0.3, 0.1, 2.9, 2.1, 0.95, 1.5, shade(STEEL, -0.02), '#57604f', 'v');
      // grande porte de sortie des véhicules (mur gauche du hangar)
      K.door('left', 0.85, 2.2, 2.1, 0.82, team, 0.2);
      door = { u: 1.5, v: 2.35 };
      // rampe de sortie peinte + chevrons
      K.pad(0.75, 2.1, 2.35, 2.95, 'rgba(56,58,54,0.85)', 'rgba(200,200,190,0.3)');
      for (let i = 0; i < 4; i++) {
        K.paint(0.95 + i * 0.35, 2.25, 1.15 + i * 0.35, 2.8, `rgba(184,145,47,${0.5 - i * 0.08})`, 3);
      }
      // bloc bureaux accolé
      K.box(0.05, 0.35, 0.42, 1.8, 0, 0.72, CONCRETE_D, { roofBorder: true });
      K.windows('left', 0.5, 1.7, 1.8, 0.3, 3);
      // cheminée d'atelier + extracteurs
      K.cyl(2.6, 0.35, 0.11, 1.4, 2.0, '#6d6a60', { band: HAZARD, bandAt: 0.2 });
      overlays.push({ kind: 'smoke', u: 2.6, v: 0.35, h: 2.0, s: 0.85 });
      overlays.push({ kind: 'weld', u: 1.5, v: 1.2, h: 0.5, s: 1 });
      K.roofKit(0.6, 0.3, 2.6, 1.9, 1.5, 3);
      K.teamBand('right', 0.2, 2.0, 2.9, 0.8, team);
      break;
    }
    case 'factory2': {
      K.slab(0, 0, 3, 3);
      K.shadow(0.05, 0.05, 2.95, 2.95, 1.8);
      // double travée parallèle + tour d'assemblage lourde
      K.gable(0.1, 0.1, 2.6, 1.35, 0.9, 1.35, shade(STEEL, -0.08), '#4e574c', 'u');
      K.gable(0.1, 1.5, 2.6, 2.75, 0.9, 1.35, shade(STEEL, -0.04), '#535c50', 'u');
      // portique roulant au-dessus des travées
      c.strokeStyle = shade(HAZARD, -0.15); c.lineWidth = 3.4;
      c.beginPath();
      c.moveTo(K.lx(0.5, 0.05), K.ly(0.5, 0.05, 1.7));
      c.lineTo(K.lx(0.5, 2.8), K.ly(0.5, 2.8, 1.7));
      c.stroke();
      c.strokeStyle = STEEL_D; c.lineWidth = 2.2;
      for (const vv of [0.1, 2.75]) {
        c.beginPath(); c.moveTo(K.lx(0.5, vv), K.ly(0.5, vv, 1.7)); c.lineTo(K.lx(0.5, vv), K.ly(0.5, vv, 0)); c.stroke();
      }
      // chariot + câble
      c.fillStyle = '#2e332e';
      c.fillRect(K.lx(0.5, 1.9) - 5, K.ly(0.5, 1.9, 1.7) - 3, 10, 7);
      c.strokeStyle = 'rgba(220,220,210,0.5)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(K.lx(0.5, 1.9), K.ly(0.5, 1.9, 1.7)); c.lineTo(K.lx(0.5, 1.9), K.ly(0.5, 1.9, 1.0)); c.stroke();
      // tour d'assemblage (silhouette T2 bien distincte)
      K.box(2.65, 0.15, 2.95, 1.0, 0, 2.05, shade(CONCRETE, -0.12), { roofBorder: true });
      K.teamBand('left', 2.65, 2.95, 1.0, 1.85, team);
      overlays.push({ kind: 'beacon', u: 2.8, v: 0.2, h: 2.1, s: 0.9 });
      // grande porte double travée
      K.door('left', 0.5, 1.15, 2.75, 0.78, team, 0.18);
      door = { u: 0.85, v: 2.85 };
      K.pad(0.35, 2.75, 1.5, 2.98, 'rgba(56,58,54,0.85)', 'rgba(200,200,190,0.3)');
      overlays.push({ kind: 'weld', u: 1.4, v: 0.7, h: 0.5, s: 1.2 });
      overlays.push({ kind: 'weld', u: 1.6, v: 2.1, h: 0.5, s: 1 });
      K.cyl(2.8, 2.6, 0.12, 0, 1.5, '#6d6a60');
      overlays.push({ kind: 'smoke', u: 2.8, v: 2.6, h: 1.5, s: 0.8 });
      break;
    }
    case 'radar': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.15, 0.2, 1.85, 1.8, 1.0);
      // bunker technique bas
      K.box(0.15, 0.5, 1.5, 1.8, 0, 0.62, CONCRETE_D, { roofBorder: true });
      K.windows('left', 0.35, 1.3, 1.8, 0.3, 2);
      K.teamBand('left', 0.15, 1.5, 1.8, 0.5, team);
      K.door('left', 0.55, 0.95, 1.8, 0.4, team);
      door = { u: 0.75, v: 1.8 };
      // pylône + GRANDE parabole (l'identité du bâtiment)
      K.mast(1.15, 0.95, 0.62, 1.35);
      K.dish(1.15, 0.95, 1.55, 0.62, '#a2a89f');
      overlays.push({ kind: 'beacon', u: 1.15, v: 0.95, h: 2.1, s: 1 });
      // petit radôme d'appoint
      c.fillStyle = shade('#9aa39c', 0.06);
      c.beginPath(); c.ellipse(K.lx(1.7, 1.45), K.ly(1.7, 1.45, 0.2), 9, 7, 0, Math.PI, 0); c.fill();
      c.strokeStyle = 'rgba(10,12,10,0.4)'; c.stroke();
      K.whip(0.35, 0.6, 0.62, 0.8);
      break;
    }
    case 'radarcenter': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.1, 0.1, 1.9, 1.9, 1.4);
      // socle octogonal + grand radôme (dôme = silhouette unique)
      K.box(0.25, 0.5, 1.75, 1.9, 0, 0.72, shade(CONCRETE, -0.05), { roofBorder: true });
      K.teamBand('left', 0.25, 1.75, 1.9, 0.6, team);
      const dx = K.lx(1.0, 1.2), dy = K.ly(1.0, 1.2, 0.72);
      const R = 0.62 * ISO_S;
      const g = c.createRadialGradient(dx - R * 0.3, dy - R * 0.75, R * 0.1, dx, dy - R * 0.35, R * 1.15);
      g.addColorStop(0, '#c3c8bf');
      g.addColorStop(0.6, '#8f958c');
      g.addColorStop(1, '#565c55');
      c.fillStyle = g;
      c.beginPath(); c.ellipse(dx, dy, R, R * 0.9, 0, Math.PI, 0); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(10,12,10,0.5)'; c.lineWidth = 1.4; c.stroke();
      // facettes du radôme
      c.strokeStyle = 'rgba(30,34,30,0.25)'; c.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        c.beginPath(); c.ellipse(dx, dy, R * (i / 5), R * 0.9, 0, Math.PI, 0); c.stroke();
      }
      c.beginPath(); c.moveTo(dx - R * 0.55, dy - R * 0.62); c.quadraticCurveTo(dx, dy - R * 1.05, dx + R * 0.55, dy - R * 0.62); c.stroke();
      // antennes panneaux + fouets
      K.box(1.62, 0.42, 1.9, 0.7, 0, 0.95, STEEL_D);
      K.fillP([[1.62, 0.72, 0.9], [1.9, 0.72, 0.9], [1.9, 0.72, 0.45], [1.62, 0.72, 0.45]], '#39423d', false);
      K.whip(0.4, 0.55, 0.72, 1.1);
      K.whip(0.62, 0.42, 0.72, 0.85);
      overlays.push({ kind: 'beacon', u: 1.0, v: 1.2, h: 1.85, s: 1 });
      door = { u: 1.0, v: 1.9 };
      break;
    }
    case 'airport': {
      // tarmac complet + tour + hangar : l'aérien se lit au premier regard
      K.pad(0, 0, 3, 2, 'rgba(58,60,56,0.75)', 'rgba(210,210,200,0.35)');
      K.shadow(0.1, 0.1, 1.4, 1.9, 1.1);
      // piste peinte : axe + chevrons de seuil
      K.paint(1.5, 1.0, 2.85, 1.0, 'rgba(226,226,214,0.5)', 2.4);
      for (let i = 0; i < 3; i++) K.paint(2.55 + i * 0.12, 0.72, 2.55 + i * 0.12, 1.28, 'rgba(226,226,214,0.4)', 2);
      c.fillStyle = 'rgba(214,178,80,0.5)';
      c.beginPath(); c.ellipse(K.lx(2.1, 1.0), K.ly(2.1, 1.0), 0.42 * ISO_S * 1.414, 0.42 * ISO_S * 0.707, 0, 0, Math.PI * 2); c.fill();
      // hangar d'entretien (toit voûté)
      K.gable(0.15, 0.15, 1.35, 1.05, 0.6, 0.98, shade(STEEL, -0.04), '#4f584e', 'u');
      K.door('left', 0.35, 1.1, 1.05, 0.5, team, 0.16);
      door = { u: 0.7, v: 1.05 };
      // tour de contrôle avec cabine vitrée
      K.cyl(0.5, 1.55, 0.17, 0, 1.35, CONCRETE);
      K.box(0.28, 1.34, 0.74, 1.78, 1.35, 1.72, '#5a625a', { roof: '#49514a' });
      K.fillP([[0.28, 1.76, 1.66], [0.74, 1.76, 1.66], [0.74, 1.76, 1.42], [0.28, 1.76, 1.42]], GLASS, false);
      overlays.push({ kind: 'beacon', u: 0.5, v: 1.55, h: 1.78, s: 1 });
      // manche à air
      K.whip(2.75, 1.75, 0, 0.6);
      c.fillStyle = paintTeam(team);
      c.beginPath();
      c.moveTo(K.lx(2.75, 1.75) + 2, K.ly(2.75, 1.75, 0.6));
      c.lineTo(K.lx(2.75, 1.75) + 12, K.ly(2.75, 1.75, 0.6) + 2);
      c.lineTo(K.lx(2.75, 1.75) + 11, K.ly(2.75, 1.75, 0.6) + 5);
      c.lineTo(K.lx(2.75, 1.75) + 2, K.ly(2.75, 1.75, 0.6) + 3);
      c.closePath(); c.fill();
      // feux de piste (chauds)
      for (let i = 0; i < 4; i++) {
        c.fillStyle = 'rgba(240,200,120,0.8)';
        c.beginPath(); c.arc(K.lx(1.6 + i * 0.4, 0.68), K.ly(1.6 + i * 0.4, 0.68), 1.6, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(K.lx(1.6 + i * 0.4, 1.32), K.ly(1.6 + i * 0.4, 1.32), 1.6, 0, Math.PI * 2); c.fill();
      }
      break;
    }
    case 'helipad': {
      K.pad(0, 0, 3, 2, 'rgba(60,62,58,0.7)', 'rgba(210,210,200,0.3)');
      K.shadow(0.1, 0.15, 1.05, 1.85, 0.85);
      // plateforme H surélevée
      K.box(1.3, 0.2, 2.85, 1.75, 0, 0.14, '#4a4e48', { roof: '#3f443f' });
      const hx = K.lx(2.07, 0.97), hy = K.ly(2.07, 0.97, 0.14);
      c.strokeStyle = 'rgba(226,226,214,0.6)'; c.lineWidth = 2;
      c.beginPath(); c.ellipse(hx, hy, 0.55 * ISO_S * 1.414, 0.55 * ISO_S * 0.707, 0, 0, Math.PI * 2); c.stroke();
      c.save();
      c.translate(hx, hy);
      c.transform(1, 0.0, 0, 0.5, 0, 0);   // écrase le H sur le plan du sol
      c.rotate(Math.PI / 4);
      c.strokeStyle = 'rgba(226,226,214,0.75)'; c.lineWidth = 5;
      c.beginPath(); c.moveTo(-11, -13); c.lineTo(-11, 13); c.moveTo(11, -13); c.lineTo(11, 13); c.moveTo(-11, 0); c.lineTo(11, 0); c.stroke();
      c.restore();
      // feux d'angle chauds
      for (const [uu, vv] of [[1.42, 0.32], [2.72, 0.32], [1.42, 1.62], [2.72, 1.62]] as const) {
        c.fillStyle = 'rgba(240,190,110,0.85)';
        c.beginPath(); c.arc(K.lx(uu, vv), K.ly(uu, vv, 0.16), 1.7, 0, Math.PI * 2); c.fill();
      }
      // hangar + dépôt carburant
      K.gable(0.12, 0.15, 1.1, 1.0, 0.55, 0.85, shade(STEEL, -0.06), '#4d564d', 'u');
      K.door('left', 0.3, 0.9, 1.0, 0.45, team, 0.14);
      door = { u: 0.6, v: 1.0 };
      K.tankH(0.25, 0.95, 1.5, 0.16, 0, '#7c6f52');
      c.fillStyle = 'rgba(0,0,0,0.25)';
      K.crates(0.35, 1.78, 2, team);
      K.mast(1.15, 1.7, 0, 0.9, team);
      break;
    }
    case 'turret': {
      K.slab(0.02, 0.02, 0.98, 0.98);
      K.shadow(0.1, 0.15, 0.9, 0.9, 0.5);
      // bunker circulaire + sacs de sable
      K.cyl(0.5, 0.5, 0.4, 0, 0.42, CONCRETE_D);
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * 0.15 + (i / 7) * Math.PI * 0.9;
        const uu = 0.5 + Math.cos(a) * 0.44, vv = 0.5 + Math.sin(a) * 0.44;
        c.fillStyle = shade('#776c50', i % 2 ? -0.06 : 0.05);
        c.beginPath(); c.ellipse(K.lx(uu, vv), K.ly(uu, vv, 0.03), 5, 3, 0, 0, Math.PI * 2); c.fill();
      }
      K.teamBand('left', 0.28, 0.72, 0.9, 0.3, team);
      turret = bakeTurretTop('mg', team);
      turretMount = { u: 0.5, v: 0.5, h: 0.46 };
      break;
    }
    case 'atgun': {
      K.slab(0.02, 0.02, 0.98, 0.98);
      K.shadow(0.1, 0.15, 0.92, 0.9, 0.55);
      // casemate angulaire (blindage apparent)
      K.fillP([[0.1, 0.3, 0.5], [0.9, 0.3, 0.5], [0.98, 0.55, 0.28], [0.9, 0.9, 0], [0.1, 0.9, 0], [0.02, 0.55, 0.28]], shade('#4f574f', -0.05));
      K.fillP([[0.1, 0.3, 0.5], [0.9, 0.3, 0.5], [0.9, 0.34, 0.5], [0.1, 0.34, 0.5]], shade('#4f574f', 0.14), false);
      K.teamBand('left', 0.25, 0.75, 0.88, 0.16, team);
      turret = bakeTurretTop('at', team);
      turretMount = { u: 0.5, v: 0.5, h: 0.52 };
      break;
    }
    case 'aa': {
      K.slab(0.02, 0.02, 0.98, 0.98);
      K.shadow(0.12, 0.15, 0.9, 0.88, 0.55);
      // plateforme croisillon + rampe radar
      K.box(0.15, 0.15, 0.85, 0.85, 0, 0.4, '#565e58', { roofBorder: true });
      K.whip(0.22, 0.25, 0.4, 0.55);
      K.teamBand('right', 0.25, 0.75, 0.85, 0.28, team);
      turret = bakeTurretTop('aa', team);
      turretMount = { u: 0.5, v: 0.5, h: 0.46 };
      break;
    }
    case 'tech': {
      K.slab(0, 0, 2, 2);
      K.shadow(0.12, 0.12, 1.88, 1.88, 1.1);
      // atelier d'études : bloc + shed vitré + banc d'essai
      K.box(0.15, 0.5, 1.5, 1.85, 0, 0.85, CONCRETE, { roofBorder: true });
      K.fillP([[0.15, 0.5, 0.85], [0.6, 0.5, 1.18], [0.6, 1.85, 1.18], [0.15, 1.85, 0.85]], shade(METAL_ROOF, 0.1));
      K.fillP([[0.6, 0.5, 1.18], [0.62, 0.5, 1.18], [0.62, 1.85, 1.18], [0.6, 1.85, 1.18]], 'rgba(240,240,230,0.2)', false);
      K.windows('left', 0.35, 1.35, 1.85, 0.42, 3);
      K.teamBand('left', 0.15, 1.5, 1.85, 0.72, team);
      K.door('left', 0.85, 1.25, 1.85, 0.45, team);
      door = { u: 1.05, v: 1.85 };
      // banc d'essai extérieur : moteur sur châssis + mât d'instrumentation
      K.box(1.6, 0.6, 1.92, 1.1, 0, 0.3, STEEL_D);
      K.cyl(1.76, 0.85, 0.11, 0.3, 0.62, '#6d7268');
      overlays.push({ kind: 'weld', u: 1.76, v: 0.85, h: 0.4, s: 0.8 });
      K.mast(1.75, 1.55, 0, 1.45);
      K.dish(1.75, 1.55, 1.5, 0.22, '#9aa39a');
      K.roofKit(0.7, 0.6, 1.4, 1.7, 0.85, 2);
      break;
    }
    case 'depot': {
      K.pad(0, 0, 2, 2, 'rgba(62,64,58,0.55)', 'rgba(200,200,190,0.25)');
      K.shadow(0.3, 0.3, 1.8, 1.7, 0.8);
      // zone logistique : allées peintes + rangées de conteneurs + grue portique
      K.paint(0.15, 1.0, 1.85, 1.0, 'rgba(214,178,80,0.35)', 2);
      // conteneurs alignés
      K.box(0.2, 0.2, 0.95, 0.55, 0, 0.34, shade(paintTeam(team), -0.15));
      K.box(0.25, 0.62, 0.9, 0.95, 0, 0.3, RUST);
      K.box(0.3, 0.62, 0.85, 0.95, 0.3, 0.55, '#5d665e');
      K.box(1.1, 0.25, 1.8, 0.6, 0, 0.32, '#57605a');
      // grue portique au-dessus de l'allée
      c.strokeStyle = shade(HAZARD, -0.1); c.lineWidth = 3;
      c.beginPath();
      c.moveTo(K.lx(0.3, 1.28), K.ly(0.3, 1.28, 1.05));
      c.lineTo(K.lx(1.8, 1.28), K.ly(1.8, 1.28, 1.05));
      c.stroke();
      c.strokeStyle = STEEL_D; c.lineWidth = 2.2;
      for (const uu of [0.35, 1.75]) {
        c.beginPath(); c.moveTo(K.lx(uu, 1.28), K.ly(uu, 1.28, 1.05)); c.lineTo(K.lx(uu, 1.28), K.ly(uu, 1.28, 0)); c.stroke();
      }
      c.strokeStyle = 'rgba(220,220,210,0.5)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(K.lx(1.0, 1.28), K.ly(1.0, 1.28, 1.05)); c.lineTo(K.lx(1.0, 1.28), K.ly(1.0, 1.28, 0.4)); c.stroke();
      c.fillStyle = '#2e332e';
      c.fillRect(K.lx(1.0, 1.28) - 4, K.ly(1.0, 1.28, 0.42) - 3, 8, 6);
      // cabane de gestion + citerne
      K.box(1.35, 1.45, 1.9, 1.9, 0, 0.5, CANVAS_TENT, { roofBorder: true });
      K.tankH(0.25, 0.85, 1.72, 0.15, 0, '#6f6448');
      K.crates(1.05, 1.65, 3, team);
      door = { u: 1.6, v: 1.9 };
      break;
    }
    case 'lab': {
      K.slab(0, 0, 3, 3);
      K.shadow(0.1, 0.1, 2.9, 2.9, 1.6);
      // laboratoire avancé : bloc principal + dôme d'essai + réservoirs cryo
      K.box(0.15, 0.9, 2.1, 2.55, 0, 1.15, shade(CONCRETE, -0.02), { roofBorder: true });
      K.windows('left', 0.4, 1.9, 2.55, 0.72, 4);
      K.windows('right', 1.1, 2.4, 2.1, 0.72, 3);
      K.teamBand('left', 0.15, 2.1, 2.55, 1.0, team);
      K.door('left', 1.0, 1.45, 2.55, 0.5, team);
      door = { u: 1.2, v: 2.55 };
      // dôme d'expérimentation
      const dx = K.lx(2.35, 1.15), dy = K.ly(2.35, 1.15, 0.4);
      K.cyl(2.35, 1.15, 0.5, 0, 0.4, shade(CONCRETE, -0.1));
      const R = 0.48 * ISO_S;
      const g2 = c.createRadialGradient(dx - R * 0.3, dy - R * 0.7, R * 0.1, dx, dy - R * 0.3, R * 1.1);
      g2.addColorStop(0, '#b7bdb2');
      g2.addColorStop(0.65, '#848b81');
      g2.addColorStop(1, '#4f554d');
      c.fillStyle = g2;
      c.beginPath(); c.ellipse(dx, dy, R, R * 0.82, 0, Math.PI, 0); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(10,12,10,0.5)'; c.lineWidth = 1.3; c.stroke();
      c.strokeStyle = 'rgba(30,34,30,0.25)';
      c.beginPath(); c.moveTo(dx - R * 0.6, dy - R * 0.55); c.quadraticCurveTo(dx, dy - R * 0.95, dx + R * 0.6, dy - R * 0.55); c.stroke();
      // réservoirs verticaux + tuyauterie
      K.cyl(0.5, 0.45, 0.2, 0, 1.35, '#8b9089');
      K.cyl(1.05, 0.35, 0.2, 0, 1.5, '#939890');
      K.cyl(1.6, 0.45, 0.2, 0, 1.35, '#8b9089');
      K.pipe(0.5, 0.45, 1.28, 1.05, 0.35, 1.42);
      K.pipe(1.05, 0.35, 1.42, 1.6, 0.45, 1.28);
      K.pipe(1.05, 0.7, 1.0, 1.05, 1.3, 1.0);
      overlays.push({ kind: 'steam', u: 1.05, v: 0.35, h: 1.5, s: 0.6 });
      overlays.push({ kind: 'beacon', u: 2.35, v: 1.15, h: 1.35, s: 0.9 });
      K.roofKit(0.4, 1.1, 1.9, 2.4, 1.15, 3);
      break;
    }
  }

  K.grime(0.12);

  return {
    canvas: cv,
    ax: K.lx(w / 2, h / 2),
    ay: K.ly(w / 2, h / 2, 0),
    turret, turretMount, overlays, door,
  };
}
