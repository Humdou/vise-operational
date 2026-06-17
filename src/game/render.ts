// Rendu Canvas 2D : terrain pré-rendu adouci, entités différenciées,
// brouillard à dégradé doux, mini-carte.
import { Game, Unit, Building } from './engine';
import { UNITS, BUILDINGS, THEMES, PLAYER_COLORS } from './data';
import { T_GRASS, T_ROUGH, T_WATER, T_ROCK, mulberry32 } from './map';
import { prof } from './profiler';

export interface Camera {
  x: number;   // centre, en tuiles
  y: number;
  zoom: number; // pixels par tuile
}

export interface ViewState {
  cam: Camera;
  selectedUnits: number[];
  selectedBuilding: number;
  placing: string | null;
  placeTx: number;
  placeTy: number;
  placeValid: boolean;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  attackMoveMode: boolean;
  cursor: {
    x: number;
    y: number;
    inside: boolean;
    kind: 'default' | 'ore' | 'ally' | 'enemy' | 'attack' | 'move' | 'place-ok' | 'place-bad';
  };
  orderMarkers: { x: number; y: number; t: number; kind: 'move' | 'attack' | 'harvest' | 'rally' }[];
  // feedback optimiste : bâtiments demandés localement, en attente de
  // confirmation réseau (dessinés en fantôme « en construction »).
  pendingBuilds: { type: string; tx: number; ty: number }[];
}


// Matériau commun des coques (cohérence visuelle façon Planetary Annihilation) :
// métal neutre + panneaux à la couleur de l'équipe + accents lumineux.
const HULL_DARK = '#171b18';
const HULL_MID = '#30372f';
const HULL_LIGHT = '#485348';
const INDUSTRIAL_ACCENT = '#b88f34';

// Résolution des sprites pré-calculés (px par tuile) : le détail est "cuit"
// une seule fois en haute résolution puis affiché lissé — beaucoup plus fin
// qu'un dessin direct, et plus rapide.
const SPX = 48;

// Porte de sortie par type de bâtiment producteur : [dx, dy, largeur, hauteur]
// en fractions de l'emprise, relatives au centre du sprite. Sert à l'animation
// d'ouverture (lumière chaude + panneau qui se lève) quand une unité sort.
const DOOR_RECTS: Partial<Record<string, [number, number, number, number]>> = {
  factory: [0, 0.11, 0.5, 0.19],
  factory2: [-0.19, -0.085, 0.3, 0.1],
  barracks: [-0.08, 0.22, 0.1, 0.08],
  barracks2: [0, 0.065, 0.13, 0.1],
  refinery: [0.08, 0.38, 0.18, 0.076],
  refinery2: [0.08, 0.4, 0.3, 0.06],
  airport: [-0.28, 0.33, 0.26, 0.13],
};

// Éclaircit (f>0) ou assombrit (f<0) une couleur (#rrggbb ou rgb(r,g,b)).
function shade(color: string, f: number): string {
  let r = 0, g = 0, b = 0;
  if (color.startsWith('#')) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  } else {
    const m2 = color.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m2) { r = +m2[1]; g = +m2[2]; b = +m2[3]; }
  }
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

// Plaque de métal biseautée : dégradé vertical, contour d'encrage, arête claire.
function plate(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, base: string) {
  const gr = c.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, shade(base, 0.13));
  gr.addColorStop(0.45, shade(base, -0.06));
  gr.addColorStop(1, shade(base, -0.38));
  c.fillStyle = gr;
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.55)';
  c.lineWidth = Math.max(1, SPX * 0.03);
  c.stroke();
  c.strokeStyle = 'rgba(235,225,190,0.18)';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(x + r, y + 1.5); c.lineTo(x + w - r, y + 1.5); c.stroke();
}

// Polygone de blindage avec dégradé directionnel.
function armor(c: CanvasRenderingContext2D, pts: [number, number][], base: string, lightDir = -1) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const gr = c.createLinearGradient(0, lightDir < 0 ? minY : maxY, 0, lightDir < 0 ? maxY : minY);
  gr.addColorStop(0, shade(base, 0.12));
  gr.addColorStop(0.55, shade(base, -0.06));
  gr.addColorStop(1, shade(base, -0.36));
  c.fillStyle = gr;
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.5)';
  c.lineWidth = Math.max(1, SPX * 0.03);
  c.stroke();
}

// Chenille : bande sombre, galets, maillons.
function tracks(c: CanvasRenderingContext2D, x: number, y: number, len: number, wd: number) {
  plate(c, x, y, len, wd, wd * 0.3, '#121614');
  c.fillStyle = '#252b27';
  const n = Math.max(3, Math.floor(len / (wd * 0.9)));
  for (let k = 0; k < n; k++) {
    c.beginPath();
    c.arc(x + wd * 0.6 + (k * (len - wd * 1.2)) / Math.max(1, n - 1), y + wd / 2, wd * 0.3, 0, Math.PI * 2);
    c.fill();
  }
  c.strokeStyle = 'rgba(255,255,255,0.12)';
  c.lineWidth = 1;
  for (let k = 0; k < len; k += 4) {
    c.beginPath(); c.moveTo(x + k, y + 1); c.lineTo(x + k, y + wd - 1); c.stroke();
  }
}

// Canon : fût cylindrique en dégradé + frein de bouche.
function barrel(c: CanvasRenderingContext2D, x: number, y: number, len: number, thick: number, brake = true) {
  const gr = c.createLinearGradient(0, y - thick / 2, 0, y + thick / 2);
  gr.addColorStop(0, '#929b94');
  gr.addColorStop(0.5, '#5d665f');
  gr.addColorStop(1, '#252b29');
  c.fillStyle = gr;
  c.fillRect(x, y - thick / 2, len, thick);
  c.strokeStyle = 'rgba(0,0,0,0.5)';
  c.lineWidth = 1;
  c.strokeRect(x, y - thick / 2, len, thick);
  if (brake) {
    c.fillStyle = '#2c3136';
    c.fillRect(x + len - thick * 1.4, y - thick * 0.8, thick * 1.4, thick * 1.6);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(x + len - thick * 1.4, y - thick * 0.8, thick * 1.4, 2);
  }
}

// Greebles : petits détails techniques (évents, boîtiers, boulons).
function greebles(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number, n: number) {
  const rng = mulberry32(seed);
  for (let k = 0; k < n; k++) {
    const gx = x + rng() * w, gy = y + rng() * h;
    const kind = rng();
    if (kind < 0.4) { // évent
      c.fillStyle = 'rgba(0,0,0,0.35)';
      const gw = 3 + rng() * 5;
      c.fillRect(gx, gy, gw, 2);
      c.fillRect(gx, gy + 3, gw, 2);
    } else if (kind < 0.75) { // boîtier
      c.fillStyle = `rgba(255,255,255,${0.06 + rng() * 0.08})`;
      c.fillRect(gx, gy, 3 + rng() * 4, 3 + rng() * 3);
      c.strokeStyle = 'rgba(0,0,0,0.3)';
      c.lineWidth = 1;
      c.strokeRect(gx, gy, 3 + rng() * 4, 3 + rng() * 3);
    } else { // boulon
      c.fillStyle = 'rgba(255,255,255,0.22)';
      c.beginPath(); c.arc(gx, gy, 1.2, 0, Math.PI * 2); c.fill();
    }
  }
}

// Usure : éraflures et salissures discrètes.
function weather(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number) {
  const rng = mulberry32(seed * 7 + 3);
  for (let k = 0; k < 14; k++) {
    const gx = x + rng() * w, gy = y + rng() * h;
    if (rng() < 0.5) {
      c.strokeStyle = `rgba(0,0,0,${0.08 + rng() * 0.1})`;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + (rng() - 0.5) * 8, gy + (rng() - 0.5) * 8); c.stroke();
    } else {
      c.fillStyle = `rgba(60,48,30,${0.06 + rng() * 0.08})`;
      c.beginPath(); c.arc(gx, gy, 1 + rng() * 2.5, 0, Math.PI * 2); c.fill();
    }
  }
}

// Passe commune de direction artistique : assombrit, unifie et détaille les
// sprites déjà dessinés. Elle ne change que les pixels précalculés, jamais les
// données de gameplay.
function industrialFinish(
  c: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  seed: number,
  intensity = 1,
) {
  const rng = mulberry32(seed * 97 + 31);
  c.save();
  c.globalCompositeOperation = 'destination-over';
  const shadow = c.createRadialGradient(x + w * 0.6, y + h * 0.72, 1, x + w * 0.58, y + h * 0.72, Math.max(w, h) * 0.55);
  shadow.addColorStop(0, `rgba(0,0,0,${0.42 * intensity})`);
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = shadow;
  c.beginPath();
  c.ellipse(x + w * 0.58, y + h * 0.72, w * 0.46, h * 0.22, -0.08, 0, Math.PI * 2);
  c.fill();
  c.restore();

  c.save();
  c.globalCompositeOperation = 'source-atop';

  const tone = c.createLinearGradient(x, y, x + w, y + h);
  tone.addColorStop(0, `rgba(226,220,188,${0.045 * intensity})`);
  tone.addColorStop(0.34, `rgba(39,45,37,${0.12 * intensity})`);
  tone.addColorStop(0.72, `rgba(10,13,12,${0.2 * intensity})`);
  tone.addColorStop(1, `rgba(0,0,0,${0.36 * intensity})`);
  c.fillStyle = tone;
  c.fillRect(x, y, w, h);

  // Arêtes et renforts ponctuels, pas de quadrillage systématique.
  c.strokeStyle = `rgba(0,0,0,${0.34 * intensity})`;
  c.lineWidth = Math.max(1, SPX * 0.022);
  const ribs = Math.max(3, Math.min(8, Math.floor((w + h) / 42)));
  for (let i = 0; i < ribs; i++) {
    const horizontal = rng() < 0.55;
    const ax = x + w * (0.12 + rng() * 0.68);
    const ay = y + h * (0.18 + rng() * 0.58);
    const len = (horizontal ? w : h) * (0.12 + rng() * 0.22);
    c.beginPath();
    if (horizontal) {
      c.moveTo(ax, ay);
      c.lineTo(Math.min(x + w * 0.9, ax + len), ay + (rng() - 0.5) * 2);
    } else {
      c.moveTo(ax, ay);
      c.lineTo(ax + (rng() - 0.5) * 2, Math.min(y + h * 0.88, ay + len));
    }
    c.stroke();
    c.strokeStyle = `rgba(226,220,188,${0.06 * intensity})`;
    c.lineWidth = 1;
    c.stroke();
    c.strokeStyle = `rgba(0,0,0,${0.34 * intensity})`;
    c.lineWidth = Math.max(1, SPX * 0.022);
  }

  const rivets = Math.max(6, Math.floor((w * h) / 1100));
  for (let i = 0; i < rivets; i++) {
    const clusterX = x + w * (0.14 + rng() * 0.72);
    const clusterY = y + h * (0.16 + rng() * 0.68);
    const cluster = rng() < 0.7 ? 2 + Math.floor(rng() * 3) : 1;
    for (let j = 0; j < cluster; j++) {
      const rx = clusterX + (j - (cluster - 1) / 2) * (2.8 + rng() * 1.7);
      const ry = clusterY + (rng() - 0.5) * 2.5;
      c.fillStyle = `rgba(218,211,178,${0.13 + rng() * 0.11})`;
      c.beginPath();
      c.arc(rx, ry, 0.75 + rng() * 0.55, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = `rgba(0,0,0,${0.18 + rng() * 0.12})`;
      c.beginPath();
      c.arc(rx + 0.7, ry + 0.7, 0.65, 0, Math.PI * 2);
      c.fill();
    }
  }

  c.strokeStyle = `rgba(235,224,190,${0.07 * intensity})`;
  c.lineWidth = Math.max(1, SPX * 0.015);
  for (let i = 0; i < 11; i++) {
    const sx = x + rng() * w;
    const sy = y + rng() * h;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(sx + (rng() - 0.5) * 12, sy + (rng() - 0.5) * 12);
    c.stroke();
  }

  c.strokeStyle = `rgba(12,10,7,${0.13 * intensity})`;
  c.lineWidth = Math.max(1, SPX * 0.018);
  for (let i = 0; i < 5; i++) {
    const cx = x + w * (0.18 + rng() * 0.64);
    const cy = y + h * (0.2 + rng() * 0.58);
    c.beginPath();
    c.moveTo(cx, cy);
    c.quadraticCurveTo(cx + (rng() - 0.5) * w * 0.12, cy + h * (0.04 + rng() * 0.08), cx + (rng() - 0.5) * w * 0.16, cy + h * (0.1 + rng() * 0.12));
    c.stroke();
  }

  const grime = c.createRadialGradient(x + w * 0.42, y + h * 0.62, 1, x + w * 0.42, y + h * 0.62, Math.max(w, h) * 0.5);
  grime.addColorStop(0, `rgba(92,76,42,${0.08 * intensity})`);
  grime.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = grime;
  c.fillRect(x, y, w, h);

  const lamps = Math.max(2, Math.min(8, Math.floor((w + h) / 36)));
  for (let i = 0; i < lamps; i++) {
    const lx = x + w * (0.12 + rng() * 0.76);
    const ly = y + h * (0.22 + rng() * 0.62);
    const rr = 1.4 + rng() * 1.4;
    c.fillStyle = `rgba(255,174,64,${0.08 * intensity})`;
    c.beginPath(); c.arc(lx, ly, rr * 3.2, 0, Math.PI * 2); c.fill();
    c.fillStyle = shade(INDUSTRIAL_ACCENT, 0.18);
    c.beginPath(); c.arc(lx, ly, rr, 0, Math.PI * 2); c.fill();
  }

  c.fillStyle = `rgba(0,0,0,${0.12 * intensity})`;
  c.fillRect(x, y + h * 0.82, w, h * 0.18);

  c.strokeStyle = `rgba(184,143,52,${0.18 * intensity})`;
  c.lineWidth = Math.max(1, SPX * 0.017);
  const hazardY = y + h * (0.76 + rng() * 0.08);
  for (let i = 0; i < 4; i++) {
    const hx = x + w * (0.14 + rng() * 0.68);
    c.beginPath();
    c.moveTo(hx, hazardY);
    c.lineTo(hx + w * 0.035, hazardY - h * 0.018);
    c.stroke();
  }

  c.strokeStyle = `rgba(0,0,0,${0.45 * intensity})`;
  c.lineWidth = Math.max(1, SPX * 0.022);
  c.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));

  c.restore();
}

export class Renderer {
  /** index du joueur dont on rend le point de vue (brouillard, alliés) */
  pov = 0;
  private ctx: CanvasRenderingContext2D;
  private mmCtx: CanvasRenderingContext2D;
  private mmTerrain: HTMLCanvasElement | null = null;
  private mmFog: HTMLCanvasElement | null = null;   // overlay brouillard (résolution carte)
  private mmFogImg: ImageData | null = null;
  private mmBase: HTMLCanvasElement | null = null;  // contenu mini-carte mis en cache
  private mmBaseCtx: CanvasRenderingContext2D | null = null;
  private mmAccum = 0;                                // throttle du rafraîchissement
  private mmDrawn = false;
  private terrain: HTMLCanvasElement | null = null;
  private tpx = 12;   // pixels de pré-rendu par TUILE de gameplay (= SUB × spx, adaptatif)
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogCtx: CanvasRenderingContext2D | null = null;
  private fogImg: ImageData | null = null;

  constructor(private canvas: HTMLCanvasElement, private minimap: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.mmCtx = minimap.getContext('2d')!;
  }

  // ------------------------------------------------ terrain pré-rendu (1 fois)

  private buildTerrain(g: Game) {
    const { w, h, terrain, roads, cliff, height } = g.map;
    const theme = THEMES[g.map.theme];

    // ===== SUBDIVISION VISUELLE : chaque tuile de gameplay = SUB×SUB sous-tuiles.
    // Le gameplay/coords/collisions/fog sont INCHANGÉS — seul le rendu gagne en
    // densité. spx (pixels par sous-tuile) est borné pour que la toile de
    // pré-rendu reste raisonnable même sur carte Géante (perf/mémoire).
    const SUB = 4;
    const n = Math.max(w, h);
    const spx = Math.max(3, Math.min(6, Math.floor(4400 / (n * SUB))));
    const tpx = SUB * spx;
    this.tpx = tpx;
    const W4 = w * SUB, H4 = h * SUB;

    const c = document.createElement('canvas');
    c.width = w * tpx; c.height = h * tpx;
    const tc = c.getContext('2d')!;

    // ---- bruit de valeur lissé (déterministe) : déformation des frontières +
    // variation de teinte. Petite grille échantillonnée en bilinéaire.
    const mkNoise = (seed: number) => {
      const G = 64; const grid = new Float32Array(G * G); const r = mulberry32(seed);
      for (let i = 0; i < G * G; i++) grid[i] = r();
      const at = (x: number, y: number) => grid[((y % G + G) % G) * G + ((x % G + G) % G)];
      return (x: number, y: number) => {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        const a = at(xi, yi), b = at(xi + 1, yi), cc = at(xi, yi + 1), d = at(xi + 1, yi + 1);
        return a + (b - a) * u + (cc - a) * v + (a - b - cc + d) * u * v;
      };
    };
    const warpA = mkNoise(w * 91 + h * 7 + 1);
    const warpB = mkNoise(w * 17 + h * 53 + 2);
    const tint = mkNoise(w * 131 + h * 29 + 3);
    const grain = mkNoise(w * 211 + h * 97 + 4);

    const hex2rgb = (s: string): [number, number, number] => {
      const v = parseInt(s.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    };
    const grassP = theme.grass.map(hex2rgb);
    const roughP = theme.rough.map(hex2rgb);
    const rockP = theme.rock.map(hex2rgb);
    const waterRGB = hex2rgb(theme.water);

    // ---- hauteur interpolée à la résolution sous-tuile (relief lisse et fin)
    const interpH = (gx: number, gy: number): number => {
      if (gx < 0) gx = 0; else if (gx > w - 1) gx = w - 1;
      if (gy < 0) gy = 0; else if (gy > h - 1) gy = h - 1;
      const x0 = gx | 0, y0 = gy | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
      const fx = gx - x0, fy = gy - y0;
      const a = height[y0 * w + x0], b = height[y0 * w + x1], cc = height[y1 * w + x0], d = height[y1 * w + x1];
      return a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
    };
    // Champ d'altitude sous-tuile, avec CONTRASTE ÉTALÉ autour de 0.46 : pousse
    // les hauts plus haut et les bas plus bas → davantage de ruptures de niveau
    // (donc plus de falaises/terrasses franches) sans toucher au gameplay.
    const SH = new Float32Array(W4 * H4);
    for (let sy = 0; sy < H4; sy++)
      for (let sx2 = 0; sx2 < W4; sx2++) {
        const hv = (interpH((sx2 + 0.5) / SUB - 0.5, (sy + 0.5) / SUB - 0.5) - 0.46) * 1.55 + 0.46;
        SH[sy * W4 + sx2] = hv < 0 ? 0 : hv > 1 ? 1 : hv;
      }

    const isLand = (tx: number, ty: number) => {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
      const t = terrain[ty * w + tx];
      return t === T_GRASS || t === T_ROUGH;
    };

    // ===== 1) BASE : couleur + relief par SOUS-TUILE via ImageData (rapide,
    // dense). Frontières de terrain déformées par bruit (fini les carrés nets).
    const small = document.createElement('canvas');
    small.width = W4; small.height = H4;
    const sctx = small.getContext('2d')!;
    const img = sctx.createImageData(W4, H4);
    const D = img.data;

    // Couleur d'une tuile (palette variée, déterministe). Sert au mélange des
    // bordures : on interpole les couleurs des 4 tuiles autour de chaque
    // sous-cellule → transitions douces entre herbe / terre / roche / eau.
    const c00: [number, number, number] = [0, 0, 0], c10: [number, number, number] = [0, 0, 0];
    const c01: [number, number, number] = [0, 0, 0], c11: [number, number, number] = [0, 0, 0];
    const tileRGB = (tx: number, ty: number, out: [number, number, number]) => {
      if (tx < 0) tx = 0; else if (tx >= w) tx = w - 1;
      if (ty < 0) ty = 0; else if (ty >= h) ty = h - 1;
      const tt = terrain[ty * w + tx];
      if (tt === T_WATER) { out[0] = waterRGB[0]; out[1] = waterRGB[1]; out[2] = waterRGB[2]; return; }
      const vi = (((tx * 73856093) ^ (ty * 19349663)) >>> 0);
      const p = tt === T_ROCK ? rockP[vi % rockP.length] : tt === T_ROUGH ? roughP[vi % roughP.length] : grassP[vi % grassP.length];
      out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    };

    for (let sy = 0; sy < H4; sy++) {
      for (let sx2 = 0; sx2 < W4; sx2++) {
        const i4 = sy * W4 + sx2;
        const fx = (sx2 + 0.5) / SUB, fy = (sy + 0.5) / SUB;     // coord tuile
        // position continue déformée (frontières organiques), alignée centres tuiles
        const wx = fx - 0.5 + (warpA(fx * 1.1, fy * 1.1) - 0.5) * 1.8;
        const wy = fy - 0.5 + (warpB(fx * 1.1 + 3.3, fy * 1.1 + 1.1) - 0.5) * 1.8;
        const x0 = Math.floor(wx), y0 = Math.floor(wy);
        const fxr = wx - x0, fyr = wy - y0;
        // type dominant (tuile la plus proche) pour la logique eau/relief
        let gtx = Math.round(wx); if (gtx < 0) gtx = 0; else if (gtx >= w) gtx = w - 1;
        let gty = Math.round(wy); if (gty < 0) gty = 0; else if (gty >= h) gty = h - 1;
        const t = terrain[gty * w + gtx];
        let rockContact = 0, openContact = 0;
        if (t !== T_WATER) {
          const neigh: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (const [dx, dy] of neigh) {
            const nx = gtx + dx, ny = gty + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nt = terrain[ny * w + nx];
            if (nt === T_ROCK) rockContact++;
            else if (nt !== T_WATER) openContact++;
          }
        }

        // ----- couleur fondue : mélange bilinéaire des 4 tuiles voisines
        tileRGB(x0, y0, c00); tileRGB(x0 + 1, y0, c10); tileRGB(x0, y0 + 1, c01); tileRGB(x0 + 1, y0 + 1, c11);
        const w00 = (1 - fxr) * (1 - fyr), w10 = fxr * (1 - fyr), w01 = (1 - fxr) * fyr, w11 = fxr * fyr;
        let r = c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11;
        let gn = c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11;
        let b = c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11;
        if (t === T_ROCK) {
          // Les zones infranchissables doivent rester immédiatement lisibles,
          // même après le mélange organique des bordures.
          r = r * 0.72 + 42;
          gn = gn * 0.70 + 38;
          b = b * 0.68 + 34;
          if (openContact > 0) {
            const rim = Math.min(0.24, openContact * 0.06);
            r += 42 * rim; gn += 36 * rim; b += 24 * rim;
          }
        } else if (rockContact > 0 && t !== T_WATER) {
          const border = Math.min(0.28, rockContact * 0.085);
          r *= 1 - border;
          gn *= 1 - border;
          b *= 1 - border * 0.9;
        }

        const e = SH[i4];
        if (t !== T_WATER) {
          // teinte par altitude : sommets clairs/secs, creux verts/sombres
          const hh = e - 0.5;
          if (hh > 0) { const k = Math.min(0.42, hh * 1.0); r += (208 - r) * k; gn += (196 - gn) * k; b += (150 - b) * k; }
          else { const k = Math.min(0.42, -hh * 1.0); r += (26 - r) * k; gn += (62 - gn) * k; b += (44 - b) * k; }
          // variation fine de teinte (herbe/sol moins répétitifs)
          const j = (grain(fx * 3.1, fy * 3.1) - 0.5) * 0.16 + (tint(fx * 7.3, fy * 7.3) - 0.5) * 0.10;
          r *= 1 + j; gn *= 1 + j; b *= 1 + j;
          // Lecture stratégique du relief : les fonds de vallée sont plus froids
          // et sombres, les plateaux/sommets plus secs et rocheux.
          const valleyTone = Math.max(0, Math.min(1, (0.46 - e) * 2.4));
          if (valleyTone > 0) {
            r = r * (1 - valleyTone * 0.18) + 18 * valleyTone;
            gn = gn * (1 - valleyTone * 0.10) + 38 * valleyTone;
            b = b * (1 - valleyTone * 0.06) + 30 * valleyTone;
          }
          const plateauTone = Math.max(0, Math.min(1, (e - 0.64) * 2.1));
          if (plateauTone > 0) {
            r = r * (1 - plateauTone * 0.16) + 142 * plateauTone;
            gn = gn * (1 - plateauTone * 0.18) + 128 * plateauTone;
            b = b * (1 - plateauTone * 0.26) + 92 * plateauTone;
          }
        } else {
          // eau : forte profondeur (fonds très sombres et bleutés, hauts-fonds
          // clairs et turquoise) → contraste marqué + meilleure intégration.
          const depth = Math.max(0, Math.min(1, (0.2 - e) / 0.2));
          if (depth > 0.55) {        // grand fond : bleu nuit profond
            r *= 1 - depth * 0.72; gn *= 1 - depth * 0.6; b = b * (1 - depth * 0.32) + depth * 26;
          } else {                   // haut-fond : turquoise plus clair
            const sh2 = 1 - depth;
            r = r * (1 - sh2 * 0.25) + sh2 * 30; gn = gn * (1 - sh2 * 0.15) + sh2 * 70; b = b * (1 - sh2 * 0.1) + sh2 * 30;
          }
          const ripple = (grain(fx * 5, fy * 2.5) - 0.5) * 20;
          r += ripple * 0.4; gn += ripple * 0.6; b += ripple;
        }

        // ===== RELIEF EN PALIERS + FALAISES (lecture de hauteur immédiate) =====
        // Style C&C/Tempest : l'altitude est découpée en niveaux ; chaque niveau
        // a une luminosité distincte (haut clair / bas sombre) et les RUPTURES de
        // niveau deviennent des falaises (arête éclairée au NO, ombre au pied SE).
        const xm = sx2 > 0 ? sx2 - 1 : sx2, xp = sx2 < W4 - 1 ? sx2 + 1 : sx2;
        const ym = sy > 0 ? sy - 1 : sy, yp = sy < H4 - 1 ? sy + 1 : sy;
        const hl = SH[sy * W4 + xm], hr = SH[sy * W4 + xp], hu = SH[ym * W4 + sx2], hd = SH[yp * W4 + sx2];
        const dxh = hr - hl, dyh = hd - hu;
        const LEVELS = 9;
        const myL = Math.floor(e * LEVELS);
        // rampe de luminosité par palier : contraste fort entre étages
        let relief = 0.64 + myL * (0.62 / LEVELS);
        if (t !== T_WATER) {
          // bord SUPÉRIEUR de falaise (domine l'est/le sud, côté éclairé) → liseré clair
          if (myL > Math.floor(hr * LEVELS)) relief += 0.28;
          if (myL > Math.floor(hd * LEVELS)) relief += 0.28;
          // PIED de falaise (dominé par l'ouest/le nord) → ombre franche
          if (myL < Math.floor(hl * LEVELS)) relief -= 0.56;
          if (myL < Math.floor(hu * LEVELS)) relief -= 0.56;
        }
        // micro-pente continue (douceur à l'intérieur d'un palier)
        relief += (-dxh - dyh) * 7;
        if (relief < 0.28) relief = 0.28; else if (relief > 1.82) relief = 1.82;
        // ombre PORTÉE longue : falaises/collines projettent loin vers le SE
        let cast = 0;
        for (let s = 1; s <= 11; s++) {
          const ax = sx2 - s, ay = sy - s; if (ax < 0 || ay < 0) break;
          const diff = SH[ay * W4 + ax] - e - s * 0.0085;
          if (diff > cast) cast = diff;
        }
        const m = relief * (1 - Math.min(0.76, cast * 3.35));
        r *= m; gn *= m; b *= m;

        const o = i4 * 4;
        D[o] = r < 0 ? 0 : r > 255 ? 255 : r;
        D[o + 1] = gn < 0 ? 0 : gn > 255 ? 255 : gn;
        D[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        D[o + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    // mise à l'échelle douce → dégradés fluides entre sous-tuiles
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
    tc.drawImage(small, 0, 0, W4, H4, 0, 0, c.width, c.height);

    const rng = mulberry32(w * 31 + h);
    const SS = spx;             // taille d'une sous-tuile en pixels

    // ===== 2) RIVAGES : écume + liseré clair, contour irrégulier (sous-tuile)
    tc.lineWidth = Math.max(1, SS * 0.6);
    const icyShore = g.map.theme === 'snow';
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        if (terrain[ty * w + tx] !== T_WATER) continue;
        const neigh: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of neigh) {
          if (!isLand(tx + dx, ty + dy)) continue;
          tc.strokeStyle = icyShore ? 'rgba(238,248,255,0.76)' : 'rgba(228,242,250,0.55)';
          tc.beginPath();
          const ex = (tx + (dx > 0 ? 1 : 0)) * tpx, ey = (ty + (dy > 0 ? 1 : 0)) * tpx;
          for (let s = 0; s <= SUB; s++) {
            const jit = (warpA(tx + s * 0.3, ty + s * 0.3) - 0.5) * SS * 1.3;
            const x = dx !== 0 ? ex + jit * 0.3 : (tx) * tpx + s * SS;
            const y = dy !== 0 ? ey + jit * 0.3 : (ty) * tpx + s * SS;
            if (s === 0) tc.moveTo(x, y); else tc.lineTo(x, y);
          }
          tc.stroke();
          if (icyShore) {
            tc.strokeStyle = 'rgba(150,205,230,0.28)';
            tc.lineWidth = Math.max(1, SS * 0.28);
            tc.beginPath();
            for (let s = 0; s <= SUB; s++) {
              const jit = (warpB(tx + s * 0.22 + 7, ty + s * 0.22 + 2) - 0.5) * SS * 1.1;
              const x = dx !== 0 ? ex + dx * SS * 0.45 + jit * 0.25 : tx * tpx + s * SS;
              const y = dy !== 0 ? ey + dy * SS * 0.45 + jit * 0.25 : ty * tpx + s * SS;
              if (s === 0) tc.moveTo(x, y); else tc.lineTo(x, y);
            }
            tc.stroke();
            tc.lineWidth = Math.max(1, SS * 0.6);
          }
        }
      }

    if (icyShore) {
      // Plaques de glace et fissures légères sur les lacs : visuel uniquement,
      // pré-rendu, donc coût nul pendant les frames de jeu.
      const iceRng = mulberry32(w * 251 + h * 997 + 19);
      const iceCount = Math.floor(w * h * 0.035);
      for (let k = 0; k < iceCount; k++) {
        const tx = (iceRng() * w) | 0, ty = (iceRng() * h) | 0;
        if (terrain[ty * w + tx] !== T_WATER) continue;
        const cx = tx * tpx + iceRng() * tpx;
        const cy = ty * tpx + iceRng() * tpx;
        const rw = tpx * (0.32 + iceRng() * 0.42);
        const rh = tpx * (0.08 + iceRng() * 0.15);
        const a = -0.45 + (iceRng() - 0.5) * 0.5;
        tc.save();
        tc.translate(cx, cy);
        tc.rotate(a);
        tc.fillStyle = `rgba(222,242,250,${0.08 + iceRng() * 0.08})`;
        tc.beginPath();
        tc.ellipse(0, 0, rw, rh, 0, 0, Math.PI * 2);
        tc.fill();
        if (iceRng() < 0.45) {
          tc.strokeStyle = 'rgba(190,224,238,0.18)';
          tc.lineWidth = Math.max(1, SS * 0.12);
          tc.beginPath();
          tc.moveTo(-rw * 0.55, (iceRng() - 0.5) * rh);
          tc.lineTo(-rw * 0.1, (iceRng() - 0.5) * rh);
          tc.lineTo(rw * 0.55, (iceRng() - 0.5) * rh);
          tc.stroke();
        }
        tc.restore();
      }
    }

    // ===== 3) FALAISES : escarpements à bords irréguliers (résolution sous-tuile),
    // arête éclairée au NO, face rocheuse sombre + stries au SE, ombre au pied.
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        const i = ty * w + tx;
        const mask = cliff[i] ?? 0;
        if (!mask || terrain[i] === T_WATER) continue;
        const px = tx * tpx, py = ty * tpx;
        const face = Math.max(SS * 1.4, tpx * 0.42);
        const jitter = (s: number, salt: number) => (warpB(tx + s * 0.25 + salt, ty + s * 0.25) - 0.5) * SS * 1.1;
        if (mask & 1) { // N : arête éclairée
          tc.fillStyle = 'rgba(255,250,222,0.58)';
          for (let s = 0; s < SUB; s++) tc.fillRect(px + s * SS, py + jitter(s, 1), SS + 1, Math.max(1.5, SS * 0.5));
        }
        if (mask & 8) { // O : arête éclairée
          tc.fillStyle = 'rgba(255,250,222,0.5)';
          for (let s = 0; s < SUB; s++) tc.fillRect(px + jitter(s, 4), py + s * SS, Math.max(1.5, SS * 0.5), SS + 1);
        }
        if (mask & 2) { // E : face sombre + stries
          const gr = tc.createLinearGradient(px + tpx - face, 0, px + tpx, 0);
          gr.addColorStop(0, 'rgba(18,14,10,0.12)'); gr.addColorStop(1, 'rgba(6,4,3,0.74)');
          tc.fillStyle = gr; tc.fillRect(px + tpx - face, py, face, tpx);
          tc.strokeStyle = 'rgba(0,0,0,0.5)'; tc.lineWidth = 1;
          for (let k = 0; k < SUB; k++) { const yy = py + k * SS + rng() * SS; tc.beginPath(); tc.moveTo(px + tpx - face, yy); tc.lineTo(px + tpx, yy + (rng() - 0.5) * SS); tc.stroke(); }
        }
        if (mask & 4) { // S : face sombre + ombre projetée au pied
          const gr = tc.createLinearGradient(0, py + tpx - face, 0, py + tpx);
          gr.addColorStop(0, 'rgba(18,14,10,0.13)'); gr.addColorStop(1, 'rgba(6,4,3,0.78)');
          tc.fillStyle = gr; tc.fillRect(px, py + tpx - face, tpx, face);
          tc.strokeStyle = 'rgba(0,0,0,0.54)'; tc.lineWidth = 1;
          for (let k = 0; k < SUB; k++) { const xx = px + k * SS + rng() * SS; tc.beginPath(); tc.moveTo(xx, py + tpx - face); tc.lineTo(xx + (rng() - 0.5) * SS, py + tpx); tc.stroke(); }
          if (ty + 1 < h && terrain[(ty + 1) * w + tx] !== T_WATER) { tc.fillStyle = 'rgba(6,8,16,0.5)'; tc.fillRect(px, py + tpx, tpx, face); }
        }
      }

    // ===== 4) ROUTES en RÉSEAU réaliste : tranchée d'assise sombre → terre
    // battue (largeur irrégulière) → bords usés → ornières jumelles → crête de
    // poussière → gravier/flaques. Tracées de centre à centre (pistes continues).
    const snow = g.map.theme === 'snow', desert = g.map.theme === 'desert';
    // Teinte terreuse claire ET surtout TRANSLUCIDE : la piste se FOND dans le sol
    // (le terrain et son relief transparaissent dessous) au lieu de trancher.
    const dirtMid = snow ? [156, 150, 140] : desert ? [160, 132, 92] : [112, 96, 70];
    const ROAD_A = 0.5;                 // opacité de la terre battue (faible = fondu)
    const roadEdge = snow ? 'rgba(54,58,62,0.13)' : 'rgba(28,20,12,0.16)';
    const roadRut = snow ? 'rgba(42,48,54,0.13)' : 'rgba(10,6,2,0.16)';
    const roadCrest = snow ? 'rgba(245,248,250,0.1)' : 'rgba(228,214,176,0.09)';
    const dirs8: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const roadN = (tx: number, ty: number) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const xx = tx + dx, yy = ty + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && roads[yy * w + xx]) n++;
      }
      return n;
    };
    tc.lineCap = 'round'; tc.lineJoin = 'round';
    // layer 0 : assise creusée ; 1 : terre battue ; 2 : bords ; 3 : ornières ; 4 : crête.
    // Les ornières/bords/crête ne sont tracés que sur les TRONÇONS FINS (≤4 voisins) :
    // les zones-route denses (carrefours/places de départ) restent en terre pleine,
    // ce qui évite l'effet « grille » sur les amas de tuiles-route.
    for (let layer = 0; layer < 5; layer++) {
      for (let ty = 0; ty < h; ty++)
        for (let tx = 0; tx < w; tx++) {
          if (!roads[ty * w + tx]) continue;
          const cx = (tx + 0.5) * tpx, cy = (ty + 0.5) * tpx;
          const nbr = roadN(tx, ty);
          const thin = nbr <= 4;
          // tonalité et largeur variables par tuile (piste vivante, pas uniforme)
          const tone = 0.82 + (warpA(tx * 0.9, ty * 0.9) - 0.5) * 0.4;
          const wide = tpx * (0.5 + (warpB(tx * 0.7 + 5, ty * 0.7) - 0.5) * 0.18);
          if ((layer === 2 || layer === 3 || layer === 4) && !thin) continue;
          // remplissage plein de la chaussée (disques fusionnés → pas de grille)
          if (layer === 0) {
            tc.fillStyle = 'rgba(0,0,0,0.12)';
            tc.beginPath(); tc.arc(cx, cy + tpx * 0.06, wide * 0.62 + tpx * 0.08, 0, Math.PI * 2); tc.fill();
          } else if (layer === 1) {
            tc.fillStyle = `rgba(${Math.round(dirtMid[0] * tone)},${Math.round(dirtMid[1] * tone)},${Math.round(dirtMid[2] * tone)},${ROAD_A})`;
            tc.beginPath(); tc.arc(cx, cy, wide * 0.62, 0, Math.PI * 2); tc.fill();
          }
          for (const [dx, dy] of dirs8) {
            const nx = tx + dx, ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !roads[ny * w + nx]) continue;
            const nxp = (nx + 0.5) * tpx, nyp = (ny + 0.5) * tpx;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len), oy = (dx / len);            // perpendiculaire unitaire
            if (layer === 0) {                                   // assise creusée
              tc.strokeStyle = 'rgba(0,0,0,0.12)'; tc.lineWidth = wide + tpx * 0.18;
              tc.beginPath(); tc.moveTo(cx, cy + tpx * 0.06); tc.lineTo(nxp, nyp + tpx * 0.06); tc.stroke();
            } else if (layer === 1) {                            // terre battue
              tc.strokeStyle = `rgba(${Math.round(dirtMid[0] * tone)},${Math.round(dirtMid[1] * tone)},${Math.round(dirtMid[2] * tone)},${ROAD_A})`;
              tc.lineWidth = wide;
              tc.beginPath(); tc.moveTo(cx, cy); tc.lineTo(nxp, nyp); tc.stroke();
            } else if (layer === 2) {                            // bords assombris (usure)
              tc.strokeStyle = roadEdge; tc.lineWidth = Math.max(1, tpx * 0.07);
              for (const sgn of [-1, 1]) {
                const eo = sgn * wide * 0.46;
                tc.beginPath(); tc.moveTo(cx + ox * eo, cy + oy * eo); tc.lineTo(nxp + ox * eo, nyp + oy * eo); tc.stroke();
              }
            } else if (layer === 3) {                            // ornières jumelles
              tc.strokeStyle = roadRut; tc.lineWidth = Math.max(1, tpx * 0.06);
              for (const sgn of [-1, 1]) {
                const eo = sgn * wide * 0.2;
                tc.beginPath(); tc.moveTo(cx + ox * eo, cy + oy * eo); tc.lineTo(nxp + ox * eo, nyp + oy * eo); tc.stroke();
              }
            } else {                                             // crête de poussière claire
              tc.strokeStyle = roadCrest; tc.lineWidth = Math.max(1, tpx * 0.09);
              tc.beginPath(); tc.moveTo(cx, cy); tc.lineTo(nxp, nyp); tc.stroke();
            }
          }
        }
    }
    // gravier + flaques épars sur la chaussée (déterministe)
    const grav = mulberry32(w * 53 + h * 311 + 7);
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        if (!roads[ty * w + tx]) continue;
        const cx = (tx + 0.5) * tpx, cy = (ty + 0.5) * tpx;
        for (let k = 0; k < 5; k++) {
          const gx = cx + (grav() - 0.5) * tpx * 0.7, gy = cy + (grav() - 0.5) * tpx * 0.7;
          const rr = grav();
          if (rr < 0.7) { tc.fillStyle = snow ? `rgba(35,45,55,${0.08 + grav() * 0.1})` : `rgba(0,0,0,${0.1 + grav() * 0.12})`; tc.beginPath(); tc.arc(gx, gy, Math.max(0.6, SS * 0.28), 0, Math.PI * 2); tc.fill(); }
          else { tc.fillStyle = snow ? 'rgba(245,248,255,0.2)' : 'rgba(220,210,180,0.18)'; tc.beginPath(); tc.arc(gx, gy, Math.max(0.5, SS * 0.2), 0, Math.PI * 2); tc.fill(); }
        }
      }

    // ===== 5) VÉGÉTATION / DÉTAILS épars (densité bornée pour la perf) : touffes,
    // buissons, cailloux, palmiers en tropical — donnent la richesse de surface.
    const tropical = g.map.theme === 'tropical';
    const arctic = g.map.theme === 'snow';
    const vegRng = mulberry32(w * 17 + h * 101 + 55);
    const vegCount = Math.floor(w * h * 1.1);
    for (let k = 0; k < vegCount; k++) {
      const tx = (vegRng() * w) | 0, ty = (vegRng() * h) | 0;
      const t = terrain[ty * w + tx];
      if (t === T_WATER) continue;
      const px = tx * tpx + vegRng() * tpx, py = ty * tpx + vegRng() * tpx;
      const r = vegRng();
      if (t === T_ROCK) {
        if (r < 0.4) { tc.fillStyle = `rgba(0,0,0,${0.12 + vegRng() * 0.14})`; tc.beginPath(); tc.arc(px, py, SS * (0.4 + vegRng() * 0.5), 0, Math.PI * 2); tc.fill(); }
      } else if (arctic && r < 0.045 && !roads[ty * w + tx]) {
        const scale = 0.75 + vegRng() * 0.55;
        const trunkH = tpx * 0.28 * scale;
        tc.fillStyle = 'rgba(18,28,28,0.28)';
        tc.beginPath(); tc.ellipse(px + SS * 0.22, py + SS * 0.3, SS * 0.9 * scale, SS * 0.42 * scale, 0.25, 0, Math.PI * 2); tc.fill();
        tc.strokeStyle = 'rgba(70,52,38,0.72)';
        tc.lineWidth = Math.max(1, SS * 0.22);
        tc.beginPath(); tc.moveTo(px, py + trunkH * 0.35); tc.lineTo(px, py - trunkH * 0.35); tc.stroke();
        for (let tier = 0; tier < 3; tier++) {
          const yy = py - trunkH * (0.44 - tier * 0.28);
          const ww = SS * (2.5 - tier * 0.52) * scale;
          const hh = SS * (1.15 - tier * 0.12) * scale;
          tc.fillStyle = tier === 0 ? 'rgba(17,56,47,0.72)' : 'rgba(20,72,56,0.68)';
          tc.beginPath();
          tc.moveTo(px, yy - hh * 0.72);
          tc.lineTo(px + ww * 0.5, yy + hh * 0.45);
          tc.lineTo(px - ww * 0.5, yy + hh * 0.45);
          tc.closePath(); tc.fill();
          tc.fillStyle = 'rgba(238,247,255,0.64)';
          tc.beginPath();
          tc.moveTo(px - ww * 0.42, yy + hh * 0.15);
          tc.lineTo(px + ww * 0.32, yy + hh * 0.04);
          tc.lineTo(px + ww * 0.43, yy + hh * 0.28);
          tc.lineTo(px - ww * 0.32, yy + hh * 0.34);
          tc.closePath(); tc.fill();
        }
      } else if (arctic && r < 0.13) {
        tc.fillStyle = 'rgba(42,55,60,0.22)';
        tc.beginPath(); tc.ellipse(px, py, SS * (0.8 + vegRng() * 0.75), SS * (0.45 + vegRng() * 0.35), vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
        tc.fillStyle = 'rgba(242,248,252,0.36)';
        tc.beginPath(); tc.ellipse(px - SS * 0.15, py - SS * 0.15, SS * (0.65 + vegRng() * 0.45), SS * 0.26, vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
      } else if (arctic && r < 0.28) {
        const len = SS * (0.7 + vegRng() * 0.8);
        tc.strokeStyle = 'rgba(24,42,38,0.23)'; tc.lineWidth = 1;
        for (let q = 0; q < 2; q++) {
          tc.beginPath();
          tc.moveTo(px + (vegRng() - 0.5) * SS, py + SS * 0.35);
          tc.lineTo(px + (vegRng() - 0.5) * SS, py - len);
          tc.stroke();
        }
      } else if (tropical && r < 0.05) {
        const topX = px + (vegRng() - 0.5) * SS, topY = py - tpx * 0.5;
        tc.strokeStyle = '#5d4a30'; tc.lineWidth = Math.max(1.2, SS * 0.4);
        tc.beginPath(); tc.moveTo(px, py); tc.lineTo(topX, topY); tc.stroke();
        tc.strokeStyle = '#1f5a2d'; tc.lineWidth = Math.max(1, SS * 0.3);
        for (let q = 0; q < 5; q++) { const a = (q / 5) * Math.PI * 2 + vegRng(); tc.beginPath(); tc.moveTo(topX, topY); tc.quadraticCurveTo(topX + Math.cos(a) * tpx * 0.2, topY + Math.sin(a) * tpx * 0.1, topX + Math.cos(a) * tpx * 0.34, topY + Math.sin(a) * tpx * 0.18); tc.stroke(); }
      } else if (r < 0.34) {
        // touffe d'herbe : brin sombre + brin clair
        const len = SS * (0.8 + vegRng());
        tc.strokeStyle = 'rgba(0,0,0,0.22)'; tc.lineWidth = 1;
        tc.beginPath(); tc.moveTo(px, py); tc.lineTo(px + (vegRng() - 0.5) * SS, py - len); tc.stroke();
        tc.strokeStyle = 'rgba(255,255,235,0.16)'; tc.beginPath(); tc.moveTo(px + 0.6, py); tc.lineTo(px + 0.6 + (vegRng() - 0.5) * SS, py - len * 0.8); tc.stroke();
      } else if (r < 0.4) {
        tc.fillStyle = tropical ? 'rgba(10,45,20,0.5)' : 'rgba(20,40,18,0.34)';
        for (let q = 0; q < 3; q++) { tc.beginPath(); tc.arc(px + (vegRng() - 0.5) * SS * 2, py + (vegRng() - 0.5) * SS * 2, SS * (0.4 + vegRng() * 0.4), 0, Math.PI * 2); tc.fill(); }
      } else if (r < 0.43) {
        tc.fillStyle = 'rgba(96,78,52,0.26)';
        tc.beginPath(); tc.ellipse(px, py, SS * 1.4, SS * 0.9, vegRng() * 3, 0, Math.PI * 2); tc.fill();
      }
    }

    // ===== 6) ÉROSION / ACCIDENTS DE SOL : détails discrets alignés sur la
    // pente. Cela donne une lecture plus naturelle des plateaux et vallées sans
    // changer une seule tuile de gameplay.
    const erosionRng = mulberry32(w * 409 + h * 37 + 23);
    const erosionCount = Math.floor(w * h * 0.42);
    for (let k = 0; k < erosionCount; k++) {
      const tx = (erosionRng() * w) | 0, ty = (erosionRng() * h) | 0;
      const i = ty * w + tx;
      const t = terrain[i];
      if (t === T_WATER || roads[i]) continue;
      const leftH = height[ty * w + Math.max(0, tx - 1)];
      const rightH = height[ty * w + Math.min(w - 1, tx + 1)];
      const upH = height[Math.max(0, ty - 1) * w + tx];
      const downH = height[Math.min(h - 1, ty + 1) * w + tx];
      const sxh = rightH - leftH, syh = downH - upH;
      const slope = Math.hypot(sxh, syh);
      const px = tx * tpx + erosionRng() * tpx;
      const py = ty * tpx + erosionRng() * tpx;
      const angle = slope > 0.015 ? Math.atan2(syh, sxh) + Math.PI / 2 : erosionRng() * Math.PI;
      tc.save();
      tc.translate(px, py);
      tc.rotate(angle + (erosionRng() - 0.5) * 0.45);
      if (t === T_ROCK || slope > 0.045) {
        tc.strokeStyle = snow ? 'rgba(38,48,58,0.22)' : t === T_ROCK ? 'rgba(0,0,0,0.34)' : 'rgba(42,34,22,0.22)';
        tc.lineWidth = Math.max(1, SS * 0.22);
        const len = tpx * (0.25 + erosionRng() * 0.42);
        tc.beginPath();
        tc.moveTo(-len * 0.5, 0);
        tc.quadraticCurveTo(0, (erosionRng() - 0.5) * SS, len * 0.5, 0);
        tc.stroke();
        tc.strokeStyle = snow ? 'rgba(255,255,255,0.14)' : 'rgba(255,245,210,0.10)';
        tc.lineWidth = 1;
        tc.beginPath();
        tc.moveTo(-len * 0.35, -SS * 0.18);
        tc.lineTo(len * 0.35, -SS * 0.18);
        tc.stroke();
      } else if (t === T_ROUGH) {
        tc.fillStyle = snow ? 'rgba(72,82,90,0.16)' : desert ? 'rgba(124,88,50,0.18)' : 'rgba(70,60,44,0.20)';
        tc.beginPath();
        tc.ellipse(0, 0, tpx * (0.18 + erosionRng() * 0.18), SS * (0.45 + erosionRng() * 0.45), 0, 0, Math.PI * 2);
        tc.fill();
      } else if (erosionRng() < 0.35) {
        tc.fillStyle = snow ? 'rgba(235,242,248,0.13)' : desert ? 'rgba(150,112,66,0.16)' : 'rgba(126,104,66,0.16)';
        tc.beginPath();
        tc.ellipse(0, 0, tpx * (0.16 + erosionRng() * 0.12), SS * (0.35 + erosionRng() * 0.35), 0, 0, Math.PI * 2);
        tc.fill();
      }
      tc.restore();
    }

    if (snow) {
      // Stries de vent, plaques grises et neige compactée : augmente la richesse
      // des grandes plaines arctiques sans créer d'obstacles ni de nouvelles tuiles.
      const snowRng = mulberry32(w * 733 + h * 149 + 41);
      const snowMarks = Math.floor(w * h * 0.24);
      for (let k = 0; k < snowMarks; k++) {
        const tx = (snowRng() * w) | 0, ty = (snowRng() * h) | 0;
        const i = ty * w + tx;
        const t = terrain[i];
        if (t === T_WATER || t === T_ROCK || roads[i]) continue;
        const px = tx * tpx + snowRng() * tpx;
        const py = ty * tpx + snowRng() * tpx;
        const len = tpx * (0.32 + snowRng() * 0.74);
        const wid = SS * (0.18 + snowRng() * 0.26);
        const angle = -0.62 + (snowRng() - 0.5) * 0.32;
        tc.save();
        tc.translate(px, py);
        tc.rotate(angle);
        if (snowRng() < 0.6) {
          tc.strokeStyle = `rgba(255,255,255,${0.10 + snowRng() * 0.12})`;
          tc.lineWidth = Math.max(1, wid);
          tc.beginPath();
          tc.moveTo(-len * 0.5, 0);
          tc.quadraticCurveTo(0, (snowRng() - 0.5) * SS * 0.25, len * 0.5, 0);
          tc.stroke();
        } else {
          tc.fillStyle = `rgba(78,91,98,${0.055 + snowRng() * 0.06})`;
          tc.beginPath();
          tc.ellipse(0, 0, len * 0.42, wid * 1.4, 0, 0, Math.PI * 2);
          tc.fill();
          tc.fillStyle = 'rgba(240,247,252,0.10)';
          tc.beginPath();
          tc.ellipse(-len * 0.08, -wid * 0.8, len * 0.3, wid * 0.45, 0, 0, Math.PI * 2);
          tc.fill();
        }
        tc.restore();
      }
    }

    // léger assombrissement global pour l'unité chromatique
    tc.fillStyle = 'rgba(0,0,0,0.04)';
    tc.fillRect(0, 0, c.width, c.height);
    const debugMode = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('terrainDebug')
      : null;
    if (debugMode === 'height' || debugMode === 'light' || debugMode === 'cliff' || debugMode === 'roads') {
      const dbg = document.createElement('canvas');
      dbg.width = w; dbg.height = h;
      const dctx = dbg.getContext('2d')!;
      const di = dctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        if (debugMode === 'height') {
          const v = Math.max(0, Math.min(255, Math.round(height[i] * 255)));
          di.data[o] = v; di.data[o + 1] = v; di.data[o + 2] = v;
        } else if (debugMode === 'light') {
          const v = Math.max(0, Math.min(255, Math.round(((g.map.light[i] ?? 1) - 0.48) / 1.14 * 255)));
          di.data[o] = v; di.data[o + 1] = v; di.data[o + 2] = 255 - v;
        } else if (debugMode === 'cliff') {
          di.data[o] = cliff[i] ? 255 : 20; di.data[o + 1] = cliff[i] ? 80 : 20; di.data[o + 2] = 20;
        } else {
          di.data[o] = roads[i] ? 220 : 20; di.data[o + 1] = roads[i] ? 160 : 20; di.data[o + 2] = roads[i] ? 70 : 20;
        }
        di.data[o + 3] = 255;
      }
      dctx.putImageData(di, 0, 0);
      tc.imageSmoothingEnabled = false;
      tc.drawImage(dbg, 0, 0, w, h, 0, 0, c.width, c.height);
    }
    this.terrain = c;
    // Hook debug (profileur actif uniquement) : capture du terrain complet.
    if (prof.enabled && typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__terrain = c;
  }

  // ------------------------------------------------------------------- frame

  draw(g: Game, v: ViewState, dtFrame: number) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const { cam } = v;
    const z = cam.zoom;
    const theme = THEMES[g.map.theme];
    const fog = g.players[this.pov].fog;
    const revealAll = g.over;
    const mw = g.map.w;

    const sx = (wx: number) => (wx - cam.x) * z + W / 2;
    const sy = (wy: number) => (wy - cam.y) * z + H / 2;

    ctx.fillStyle = '#0a0d10';
    ctx.fillRect(0, 0, W, H);

    // ----- terrain : une seule image pré-rendue, mise à l'échelle en douceur
    if (!this.terrain) this.buildTerrain(g);
    const viewW = W / z, viewH = H / z;
    const left = cam.x - viewW / 2, top = cam.y - viewH / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    const _rt = prof.enabled ? performance.now() : 0;
    this.drawImageClamped(
      ctx, this.terrain!,
      (left + 0.5) * this.tpx, (top + 0.5) * this.tpx, viewW * this.tpx, viewH * this.tpx,
      W, H,
    );
    if (prof.enabled) prof.add('render.terrain', performance.now() - _rt);

    const tx0 = Math.max(0, Math.floor(left) - 1);
    const tx1 = Math.min(mw - 1, Math.ceil(left + viewW) + 1);
    const ty0 = Math.max(0, Math.floor(top) - 1);
    const ty1 = Math.min(g.map.h - 1, Math.ceil(top + viewH) + 1);

    // ----- EAU VIVANTE : miroitement et vaguelettes animés par frame, dessinés
    // par-dessus le terrain figé (sous les entités). Borné au viewport ; ignoré
    // en fort dézoom (invisible et inutile → coût nul sur grandes cartes).
    if (z >= 6) {
      const terr = g.map.terrain, t1 = g.time;
      const sPx = z;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const idx = ty * mw + tx;
          if (terr[idx] !== T_WATER) continue;
          if (!revealAll && fog[idx] === 0) continue;
          const px = sx(tx + 0.5), py = sy(ty + 0.5);
          // bande de lumière qui ondule lentement
          const band = 0.05 + 0.05 * Math.sin(t1 * 1.5 + tx * 0.9 + ty * 0.6);
          if (band > 0.01) {
            const yo = Math.sin(t1 * 1.05 + tx * 0.8) * sPx * 0.16;
            ctx.fillStyle = `rgba(120,170,195,${band})`;
            ctx.fillRect(px - sPx * 0.5, py - sPx * 0.08 + yo, sPx, sPx * 0.16);
          }
          // éclat spéculaire qui dérive
          const spk = Math.sin(t1 * 2.1 + (tx * 13 + ty * 7));
          if (spk > 0.86) {
            const dx = Math.sin(t1 * 0.6 + tx) * sPx * 0.28;
            const dy = Math.cos(t1 * 0.5 + ty) * sPx * 0.22;
            ctx.fillStyle = `rgba(225,245,255,${(spk - 0.86) * 4})`;
            ctx.beginPath(); ctx.arc(px + dx, py + dy, Math.max(0.8, sPx * 0.07), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    // ----- gisements : cristaux dorés (or) ou rouge sombre/bleu (minerai rare)
    for (const n of g.nodes) {
      if (n.amount < 10) continue;
      const i = n.ty * mw + n.tx;
      if (n.tx < tx0 || n.tx > tx1 || n.ty < ty0 || n.ty > ty1 || (!revealAll && fog[i] === 0)) continue;
      const px = sx(n.tx), py = sy(n.ty);
      const fill = Math.max(0.3, n.amount / n.max);
      const baseR = z * 0.46 * fill;
      const rare = n.kind === 'rare';
      const bodyCol = rare ? '#8e1f33' : theme.ore;
      const glowCol = rare ? '#3a4f8f' : theme.oreGlow;
      // ombre au sol + halo pulsant pour le minerai rare
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(px, py + z * 0.08, baseR, baseR * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      if (rare) {
        const pulse = 0.18 + 0.1 * Math.sin(g.time * 2.5 + n.id);
        ctx.fillStyle = `rgba(220,60,90,${pulse})`;
        ctx.beginPath(); ctx.arc(px, py, baseR * 1.5, 0, Math.PI * 2); ctx.fill();
      }
      // cristaux (déterministes par gisement)
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + n.id * 1.7;
        const cxk = px + Math.cos(a) * baseR * 0.5;
        const cyk = py + Math.sin(a) * baseR * 0.35;
        const hgt = baseR * (0.55 + ((n.id + k) % 3) * 0.2) * (rare ? 1.2 : 1);
        const wid = hgt * 0.45;
        ctx.fillStyle = bodyCol;
        ctx.beginPath();
        ctx.moveTo(cxk, cyk - hgt);
        ctx.lineTo(cxk + wid, cyk + hgt * 0.25);
        ctx.lineTo(cxk - wid, cyk + hgt * 0.25);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.moveTo(cxk, cyk - hgt);
        ctx.lineTo(cxk + wid * 0.35, cyk - hgt * 0.2);
        ctx.lineTo(cxk - wid * 0.1, cyk - hgt * 0.15);
        ctx.closePath(); ctx.fill();
      }
      // glint : étincelle périodique sur les cristaux
      const glint = (g.time * 0.7 + n.id * 0.37) % 1;
      if (glint < 0.12) {
        ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - glint / 0.12)})`;
        ctx.beginPath();
        ctx.arc(px + Math.cos(n.id) * baseR * 0.4, py - baseR * 0.4, Math.max(1, z * 0.06), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ----- unités en train de SORTIR d'un bâtiment : dessinées AVANT les
    // bâtiments, donc sous leur toit — elles émergent par la porte sud.
    // L'animation est purement visuelle : la position de jeu est inchangée.
    const exiting = new Set<number>();
    for (const u of g.units) {
      if (u.transportedBy) continue;
      if (u.airState || !u.exitFx) continue;
      const dur = UNITS[u.type].armor === 'inf' ? 1.0 : 0.8;
      const t = (g.time - u.exitFx.t0) / dur;
      if (t < 0 || t >= 1) continue;
      if (u.x < tx0 - 2 || u.x > tx1 + 2 || u.y < ty0 - 2 || u.y > ty1 + 2) continue;
      if (u.owner !== this.pov && !g.isVisibleTo(this.pov, u.x, u.y)) continue;
      const k = t * t * (3 - 2 * t); // lissage : démarre doucement, sort franchement
      exiting.add(u.id);
      // le centre DESSINÉ du bâtiment est décalé d'une demi-tuile (convention
      // de rendu des bâtiments) : on part de là pour émerger pile par la porte
      const ex0 = u.exitFx.x - 0.5, ey0 = u.exitFx.y - 0.5;
      this.drawUnitSprite(ctx, g, u, sx, sy, z, v.selectedUnits.includes(u.id),
        ex0 + (u.x - ex0) * k, ey0 + (u.y - ey0) * k);
    }

    // ----- bâtiments et unités au sol, triés par profondeur (peintre) :
    // en 2.5D un objet plus au sud recouvre un objet plus au nord — on trie
    // par la ligne de sol (sud de l'emprise pour un bâtiment, pied de l'unité).
    const depthBuildings: Building[] = [];
    const depthUnits: Unit[] = [];
    for (const b of g.buildings) {
      if (b.tx + b.w < tx0 || b.tx > tx1 || b.ty + b.h < ty0 - 2 || b.ty > ty1) continue;
      const ci = (b.ty + Math.floor(b.h / 2)) * mw + b.tx + Math.floor(b.w / 2);
      if (!revealAll && fog[ci] === 0) continue;
      depthBuildings.push(b);
    }
    for (const u of g.units) {
      if (u.transportedBy) continue;
      if (u.airState || exiting.has(u.id)) continue;
      if (u.x < tx0 - 1 || u.x > tx1 + 1 || u.y < ty0 - 1 || u.y > ty1 + 1) continue;
      if (!revealAll && u.owner !== this.pov && !g.isVisibleTo(this.pov, u.x, u.y)) continue;
      depthUnits.push(u);
    }
    depthBuildings.sort((a, b2) => (a.ty + a.h) - (b2.ty + b2.h));
    depthUnits.sort((a, b2) => a.y - b2.y);
    if (prof.enabled) { prof.count('render.entCount', depthBuildings.length + depthUnits.length); prof.count('render.entFrames'); }
    const _re = prof.enabled ? performance.now() : 0;
    let ui = 0;
    for (const b of depthBuildings) {
      const base = b.ty + b.h - 0.5; // ligne de sol du bâtiment dessiné
      while (ui < depthUnits.length && depthUnits[ui].y + 0.3 <= base) {
        const u = depthUnits[ui++];
        this.drawUnitSprite(ctx, g, u, sx, sy, z, v.selectedUnits.includes(u.id));
      }
      this.drawBuildingSprite(ctx, g, b, sx, sy, z, v.selectedBuilding === b.id);
    }
    while (ui < depthUnits.length) {
      const u = depthUnits[ui++];
      this.drawUnitSprite(ctx, g, u, sx, sy, z, v.selectedUnits.includes(u.id));
    }
    if (prof.enabled) prof.add('render.entities', performance.now() - _re);

    // ----- projectiles
    for (const p of g.projectiles) {
      const px = sx(p.x), py = sy(p.y);
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      if (!revealAll && !g.isVisibleTo(this.pov, p.x, p.y)) continue;
      let arcY = 0;
      if (p.indirect) arcY = Math.sin(p.t * Math.PI) * p.dist * 0.22 * z;
      if (p.kind === 'bullet' || p.kind === 'mg' || p.kind === 'sniper') {
        ctx.strokeStyle = '#ffe9a0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        const bx = (p.tx - p.sx) / p.dist, by = (p.ty - p.sy) / p.dist;
        ctx.beginPath();
        ctx.moveTo(px - bx * z * 0.3, py - by * z * 0.3);
        ctx.lineTo(px, py);
        ctx.stroke();
      } else if (p.kind === 'flak') {
        ctx.fillStyle = '#ffd3a0';
        ctx.beginPath(); ctx.arc(px, py, Math.max(1.5, z * 0.08), 0, Math.PI * 2); ctx.fill();
      } else {
        // traînée de fumée derrière les obus / roquettes
        for (let k = 1; k <= 3; k++) {
          const tt = Math.max(0, p.t - k * 0.045);
          const txp = sx(p.sx + (p.tx - p.sx) * tt);
          const typ = sy(p.sy + (p.ty - p.sy) * tt);
          const tArc = p.indirect ? Math.sin(tt * Math.PI) * p.dist * 0.22 * z : 0;
          ctx.fillStyle = `rgba(190,190,185,${0.3 - k * 0.08})`;
          ctx.beginPath(); ctx.arc(txp, typ - tArc, Math.max(1, z * (0.09 - k * 0.02)), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = p.kind === 'ap' ? '#ffb060' : '#fff3c0';
        ctx.beginPath(); ctx.arc(px, py - arcY, Math.max(2, z * 0.11), 0, Math.PI * 2); ctx.fill();
        if (p.kind === 'arty' || p.kind === 'bomb') {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.beginPath(); ctx.arc(px, py, Math.max(1, z * 0.07), 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // ----- effets
    for (const e of g.effects) {
      if (!revealAll && !g.isVisibleTo(this.pov, e.x, e.y)) continue;
      const px = sx(e.x), py = sy(e.y);
      const f = e.age / e.dur;
      if (e.kind === 'boom') {
        // onde de choc + flash chaud + cratère doux + débris incandescents.
        const hot = Math.max(0, 1 - f);
        ctx.fillStyle = `rgba(12,10,8,${0.22 * hot})`;
        ctx.beginPath(); ctx.ellipse(px + z * 0.08, py + z * 0.14, e.r * z * (0.7 + f * 1.4), e.r * z * (0.34 + f * 0.62), 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(255,238,190,${hot * 0.62})`;
        ctx.lineWidth = Math.max(1, z * 0.09 * hot);
        ctx.beginPath(); ctx.arc(px, py, e.r * z * (0.45 + f * 2.35), 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(255,110,55,${hot * 0.38})`;
        ctx.lineWidth = Math.max(1, z * 0.055 * hot);
        ctx.beginPath(); ctx.arc(px, py, e.r * z * (0.22 + f * 1.55), 0, Math.PI * 2); ctx.stroke();
        const fire = ctx.createRadialGradient(px - e.r * z * 0.12, py - e.r * z * 0.18, 0, px, py, Math.max(1, e.r * z * (0.5 + f * 1.25)));
        fire.addColorStop(0, `rgba(255,255,230,${hot * 0.92})`);
        fire.addColorStop(0.34, `rgba(255,174,55,${hot * 0.82})`);
        fire.addColorStop(0.72, `rgba(150,42,24,${hot * 0.42})`);
        fire.addColorStop(1, 'rgba(30,24,20,0)');
        ctx.fillStyle = fire;
        ctx.beginPath(); ctx.arc(px, py, e.r * z * (0.55 + f * 1.22), 0, Math.PI * 2); ctx.fill();
        // débris projetés (déterministes, avec gravité)
        const seed = Math.floor(e.x * 13 + e.y * 7);
        for (let k = 0; k < 9; k++) {
          const a = ((seed + k * 5) % 17) / 17 * Math.PI * 2;
          const sp = 1.4 + ((seed + k * 3) % 5) * 0.3;
          const dx = Math.cos(a) * f * sp * e.r * z;
          const dy = Math.sin(a) * f * sp * e.r * z * 0.7 - f * z * 0.6 + f * f * z * 2.2;
          ctx.strokeStyle = `rgba(255,${170 - Math.floor(f * 90)},70,${hot * 0.74})`;
          ctx.lineWidth = Math.max(1, z * 0.035);
          ctx.beginPath();
          ctx.moveTo(px + dx * 0.72, py + dy * 0.72);
          ctx.lineTo(px + dx, py + dy);
          ctx.stroke();
          ctx.fillStyle = `rgba(255,${190 - Math.floor(f * 120)},80,${hot})`;
          ctx.beginPath(); ctx.arc(px + dx, py + dy, Math.max(1, z * 0.055 * (1 - f * 0.5)), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = `rgba(58,54,50,${hot * 0.46})`;
        ctx.beginPath(); ctx.arc(px + Math.sin(seed) * z * 0.1, py - f * z * 0.65, e.r * z * (0.3 + f * 1.55), 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'smoke') {
        // colonne de fumée stratifiée qui s'élève et se dissipe.
        const rise = f * z * 1.8;
        for (let k = 0; k < 5; k++) {
          const kf = Math.max(0, f - k * 0.12);
          if (kf <= 0) continue;
          const wobble = Math.sin((f + k) * 5.4 + e.x * 1.7) * z * (0.14 + k * 0.035);
          ctx.fillStyle = `rgba(${44 + k * 9},${43 + k * 9},${42 + k * 9},${(1 - f) * (0.36 - k * 0.045)})`;
          ctx.beginPath();
          ctx.ellipse(
            px + wobble,
            py - rise + k * z * 0.33,
            e.r * z * (0.42 + kf * 1.35),
            e.r * z * (0.28 + kf * 0.88),
            0.2 * Math.sin(k + e.y),
            0, Math.PI * 2,
          );
          ctx.fill();
        }
      } else if (e.kind === 'flash') {
        // éclair de bouche / sabotage en étoile avec noyau chaud.
        ctx.fillStyle = `rgba(255,240,180,${1 - f})`;
        ctx.beginPath(); ctx.arc(px, py, e.r * z * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(255,250,205,${(1 - f) * 0.88})`;
        ctx.lineWidth = Math.max(1, z * 0.035);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + e.x;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * e.r * z * 0.2, py + Math.sin(a) * e.r * z * 0.2);
          ctx.lineTo(px + Math.cos(a) * e.r * z * (0.75 + (k % 2) * 0.35), py + Math.sin(a) * e.r * z * (0.75 + (k % 2) * 0.35));
          ctx.stroke();
        }
      } else if (e.kind === 'spark') {
        const seed = Math.floor(e.x * 19 + e.y * 23);
        ctx.strokeStyle = `rgba(255,214,125,${1 - f})`;
        ctx.lineWidth = Math.max(1, z * 0.03);
        for (let k = 0; k < 4; k++) {
          const a = ((seed + k * 7) % 16) / 16 * Math.PI * 2;
          const len = e.r * z * (0.65 + k * 0.22) * (1 - f);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(255,235,160,${1 - f})`;
        ctx.beginPath(); ctx.arc(px, py, Math.max(1, e.r * z * 0.55 * (1 - f)), 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'dust') {
        ctx.fillStyle = `rgba(168,158,136,${(1 - f) * 0.34})`;
        ctx.beginPath();
        ctx.ellipse(px, py - f * z * 0.35, e.r * z * (0.5 + f * 1.1), e.r * z * (0.24 + f * 0.45), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ----- unités aériennes (au-dessus de tout)
    for (const u of g.units) {
      if (u.transportedBy) continue;
      if (!u.airState) continue;
      if (!revealAll && u.owner !== this.pov && !g.isVisibleTo(this.pov, u.x, u.y)) continue;
      const flying = u.airState !== 'pad';
      const px = sx(u.x), py = sy(u.y);
      // ombre très détachée en vol : l'altitude se lit immédiatement
      ctx.fillStyle = flying ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(
        px + (flying ? z * 0.7 : z * 0.1), py + (flying ? z * 0.85 : z * 0.12),
        z * (flying ? 0.38 : 0.46), z * 0.17, 0, 0, Math.PI * 2,
      );
      ctx.fill();
      const sprA = this.unitSprites(u.type, u.owner);
      const sA = z / SPX;
      // sortie de hangar : l'appareil se matérialise sur le pad (fondu rapide)
      let aIn = 1;
      if (u.exitFx) {
        const tIn = (g.time - u.exitFx.t0) / 0.6;
        if (tIn >= 0 && tIn < 1) aIn = 0.15 + 0.85 * tIn;
      }
      const alt = flying ? z * 0.95 : z * 0.1;
      // flanc sombre sous le fuselage (volume), puis l'appareil
      for (const [img, dy] of [
        [sprA.side, alt === 0 ? 0 : -alt + z * 0.06],
        [sprA.body, -alt],
      ] as [HTMLCanvasElement, number][]) {
        ctx.save();
        ctx.globalAlpha = aIn;
        ctx.translate(px, py + dy);
        ctx.rotate(u.dir);
        ctx.scale(0.85 + 0.15 * aIn, 0.85 + 0.15 * aIn);
        ctx.drawImage(img, -img.width / 2 * sA, -img.height / 2 * sA, img.width * sA, img.height * sA);
        ctx.restore();
      }
      if (v.selectedUnits.includes(u.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, z * 0.6, 0, Math.PI * 2); ctx.stroke();
      }
      this.healthBar(ctx, px, py - z * 0.9, z * 0.9, u.hp / u.maxHp, v.selectedUnits.includes(u.id));
    }

    // ----- brouillard : image alpha 1 px/tuile, mise à l'échelle adoucie
    const _rf = prof.enabled ? performance.now() : 0;
    if (!revealAll) this.drawFog(g, ctx, left, top, viewW, viewH, W, H);
    if (prof.enabled) prof.add('render.fog', performance.now() - _rf);

    // ----- builds en attente (feedback optimiste réseau) : fantôme « chantier »
    // affiché dès le clic, avant que le round réseau ne crée le vrai bâtiment.
    for (const pb of v.pendingBuilds) {
      const def = BUILDINGS[pb.type as keyof typeof BUILDINGS];
      if (!def) continue;
      const px = sx(pb.tx - 0.5), py = sy(pb.ty - 0.5);
      const pulse = 0.28 + 0.14 * Math.sin(g.time * 5);
      ctx.fillStyle = `rgba(231,196,74,${pulse})`;
      ctx.fillRect(px, py, def.w * z, def.h * z);
      ctx.strokeStyle = 'rgba(231,196,74,0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(px, py, def.w * z, def.h * z);
      ctx.setLineDash([]);
    }

    // ----- fantôme de placement
    if (v.placing) {
      const def = BUILDINGS[v.placing as keyof typeof BUILDINGS];
      const px = sx(v.placeTx - 0.5), py = sy(v.placeTy - 0.5);
      ctx.fillStyle = v.placeValid ? 'rgba(80,220,120,0.4)' : 'rgba(230,70,60,0.4)';
      ctx.fillRect(px, py, def.w * z, def.h * z);
      ctx.strokeStyle = v.placeValid ? '#50dc78' : '#e6463c';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, def.w * z, def.h * z);
    }

    // ----- rectangle de sélection
    if (v.box) {
      ctx.strokeStyle = 'rgba(140,220,140,0.9)';
      ctx.fillStyle = 'rgba(140,220,140,0.12)';
      ctx.lineWidth = 1;
      const bx = Math.min(v.box.x0, v.box.x1), by = Math.min(v.box.y0, v.box.y1);
      const bw = Math.abs(v.box.x1 - v.box.x0), bh = Math.abs(v.box.y1 - v.box.y0);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    }

    // ----- cycle jour/nuit + ambiance
    if (g.settings.dayNight) {
      const cycle = (g.time % 240) / 240;
      const night = Math.max(0, Math.sin(cycle * Math.PI * 2 - Math.PI / 2)) * 0.32;
      if (night > 0.01) {
        ctx.fillStyle = `rgba(10,16,42,${night})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    if (theme.mist) {
      const t = g.time * 0.06;
      ctx.fillStyle = `rgba(190,200,210,${theme.mist * (0.7 + 0.3 * Math.sin(t))})`;
      ctx.fillRect(0, 0, W, H);
    }

    // ----- étalonnage : vignettage doux + lumière zénithale (rendu "caméra")
    const vg = ctx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.42, W / 2, H * 0.5, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(4,6,10,0.26)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    const tl = ctx.createLinearGradient(0, 0, 0, H);
    tl.addColorStop(0, 'rgba(255,250,235,0.045)');
    tl.addColorStop(0.45, 'rgba(0,0,0,0)');
    ctx.fillStyle = tl;
    ctx.fillRect(0, 0, W, H);

    this.drawOrderMarkers(ctx, g, v, sx, sy, z);
    this.drawCommandCursor(ctx, g, v);

    const _rm = prof.enabled ? performance.now() : 0;
    this.drawMinimap(g, v, dtFrame);
    if (prof.enabled) prof.add('render.minimap', performance.now() - _rm);
  }

  private drawOrderMarkers(
    ctx: CanvasRenderingContext2D, g: Game, v: ViewState,
    sx: (x: number) => number, sy: (y: number) => number, z: number,
  ) {
    for (const m of v.orderMarkers) {
      const age = g.time - m.t;
      const f = Math.max(0, Math.min(1, age / 0.85));
      const px = sx(m.x), py = sy(m.y);
      const attack = m.kind === 'attack';
      const harvest = m.kind === 'harvest';
      const rally = m.kind === 'rally';
      const col = attack ? '255,70,58' : harvest ? '72,220,120' : rally ? '100,190,255' : '230,238,244';
      const r = z * (0.22 + f * 0.68);
      const inner = z * (0.16 + f * 0.1);

      ctx.save();
      ctx.globalAlpha = 1 - f;
      ctx.fillStyle = `rgba(0,0,0,${0.22 * (1 - f)})`;
      ctx.beginPath();
      ctx.ellipse(px + z * 0.08, py + z * 0.1, r * 0.95, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${col},0.95)`;
      ctx.lineWidth = Math.max(1.5, z * 0.055);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.32 * (1 - f)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2, inner), 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(${col},0.72)`;
      ctx.lineWidth = Math.max(1, z * 0.04);
      if (attack) {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + f * 0.7;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r * 0.38, py + Math.sin(a) * r * 0.38);
          ctx.lineTo(px + Math.cos(a) * r * 1.18, py + Math.sin(a) * r * 1.18);
          ctx.stroke();
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r * 0.7, py + Math.sin(a) * r * 0.7);
          ctx.lineTo(px + Math.cos(a) * r * 0.98, py + Math.sin(a) * r * 0.98);
          ctx.stroke();
        }
      }
      if (rally) {
        ctx.fillStyle = `rgba(${col},0.82)`;
        ctx.beginPath();
        ctx.moveTo(px, py - r * 0.8);
        ctx.lineTo(px + r * 0.45, py);
        ctx.lineTo(px, py + r * 0.8);
        ctx.closePath();
        ctx.fill();
      }
      if (!attack && !rally) {
        ctx.strokeStyle = `rgba(${col},${0.55 * (1 - f)})`;
        ctx.lineWidth = Math.max(1.2, z * 0.045);
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + f * 1.2;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r * 0.22, py + Math.sin(a) * r * 0.22);
          ctx.lineTo(px + Math.cos(a) * r * 0.45, py + Math.sin(a) * r * 0.45);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  private drawCommandCursor(ctx: CanvasRenderingContext2D, g: Game, v: ViewState) {
    const cur = v.cursor;
    if (!cur.inside) return;
    const palette: Record<ViewState['cursor']['kind'], { rgb: string; core: string; hostile?: boolean; glow?: boolean }> = {
      default: { rgb: '220,228,232', core: '#e6edf0' },
      ore: { rgb: '76,235,130', core: '#71f39c', glow: true },
      ally: { rgb: '100,205,255', core: '#9fe0ff', glow: true },
      enemy: { rgb: '255,66,58', core: '#ff554d', hostile: true, glow: true },
      attack: { rgb: '255,84,64', core: '#ff6a52', hostile: true, glow: true },
      move: { rgb: '230,238,244', core: '#f0f5f7' },
      'place-ok': { rgb: '80,220,120', core: '#74f09a', glow: true },
      'place-bad': { rgb: '230,70,60', core: '#ff6458', hostile: true, glow: true },
    };
    const p = palette[cur.kind];
    const pulse = p.hostile ? 0.5 + 0.5 * Math.sin(g.time * 9) : 0.35 + 0.25 * Math.sin(g.time * 4);
    const r = p.hostile ? 8.5 + pulse * 1.2 : 8.5;
    const gap = 3.2;
    const len = 7.2;
    const alpha = p.hostile ? 0.86 + pulse * 0.14 : 0.88;

    ctx.save();
    ctx.translate(cur.x, cur.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (p.glow) {
      ctx.strokeStyle = `rgba(${p.rgb},${p.hostile ? 0.16 + pulse * 0.18 : 0.13})`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = `rgba(${p.rgb},${alpha})`;
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 3;
    for (const [x1, y1, x2, y2] of [
      [-r - len, 0, -gap, 0],
      [gap, 0, r + len, 0],
      [0, -r - len, 0, -gap],
      [0, gap, 0, r + len],
    ] as const) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.strokeStyle = `rgba(${p.rgb},${alpha})`;
    ctx.lineWidth = 1.35;
    for (const [x1, y1, x2, y2] of [
      [-r - len, 0, -gap, 0],
      [gap, 0, r + len, 0],
      [0, -r - len, 0, -gap],
      [0, gap, 0, r + len],
    ] as const) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.beginPath(); ctx.arc(0, 0, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.core;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();

    if (p.hostile) {
      ctx.strokeStyle = `rgba(${p.rgb},${0.28 + pulse * 0.42})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 13 + pulse * 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- brouillard

  private drawFog(
    g: Game, ctx: CanvasRenderingContext2D,
    left: number, top: number, viewW: number, viewH: number, W: number, H: number,
  ) {
    const { w, h } = g.map;
    if (!this.fogCanvas) {
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.width = w; this.fogCanvas.height = h;
      this.fogCtx = this.fogCanvas.getContext('2d')!;
      this.fogImg = this.fogCtx.createImageData(w, h);
      const d = this.fogImg.data;
      for (let i = 0; i < w * h; i++) { d[i * 4] = 8; d[i * 4 + 1] = 10; d[i * 4 + 2] = 14; }
    }
    const fog = g.players[this.pov].fog;
    const d = this.fogImg!.data;
    for (let i = 0; i < w * h; i++) {
      d[i * 4 + 3] = fog[i] === 2 ? 0 : fog[i] === 1 ? 118 : 255;
    }
    this.fogCtx!.putImageData(this.fogImg!, 0, 0);
    ctx.imageSmoothingEnabled = true;
    this.drawImageClamped(ctx, this.fogCanvas, left + 0.5, top + 0.5, viewW, viewH, W, H);
  }

  // drawImage avec rectangle source rogné aux bords de l'image : un rectangle
  // source hors limites est étiré par Safari (le brouillard "bougeait" au zoom).
  private drawImageClamped(
    ctx: CanvasRenderingContext2D, img: HTMLCanvasElement,
    srcX: number, srcY: number, srcW: number, srcH: number,
    dstW: number, dstH: number,
  ) {
    const x0 = Math.max(0, srcX), y0 = Math.max(0, srcY);
    const x1 = Math.min(img.width, srcX + srcW), y1 = Math.min(img.height, srcY + srcH);
    if (x1 <= x0 || y1 <= y0) return;
    const kx = dstW / srcW, ky = dstH / srcH;
    ctx.drawImage(
      img, x0, y0, x1 - x0, y1 - y0,
      (x0 - srcX) * kx, (y0 - srcY) * ky, (x1 - x0) * kx, (y1 - y0) * ky,
    );
  }

  // ------------------------------------------------------------------ unités

  private rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  // -------------------------------------------- sprites de bâtiments pré-cuits
  //
  // Rendu 2.5D « trois-quarts » façon Red Alert : la carte reste une grille
  // carrée vue de dessus, mais chaque bâtiment est dessiné en ÉLÉVATION —
  // façade sud visible, toit décalé vers le haut proportionnellement à la
  // hauteur, ombre portée vers le sud-est (lumière au nord-ouest). Chaque
  // bâtiment a une hauteur propre (caserne basse, usine massive, centrale à
  // tours hautes, QG imposant). Tout est cuit une fois ; gameplay inchangé.

  private buildingSpriteCache = new Map<string, HTMLCanvasElement>();
  // suivi visuel du chantier : flash d'activation à l'achèvement
  private builtFlash = new Map<number, number>();
  private constructing = new Set<number>();

  private buildingSprite(type: string, owner: number): HTMLCanvasElement {
    const key = `b:${type}:${owner}`;
    let cv = this.buildingSpriteCache.get(key);
    if (!cv) {
      cv = this.bakeBuilding(type, PLAYER_COLORS[owner]);
      this.buildingSpriteCache.set(key, cv);
    }
    return cv;
  }

  // Miniature pour le menu de construction : généré à partir du SPRITE RÉEL du
  // bâtiment (recadré sur son contenu, mis à l'échelle dans un carré) → l'icône
  // est exactement l'apparence en jeu. Renvoie un data-URL PNG, mis en cache.
  private iconCache = new Map<string, string>();
  buildingIcon(type: string, owner: number): string {
    const key = `${type}:${owner}`;
    const hit = this.iconCache.get(key);
    if (hit) return hit;
    const src = this.buildingSprite(type, owner);
    const sw = src.width, sh = src.height;
    const sc = src.getContext('2d')!;
    const data = sc.getImageData(0, 0, sw, sh).data;
    let minX = sw, minY = sh, maxX = 0, maxY = 0;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++)
        if (data[(y * sw + x) * 4 + 3] > 12) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    if (maxX < minX) { minX = 0; minY = 0; maxX = sw - 1; maxY = sh - 1; }
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const S = 96, pad = 7;
    const scale = Math.min((S - pad * 2) / cw, (S - pad * 2) / ch);
    const dw = cw * scale, dh = ch * scale;
    const out = document.createElement('canvas');
    out.width = S; out.height = S;
    const oc = out.getContext('2d')!;
    oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high';
    oc.drawImage(src, minX, minY, cw, ch, (S - dw) / 2, (S - dh) / 2 + 2, dw, dh);
    const url = out.toDataURL('image/png');
    this.iconCache.set(key, url);
    return url;
  }

  private bakeBuilding(type: string, col: string): HTMLCanvasElement {
    const B = 44; // px par tuile
    const def = BUILDINGS[type as keyof typeof BUILDINGS];
    const W = def.w * B, H = def.h * B;
    const cv = document.createElement('canvas');
    // marge horizontale 0,5 tuile de chaque côté ; verticale 1,5 tuile pour
    // les structures hautes (le sprite reste centré sur l'emprise).
    cv.width = Math.ceil((def.w + 1) * B);
    cv.height = Math.ceil((def.h + 3) * B);
    const c = cv.getContext('2d')!;
    c.translate(cv.width / 2, cv.height / 2);
    const seed = type.length * 53 + 11;
    const rng = mulberry32(seed * 5 + 2);

    const line = (x1: number, y1: number, x2: number, y2: number) => {
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    };

    // ===== NOUVELLE DA : acier blindé sombre + accents d'équipe + lumières chaudes.
    const px3 = (s: string): [number, number, number] => s.startsWith('#')
      ? [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
      : (() => { const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/); return m ? [+m[1], +m[2], +m[3]] : [128, 128, 128]; })();
    const mix = (a: string, b: string, t: number): string => {
      const A = px3(a), Bc = px3(b);
      return `rgb(${Math.round(A[0] + (Bc[0] - A[0]) * t)},${Math.round(A[1] + (Bc[1] - A[1]) * t)},${Math.round(A[2] + (Bc[2] - A[2]) * t)})`;
    };
    const STEEL = '#222831';                  // acier blindé charbon (corps dominant)
    const steel = (base: string) => mix(base, STEEL, 0.76);
    const accent = col;                       // couleur d'équipe = accent fort
    const accentDark = mix(col, '#000000', 0.32);
    // rivets aux quatre coins d'un panneau
    const rivets = (x: number, y: number, w: number, h: number, inset = 4) => {
      c.fillStyle = 'rgba(0,0,0,0.5)';
      for (const [rx, ry] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        c.beginPath(); c.arc(x + rx * (w / 2 - inset), y + ry * (h / 2 - inset), 1.3, 0, Math.PI * 2); c.fill();
      }
    };

    // ================= SOL (inchangé : dalles, marquages, clôtures…)

    const apron = (x: number, y: number, w: number, h: number, base = '#3d4248', r = 5) => {
      base = mix(base, '#2e333a', 0.58);   // béton militaire sombre (tous les socles)
      c.fillStyle = 'rgba(0,0,0,0.22)';
      this.rr(c, x - w / 2 + 2, y - h / 2 + 3, w, h, r); c.fill();
      const gr = c.createLinearGradient(0, y - h / 2, 0, y + h / 2);
      gr.addColorStop(0, shade(base, 0.07));
      gr.addColorStop(1, shade(base, -0.13));
      c.fillStyle = gr;
      this.rr(c, x - w / 2, y - h / 2, w, h, r); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.38)';
      c.lineWidth = 1.4;
      c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.13)';
      c.lineWidth = 1;
      const nx = Math.max(2, Math.round(w / 26)), ny = Math.max(2, Math.round(h / 26));
      for (let i = 1; i < nx; i++) line(x - w / 2 + (i * w) / nx, y - h / 2 + 2, x - w / 2 + (i * w) / nx, y + h / 2 - 2);
      for (let i = 1; i < ny; i++) line(x - w / 2 + 2, y - h / 2 + (i * h) / ny, x + w / 2 - 2, y - h / 2 + (i * h) / ny);
      for (let k = 0; k < 4; k++) {
        const fx = x + (rng() - 0.5) * w * 0.8, fy = y + (rng() - 0.5) * h * 0.8;
        c.strokeStyle = `rgba(0,0,0,${0.1 + rng() * 0.08})`;
        c.beginPath();
        c.moveTo(fx, fy);
        c.lineTo(fx + (rng() - 0.5) * 12, fy + (rng() - 0.5) * 12);
        c.stroke();
      }
    };

    const lane = (x1: number, y1: number, x2: number, y2: number) => {
      c.strokeStyle = 'rgba(235,238,240,0.5)';
      c.lineWidth = 2;
      c.setLineDash([6, 6]);
      line(x1, y1, x2, y2);
      c.setLineDash([]);
    };

    const fence = (x: number, y: number, w: number, h: number) => {
      c.strokeStyle = '#6e756d';
      c.lineWidth = 1.3;
      c.strokeRect(x - w / 2, y - h / 2, w, h);
      for (let i = 0; i <= 5; i++) line(x - w / 2 + (i * w) / 5, y - h / 2, x - w / 2 + (i * w) / 5, y + h / 2);
      for (let i = 0; i <= 3; i++) line(x - w / 2, y - h / 2 + (i * h) / 3, x + w / 2, y - h / 2 + (i * h) / 3);
    };

    const helipad = (x: number, y: number, r: number) => {
      c.fillStyle = '#2c3034';
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1.4;
      c.stroke();
      c.strokeStyle = 'rgba(235,238,240,0.8)';
      c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, r * 0.74, 0, Math.PI * 2); c.stroke();
      c.lineWidth = 2.4;
      line(x - r * 0.3, y - r * 0.34, x - r * 0.3, y + r * 0.34);
      line(x + r * 0.3, y - r * 0.34, x + r * 0.3, y + r * 0.34);
      line(x - r * 0.3, y, x + r * 0.3, y);
    };

    const hazard = (x: number, y: number, w: number, h: number) => {
      c.fillStyle = '#1d2126';
      c.fillRect(x - w / 2, y - h / 2, w, h);
      c.save();
      c.beginPath(); c.rect(x - w / 2, y - h / 2, w, h); c.clip();
      c.strokeStyle = '#caa536';
      c.lineWidth = Math.max(3, h * 0.35);
      for (let i = -4; i < 7; i++) {
        c.beginPath();
        c.moveTo(x - w / 2 + i * h, y + h / 2);
        c.lineTo(x - w / 2 + i * h + h * 1.4, y - h / 2);
        c.stroke();
      }
      c.restore();
    };

    const sandbags = (x: number, y: number, len: number, ang = 0) => {
      c.save(); c.translate(x, y); c.rotate(ang);
      const n = Math.max(2, Math.round(len / 7));
      for (let row = 0; row < 2; row++) {
        for (let k = 0; k < n - row; k++) {
          const bx = -len / 2 + 3.5 + k * 7 + row * 3.5;
          c.fillStyle = row ? '#9b8a60' : '#857550';
          c.beginPath(); c.ellipse(bx, -row * 2.4, 4.2, 2.6, 0, 0, Math.PI * 2); c.fill();
          c.strokeStyle = 'rgba(0,0,0,0.3)';
          c.lineWidth = 0.8;
          c.stroke();
        }
      }
      c.restore();
    };

    // ================= VOLUMES 3/4 (ombre SE + façade sud + toit surélevé)

    // boîte : empreinte au sol (x,y,w,h) montée à la hauteur e
    const volume = (
      x: number, y: number, w: number, h: number, e: number, base: string,
      opt: { r?: number; win?: number; seams?: number } = {},
    ) => {
      const r = opt.r ?? 3;
      const B = steel(base);               // corps en acier blindé sombre
      const fy = y + h / 2 - e; // haut de la façade = bord sud du toit
      // ombre portée au sol, vers le sud-est (plus dense)
      c.fillStyle = 'rgba(4,6,9,0.42)';
      this.rr(c, x - w / 2 + e * 0.5, y - h / 2 + e * 0.30, w, h, r + 4); c.fill();
      // ===== façade sud : acier sombre biseauté + panneaux blindés
      const fGr = c.createLinearGradient(0, fy, 0, fy + e);
      fGr.addColorStop(0, shade(B, 0.08));
      fGr.addColorStop(0.12, shade(B, -0.05));
      fGr.addColorStop(0.85, shade(B, -0.44));
      fGr.addColorStop(1, shade(B, -0.62));
      c.fillStyle = fGr;
      c.fillRect(x - w / 2, fy, w, e);
      const panels = Math.max(2, Math.round(w / 22));
      for (let i = 1; i < panels; i++) {
        c.strokeStyle = 'rgba(0,0,0,0.32)'; c.lineWidth = 1;
        line(x - w / 2 + (i * w) / panels, fy + 1, x - w / 2 + (i * w) / panels, fy + e - 1);
      }
      const seams = opt.seams ?? Math.max(1, Math.floor(e / 15));
      for (let i = 1; i <= seams; i++) {
        const yy = fy + (i * e) / (seams + 1);
        c.strokeStyle = 'rgba(0,0,0,0.28)'; c.lineWidth = 1; line(x - w / 2 + 1, yy, x + w / 2 - 1, yy);
        c.strokeStyle = 'rgba(255,255,255,0.05)'; line(x - w / 2 + 1, yy + 1, x + w / 2 - 1, yy + 1);
      }
      // ===== fenêtres CHAUDES émissives (rangées) avec halo — lecture « vivant »
      if (opt.win) {
        const rows = e > 34 ? 2 : 1;
        for (let rw = 0; rw < rows; rw++) {
          const wy = fy + e * (0.2 + rw * 0.34);
          const wh = Math.max(4, Math.min(8, e * 0.2));
          for (let i = 0; i < opt.win; i++) {
            const wx = x - w / 2 + ((i + 0.5) * w) / opt.win - 2.8;
            c.fillStyle = 'rgba(255,150,40,0.30)'; c.fillRect(wx - 3, wy - 3, 11, wh + 6);
            c.fillStyle = 'rgba(255,170,60,0.6)'; c.fillRect(wx - 1, wy - 1, 7, wh + 2);
            c.fillStyle = 'rgba(255,210,128,1)'; c.fillRect(wx, wy, 5, wh);
            c.fillStyle = 'rgba(255,245,220,1)'; c.fillRect(wx + 1.2, wy, 1.6, wh);
          }
        }
      }
      // bande d'accent d'équipe en pied de façade
      const ab = Math.max(3, e * 0.1);
      c.fillStyle = accentDark; c.fillRect(x - w / 2, fy + e - ab, w, ab);
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(x - w / 2, fy + e - ab, w, 1);
      // plinthe + liseré est (profondeur)
      c.fillStyle = 'rgba(0,0,0,0.4)';
      c.fillRect(x - w / 2, y + h / 2 - 3, w, 3);
      c.fillStyle = 'rgba(0,0,0,0.32)';
      c.fillRect(x + w / 2 - Math.max(2, e * 0.08), fy, Math.max(2, e * 0.08), e);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.3;
      c.strokeRect(x - w / 2, fy, w, e);
      // ===== toit : acier sombre, panneaux, chevron d'équipe, rivets, témoin
      const roof = c.createLinearGradient(0, y - h / 2 - e, 0, y + h / 2 - e);
      roof.addColorStop(0, shade(B, 0.24));
      roof.addColorStop(0.5, shade(B, 0.0));
      roof.addColorStop(1, shade(B, -0.18));
      c.fillStyle = roof;
      this.rr(c, x - w / 2, y - h / 2 - e, w, h, r); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 1;
      for (let i = 1; i < panels; i++) line(x - w / 2 + (i * w) / panels, y - h / 2 - e + 2, x - w / 2 + (i * w) / panels, y + h / 2 - e - 2);
      // chevron d'accent d'équipe (lecture immédiate de la faction)
      const cs = Math.min(w, h) * 0.17, cyr = y - e;
      c.fillStyle = accent;
      c.beginPath();
      c.moveTo(x - cs, cyr + cs * 0.55); c.lineTo(x, cyr - cs * 0.5); c.lineTo(x + cs, cyr + cs * 0.55);
      c.lineTo(x + cs * 0.5, cyr + cs * 0.55); c.lineTo(x, cyr + cs * 0.02); c.lineTo(x - cs * 0.5, cyr + cs * 0.55);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.6)';
      c.lineWidth = 1.6;
      this.rr(c, x - w / 2, y - h / 2 - e, w, h, r); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.42)';
      c.lineWidth = 1.4;
      line(x - w / 2 + r, fy, x + w / 2 - r, fy);
      rivets(x, y - e, w, h, 5);
      // bloc d'équipement + témoin rouge clignotant
      c.fillStyle = shade(B, -0.22); c.fillRect(x + w * 0.18, y - e - 3, 7, 6);
      c.fillStyle = 'rgba(255,90,74,0.95)'; c.beginPath(); c.arc(x + w * 0.18 + 3.5, y - e - 3, 1.4, 0, Math.PI * 2); c.fill();
    };

    // baraquement à toit deux pans : façade + pan sud clair + pan nord sombre
    const gableVol = (x: number, y: number, w: number, h: number, e: number, base: string) => {
      base = steel(base);
      const fy = y + h / 2 - e;
      c.fillStyle = 'rgba(8,10,8,0.30)';
      this.rr(c, x - w / 2 + e * 0.5, y - h / 2 + e * 0.26, w, h, 4); c.fill();
      const fGr = c.createLinearGradient(0, fy, 0, fy + e);
      fGr.addColorStop(0, shade(base, -0.05));
      fGr.addColorStop(1, shade(base, -0.5));
      c.fillStyle = fGr;
      c.fillRect(x - w / 2, fy, w, e);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(x - w / 2, y + h / 2 - 2.5, w, 2.5);
      // pans de toit (faîtage est-ouest)
      c.fillStyle = shade(base, 0.26);
      c.fillRect(x - w / 2, fy - h * 0.55, w, h * 0.55);
      c.fillStyle = shade(base, -0.06);
      c.fillRect(x - w / 2, fy - h, w, h * 0.45);
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.lineWidth = 1.6;
      line(x - w / 2 + 1, fy - h * 0.55, x + w / 2 - 1, fy - h * 0.55);
      c.strokeStyle = 'rgba(0,0,0,0.2)';
      c.lineWidth = 1;
      const n = Math.max(3, Math.floor(w / 10));
      for (let i = 1; i < n; i++) line(x - w / 2 + (i * w) / n, fy - h, x - w / 2 + (i * w) / n, fy);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.4;
      c.strokeRect(x - w / 2, fy - h, w, h + e);
    };

    // cylindre vertical (cuve, cheminée, tour) — pied au sol en (x,y)
    const cyl = (x: number, y: number, rad: number, e: number, base: string, mouth = 0, band = false) => {
      base = mix(base, STEEL, 0.42);
      c.fillStyle = 'rgba(8,10,8,0.30)';
      c.beginPath(); c.ellipse(x + e * 0.4, y + e * 0.16, rad * 1.05, rad * 0.5, 0, 0, Math.PI * 2); c.fill();
      const gr = c.createLinearGradient(x - rad, 0, x + rad, 0);
      gr.addColorStop(0, shade(base, -0.45));
      gr.addColorStop(0.3, shade(base, 0.3));
      gr.addColorStop(0.55, base);
      gr.addColorStop(1, shade(base, -0.5));
      c.fillStyle = gr;
      c.fillRect(x - rad, y - e, rad * 2, e);
      if (band) {
        c.fillStyle = '#b8413a';
        c.fillRect(x - rad, y - e * 0.84, rad * 2, Math.max(3, e * 0.07));
      }
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.beginPath(); c.ellipse(x, y, rad, rad * 0.42, 0, 0, Math.PI); c.fill();
      const top = c.createRadialGradient(x - rad * 0.3, y - e - rad * 0.15, rad * 0.1, x, y - e, rad);
      top.addColorStop(0, shade(base, 0.4));
      top.addColorStop(1, shade(base, -0.15));
      c.fillStyle = top;
      c.beginPath(); c.ellipse(x, y - e, rad, rad * 0.45, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.4;
      c.stroke();
      if (mouth > 0) {
        c.fillStyle = '#101317';
        c.beginPath(); c.ellipse(x, y - e, rad * mouth, rad * mouth * 0.45, 0, 0, Math.PI * 2); c.fill();
      }
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1.2;
      line(x - rad, y - e, x - rad, y);
      line(x + rad, y - e, x + rad, y);
    };

    // aéroréfrigérant : silhouette évasée, gorge sombre fumante
    const coolTower = (x: number, y: number, rad: number, e: number) => {
      c.fillStyle = 'rgba(8,10,8,0.30)';
      c.beginPath(); c.ellipse(x + e * 0.36, y + e * 0.15, rad * 1.12, rad * 0.5, 0, 0, Math.PI * 2); c.fill();
      const w1 = rad * 0.7, w2 = rad * 0.86;
      const yT = y - e, yW = y - e * 0.42;
      const gr = c.createLinearGradient(x - rad, 0, x + rad, 0);
      gr.addColorStop(0, '#5d6266');
      gr.addColorStop(0.32, '#b9bec1');
      gr.addColorStop(0.6, '#9aa0a3');
      gr.addColorStop(1, '#4c5155');
      c.fillStyle = gr;
      c.beginPath();
      c.moveTo(x - rad, y);
      c.quadraticCurveTo(x - w1, yW, x - w2, yT);
      c.lineTo(x + w2, yT);
      c.quadraticCurveTo(x + w1, yW, x + rad, y);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1.4;
      c.stroke();
      // nervures verticales du béton
      c.strokeStyle = 'rgba(0,0,0,0.14)';
      c.lineWidth = 1;
      for (let i = 1; i < 6; i++) {
        const f = i / 6;
        c.beginPath();
        c.moveTo(x - rad + f * rad * 2, y);
        c.quadraticCurveTo(x - w1 + f * w1 * 2, yW, x - w2 + f * w2 * 2, yT);
        c.stroke();
      }
      c.fillStyle = '#262b2e';
      c.beginPath(); c.ellipse(x, yT, w2, w2 * 0.32, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.4)';
      c.lineWidth = 1.6;
      c.beginPath(); c.ellipse(x, yT, w2, w2 * 0.32, 0, Math.PI, Math.PI * 2); c.stroke();
      c.fillStyle = '#0f1316';
      c.beginPath(); c.ellipse(x, yT, w2 * 0.76, w2 * 0.24, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.beginPath(); c.ellipse(x, y, rad, rad * 0.4, 0, 0, Math.PI); c.fill();
    };

    // citerne horizontale couchée est-ouest, posée au sol en y
    const hTankV = (x: number, y: number, len: number, dia: number, base: string) => {
      base = mix(base, STEEL, 0.4);
      c.fillStyle = 'rgba(8,10,8,0.30)';
      this.rr(c, x - len / 2 + dia * 0.3, y - dia * 0.2, len, dia * 0.55, dia * 0.27); c.fill();
      const gr = c.createLinearGradient(0, y - dia, 0, y);
      gr.addColorStop(0, shade(base, 0.42));
      gr.addColorStop(0.45, base);
      gr.addColorStop(1, shade(base, -0.5));
      c.fillStyle = gr;
      this.rr(c, x - len / 2, y - dia, len, dia, dia / 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.4;
      c.stroke();
      // calotte est + anneaux de renfort
      c.fillStyle = 'rgba(0,0,0,0.2)';
      c.beginPath(); c.ellipse(x + len / 2 - dia * 0.18, y - dia / 2, dia * 0.16, dia * 0.48, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.25)';
      c.lineWidth = 1.4;
      for (const f of [-0.22, 0, 0.22]) line(x + len * f, y - dia + 1, x + len * f, y - 1);
      // berceaux
      c.fillStyle = '#23272b';
      c.fillRect(x - len * 0.32, y - 2, len * 0.1, 4);
      c.fillRect(x + len * 0.24, y - 2, len * 0.1, 4);
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = 1.2;
      line(x - len / 2 + dia * 0.4, y - dia * 0.82, x + len / 2 - dia * 0.4, y - dia * 0.82);
    };

    // colonne de distillation : cylindre haut et fin à passerelles
    const column = (x: number, y: number, rad: number, e: number) => {
      cyl(x, y, rad, e, '#8a939c');
      c.strokeStyle = '#1d2126';
      c.lineWidth = 2;
      for (let i = 1; i <= 3; i++) line(x - rad * 1.5, y - (i * e) / 4, x + rad * 1.5, y - (i * e) / 4);
      c.fillStyle = '#1d2126';
      c.fillRect(x - 2, y - e - 6, 4, 6);
    };

    // mirador sur pilotis
    const stiltCabin = (x: number, y: number, s: number, e: number) => {
      c.fillStyle = 'rgba(8,10,8,0.26)';
      c.beginPath(); c.ellipse(x + e * 0.3, y + 2, s * 0.5, s * 0.22, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#23282c';
      c.lineWidth = 2;
      line(x - s * 0.3, y, x - s * 0.2, y - e);
      line(x + s * 0.3, y, x + s * 0.2, y - e);
      c.lineWidth = 1.2;
      line(x - s * 0.26, y - e * 0.45, x + s * 0.26, y - e * 0.6);
      // cabine
      const cw = s * 0.84, ch = s * 0.5;
      c.fillStyle = shade('#555c61', -0.3);
      c.fillRect(x - cw / 2, y - e - ch * 0.4, cw, ch);
      c.fillStyle = '#171b1f';
      c.fillRect(x - cw * 0.34, y - e - ch * 0.2, cw * 0.68, ch * 0.34);
      c.fillStyle = shade('#555c61', 0.2);
      c.fillRect(x - cw * 0.56, y - e - ch * 0.55, cw * 1.12, ch * 0.26);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.2;
      c.strokeRect(x - cw / 2, y - e - ch * 0.4, cw, ch);
    };

    // portique roulant : jambes en A + poutre jaune en hauteur
    const gantryVol = (x: number, y: number, span: number, e: number) => {
      c.fillStyle = 'rgba(8,10,8,0.18)';
      c.fillRect(x - span / 2 + e * 0.4, y + e * 0.14, span, 5);
      for (const sx2 of [-span / 2, span / 2]) {
        c.strokeStyle = '#262b30';
        c.lineWidth = 3;
        line(x + sx2 - 7, y, x + sx2, y - e + 4);
        line(x + sx2 + 7, y, x + sx2, y - e + 4);
        c.lineWidth = 1.3;
        line(x + sx2 - 5, y - e * 0.45, x + sx2 + 5, y - e * 0.45);
      }
      const gr = c.createLinearGradient(0, y - e - 5, 0, y - e + 5);
      gr.addColorStop(0, '#e3b94b');
      gr.addColorStop(1, '#8f6f1e');
      c.fillStyle = gr;
      c.fillRect(x - span / 2 - 8, y - e - 5, span + 16, 10);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.4;
      c.strokeRect(x - span / 2 - 8, y - e - 5, span + 16, 10);
      // chariot + câble + crochet
      const xT = x + span * 0.18;
      c.fillStyle = '#1d2126';
      c.fillRect(xT - 6, y - e - 8, 12, 16);
      c.strokeStyle = '#1d2126';
      c.lineWidth = 1.6;
      line(xT, y - e + 8, xT, y - e * 0.4);
      c.beginPath(); c.arc(xT, y - e * 0.4 + 3, 2.6, 0, Math.PI * 2); c.fill();
    };

    // ================= DÉTAILS

    const door = (x: number, y: number, w: number, h: number, accent = '#caa536') => {
      const gr = c.createLinearGradient(0, y - h / 2, 0, y + h / 2);
      gr.addColorStop(0, '#23282d');
      gr.addColorStop(1, '#0f1215');
      c.fillStyle = gr;
      this.rr(c, x - w / 2, y - h / 2, w, h, 2); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.18)';
      c.lineWidth = 1;
      for (let i = 1; i < 4; i++) line(x - w / 2 + 2, y - h / 2 + (i * h) / 4, x + w / 2 - 2, y - h / 2 + (i * h) / 4);
      c.fillStyle = accent;
      c.fillRect(x - w / 2, y + h / 2 - 3, w, 3);
    };

    const antenna = (x: number, y: number, h: number, r = 10) => {
      c.strokeStyle = '#c5ced6';
      c.lineWidth = 2;
      line(x, y, x, y - h);
      c.strokeStyle = 'rgba(205,215,220,0.5)';
      c.lineWidth = 1.4;
      line(x - r * 0.7, y - h * 0.62, x + r * 0.7, y - h * 0.7);
      line(x - r * 0.55, y - h * 0.8, x + r * 0.55, y - h * 0.88);
      c.fillStyle = '#e0344a';
      c.beginPath(); c.arc(x, y - h, 2.2, 0, Math.PI * 2); c.fill();
    };

    const dish = (x: number, y: number, r: number, a = -0.35) => {
      c.save();
      c.translate(x, y); c.rotate(a);
      c.fillStyle = '#242a30';
      c.beginPath(); c.ellipse(0, 0, r, r * 0.45, 0, Math.PI * 0.15, Math.PI * 1.85); c.fill();
      c.strokeStyle = '#c5ced6';
      c.lineWidth = 2;
      c.stroke();
      c.strokeStyle = 'rgba(205,215,220,0.36)';
      c.lineWidth = 1;
      line(-r * 0.55, -r * 0.16, r * 0.55, r * 0.16);
      line(-r * 0.35, r * 0.18, r * 0.35, -r * 0.18);
      c.restore();
    };

    const roofVents = (x: number, y: number, w: number, n: number) => {
      c.strokeStyle = 'rgba(0,0,0,0.24)';
      c.lineWidth = 1;
      for (let i = 1; i < n; i++) line(x - w / 2 + (i * w) / n, y - 4, x - w / 2 + (i * w) / n, y + 4);
    };

    const container = (x: number, y: number, w: number, h: number, color: string, lift = 0) => {
      c.fillStyle = 'rgba(8,10,8,0.28)';
      c.fillRect(x - w / 2 + 3, y - h / 2 + 3, w, h);
      const e2 = 5 + lift;
      const fGr = c.createLinearGradient(0, y + h / 2 - e2, 0, y + h / 2);
      fGr.addColorStop(0, shade(color, -0.1));
      fGr.addColorStop(1, shade(color, -0.45));
      c.fillStyle = fGr;
      c.fillRect(x - w / 2, y + h / 2 - e2 - lift, w, e2);
      const gr = c.createLinearGradient(0, y - h / 2 - e2 - lift, 0, y + h / 2 - e2 - lift);
      gr.addColorStop(0, shade(color, 0.25));
      gr.addColorStop(1, shade(color, -0.1));
      c.fillStyle = gr;
      c.fillRect(x - w / 2, y - h / 2 - e2 - lift, w, h);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 1.1;
      c.strokeRect(x - w / 2, y - h / 2 - e2 - lift, w, h + e2);
      c.strokeStyle = 'rgba(0,0,0,0.22)';
      c.lineWidth = 1;
      const n = Math.max(3, Math.floor(w / 5));
      for (let i = 1; i < n; i++) line(x - w / 2 + (i * w) / n, y - h / 2 - e2 - lift + 1, x - w / 2 + (i * w) / n, y + h / 2 - e2 - lift - 1);
    };

    const flag = (x: number, y: number, hgt: number) => {
      c.strokeStyle = '#1d2126';
      c.lineWidth = 1.8;
      line(x, y, x, y - hgt);
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(x, y - hgt);
      c.lineTo(x + hgt * 0.55, y - hgt + hgt * 0.16);
      c.lineTo(x, y - hgt + hgt * 0.32);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = 1;
      c.stroke();
    };

    const star = (x: number, y: number, r: number, color = 'rgba(240,243,245,0.8)') => {
      c.fillStyle = color;
      c.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rk = k % 2 === 0 ? r : r * 0.42;
        if (k === 0) c.moveTo(x + Math.cos(a) * rk, y + Math.sin(a) * rk);
        else c.lineTo(x + Math.cos(a) * rk, y + Math.sin(a) * rk);
      }
      c.closePath();
      c.fill();
    };

    const teamMark = (x: number, y: number, w: number, h: number) => {
      c.fillStyle = shade(col, -0.1);
      c.fillRect(x - w / 2, y - h / 2, w, h);
      c.strokeStyle = 'rgba(0,0,0,0.4)';
      c.lineWidth = 1;
      c.strokeRect(x - w / 2, y - h / 2, w, h);
    };

    const glass = (x: number, y: number, w: number, h: number, warm = false) => {
      const gr = c.createLinearGradient(0, y - h / 2, 0, y + h / 2);
      if (warm) { gr.addColorStop(0, '#e8d49a'); gr.addColorStop(1, '#8a7340'); }
      else { gr.addColorStop(0, '#3a4148'); gr.addColorStop(1, '#15181c'); }
      c.fillStyle = gr;
      this.rr(c, x - w / 2, y - h / 2, w, h, 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1;
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.25)';
      const n = Math.max(2, Math.floor(w / 8));
      for (let i = 1; i < n; i++) line(x - w / 2 + (i * w) / n, y - h / 2 + 1, x - w / 2 + (i * w) / n, y + h / 2 - 1);
    };

    const pipe = (x1: number, y1: number, x2: number, y2: number, wd: number, bend = 0) => {
      c.strokeStyle = 'rgba(0,0,0,0.35)';
      c.lineWidth = wd + 2;
      c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo((x1 + x2) / 2 + bend, (y1 + y2) / 2 - bend, x2, y2); c.stroke();
      c.strokeStyle = '#7d8790';
      c.lineWidth = wd;
      c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo((x1 + x2) / 2 + bend, (y1 + y2) / 2 - bend, x2, y2); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.3)';
      c.lineWidth = Math.max(1, wd * 0.3);
      c.beginPath(); c.moveTo(x1, y1 - wd * 0.22); c.quadraticCurveTo((x1 + x2) / 2 + bend, (y1 + y2) / 2 - bend - wd * 0.22, x2, y2 - wd * 0.22); c.stroke();
    };

    const truck = (x: number, y: number, s: number, ang = 0) => {
      c.save(); c.translate(x, y); c.rotate(ang);
      c.fillStyle = 'rgba(8,10,8,0.3)';
      c.fillRect(-s * 0.5 + 2, -s * 0.22 + 3, s, s * 0.44);
      c.fillStyle = '#3f4a3a';
      c.fillRect(-s * 0.5, -s * 0.26, s * 0.3, s * 0.44);
      c.fillStyle = '#6d6450';
      c.fillRect(-s * 0.16, -s * 0.24, s * 0.64, s * 0.4);
      c.fillStyle = 'rgba(255,255,255,0.18)';
      c.fillRect(-s * 0.16, -s * 0.24, s * 0.64, s * 0.1);
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1;
      c.strokeRect(-s * 0.16, -s * 0.24, s * 0.64, s * 0.4);
      c.strokeRect(-s * 0.5, -s * 0.26, s * 0.3, s * 0.44);
      c.restore();
    };

    const pumpjack = (x: number, y: number, s: number) => {
      c.fillStyle = 'rgba(8,10,8,0.26)';
      c.beginPath(); c.ellipse(x + s * 0.12, y + s * 0.24, s * 0.45, s * 0.14, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#20252a';
      c.lineWidth = Math.max(2.5, s * 0.09);
      c.beginPath(); c.moveTo(x - s * 0.34, y + s * 0.22); c.lineTo(x, y - s * 0.3); c.lineTo(x + s * 0.34, y + s * 0.22); c.stroke();
      c.strokeStyle = '#6f7882';
      c.lineWidth = Math.max(3.5, s * 0.12);
      line(x - s * 0.3, y - s * 0.22, x + s * 0.4, y - s * 0.36);
      c.fillStyle = '#2b3137';
      c.beginPath(); c.arc(x + s * 0.44, y - s * 0.36, s * 0.09, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#20252a';
      c.lineWidth = Math.max(1.6, s * 0.05);
      line(x + s * 0.44, y - s * 0.27, x + s * 0.44, y + s * 0.25);
    };

    const flare = (x: number, y: number, hgt: number) => {
      c.strokeStyle = '#5d646a';
      c.lineWidth = 2.4;
      line(x, y, x, y - hgt);
      c.strokeStyle = 'rgba(0,0,0,0.4)';
      c.lineWidth = 1;
      line(x - 5, y, x, y - hgt * 0.5);
      line(x + 5, y, x, y - hgt * 0.5);
      c.fillStyle = '#2a2f34';
      c.fillRect(x - 2.5, y - hgt - 4, 5, 5);
    };

    const octPath = (x: number, y: number, r: number) => {
      c.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        if (k === 0) c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        else c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      c.closePath();
    };

    // poussière et usure du sol (très léger, ancre le bâtiment)
    const rngPad = mulberry32(seed * 3 + 1);
    for (let k = 0; k < 5; k++) {
      const ex = (rngPad() - 0.5) * W * 0.8;
      const ey = (rngPad() - 0.5) * H * 0.8;
      const er = W * (0.2 + rngPad() * 0.25);
      c.fillStyle = `rgba(28,24,18,${0.1 + rngPad() * 0.08})`;
      c.beginPath();
      c.ellipse(ex, ey, er, er * (0.5 + rngPad() * 0.3), rngPad() * 3, 0, Math.PI * 2);
      c.fill();
    }

    const industrialBlock = (x: number, y: number, w: number, h: number, e: number, base: string) => {
      base = steel(base);
      const fy = y + h / 2 - e;
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(x - w / 2 + e * 0.28, y - h / 2 + e * 0.16, w, h);
      c.fillStyle = shade(base, -0.48);
      c.fillRect(x - w / 2, fy, w, e);
      c.fillStyle = shade(base, -0.68);
      c.fillRect(x + w / 2 - Math.max(3, e * 0.12), fy, Math.max(3, e * 0.12), e);
      const top = c.createLinearGradient(0, y - h / 2 - e, 0, y + h / 2 - e);
      top.addColorStop(0, shade(base, 0.2));
      top.addColorStop(0.55, shade(base, -0.02));
      top.addColorStop(1, shade(base, -0.25));
      c.fillStyle = top;
      c.fillRect(x - w / 2, y - h / 2 - e, w, h);
      c.strokeStyle = 'rgba(0,0,0,0.68)';
      c.lineWidth = 1.4;
      c.strokeRect(x - w / 2, fy, w, e);
      c.strokeRect(x - w / 2, y - h / 2 - e, w, h);
      c.strokeStyle = 'rgba(230,224,190,0.12)';
      c.lineWidth = 1;
      line(x - w / 2 + 2, y - h / 2 - e + 2, x + w / 2 - 2, y - h / 2 - e + 2);
    };

    const techPlate = (x: number, y: number, w: number, h: number, base = '#20261f') => {
      c.fillStyle = base;
      c.fillRect(x - w / 2, y - h / 2, w, h);
      c.strokeStyle = 'rgba(0,0,0,0.68)';
      c.lineWidth = 1.1;
      c.strokeRect(x - w / 2, y - h / 2, w, h);
      c.strokeStyle = 'rgba(230,224,190,0.12)';
      c.lineWidth = 1;
      line(x - w / 2 + 1, y - h / 2 + 1, x + w / 2 - 1, y - h / 2 + 1);
    };

    const ventPanel = (x: number, y: number, w: number, h: number, n = 5) => {
      techPlate(x, y, w, h, '#121714');
      c.strokeStyle = 'rgba(130,136,124,0.58)';
      c.lineWidth = 1;
      for (let i = 1; i < n; i++) line(x - w / 2 + (i * w) / n, y - h / 2 + 2, x - w / 2 + (i * w) / n, y + h / 2 - 2);
    };

    const tinyRivets = (x: number, y: number, w: number, n: number) => {
      c.fillStyle = 'rgba(218,211,178,0.2)';
      for (let i = 0; i < n; i++) {
        c.beginPath();
        c.arc(x - w / 2 + ((i + 0.5) * w) / n, y, 1, 0, Math.PI * 2);
        c.fill();
      }
    };

    const warmLamp = (x: number, y: number, r = 1.9) => {
      c.fillStyle = 'rgba(255,174,64,0.1)';
      c.beginPath(); c.arc(x, y, r * 2.7, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#d79a42';
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    };

    const grimeStreaks = (x: number, y: number, w: number, h: number, seedOffset: number, count: number) => {
      const r2 = mulberry32(seed * 31 + seedOffset);
      for (let i = 0; i < count; i++) {
        const sx2 = x - w / 2 + r2() * w;
        const sy2 = y - h / 2 + r2() * h;
        c.strokeStyle = `rgba(12,10,7,${0.14 + r2() * 0.14})`;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(sx2, sy2);
        c.lineTo(sx2 + (r2() - 0.5) * w * 0.08, sy2 + (r2() - 0.5) * h * 0.05);
        c.stroke();
      }
    };

    // ---- une silhouette et une HAUTEUR uniques par bâtiment
    switch (type) {
      // ============ QG : forteresse de commandement inspirée de la référence
      case 'hq': {
        const trim = '#b88f34';
        const slab = (pts: [number, number][], fill: string, stroke = 'rgba(0,0,0,0.52)') => {
          c.fillStyle = fill;
          c.beginPath();
          c.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
          c.closePath();
          c.fill();
          c.strokeStyle = stroke;
          c.lineWidth = 1.4;
          c.stroke();
        };
        const hardBlock = (x: number, y: number, w: number, d: number, e: number, base: string) => {
          const fy = y + d / 2 - e;
          c.fillStyle = 'rgba(0,0,0,0.34)';
          c.fillRect(x - w / 2 + e * 0.32, y - d / 2 + e * 0.18, w, d);

          c.fillStyle = shade(base, -0.48);
          c.fillRect(x - w / 2, fy, w, e);
          c.fillStyle = shade(base, -0.68);
          c.fillRect(x + w / 2 - Math.max(4, e * 0.12), fy, Math.max(4, e * 0.12), e);

          const top = c.createLinearGradient(0, y - d / 2 - e, 0, y + d / 2 - e);
          top.addColorStop(0, shade(base, 0.22));
          top.addColorStop(0.48, shade(base, 0.02));
          top.addColorStop(1, shade(base, -0.22));
          c.fillStyle = top;
          c.fillRect(x - w / 2, y - d / 2 - e, w, d);

          c.strokeStyle = 'rgba(0,0,0,0.72)';
          c.lineWidth = 1.6;
          c.strokeRect(x - w / 2, fy, w, e);
          c.strokeRect(x - w / 2, y - d / 2 - e, w, d);

          c.strokeStyle = 'rgba(230,224,190,0.13)';
          c.lineWidth = 1;
          line(x - w / 2 + 2, y - d / 2 - e + 2, x + w / 2 - 2, y - d / 2 - e + 2);
        };
        const platePanel = (x: number, y: number, w: number, h: number, base = '#252b25') => {
          c.fillStyle = base;
          c.fillRect(x - w / 2, y - h / 2, w, h);
          c.strokeStyle = 'rgba(0,0,0,0.7)';
          c.lineWidth = 1.1;
          c.strokeRect(x - w / 2, y - h / 2, w, h);
          c.strokeStyle = 'rgba(230,224,190,0.12)';
          c.lineWidth = 1;
          line(x - w / 2 + 1, y - h / 2 + 1, x + w / 2 - 1, y - h / 2 + 1);
        };
        const rivets = (x: number, y: number, w: number, n: number) => {
          c.fillStyle = 'rgba(218,211,178,0.22)';
          for (let i = 0; i < n; i++) {
            c.beginPath();
            c.arc(x - w / 2 + ((i + 0.5) * w) / n, y, 1.1, 0, Math.PI * 2);
            c.fill();
          }
        };
        const light = (x: number, y: number, r = 2.2) => {
          c.fillStyle = 'rgba(255,174,64,0.1)';
          c.beginPath(); c.arc(x, y, r * 2.8, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#d79a42';
          c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        };
        const vent = (x: number, y: number, w: number, h: number, n = 5) => {
          platePanel(x, y, w, h, '#121714');
          c.strokeStyle = 'rgba(125,132,120,0.6)';
          c.lineWidth = 1;
          for (let i = 1; i < n; i++) line(x - w / 2 + (i * w) / n, y - h / 2 + 2, x - w / 2 + (i * w) / n, y + h / 2 - 2);
        };
        const stair = (x: number, y: number, w: number, h: number) => {
          slab([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w * 0.35, y + h / 2], [x - w * 0.35, y + h / 2]], '#242a26');
          c.strokeStyle = 'rgba(210,205,175,0.24)';
          c.lineWidth = 1;
          for (let i = 1; i < 5; i++) {
            const yy = y - h / 2 + (i * h) / 5;
            line(x - w / 2 + i * w * 0.03, yy, x + w / 2 - i * w * 0.03, yy);
          }
        };

        // Dalle découpée et sale, proche d'une base industrielle lourde.
        slab([
          [-W * 0.52, -H * 0.14], [-W * 0.42, -H * 0.34], [W * 0.46, -H * 0.34],
          [W * 0.52, H * 0.18], [W * 0.4, H * 0.33], [W * 0.22, H * 0.33],
          [W * 0.17, H * 0.49], [-W * 0.17, H * 0.49], [-W * 0.22, H * 0.33],
          [-W * 0.52, H * 0.32],
        ], '#3f433e');
        c.fillStyle = 'rgba(18,15,12,0.18)';
        for (const [gx, gy, gw, gh] of [
          [-0.38, 0.25, 0.16, 0.07], [0.28, 0.25, 0.18, 0.08], [0.02, -0.29, 0.24, 0.05],
          [-0.12, 0.39, 0.16, 0.035], [0.22, -0.24, 0.18, 0.04],
        ] as const) c.fillRect(W * gx, H * gy, W * gw, H * gh);
        lane(0, H * 0.48, W * 0.3, H * 0.58);
        c.strokeStyle = 'rgba(184,143,52,0.5)';
        c.lineWidth = 1.4;
        line(-W * 0.42, H * 0.31, W * 0.42, H * 0.31);
        line(-W * 0.4, -H * 0.29, W * 0.4, -H * 0.29);

        // Corps bas : volumes nets sans arrondis, plus béton/métal.
        hardBlock(-W * 0.27, H * 0.1, W * 0.29, H * 0.46, H * 0.31, '#30362f');
        hardBlock(W * 0.27, H * 0.1, W * 0.29, H * 0.46, H * 0.31, '#2e352e');
        hardBlock(0, H * 0.16, W * 0.58, H * 0.46, H * 0.38, '#3a4038');

        // Façade principale : blindage, porte, escaliers, lumière et marquage.
        door(0, H * 0.39, W * 0.25, H * 0.18, trim);
        stair(0, H * 0.49, W * 0.2, H * 0.16);
        slab([[-W * 0.18, H * 0.25], [W * 0.18, H * 0.25], [W * 0.12, H * 0.34], [-W * 0.12, H * 0.34]], '#171c18');
        teamMark(0, H * 0.28, W * 0.31, 5);
        light(-W * 0.16, H * 0.34);
        light(W * 0.16, H * 0.34);
        hazard(0, H * 0.52, W * 0.28, 5);

        // Casser les grands aplats : contreforts, trappes, fenêtres, rivets.
        for (const x2 of [-0.38, -0.25, -0.14, 0.14, 0.25, 0.38]) {
          platePanel(W * x2, H * 0.19, W * 0.075, H * 0.26, '#20261f');
          rivets(W * x2, H * 0.07, W * 0.055, 3);
          c.fillStyle = 'rgba(255,180,75,0.55)';
          c.fillRect(W * x2 - W * 0.025, H * 0.12, W * 0.05, 4);
        }
        for (const [px2, py2, ww, hh] of [
          [-0.34, -0.04, 0.1, 0.055], [-0.23, -0.06, 0.085, 0.045], [0.22, -0.06, 0.1, 0.045],
          [0.34, -0.02, 0.085, 0.055], [-0.08, 0.02, 0.1, 0.055], [0.1, 0.02, 0.085, 0.055],
        ] as const) vent(W * px2, H * py2, W * ww, H * hh, 5);

        // Niveau supérieur : toit encombré, pas une surface vide.
        hardBlock(0, -H * 0.09, W * 0.5, H * 0.31, H * 0.28, '#4b5148');
        slab([[-W * 0.32, -H * 0.25], [W * 0.24, -H * 0.25], [W * 0.27, -H * 0.08], [-W * 0.29, -H * 0.08]], '#343b34');
        roofVents(-W * 0.12, -H * 0.24, W * 0.28, 7);
        platePanel(W * 0.1, -H * 0.19, W * 0.18, H * 0.09, '#1f251f');
        platePanel(-W * 0.32, -H * 0.16, W * 0.15, H * 0.08, '#1f251f');
        vent(W * 0.29, -H * 0.12, W * 0.14, H * 0.075, 6);
        vent(-W * 0.04, -H * 0.27, W * 0.16, H * 0.065, 6);
        pipe(-W * 0.38, -H * 0.1, W * 0.26, -H * 0.04, 3, W * 0.1);
        pipe(-W * 0.1, -H * 0.31, W * 0.28, -H * 0.2, 2.5, -W * 0.08);
        hTankV(W * 0.02, -H * 0.12, W * 0.16, H * 0.075, '#5e665f');
        hTankV(-W * 0.2, -H * 0.1, W * 0.14, H * 0.07, '#585f59');

        // Tour centrale : silhouette dure, vitrages petits, dôme technique.
        hardBlock(0, -H * 0.27, W * 0.22, H * 0.22, H * 0.38, '#394139');
        cyl(0, -H * 0.38, W * 0.075, H * 0.2, '#656c62', 0.2);
        glass(0, -H * 0.48, W * 0.19, 7, true);
        c.fillStyle = '#252b25';
        c.beginPath(); c.ellipse(0, -H * 0.6, W * 0.09, H * 0.035, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(230,224,190,0.4)';
        c.lineWidth = 1.4;
        c.beginPath(); c.ellipse(0, -H * 0.6, W * 0.09, H * 0.035, 0, 0, Math.PI * 2); c.stroke();

        // Énorme parabole haute : nervures visibles, pied industriel.
        c.strokeStyle = '#111613';
        c.lineWidth = 5;
        line(W * 0.22, -H * 0.27, W * 0.34, -H * 0.55);
        line(W * 0.44, -H * 0.27, W * 0.34, -H * 0.55);
        line(W * 0.22, -H * 0.27, W * 0.44, -H * 0.27);
        c.strokeStyle = 'rgba(230,224,190,0.18)';
        c.lineWidth = 1.6;
        line(W * 0.27, -H * 0.33, W * 0.41, -H * 0.33);
        line(W * 0.29, -H * 0.44, W * 0.39, -H * 0.44);
        hardBlock(W * 0.33, -H * 0.21, W * 0.18, H * 0.15, H * 0.13, '#2b322c');
        c.save();
        c.translate(W * 0.35, -H * 0.59);
        c.rotate(-0.62);
        c.fillStyle = '#222822';
        c.beginPath(); c.ellipse(0, 0, W * 0.18, W * 0.078, 0, Math.PI * 0.1, Math.PI * 1.9); c.fill();
        c.strokeStyle = '#9da398';
        c.lineWidth = 2;
        c.stroke();
        c.strokeStyle = 'rgba(230,224,190,0.38)';
        c.lineWidth = 1;
        for (const a of [-0.6, -0.3, 0, 0.3, 0.6]) {
          c.beginPath();
          c.moveTo(0, 0);
          c.lineTo(Math.cos(a) * W * 0.16, Math.sin(a) * W * 0.068);
          c.stroke();
        }
        c.beginPath(); c.ellipse(0, 0, W * 0.105, W * 0.043, 0, 0, Math.PI * 2); c.stroke();
        c.fillStyle = '#101410';
        c.beginPath(); c.arc(0, 0, W * 0.025, 0, Math.PI * 2); c.fill();
        c.restore();

        // Tour de gauche avec panneau radar rectangulaire.
        hardBlock(-W * 0.4, -H * 0.02, W * 0.14, H * 0.22, H * 0.35, '#30372f');
        c.strokeStyle = '#151a16';
        c.lineWidth = 3.4;
        line(-W * 0.4, -H * 0.28, -W * 0.42, -H * 0.52);
        c.save();
        c.translate(-W * 0.42, -H * 0.56);
        c.rotate(-0.55);
        platePanel(0, 0, W * 0.16, H * 0.055, '#72786d');
        rivets(0, 0, W * 0.13, 4);
        c.restore();
        antenna(-W * 0.3, -H * 0.22, H * 0.42, W * 0.045);
        antenna(-W * 0.14, -H * 0.32, H * 0.38, W * 0.04);
        antenna(W * 0.46, -H * 0.03, H * 0.28, W * 0.04);
        dish(-W * 0.18, -H * 0.38, W * 0.06, -0.25);

        // modules, caisses et quais autour pour retrouver le côté "base vivante".
        hTankV(-W * 0.27, H * 0.35, W * 0.15, H * 0.085, '#676f68');
        hTankV(W * 0.27, H * 0.35, W * 0.15, H * 0.085, '#676f68');
        container(-W * 0.45, H * 0.29, W * 0.11, H * 0.08, '#343a36', 4);
        container(-W * 0.35, H * 0.39, W * 0.1, H * 0.075, '#6d5536', 4);
        container(W * 0.41, H * 0.33, W * 0.12, H * 0.085, '#343a36', 4);
        container(W * 0.48, H * 0.22, W * 0.085, H * 0.07, '#72533c', 3);
        truck(W * 0.34, H * 0.43, W * 0.13, -0.02);
        flag(-W * 0.47, H * 0.05, H * 0.22);
        sandbags(-W * 0.24, H * 0.46, W * 0.19, 0.06);
        sandbags(W * 0.24, H * 0.46, W * 0.19, -0.06);

        // Salissures ciblées et micro-détails pour casser l'effet "sprite lisse".
        const hqRng = mulberry32(997);
        for (let i = 0; i < 32; i++) {
          const sx2 = -W * 0.42 + hqRng() * W * 0.84;
          const sy2 = -H * 0.24 + hqRng() * H * 0.68;
          c.strokeStyle = `rgba(12,10,7,${0.18 + hqRng() * 0.14})`;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(sx2, sy2);
          c.lineTo(sx2 + (hqRng() - 0.5) * W * 0.09, sy2 + (hqRng() - 0.5) * H * 0.045);
          c.stroke();
        }
        for (let i = 0; i < 18; i++) {
          c.fillStyle = `rgba(45,34,22,${0.12 + hqRng() * 0.1})`;
          c.beginPath();
          c.ellipse(-W * 0.42 + hqRng() * W * 0.84, -H * 0.18 + hqRng() * H * 0.62, W * (0.012 + hqRng() * 0.025), H * 0.01, hqRng() * Math.PI, 0, Math.PI * 2);
          c.fill();
        }
        break;
      }

      // ============ Centrale T1 : petit site (hall bas + cheminée + transfos)
      case 'power': {
        apron(0, 0, W * 0.96, H * 0.92, '#4d524c', 4);
        c.fillStyle = 'rgba(18,15,12,0.18)';
        c.fillRect(-W * 0.43, H * 0.3, W * 0.86, H * 0.08);
        c.fillRect(W * 0.12, -H * 0.34, W * 0.22, H * 0.06);

        // salle turbine blindée + salle de contrôle basse.
        industrialBlock(-W * 0.18, H * 0.08, W * 0.48, H * 0.34, H * 0.2, '#3a4038');
        industrialBlock(-W * 0.2, -H * 0.13, W * 0.34, H * 0.18, H * 0.13, '#444b43');
        door(-W * 0.2, H * 0.22, W * 0.15, H * 0.11, '#b88f34');
        teamMark(-W * 0.2, H * 0.1, W * 0.13, 4);
        for (const gx of [-0.35, -0.26, -0.12, -0.03]) {
          ventPanel(W * gx, H * 0.02, W * 0.075, H * 0.07, 4);
          tinyRivets(W * gx, H * -0.04, W * 0.055, 3);
        }

        // transformateurs, isolateurs et lignes haute tension.
        for (const [tx, ty] of [[0.22, -0.18], [0.22, 0.1]] as const) {
          industrialBlock(W * tx, H * ty, W * 0.2, H * 0.15, H * 0.08, '#333a33');
          c.strokeStyle = '#141915';
          c.lineWidth = 1.4;
          for (const ox of [-0.05, 0, 0.05]) line(W * (tx + ox), H * ty - H * 0.08, W * (tx + ox), H * ty - H * 0.22);
          c.fillStyle = '#bec5bb';
          for (const ox of [-0.05, 0, 0.05]) {
            c.beginPath(); c.arc(W * (tx + ox), H * ty - H * 0.22, 1.8, 0, Math.PI * 2); c.fill();
          }
        }
        c.strokeStyle = 'rgba(190,190,170,0.55)';
        c.lineWidth = 1;
        line(W * 0.17, -H * 0.4, W * 0.27, -H * 0.4);
        line(W * 0.17, -H * 0.12, W * 0.27, -H * 0.12);
        line(W * 0.17, H * 0.16, W * 0.27, H * 0.16);

        // cheminée et conduites : lecture immédiate "production d'énergie".
        cyl(-W * 0.39, -H * 0.18, W * 0.055, H * 0.42, '#787f78', 0.58);
        pipe(-W * 0.36, H * 0.02, -W * 0.06, -H * 0.08, 4, W * 0.08);
        pipe(-W * 0.02, H * 0.06, W * 0.22, H * 0.1, 4, -W * 0.04);
        hTankV(W * 0.02, H * 0.28, W * 0.24, H * 0.09, '#626a62');
        hazard(W * 0.2, H * 0.39, W * 0.36, H * 0.045);
        warmLamp(-W * 0.35, H * 0.16);
        warmLamp(W * 0.33, H * 0.27);
        grimeStreaks(0, H * 0.05, W * 0.82, H * 0.74, 201, 20);
        break;
      }

      // ============ Centrale T2 : tours de refroidissement massives
      case 'power2': {
        apron(0, 0, W * 1.0, H * 0.96, '#4a504a', 4);
        coolTower(-W * 0.24, -H * 0.04, W * 0.19, H * 0.5);
        coolTower(W * 0.23, -H * 0.06, W * 0.16, H * 0.42);
        cyl(W * 0.42, H * 0.04, W * 0.047, H * 0.52, '#8b928b', 0.55, true);

        industrialBlock(0, H * 0.28, W * 0.78, H * 0.25, H * 0.2, '#343b36');
        door(W * 0.02, H * 0.37, W * 0.18, H * 0.1, '#b88f34');
        teamMark(-W * 0.28, H * 0.27, W * 0.15, 5);
        for (const gx of [-0.22, -0.08, 0.12, 0.28]) ventPanel(W * gx, H * 0.17, W * 0.1, H * 0.06, 5);
        roofVents(W * 0.08, H * 0.03, W * 0.46, 8);

        pipe(-W * 0.24, H * 0.04, -W * 0.06, H * 0.22, 5, 4);
        pipe(W * 0.23, H * -0.02, W * 0.1, H * 0.21, 5, -4);
        pipe(W * 0.32, H * 0.12, W * 0.42, H * 0.2, 4, W * 0.03);
        hTankV(-W * 0.02, H * 0.07, W * 0.24, H * 0.08, '#5f675f');
        hTankV(W * 0.25, H * 0.1, W * 0.2, H * 0.075, '#626a62');
        hazard(0, H * 0.42, W * 0.56, H * 0.045);
        warmLamp(-W * 0.42, H * 0.22);
        warmLamp(W * 0.42, H * 0.3);
        grimeStreaks(0, H * 0.08, W * 0.88, H * 0.78, 202, 24);
        break;
      }

      // ============ Raffinerie T1 : extraction (chevalet, citernes couchées)
      case 'refinery': {
        // Raffinerie = RAFFINAGE (et plus extraction) : haute tour de distillation,
        // ferme de cuves verticales, torchère, bloc de traitement et quai.
        apron(0, 0, W * 1.0, H * 0.94, '#3d4248', 4);
        // torchère + tour de distillation (silhouette haute signature)
        flare(W * 0.4, -H * 0.26, H * 0.46);
        column(-W * 0.3, -H * 0.04, W * 0.065, H * 0.62);
        // ferme de cuves verticales (cluster de réservoirs)
        cyl(-W * 0.04, -H * 0.12, W * 0.12, H * 0.34, '#69716a', 0.14, true);
        cyl(W * 0.17, -H * 0.16, W * 0.095, H * 0.27, '#69716a', 0.14);
        cyl(W * 0.04, H * 0.02, W * 0.08, H * 0.2, '#69716a', 0.14);
        // bloc de traitement blindé + porte éclairée
        industrialBlock(W * 0.06, H * 0.3, W * 0.5, H * 0.2, H * 0.18, '#3b4038');
        door(W * 0.06, H * 0.38, W * 0.18, H * 0.1, '#caa536');
        teamMark(W * 0.3, H * 0.31, W * 0.13, 4);
        for (const gx of [-0.12, 0.0, 0.12]) ventPanel(W * gx, H * 0.18, W * 0.08, H * 0.05, 4);
        // réseau de pipelines
        pipe(-W * 0.3, H * 0.12, -W * 0.04, H * 0.04, 4, 6);
        pipe(W * 0.17, -H * 0.05, W * 0.06, H * 0.18, 4, -5);
        pipe(-W * 0.04, -H * 0.04, W * 0.18, -H * 0.12, 3, W * 0.03);
        // quai de chargement + camion-citerne
        hazard(W * 0.04, H * 0.46, W * 0.42, H * 0.045);
        truck(-W * 0.34, H * 0.4, W * 0.14, 0);
        warmLamp(W * 0.3, H * 0.28);
        warmLamp(-W * 0.04, H * 0.34);
        grimeStreaks(0, H * 0.1, W * 0.84, H * 0.76, 301, 24);
        break;
      }

      // ============ Raffinerie T2 : complexe à plusieurs niveaux (bacs, colonnes)
      case 'refinery2': {
        apron(0, 0, W * 1.02, H * 0.98, '#4c514b', 4);
        flare(W * 0.45, -H * 0.24, H * 0.48);

        // Bacs de stockage et traitement multi-niveaux.
        cyl(-W * 0.28, -H * 0.1, W * 0.15, H * 0.25, '#81887f', 0.12);
        cyl(W * 0.04, -H * 0.17, W * 0.12, H * 0.21, '#8d6539', 0.12);
        cyl(-W * 0.32, H * 0.22, W * 0.11, H * 0.17, '#7b837c', 0.12);
        c.strokeStyle = '#151a16';
        c.lineWidth = 2;
        line(-W * 0.42, -H * 0.18, -W * 0.14, -H * 0.28);
        line(-W * 0.38, H * 0.16, -W * 0.22, H * 0.08);

        column(W * 0.28, H * 0.03, W * 0.05, H * 0.44);
        column(W * 0.39, H * 0.08, W * 0.04, H * 0.35);
        industrialBlock(W * 0.08, H * 0.35, W * 0.48, H * 0.18, H * 0.18, '#384039');
        door(W * 0.08, H * 0.41, W * 0.16, H * 0.09, '#b88f34');
        teamMark(W * 0.08, H * 0.31, W * 0.17, 4);
        for (const gx of [-0.08, 0.08, 0.24]) ventPanel(W * gx, H * 0.24, W * 0.08, H * 0.05, 4);

        // Réseau de pipelines et zones de chargement.
        for (const off of [-3, 0, 3]) pipe(-W * 0.27, -H * 0.12 + off, W * 0.25, -H * 0.06 + off, 3, 5);
        pipe(-W * 0.32, H * 0.22, -W * 0.08, H * 0.32, 4, 4);
        pipe(W * 0.04, -H * 0.18, W * 0.34, H * 0.03, 3, -W * 0.04);
        hTankV(W * 0.16, H * 0.08, W * 0.24, H * 0.085, '#606861');
        hazard(W * 0.08, H * 0.46, W * 0.42, H * 0.04);
        truck(-W * 0.34, H * 0.42, W * 0.15, 0);
        warmLamp(-W * 0.42, H * 0.3);
        warmLamp(W * 0.34, H * 0.28);
        grimeStreaks(0, H * 0.08, W * 0.9, H * 0.78, 302, 30);
        break;
      }

      // ============ Caserne T1 : camp bas (baraquements, tente, entraînement)
      case 'barracks': {
        // Bunker-hangar bas et large (garnison militaire), façon référence :
        // corps blindé principal + deux portes de déploiement éclairées, modules
        // de casernement latéraux, aérations de toit, antenne, mât.
        apron(0, 0, W * 1.0, H * 0.96, '#3d4248');
        // modules latéraux (dortoirs blindés) en retrait
        volume(-W * 0.4, -H * 0.04, W * 0.18, H * 0.42, H * 0.16, '#474e57', { seams: 1 });
        volume(W * 0.4, -H * 0.04, W * 0.18, H * 0.42, H * 0.16, '#474e57', { seams: 1 });
        // corps principal : hangar bas à toit large
        volume(0, -H * 0.04, W * 0.66, H * 0.46, H * 0.2, '#4c545d', { win: 4, seams: 1 });
        roofVents(0, -H * 0.2, W * 0.42, 5);
        antenna(W * 0.22, -H * 0.28, H * 0.24, W * 0.04);
        flag(-W * 0.24, -H * 0.26, H * 0.22);
        // porche de déploiement au sud : deux portes blindées éclairées
        volume(0, H * 0.26, W * 0.5, H * 0.12, H * 0.1, '#434a52');
        door(-W * 0.15, H * 0.3, W * 0.13, H * 0.12, '#caa536');
        door(W * 0.15, H * 0.3, W * 0.13, H * 0.12, '#caa536');
        // marquage de zone + sacs de sable
        hazard(0, H * 0.43, W * 0.42, H * 0.045);
        sandbags(-W * 0.34, H * 0.4, W * 0.18, 0.25);
        sandbags(W * 0.34, H * 0.4, W * 0.18, -0.25);
        break;
      }

      // ============ Caserne T2 : forteresse (enceinte, blockhaus, miradors)
      case 'barracks2': {
        apron(0, 0, W * 1.0, H * 0.98, '#70757a');
        // enceinte bétonnée (3 segments en volume, porte au sud)
        volume(0, -H * 0.38, W * 0.8, H * 0.07, 10, '#666c71', { seams: 1 });
        volume(-W * 0.38, 0, W * 0.07, H * 0.6, 10, '#61676c', { seams: 1 });
        volume(W * 0.38, 0, W * 0.07, H * 0.6, 10, '#61676c', { seams: 1 });
        // blockhaus central haut + passerelle
        volume(0, -H * 0.02, W * 0.4, H * 0.26, H * 0.28, '#525a61', { win: 3, seams: 2 });
        glass(0, -H * 0.12, W * 0.24, 4.5, false);
        door(0, H * 0.065, W * 0.13, 9, '#caa536');
        antenna(W * 0.11, -H * 0.43, H * 0.26, W * 0.04);
        flag(-W * 0.11, -H * 0.43, H * 0.22);
        // miradors d'angle sur pilotis
        stiltCabin(-W * 0.36, -H * 0.32, W * 0.2, H * 0.24);
        stiltCabin(W * 0.36, -H * 0.32, W * 0.2, H * 0.24);
        stiltCabin(-W * 0.36, H * 0.36, W * 0.2, H * 0.24);
        stiltCabin(W * 0.36, H * 0.36, W * 0.2, H * 0.24);
        hazard(0, H * 0.43, W * 0.24, H * 0.05);
        sandbags(-W * 0.17, H * 0.43, W * 0.18, 0.3);
        sandbags(W * 0.17, H * 0.43, W * 0.18, -0.3);
        break;
      }

      // ============ Usine T1 : hangar militaire massif à porte monumentale
      case 'factory': {
        // Halle de production militaire : hall haut à toit en redans (sheds
        // vitrés), cheminées d'usine, GRANDE PORTE BLINDÉE en façade, aile basse
        // et PONT ROULANT au-dessus de la cour de sortie — façon référence.
        apron(0, 0, W * 1.04, H * 0.96, '#3d4248');
        lane(W * 0.34, H * 0.3, W * 0.34, H * 0.52);
        // cheminées d'usine (lecture "industrie lourde")
        cyl(-W * 0.34, -H * 0.24, 5, H * 0.52, '#5a6168', 0.5, true);
        cyl(-W * 0.25, -H * 0.22, 5, H * 0.46, '#5a6168', 0.5);
        // hall principal haut
        volume(-W * 0.06, -H * 0.04, W * 0.66, H * 0.5, H * 0.32, '#48505a', { win: 4, seams: 3 });
        // toit en redans : verrières inclinées (sheds)
        c.fillStyle = 'rgba(150,200,235,0.32)';
        for (let i = 0; i < 4; i++) {
          const x0 = -W * 0.36 + (i * W * 0.6) / 4;
          const yT = -H * 0.04 - H * 0.5 / 2 - H * 0.32;
          c.beginPath();
          c.moveTo(x0, yT + H * 0.06);
          c.lineTo(x0 + W * 0.09, yT - 3 + H * 0.06);
          c.lineTo(x0 + W * 0.15, yT + H * 0.06);
          c.closePath(); c.fill();
        }
        roofVents(-W * 0.06, -H * 0.16, W * 0.5, 6);
        // grande porte blindée + bandes de danger en façade
        door(-W * 0.06, H * 0.16, W * 0.46, H * 0.2, '#caa536');
        hazard(-W * 0.06, H * 0.04, W * 0.46, 5);
        teamMark(W * 0.32, -H * 0.16, W * 0.14, 4);
        // aile basse est (atelier) + pont roulant au-dessus de la cour
        volume(W * 0.34, H * 0.02, W * 0.22, H * 0.44, H * 0.16, '#444b54', { win: 2 });
        gantryVol(W * 0.02, H * 0.34, W * 0.74, H * 0.3);
        truck(W * 0.36, H * 0.42, W * 0.14, 0);
        break;
      }

      // ============ Usine T2 : complexe lourd (sheds, hall haut, portique géant)
      case 'factory2': {
        apron(0, 0, W * 1.04, H * 1.0, '#6c7175');
        cyl(W * 0.43, -H * 0.3, 5, H * 0.42, '#c6cbcf', 0.55, true);
        // hall ouest à sheds
        volume(-W * 0.19, -H * 0.16, W * 0.56, H * 0.28, H * 0.18, '#46505a', { seams: 2 });
        c.fillStyle = 'rgba(235,240,245,0.2)';
        for (let i = 0; i < 4; i++) {
          const x0 = -W * 0.47 + (i * W * 0.56) / 4;
          c.beginPath();
          c.moveTo(x0, -H * 0.16 - H * 0.18 - H * 0.14 + H * 0.06);
          c.lineTo(x0 + W * 0.08, -H * 0.16 - H * 0.18 - H * 0.14 - 4 + H * 0.06);
          c.lineTo(x0 + W * 0.14, -H * 0.16 - H * 0.18 - H * 0.14 + H * 0.06);
          c.closePath(); c.fill();
        }
        door(-W * 0.19, -H * 0.085, W * 0.3, H * 0.1, '#caa536');
        // hall lourd est (plus haut)
        volume(W * 0.28, -H * 0.14, W * 0.3, H * 0.3, H * 0.28, '#343c44', { win: 3, seams: 3 });
        glass(W * 0.28, -H * 0.36, W * 0.22, 5, false);
        door(W * 0.28, -H * 0.04, W * 0.2, H * 0.09, '#caa536');
        teamMark(W * 0.28, -H * 0.135, W * 0.14, 4);
        // cour sud : portique roulant géant + stocks
        container(-W * 0.34, H * 0.34, W * 0.2, H * 0.08, '#7a5b34');
        container(-W * 0.34, H * 0.24, W * 0.2, H * 0.08, '#4f5a44', 6);
        container(W * 0.38, H * 0.32, W * 0.18, H * 0.08, shade(col, -0.15));
        gantryVol(0, H * 0.32, W * 0.8, H * 0.32);
        hazard(0, H * 0.46, W * 0.66, H * 0.05);
        break;
      }

      // ============ Radar : bunker bas + tour-pylône à grande parabole
      case 'radar': {
        apron(0, 0, W * 0.95, H * 0.92, '#75797d');
        antenna(-W * 0.34, H * 0.1, H * 0.3, W * 0.05);
        cyl(0, -H * 0.04, W * 0.1, H * 0.34, '#2e353c');
        dish(0, -H * 0.43, W * 0.19, -0.3);
        volume(0, H * 0.24, W * 0.6, H * 0.26, H * 0.18, '#414a52', { win: 3 });
        glass(0, H * 0.245, W * 0.36, 5, true);
        teamMark(W * 0.2, H * 0.31, W * 0.14, 4);
        break;
      }

      // ============ Centre radar avancé : radôme géant perché
      case 'radarcenter': {
        apron(0, 0, W * 0.98, H * 0.95, '#787c80');
        volume(0, H * 0.12, W * 0.74, H * 0.34, H * 0.22, '#3a434b', { win: 4, seams: 2 });
        const rr3 = W * 0.205;
        const sphY = -H * 0.27; // posé sur le toit
        c.fillStyle = 'rgba(8,10,8,0.2)';
        c.beginPath(); c.ellipse(rr3 * 0.5, -H * 0.1, rr3 * 1.0, rr3 * 0.35, 0, 0, Math.PI * 2); c.fill();
        const gr3 = c.createRadialGradient(-rr3 * 0.35, sphY - rr3 * 0.35, rr3 * 0.12, 0, sphY, rr3);
        gr3.addColorStop(0, '#f2f4f5');
        gr3.addColorStop(0.65, '#c9ced2');
        gr3.addColorStop(1, '#7d848a');
        c.fillStyle = gr3;
        c.beginPath(); c.arc(0, sphY, rr3, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.4)';
        c.lineWidth = 1.5;
        c.stroke();
        c.strokeStyle = 'rgba(0,0,0,0.12)';
        c.lineWidth = 1;
        for (let k = 1; k <= 2; k++) {
          c.beginPath(); c.ellipse(0, sphY, rr3 * 0.96, rr3 * (k * 0.32), 0, 0, Math.PI * 2); c.stroke();
        }
        dish(-W * 0.32, -H * 0.16, W * 0.09, -0.5);
        dish(W * 0.33, -H * 0.12, W * 0.075, -0.2);
        antenna(W * 0.42, H * 0.18, H * 0.3, W * 0.05);
        teamMark(-W * 0.22, H * 0.25, W * 0.16, 4);
        break;
      }

      // ============ Aéroport : piste au sol + tour de contrôle haute
      case 'airport': {
        apron(0, 0, W * 1.02, H * 0.98, '#6f7478');
        c.fillStyle = '#26292d';
        this.rr(c, -W * 0.48, -H * 0.3, W * 0.96, H * 0.42, 6); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.45)';
        c.lineWidth = 1.4;
        this.rr(c, -W * 0.48, -H * 0.3, W * 0.96, H * 0.42, 6); c.stroke();
        c.fillStyle = 'rgba(235,238,240,0.75)';
        for (let k = 0; k < 4; k++) {
          c.fillRect(-W * 0.45, -H * 0.24 + k * H * 0.08, W * 0.05, H * 0.04);
          c.fillRect(W * 0.4, -H * 0.24 + k * H * 0.08, W * 0.05, H * 0.04);
        }
        lane(-W * 0.34, -H * 0.09, W * 0.34, -H * 0.09);
        c.strokeStyle = 'rgba(0,0,0,0.4)';
        c.lineWidth = 3;
        for (const off of [-4, 4]) {
          c.beginPath(); c.moveTo(-W * 0.2 + off * 2, -H * 0.09 + off); c.lineTo(W * 0.1 + off * 2, -H * 0.09 + off); c.stroke();
        }
        // hangar d'entretien ouest
        volume(-W * 0.28, H * 0.34, W * 0.34, H * 0.18, H * 0.2, '#3f4850', { seams: 2 });
        door(-W * 0.28, H * 0.33, W * 0.26, H * 0.13, '#caa536');
        teamMark(-W * 0.28, H * 0.2, W * 0.14, 4);
        // tour de contrôle : fût + cabine vitrée en surplomb
        const tx2 = W * 0.36, tyG = H * 0.4;
        c.fillStyle = 'rgba(8,10,8,0.3)';
        c.beginPath(); c.ellipse(tx2 + 10, tyG + 3, W * 0.1, H * 0.05, 0, 0, Math.PI * 2); c.fill();
        const shGr = c.createLinearGradient(tx2 - 6, 0, tx2 + 6, 0);
        shGr.addColorStop(0, '#5a6269');
        shGr.addColorStop(0.5, '#8a9299');
        shGr.addColorStop(1, '#454d54');
        c.fillStyle = shGr;
        c.fillRect(tx2 - 6, tyG - H * 0.52, 12, H * 0.52);
        c.strokeStyle = 'rgba(0,0,0,0.45)';
        c.lineWidth = 1.2;
        c.strokeRect(tx2 - 6, tyG - H * 0.52, 12, H * 0.52);
        c.fillStyle = '#2c343b';
        this.rr(c, tx2 - W * 0.085, tyG - H * 0.62, W * 0.17, H * 0.12, 3); c.fill();
        glass(tx2, tyG - H * 0.575, W * 0.14, 6, true);
        c.fillStyle = '#3c444b';
        this.rr(c, tx2 - W * 0.095, tyG - H * 0.64, W * 0.19, H * 0.035, 2); c.fill();
        dish(tx2 + W * 0.05, tyG - H * 0.66, W * 0.05, -0.4);
        // manche à air
        c.strokeStyle = '#23272b';
        c.lineWidth = 1.6;
        line(W * 0.1, H * 0.4, W * 0.1, H * 0.26);
        c.fillStyle = '#d97f2e';
        c.beginPath(); c.moveTo(W * 0.1, H * 0.26); c.lineTo(W * 0.17, H * 0.28); c.lineTo(W * 0.1, H * 0.31); c.closePath(); c.fill();
        break;
      }

      // ============ Héliport : dalle de posé + hangar bas + marquage H
      case 'helipad': {
        apron(0, 0, W * 1.0, H * 0.94, '#687076');
        c.fillStyle = '#2c3237';
        c.beginPath(); c.ellipse(-W * 0.22, -H * 0.02, W * 0.24, H * 0.24, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(245,245,225,0.75)';
        c.lineWidth = Math.max(2, W * 0.035);
        c.beginPath(); c.ellipse(-W * 0.22, -H * 0.02, W * 0.17, H * 0.17, 0, 0, Math.PI * 2); c.stroke();
        c.fillStyle = '#e8e1b5';
        c.fillRect(-W * 0.31, -H * 0.055, W * 0.18, H * 0.035);
        c.fillRect(-W * 0.24, -H * 0.13, W * 0.035, H * 0.15);
        volume(W * 0.25, H * 0.24, W * 0.34, H * 0.22, H * 0.18, '#46505a', { seams: 2 });
        door(W * 0.25, H * 0.24, W * 0.25, H * 0.13, '#b9a84e');
        antenna(W * 0.42, -H * 0.12, H * 0.34, W * 0.045);
        teamMark(W * 0.24, H * 0.08, W * 0.13, 4);
        break;
      }

      // ============ Défenses : encuvement octogonal bétonné
      case 'turret': case 'atgun': case 'aa': {
        c.save();
        c.translate(2, 3);
        c.fillStyle = 'rgba(8,10,8,0.3)';
        octPath(0, 0, W * 0.46); c.fill();
        c.restore();
        // muret extrudé (béton blindé sombre)
        c.fillStyle = mix('#4a5055', STEEL, 0.6);
        octPath(0, 4, W * 0.45); c.fill();
        c.fillStyle = mix('#6a7075', STEEL, 0.55);
        octPath(0, 0, W * 0.45); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.5)';
        c.lineWidth = 1.6;
        c.stroke();
        c.fillStyle = mix('#454b50', STEEL, 0.6);
        octPath(0, 0, W * 0.34); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.35)';
        c.lineWidth = 1;
        c.stroke();
        c.fillStyle = '#23282d';
        c.beginPath(); c.arc(0, 0, W * 0.16, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(255,255,255,0.15)';
        c.lineWidth = 1;
        c.beginPath(); c.arc(0, 0, W * 0.16, 0, Math.PI * 2); c.stroke();
        sandbags(0, W * 0.44, W * 0.5, 0);
        break;
      }

      // ============ Centre tactique : bunker enterré à verrière
      case 'tech': {
        apron(0, 0, W * 0.96, H * 0.94, '#74787c');
        antenna(-W * 0.38, H * 0.22, H * 0.4, W * 0.06);
        antenna(-W * 0.28, H * 0.28, H * 0.26, W * 0.045);
        volume(0, H * 0.04, W * 0.62, H * 0.4, H * 0.2, '#4d5547', { win: 2, seams: 2 });
        glass(0, -H * 0.2, W * 0.32, H * 0.13, true);
        c.strokeStyle = 'rgba(235,238,240,0.6)';
        c.lineWidth = 2;
        line(-W * 0.26, -H * 0.32, -W * 0.18, -H * 0.32);
        line(-W * 0.26, -H * 0.32, -W * 0.26, -H * 0.24);
        line(W * 0.26, -H * 0.04, W * 0.18, -H * 0.04);
        line(W * 0.26, -H * 0.04, W * 0.26, -H * 0.12);
        dish(W * 0.32, -H * 0.26, W * 0.09, -0.45);
        door(0, H * 0.16, W * 0.13, 9, '#caa536');
        sandbags(W * 0.24, H * 0.36, W * 0.24, -0.15);
        teamMark(-W * 0.2, H * 0.18, W * 0.13, 4);
        break;
      }

      // ============ Laboratoire avancé : campus clair, atrium vitré vertical
      case 'lab': {
        apron(0, 0, W * 1.02, H * 0.98, '#7b8084');
        antenna(-W * 0.42, -H * 0.08, H * 0.46, W * 0.05);
        // ailes latérales
        volume(-W * 0.38, H * 0.02, W * 0.18, H * 0.24, H * 0.14, '#5b636b', { win: 2 });
        volume(W * 0.38, H * 0.02, W * 0.18, H * 0.24, H * 0.14, '#5b636b', { win: 2 });
        // bâtiment principal clair et haut
        volume(0, 0, W * 0.56, H * 0.32, H * 0.23, '#8d949a', { seams: 3 });
        // atrium vitré pleine hauteur sur la façade
        glass(0, H * 0.045, W * 0.14, H * 0.22, true);
        glass(0, -H * 0.16, W * 0.4, 6, false);
        dish(W * 0.2, -H * 0.27, W * 0.1, -0.3);
        star(-W * 0.18, -H * 0.2, W * 0.05, 'rgba(40,46,52,0.55)');
        teamMark(0, H * 0.14, W * 0.3, 4);
        // banc d'essai sud : plateforme + condensateurs + câble
        apron(0, H * 0.36, W * 0.46, H * 0.18, '#62676b', 3);
        hazard(0, H * 0.265, W * 0.46, 4.5);
        cyl(-W * 0.1, H * 0.38, 5.5, 15, '#9aa1a7', 0.45);
        cyl(W * 0.1, H * 0.38, 5.5, 15, '#9aa1a7', 0.45);
        c.strokeStyle = '#23272b';
        c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(-W * 0.1, H * 0.38 - 15); c.quadraticCurveTo(0, H * 0.3, W * 0.1, H * 0.38 - 15); c.stroke();
        break;
      }

      // ============ Dépôt logistique : entrepôt + parc à conteneurs
      case 'depot': {
        apron(0, 0, W * 1.0, H * 0.98, '#75716a');
        lane(-W * 0.46, H * 0.2, W * 0.46, H * 0.2);
        volume(0, -H * 0.14, W * 0.84, H * 0.28, H * 0.2, '#5d5546', { seams: 2 });
        roofVents(0, -H * 0.34, W * 0.76, 7);
        door(-W * 0.2, -H * 0.02, W * 0.22, H * 0.1, '#caa536');
        door(W * 0.2, -H * 0.02, W * 0.22, H * 0.1, '#caa536');
        teamMark(0, -H * 0.12, W * 0.18, 4);
        container(-W * 0.28, H * 0.32, W * 0.26, H * 0.1, '#7a5b34');
        container(-W * 0.26, H * 0.43, W * 0.26, H * 0.1, '#56604a');
        container(W * 0.06, H * 0.34, W * 0.26, H * 0.1, '#8a8579', 6);
        container(W * 0.32, H * 0.4, W * 0.22, H * 0.09, shade(col, -0.12));
        c.fillStyle = '#8a744e';
        c.fillRect(W * 0.3, H * 0.08, 7, 5);
        c.fillRect(W * 0.38, H * 0.11, 7, 5);
        truck(-W * 0.02, H * 0.2, W * 0.2, 0);
        break;
      }
    }
    weather(c, -W / 2, -H / 2, W, H, seed);
    industrialFinish(c, -W / 2, -H / 2 - H * 0.35, W, H * 1.55, seed, 1.1);
    return cv;
  }

  // ---- vapeur animée (centrales, cheminées) : blanche, jamais bleue
  private steam(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, time: number, scale: number, alpha = 0.2) {
    for (let k = 0; k < 3; k++) {
      const t = (time * 0.3 + k / 3) % 1;
      ctx.fillStyle = `rgba(228,232,234,${alpha * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(x + Math.sin((time + k * 2.1) * 1.7) * z * 0.06, y - t * z * scale * 2.2, z * scale * (0.45 + t * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- flamme de torchère animée (orange/jaune)
  private flame(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, time: number, s: number) {
    const fl = 0.7 + 0.3 * Math.sin(time * 13) * Math.sin(time * 7.7);
    ctx.fillStyle = `rgba(255,140,50,${0.5 * fl})`;
    ctx.beginPath(); ctx.arc(x, y - z * s * 0.3, z * s * (0.5 + 0.2 * fl), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,210,90,${0.85 * fl})`;
    ctx.beginPath(); ctx.arc(x, y - z * s * 0.16, z * s * 0.3, 0, Math.PI * 2); ctx.fill();
  }

  // ----------------------------------------------- sprites d'unités pré-cuits
  //
  // Chaque unité est dessinée UNE fois en 48 px/tuile (dégradés, blindage,
  // greebles, usure) puis affichée avec rotation lissée : détail x20 et
  // rendu par frame plus léger qu'avant.

  private spriteCache = new Map<string, {
    body: HTMLCanvasElement; turret?: HTMLCanvasElement;
    side: HTMLCanvasElement; turretSide?: HTMLCanvasElement;
  }>();

  // copie assombrie d'un sprite : sert de « flanc » pour l'extrusion 2.5D
  private darkenSprite(src: HTMLCanvasElement): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = src.width; cv.height = src.height;
    const c = cv.getContext('2d')!;
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(8,10,16,0.55)';
    c.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }

  private unitSprites(type: string, owner: number): {
    body: HTMLCanvasElement; turret?: HTMLCanvasElement;
    side: HTMLCanvasElement; turretSide?: HTMLCanvasElement;
  } {
    const key = `${type}:${owner}`;
    let spr = this.spriteCache.get(key);
    if (!spr) {
      const baked = this.bakeUnit(type, PLAYER_COLORS[owner]);
      spr = {
        body: baked.body,
        turret: baked.turret,
        side: this.darkenSprite(baked.body),
        turretSide: baked.turret ? this.darkenSprite(baked.turret) : undefined,
      };
      this.spriteCache.set(key, spr);
    }
    return spr;
  }

  private newSprite(tiles: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(tiles * SPX);
    const c = cv.getContext('2d')!;
    c.translate(cv.width / 2, cv.height / 2);
    return [cv, c];
  }

  private unitVisualScale(type: string, def: { armor: string; isAir?: boolean }) {
    // Véhicules agrandis (lisibilité + détail visible) ; hitbox/gameplay inchangés.
    if (def.armor === 'inf') return 1.1;
    if (def.isAir) return type === 'cargoheli' || type === 'transportheli' ? 1.2 : 1.18;
    if (type === 'harvester' || type === 'mobilecmd') return 1.32;
    if (type === 'heavytank' || type === 'heavyarty' || type === 'tankdestroyer') return 1.3;
    if (type === 'artillery' || type === 'tank') return 1.26;
    return 1.22;
  }

  private bakeUnit(type: string, col: string): { body: HTMLCanvasElement; turret?: HTMLCanvasElement } {
    const T = SPX;
    const def = UNITS[type as keyof typeof UNITS];
    const r = def.radius * T;

    // ---------- infanterie : soldat avec casque, gilet, arme détaillée
    if (def.armor === 'inf' && !def.isAir) {
      const [cv, c] = this.newSprite(1.8);
      const torso = (base: string, rad = r) => {
        const gr = c.createRadialGradient(-rad * 0.35, -rad * 0.35, rad * 0.2, 0, 0, rad);
        gr.addColorStop(0, shade(base, 0.3));
        gr.addColorStop(0.7, base);
        gr.addColorStop(1, shade(base, -0.35));
        c.fillStyle = gr;
        c.beginPath(); c.arc(0, 0, rad, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.55)';
        c.lineWidth = 1.5;
        c.stroke();
        // épaules
        c.fillStyle = shade(base, -0.25);
        c.beginPath(); c.arc(0, -rad * 0.85, rad * 0.34, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(0, rad * 0.85, rad * 0.34, 0, Math.PI * 2); c.fill();
      };
      const helmet = (base: string) => {
        const gr = c.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r * 0.62);
        gr.addColorStop(0, shade(base, 0.45));
        gr.addColorStop(1, shade(base, -0.3));
        c.fillStyle = gr;
        c.beginPath(); c.arc(0, 0, r * 0.62, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.4)';
        c.lineWidth = 1;
        c.stroke();
      };
      const rifle = (len: number, stock = true) => {
        if (stock) { c.fillStyle = '#6b4f2e'; c.fillRect(r * 0.1, -1.8, r * 0.7, 3.6); }
        barrel(c, r * 0.7, 0, len - r * 0.7, 2.6, false);
      };

      switch (type) {
        case 'rifle':
          c.fillStyle = '#5a4a32'; c.fillRect(-r * 1.15 - 3, -3.5, 7, 7); // sac
          torso(col); helmet('#3c4046'); rifle(r * 1.7);
          break;
        case 'elite':
          c.fillStyle = '#5a4a32'; c.fillRect(-r * 1.15 - 3, -4, 8, 8);
          torso(shade(col, -0.2));
          c.strokeStyle = '#e7c44a'; c.lineWidth = 2;
          c.beginPath(); c.arc(0, 0, r * 0.92, 0, Math.PI * 2); c.stroke();
          helmet('#23262a');
          rifle(r * 2.0);
          c.strokeStyle = '#e7c44a'; c.lineWidth = 1.6;
          c.beginPath(); c.moveTo(r * 2.0, 0); c.lineTo(r * 2.3, 0); c.stroke(); // baïonnette
          break;
        case 'bazooka': {
          torso(col); helmet('#3c4046');
          const gr2 = c.createLinearGradient(0, -5, 0, 5);
          gr2.addColorStop(0, '#cbb277'); gr2.addColorStop(0.5, '#9a8146'); gr2.addColorStop(1, '#5e4d27');
          c.fillStyle = gr2;
          c.fillRect(-r * 1.0, -4, r * 2.9, 8);
          c.fillStyle = '#1d2126';
          c.fillRect(r * 1.5, -5.5, r * 0.4, 11); // gueule
          c.fillStyle = '#ff5e72';
          c.beginPath(); c.arc(-r * 1.0, 0, 3.4, 0, Math.PI * 2); c.fill(); // venturi
          break;
        }
        case 'rocketeer': {
          c.fillStyle = '#4a3f23';
          c.fillRect(-r * 1.3 - 4, -7, 9, 14); // râtelier dorsal
          c.fillStyle = '#ff5e72';
          for (const oy of [-5, -1.7, 1.7, 5]) { c.beginPath(); c.arc(-r * 1.3, oy, 1.6, 0, Math.PI * 2); c.fill(); }
          torso(col); helmet('#23262a');
          for (const oy of [-3.6, 3.6]) {
            const gr2 = c.createLinearGradient(0, oy - 3, 0, oy + 3);
            gr2.addColorStop(0, '#a8915a'); gr2.addColorStop(1, '#574a26');
            c.fillStyle = gr2;
            c.fillRect(-r * 1.0, oy - 3, r * 3.1, 6);
            c.fillStyle = '#1d2126';
            c.fillRect(r * 1.7, oy - 4, r * 0.35, 8);
          }
          break;
        }
        case 'sniper': {
          const rngS = mulberry32(42);
          for (let k = 0; k < 5; k++) { // ghillie
            const gr2 = c.createRadialGradient(0, 0, 1, 0, 0, r * 0.7);
            gr2.addColorStop(0, '#3a4429'); gr2.addColorStop(1, '#222a18');
            c.fillStyle = gr2;
            c.beginPath();
            c.arc((rngS() - 0.5) * r * 1.2, (rngS() - 0.5) * r * 1.2, r * (0.5 + rngS() * 0.3), 0, Math.PI * 2);
            c.fill();
          }
          c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1;
          c.beginPath(); c.arc(0, 0, r * 0.95, 0, Math.PI * 2); c.stroke();
          barrel(c, r * 0.3, 0, r * 2.5, 2, false);
          c.fillStyle = '#9ad0ff';
          c.beginPath(); c.arc(r * 1.0, -2.5, 2.4, 0, Math.PI * 2); c.fill(); // lunette
          c.strokeStyle = '#c9d1d9'; c.lineWidth = 1.4; // bipied
          c.beginPath(); c.moveTo(r * 2.5, 0); c.lineTo(r * 2.9, -4); c.stroke();
          c.beginPath(); c.moveTo(r * 2.5, 0); c.lineTo(r * 2.9, 4); c.stroke();
          break;
        }
        case 'engineer':
          c.fillStyle = '#e07b2c'; // boîte à outils
          c.fillRect(-3, r * 0.9, 9, 6.5);
          c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1;
          c.strokeRect(-3, r * 0.9, 9, 6.5);
          torso('#b9bec8');
          helmet('#ffd84d');
          c.fillStyle = '#ffd84d';
          c.fillRect(-r * 0.85, -2, r * 0.5, 4); // visière
          c.strokeStyle = '#fff'; c.lineWidth = 2;
          c.beginPath(); c.moveTo(r * 0.4, 0); c.lineTo(r * 1.4, 0); c.stroke(); // clé
          c.beginPath(); c.arc(r * 1.5, 0, 2.6, 0.6, Math.PI * 1.5); c.stroke();
          break;
        case 'kamikaze':
          torso('#3a1d20');
          c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1;
          for (const a of [-0.9, 0, 0.9]) { // charges sur le gilet
            const bx = Math.cos(a + Math.PI) * r * 0.5, by = Math.sin(a + Math.PI) * r * 0.5;
            c.fillStyle = '#c23030';
            c.fillRect(bx - 2.6, by - 2.6, 5.2, 5.2);
            c.strokeRect(bx - 2.6, by - 2.6, 5.2, 5.2);
          }
          c.strokeStyle = '#e8c84a'; c.lineWidth = 1; // câblage
          c.beginPath(); c.arc(0, 0, r * 0.55, 0.4, Math.PI * 1.6); c.stroke();
          helmet('#2c2326');
          break;
        case 'spy':
          torso('#20252c', r * 0.92);
          c.strokeStyle = '#6fb6d8';
          c.lineWidth = 1.4;
          c.beginPath(); c.arc(0, 0, r * 0.82, -0.6, 0.7); c.stroke();
          helmet('#11161c');
          c.fillStyle = '#101418';
          c.fillRect(r * 0.25, -2, r * 1.1, 4);
          c.fillStyle = '#77d7ff';
          c.beginPath(); c.arc(r * 0.95, -2.6, 1.8, 0, Math.PI * 2); c.fill();
          c.beginPath(); c.arc(r * 0.95, 2.6, 1.8, 0, Math.PI * 2); c.fill();
          break;
      }
      weather(c, -r, -r, r * 2, r * 2, type.length * 17);
      industrialFinish(c, -r * 1.35, -r * 1.35, r * 2.7, r * 2.7, type.length * 19, 0.55);
      return { body: cv };
    }

    // ---------- aviation
    if (def.isAir) {
      const [cv, c] = this.newSprite(1.6);
      const Tz = T;
      if (type === 'transportheli' || type === 'cargoheli') {
        const heavy = type === 'cargoheli';
        armor(c, [[-Tz * 0.34, -Tz * 0.14], [Tz * 0.28, -Tz * 0.14], [Tz * 0.42, 0], [Tz * 0.28, Tz * 0.14], [-Tz * 0.34, Tz * 0.14], [-Tz * 0.44, 0]], heavy ? '#4a535a' : HULL_LIGHT);
        armor(c, [[-Tz * 0.52, -Tz * 0.05], [-Tz * 0.36, 0], [-Tz * 0.52, Tz * 0.05]], col);
        c.strokeStyle = '#252a2e'; c.lineWidth = Math.max(1.3, Tz * 0.035);
        c.beginPath(); c.moveTo(-Tz * 0.38, 0); c.lineTo(-Tz * 0.74, 0); c.stroke();
        c.beginPath(); c.moveTo(-Tz * 0.74, -Tz * 0.1); c.lineTo(-Tz * 0.74, Tz * 0.1); c.stroke();
        c.strokeStyle = 'rgba(15,18,20,0.55)';
        c.lineWidth = Math.max(2, Tz * 0.045);
        c.beginPath(); c.moveTo(-Tz * 0.48, 0); c.lineTo(Tz * 0.48, 0); c.stroke();
        c.beginPath(); c.moveTo(0, -Tz * 0.42); c.lineTo(0, Tz * 0.42); c.stroke();
        c.fillStyle = '#23282d';
        c.beginPath(); c.arc(0, 0, Tz * 0.08, 0, Math.PI * 2); c.fill();
        if (heavy) {
          c.strokeStyle = '#1d2226'; c.lineWidth = Math.max(1, Tz * 0.025);
          c.beginPath(); c.moveTo(-Tz * 0.18, Tz * 0.18); c.lineTo(Tz * 0.18, Tz * 0.18); c.stroke();
          c.fillStyle = '#2a3035';
          c.fillRect(-Tz * 0.18, Tz * 0.19, Tz * 0.36, Tz * 0.08);
        }
      } else if (type === 'scoutplane') {
        armor(c, [[-Tz * 0.42, -Tz * 0.05], [Tz * 0.38, -Tz * 0.05], [Tz * 0.38, Tz * 0.05], [-Tz * 0.42, Tz * 0.05]], HULL_LIGHT); // fuselage
        armor(c, [[-Tz * 0.05, -Tz * 0.44], [Tz * 0.09, -Tz * 0.44], [Tz * 0.05, 0], [Tz * 0.09, Tz * 0.44], [-Tz * 0.05, Tz * 0.44]], col); // ailes droites
        armor(c, [[-Tz * 0.4, -Tz * 0.18], [-Tz * 0.28, 0], [-Tz * 0.4, Tz * 0.18]], col); // empennage
        const gr2 = c.createRadialGradient(0, 0, 1, 0, 0, Tz * 0.13);
        gr2.addColorStop(0, '#e8f4ff'); gr2.addColorStop(1, '#5a93d0');
        c.fillStyle = gr2;
        c.beginPath(); c.arc(Tz * 0.02, 0, Tz * 0.13, 0, Math.PI * 2); c.fill(); // rotodôme
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1; c.stroke();
      } else {
        // chasseur-bombardier : ailes en flèche
        armor(c, [
          [Tz * 0.52, 0], [Tz * 0.1, -Tz * 0.12], [-Tz * 0.22, -Tz * 0.46], [-Tz * 0.34, -Tz * 0.4],
          [-Tz * 0.18, -Tz * 0.08], [-Tz * 0.44, -Tz * 0.1], [-Tz * 0.5, 0],
          [-Tz * 0.44, Tz * 0.1], [-Tz * 0.18, Tz * 0.08], [-Tz * 0.34, Tz * 0.4],
          [-Tz * 0.22, Tz * 0.46], [Tz * 0.1, Tz * 0.12],
        ], col);
        c.fillStyle = '#2c3136'; // nacelles
        c.fillRect(-Tz * 0.2, -Tz * 0.2, Tz * 0.26, Tz * 0.09);
        c.fillRect(-Tz * 0.2, Tz * 0.11, Tz * 0.26, Tz * 0.09);
        const gr2 = c.createLinearGradient(0, -3, 0, 3);
        gr2.addColorStop(0, '#eaf6ff'); gr2.addColorStop(1, '#7db4e0');
        c.fillStyle = gr2;
        c.beginPath(); c.ellipse(Tz * 0.24, 0, Tz * 0.13, Tz * 0.06, 0, 0, Math.PI * 2); c.fill();
      }
      industrialFinish(c, -Tz * 0.78, -Tz * 0.56, Tz * 1.56, Tz * 1.12, type.length * 29, 0.75);
      return { body: cv };
    }

    // ---------- véhicules
    const [cv, c] = this.newSprite(3);
    const seed = type.length * 31 + 7;
    let turretCv: HTMLCanvasElement | undefined;
    const lamp = (x: number, y: number, rr = 2.2, color = '#d7c77b') => {
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.beginPath(); c.arc(x + 0.6, y + 0.8, rr * 1.2, 0, Math.PI * 2); c.fill();
      const gr = c.createRadialGradient(x - rr * 0.25, y - rr * 0.25, 0.4, x, y, rr);
      gr.addColorStop(0, '#fff7c0'); gr.addColorStop(1, color);
      c.fillStyle = gr;
      c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
    };
    const whip = (x: number, y: number, len: number) => {
      c.strokeStyle = '#11161a';
      c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x - len * 0.2, y - len * 0.45, x + len * 0.1, y - len); c.stroke();
      c.fillStyle = '#e0344a';
      c.beginPath(); c.arc(x + len * 0.1, y - len, 1.5, 0, Math.PI * 2); c.fill();
    };
    const armorBolts = (x: number, y: number, w: number, h: number, count: number) => {
      c.fillStyle = 'rgba(230,235,232,0.18)';
      for (let k = 0; k < count; k++) {
        const px = x + ((k + 0.5) * w) / count;
        c.beginPath(); c.arc(px, y, 1.2, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(px, y + h, 1.2, 0, Math.PI * 2); c.fill();
      }
    };

    if (type === 'jeep') {
      const L = r * 2.3, Wd = r * 1.35;
      for (const [ox, oy] of [[-0.32, -0.66], [0.32, -0.66], [-0.32, 0.66], [0.32, 0.66]]) {
        plate(c, ox * L - 5, oy * Wd - 4, 10, 8, 3, '#15181b'); // roues
      }
      plate(c, -L / 2, -Wd / 2, L, Wd, 5, HULL_MID);
      plate(c, L * 0.16, -Wd / 2 + 2, L * 0.34, Wd - 4, 4, col); // capot d'équipe
      const gr2 = c.createLinearGradient(0, -Wd * 0.3, 0, Wd * 0.3);
      gr2.addColorStop(0, '#dff0fa'); gr2.addColorStop(1, '#8fb6cf');
      c.fillStyle = gr2;
      c.fillRect(L * 0.0, -Wd * 0.3, L * 0.13, Wd * 0.6); // pare-brise
      plate(c, -L * 0.46, -Wd * 0.28, L * 0.3, Wd * 0.56, 3, HULL_DARK); // plateau arrière
      c.fillStyle = '#2c3136';
      c.beginPath(); c.arc(-L * 0.44, 0, Wd * 0.2, 0, Math.PI * 2); c.fill(); // roue de secours
      c.strokeStyle = '#14191e';
      c.lineWidth = 2;
      c.strokeRect(-L * 0.12, -Wd * 0.38, L * 0.28, Wd * 0.76);
      lamp(L * 0.5, -Wd * 0.24, 2.1);
      lamp(L * 0.5, Wd * 0.24, 2.1);
      whip(-L * 0.38, -Wd * 0.24, Wd * 0.7);
      greebles(c, -L * 0.4, -Wd * 0.4, L * 0.3, Wd * 0.8, seed, 4);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
    } else if (type === 'tank' || type === 'heavytank') {
      const heavy = type === 'heavytank';
      const L = r * (heavy ? 2.5 : 2.4), Wd = r * (heavy ? 2.1 : 2.0);
      tracks(c, -L / 2, -Wd / 2, L, Wd * (heavy ? 0.3 : 0.26));
      tracks(c, -L / 2, Wd / 2 - Wd * (heavy ? 0.3 : 0.26), L, Wd * (heavy ? 0.3 : 0.26));
      armor(c, [
        [-L * 0.48, -Wd * 0.28], [L * 0.22, -Wd * 0.28], [L * 0.5, 0],
        [L * 0.22, Wd * 0.28], [-L * 0.48, Wd * 0.28],
      ], HULL_MID);
      armor(c, [[L * 0.2, -Wd * 0.26], [L * 0.47, 0], [L * 0.2, Wd * 0.26]], col); // glacis d'équipe
      plate(c, -L * 0.16, -Wd * 0.18, L * 0.24, Wd * 0.12, 2, '#2a3036');
      plate(c, -L * 0.16, Wd * 0.06, L * 0.24, Wd * 0.12, 2, '#2a3036');
      armorBolts(-L * 0.42, -Wd * 0.31, L * 0.72, Wd * 0.62, heavy ? 8 : 6);
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1; // grilles moteur
      for (let k = 0; k < 4; k++) {
        c.beginPath();
        c.moveTo(-L * (0.44 - k * 0.045), -Wd * 0.2);
        c.lineTo(-L * (0.44 - k * 0.045), Wd * 0.2);
        c.stroke();
      }
      greebles(c, -L * 0.3, -Wd * 0.24, L * 0.4, Wd * 0.48, seed, heavy ? 7 : 5);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
      // tourelle (sprite séparé, pivote vers la cible)
      const [tcv, tc] = this.newSprite(2.6);
      const tr = Wd * (heavy ? 0.36 : 0.32);
      if (heavy) {
        barrel(tc, tr * 0.4, -Wd * 0.13, L * 0.78, 5);
        barrel(tc, tr * 0.4, Wd * 0.13, L * 0.78, 5);
        plate(tc, -tr, -tr * 0.85, tr * 2, tr * 1.7, tr * 0.4, HULL_DARK);
        plate(tc, -tr * 0.62, -tr * 0.55, tr * 1.24, tr * 1.1, tr * 0.3, col);
        tc.fillStyle = '#20262b';
        tc.fillRect(-tr * 0.2, -tr * 0.85, tr * 0.38, tr * 0.16);
      } else {
        barrel(tc, tr * 0.3, 0, L * 0.8, 5.5);
        const gr2 = tc.createRadialGradient(-tr * 0.3, -tr * 0.3, 2, 0, 0, tr);
        gr2.addColorStop(0, shade(HULL_DARK, 0.35)); gr2.addColorStop(1, shade(HULL_DARK, -0.2));
        tc.fillStyle = gr2;
        tc.beginPath(); tc.arc(0, 0, tr, 0, Math.PI * 2); tc.fill();
        tc.strokeStyle = 'rgba(0,0,0,0.5)'; tc.lineWidth = 1.5; tc.stroke();
        const gr3 = tc.createRadialGradient(-tr * 0.2, -tr * 0.2, 1, 0, 0, tr * 0.66);
        gr3.addColorStop(0, shade(col, 0.25)); gr3.addColorStop(1, shade(col, -0.25));
        tc.fillStyle = gr3;
        tc.beginPath(); tc.arc(0, 0, tr * 0.66, 0, Math.PI * 2); tc.fill();
        tc.fillStyle = 'rgba(255,255,255,0.4)';
        tc.beginPath(); tc.arc(-tr * 0.2, -tr * 0.2, tr * 0.18, 0, Math.PI * 2); tc.fill(); // écoutille
        tc.strokeStyle = '#151a1f';
        tc.lineWidth = 1.2;
        tc.beginPath(); tc.arc(-tr * 0.2, -tr * 0.2, tr * 0.25, 0, Math.PI * 2); tc.stroke();
      }
      turretCv = tcv;
    } else if (type === 'artillery' || type === 'heavyarty') {
      const heavy = type === 'heavyarty';
      const L = r * (heavy ? 2.5 : 2.3), Wd = r * (heavy ? 2.0 : 1.5);
      if (heavy) {
        c.strokeStyle = '#2c3136'; c.lineWidth = 5; // vérins
        for (const [vx2, vy2] of [[-0.5, -0.55], [-0.5, 0.55], [0.35, -0.55], [0.35, 0.55]]) {
          c.beginPath(); c.moveTo(vx2 * L * 0.6, vy2 * Wd * 0.5); c.lineTo(vx2 * L, vy2 * Wd); c.stroke();
          c.fillStyle = '#1d2126';
          c.beginPath(); c.arc(vx2 * L, vy2 * Wd, 4, 0, Math.PI * 2); c.fill();
        }
      } else {
        tracks(c, -L / 2, -Wd / 2, L, Wd * 0.2);
        tracks(c, -L / 2, Wd / 2 - Wd * 0.2, L, Wd * 0.2);
      }
      plate(c, -L / 2, -Wd * 0.32, L, Wd * 0.64, 5, HULL_MID);
      plate(c, heavy ? L * 0.26 : -L * 0.44, -Wd * 0.3, L * 0.2, Wd * 0.6, 3, col); // panneau d'équipe
      // plaque arrière à rayures
      plate(c, -L * 0.62, -Wd * 0.52, L * 0.16, Wd * 1.04, 2, '#2c3136');
      c.fillStyle = '#e8c84a';
      c.fillRect(-L * 0.62, -Wd * 0.52, L * 0.16, Wd * 0.14);
      c.fillRect(-L * 0.62, Wd * 0.38, L * 0.16, Wd * 0.14);
      c.fillStyle = '#1d2227';
      c.fillRect(-L * 0.45, -Wd * 0.42, L * 0.18, Wd * 0.18);
      c.fillRect(-L * 0.45, Wd * 0.24, L * 0.18, Wd * 0.18);
      // berceau + cylindres de recul + canon
      plate(c, -L * 0.12, -Wd * 0.2, L * 0.34, Wd * 0.4, 3, HULL_DARK);
      c.strokeStyle = '#9aa6b0'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-L * 0.02, -Wd * 0.12); c.lineTo(L * 0.45, -Wd * 0.12); c.stroke();
      c.beginPath(); c.moveTo(-L * 0.02, Wd * 0.12); c.lineTo(L * 0.45, Wd * 0.12); c.stroke();
      barrel(c, -L * 0.05, 0, L * (heavy ? 1.0 : 1.12), heavy ? 9 : 6);
      if (heavy) {
        c.fillStyle = '#1d2126';
        c.beginPath(); c.arc(-L * 0.1, 0, Wd * 0.34, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#9aa6b0'; c.lineWidth = 1.5; c.stroke();
      }
      greebles(c, -L * 0.45, -Wd * 0.28, L * 0.3, Wd * 0.56, seed, 4);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
    } else if (type === 'harvester') {
      const L = r * 2.7, Wd = r * 2.1;
      tracks(c, -L / 2, -Wd / 2, L, Wd * 0.2);
      tracks(c, -L / 2, Wd / 2 - Wd * 0.2, L, Wd * 0.2);
      plate(c, -L / 2, -Wd * 0.34, L, Wd * 0.68, 6, HULL_MID);
      armor(c, [ // chevron industriel d'équipe
        [L * 0.16, -Wd * 0.34], [L * 0.32, -Wd * 0.34], [L * 0.42, 0],
        [L * 0.32, Wd * 0.34], [L * 0.16, Wd * 0.34], [L * 0.28, 0],
      ], col);
      // tambour d'admission
      plate(c, L * 0.42, -Wd * 0.5, L * 0.28, Wd, 4, '#33393f');
      c.strokeStyle = '#9aa6b0'; c.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        const yy = -Wd * 0.42 + k * Wd * 0.28;
        c.beginPath(); c.moveTo(L * 0.44, yy); c.lineTo(L * 0.68, yy); c.stroke();
      }
      // benne (le remplissage est dessiné en direct)
      plate(c, -L * 0.44, -Wd * 0.32, L * 0.58, Wd * 0.64, 4, '#1d2126');
      c.fillStyle = '#2c3136'; // cheminées
      c.beginPath(); c.arc(L * 0.3, -Wd * 0.4, 4.4, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(L * 0.3, Wd * 0.4, 4.4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#8c969f';
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(-L * 0.15, -Wd * 0.36); c.lineTo(-L * 0.36, -Wd * 0.58); c.stroke();
      c.beginPath(); c.moveTo(-L * 0.15, Wd * 0.36); c.lineTo(-L * 0.36, Wd * 0.58); c.stroke();
      lamp(L * 0.62, -Wd * 0.28, 2.4, '#f0c44f');
      lamp(L * 0.62, Wd * 0.28, 2.4, '#f0c44f');
      greebles(c, -L * 0.4, -Wd * 0.28, L * 0.2, Wd * 0.56, seed, 4);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
    } else if (type === 'tankdestroyer') {
      const L = r * 2.6, Wd = r * 1.8;
      tracks(c, -L / 2, -Wd / 2, L, Wd * 0.22);
      tracks(c, -L / 2, Wd / 2 - Wd * 0.22, L, Wd * 0.22);
      armor(c, [
        [-L * 0.46, -Wd * 0.3], [L * 0.2, -Wd * 0.3], [L * 0.5, 0],
        [L * 0.2, Wd * 0.3], [-L * 0.46, Wd * 0.3],
      ], HULL_MID);
      armor(c, [ // bande dorsale d'équipe
        [-L * 0.46, -Wd * 0.08], [L * 0.38, -Wd * 0.08], [L * 0.5, 0],
        [L * 0.38, Wd * 0.08], [-L * 0.46, Wd * 0.08],
      ], col);
      armor(c, [ // casemate
        [-L * 0.3, -Wd * 0.18], [L * 0.08, -Wd * 0.18], [L * 0.24, 0],
        [L * 0.08, Wd * 0.18], [-L * 0.3, Wd * 0.18],
      ], HULL_DARK);
      barrel(c, L * 0.1, 0, L * 1.05, 5);
      greebles(c, -L * 0.28, -Wd * 0.16, L * 0.3, Wd * 0.32, seed, 4);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
    } else if (type === 'radarvehicle') {
      const L = r * 2.4, Wd = r * 1.6;
      for (const ox of [-0.36, 0, 0.36]) {
        plate(c, ox * L - 4.5, -Wd * 0.64 - 3.5, 9, 7, 3, '#15181b');
        plate(c, ox * L - 4.5, Wd * 0.64 - 3.5, 9, 7, 3, '#15181b');
      }
      plate(c, -L / 2, -Wd / 2, L, Wd, 5, HULL_MID);
      plate(c, L * 0.3, -Wd / 2 + 2, L * 0.18, Wd - 4, 3, col);
      plate(c, -L * 0.48, -Wd / 2 + 2, L * 0.18, Wd - 4, 3, col);
      const gr2 = c.createRadialGradient(-2, -2, 1, 0, 0, Wd * 0.26);
      gr2.addColorStop(0, '#eaf6ff'); gr2.addColorStop(1, '#7da8c9');
      c.fillStyle = gr2;
      c.beginPath(); c.arc(0, 0, Wd * 0.26, 0, Math.PI * 2); c.fill(); // dôme
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1; c.stroke();
      whip(-L * 0.25, -Wd * 0.25, Wd * 0.9);
      c.strokeStyle = '#13191f';
      c.lineWidth = 1.4;
      c.beginPath(); c.arc(0, 0, Wd * 0.36, -0.35, 0.35); c.stroke();
      greebles(c, -L * 0.3, -Wd * 0.4, L * 0.5, Wd * 0.8, seed, 4);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
    } else if (type === 'mobilecmd') {
      const L = r * 2.7, Wd = r * 1.9;
      for (const [ox, oy] of [[-0.36, -0.62], [0, -0.62], [0.36, -0.62], [-0.36, 0.62], [0, 0.62], [0.36, 0.62]]) {
        plate(c, ox * L - 5, oy * Wd - 4, 10, 8, 3, '#15181b');
      }
      plate(c, -L / 2, -Wd / 2, L, Wd, 6, HULL_MID);
      plate(c, -L * 0.42, -Wd * 0.38, L * 0.46, Wd * 0.76, 4, '#23282e');
      plate(c, L * 0.1, -Wd * 0.34, L * 0.34, Wd * 0.68, 4, col);
      const gr2 = c.createRadialGradient(-2, -2, 1, 0, 0, Wd * 0.22);
      gr2.addColorStop(0, '#eef8ff'); gr2.addColorStop(1, '#5d8fb0');
      c.fillStyle = gr2;
      c.beginPath(); c.arc(-L * 0.18, 0, Wd * 0.2, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#9aa6b0'; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(-L * 0.18, -Wd * 0.2); c.lineTo(-L * 0.18, -Wd * 0.56); c.stroke();
      c.beginPath(); c.arc(-L * 0.18, -Wd * 0.6, Wd * 0.12, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#e8c84a';
      c.fillRect(L * 0.3, -Wd * 0.42, L * 0.11, Wd * 0.84);
      whip(-L * 0.38, -Wd * 0.38, Wd * 0.9);
      whip(-L * 0.28, Wd * 0.38, Wd * 0.75);
      lamp(L * 0.48, -Wd * 0.24, 2.3, '#d7c77b');
      lamp(L * 0.48, Wd * 0.24, 2.3, '#d7c77b');
      greebles(c, -L * 0.45, -Wd * 0.42, L * 0.75, Wd * 0.84, seed, 8);
      weather(c, -L / 2, -Wd / 2, L, Wd, seed);
    }
    industrialFinish(c, -T * 1.35, -T * 1.1, T * 2.7, T * 2.2, seed, 0.95);
    if (turretCv) {
      const tc = turretCv.getContext('2d')!;
      industrialFinish(tc, -T * 1.1, -T * 1.1, T * 2.2, T * 2.2, seed + 17, 0.85);
    }
    return { body: cv, turret: turretCv };
  }

  // Rendu d'une unité via son sprite haute résolution + surcouches dynamiques.
  private drawUnitSprite(
    ctx: CanvasRenderingContext2D, g: Game, u: Unit,
    sx: (x: number) => number, sy: (y: number) => number, z: number, selected: boolean,
    ox?: number, oy?: number,  // position visuelle alternative (sortie de bâtiment)
  ) {
    const def = UNITS[u.type];
    const px = sx(ox ?? u.x), py = sy(oy ?? u.y);
    const col = PLAYER_COLORS[u.owner];
    const spr = this.unitSprites(u.type, u.owner);
    const visualScale = this.unitVisualScale(u.type, def);
    const s = (z / SPX) * visualScale;

    if (selected) {
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.42) * z, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(3, z * 0.14);
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.32) * z, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(2, z * 0.1);
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.3) * z, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.3) * z, 0, Math.PI * 2); ctx.stroke();
    }

    // ----- OMBRE PROJETÉE AU SOL : direction FIXE selon la lumière (nord-ouest →
    // ombre vers le sud-est), INDÉPENDANTE de l'orientation du véhicule. Elle ne
    // tourne donc pas avec lui : c'est une vraie ombre au sol, pas un élément
    // accroché. Ellipse douce aplatie, déportée vers le SE.
    {
      const inf = def.armor === 'inf';
      const rad = (inf ? def.radius * 1.05 : def.radius * 1.3 * visualScale) * z;
      ctx.save();
      ctx.translate(px + rad * 0.34, py + rad * 0.40);   // décalage SE (= sens de la lumière)
      ctx.rotate(Math.PI * 0.25);                        // allongement FIXE vers le SE (pas u.dir)
      ctx.scale(1.15, 0.5);
      const sg = ctx.createRadialGradient(0, 0, rad * 0.2, 0, 0, rad);
      sg.addColorStop(0, 'rgba(0,0,0,0.4)');
      sg.addColorStop(0.6, 'rgba(0,0,0,0.26)');
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Corps unique, CENTRÉ sur la position de l'unité (l'ombre reste dessous).
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(u.dir);
    ctx.drawImage(spr.body, -spr.body.width / 2 * s, -spr.body.height / 2 * s, spr.body.width * s, spr.body.height * s);
    if (u.type === 'harvester' && u.cargo > 1) {
      const L = def.radius * 2.7 * z * visualScale, Wd = def.radius * 2.1 * z * visualScale;
      const fillF = Math.min(1, u.cargo / 320);
      ctx.fillStyle = u.cargoValue > u.cargo * 1.5 ? '#c43050' : '#e7c44a';
      this.rr(ctx, -L * 0.42, -Wd * 0.27, L * 0.52 * fillF, Wd * 0.54, z * 0.05 * visualScale);
      ctx.fill();
    }
    ctx.restore();

    // tourelle pivotante (tank, tank lourd)
    if (spr.turret) {
      let tAng = u.dir;
      if (u.engageId) {
        const tgt = u.engageIsBuilding ? g.buildingById.get(u.engageId) : g.unitById.get(u.engageId);
        if (tgt) {
          const bx = u.engageIsBuilding
            ? (tgt as { tx: number; w: number }).tx + (tgt as { w: number }).w / 2
            : (tgt as { x: number }).x;
          const by = u.engageIsBuilding
            ? (tgt as { ty: number; h: number }).ty + (tgt as { h: number }).h / 2
            : (tgt as { y: number }).y;
          tAng = Math.atan2(by - u.y, bx - u.x);
        }
      }
      const pivot = -def.radius * 0.12 * z;
      const tx2 = px + Math.cos(u.dir) * pivot, ty2 = py + Math.sin(u.dir) * pivot;
      // la tourelle coiffe le corps (corps désormais centré) : légère surépaisseur
      for (const [img, dy] of [
        [spr.turretSide ?? spr.turret, z * 0.02],
        [spr.turret, -z * 0.05],
      ] as [HTMLCanvasElement, number][]) {
        ctx.save();
        ctx.translate(tx2, ty2 + dy);
        ctx.rotate(tAng);
        ctx.drawImage(img, -img.width / 2 * s, -img.height / 2 * s, img.width * s, img.height * s);
        ctx.restore();
      }
    }

    if (def.armor !== 'inf') {
      // Petits feux et reflets métalliques : améliore la lisibilité premium des
      // véhicules sans ajouter d'état ni de particules.
      const fx = Math.cos(u.dir), fy = Math.sin(u.dir);
      const oxp = -fy * def.radius * 0.42 * z;
      const oyp = fx * def.radius * 0.42 * z;
      const nose = def.radius * 0.9 * z;
      const lx = px + fx * nose;
      const ly = py + fy * nose;
      const lampR = Math.max(1, z * 0.045);
      ctx.fillStyle = 'rgba(255,224,145,0.52)';
      ctx.beginPath(); ctx.arc(lx + oxp, ly + oyp, lampR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(lx - oxp, ly - oyp, lampR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = Math.max(1, z * 0.025);
      ctx.beginPath();
      ctx.moveTo(px - fx * def.radius * 0.45 * z - oxp * 0.55, py - fy * def.radius * 0.45 * z - oyp * 0.55);
      ctx.lineTo(px + fx * def.radius * 0.32 * z - oxp * 0.55, py + fy * def.radius * 0.32 * z - oyp * 0.55);
      ctx.stroke();
    }

    // surcouches non orientées
    if (u.type === 'kamikaze') {
      const pulse = 0.45 + 0.35 * Math.sin(g.time * 7 + u.id);
      ctx.strokeStyle = `rgba(255,70,70,${pulse})`;
      ctx.lineWidth = Math.max(1.5, z * 0.09);
      ctx.beginPath(); ctx.arc(px, py, def.radius * 1.35 * z, 0, Math.PI * 2); ctx.stroke();
    } else if (u.type === 'radarvehicle') {
      const sweep = g.time * 2.4 + u.id;
      ctx.strokeStyle = '#9ad0ff';
      ctx.lineWidth = Math.max(2, z * 0.1);
      ctx.beginPath(); ctx.arc(px, py, def.radius * 0.9 * z, sweep, sweep + Math.PI * 0.7); ctx.stroke();
    }

    if (selected || u.hp < u.maxHp) {
      this.healthBar(ctx, px, py - (def.radius + 0.45) * z, Math.max(14, def.radius * 2.4 * z), u.hp / u.maxHp, selected);
    }
  }

  // (ancien rendu vectoriel direct, conservé en secours)
  private drawUnit(
    ctx: CanvasRenderingContext2D, g: Game, u: Unit,
    sx: (x: number) => number, sy: (y: number) => number, z: number, selected: boolean,
  ) {
    const def = UNITS[u.type];
    const px = sx(u.x), py = sy(u.y);
    const col = PLAYER_COLORS[u.owner];

    if (selected) {
      // double anneau : couleur d'équipe + cœur blanc
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.42) * z, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(3, z * 0.14);
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.32) * z, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(2, z * 0.1);
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.3) * z, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.3) * z, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.save();
    ctx.translate(px, py);
    // ombre au sol douce, commune à toutes les unités terrestres
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(z * 0.08, z * 0.12, def.radius * 1.2 * z, def.radius * 0.85 * z, 0, 0, Math.PI * 2);
    ctx.fill();

    if (def.armor === 'inf') {
      const r = def.radius * z;
      // ombre + corps commun
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(z * 0.05, z * 0.08, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // reflet de casque (lumière zénithale)
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = Math.max(1, z * 0.05);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.72, -2.4, -1.2); ctx.stroke();
      const dirX = Math.cos(u.dir), dirY = Math.sin(u.dir);
      // épaules : petit trait perpendiculaire à la visée (donne une posture)
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = Math.max(1.4, z * 0.1);
      ctx.beginPath();
      ctx.moveTo(-dirY * r * 0.8, dirX * r * 0.8);
      ctx.lineTo(dirY * r * 0.8, -dirX * r * 0.8);
      ctx.stroke();

      if (u.type === 'rifle') {
        // fusilier : casque sombre, fusil deux tons (crosse bois + canon clair), sac à dos
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#6e5a3a';
        ctx.fillRect(-dirX * r * 1.0 - z * 0.06, -dirY * r * 1.0 - z * 0.06, z * 0.12, z * 0.12); // sac
        ctx.strokeStyle = '#7a5c34'; // crosse
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.2, dirY * r * 0.2);
        ctx.lineTo(dirX * r * 0.8, dirY * r * 0.8);
        ctx.stroke();
        ctx.strokeStyle = '#e8eef2'; // canon
        ctx.lineWidth = Math.max(1, z * 0.055);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.8, dirY * r * 0.8);
        ctx.lineTo(dirX * r * 1.6, dirY * r * 1.6);
        ctx.stroke();
      } else if (u.type === 'bazooka') {
        // bazooka : gros tube kaki sur l'épaule, gueule sombre, embout rouge, genou à terre
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.arc(-dirY * r * 0.55, dirX * r * 0.55, Math.max(1.2, z * 0.07), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#b09040';
        ctx.lineWidth = Math.max(2.4, z * 0.16);
        ctx.beginPath();
        ctx.moveTo(-dirX * r * 1.0, -dirY * r * 1.0);
        ctx.lineTo(dirX * r * 1.9, dirY * r * 1.9);
        ctx.stroke();
        ctx.strokeStyle = '#2c3136'; // gueule du tube
        ctx.lineWidth = Math.max(2.8, z * 0.2);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 1.55, dirY * r * 1.55);
        ctx.lineTo(dirX * r * 1.9, dirY * r * 1.9);
        ctx.stroke();
        ctx.fillStyle = '#ff5e72';
        ctx.beginPath(); ctx.arc(-dirX * r * 1.0, -dirY * r * 1.0, Math.max(1.5, z * 0.09), 0, Math.PI * 2); ctx.fill();
      } else if (u.type === 'sniper') {
        // sniper : ghillie sombre irrégulière, très long canon, lunette, bipied
        ctx.fillStyle = 'rgba(20,28,18,0.55)';
        for (const [ox, oy] of [[0, 0], [0.5, 0.3], [-0.4, 0.4], [0.2, -0.5]]) {
          ctx.beginPath(); ctx.arc(ox * r, oy * r, r * 0.62, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = '#dfe5ea';
        ctx.lineWidth = Math.max(1, z * 0.045);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.3, dirY * r * 0.3);
        ctx.lineTo(dirX * r * 2.7, dirY * r * 2.7);
        ctx.stroke();
        // bipied
        ctx.beginPath();
        ctx.moveTo(dirX * r * 2.3 - dirY * r * 0.35, dirY * r * 2.3 + dirX * r * 0.35);
        ctx.lineTo(dirX * r * 2.3 + dirY * r * 0.35, dirY * r * 2.3 - dirX * r * 0.35);
        ctx.stroke();
        ctx.fillStyle = '#9ad0ff'; // lunette
        ctx.beginPath(); ctx.arc(dirX * r * 1.0, dirY * r * 1.0, Math.max(1.3, z * 0.08), 0, Math.PI * 2); ctx.fill();
      } else if (u.type === 'engineer') {
        // ingénieur : casque de chantier à visière, boîte à outils orange, clé
        ctx.fillStyle = '#ffd84d';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.64, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#c79a20';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, r * 0.64, u.dir - 0.7, u.dir + 0.7); ctx.stroke();
        ctx.fillStyle = '#e07b2c'; // boîte à outils
        ctx.fillRect(-dirY * r * 1.05 - z * 0.09, dirX * r * 1.05 - z * 0.06, z * 0.18, z * 0.12);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath();
        ctx.moveTo(-r * 0.55, r * 0.55); ctx.lineTo(r * 0.55, -r * 0.55);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(r * 0.6, -r * 0.6, Math.max(1.2, z * 0.07), 0, Math.PI * 1.4); ctx.stroke();
      } else if (u.type === 'elite') {
        // fusilier d'élite : liseré doré, fusil à baïonnette, béret sombre
        ctx.strokeStyle = '#e7c44a';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath(); ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e8eef2';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.25, dirY * r * 0.25);
        ctx.lineTo(dirX * r * 1.75, dirY * r * 1.75);
        ctx.stroke();
        ctx.strokeStyle = '#e7c44a'; // baïonnette
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 1.75, dirY * r * 1.75);
        ctx.lineTo(dirX * r * 2.05, dirY * r * 2.05);
        ctx.stroke();
      } else if (u.type === 'rocketeer') {
        // lance-roquettes lourd : double tube + râtelier de roquettes dorsal
        ctx.strokeStyle = '#8a7430';
        ctx.lineWidth = Math.max(3.2, z * 0.24);
        ctx.beginPath();
        ctx.moveTo(-dirX * r * 1.0, -dirY * r * 1.0);
        ctx.lineTo(dirX * r * 2.0, dirY * r * 2.0);
        ctx.stroke();
        ctx.strokeStyle = '#1d2126'; // séparation des deux tubes
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath();
        ctx.moveTo(-dirX * r * 1.0, -dirY * r * 1.0);
        ctx.lineTo(dirX * r * 2.0, dirY * r * 2.0);
        ctx.stroke();
        ctx.fillStyle = '#ff5e72';
        ctx.beginPath(); ctx.arc(dirX * r * 2.0, dirY * r * 2.0, Math.max(1.8, z * 0.11), 0, Math.PI * 2); ctx.fill();
        // râtelier dorsal
        ctx.fillStyle = '#5a4d28';
        ctx.fillRect(-dirX * r * 1.15 - z * 0.1, -dirY * r * 1.15 - z * 0.1, z * 0.2, z * 0.2);
      } else if (u.type === 'kamikaze') {
        // kamikaze : gilet d'explosifs visible + anneau rouge pulsant
        const pulse = 0.45 + 0.35 * Math.sin(g.time * 7 + u.id);
        ctx.strokeStyle = `rgba(255,70,70,${pulse})`;
        ctx.lineWidth = Math.max(1.5, z * 0.09);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#2c1416';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#c23030';
        for (const a of [-0.8, 0, 0.8]) {
          const bx = Math.cos(u.dir + a + Math.PI) * r * 0.45;
          const by = Math.sin(u.dir + a + Math.PI) * r * 0.45;
          ctx.fillRect(bx - z * 0.05, by - z * 0.05, z * 0.1, z * 0.1);
        }
      }
    } else {
      ctx.rotate(u.dir);

      if (u.type === 'jeep') {
        // jeep : petite, fine, 4 roues visibles, pare-brise clair, antenne
        const L = def.radius * 2.3 * z, Wd = def.radius * 1.35 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const wr = Math.max(1.5, z * 0.09);
        for (const [ox, oy] of [[-0.32, -0.62], [0.32, -0.62], [-0.32, 0.62], [0.32, 0.62]]) {
          ctx.fillRect(ox * L - wr, oy * Wd - wr, wr * 2, wr * 2);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.1); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // capot avant à la couleur de l'équipe
        ctx.fillStyle = col;
        this.rr(ctx, L * 0.18, -Wd / 2, L * 0.32, Wd, z * 0.08); ctx.fill();
        ctx.fillStyle = 'rgba(220,235,245,0.85)';
        ctx.fillRect(L * 0.02, -Wd * 0.32, L * 0.14, Wd * 0.64);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-L * 0.3, 0); ctx.lineTo(-L * 0.3, -Wd * 0.9); ctx.stroke();
      } else if (u.type === 'tank') {
        // tank : chenilles à galets, glacis, tourelle ORIENTABLE + canon à manchon
        const L = def.radius * 2.4 * z, Wd = def.radius * 2.0 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.06, -Wd / 2 + z * 0.08, L, Wd, z * 0.08); ctx.fill();
        // chenilles avec galets
        ctx.fillStyle = '#23282c';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.26, z * 0.06); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.26, L, Wd * 0.26, z * 0.06); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        for (let k = -2; k <= 2; k++) {
          ctx.beginPath(); ctx.arc(k * L * 0.18, -Wd * 0.37, Math.max(1, Wd * 0.07), 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(k * L * 0.18, Wd * 0.37, Math.max(1, Wd * 0.07), 0, Math.PI * 2); ctx.fill();
        }
        // caisse métal neutre + glacis avant à la couleur de l'équipe
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L * 0.46, -Wd * 0.27, L * 0.92, Wd * 0.54, z * 0.07); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(L * 0.22, -Wd * 0.27); ctx.lineTo(L * 0.46, 0); ctx.lineTo(L * 0.22, Wd * 0.27);
        ctx.closePath(); ctx.fill();
        // grilles moteur arrière
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.moveTo(-L * (0.42 - k * 0.05), -Wd * 0.18);
          ctx.lineTo(-L * (0.42 - k * 0.05), Wd * 0.18);
          ctx.stroke();
        }
        // tourelle orientée vers la cible engagée
        let tAng = 0;
        if (u.engageId) {
          const tgt = u.engageIsBuilding ? g.buildingById.get(u.engageId) : g.unitById.get(u.engageId);
          if (tgt) {
            const tx2 = 'x' in tgt ? (tgt as { x: number }).x : 0;
            const ty2 = 'y' in tgt ? (tgt as { y: number }).y : 0;
            const bx = u.engageIsBuilding ? (tgt as { tx: number; w: number }).tx + (tgt as { w: number }).w / 2 : tx2;
            const by = u.engageIsBuilding ? (tgt as { ty: number; h: number }).ty + (tgt as { h: number }).h / 2 : ty2;
            tAng = Math.atan2(by - u.y, bx - u.x) - u.dir;
          }
        }
        ctx.save();
        ctx.translate(-L * 0.05, 0);
        ctx.rotate(tAng);
        ctx.fillStyle = HULL_DARK;
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.31, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col; // toit de tourelle à la couleur de l'équipe
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.23, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath(); ctx.arc(-Wd * 0.06, -Wd * 0.06, Wd * 0.09, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.11);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.74, 0); ctx.stroke();
        ctx.lineWidth = Math.max(2.5, z * 0.16);
        ctx.beginPath(); ctx.moveTo(L * 0.52, 0); ctx.lineTo(L * 0.68, 0); ctx.stroke();
        ctx.restore();
      } else if (u.type === 'artillery') {
        // artillerie : chenilles fines, plaque arrière hachurée, canon démesuré
        // avec cylindres de recul et frein de bouche
        const L = def.radius * 2.3 * z, Wd = def.radius * 1.5 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.08); ctx.fill();
        ctx.fillStyle = '#23282c';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.2, z * 0.05); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.2, L, Wd * 0.2, z * 0.05); ctx.fill();
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L * 0.46, -Wd * 0.3, L * 0.92, Wd * 0.6, z * 0.08); ctx.fill();
        // panneaux latéraux à la couleur de l'équipe
        ctx.fillStyle = col;
        this.rr(ctx, -L * 0.42, -Wd * 0.28, L * 0.5, Wd * 0.14, z * 0.04); ctx.fill();
        this.rr(ctx, -L * 0.42, Wd * 0.14, L * 0.5, Wd * 0.14, z * 0.04); ctx.fill();
        // plaque de stabilisation arrière à rayures de danger
        ctx.fillStyle = '#2c3136';
        ctx.fillRect(-L * 0.64, -Wd * 0.55, L * 0.2, Wd * 1.1);
        ctx.fillStyle = '#e8c84a';
        ctx.fillRect(-L * 0.64, -Wd * 0.55, L * 0.2, Wd * 0.16);
        ctx.fillRect(-L * 0.64, Wd * 0.39, L * 0.2, Wd * 0.16);
        // berceau + cylindres de recul + très long canon + frein de bouche
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-L * 0.15, -Wd * 0.22, L * 0.4, Wd * 0.44);
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.moveTo(-L * 0.05, -Wd * 0.12); ctx.lineTo(L * 0.45, -Wd * 0.12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-L * 0.05, Wd * 0.12); ctx.lineTo(L * 0.45, Wd * 0.12); ctx.stroke();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.12);
        ctx.beginPath(); ctx.moveTo(-L * 0.1, 0); ctx.lineTo(L * 1.1, 0); ctx.stroke();
        ctx.lineWidth = Math.max(2.6, z * 0.18);
        ctx.beginPath(); ctx.moveTo(L * 0.95, 0); ctx.lineTo(L * 1.1, 0); ctx.stroke();
        ctx.strokeStyle = '#ffb060';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.moveTo(L * 0.8, -Wd * 0.18); ctx.lineTo(L * 0.8, Wd * 0.18); ctx.stroke();
      } else if (u.type === 'harvester') {
        // récolteur industriel : tambour d'admission denté, benne, cheminées
        const L = def.radius * 2.7 * z, Wd = def.radius * 2.1 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.06, -Wd / 2 + z * 0.08, L, Wd, z * 0.12); ctx.fill();
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.12); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // chevron d'équipe sur l'avant industriel
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(L * 0.18, -Wd * 0.5);
        ctx.lineTo(L * 0.34, -Wd * 0.5);
        ctx.lineTo(L * 0.42, 0);
        ctx.lineTo(L * 0.34, Wd * 0.5);
        ctx.lineTo(L * 0.18, Wd * 0.5);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.18, z * 0.1); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.18, L, Wd * 0.18, z * 0.1); ctx.fill();
        // tambour d'admission denté à l'avant (tourne quand il récolte)
        const spin = u.order.kind === 'harvest' && !u.path ? g.time * 6 : 0;
        ctx.fillStyle = '#3a4148';
        this.rr(ctx, L * 0.42, -Wd * 0.52, L * 0.3, Wd * 1.04, z * 0.06); ctx.fill();
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        for (let k = 0; k < 4; k++) {
          const off = ((spin + k * 0.8) % 3.2) / 3.2;
          const yy = -Wd * 0.45 + off * Wd * 0.9;
          ctx.beginPath(); ctx.moveTo(L * 0.44, yy); ctx.lineTo(L * 0.7, yy); ctx.stroke();
        }
        // benne : remplissage doré (ou rouge si minerai rare) proportionnel
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        this.rr(ctx, -L * 0.44, -Wd * 0.34, L * 0.62, Wd * 0.68, z * 0.06); ctx.fill();
        const fillF = Math.min(1, u.cargo / 320);
        if (fillF > 0.03) {
          const rareCargo = u.cargoValue > u.cargo * 1.5;
          ctx.fillStyle = rareCargo ? '#c43050' : '#e7c44a';
          this.rr(ctx, -L * 0.42, -Wd * 0.3, L * 0.58 * fillF, Wd * 0.6, z * 0.05); ctx.fill();
        }
        // cheminées d'échappement
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(L * 0.28, -Wd * 0.34, Math.max(1.4, z * 0.09), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(L * 0.28, Wd * 0.34, Math.max(1.4, z * 0.09), 0, Math.PI * 2); ctx.fill();
        // bande de sécurité
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(L * 0.2, -Wd * 0.5, z * 0.07, Wd);
      } else if (u.type === 'heavytank') {
        // tank lourd : massif, jupes latérales, tourelle large à DOUBLE canon
        const L = def.radius * 2.5 * z, Wd = def.radius * 2.1 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        this.rr(ctx, -L / 2 + z * 0.07, -Wd / 2 + z * 0.09, L, Wd, z * 0.08); ctx.fill();
        ctx.fillStyle = '#1d2126'; // jupes blindées couvrant les chenilles
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.3, z * 0.05); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.3, L, Wd * 0.3, z * 0.05); ctx.fill();
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L * 0.48, -Wd * 0.28, L * 0.96, Wd * 0.56, z * 0.06); ctx.fill();
        ctx.fillStyle = col; // glacis d'équipe
        ctx.beginPath();
        ctx.moveTo(L * 0.26, -Wd * 0.28); ctx.lineTo(L * 0.48, 0); ctx.lineTo(L * 0.26, Wd * 0.28);
        ctx.closePath(); ctx.fill();
        let tAng2 = 0;
        if (u.engageId) {
          const tgt = u.engageIsBuilding ? g.buildingById.get(u.engageId) : g.unitById.get(u.engageId);
          if (tgt) {
            const bx = u.engageIsBuilding
              ? (tgt as { tx: number; w: number }).tx + (tgt as { w: number }).w / 2
              : (tgt as { x: number }).x;
            const by = u.engageIsBuilding
              ? (tgt as { ty: number; h: number }).ty + (tgt as { h: number }).h / 2
              : (tgt as { y: number }).y;
            tAng2 = Math.atan2(by - u.y, bx - u.x) - u.dir;
          }
        }
        ctx.save();
        ctx.translate(-L * 0.06, 0);
        ctx.rotate(tAng2);
        ctx.fillStyle = '#1d2126';
        this.rr(ctx, -Wd * 0.34, -Wd * 0.3, Wd * 0.68, Wd * 0.6, z * 0.08); ctx.fill();
        ctx.fillStyle = col; // toit de tourelle d'équipe
        this.rr(ctx, -Wd * 0.22, -Wd * 0.2, Wd * 0.44, Wd * 0.4, z * 0.06); ctx.fill();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.1);
        ctx.beginPath(); ctx.moveTo(0, -Wd * 0.12); ctx.lineTo(L * 0.74, -Wd * 0.12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, Wd * 0.12); ctx.lineTo(L * 0.74, Wd * 0.12); ctx.stroke();
        ctx.lineWidth = Math.max(2.4, z * 0.15);
        ctx.beginPath(); ctx.moveTo(L * 0.56, -Wd * 0.12); ctx.lineTo(L * 0.7, -Wd * 0.12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(L * 0.56, Wd * 0.12); ctx.lineTo(L * 0.7, Wd * 0.12); ctx.stroke();
        ctx.restore();
      } else if (u.type === 'tankdestroyer') {
        // chasseur de chars : casemate basse fixe, très long canon, glacis anguleux
        const L = def.radius * 2.6 * z, Wd = def.radius * 1.8 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.06); ctx.fill();
        ctx.fillStyle = '#23282c';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.22, z * 0.04); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.22, L, Wd * 0.22, z * 0.04); ctx.fill();
        // coque anguleuse (pointe avant) en métal neutre
        ctx.fillStyle = HULL_MID;
        ctx.beginPath();
        ctx.moveTo(-L * 0.46, -Wd * 0.3);
        ctx.lineTo(L * 0.2, -Wd * 0.3);
        ctx.lineTo(L * 0.5, 0);
        ctx.lineTo(L * 0.2, Wd * 0.3);
        ctx.lineTo(-L * 0.46, Wd * 0.3);
        ctx.closePath(); ctx.fill();
        // bande dorsale d'équipe
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(-L * 0.46, -Wd * 0.08);
        ctx.lineTo(L * 0.38, -Wd * 0.08);
        ctx.lineTo(L * 0.5, 0);
        ctx.lineTo(L * 0.38, Wd * 0.08);
        ctx.lineTo(-L * 0.46, Wd * 0.08);
        ctx.closePath(); ctx.fill();
        // casemate sombre fixe
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.moveTo(-L * 0.3, -Wd * 0.18);
        ctx.lineTo(L * 0.1, -Wd * 0.18);
        ctx.lineTo(L * 0.26, 0);
        ctx.lineTo(L * 0.1, Wd * 0.18);
        ctx.lineTo(-L * 0.3, Wd * 0.18);
        ctx.closePath(); ctx.fill();
        // canon démesuré avec gros frein de bouche
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.1);
        ctx.beginPath(); ctx.moveTo(L * 0.1, 0); ctx.lineTo(L * 1.15, 0); ctx.stroke();
        ctx.lineWidth = Math.max(2.8, z * 0.18);
        ctx.beginPath(); ctx.moveTo(L * 0.98, 0); ctx.lineTo(L * 1.15, 0); ctx.stroke();
      } else if (u.type === 'heavyarty') {
        // artillerie lourde : plateforme à 4 vérins déployés + mortier énorme
        const L = def.radius * 2.5 * z, Wd = def.radius * 2.0 * z;
        ctx.strokeStyle = '#2c3136'; // vérins de stabilisation
        ctx.lineWidth = Math.max(2, z * 0.12);
        for (const [vx2, vy2] of [[-0.5, -0.55], [-0.5, 0.55], [0.35, -0.55], [0.35, 0.55]]) {
          ctx.beginPath();
          ctx.moveTo(vx2 * L * 0.6, vy2 * Wd * 0.5);
          ctx.lineTo(vx2 * L, vy2 * Wd);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.06, -Wd / 2 + z * 0.08, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.1); ctx.fill();
        // panneaux avant d'équipe
        ctx.fillStyle = col;
        this.rr(ctx, L * 0.26, -Wd * 0.46, L * 0.2, Wd * 0.92, z * 0.05); ctx.fill();
        // plateau tournant + mortier massif
        ctx.fillStyle = '#1d2126';
        ctx.beginPath(); ctx.arc(-L * 0.1, 0, Wd * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.arc(-L * 0.1, 0, Wd * 0.38, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#dfe5ea';
        ctx.lineWidth = Math.max(4, z * 0.26);
        ctx.beginPath(); ctx.moveTo(-L * 0.1, 0); ctx.lineTo(L * 0.85, 0); ctx.stroke();
        ctx.strokeStyle = '#2c3136';
        ctx.lineWidth = Math.max(5, z * 0.34);
        ctx.beginPath(); ctx.moveTo(L * 0.6, 0); ctx.lineTo(L * 0.85, 0); ctx.stroke();
        ctx.fillStyle = '#e8c84a'; // rayures de danger
        ctx.fillRect(-L * 0.52, -Wd * 0.52, L * 0.1, Wd * 0.18);
        ctx.fillRect(-L * 0.52, Wd * 0.34, L * 0.1, Wd * 0.18);
      } else if (u.type === 'radarvehicle') {
        // véhicule radar : châssis 6 roues + grande parabole rotative
        const L = def.radius * 2.4 * z, Wd = def.radius * 1.6 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const wr2 = Math.max(1.4, z * 0.08);
        for (const ox2 of [-0.36, 0, 0.36]) {
          ctx.fillRect(ox2 * L - wr2, -Wd * 0.62 - wr2, wr2 * 2, wr2 * 2);
          ctx.fillRect(ox2 * L - wr2, Wd * 0.62 - wr2, wr2 * 2, wr2 * 2);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = HULL_MID;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.1); ctx.fill();
        // bandes d'équipe avant/arrière
        ctx.fillStyle = col;
        this.rr(ctx, L * 0.32, -Wd / 2, L * 0.16, Wd, z * 0.05); ctx.fill();
        this.rr(ctx, -L * 0.48, -Wd / 2, L * 0.16, Wd, z * 0.05); ctx.fill();
        // parabole rotative (animée) + dôme
        const sweep = g.time * 2.4 + u.id;
        ctx.strokeStyle = '#9ad0ff';
        ctx.lineWidth = Math.max(2, z * 0.1);
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.55, sweep - u.dir, sweep - u.dir + Math.PI * 0.7); ctx.stroke();
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.24, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.1, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    if (selected || u.hp < u.maxHp) {
      this.healthBar(ctx, px, py - (def.radius + 0.45) * z, Math.max(14, def.radius * 2.4 * z), u.hp / u.maxHp, selected);
    }
  }

  // --------------------------------------------------------------- bâtiments

  private buildingVisualScale(type: string) {
    switch (type) {
      case 'hq':
        return 1.14;
      case 'factory2':
      case 'refinery2':
      case 'power2':
      case 'lab':
        return 1.17;
      case 'factory':
      case 'refinery':
      case 'airport':
      case 'helipad':
      case 'radarcenter':
        return 1.14;
      case 'barracks2':
      case 'tech':
      case 'radar':
        return 1.12;
      case 'turret':
      case 'atgun':
      case 'aa':
        return 1.08;
      default:
        return 1.1;
    }
  }

  // Rendu via sprite courbe pré-cuit + surcouches animées.
  private drawBuildingSprite(
    ctx: CanvasRenderingContext2D, g: Game, b: Building,
    sx: (x: number) => number, sy: (y: number) => number, z: number,
    selected: boolean,
  ) {
    const px = sx(b.tx - 0.5), py = sy(b.ty - 0.5);
    const bw = b.w * z, bh = b.h * z;
    const col = PLAYER_COLORS[b.owner];
    const cx = px + bw / 2, cy = py + bh / 2;
    const spr = this.buildingSprite(b.type, b.owner);
    const visualScale = this.buildingVisualScale(b.type);
    const s = (z / 44) * visualScale;
    const sw = spr.width * s, sh = spr.height * s;
    const bx0 = cx - sw / 2, by0 = cy - sh / 2;
    const drawBuildProgress = (progress: number, fill: string) => {
      const barW = Math.max(18, Math.min(bw * 0.82, sw * 0.52));
      const barH = Math.max(3, Math.min(5, z * 0.11));
      const barX = cx - barW / 2;
      const barY = Math.min(py + bh + z * 0.12, cy + sh * 0.34);
      const pct = Math.max(0, Math.min(1, progress));

      ctx.save();
      ctx.fillStyle = 'rgba(5,7,9,0.72)';
      this.rr(ctx, barX - 1, barY - 1, barW + 2, barH + 2, barH * 0.7);
      ctx.fill();
      ctx.fillStyle = '#15181c';
      this.rr(ctx, barX, barY, barW, barH, barH * 0.55);
      ctx.fill();
      if (pct > 0) {
        ctx.fillStyle = fill;
        this.rr(ctx, barX, barY, barW * pct, barH, barH * 0.55);
        ctx.fill();
      }
      ctx.restore();
    };

    // Ombre d'assise commune : les sprites pré-cuits ont du volume, mais cette
    // ellipse les ancre toujours au terrain courant, quelle que soit la taille.
    ctx.save();
    const shadowGrad = ctx.createRadialGradient(cx + z * 0.16, py + bh * 0.72, 0, cx + z * 0.16, py + bh * 0.72, Math.max(bw, bh) * 0.72);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0.28)');
    shadowGrad.addColorStop(0.62, 'rgba(0,0,0,0.12)');
    shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.ellipse(cx + z * 0.16, py + bh * 0.72, bw * 0.62, bh * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (!b.built) {
      // ================= CHANTIER en trois phases (purement visuel)
      this.constructing.add(b.id);
      const p = b.progress;
      const rngC = mulberry32(b.id * 97 + 13);

      // zone de chantier : terre retournée qui déborde de l'emprise
      ctx.fillStyle = 'rgba(62,52,38,0.35)';
      ctx.fillRect(px - z * 0.3, py - z * 0.3, bw + z * 0.6, bh + z * 0.6);

      // PHASE 1 — fondations : dalle coulée + treillis d'armatures
      const slabA = Math.min(1, p / 0.22);
      ctx.fillStyle = `rgba(125,130,134,${0.5 + 0.4 * slabA})`;
      ctx.fillRect(px + bw * 0.04, py + bh * 0.04, bw * 0.92, bh * 0.92);
      ctx.strokeStyle = 'rgba(58,62,66,0.55)';
      ctx.lineWidth = 1;
      const nGrid = 2 + b.w;
      for (let i = 1; i < nGrid; i++) {
        const fx2 = px + bw * 0.04 + (i * bw * 0.92) / nGrid;
        const fy2 = py + bh * 0.04 + (i * bh * 0.92) / nGrid;
        ctx.beginPath(); ctx.moveTo(fx2, py + bh * 0.06); ctx.lineTo(fx2, py + bh * 0.94); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + bw * 0.06, fy2); ctx.lineTo(px + bw * 0.94, fy2); ctx.stroke();
      }
      // contour peint du futur bâtiment + piquets d'angle
      ctx.strokeStyle = 'rgba(235,238,240,0.55)';
      ctx.lineWidth = Math.max(1, z * 0.05);
      ctx.setLineDash([z * 0.25, z * 0.2]);
      ctx.strokeRect(px, py, bw, bh);
      ctx.setLineDash([]);
      ctx.fillStyle = '#e3b94b';
      for (const [kx, ky] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        ctx.fillRect(px + kx * bw - z * 0.06, py + ky * bh - z * 0.06, z * 0.12, z * 0.12);
      }
      // matériel de chantier (caisses, madriers) qui s'épuise en fin de montage
      if (p < 0.85) {
        ctx.globalAlpha = Math.min(1, (0.85 - p) * 4);
        for (let k2 = 0; k2 < 3; k2++) {
          const mx = px + bw * (0.1 + rngC() * 0.7);
          const my = py + bh * (0.06 + rngC() * 0.16);
          const mw2 = z * (0.25 + rngC() * 0.2), mh2 = z * 0.16;
          ctx.fillStyle = k2 === 0 ? '#7a5b34' : '#6d6450';
          ctx.fillRect(mx, my, mw2, mh2);
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.lineWidth = 1;
          ctx.strokeRect(mx, my, mw2, mh2);
        }
        ctx.globalAlpha = 1;
      }

      // PHASE 2 — montage : ossature métallique + le bâtiment qui « monte »
      if (p >= 0.22) {
        const f = Math.min(1, (p - 0.22) / 0.7);
        ctx.strokeStyle = 'rgba(40,45,50,0.7)';
        ctx.lineWidth = Math.max(1.2, z * 0.06);
        const nCols = 1 + b.w;
        for (let i = 0; i <= nCols; i++) {
          const xx = px + (i * bw) / nCols;
          ctx.beginPath(); ctx.moveTo(xx, py + bh * 0.05); ctx.lineTo(xx, py + bh * 0.95); ctx.stroke();
        }
        ctx.lineWidth = 1;
        for (let i = 1; i <= 2; i++) {
          const yy = py + (i * bh) / 3;
          ctx.beginPath(); ctx.moveTo(px, yy); ctx.lineTo(px + bw, yy); ctx.stroke();
        }
        // révélation du sprite depuis le pied du bâtiment : la structure
        // s'élève du sol jusqu'au sommet (le canevas a une marge haute pour
        // les tours — on balaie du bas de l'emprise au haut du sprite)
        const yBot = py + bh + z * 0.45;
        const yFront = yBot - (yBot - by0) * f;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx0 - z, yFront, sw + z * 2, yBot - yFront + z * 0.2);
        ctx.clip();
        ctx.drawImage(spr, bx0, by0, sw, sh);
        ctx.restore();
        // poutre de levage jaune au front de montage + chariot mobile
        if (f < 1) {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(px - z * 0.2, yFront + z * 0.06, bw + z * 0.4, z * 0.12);
          const grB = ctx.createLinearGradient(0, yFront - z * 0.07, 0, yFront + z * 0.07);
          grB.addColorStop(0, '#e3b94b');
          grB.addColorStop(1, '#8f6f1e');
          ctx.fillStyle = grB;
          ctx.fillRect(px - z * 0.25, yFront - z * 0.07, bw + z * 0.5, z * 0.14);
          const xT = cx + Math.sin(g.time * 1.7 + b.id) * bw * 0.36;
          ctx.fillStyle = '#1d2126';
          ctx.fillRect(xT - z * 0.1, yFront - z * 0.12, z * 0.2, z * 0.24);
        }

        // PHASE 3 — finitions : éclats de soudure sur la façade montée
        if (p >= 0.85) {
          const wf = Math.sin(g.time * 15 + b.id * 5);
          if (wf > 0.4) {
            ctx.fillStyle = `rgba(255,200,100,${0.4 + 0.4 * wf})`;
            ctx.beginPath();
            ctx.arc(
              cx + Math.sin(b.id + Math.floor(g.time * 1.3)) * bw * 0.3,
              py + bh * (0.3 + 0.4 * Math.abs(Math.sin(b.id * 3 + Math.floor(g.time)))),
              z * 0.07, 0, Math.PI * 2,
            );
            ctx.fill();
          }
        }
      }
    } else {
      // ================= bâtiment terminé
      ctx.drawImage(spr, bx0, by0, sw, sh);

      // flash d'activation discret à l'achèvement du chantier
      if (this.constructing.has(b.id)) {
        this.constructing.delete(b.id);
        this.builtFlash.set(b.id, g.time);
      }
      const ft = this.builtFlash.get(b.id);
      if (ft !== undefined) {
        const t = (g.time - ft) / 0.8;
        if (t >= 1) this.builtFlash.delete(b.id);
        else {
          ctx.globalAlpha = 0.5 * (1 - t);
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(spr, bx0, by0, sw, sh);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          // bouffées de poussière qui retombent
          for (let k2 = 0; k2 < 5; k2++) {
            const a = (k2 / 5) * Math.PI * 2 + b.id;
            ctx.fillStyle = `rgba(165,155,135,${0.28 * (1 - t)})`;
            ctx.beginPath();
            ctx.arc(
              cx + Math.cos(a) * (bw * 0.34 + t * z * 0.8),
              cy + Math.sin(a) * (bh * 0.3 + t * z * 0.5),
              z * (0.12 + t * 0.14), 0, Math.PI * 2,
            );
            ctx.fill();
          }
        }
      }

      // porte qui s'ouvre (lumière chaude + panneau levé) quand une unité sort
      const dr = DOOR_RECTS[b.type];
      if (dr && b.doorT !== undefined) {
        const dt2 = (g.time - b.doorT) / 1.1;
        if (dt2 >= 0 && dt2 < 1) {
          const open = Math.sin(dt2 * Math.PI);
          const w2 = bw * dr[2], h2 = bh * dr[3];
          const x2 = cx + bw * dr[0] - w2 / 2, y2 = cy + bh * dr[1] - h2 / 2;
          ctx.fillStyle = `rgba(255,206,110,${0.4 * open})`;
          ctx.fillRect(x2, y2 + h2 * (1 - open), w2, h2 * open);
          ctx.fillStyle = `rgba(255,240,200,${0.75 * open})`;
          ctx.fillRect(x2, y2 + h2 * (1 - open) - 1, w2, 2);
        }
      }
    }

    // ----- surcouches animées par type : feux de balisage, vapeur, flammes,
    // soudure — uniquement des teintes chaudes ou neutres, jamais de bleu.
    // Elles ne s'activent qu'à la fin du chantier (feedback de mise en service).
    if (b.built) switch (b.type) {
      case 'hq': {
        // feux anticollision sur les mâts et veille chaude de la tour de commandement
        const blink = 0.35 + 0.65 * Math.max(0, Math.sin(g.time * 3.2));
        ctx.fillStyle = `rgba(224,52,60,${blink})`;
        ctx.beginPath(); ctx.arc(cx - bw * 0.46, cy - bh * 0.62, Math.max(1.2, z * 0.06), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx - bw * 0.18, cy - bh * 0.64, Math.max(1.1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + bw * 0.54, cy - bh * 0.4, Math.max(1.1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,222,140,${0.18 + 0.1 * Math.sin(g.time * 1.8)})`;
        ctx.fillRect(cx - bw * 0.11, cy - bh * 0.39, bw * 0.22, bh * 0.05);
        ctx.fillStyle = `rgba(255,184,80,${0.12 + 0.08 * Math.sin(g.time * 2.1)})`;
        ctx.fillRect(cx - bw * 0.12, cy + bh * 0.16, bw * 0.24, bh * 0.06);
        const sweep = g.time * 2.2;
        ctx.strokeStyle = `rgba(230,236,220,${0.2 + 0.12 * Math.sin(g.time * 2.7)})`;
        ctx.lineWidth = Math.max(1.2, z * 0.045);
        ctx.beginPath();
        ctx.moveTo(cx + bw * 0.36, cy - bh * 0.6);
        ctx.lineTo(cx + bw * 0.36 + Math.cos(sweep) * bw * 0.12, cy - bh * 0.6 + Math.sin(sweep) * bh * 0.07);
        ctx.stroke();
        break;
      }
      case 'power': {
        // fenêtres du hall qui vacillent + fumée légère du groupe
        const f = 0.5 + 0.3 * Math.sin(g.time * 7) * Math.sin(g.time * 2.3);
        ctx.fillStyle = `rgba(255,213,120,${0.3 + 0.25 * f})`;
        ctx.fillRect(cx - bw * 0.28, cy + bh * 0.07, bw * 0.07, bh * 0.05);
        ctx.fillRect(cx - bw * 0.13, cy + bh * 0.07, bw * 0.07, bh * 0.05);
        this.steam(ctx, cx - bw * 0.34, cy - bh * 0.66, z, g.time + b.id, 0.16, 0.16);
        break;
      }
      case 'power2': {
        // panaches de vapeur des aéroréfrigérants + strobe rouge de la cheminée
        this.steam(ctx, cx - bw * 0.2, cy - bh * 0.54, z, g.time + b.id, 0.3, 0.22);
        this.steam(ctx, cx + bw * 0.26, cy - bh * 0.49, z, g.time * 1.13 + b.id + 5, 0.24, 0.2);
        const blink = Math.max(0, Math.sin(g.time * 2.6));
        ctx.fillStyle = `rgba(224,52,60,${0.25 + 0.6 * blink})`;
        ctx.beginPath(); ctx.arc(cx + bw * 0.42, cy - bh * 0.49, Math.max(1.2, z * 0.05), 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'refinery': {
        this.flame(ctx, cx + bw * 0.42, cy - bh * 0.58, z, g.time + b.id, 0.22);
        break;
      }
      case 'refinery2': {
        this.flame(ctx, cx + bw * 0.46, cy - bh * 0.74, z, g.time * 1.2 + b.id, 0.3);
        this.steam(ctx, cx + bw * 0.3, cy - bh * 0.42, z, g.time + b.id, 0.14, 0.12);
        break;
      }
      case 'factory': {
        // éclats de soudure derrière la grande porte
        const w2 = Math.sin(g.time * 17 + b.id * 3) * Math.sin(g.time * 5.3 + b.id);
        if (w2 > 0.35) {
          ctx.fillStyle = `rgba(255,190,90,${0.4 + 0.5 * w2})`;
          ctx.beginPath(); ctx.arc(cx + z * 0.2 * Math.sin(b.id + g.time), cy + bh * 0.11, z * 0.1, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'factory2': {
        const w2 = Math.sin(g.time * 19 + b.id * 3) * Math.sin(g.time * 6.1 + b.id);
        if (w2 > 0.3) {
          ctx.fillStyle = `rgba(255,190,90,${0.4 + 0.5 * w2})`;
          ctx.beginPath(); ctx.arc(cx - bw * 0.19, cy - bh * 0.085, z * 0.11, 0, Math.PI * 2); ctx.fill();
        }
        this.steam(ctx, cx + bw * 0.43, cy - bh * 0.72, z, g.time + b.id, 0.14, 0.14);
        break;
      }
      case 'radar': {
        // bras de balayage de la parabole
        const a = g.time * 1.6;
        ctx.strokeStyle = 'rgba(225,231,235,0.7)';
        ctx.lineWidth = Math.max(1.6, z * 0.08);
        ctx.beginPath();
        ctx.moveTo(cx, cy - bh * 0.43);
        ctx.lineTo(cx + Math.cos(a) * z * 0.42, cy - bh * 0.43 + Math.sin(a) * z * 0.26);
        ctx.stroke();
        break;
      }
      case 'radarcenter': {
        // feu de balisage rouge au sommet du radôme
        const blink = Math.max(0, Math.sin(g.time * 2.2));
        ctx.fillStyle = `rgba(224,52,60,${0.25 + 0.6 * blink})`;
        ctx.beginPath(); ctx.arc(cx, cy - bh * 0.48, Math.max(1.4, z * 0.06), 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'airport': {
        // rampe de balisage séquencée le long de la piste
        for (let k = 0; k < 6; k++) {
          const on = (Math.floor(g.time * 5) % 6) === k;
          ctx.fillStyle = on ? '#ffe27a' : 'rgba(255,226,122,0.22)';
          for (const ly of [cy - bh * 0.28, cy + bh * 0.1]) {
            ctx.beginPath();
            ctx.arc(cx + bw * (-0.42 + k * 0.168), ly, Math.max(1, z * 0.045), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }
      case 'helipad': {
        const blink = 0.25 + 0.45 * Math.max(0, Math.sin(g.time * 4));
        ctx.strokeStyle = `rgba(255,226,122,${blink})`;
        ctx.lineWidth = Math.max(1.2, z * 0.045);
        ctx.beginPath();
        ctx.arc(cx - bw * 0.2, cy, Math.max(3, z * 0.42), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,226,122,${blink})`;
        for (const [lx, ly] of [[-0.43, -0.26], [0.04, -0.26], [-0.43, 0.26], [0.04, 0.26]]) {
          ctx.beginPath();
          ctx.arc(cx + bw * lx, cy + bh * ly, Math.max(1, z * 0.045), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'turret': case 'atgun': {
        const target = b.engageId ? g.unitById.get(b.engageId) : undefined;
        const ang = target ? Math.atan2(target.y - (b.ty + b.h / 2), target.x - (b.tx + b.w / 2)) : g.time * 0.3 + b.id;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        ctx.fillStyle = '#41484f';
        this.rr(ctx, -z * 0.2, -z * 0.18, z * 0.4, z * 0.36, z * 0.12); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -z * 0.12, -z * 0.1, z * 0.24, z * 0.2, z * 0.07); ctx.fill();
        ctx.strokeStyle = b.type === 'turret' ? '#dfe5ea' : '#ffb060';
        if (b.type === 'turret') {
          ctx.lineWidth = Math.max(1.4, z * 0.07);
          ctx.beginPath(); ctx.moveTo(0, -z * 0.08); ctx.lineTo(z * 0.58, -z * 0.08); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, z * 0.08); ctx.lineTo(z * 0.58, z * 0.08); ctx.stroke();
        } else {
          ctx.lineWidth = Math.max(2.2, z * 0.13);
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(z * 0.7, 0); ctx.stroke();
          ctx.lineWidth = Math.max(2.8, z * 0.2);
          ctx.beginPath(); ctx.moveTo(z * 0.56, 0); ctx.lineTo(z * 0.7, 0); ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'aa': {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 4 + 0.2 * Math.sin(g.time * 0.8));
        ctx.fillStyle = '#41484f';
        this.rr(ctx, -z * 0.26, -z * 0.22, z * 0.52, z * 0.44, z * 0.08); ctx.fill();
        ctx.strokeStyle = '#dfe5ea';
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        for (const off of [-z * 0.13, -z * 0.045, z * 0.045, z * 0.13]) {
          ctx.beginPath(); ctx.moveTo(-z * 0.18, off); ctx.lineTo(z * 0.4, off); ctx.stroke();
        }
        ctx.fillStyle = '#e0344a';
        for (const off of [-z * 0.13, -z * 0.045, z * 0.045, z * 0.13]) {
          ctx.beginPath(); ctx.arc(z * 0.4, off, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 'tech': {
        // lueur de la salle des cartes à travers la verrière
        ctx.fillStyle = `rgba(255,222,140,${0.1 + 0.07 * Math.sin(g.time * 2.1 + b.id)})`;
        ctx.fillRect(cx - bw * 0.16, cy - bh * 0.265, bw * 0.32, bh * 0.13);
        break;
      }
      case 'lab': {
        // respiration lumineuse de l'atrium + feu rouge du mât
        ctx.fillStyle = `rgba(255,222,140,${0.1 + 0.07 * Math.sin(g.time * 1.6 + b.id)})`;
        ctx.fillRect(cx - bw * 0.07, cy - bh * 0.065, bw * 0.14, bh * 0.22);
        const blink = Math.max(0, Math.sin(g.time * 2.8));
        ctx.fillStyle = `rgba(224,52,60,${0.2 + 0.6 * blink})`;
        ctx.beginPath(); ctx.arc(cx - bw * 0.42, cy - bh * 0.54, Math.max(1.2, z * 0.05), 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'barracks2': {
        const blink = Math.max(0, Math.sin(g.time * 2.4 + b.id));
        ctx.fillStyle = `rgba(224,52,60,${0.2 + 0.55 * blink})`;
        ctx.beginPath(); ctx.arc(cx + bw * 0.11, cy - bh * 0.69, Math.max(1.1, z * 0.045), 0, Math.PI * 2); ctx.fill();
        break;
      }
    }

    // ----- construction : barre de progression (l'animation de chantier en
    // trois phases est dessinée plus haut, avec le sprite)
    if (!b.built) {
      ctx.fillStyle = '#15181c';
      ctx.fillRect(px, py + bh + 3, bw, 4);
      ctx.fillStyle = '#50dc78';
      ctx.fillRect(px, py + bh + 3, bw * b.progress, 4);
    }
    if (b.built && b.queue.length > 0) {
      const q = b.queue[0];
      ctx.fillStyle = '#15181c';
      ctx.fillRect(px, py + bh + 3, bw, 4);
      ctx.fillStyle = '#6db7ff';
      ctx.fillRect(px, py + bh + 3, bw * Math.min(1, q.t / q.time), 4);
    }
    if (b.repairOn) {
      ctx.fillStyle = '#ffe070';
      ctx.font = `bold ${Math.max(9, z * 0.6)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔧', px + bw - z * 0.4, py + z * 0.4);
    }
    if (selected) {
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(px - 4, py - 4, bw + 8, bh + 8);
      ctx.strokeStyle = 'rgba(0,0,0,0.62)';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(px - 3, py - 3, bw + 6, bh + 6);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(px - 2, py - 2, bw + 4, bh + 4);
      ctx.setLineDash([]);
      if (b.rally) {
        const rx = sx(b.rally.x), ry = sy(b.rally.y);
        ctx.strokeStyle = 'rgba(120,255,150,0.8)';
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(rx, ry); ctx.stroke();
        ctx.fillStyle = '#78ff96';
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx, ry - 10); ctx.lineTo(rx + 7, ry - 7); ctx.closePath(); ctx.fill();
      }
    }
    if (selected || b.hp < b.maxHp) {
      this.healthBar(ctx, cx, py - 5, bw * 0.85, b.hp / b.maxHp, selected);
    }
  }

  // (ancien rendu vectoriel direct des bâtiments, conservé en secours)
  private drawBuilding(
    ctx: CanvasRenderingContext2D, g: Game, b: Building,
    sx: (x: number) => number, sy: (y: number) => number, z: number,
    selected: boolean,
  ) {
    const px = sx(b.tx - 0.5), py = sy(b.ty - 0.5);
    const bw = b.w * z, bh = b.h * z;
    const col = PLAYER_COLORS[b.owner];
    const drawBuildProgress = (progress: number, fill: string) => {
      const barW = Math.max(18, bw * 0.72);
      const barH = Math.max(3, Math.min(5, z * 0.11));
      const barX = px + (bw - barW) / 2;
      const barY = py + bh + z * 0.1;
      const pct = Math.max(0, Math.min(1, progress));
      ctx.fillStyle = 'rgba(5,7,9,0.72)';
      this.rr(ctx, barX - 1, barY - 1, barW + 2, barH + 2, barH * 0.7);
      ctx.fill();
      ctx.fillStyle = '#15181c';
      this.rr(ctx, barX, barY, barW, barH, barH * 0.55);
      ctx.fill();
      if (pct > 0) {
        ctx.fillStyle = fill;
        this.rr(ctx, barX, barY, barW * pct, barH, barH * 0.55);
        ctx.fill();
      }
    };
    ctx.save();

    // ----- infrastructure militaire : ombre, dalle béton, corps métallique
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    this.rr(ctx, px + z * 0.14, py + z * 0.18, bw, bh, z * 0.1); ctx.fill();
    // dalle de béton débordante avec coins renforcés
    ctx.fillStyle = '#24272c';
    this.rr(ctx, px - z * 0.12, py - z * 0.12, bw + z * 0.24, bh + z * 0.24, z * 0.08); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    this.rr(ctx, px - z * 0.12, py - z * 0.12, bw + z * 0.24, bh + z * 0.24, z * 0.08); ctx.stroke();
    // marquages de danger aux coins de la dalle
    ctx.fillStyle = '#caa536';
    const hz = Math.max(2, z * 0.16);
    for (const [cx2, cy2] of [[px - z * 0.12, py - z * 0.12], [px + bw + z * 0.12 - hz, py - z * 0.12],
                              [px - z * 0.12, py + bh + z * 0.12 - hz], [px + bw + z * 0.12 - hz, py + bh + z * 0.12 - hz]]) {
      ctx.fillRect(cx2, cy2, hz, hz * 0.4);
    }
    // corps métallique : tôle, éclairage zénithal, joints de panneaux
    ctx.fillStyle = '#41484f';
    this.rr(ctx, px, py, bw, bh, z * 0.1); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    this.rr(ctx, px, py, bw, bh * 0.26, z * 0.1); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    this.rr(ctx, px, py + bh * 0.78, bw, bh * 0.22, z * 0.1); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    for (let k = 1; k < b.w; k++) {
      ctx.beginPath(); ctx.moveTo(px + k * z, py + z * 0.1); ctx.lineTo(px + k * z, py + bh - z * 0.1); ctx.stroke();
    }
    // rivets d'angle
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (const [rx2, ry2] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
      ctx.beginPath(); ctx.arc(px + bw * rx2, py + bh * ry2, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
    }
    // bande d'identification du propriétaire (haut du bâtiment)
    ctx.fillStyle = col;
    this.rr(ctx, px, py, bw, Math.max(2.5, z * 0.16), z * 0.08); ctx.fill();
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, z * 0.05);
    this.rr(ctx, px + 0.5, py + 0.5, bw - 1, bh - 1, z * 0.09); ctx.stroke();
    ctx.globalAlpha = 1;
    // feu de statut pulsant à la couleur de l'équipe
    if (b.built) {
      ctx.globalAlpha = 0.45 + 0.4 * Math.sin(g.time * 3 + b.id);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px + bw - z * 0.22, py + bh - z * 0.22, Math.max(2, z * 0.11), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.arc(px + bw - z * 0.22, py + bh - z * 0.22, Math.max(1, z * 0.04), 0, Math.PI * 2); ctx.fill();
    }

    // détail par type
    const cx = px + bw / 2, cy = py + bh / 2;
    ctx.fillStyle = col;
    ctx.strokeStyle = '#dfe5ea';
    switch (b.type) {
      case 'hq': {
        // QG de secours : bunker élargi, porte blindée, antennes et grand radar
        ctx.fillStyle = '#20251f';
        this.rr(ctx, px + bw * 0.08, py + bh * 0.16, bw * 0.84, bh * 0.62, z * 0.08); ctx.fill();
        ctx.fillStyle = '#3b433a';
        this.rr(ctx, px + bw * 0.16, py + bh * 0.2, bw * 0.68, bh * 0.42, z * 0.06); ctx.fill();
        ctx.fillStyle = '#161a17';
        this.rr(ctx, px + bw * 0.39, py + bh * 0.53, bw * 0.22, bh * 0.18, z * 0.04); ctx.fill();
        ctx.fillStyle = 'rgba(184,143,52,0.7)';
        ctx.fillRect(px + bw * 0.4, py + bh * 0.58, bw * 0.2, z * 0.08);
        ctx.fillStyle = '#485146';
        this.rr(ctx, px + bw * 0.36, py + bh * 0.04, bw * 0.28, bh * 0.22, z * 0.05); ctx.fill();
        ctx.fillStyle = `rgba(255,220,130,${0.25 + 0.12 * Math.sin(g.time * 2)})`;
        ctx.fillRect(px + bw * 0.4, py + bh * 0.11, bw * 0.2, bh * 0.04);
        ctx.strokeStyle = '#c9d1d9';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.17, py + bh * 0.44); ctx.lineTo(px + bw * 0.14, py - bh * 0.06); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + bw * 0.34, py + bh * 0.24); ctx.lineTo(px + bw * 0.34, py - bh * 0.08); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + bw * 0.76, py + bh * 0.36); ctx.lineTo(px + bw * 0.82, py + bh * 0.03); ctx.stroke();
        ctx.fillStyle = `rgba(255,80,80,${0.5 + 0.5 * Math.sin(g.time * 4)})`;
        ctx.beginPath(); ctx.arc(px + bw * 0.14, py - bh * 0.06, Math.max(1.2, z * 0.07), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#242a25';
        ctx.beginPath(); ctx.ellipse(px + bw * 0.7, py + bh * 0.1, z * 0.42, z * 0.17, -0.45, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#d0d4c8';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.ellipse(px + bw * 0.7, py + bh * 0.1, z * 0.42, z * 0.17, -0.45, 0, Math.PI * 2); ctx.stroke();
        const ha = g.time * 2;
        ctx.strokeStyle = 'rgba(230,236,220,0.62)';
        ctx.lineWidth = Math.max(1.2, z * 0.06);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.7, py + bh * 0.1); ctx.lineTo(px + bw * 0.7 + Math.cos(ha) * z * 0.38, py + bh * 0.1 + Math.sin(ha) * z * 0.2); ctx.stroke();
        ctx.fillStyle = '#b88f34';
        ctx.fillRect(px + bw * 0.16, py + bh * 0.68, bw * 0.68, z * 0.05);
        break;
      }
      case 'power': {
        // centrale : deux turbines à ailettes + cœur lumineux + câblage
        for (const tx2 of [0.32, 0.68]) {
          ctx.fillStyle = '#2c3136';
          ctx.beginPath(); ctx.arc(px + bw * tx2, cy, z * 0.42, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#6f7882';
          ctx.lineWidth = Math.max(1, z * 0.05);
          const ta = g.time * (tx2 < 0.5 ? 2.2 : -2.2);
          for (let k = 0; k < 3; k++) {
            const a = ta + (k / 3) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(px + bw * tx2, cy);
            ctx.lineTo(px + bw * tx2 + Math.cos(a) * z * 0.36, cy + Math.sin(a) * z * 0.36);
            ctx.stroke();
          }
          ctx.fillStyle = `rgba(255,216,77,${0.55 + 0.25 * Math.sin(g.time * 6 + tx2 * 9)})`;
          ctx.beginPath(); ctx.arc(px + bw * tx2, cy, z * 0.12, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = '#caa536';
        ctx.lineWidth = Math.max(1, z * 0.06);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.32, cy); ctx.lineTo(px + bw * 0.68, cy); ctx.stroke();
        break;
      }
      case 'refinery': {
        // site industriel : deux cuves cerclées, tuyauterie, torchère
        for (const [tx2, ty2, r2] of [[0.3, 0.36, 0.42], [0.62, 0.62, 0.34]]) {
          ctx.fillStyle = '#8a939d';
          ctx.beginPath(); ctx.arc(px + bw * tx2, py + bh * ty2, z * r2, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.beginPath(); ctx.arc(px + bw * tx2 - z * r2 * 0.3, py + bh * ty2 - z * r2 * 0.3, z * r2 * 0.35, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(px + bw * tx2, py + bh * ty2, z * r2 * 0.65, 0, Math.PI * 2); ctx.stroke();
        }
        // tuyauterie
        ctx.strokeStyle = '#6f7882';
        ctx.lineWidth = Math.max(1.6, z * 0.1);
        ctx.beginPath();
        ctx.moveTo(px + bw * 0.3, py + bh * 0.36);
        ctx.lineTo(px + bw * 0.62, py + bh * 0.62);
        ctx.lineTo(px + bw * 0.88, py + bh * 0.62);
        ctx.stroke();
        // torchère avec flamme vacillante
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.06);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.84, py + bh * 0.4); ctx.lineTo(px + bw * 0.84, py + bh * 0.14); ctx.stroke();
        ctx.fillStyle = `rgba(255,${150 + Math.floor(60 * Math.sin(g.time * 9))},60,0.9)`;
        ctx.beginPath(); ctx.arc(px + bw * 0.84, py + bh * 0.11, Math.max(1.5, z * 0.1 + z * 0.03 * Math.sin(g.time * 11)), 0, Math.PI * 2); ctx.fill();
        // quai doré de déchargement
        ctx.fillStyle = '#caa536';
        this.rr(ctx, px + bw * 0.22, py + bh - z * 0.42, bw * 0.56, z * 0.32, z * 0.06); ctx.fill();
        ctx.fillStyle = '#2c3136';
        for (let k = 0; k < 3; k++) ctx.fillRect(px + bw * (0.28 + k * 0.17), py + bh - z * 0.38, z * 0.1, z * 0.24);
        break;
      }
      case 'barracks': {
        // base militaire : toit à deux travées, porte, sacs de sable
        ctx.fillStyle = '#3a4046';
        this.rr(ctx, px + bw * 0.12, py + bh * 0.22, bw * 0.76, bh * 0.3, z * 0.05); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(px + bw * 0.12, py + bh * 0.22, bw * 0.76, bh * 0.08);
        ctx.fillStyle = '#3a4046';
        this.rr(ctx, px + bw * 0.12, py + bh * 0.58, bw * 0.76, bh * 0.3, z * 0.05); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(px + bw * 0.12, py + bh * 0.58, bw * 0.76, bh * 0.08);
        // porte éclairée
        ctx.fillStyle = '#1d2126';
        ctx.fillRect(px + bw * 0.44, py + bh * 0.66, bw * 0.12, bh * 0.22);
        ctx.fillStyle = 'rgba(255,230,150,0.6)';
        ctx.fillRect(px + bw * 0.46, py + bh * 0.68, bw * 0.08, bh * 0.05);
        // sacs de sable
        ctx.fillStyle = '#7a6f52';
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          ctx.ellipse(px + bw * (0.2 + k * 0.2), py + bh * 0.94, z * 0.11, z * 0.06, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'factory': {
        // complexe industriel : halle, portique roulant, baie à chevrons
        ctx.fillStyle = '#353b42';
        this.rr(ctx, px + bw * 0.1, py + bh * 0.2, bw * 0.8, bh * 0.62, z * 0.05); ctx.fill();
        // toit en dents de scie
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.moveTo(px + bw * (0.1 + k * 0.27), py + bh * 0.2);
          ctx.lineTo(px + bw * (0.23 + k * 0.27), py + bh * 0.3);
          ctx.lineTo(px + bw * (0.1 + k * 0.27), py + bh * 0.4);
          ctx.closePath(); ctx.fill();
        }
        // portique roulant (anime un léger va-et-vient)
        const gx = px + bw * (0.3 + 0.3 * (0.5 + 0.5 * Math.sin(g.time * 0.7)));
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1.4, z * 0.08);
        ctx.beginPath(); ctx.moveTo(gx, py + bh * 0.2); ctx.lineTo(gx, py + bh * 0.82); ctx.stroke();
        ctx.fillStyle = '#caa536';
        ctx.fillRect(gx - z * 0.1, py + bh * 0.46, z * 0.2, z * 0.16);
        // baie de sortie à chevrons
        ctx.fillStyle = '#1d2126';
        ctx.fillRect(px + bw * 0.32, py + bh * 0.84, bw * 0.36, bh * 0.12);
        ctx.fillStyle = '#caa536';
        for (let k = 0; k < 3; k++) ctx.fillRect(px + bw * (0.34 + k * 0.12), py + bh * 0.86, bw * 0.05, bh * 0.08);
        break;
      }
      case 'radar': {
        // station radar : dôme + parabole inclinée balayant + écran
        ctx.fillStyle = '#353b42';
        ctx.beginPath(); ctx.arc(cx, cy + z * 0.1, z * 0.42, 0, Math.PI * 2); ctx.fill();
        const a = g.time * 1.6;
        ctx.strokeStyle = 'rgba(220,230,235,0.62)';
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * z * 0.52, cy + Math.sin(a) * z * 0.34); ctx.stroke();
        ctx.fillStyle = '#d6dee5';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(120,255,150,${0.4 + 0.3 * Math.sin(g.time * 3)})`;
        ctx.fillRect(px + bw * 0.14, py + bh * 0.7, bw * 0.2, bh * 0.12);
        break;
      }
      case 'airport': {
        // piste éclairée + manche à air + hangar
        ctx.fillStyle = '#2c3136';
        this.rr(ctx, px + bw * 0.1, py + bh * 0.25, bw * 0.8, bh * 0.52, z * 0.06); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.setLineDash([z * 0.15, z * 0.15]);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.14, cy); ctx.lineTo(px + bw * 0.86, cy); ctx.stroke();
        ctx.setLineDash([]);
        // feux de piste séquentiels
        for (let k = 0; k < 5; k++) {
          const on = (Math.floor(g.time * 4) % 5) === k;
          ctx.fillStyle = on ? '#ffe27a' : 'rgba(255,226,122,0.25)';
          ctx.beginPath(); ctx.arc(px + bw * (0.16 + k * 0.17), py + bh * 0.72, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        }
        // manche à air
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px + bw * 0.9, py + bh * 0.3); ctx.lineTo(px + bw * 0.9, py + bh * 0.12); ctx.stroke();
        ctx.fillStyle = '#e0344a';
        ctx.beginPath();
        ctx.moveTo(px + bw * 0.9, py + bh * 0.12);
        ctx.lineTo(px + bw * 0.98, py + bh * 0.16);
        ctx.lineTo(px + bw * 0.9, py + bh * 0.2);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'helipad': {
        ctx.fillStyle = '#2b3136';
        ctx.beginPath();
        ctx.ellipse(px + bw * 0.32, cy, bw * 0.22, bh * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(245,245,225,0.78)';
        ctx.lineWidth = Math.max(1, z * 0.055);
        ctx.beginPath();
        ctx.ellipse(px + bw * 0.32, cy, bw * 0.16, bh * 0.2, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e8e1b5';
        ctx.fillRect(px + bw * 0.24, cy - bh * 0.025, bw * 0.16, bh * 0.05);
        ctx.fillRect(px + bw * 0.3, cy - bh * 0.11, bw * 0.04, bh * 0.22);
        break;
      }
      case 'turret': case 'atgun': {
        // plateforme octogonale + tourelle blindée orientée + canon avec recul visuel
        ctx.fillStyle = '#2c3136';
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const a2 = (k / 8) * Math.PI * 2 + Math.PI / 8;
          const xx = cx + Math.cos(a2) * z * 0.42, yy = cy + Math.sin(a2) * z * 0.42;
          if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.closePath(); ctx.fill();
        const target = b.engageId ? g.unitById.get(b.engageId) : undefined;
        const ang = target ? Math.atan2(target.y - (b.ty + b.h / 2), target.x - (b.tx + b.w / 2)) : g.time * 0.3 + b.id;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        ctx.fillStyle = '#41484f';
        this.rr(ctx, -z * 0.22, -z * 0.2, z * 0.44, z * 0.4, z * 0.07); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        this.rr(ctx, -z * 0.14, -z * 0.12, z * 0.28, z * 0.24, z * 0.05); ctx.fill();
        ctx.strokeStyle = b.type === 'turret' ? '#dfe5ea' : '#ffb060';
        if (b.type === 'turret') {
          // double mitrailleuse
          ctx.lineWidth = Math.max(1.4, z * 0.07);
          ctx.beginPath(); ctx.moveTo(0, -z * 0.08); ctx.lineTo(z * 0.6, -z * 0.08); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, z * 0.08); ctx.lineTo(z * 0.6, z * 0.08); ctx.stroke();
        } else {
          ctx.lineWidth = Math.max(2.2, z * 0.13);
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(z * 0.72, 0); ctx.stroke();
          ctx.lineWidth = Math.max(2.8, z * 0.2);
          ctx.beginPath(); ctx.moveTo(z * 0.58, 0); ctx.lineTo(z * 0.72, 0); ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'aa': {
        // batterie AA : rampe de 4 missiles inclinés + radar de tir
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 4 + 0.2 * Math.sin(g.time * 0.8));
        ctx.fillStyle = '#41484f';
        this.rr(ctx, -z * 0.3, -z * 0.24, z * 0.6, z * 0.48, z * 0.06); ctx.fill();
        ctx.strokeStyle = '#dfe5ea';
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        for (const off of [-z * 0.14, -z * 0.05, z * 0.05, z * 0.14]) {
          ctx.beginPath(); ctx.moveTo(-z * 0.2, off); ctx.lineTo(z * 0.42, off); ctx.stroke();
        }
        ctx.fillStyle = '#e0344a';
        for (const off of [-z * 0.14, -z * 0.05, z * 0.05, z * 0.14]) {
          ctx.beginPath(); ctx.arc(z * 0.42, off, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 'tech': {
        // centre tactique : écrans, antenne fouet, éprouvette lumineuse
        ctx.fillStyle = '#1d2126';
        this.rr(ctx, px + bw * 0.16, py + bh * 0.3, bw * 0.42, bh * 0.32, z * 0.05); ctx.fill();
        ctx.fillStyle = `rgba(210,218,220,${0.42 + 0.16 * Math.sin(g.time * 2.4)})`;
        ctx.fillRect(px + bw * 0.2, py + bh * 0.35, bw * 0.14, bh * 0.1);
        ctx.fillRect(px + bw * 0.38, py + bh * 0.35, bw * 0.14, bh * 0.1);
        ctx.fillStyle = 'rgba(120,255,150,0.55)';
        ctx.fillRect(px + bw * 0.2, py + bh * 0.5, bw * 0.32, bh * 0.06);
        ctx.strokeStyle = '#c9d1d9';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px + bw * 0.76, py + bh * 0.6); ctx.lineTo(px + bw * 0.82, py + bh * 0.16); ctx.stroke();
        ctx.fillStyle = '#d6dee5';
        ctx.beginPath(); ctx.arc(px + bw * 0.7, py + bh * 0.74, z * 0.18, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'radarcenter': {
        // double bras balayant + grand dôme
        ctx.strokeStyle = 'rgba(220,230,235,0.62)';
        ctx.lineWidth = Math.max(1.5, z * 0.09);
        const a2 = g.time * 2.2;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a2) * z * 0.55, cy + Math.sin(a2) * z * 0.38); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(-a2) * z * 0.32, cy + Math.sin(-a2) * z * 0.24); ctx.stroke();
        ctx.fillStyle = '#d6dee5';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.16, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'depot': {
        // caisses empilées + pastille dorée
        ctx.fillStyle = '#8a6d3f';
        this.rr(ctx, px + bw * 0.18, py + bh * 0.4, bw * 0.28, bh * 0.32, z * 0.04); ctx.fill();
        this.rr(ctx, px + bw * 0.52, py + bh * 0.4, bw * 0.28, bh * 0.32, z * 0.04); ctx.fill();
        ctx.fillStyle = '#a8895a';
        this.rr(ctx, px + bw * 0.34, py + bh * 0.18, bw * 0.3, bh * 0.26, z * 0.04); ctx.fill();
        ctx.fillStyle = '#e7c44a';
        ctx.beginPath(); ctx.arc(cx, py + bh * 0.78, z * 0.12, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'lab': {
        // laboratoire : noyau lumineux + bras de mesure animés
        const a3 = g.time * 1.4;
        ctx.strokeStyle = 'rgba(220,230,235,0.56)';
        ctx.lineWidth = Math.max(1.2, z * 0.06);
        for (let k2 = 0; k2 < 3; k2++) {
          ctx.beginPath();
          const a = a3 + (k2 * Math.PI * 2) / 3;
          ctx.moveTo(cx + Math.cos(a) * z * 0.18, cy + Math.sin(a) * z * 0.08);
          ctx.lineTo(cx + Math.cos(a) * z * 0.6, cy + Math.sin(a) * z * 0.24);
          ctx.stroke();
        }
        ctx.fillStyle = '#d6dee5';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(190,220,230,${0.18 + 0.1 * Math.sin(g.time * 3)})`;
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.5, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'barracks2': {
        // caserne T2 : double chevron doré + deux silhouettes
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath(); ctx.arc(cx - z * 0.3, cy + z * 0.1, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + z * 0.3, cy + z * 0.1, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e7c44a';
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        for (const off of [0, z * 0.22]) {
          ctx.beginPath();
          ctx.moveTo(cx - z * 0.32, cy - z * 0.18 - off + z * 0.14);
          ctx.lineTo(cx, cy - z * 0.4 - off + z * 0.14);
          ctx.lineTo(cx + z * 0.32, cy - z * 0.18 - off + z * 0.14);
          ctx.stroke();
        }
        break;
      }
      case 'factory2': {
        // usine T2 : chaînes superposées + double cheminée incandescente
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        this.rr(ctx, px + bw * 0.15, py + bh * 0.26, bw * 0.7, bh * 0.15, z * 0.05); ctx.fill();
        ctx.fillStyle = '#9aa6b0';
        this.rr(ctx, px + bw * 0.15, py + bh * 0.47, bw * 0.7, bh * 0.15, z * 0.05); ctx.fill();
        ctx.fillStyle = '#6f7882';
        this.rr(ctx, px + bw * 0.15, py + bh * 0.68, bw * 0.7, bh * 0.15, z * 0.05); ctx.fill();
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(px + bw * 0.8, py + bh * 0.18, z * 0.16, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px + bw * 0.62, py + bh * 0.18, z * 0.16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,120,60,${0.5 + 0.3 * Math.sin(g.time * 4)})`;
        ctx.beginPath(); ctx.arc(px + bw * 0.8, py + bh * 0.18, z * 0.08, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'power2': {
        // centrale T2 : réacteur circulaire + double éclair
        ctx.strokeStyle = 'rgba(220,230,235,0.55)';
        ctx.lineWidth = Math.max(1.5, z * 0.09);
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.58, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(190,220,230,${0.14 + 0.08 * Math.sin(g.time * 5)})`;
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.55, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd84d';
        for (const off of [-z * 0.16, z * 0.16]) {
          ctx.beginPath();
          ctx.moveTo(cx + off + z * 0.07, cy - z * 0.34);
          ctx.lineTo(cx + off - z * 0.16, cy + z * 0.06);
          ctx.lineTo(cx + off + z * 0.01, cy + z * 0.06);
          ctx.lineTo(cx + off - z * 0.07, cy + z * 0.38);
          ctx.lineTo(cx + off + z * 0.2, cy - z * 0.04);
          ctx.lineTo(cx + off + z * 0.01, cy - z * 0.04);
          ctx.closePath(); ctx.fill();
        }
        break;
      }
      case 'refinery2': {
        // raffinerie T2 : grand dôme doré cerclé + double quai + halo
        ctx.fillStyle = `rgba(231,196,74,${0.18 + 0.1 * Math.sin(g.time * 2.5)})`;
        ctx.beginPath(); ctx.arc(cx, cy - z * 0.1, z * 0.85, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d4af37';
        ctx.beginPath(); ctx.arc(cx, cy - z * 0.12, z * 0.62, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff0c0';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath(); ctx.arc(cx, cy - z * 0.12, z * 0.62, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath(); ctx.arc(cx - z * 0.18, cy - z * 0.3, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2c3136';
        this.rr(ctx, px + bw * 0.12, py + bh - z * 0.55, bw * 0.32, z * 0.45, z * 0.08); ctx.fill();
        this.rr(ctx, px + bw * 0.56, py + bh - z * 0.55, bw * 0.32, z * 0.45, z * 0.08); ctx.fill();
        break;
      }
    }

    // construction en cours
    if (!b.built) {
      ctx.fillStyle = 'rgba(10,12,15,0.55)';
      ctx.fillRect(px, py, bw, bh * (1 - b.progress));
      drawBuildProgress(b.progress, '#50dc78');
    }

    // production en cours
    if (b.built && b.queue.length > 0) {
      const q = b.queue[0];
      drawBuildProgress(Math.min(1, q.t / q.time), '#6db7ff');
    }

    if (b.repairOn) {
      ctx.fillStyle = '#ffe070';
      ctx.font = `bold ${Math.max(9, z * 0.6)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔧', px + bw - z * 0.4, py + z * 0.4);
    }

    if (selected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(px - 2, py - 2, bw + 4, bh + 4);
      ctx.setLineDash([]);
      if (b.rally) {
        const rx = sx(b.rally.x), ry = sy(b.rally.y);
        ctx.strokeStyle = 'rgba(120,255,150,0.8)';
        ctx.beginPath(); ctx.moveTo(px + bw / 2, py + bh / 2); ctx.lineTo(rx, ry); ctx.stroke();
        ctx.fillStyle = '#78ff96';
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx, ry - 10); ctx.lineTo(rx + 7, ry - 7); ctx.closePath(); ctx.fill();
      }
    }

    if (selected || b.hp < b.maxHp) {
      this.healthBar(ctx, px + bw / 2, py - 5, bw * 0.85, b.hp / b.maxHp, selected);
    }
    ctx.restore();
  }

  private healthBar(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, f: number, strong: boolean) {
    f = Math.max(0, Math.min(1, f));
    const h = strong ? 4 : 3;
    // cadre sombre arrondi + jauge avec liseré clair
    ctx.fillStyle = 'rgba(8,10,12,0.8)';
    this.rr(ctx, cx - w / 2 - 1, cy - 1, w + 2, h + 2, 2); ctx.fill();
    ctx.fillStyle = f > 0.55 ? '#5fd96a' : f > 0.25 ? '#e8c84a' : '#e05a4e';
    if (w * f > 1) { this.rr(ctx, cx - w / 2, cy, w * f, h, 1.5); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    if (w * f > 1) ctx.fillRect(cx - w / 2, cy, w * f, 1);
  }

  // --------------------------------------------------------------- mini-carte

  private drawMinimap(g: Game, v: ViewState, dt: number) {
    // La mini-carte n'a pas besoin de suivre le framerate : l'état (brouillard,
    // positions) évolue lentement. On la rafraîchit à ~12 Hz et on laisse le
    // dernier rendu affiché entre deux mises à jour (le canvas n'est pas effacé
    // ailleurs). Le viewport bouge plus souvent : il est tracé par-dessus le
    // cache à chaque frame, en bas de méthode.
    this.mmAccum += dt;
    const due = !this.mmDrawn || this.mmAccum >= 0.083;

    const S = this.minimap.width;
    const mw = g.map.w, mh = g.map.h;
    // canvas offscreen du contenu (terrain + brouillard + entités), rebâti à ~12 Hz
    if (!this.mmBase) {
      this.mmBase = document.createElement('canvas');
      this.mmBase.width = S; this.mmBase.height = S;
      this.mmBaseCtx = this.mmBase.getContext('2d')!;
    }
    if (!due) { this.blitMinimap(g, v); return; }
    this.mmAccum = 0;
    this.mmDrawn = true;
    const ctx = this.mmBaseCtx!;
    // Letterbox : les cartes spéciales (Italie…) ne sont pas carrées.
    const k = S / Math.max(mw, mh);
    const ox = (S - mw * k) / 2, oy = (S - mh * k) / 2;
    const fog = g.players[this.pov].fog;
    const revealAll = g.over;
    const theme = THEMES[g.map.theme];
    const radar = g.hasRadar(this.pov);

    // fond terrain mis en cache
    if (!this.mmTerrain) {
      const c = document.createElement('canvas');
      c.width = mw; c.height = mh;
      const cc = c.getContext('2d')!;
      const img = cc.createImageData(mw, mh);
      for (let i = 0; i < mw * mh; i++) {
        const t = g.map.terrain[i];
        const col = t === T_WATER ? theme.water : t === T_ROCK ? theme.rock[0] : t === T_ROUGH ? theme.rough[0] : theme.grass[0];
        const li = Math.max(0.72, Math.min(1.22, g.map.light[i] ?? 1));
        const hi = Math.max(0, Math.min(1, g.map.height[i] ?? 0.5));
        const cliff = g.map.cliff[i] ? 1 : 0;
        const depth = t === T_WATER ? Math.max(0, Math.min(1, (0.22 - hi) / 0.22)) : 0;
        const ridge = t !== T_WATER ? Math.max(-0.15, Math.min(0.2, (hi - 0.52) * 0.34)) : 0;
        let r = Math.max(0, Math.min(255, Math.round(parseInt(col.slice(1, 3), 16) * (li + ridge))));
        let gg = Math.max(0, Math.min(255, Math.round(parseInt(col.slice(3, 5), 16) * (li + ridge))));
        let bb = Math.max(0, Math.min(255, Math.round(parseInt(col.slice(5, 7), 16) * (li + ridge))));
        if (depth > 0) {
          r = Math.floor(r * (1 - depth * 0.42));
          gg = Math.floor(gg * (1 - depth * 0.28));
          bb = Math.floor(bb * (1 + depth * 0.12) + 18 * depth);
        }
        if (cliff) {
          r = Math.floor(r * 0.72 + 28);
          gg = Math.floor(gg * 0.72 + 25);
          bb = Math.floor(bb * 0.72 + 22);
        }
        const road = g.map.roads[i] === 1;
        img.data[i * 4] = road ? Math.floor(r * 0.56 + 96 * 0.44) : r;
        img.data[i * 4 + 1] = road ? Math.floor(gg * 0.56 + 80 * 0.44) : gg;
        img.data[i * 4 + 2] = road ? Math.floor(bb * 0.56 + 62 * 0.44) : bb;
        img.data[i * 4 + 3] = 255;
      }
      cc.putImageData(img, 0, 0);
      this.mmTerrain = c;
    }

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#06080a';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(this.mmTerrain, ox, oy, mw * k, mh * k);

    // brouillard : un seul ImageData (résolution carte) mis à l'échelle —
    // remplace des dizaines de milliers de fillRect par tuile.
    if (!this.mmFog || this.mmFog.width !== mw || this.mmFog.height !== mh) {
      this.mmFog = document.createElement('canvas');
      this.mmFog.width = mw; this.mmFog.height = mh;
      this.mmFogImg = this.mmFog.getContext('2d')!.createImageData(mw, mh);
    }
    const fimg = this.mmFogImg!;
    const fd = fimg.data;
    for (let i = 0; i < mw * mh; i++) {
      const f = revealAll ? 2 : fog[i];
      const a = f === 0 ? 255 : f === 1 ? 115 : 0;
      const o = i * 4;
      fd[o] = 6; fd[o + 1] = 8; fd[o + 2] = 10; fd[o + 3] = a;
    }
    const fctx = this.mmFog.getContext('2d')!;
    fctx.putImageData(fimg, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mmFog, ox, oy, mw * k, mh * k);

    // minerai découvert (le rare ressort en rouge vif)
    for (const n of g.nodes) {
      if (n.amount < 10 || (!revealAll && fog[n.ty * mw + n.tx] === 0)) continue;
      ctx.fillStyle = n.kind === 'rare' ? '#ff4d6d' : theme.oreGlow;
      ctx.fillRect(ox + n.tx * k - 1, oy + n.ty * k - 1, 2, 2);
    }

    // bâtiments
    for (const b of g.buildings) {
      const ci = (b.ty + 1) * mw + b.tx + 1;
      const own = b.owner === this.pov;
      if (!revealAll && !own) {
        if (fog[Math.min(ci, fog.length - 1)] === 0) continue;
        if (!radar && !g.buildingVisibleTo(this.pov, b)) continue;
      }
      ctx.fillStyle = PLAYER_COLORS[b.owner];
      ctx.fillRect(ox + b.tx * k, oy + b.ty * k, Math.max(2, b.w * k), Math.max(2, b.h * k));
    }

    // unités
    for (const u of g.units) {
      if (u.transportedBy) continue;
      const own = u.owner === this.pov;
      if (!revealAll && !own && (!radar || !g.isVisibleTo(this.pov, u.x, u.y))) continue;
      ctx.fillStyle = own ? '#9fe0ff' : PLAYER_COLORS[u.owner];
      ctx.fillRect(ox + u.x * k - 1, oy + u.y * k - 1, 2.2, 2.2);
    }

    // alertes
    for (const p of g.pings) {
      const age = (g.time - p.t) % 1;
      ctx.strokeStyle = `rgba(255,80,60,${1 - age})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ox + p.x * k, oy + p.y * k, 3 + age * 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // le contenu est prêt dans mmBase : on l'affiche + le viewport par-dessus
    this.blitMinimap(g, v);
  }

  // Affiche le contenu mis en cache puis trace le cadre caméra (chaque frame,
  // pour un viewport fluide même si le contenu n'est rafraîchi qu'à 12 Hz).
  private blitMinimap(g: Game, v: ViewState) {
    const ctx = this.mmCtx;
    const S = this.minimap.width;
    const mw = g.map.w, mh = g.map.h;
    const k = S / Math.max(mw, mh);
    const ox = (S - mw * k) / 2, oy = (S - mh * k) / 2;
    if (this.mmBase) ctx.drawImage(this.mmBase, 0, 0);
    const cw = (this.canvas.width / v.cam.zoom) * k;
    const ch = (this.canvas.height / v.cam.zoom) * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + v.cam.x * k - cw / 2, oy + v.cam.y * k - ch / 2, cw, ch);
  }
}
