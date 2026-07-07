// Rendu Canvas 2D en 2.5D ISOMÉTRIQUE (diamant 2:1) : la simulation reste en
// grille carrée top-down ; toute la conversion monde ↔ écran passe par
// src/game/proj.ts. Le plan du sol (terrain pré-rendu, brouillard, décals)
// est projeté par une transformation affine ; les entités sont des billboards
// triés par profondeur (x+y). Bâtiments : bakery iso dédiée (iso-buildings.ts)
// remplaçable par des PNG via le manifest (assets.ts).
import { Game, Unit, Building } from './engine';
import { UNITS, BUILDINGS, THEMES, PLAYER_COLORS } from './data';
import { T_ROUGH, T_WATER, T_ROCK, mulberry32 } from './map';
import { prof } from './profiler';
import { Proj, ISO_ELEV } from './proj';
import { bakeIsoBuilding, IsoBuildingSprite, BUILDING_HEIGHTS, ISO_S } from './iso-buildings';
import { getBuildingAsset } from './assets';
import { bakeVehicle } from './vehicles';

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
// Palette éclaircie (l'ancienne était presque noire : les véhicules se
// lisaient comme des taches sombres en vue iso). Olive militaire mat.
const HULL_DARK = '#252c24';
const HULL_MID = '#41493c';
const HULL_LIGHT = '#5d6a52';
const INDUSTRIAL_ACCENT = '#b88f34';

// Résolution des sprites pré-calculés (px par tuile) : le détail est "cuit"
// une seule fois en haute résolution puis affiché lissé — beaucoup plus fin
// qu'un dessin direct, et plus rapide.
const SPX = 48;

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
  bakedShadow = true,   // false pour les sprites qui TOURNENT (véhicules/tourelles/
                        // infanterie) : sinon l'ombre cuite pivote avec eux. Leur
                        // ombre est gérée au rendu (projetée au sol, direction fixe).
) {
  const rng = mulberry32(seed * 97 + 31);
  if (bakedShadow) {
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
  }

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
    const SUB = 3;
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
    // Champ d'altitude sous-tuile. Contraste modéré : de bons reliefs sans
    // paliers trop francs qui créent un effet grille artificiel.
    const SH = new Float32Array(W4 * H4);
    for (let sy = 0; sy < H4; sy++)
      for (let sx2 = 0; sx2 < W4; sx2++) {
        const hv = (interpH((sx2 + 0.5) / SUB - 0.5, (sy + 0.5) / SUB - 0.5) - 0.46) * 1.20 + 0.46;
        SH[sy * W4 + sx2] = hv < 0 ? 0 : hv > 1 ? 1 : hv;
      }

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
    const shoreRGB = hex2rgb(theme.shore);

    // Précalcul : couleur de chaque tuile (+ 2 tuiles de marge pour le warp)
    // → remplace 4 appels de fonction tileRGB() par 4 lectures de tableau par pixel.
    const TMAP_W = w + 4;
    const tileMap = new Uint8Array(TMAP_W * (h + 4) * 3);
    for (let ty2 = -2; ty2 < h + 2; ty2++) {
      for (let tx2 = -2; tx2 < w + 2; tx2++) {
        const cty2 = ty2 < 0 ? 0 : ty2 >= h ? h - 1 : ty2;
        const ctx2 = tx2 < 0 ? 0 : tx2 >= w ? w - 1 : tx2;
        const tt = terrain[cty2 * w + ctx2];
        const vi = (((ctx2 * 73856093) ^ (cty2 * 19349663)) >>> 0);
        const pp = tt === T_WATER ? waterRGB : tt === T_ROCK ? rockP[vi % rockP.length] : tt === T_ROUGH ? roughP[vi % roughP.length] : grassP[vi % grassP.length];
        const i3 = ((ty2 + 2) * TMAP_W + (tx2 + 2)) * 3;
        tileMap[i3] = pp[0]; tileMap[i3 + 1] = pp[1]; tileMap[i3 + 2] = pp[2];
      }
    }
    // Voisins fixes (évite 73K allocations de tableaux dans la boucle)
    const N4DX = [1, -1, 0, 0], N4DY = [0, 0, 1, -1];

    for (let sy = 0; sy < H4; sy++) {
      for (let sx2 = 0; sx2 < W4; sx2++) {
        const i4 = sy * W4 + sx2;
        const fx = (sx2 + 0.5) / SUB, fy = (sy + 0.5) / SUB;
        // frontières organiques : bruit basse-fréquence + grande amplitude
        // → formes larges et naturelles, sans petits zigzags répétitifs
        const wx = fx - 0.5 + (warpA(fx * 0.72, fy * 0.72) - 0.5) * 3.0;
        const wy = fy - 0.5 + (warpB(fx * 0.72 + 2.6, fy * 0.72 + 1.3) - 0.5) * 3.0;
        const x0 = Math.floor(wx), y0 = Math.floor(wy);
        const fxr = wx - x0, fyr = wy - y0;
        let gtx = Math.round(wx); if (gtx < 0) gtx = 0; else if (gtx >= w) gtx = w - 1;
        let gty = Math.round(wy); if (gty < 0) gty = 0; else if (gty >= h) gty = h - 1;
        const t = terrain[gty * w + gtx];
        let rockContact = 0, openContact = 0, waterContact = 0;
        for (let ni = 0; ni < 4; ni++) {
          const nx = gtx + N4DX[ni], ny = gty + N4DY[ni];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nt = terrain[ny * w + nx];
          if (nt === T_ROCK) rockContact++;
          else if (nt === T_WATER) waterContact++;
          else openContact++;
        }

        // mélange bilinéaire des 4 tuiles voisines (lecture directe tileMap)
        const x0c = (x0 + 2 < 0 ? 0 : x0 + 2 >= TMAP_W ? TMAP_W - 1 : x0 + 2);
        const x1c = (x0 + 3 < 0 ? 0 : x0 + 3 >= TMAP_W ? TMAP_W - 1 : x0 + 3);
        const y0c = (y0 + 2 < 0 ? 0 : y0 + 2 >= h + 4 ? h + 3 : y0 + 2);
        const y1c = (y0 + 3 < 0 ? 0 : y0 + 3 >= h + 4 ? h + 3 : y0 + 3);
        const i00 = (y0c * TMAP_W + x0c) * 3, i10 = (y0c * TMAP_W + x1c) * 3;
        const i01 = (y1c * TMAP_W + x0c) * 3, i11 = (y1c * TMAP_W + x1c) * 3;
        const w00 = (1 - fxr) * (1 - fyr), w10 = fxr * (1 - fyr);
        const w01 = (1 - fxr) * fyr, w11 = fxr * fyr;
        let r = tileMap[i00] * w00 + tileMap[i10] * w10 + tileMap[i01] * w01 + tileMap[i11] * w11;
        let gn = tileMap[i00+1] * w00 + tileMap[i10+1] * w10 + tileMap[i01+1] * w01 + tileMap[i11+1] * w11;
        let b = tileMap[i00+2] * w00 + tileMap[i10+2] * w10 + tileMap[i01+2] * w01 + tileMap[i11+2] * w11;

        if (t === T_ROCK) {
          // zones infranchissables : sombres et distinctes, liseré de contact clair
          r = r * 0.68 + 22; gn = gn * 0.64 + 18; b = b * 0.60 + 14;
          if (openContact > 0) {
            const rim = Math.min(0.32, openContact * 0.08);
            r += 50 * rim; gn += 40 * rim; b += 28 * rim;
          }
        } else if (rockContact > 0 && t !== T_WATER) {
          const border = Math.min(0.36, rockContact * 0.10);
          r *= 1 - border; gn *= 1 - border; b *= 1 - border * 0.85;
        }

        const e = SH[i4];

        if (t !== T_WATER) {
          // === PLAGE : transition douce eau→terre, élargie, basée sur altitude ===
          if (t !== T_ROCK) {
            // contact direct + zone basse altitude → sable progressif
            const contactBeach = waterContact > 0 ? Math.min(0.68, waterContact * 0.24) : 0;
            const lowBeach = Math.max(0, 1.0 - e * 5.5) * 0.36;
            const beachBlend = Math.min(0.70, Math.max(contactBeach, lowBeach));
            if (beachBlend > 0.01) {
              r = r * (1 - beachBlend) + shoreRGB[0] * beachBlend;
              gn = gn * (1 - beachBlend) + shoreRGB[1] * beachBlend;
              b = b * (1 - beachBlend) + shoreRGB[2] * beachBlend;
            }
          }

          // === TONALITÉ ALTIMÉTRIQUE : douce, non dominante ===
          const hh = e - 0.50;
          if (hh > 0) {
            // plateaux : légère chaleur, sans écraser la couleur de base
            const k = Math.min(0.28, hh * 0.76);
            r += (208 - r) * k * 0.50; gn += (192 - gn) * k * 0.42; b += (138 - b) * k * 0.26;
          } else {
            // creux : légère fraîcheur/verdure
            const k = Math.min(0.24, -hh * 0.72);
            r += (24 - r) * k * 0.50; gn += (60 - gn) * k * 0.38; b += (46 - b) * k * 0.28;
          }

          // grain de surface léger
          const j = (grain(fx * 3.5, fy * 3.5) - 0.5) * 0.13 + (tint(fx * 6.5, fy * 6.5) - 0.5) * 0.07;
          r *= 1 + j; gn *= 1 + j; b *= 1 + j;

          // fond de vallée : humidité subtile
          const valleyTone = Math.max(0, Math.min(1, (0.40 - e) * 2.0));
          if (valleyTone > 0) {
            r = r * (1 - valleyTone * 0.15) + 20 * valleyTone;
            gn = gn * (1 - valleyTone * 0.08) + 54 * valleyTone;
            b = b * (1 - valleyTone * 0.04) + 42 * valleyTone;
          }
          // plateaux : tonalité rocheuse douce
          const plateauTone = Math.max(0, Math.min(1, (e - 0.67) * 2.0));
          if (plateauTone > 0) {
            r = r * (1 - plateauTone * 0.12) + 185 * plateauTone;
            gn = gn * (1 - plateauTone * 0.16) + 168 * plateauTone;
            b = b * (1 - plateauTone * 0.24) + 122 * plateauTone;
          }
        } else {
          // === EAU : bleu naturel, dégradé profondeur, rives tintées au sol ===
          const depth = Math.max(0, Math.min(1, (0.22 - e) / 0.22));
          const wR = 62 - depth * 42;   // hauts-fonds teal → profond bleu
          const wG = 150 - depth * 92;
          const wB = 192 - depth * 72;
          const wBlend = 0.50 + depth * 0.36;
          r = r * (1 - wBlend) + wR * wBlend;
          gn = gn * (1 - wBlend) + wG * wBlend;
          b = b * (1 - wBlend) + wB * wBlend;
          // rives proches (openContact = voisins terre) : teinte sableuse organique
          if (openContact > 0 && depth < 0.60) {
            const sBlend = Math.min(0.30, openContact * 0.10) * (1 - depth * 1.7);
            r += (shoreRGB[0] * 0.52 - r) * sBlend;
            gn += (shoreRGB[1] * 0.52 - gn) * sBlend;
            b += (shoreRGB[2] * 0.52 - b) * sBlend;
          }
          // micro-ondulations très discrètes
          const rip = (grain(fx * 4.5, fy * 2.2) - 0.5) * 6 + (tint(fx * 2.2, fy * 4.5) - 0.5) * 3;
          r += rip * 0.08; gn += rip * 0.16; b += rip * 0.32;
        }

        // === RELIEF CONTINU : normal-based diffuse équilibré, ombre douce, AO léger ===
        const xm = sx2 > 0 ? sx2 - 1 : sx2, xp = sx2 < W4 - 1 ? sx2 + 1 : sx2;
        const ym = sy > 0 ? sy - 1 : sy, yp = sy < H4 - 1 ? sy + 1 : sy;
        const hl = SH[sy * W4 + xm], hr = SH[sy * W4 + xp], hu = SH[ym * W4 + sx2], hd = SH[yp * W4 + sx2];
        const dxh = hr - hl, dyh = hd - hu;
        // Diffuse : amplitude modérée pour lire les pentes sans noircir les vallées
        const nlen = Math.sqrt(dxh * dxh + dyh * dyh + 0.004);
        const diffuse = ((-dxh * 0.6 + -dyh * 0.6 + 0.063) / (nlen * 1.1)) * 0.55 + 0.76;
        let relief = diffuse;
        if (relief < 0.28) relief = 0.28; else if (relief > 1.60) relief = 1.60;
        // Ombre portée très douce (moins d'artefact "peint sur le sol")
        let cast = 0;
        for (let s = 1; s <= 9; s++) {
          const ax = sx2 - s * 2, ay = sy - s * 2; if (ax < 0 || ay < 0) break;
          const diff = SH[ay * W4 + ax] - e - s * 0.016;
          if (diff > cast) cast = diff;
        }
        // AO léger (vallées 8% plus sombres max) — pas d'enfoncement brutal
        const ao = Math.max(0, (0.42 - e) * 0.10);
        const m = relief * (1 - Math.min(0.32, cast * 2.4) - ao);
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

    const SS = spx;             // taille d'une sous-tuile en pixels

    // ===== 2) RIVAGES : transitions gérées entièrement per-pixel (warp organique
    // + shore tinting dans la boucle pixel). Aucun tracé par bord de tuile
    // → pas de grille/staircase visible au bord de l'eau.
    const icyShore = g.map.theme === 'snow';

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
        const jitter = (s: number, salt: number) => (warpB(tx + s * 0.25 + salt, ty + s * 0.25) - 0.5) * SS * 1.1;
        // Arêtes N/O (côté opposé à la caméra) : liseré discret uniquement.
        // Les anciennes GROSSES bandes floues et les faces plates E/S sont
        // supprimées : elles doublonnaient salement sous les parois
        // verticales de la passe 3bis (double dessin = traits noirs baveux).
        if (mask & 1) { // N : arête éclairée (soleil NW)
          tc.fillStyle = 'rgba(255,252,228,0.46)';
          for (let s = 0; s < SUB; s++) tc.fillRect(px + s * SS, py + jitter(s, 1) * 0.5, SS + 1, Math.max(1.5, SS * 0.42));
          // halo diffus sous l'arête
          tc.fillStyle = 'rgba(255,250,200,0.14)';
          for (let s = 0; s < SUB; s++) tc.fillRect(px + s * SS, py + jitter(s, 1) * 0.3 + SS * 0.3, SS + 1, Math.max(1, SS * 0.6));
        }
        if (mask & 8) { // O : arête éclairée
          tc.fillStyle = 'rgba(255,252,228,0.42)';
          for (let s = 0; s < SUB; s++) tc.fillRect(px + jitter(s, 4) * 0.5, py + s * SS, Math.max(1.5, SS * 0.42), SS + 1);
          tc.fillStyle = 'rgba(255,250,200,0.12)';
          for (let s = 0; s < SUB; s++) tc.fillRect(px + jitter(s, 4) * 0.3 + SS * 0.3, py + s * SS, Math.max(1, SS * 0.6), SS + 1);
        }
      }

    // ===== 3bis) PAROIS ROCHEUSES VERTICALES : le terrain est cisaillé par la
    // projection affine ; en pré-appliquant la matrice INVERSE (U), ces murs
    // apparaissent parfaitement VERTICAUX à l'écran — le relief devient une
    // vraie marche 3D, pas une bande sombre plate. Cuit une fois : coût nul.
    {
      const LEVELS = 9;
      const rockBase = THEMES[g.map.theme].rock[0];
      const wallTop = shade(rockBase, +0.10);
      const wallBot = shade(rockBase, -0.58);
      const lvl = (xx: number, yy: number) =>
        Math.floor((height[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))] ?? 0.5) * LEVELS);
      const wallRng = mulberry32(w * 613 + h * 271 + 5);
      const drawWall = (ax: number, ay: number, bx: number, by: number, hw: number) => {
        tc.save();
        tc.translate(ax, ay);
        tc.transform(0.5, -0.5, 1, 1, 0, 0);   // inverse du cisaillement iso
        // face : colonnes rocheuses facettées (largeurs irrégulières, teintes
        // alternées) — la paroi a du grain, pas un simple dégradé plat
        const gr2 = tc.createLinearGradient(0, 0, 0, hw);
        gr2.addColorStop(0, wallTop);
        gr2.addColorStop(0.25, shade(rockBase, -0.24));
        gr2.addColorStop(1, wallBot);
        tc.fillStyle = gr2;
        tc.beginPath();
        tc.moveTo(0, 0); tc.lineTo(bx, by); tc.lineTo(bx, by + hw); tc.lineTo(0, hw);
        tc.closePath(); tc.fill();
        const nFac = 2;
        let tPrev = 0;
        for (let f = 0; f < nFac; f++) {
          const tNext = f === nFac - 1 ? 1 : (f + 1) / nFac + (wallRng() - 0.5) * 0.12;
          const fx0 = bx * tPrev, fy0 = by * tPrev;
          const fx1 = bx * tNext, fy1 = by * tNext;
          const tone = (f % 2 === 0 ? -0.1 : 0.06) + (wallRng() - 0.5) * 0.08;
          tc.fillStyle = shade(rockBase, -0.18 + tone);
          tc.globalAlpha = 0.28;
          tc.beginPath();
          tc.moveTo(fx0, fy0 + hw * 0.12);
          tc.lineTo(fx1, fy1 + hw * 0.1);
          tc.lineTo(fx1 + (wallRng() - 0.5) * 2, fy1 + hw);
          tc.lineTo(fx0 + (wallRng() - 0.5) * 2, fy0 + hw);
          tc.closePath(); tc.fill();
          tc.globalAlpha = 1;
          tPrev = tNext;
        }
        // strates horizontales + fissures verticales (relief de roche)
        tc.strokeStyle = 'rgba(0,0,0,0.30)'; tc.lineWidth = 1;
        for (let k = 1; k <= 2; k++) {
          const yy = (hw * k) / 3 + (wallRng() - 0.5) * 2;
          tc.beginPath(); tc.moveTo(1, yy); tc.lineTo(bx - 1, by + yy); tc.stroke();
        }
        const nCr = 2;
        for (let k = 0; k < nCr; k++) {
          const t0 = (k + 0.3 + wallRng() * 0.5) / nCr;
          const xx = bx * t0, yy0 = by * t0;
          tc.strokeStyle = `rgba(0,0,0,${0.22 + wallRng() * 0.2})`;
          tc.beginPath();
          tc.moveTo(xx, yy0 + hw * (0.12 + wallRng() * 0.2));
          tc.lineTo(xx + (wallRng() - 0.5) * 3, yy0 + hw * (0.72 + wallRng() * 0.25));
          tc.stroke();
        }
        // lèvre supérieure : arête très claire + ombre du surplomb
        tc.strokeStyle = 'rgba(255,252,230,0.72)'; tc.lineWidth = Math.max(1.5, SS * 0.44);
        tc.beginPath(); tc.moveTo(0, 0.5); tc.lineTo(bx, by + 0.5); tc.stroke();
        tc.strokeStyle = 'rgba(0,0,0,0.52)'; tc.lineWidth = Math.max(1.2, SS * 0.28);
        tc.beginPath(); tc.moveTo(0, 0.5 + SS * 0.5); tc.lineTo(bx, by + 0.5 + SS * 0.5); tc.stroke();
        // occlusion au pied : très sombre pour ancrer le mur
        tc.fillStyle = 'rgba(2,4,8,0.46)';
        tc.beginPath();
        tc.moveTo(0, hw); tc.lineTo(bx, by + hw); tc.lineTo(bx, by + hw + SS * 1.6); tc.lineTo(0, hw + SS * 1.6);
        tc.closePath(); tc.fill();
        // éboulis : cailloux tombés au pied (ancre le mur dans le sol)
        for (let r2 = 0; r2 < 2; r2++) {
          const t3 = wallRng();
          const rx2 = bx * t3 + (wallRng() - 0.5) * 3;
          const ry2 = by * t3 + hw + wallRng() * SS * 0.9;
          const rs = 0.8 + wallRng() * 1.6;
          tc.fillStyle = shade(rockBase, -0.3 + wallRng() * 0.25);
          tc.beginPath(); tc.ellipse(rx2, ry2, rs * 1.3, rs * 0.8, wallRng(), 0, Math.PI * 2); tc.fill();
        }
        tc.restore();
      };
      for (let ty = 0; ty < h; ty++)
        for (let tx = 0; tx < w; tx++) {
          const i = ty * w + tx;
          const mask = cliff[i] ?? 0;
          if (!mask || terrain[i] === T_WATER) continue;
          const px = tx * tpx, py = ty * tpx;
          const myL = lvl(tx, ty);
          if (mask & 4) {   // face SUD
            const dL = Math.max(1, Math.min(4, myL - lvl(tx, ty + 1)));
            const hw = tpx * (0.46 + 0.30 * dL);
            drawWall(px, py + tpx, tpx, 0.5 * tpx, hw);
          }
          if (mask & 2) {   // face EST
            const dL = Math.max(1, Math.min(4, myL - lvl(tx + 1, ty)));
            const hw = tpx * (0.46 + 0.30 * dL);
            drawWall(px + tpx, py, -tpx, 0.5 * tpx, hw);
          }
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

    // ===== 5) VÉGÉTATION riche : arbres, buissons, touffes, cailloux, galets
    const tropical = g.map.theme === 'tropical';
    const arctic = g.map.theme === 'snow';
    const badlands = g.map.theme === 'badlands';
    const vegRng = mulberry32(w * 17 + h * 101 + 55);

    // Pré-cuisson des sprites d'arbres avec iso-compensation intégrée.
    // Chaque stamp encode déjà le transform(0.5,-0.5,1,1) → 1 drawImage par arbre
    // au lieu de ~80 appels canvas API individuels (×1200 arbres = 96 000 → 1 200).
    const mkTreeStamp = (style: 'pine' | 'oak' | 'palm' | 'dead', scale: number): [HTMLCanvasElement, number, number] => {
      const sw = Math.ceil(tpx * 5 * scale + tpx), sh = Math.ceil(tpx * 4 * scale + tpx);
      const sc2 = document.createElement('canvas');
      sc2.width = sw; sc2.height = sh;
      const cx = sc2.getContext('2d')!;
      const anX = sw * 0.5, anY = sh * 0.78;
      cx.translate(anX, anY);
      cx.transform(0.5, -0.5, 1, 1, 0, 0);
      cx.translate(-anX, -anY);
      const trunkH = tpx * (style === 'palm' ? 0.52 : 0.32) * scale;
      // ombre au sol
      cx.fillStyle = 'rgba(0,0,0,0.22)';
      cx.beginPath(); cx.ellipse(anX + SS * 0.3, anY + SS * 0.22, SS * 1.1 * scale, SS * 0.5 * scale, 0.3, 0, Math.PI * 2); cx.fill();
      // tronc
      cx.strokeStyle = style === 'dead' ? 'rgba(80,60,40,0.80)' : 'rgba(78,54,30,0.82)';
      cx.lineWidth = Math.max(1, SS * (style === 'palm' ? 0.18 : 0.26) * scale);
      cx.beginPath(); cx.moveTo(anX, anY); cx.lineTo(anX, anY - trunkH); cx.stroke();
      const topX = anX, topY = anY - trunkH;
      if (style === 'pine') {
        for (let tier = 0; tier < 3; tier++) {
          const yy = topY + trunkH * tier * 0.26;
          const ww = SS * (2.7 - tier * 0.5) * scale;
          const hh2 = SS * (1.55 - tier * 0.22) * scale;
          cx.fillStyle = tier % 2 === 0 ? 'rgba(18,64,32,0.80)' : 'rgba(24,78,42,0.75)';
          cx.beginPath();
          cx.moveTo(topX, yy - hh2 * 0.9);
          cx.lineTo(topX + ww * 0.55, yy + hh2 * 0.55);
          cx.lineTo(topX - ww * 0.55, yy + hh2 * 0.55);
          cx.closePath(); cx.fill();
        }
      } else if (style === 'oak') {
        cx.fillStyle = 'rgba(24,72,28,0.72)';
        cx.beginPath(); cx.arc(topX, topY, SS * 2.0 * scale, 0, Math.PI * 2); cx.fill();
        cx.fillStyle = 'rgba(32,88,38,0.62)';
        cx.beginPath(); cx.arc(topX - SS * 0.6 * scale, topY - SS * 0.4 * scale, SS * 1.4 * scale, 0, Math.PI * 2); cx.fill();
        cx.fillStyle = 'rgba(180,220,190,0.14)';
        cx.beginPath(); cx.arc(topX - SS * 0.8 * scale, topY - SS * 0.6 * scale, SS * 0.8 * scale, 0, Math.PI * 2); cx.fill();
      } else if (style === 'palm') {
        cx.strokeStyle = '#2a7a38'; cx.lineWidth = Math.max(1, SS * 0.28 * scale);
        for (let q = 0; q < 5; q++) {
          const a = (q / 5) * Math.PI * 2;
          cx.beginPath();
          cx.moveTo(topX, topY);
          cx.quadraticCurveTo(topX + Math.cos(a) * tpx * 0.24, topY + Math.sin(a) * tpx * 0.12,
            topX + Math.cos(a) * tpx * 0.45, topY + Math.sin(a) * tpx * 0.24);
          cx.stroke();
        }
      } else {
        cx.strokeStyle = 'rgba(60,44,30,0.58)'; cx.lineWidth = Math.max(1, SS * 0.18);
        for (let q = 0; q < 3; q++) {
          const a = (q / 3) * Math.PI - Math.PI * 0.35;
          cx.beginPath();
          cx.moveTo(topX, topY);
          cx.lineTo(topX + Math.cos(a) * tpx * 0.22 * scale, topY + Math.sin(a) * tpx * 0.12 * scale);
          cx.stroke();
        }
      }
      return [sc2, anX, anY];
    };
    const treeStamps: Record<string, [HTMLCanvasElement, number, number][]> = {
      pine: [0.72, 1.0, 1.30].map(s => mkTreeStamp('pine', s)),
      oak:  [0.72, 1.0, 1.30].map(s => mkTreeStamp('oak', s)),
      palm: [0.72, 1.0, 1.30].map(s => mkTreeStamp('palm', s)),
      dead: [0.55, 0.72, 0.90].map(s => mkTreeStamp('dead', s)),
    };
    const stampTree = (px: number, py: number, style: string) => {
      const [sc2, ax, ay] = treeStamps[style][(vegRng() * 3) | 0];
      tc.drawImage(sc2, px - ax, py - ay);
    };

    const vegCount = Math.floor(w * h * 1.0);
    for (let k = 0; k < vegCount; k++) {
      const tx = (vegRng() * w) | 0, ty = (vegRng() * h) | 0;
      const t = terrain[ty * w + tx];
      if (t === T_WATER) continue;
      const px = tx * tpx + vegRng() * tpx, py = ty * tpx + vegRng() * tpx;
      const r = vegRng();

      if (t === T_ROCK) {
        // zones rocheuses : cailloux + fissures + lichens
        if (r < 0.50) {
          const rs = SS * (0.5 + vegRng() * 0.9);
          tc.fillStyle = `rgba(0,0,0,${0.16 + vegRng() * 0.18})`;
          tc.beginPath(); tc.ellipse(px, py, rs * 1.4, rs * 0.9, vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
          tc.fillStyle = `rgba(255,245,215,${0.06 + vegRng() * 0.06})`;
          tc.beginPath(); tc.ellipse(px - rs * 0.3, py - rs * 0.25, rs * 0.8, rs * 0.45, 0, 0, Math.PI * 2); tc.fill();
        }
        if (r < 0.18) { // lichens verts sur roche
          tc.fillStyle = `rgba(68,90,40,${0.18 + vegRng() * 0.16})`;
          tc.beginPath(); tc.ellipse(px, py, SS * (0.6 + vegRng() * 0.7), SS * (0.35 + vegRng() * 0.4), vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
        }
      } else if (arctic) {
        if (r < 0.042 && !roads[ty * w + tx]) {
          stampTree(px, py, 'pine');
        } else if (r < 0.10) {
          tc.fillStyle = 'rgba(38,52,58,0.24)';
          tc.beginPath(); tc.ellipse(px, py, SS * (0.9 + vegRng() * 0.8), SS * (0.48 + vegRng() * 0.38), vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
          tc.fillStyle = 'rgba(240,248,254,0.42)';
          tc.beginPath(); tc.ellipse(px - SS * 0.18, py - SS * 0.18, SS * (0.7 + vegRng() * 0.5), SS * 0.28, vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
        } else if (r < 0.22) {
          const len = SS * (0.9 + vegRng() * 0.9);
          tc.strokeStyle = 'rgba(22,40,36,0.26)'; tc.lineWidth = 1;
          for (let q = 0; q < 2; q++) { tc.beginPath(); tc.moveTo(px + (vegRng() - 0.5) * SS, py + SS * 0.4); tc.lineTo(px + (vegRng() - 0.5) * SS * 0.6, py - len); tc.stroke(); }
        }
      } else if (tropical) {
        if (r < 0.048 && !roads[ty * w + tx]) {
          stampTree(px, py, 'palm');
        } else if (r < 0.11 && t !== T_ROCK) {
          // fougères / grandes herbes tropicales
          tc.fillStyle = 'rgba(12,52,20,0.55)';
          for (let q = 0; q < 4; q++) { tc.beginPath(); tc.arc(px + (vegRng() - 0.5) * SS * 2.2, py + (vegRng() - 0.5) * SS * 2.2, SS * (0.45 + vegRng() * 0.5), 0, Math.PI * 2); tc.fill(); }
          tc.fillStyle = 'rgba(30,80,32,0.42)';
          for (let q = 0; q < 3; q++) { tc.beginPath(); tc.arc(px + (vegRng() - 0.5) * SS * 1.6, py + (vegRng() - 0.5) * SS * 1.6, SS * (0.30 + vegRng() * 0.35), 0, Math.PI * 2); tc.fill(); }
        } else if (r < 0.30) {
          tc.fillStyle = 'rgba(8,48,16,0.40)';
          tc.beginPath(); tc.ellipse(px, py, SS * (0.8 + vegRng() * 1.0), SS * (0.5 + vegRng() * 0.6), vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
        }
      } else if (badlands) {
        if (r < 0.028 && !roads[ty * w + tx]) {
          stampTree(px, py, 'dead');
        } else if (r < 0.20) {
          // cailloux brûlés
          tc.fillStyle = `rgba(0,0,0,${0.14 + vegRng() * 0.16})`;
          tc.beginPath(); tc.ellipse(px, py, SS * (0.8 + vegRng() * 0.9), SS * (0.45 + vegRng() * 0.45), vegRng() * Math.PI, 0, Math.PI * 2); tc.fill();
        } else if (r < 0.32) {
          // touffes rabougries
          const len = SS * (0.5 + vegRng() * 0.6);
          tc.strokeStyle = 'rgba(100,70,38,0.35)'; tc.lineWidth = 1;
          tc.beginPath(); tc.moveTo(px, py); tc.lineTo(px + (vegRng() - 0.5) * SS * 0.8, py - len); tc.stroke();
        }
      } else {
        // TEMPERATE + DESERT + MIST : arbres, herbes, buissons
        const isDesert = g.map.theme === 'desert';
        if (!isDesert && r < 0.055 && !roads[ty * w + tx] && t !== T_ROCK) {
          stampTree(px, py, vegRng() < 0.60 ? 'pine' : 'oak');
        } else if (r < 0.28) {
          // touffes d'herbe / végétation basse (variées)
          const len = SS * (0.9 + vegRng() * 1.1);
          const leafAlpha = isDesert ? 0.14 : 0.28;
          tc.strokeStyle = isDesert ? `rgba(140,100,40,${leafAlpha})` : `rgba(0,0,0,${leafAlpha})`;
          tc.lineWidth = 1;
          for (let q = 0; q < 2 + (r < 0.10 ? 2 : 0); q++) {
            tc.beginPath(); tc.moveTo(px + (vegRng() - 0.5) * SS * 1.2, py); tc.lineTo(px + (vegRng() - 0.5) * SS, py - len * (0.6 + vegRng() * 0.5)); tc.stroke();
          }
          tc.strokeStyle = isDesert ? 'rgba(220,190,120,0.12)' : 'rgba(255,255,230,0.18)';
          tc.beginPath(); tc.moveTo(px + 0.7, py); tc.lineTo(px + 0.7 + (vegRng() - 0.5) * SS, py - len * 0.75); tc.stroke();
        } else if (r < 0.38 && !isDesert) {
          // buisson dense
          tc.fillStyle = 'rgba(20,52,18,0.38)';
          for (let q = 0; q < 4; q++) { tc.beginPath(); tc.arc(px + (vegRng() - 0.5) * SS * 2.0, py + (vegRng() - 0.5) * SS * 2.0, SS * (0.42 + vegRng() * 0.45), 0, Math.PI * 2); tc.fill(); }
          tc.fillStyle = 'rgba(40,80,30,0.28)';
          tc.beginPath(); tc.arc(px, py - SS * 0.3, SS * (0.8 + vegRng() * 0.5), 0, Math.PI * 2); tc.fill();
        } else if (r < 0.44) {
          // galet / caillou
          tc.fillStyle = `rgba(80,68,48,${0.20 + vegRng() * 0.18})`;
          tc.beginPath(); tc.ellipse(px, py, SS * (1.2 + vegRng() * 0.9), SS * (0.7 + vegRng() * 0.6), vegRng() * 3, 0, Math.PI * 2); tc.fill();
          tc.fillStyle = `rgba(255,242,210,${0.06 + vegRng() * 0.06})`;
          tc.beginPath(); tc.ellipse(px - SS * 0.3, py - SS * 0.3, SS * 0.7, SS * 0.38, 0, 0, Math.PI * 2); tc.fill();
        }
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
        // fissures + stries d'érosion (plus larges et sombres)
        tc.strokeStyle = snow ? 'rgba(30,42,52,0.28)' : t === T_ROCK ? 'rgba(0,0,0,0.42)' : 'rgba(48,36,18,0.28)';
        tc.lineWidth = Math.max(1.2, SS * 0.28);
        const len = tpx * (0.30 + erosionRng() * 0.52);
        tc.beginPath();
        tc.moveTo(-len * 0.5, 0);
        tc.quadraticCurveTo(erosionRng() * SS * 0.4, (erosionRng() - 0.5) * SS * 1.2, len * 0.5, 0);
        tc.stroke();
        tc.strokeStyle = snow ? 'rgba(255,255,255,0.18)' : 'rgba(255,245,210,0.14)';
        tc.lineWidth = 1;
        tc.beginPath();
        tc.moveTo(-len * 0.38, -SS * 0.22);
        tc.lineTo(len * 0.38, -SS * 0.22);
        tc.stroke();
        // second sillon décalé
        if (erosionRng() < 0.55) {
          tc.strokeStyle = snow ? 'rgba(24,36,46,0.18)' : 'rgba(0,0,0,0.22)';
          tc.lineWidth = Math.max(1, SS * 0.18);
          const len2 = len * (0.5 + erosionRng() * 0.4);
          tc.beginPath();
          tc.moveTo(-len2 * 0.5 + (erosionRng() - 0.5) * SS, SS * 0.5);
          tc.quadraticCurveTo(0, SS * 0.5 + (erosionRng() - 0.5) * SS * 0.6, len2 * 0.5 + (erosionRng() - 0.5) * SS, SS * 0.5);
          tc.stroke();
        }
      } else if (t === T_ROUGH) {
        tc.fillStyle = snow ? 'rgba(60,72,82,0.22)' : desert ? 'rgba(130,90,48,0.24)' : 'rgba(72,58,38,0.26)';
        tc.beginPath();
        tc.ellipse(0, 0, tpx * (0.22 + erosionRng() * 0.22), SS * (0.52 + erosionRng() * 0.52), 0, 0, Math.PI * 2);
        tc.fill();
      } else if (erosionRng() < 0.38) {
        tc.fillStyle = snow ? 'rgba(230,240,248,0.15)' : desert ? 'rgba(158,118,62,0.20)' : 'rgba(128,106,62,0.20)';
        tc.beginPath();
        tc.ellipse(0, 0, tpx * (0.18 + erosionRng() * 0.15), SS * (0.40 + erosionRng() * 0.40), 0, 0, Math.PI * 2);
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

    // film atmosphérique final (unité chromatique + légère désaturation des extrêmes)
    tc.fillStyle = 'rgba(0,0,0,0.06)';
    tc.fillRect(0, 0, c.width, c.height);
    // très léger voile chaud (ciel) sur la moitié haute — donne de la profondeur
    const atmGr = tc.createLinearGradient(0, 0, 0, c.height * 0.35);
    atmGr.addColorStop(0, 'rgba(210,190,140,0.04)');
    atmGr.addColorStop(1, 'rgba(0,0,0,0)');
    tc.fillStyle = atmGr;
    tc.fillRect(0, 0, c.width, c.height * 0.35);
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

    // Projection isométrique de la frame : LE convertisseur monde → écran.
    const proj = new Proj(cam.x, cam.y, z, W, H);
    this.lastGame = g;
    if (this.lastPos.size > 2500) this.lastPos.clear();

    ctx.fillStyle = '#0a0d10';
    ctx.fillRect(0, 0, W, H);

    // ----- terrain : SOL ISO PRÉ-PROJETÉ par tuiles cachées. Un blit affine
    // plein écran par frame est le chemin LENT de Canvas2D (Safari, mobile) ;
    // on projette donc le terrain une seule fois par « chunk » de 256 px et
    // par palier de zoom, puis chaque frame ne fait que des drawImage
    // AXIS-ALIGNED (chemin rapide partout). Cache LRU, terrain immuable.
    if (!this.terrain) this.buildTerrain(g);
    const ab = proj.worldAABB(2);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    const _rt = prof.enabled ? performance.now() : 0;
    this.drawIsoGround(ctx, proj);
    this.prewarmGround(g);
    if (prof.enabled) prof.add('render.terrain', performance.now() - _rt);

    // bornes de culling en tuiles (AABB monde du viewport iso)
    const tx0 = Math.max(0, Math.floor(ab.x0));
    const tx1 = Math.min(mw - 1, Math.ceil(ab.x1));
    const ty0 = Math.max(0, Math.floor(ab.y0));
    const ty1 = Math.min(g.map.h - 1, Math.ceil(ab.y1));

    // ----- EAU VIVANTE : miroitement et vaguelettes animés par frame, dessinés
    // par-dessus le terrain figé (sous les entités). Borné au viewport ; ignoré
    // en fort dézoom (invisible et inutile → coût nul sur grandes cartes).
    if (z >= 14) {   // invisible et coûteux au dézoom (des dizaines de milliers de tuiles)
      const terr = g.map.terrain, t1 = g.time;
      const sPx = z;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const idx = ty * mw + tx;
          if (terr[idx] !== T_WATER) continue;
          if (!revealAll && fog[idx] === 0) continue;
          const px = proj.sx(tx + 0.5, ty + 0.5), py = proj.sy(tx + 0.5, ty + 0.5);
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

    // ----- ÉCUME DE RIVAGE animée : vaguelettes qui lèchent la côte (les
    // segments côtiers sont précalculés une fois ; par frame on ne dessine
    // que ceux du viewport). Donne vie aux bords d'eau sans coût notable.
    if (z >= 15) {   // écume : uniquement à zoom rapproché (milliers de segments sinon)
      if (!this.shore) this.buildShore(g);
      ctx.save();
      ctx.lineCap = 'round';
      for (const sgm of this.shore!) {
        if (sgm.x < ab.x0 || sgm.x > ab.x1 || sgm.y < ab.y0 || sgm.y > ab.y1) continue;
        const fi = Math.round(sgm.y) * mw + Math.round(sgm.x);
        if (!revealAll && fog[Math.max(0, Math.min(fog.length - 1, fi))] === 0) continue;
        const t2 = g.time * 1.15 + sgm.ph;
        const pulse = 0.5 + 0.5 * Math.sin(t2);
        const lap = 0.1 * Math.sin(t2 * 0.7 + sgm.ph);        // la vague avance/recule
        const ox2 = sgm.nx * lap, oy2 = sgm.ny * lap;
        ctx.strokeStyle = `rgba(236,248,252,${0.08 + 0.2 * pulse})`;
        ctx.lineWidth = Math.max(1, z * (0.045 + 0.03 * pulse));
        ctx.beginPath();
        ctx.moveTo(proj.sx(sgm.x1 + ox2, sgm.y1 + oy2), proj.sy(sgm.x1 + ox2, sgm.y1 + oy2));
        ctx.lineTo(proj.sx(sgm.x2 + ox2, sgm.y2 + oy2), proj.sy(sgm.x2 + ox2, sgm.y2 + oy2));
        ctx.stroke();
      }
      ctx.restore();
    }

    // ----- gisements : cristaux dorés (or) ou rouge sombre/bleu (minerai rare)
    for (const n of g.nodes) {
      if (n.amount < 10) continue;
      const i = n.ty * mw + n.tx;
      if (n.tx < tx0 || n.tx > tx1 || n.ty < ty0 || n.ty > ty1 || (!revealAll && fog[i] === 0)) continue;
      const px = proj.sx(n.tx, n.ty), py = proj.sy(n.tx, n.ty);
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
      this.drawUnitSprite(ctx, g, u, proj, v.selectedUnits.includes(u.id),
        ex0 + (u.x - ex0) * k, ey0 + (u.y - ey0) * k);
    }

    // ----- entités visibles + décals de sol
    const depthBuildings: Building[] = [];
    for (const b of g.buildings) {
      if (b.tx + b.w < tx0 || b.tx > tx1 || b.ty + b.h < ty0 - 2 || b.ty > ty1) continue;
      const ci = (b.ty + Math.floor(b.h / 2)) * mw + b.tx + Math.floor(b.w / 2);
      if (!revealAll && fog[ci] === 0) continue;
      depthBuildings.push(b);
    }
    // halo de sol des bâtiments : décal PLAT → une seule passe affine, sous
    // toutes les entités (le terrain « épouse » les bâtiments)
    {
      const t = proj.groundTransform(1, false);
      ctx.save();
      ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      for (const b of depthBuildings) {
        const decal = this.groundDecal(b.type);
        const wDec = decal.width / 44, hDec = decal.height / 44;   // px décal → tuiles
        const cx = b.tx - 0.5 + b.w / 2, cy = b.ty - 0.5 + b.h / 2;
        ctx.drawImage(decal, cx - wDec / 2, cy - hDec / 2, wDec, hDec);
      }
      ctx.restore();
    }
    // tri peintre UNIFIÉ par profondeur iso (x+y) : une entité plus « avant »
    // (vers le bas de l'écran) est dessinée après celles qu'elle recouvre.
    interface DepthEnt { key: number; b?: Building; u?: Unit; }
    const ents: DepthEnt[] = [];
    for (const b of depthBuildings) {
      ents.push({ key: (b.tx - 0.5 + b.w) + (b.ty - 0.5 + b.h) - 0.35, b });
    }
    for (const u of g.units) {
      if (u.transportedBy) continue;
      if (u.airState || exiting.has(u.id)) continue;
      if (u.x < tx0 - 1 || u.x > tx1 + 1 || u.y < ty0 - 1 || u.y > ty1 + 1) continue;
      if (!revealAll && u.owner !== this.pov && !g.isVisibleTo(this.pov, u.x, u.y)) continue;
      ents.push({ key: u.x + u.y, u });
    }
    ents.sort((a, b2) => a.key - b2.key);
    if (prof.enabled) { prof.count('render.entCount', ents.length); prof.count('render.entFrames'); }
    const _re = prof.enabled ? performance.now() : 0;
    for (const e of ents) {
      if (e.b) this.drawBuildingSprite(ctx, g, e.b, proj, v.selectedBuilding === e.b.id);
      else if (e.u) this.drawUnitSprite(ctx, g, e.u, proj, v.selectedUnits.includes(e.u.id));
    }
    if (prof.enabled) prof.add('render.entities', performance.now() - _re);

    // ----- projectiles
    for (const p of g.projectiles) {
      const px = proj.sx(p.x, p.y), py = proj.sy(p.x, p.y);
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      if (!revealAll && !g.isVisibleTo(this.pov, p.x, p.y)) continue;
      let arcY = 0;
      if (p.indirect) arcY = Math.sin(p.t * Math.PI) * p.dist * 0.22 * z;
      if (p.kind === 'bullet' || p.kind === 'mg' || p.kind === 'sniper') {
        ctx.strokeStyle = '#ffe9a0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        const bx = (p.tx - p.sx) / p.dist, by = (p.ty - p.sy) / p.dist;
        ctx.beginPath();
        ctx.moveTo(proj.sx(p.x - bx * 0.3, p.y - by * 0.3), proj.sy(p.x - bx * 0.3, p.y - by * 0.3));
        ctx.lineTo(px, py);
        ctx.stroke();
      } else if (p.kind === 'flak') {
        ctx.fillStyle = '#ffd3a0';
        ctx.beginPath(); ctx.arc(px, py, Math.max(1.5, z * 0.08), 0, Math.PI * 2); ctx.fill();
      } else {
        // traînée de fumée derrière les obus / roquettes
        for (let k = 1; k <= 3; k++) {
          const tt = Math.max(0, p.t - k * 0.045);
          const wxT = p.sx + (p.tx - p.sx) * tt, wyT = p.sy + (p.ty - p.sy) * tt;
          const txp = proj.sx(wxT, wyT), typ = proj.sy(wxT, wyT);
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
      const px = proj.sx(e.x, e.y), py = proj.sy(e.x, e.y);
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
      const px = proj.sx(u.x, u.y), py = proj.sy(u.x, u.y);
      if (px < -80 || px > W + 80 || py < -160 || py > H + 80) continue;
      const defA = UNITS[u.type];
      const vsA = this.unitVisualScale(u.type, defA);
      const alt = flying ? z * 1.35 : z * 0.12;
      // inclinaison en virage : on suit le cap d'une frame à l'autre
      const pv = this.lastPos.get(u.id);
      const dDir = pv ? Math.atan2(Math.sin(u.dir - pv.x), Math.cos(u.dir - pv.x)) : 0;
      this.lastPos.set(u.id, { x: u.dir, y: 0, mu: 0 });
      const bank = flying ? Math.max(-0.22, Math.min(0.22, dDir * 6)) : 0;
      // ombre au sol : plus loin, plus petite et plus douce en altitude
      const shOff = flying ? 0.95 : 0.12;
      const shx = proj.sx(u.x + shOff, u.y + shOff * 0.6), shy = proj.sy(u.x + shOff, u.y + shOff * 0.6);
      ctx.fillStyle = flying ? 'rgba(0,0,0,0.16)' : 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(shx, shy, z * (flying ? 0.4 : 0.6) * vsA, z * (flying ? 0.18 : 0.3) * vsA, 0, 0, Math.PI * 2);
      ctx.fill();
      // sortie de hangar : l'appareil se matérialise sur le pad (fondu rapide)
      let aIn = 1;
      if (u.exitFx) {
        const tIn = (g.time - u.exitFx.t0) / 0.6;
        if (tIn >= 0 && tIn < 1) aIn = 0.15 + 0.85 * tIn;
      }
      // fuselage : dir-sprite extrudé, éclairage écran fixe, léger roulis en virage
      const aD = this.isoUnitDir(u.type, u.owner, Renderer.dirIndex(u.dir), 'body', 0.14 * SPX * ISO_ELEV);
      if (aD) {
        const sA = (z / SPX) * vsA * (0.85 + 0.15 * aIn);
        ctx.save();
        ctx.globalAlpha = aIn;
        ctx.translate(px, py - alt);
        if (bank) ctx.rotate(bank);
        ctx.drawImage(aD.cv, -aD.ax * sA, -aD.ay * sA, aD.cv.width * sA, aD.cv.height * sA);
        ctx.restore();
      }
      // rotor des hélicoptères : disque flou + pales (vitesse selon vol/pad)
      if (u.type === 'transportheli' || u.type === 'cargoheli') {
        const ra = g.time * (flying ? 26 : 5) + u.id;
        const rr2 = z * (u.type === 'cargoheli' ? 0.66 : 0.56);
        ctx.save();
        ctx.globalAlpha = aIn;
        ctx.translate(px, py - alt - z * 0.16);
        ctx.transform(1, 0.5, -1, 0.5, 0, 0);
        ctx.strokeStyle = `rgba(215,220,214,${flying ? 0.3 : 0.16})`;
        ctx.lineWidth = Math.max(1, z * 0.055);
        ctx.beginPath(); ctx.arc(0, 0, rr2, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(235,238,232,0.85)';
        ctx.lineWidth = Math.max(1, z * 0.045);
        for (const a0 of [0, Math.PI / 2]) {
          ctx.beginPath();
          ctx.moveTo(Math.cos(ra + a0) * rr2, Math.sin(ra + a0) * rr2);
          ctx.lineTo(-Math.cos(ra + a0) * rr2, -Math.sin(ra + a0) * rr2);
          ctx.stroke();
        }
        ctx.fillStyle = '#2c302c';
        ctx.beginPath(); ctx.arc(0, 0, Math.max(1.5, z * 0.07), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      if (v.selectedUnits.includes(u.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(px, py - alt, z * 0.8, z * 0.4, 0, 0, Math.PI * 2); ctx.stroke();
      }
      this.healthBar(ctx, px, py - alt - z * 0.6, z * 0.9, u.hp / u.maxHp, v.selectedUnits.includes(u.id));
    }

    // ----- brouillard : image alpha 1 px/tuile projetée sur le plan du sol
    const _rf = prof.enabled ? performance.now() : 0;
    if (!revealAll) this.drawFog(g, ctx, proj);
    if (prof.enabled) prof.add('render.fog', performance.now() - _rf);

    // ----- builds en attente (feedback optimiste réseau) : fantôme « chantier »
    // affiché dès le clic, avant que le round réseau ne crée le vrai bâtiment.
    for (const pb of v.pendingBuilds) {
      const def = BUILDINGS[pb.type as keyof typeof BUILDINGS];
      if (!def) continue;
      const pulse = 0.28 + 0.14 * Math.sin(g.time * 5);
      proj.footprintPath(ctx, pb.tx, pb.ty, def.w, def.h);
      ctx.fillStyle = `rgba(231,196,74,${pulse})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(231,196,74,0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ----- fantôme de placement : losange d'emprise coloré (validation) +
    // aperçu translucide du bâtiment lui-même à l'endroit EXACT du clic.
    if (v.placing) {
      const def = BUILDINGS[v.placing as keyof typeof BUILDINGS];
      proj.footprintPath(ctx, v.placeTx, v.placeTy, def.w, def.h);
      ctx.fillStyle = v.placeValid ? 'rgba(80,220,120,0.32)' : 'rgba(230,70,60,0.36)';
      ctx.fill();
      ctx.strokeStyle = v.placeValid ? '#50dc78' : '#e6463c';
      ctx.lineWidth = 2;
      ctx.stroke();
      // quadrillage des tuiles de l'emprise (lecture de la grille en iso)
      ctx.strokeStyle = v.placeValid ? 'rgba(80,220,120,0.35)' : 'rgba(230,70,60,0.35)';
      ctx.lineWidth = 1;
      for (let i = 1; i < def.w; i++) {
        ctx.beginPath();
        ctx.moveTo(proj.sx(v.placeTx - 0.5 + i, v.placeTy - 0.5), proj.sy(v.placeTx - 0.5 + i, v.placeTy - 0.5));
        ctx.lineTo(proj.sx(v.placeTx - 0.5 + i, v.placeTy - 0.5 + def.h), proj.sy(v.placeTx - 0.5 + i, v.placeTy - 0.5 + def.h));
        ctx.stroke();
      }
      for (let j = 1; j < def.h; j++) {
        ctx.beginPath();
        ctx.moveTo(proj.sx(v.placeTx - 0.5, v.placeTy - 0.5 + j), proj.sy(v.placeTx - 0.5, v.placeTy - 0.5 + j));
        ctx.lineTo(proj.sx(v.placeTx - 0.5 + def.w, v.placeTy - 0.5 + j), proj.sy(v.placeTx - 0.5 + def.w, v.placeTy - 0.5 + j));
        ctx.stroke();
      }
      const spr = this.isoSprite(v.placing, this.pov);
      const s = z / ISO_S;
      const pc = proj.toScreen(v.placeTx - 0.5 + def.w / 2, v.placeTy - 0.5 + def.h / 2);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(spr.canvas, pc.x - spr.ax * s, pc.y - spr.ay * s, spr.canvas.width * s, spr.canvas.height * s);
      ctx.restore();
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

    // ----- étalonnage : vignettage + lumière zénithale PRÉ-CUITS (deux
    // dégradés plein écran par frame coûtaient cher) → un seul drawImage.
    if (!this.vignette || this.vignette.width !== W || this.vignette.height !== H) {
      this.vignette = document.createElement('canvas');
      this.vignette.width = W; this.vignette.height = H;
      const vc = this.vignette.getContext('2d')!;
      const vg = vc.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.42, W / 2, H * 0.5, Math.max(W, H) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(4,6,10,0.26)');
      vc.fillStyle = vg;
      vc.fillRect(0, 0, W, H);
      const tl = vc.createLinearGradient(0, 0, 0, H);
      tl.addColorStop(0, 'rgba(255,250,235,0.045)');
      tl.addColorStop(0.45, 'rgba(0,0,0,0)');
      vc.fillStyle = tl;
      vc.fillRect(0, 0, W, H);
    }
    ctx.drawImage(this.vignette, 0, 0);

    this.drawOrderMarkers(ctx, g, v, proj);
    this.drawCommandCursor(ctx, g, v);

    const _rm = prof.enabled ? performance.now() : 0;
    this.drawMinimap(g, v, dtFrame);
    if (prof.enabled) prof.add('render.minimap', performance.now() - _rm);
  }

  private drawOrderMarkers(
    ctx: CanvasRenderingContext2D, g: Game, v: ViewState, proj: Proj,
  ) {
    const z = proj.z;
    for (const m of v.orderMarkers) {
      const age = g.time - m.t;
      const f = Math.max(0, Math.min(1, age / 0.85));
      const px = proj.sx(m.x, m.y), py = proj.sy(m.x, m.y);
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
      ctx.ellipse(px, py, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.32 * (1 - f)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(px, py, Math.max(2, inner), Math.max(1, inner * 0.5), 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(${col},0.72)`;
      ctx.lineWidth = Math.max(1, z * 0.04);
      if (attack) {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + f * 0.7;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r * 0.38, py + Math.sin(a) * r * 0.38 * 0.5);
          ctx.lineTo(px + Math.cos(a) * r * 1.18, py + Math.sin(a) * r * 1.18 * 0.5);
          ctx.stroke();
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r * 0.7, py + Math.sin(a) * r * 0.7 * 0.5);
          ctx.lineTo(px + Math.cos(a) * r * 0.98, py + Math.sin(a) * r * 0.98 * 0.5);
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
          ctx.moveTo(px + Math.cos(a) * r * 0.22, py + Math.sin(a) * r * 0.22 * 0.5);
          ctx.lineTo(px + Math.cos(a) * r * 0.45, py + Math.sin(a) * r * 0.45 * 0.5);
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

  // ------------------------------------------- sol iso pré-projeté (chunks)
  //
  // Espace « iso-px » : U = (x−y)·S, V = (x+y)·S/2 (S = px par tuile du
  // palier). L'écran est U·(z/S) + ox — un simple zoom/translation → le
  // contenu d'un chunk ne dépend QUE de son index et du palier : cache parfait.
  // La Map SERT de LRU : l'ordre d'insertion est l'ordre de récence — un
  // accès replace la clé en fin (delete+set, O(1)), l'éviction retire la
  // première clé. Un chunk UTILISÉ reste donc toujours chaud : c'était la
  // cause des carrés noirs (chunks visibles évincés/re-cuits en boucle,
  // Safari peignant des canvas pas encore rasterisés).
  private isoChunks = new Map<string, HTMLCanvasElement | null>();
  private static readonly CHUNK = 256;
  private static readonly CHUNK_PAD = 4;

  private isoLod(z: number): number { return z < 16 ? 12 : z < 32 ? 24 : 48; }

  private isoChunk(g: Game, S: number, cu: number, cv: number): HTMLCanvasElement | null {
    const key = `${S}:${cu}:${cv}`;
    const hit = this.isoChunks.get(key);
    if (hit !== undefined) {
      this.isoChunks.delete(key);
      this.isoChunks.set(key, hit);
      return hit;
    }
    const C = Renderer.CHUNK, P = Renderer.CHUNK_PAD;
    // AABB monde couvert par le chunk (+ marge de padding)
    const u0 = (cu * C - P) / S, u1 = ((cu + 1) * C + P) / S;
    const v0 = ((cv * C - P) / S) * 2, v1 = (((cv + 1) * C + P) / S) * 2;   // v ici = x+y
    const wx0 = (v0 + u0) / 2 - 0.6, wx1 = (v1 + u1) / 2 + 0.6;
    const wy0 = (v0 - u1) / 2 - 0.6, wy1 = (v1 - u0) / 2 + 0.6;
    const { w, h } = g.map;
    let cvs: HTMLCanvasElement | null = null;
    if (wx1 > -0.5 && wy1 > -0.5 && wx0 < w - 0.5 && wy0 < h - 0.5) {
      cvs = document.createElement('canvas');
      cvs.width = cvs.height = C + P * 2;
      const c = cvs.getContext('2d')!;
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      // monde → chunk : X = S(x−y) − cu·C + P ; Y = S(x+y)/2 − cv·C + P
      // en px d'image terrain (ix = (x+0.5)·tpx) :
      const k = S / this.tpx;
      c.setTransform(k, k * 0.5, -k, k * 0.5, -cu * C + P, -cv * C + P - S * 0.5);
      const sx0 = Math.max(0, (wx0 + 0.5) * this.tpx), sy0 = Math.max(0, (wy0 + 0.5) * this.tpx);
      const sx1 = Math.min(this.terrain!.width, (wx1 + 0.5) * this.tpx);
      const sy1 = Math.min(this.terrain!.height, (wy1 + 0.5) * this.tpx);
      if (sx1 > sx0 && sy1 > sy0) c.drawImage(this.terrain!, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
      c.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.isoChunks.set(key, cvs);
    while (this.isoChunks.size > this.isoChunkCap) {
      const oldest = this.isoChunks.keys().next().value as string;
      this.isoChunks.delete(oldest);
    }
    return cvs;
  }

  private isoChunkCap = 240;

  /** Repli : blit affine direct du terrain, borné au rectangle écran donné
   *  (utilisé pour les chunks pas encore cuits — budget de cuisson/frame). */
  private drawGroundDirect(ctx: CanvasRenderingContext2D, proj: Proj, rx: number, ry: number, rw: number, rh: number) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    const t = proj.groundTransform(this.tpx, true);
    ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
    ctx.drawImage(this.terrain!, 0, 0);
    ctx.restore();
  }

  // Précuisson d'arrière-plan du palier grossier : quelques chunks par frame,
  // jusqu'à couvrir toute la carte → le dézoom ne bake plus rien en urgence.
  private prewarmDone = false;
  private prewarmNext = 0;
  private prewarmGround(g: Game) {
    if (this.prewarmDone) return;
    const S = 12, C = Renderer.CHUNK;
    const { w, h } = g.map;
    // bornes iso-px du monde entier au palier S
    const u0 = Math.floor((-(h + 1) * S) / C), u1 = Math.floor(((w + 1) * S) / C);
    const v0 = 0, v1 = Math.floor((((w + h) / 2 + 1) * S) / C);
    const cols = u1 - u0 + 1, total = cols * (v1 - v0 + 1);
    let done = 0;
    while (this.prewarmNext < total && done < 4) {
      const cu = u0 + (this.prewarmNext % cols);
      const cvi = v0 + Math.floor(this.prewarmNext / cols);
      this.prewarmNext++;
      const key = `${S}:${cu}:${cvi}`;
      if (!this.isoChunks.has(key)) { this.isoChunk(g, S, cu, cvi); done++; }
    }
    if (this.prewarmNext >= total) this.prewarmDone = true;
  }

  private drawIsoGround(ctx: CanvasRenderingContext2D, proj: Proj) {
    const g = this.lastGame!;
    const S = this.isoLod(proj.z);
    const k = proj.z / S;
    const C = Renderer.CHUNK, P = Renderer.CHUNK_PAD;
    // rectangle visible en iso-px : U = (screen − ox)/k
    const U0 = (0 - proj.ox) / k, U1 = (proj.W - proj.ox) / k;
    const V0 = (0 - proj.oy) / k, V1 = (proj.H - proj.oy) / k;
    const cu0 = Math.floor(U0 / C), cu1 = Math.floor(U1 / C);
    const cv0 = Math.floor(V0 / C), cv1 = Math.floor(V1 / C);
    // plafond dynamique : TOUJOURS assez grand pour tout le viewport (avec
    // marge ×3) — un cache plus petit que l'écran thrashait à chaque frame
    const visible = (cu1 - cu0 + 1) * (cv1 - cv0 + 1);
    // assez pour le palier grossier précuit complet + le palier courant,
    // sans excès (budget mémoire canvas de Safari iOS)
    this.isoChunkCap = Math.max(300, visible * 3);
    // budget de cuisson par frame : au changement de palier de zoom, on ne
    // re-cuit pas 100+ chunks dans la même frame (gel + artefacts Safari) —
    // les chunks manquants passent par le blit direct cette frame-là.
    let budget = 28;
    for (let cv = cv0; cv <= cv1; cv++) {
      for (let cu = cu0; cu <= cu1; cu++) {
        const key = `${S}:${cu}:${cv}`;
        let chunk = this.isoChunks.get(key);
        if (chunk === undefined) {
          if (budget > 0) {
            budget--;
            chunk = this.isoChunk(g, S, cu, cv);
          } else {
            this.drawGroundDirect(
              ctx, proj,
              proj.ox + cu * C * k, proj.oy + cv * C * k, C * k, C * k,
            );
            continue;
          }
        } else if (chunk) {
          // rafraîchit la position LRU des chunks réellement affichés
          this.isoChunk(g, S, cu, cv);
        }
        if (!chunk) continue;
        // recouvrement d'1 px source : sans lui, des interstices sub-pixel
        // entre chunks adjacents laissaient voir le fond → « traits noirs en
        // grille » à certains niveaux de zoom
        ctx.drawImage(
          chunk, P, P, C + 1, C + 1,
          proj.ox + cu * C * k, proj.oy + cv * C * k, (C + 1) * k, (C + 1) * k,
        );
      }
    }
  }

  // segments côtiers (eau ↔ terre) pour l'écume animée, précalculés
  private shore: { x: number; y: number; x1: number; y1: number; x2: number; y2: number; nx: number; ny: number; ph: number }[] | null = null;
  private buildShore(g: Game) {
    const { w, h, terrain } = g.map;
    const list: NonNullable<typeof this.shore> = [];
    const isLand = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < w && y < h && terrain[y * w + x] !== T_WATER;
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        if (terrain[ty * w + tx] !== T_WATER) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (!isLand(tx + dx, ty + dy)) continue;
          // arête partagée (tuiles centrées sur les entiers : bords à ±0.5)
          const ex = tx + dx * 0.5, ey = ty + dy * 0.5;
          list.push({
            x: tx, y: ty,
            x1: dx !== 0 ? ex : tx - 0.42, y1: dy !== 0 ? ey : ty - 0.42,
            x2: dx !== 0 ? ex : tx + 0.42, y2: dy !== 0 ? ey : ty + 0.42,
            nx: -dx, ny: -dy,               // normale vers l'eau (la vague recule)
            ph: (tx * 13 + ty * 7) % 6.28,
          });
        }
      }
    this.shore = list;
  }

  private fogScreen: HTMLCanvasElement | null = null;
  private fogScreenCtx: CanvasRenderingContext2D | null = null;
  private fogBuiltAt = -1;
  private drawFog(g: Game, ctx: CanvasRenderingContext2D, proj: Proj) {
    const { w, h } = g.map;
    if (!this.fogCanvas) {
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.width = w; this.fogCanvas.height = h;
      this.fogCtx = this.fogCanvas.getContext('2d')!;
      this.fogImg = this.fogCtx.createImageData(w, h);
      const d = this.fogImg.data;
      for (let i = 0; i < w * h; i++) { d[i * 4] = 8; d[i * 4 + 1] = 10; d[i * 4 + 2] = 14; }
    }
    // Le brouillard moteur n'évolue qu'à ~4 Hz : reconstruire l'image alpha à
    // chaque frame était le principal coût fixe du rendu (surtout mobile).
    if (this.fogBuiltAt < 0 || g.time - this.fogBuiltAt >= 0.12 || g.time < this.fogBuiltAt) {
      this.fogBuiltAt = g.time;
      const fog = g.players[this.pov].fog;
      const d = this.fogImg!.data;
      for (let i = 0; i < w * h; i++) {
        d[i * 4 + 3] = fog[i] === 2 ? 0 : fog[i] === 1 ? 118 : 255;
      }
      this.fogCtx!.putImageData(this.fogImg!, 0, 0);
    }
    // Projection affine sur le plan du sol — composée en DEMI-RÉSOLUTION
    // (le brouillard est flou par nature ; le coût de remplissage est ÷4,
    // décisif sur Safari/mobile), puis un seul agrandissement axis-aligned.
    const hw = Math.ceil(proj.W / 2), hh = Math.ceil(proj.H / 2);
    if (!this.fogScreen || this.fogScreen.width !== hw || this.fogScreen.height !== hh) {
      this.fogScreen = document.createElement('canvas');
      this.fogScreen.width = hw; this.fogScreen.height = hh;
      this.fogScreenCtx = this.fogScreen.getContext('2d')!;
    }
    const fc = this.fogScreenCtx!;
    fc.setTransform(1, 0, 0, 1, 0, 0);
    fc.clearRect(0, 0, hw, hh);
    const t = proj.groundTransform(1, true);
    fc.setTransform(t[0] / 2, t[1] / 2, t[2] / 2, t[3] / 2, t[4] / 2, t[5] / 2);
    fc.imageSmoothingEnabled = true;
    const M = 600; // marge « hors monde » en tuiles (couvre tout viewport raisonnable)
    fc.fillStyle = 'rgba(8,10,14,0.9)';
    fc.fillRect(-M, -M, w + 2 * M, M);        // bande nord
    fc.fillRect(-M, h, w + 2 * M, M);         // bande sud
    fc.fillRect(-M, 0, M, h);                 // bande ouest
    fc.fillRect(w, 0, M, h);                  // bande est
    fc.drawImage(this.fogCanvas, 0, 0, w, h, 0, 0, w, h);
    fc.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogScreen, 0, 0, hw, hh, 0, 0, proj.W, proj.H);
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

  // suivi visuel du chantier : flash d'activation à l'achèvement
  private builtFlash = new Map<number, number>();
  private constructing = new Set<number>();

  // sprites iso pré-cuits, par (type, équipe)
  private isoSpriteCache = new Map<string, IsoBuildingSprite>();
  private isoSprite(type: string, owner: number): IsoBuildingSprite {
    const key = `b:${type}:${owner}`;
    let s = this.isoSpriteCache.get(key);
    if (!s) {
      s = bakeIsoBuilding(type as keyof typeof BUILDINGS, PLAYER_COLORS[owner]);
      this.isoSpriteCache.set(key, s);
    }
    return s;
  }

  /** Canvas du sprite (icônes du menu de construction, aperçus). */
  private buildingSprite(type: string, owner: number): HTMLCanvasElement {
    return this.isoSprite(type, owner).canvas;
  }

  // -------------------------------------------- halo de sol travaillé
  //
  // Pour que le bâtiment ne paraisse plus « posé » sur une texture, on dessine
  // SOUS lui une zone de terrain remué qui l'épouse : terre tassée irrégulière
  // (jamais un rectangle), poussière, traces de circulation, et surtout une
  // bande d'occlusion sombre qui hugge le pied du bâtiment (le contact mur/sol
  // qui donne le poids et l'ancrage). Le terrain « remonte » vers le bâtiment
  // au lieu de s'arrêter net. Cuit une fois par type, en niveaux d'alpha
  // (translucide) pour laisser transparaître le biome dessous → cohérent
  // partout (herbe, roche, neige) sans plaque visible.
  private groundDecalCache = new Map<string, HTMLCanvasElement>();
  private groundDecal(type: string): HTMLCanvasElement {
    let cv = this.groundDecalCache.get(type);
    if (cv) return cv;
    const B = 44;
    const def = BUILDINGS[type as keyof typeof BUILDINGS];
    const fw = def.w * B, fh = def.h * B;       // emprise au sol en px
    const M = B * 0.95;                          // débord fondu autour de l'emprise
    cv = document.createElement('canvas');
    cv.width = Math.ceil(fw + M * 2);
    cv.height = Math.ceil(fh + M * 2);
    const c = cv.getContext('2d')!;
    c.translate(cv.width / 2, cv.height / 2);
    const rng = mulberry32(type.length * 131 + 7);

    // rayons de base de l'aire travaillée (ellipse inscrite + débord)
    const rx = fw / 2 + M * 0.62, ry = fh / 2 + M * 0.62;
    // contour irrégulier : ellipse perturbée par bruit → aucun bord droit
    const N = 40;
    const noiseR: number[] = [];
    for (let i = 0; i < N; i++) noiseR.push(0.82 + rng() * 0.34);
    // lissage du bruit pour éviter les pics anguleux
    const smooth = noiseR.map((_, i) =>
      (noiseR[(i - 1 + N) % N] + noiseR[i] * 2 + noiseR[(i + 1) % N]) / 4);
    const path = () => {
      c.beginPath();
      for (let i = 0; i <= N; i++) {
        const a = (i % N) / N * Math.PI * 2;
        const k = smooth[i % N];
        const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
    };

    // 1) lavis de terre remuée + bande de contact sombre près du pied.
    c.save();
    path(); c.clip();
    const g = c.createRadialGradient(0, 0, Math.min(rx, ry) * 0.2, 0, 0, Math.max(rx, ry));
    g.addColorStop(0, 'rgba(58,50,38,0.34)');     // sous le bâtiment : terre tassée
    g.addColorStop(0.52, 'rgba(40,33,24,0.52)');  // contact/ombre au pied : poids
    g.addColorStop(0.78, 'rgba(64,56,42,0.30)');
    g.addColorStop(1, 'rgba(74,66,50,0)');         // se fond dans le terrain
    c.fillStyle = g;
    c.fillRect(-cv.width / 2, -cv.height / 2, cv.width, cv.height);

    // 2) poussière / terre claire mouchetée, plus dense vers les bords usés
    for (let i = 0; i < 90; i++) {
      const a = rng() * Math.PI * 2, rr = Math.sqrt(rng());
      const x = Math.cos(a) * rx * rr, y = Math.sin(a) * ry * rr;
      const sz = 1 + rng() * 2.4;
      const light = rng() > 0.5;
      c.fillStyle = light
        ? `rgba(122,108,84,${0.05 + rng() * 0.10})`
        : `rgba(28,22,15,${0.06 + rng() * 0.12})`;
      c.beginPath(); c.ellipse(x, y, sz, sz * 0.7, 0, 0, Math.PI * 2); c.fill();
    }

    // 3) traces de circulation : ornières estompées partant du pied vers le sud
    //    (côté façade/sortie d'unités) → on devine l'usage du site.
    c.strokeStyle = 'rgba(30,24,16,0.16)';
    c.lineWidth = B * 0.16;
    c.lineCap = 'round';
    for (let t = 0; t < 2; t++) {
      const ox = (t === 0 ? -1 : 1) * fw * 0.16;
      c.beginPath();
      c.moveTo(ox, fh * 0.1);
      c.bezierCurveTo(ox + (rng() - 0.5) * 20, fh * 0.4, ox + (rng() - 0.5) * 28, ry * 0.7, ox * 1.4 + (rng() - 0.5) * 30, ry * 1.02);
      c.stroke();
    }
    c.restore();

    this.groundDecalCache.set(type, cv);
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

  private steam(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, time: number, scale: number, alpha = 0.17) {
    for (let k = 0; k < 3; k++) {
      const t = (time * 0.3 + k / 3) % 1;
      ctx.fillStyle = `rgba(228,232,234,${alpha * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(
        x + Math.sin((time + k * 2.1) * 1.7) * z * 0.06 + t * z * 0.12,
        y - t * z * scale * 1.5,
        z * scale * (0.28 + t * 0.55), 0, Math.PI * 2,
      );
      ctx.fill();
    }
  }

  // ---- flamme de torchère animée : langue de feu effilée + halo discret
  private flame(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, time: number, s: number) {
    const fl = 0.7 + 0.3 * Math.sin(time * 13) * Math.sin(time * 7.7);
    const h = z * s * (0.5 + 0.22 * fl);          // hauteur de la langue
    const w = z * s * 0.13;                        // demi-largeur à la base
    const sway = Math.sin(time * 9.3) * w * 0.6;   // ondulation du sommet
    // halo chaud très léger (sprite pré-cuit : pas de gradient par frame)
    ctx.save();
    ctx.globalAlpha = 0.42 * fl;
    ctx.drawImage(this.warmGlow(), x - h * 0.9, y - h * 0.35 - h * 0.9, h * 1.8, h * 1.8);
    ctx.restore();
    // langue orange
    ctx.fillStyle = `rgba(255,140,50,${0.75 * fl})`;
    ctx.beginPath();
    ctx.moveTo(x - w, y);
    ctx.quadraticCurveTo(x - w * 0.7, y - h * 0.55, x + sway, y - h);
    ctx.quadraticCurveTo(x + w * 0.8, y - h * 0.5, x + w, y);
    ctx.closePath(); ctx.fill();
    // cœur jaune
    ctx.fillStyle = `rgba(255,220,110,${0.85 * fl})`;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.45, y);
    ctx.quadraticCurveTo(x - w * 0.3, y - h * 0.4, x + sway * 0.6, y - h * 0.62);
    ctx.quadraticCurveTo(x + w * 0.4, y - h * 0.35, x + w * 0.45, y);
    ctx.closePath(); ctx.fill();
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

  private lastGame: Game | null = null;
  private vignette: HTMLCanvasElement | null = null;
  // suivi de position par unité : détection du mouvement RÉEL (animations)
  private lastPos = new Map<number, { x: number; y: number; mu: number }>();

  // halo chaud générique (portes, flammes) : cuit une fois, teinte baked
  private warmGlowCv: HTMLCanvasElement | null = null;
  private warmGlow(): HTMLCanvasElement {
    if (this.warmGlowCv) return this.warmGlowCv;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d')!;
    const gr = c.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,205,125,0.5)');
    gr.addColorStop(0.55, 'rgba(255,165,80,0.22)');
    gr.addColorStop(1, 'rgba(255,150,60,0)');
    c.fillStyle = gr;
    c.fillRect(0, 0, 64, 64);
    this.warmGlowCv = cv;
    return cv;
  }

  // blob d'ombre radial générique, cuit une fois puis étiré à la demande
  private shadowBlobCv: HTMLCanvasElement | null = null;
  private shadowBlob(): HTMLCanvasElement {
    if (this.shadowBlobCv) return this.shadowBlobCv;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d')!;
    const gr = c.createRadialGradient(32, 32, 8, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.34)');
    gr.addColorStop(0.7, 'rgba(0,0,0,0.2)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = gr;
    c.fillRect(0, 0, 64, 64);
    this.shadowBlobCv = cv;
    return cv;
  }

  // ------------------------------------------ infanterie : billboards debout
  //
  // Un fantassin vu de dessus puis aplati au sol était un simple point ; en
  // vue RTS 2.5D l'infanterie doit être DEBOUT. Chaque type a une silhouette
  // procédurale distincte (casque, arme, équipement), cuite une fois par
  // équipe, orientée vers l'est (miroir horizontal pour l'ouest au runtime).
  // Poses : 'idle' (arme basse, au repos), 'w0'-'w3' (cycle de marche 4 temps,
  // jambes et bras articulés), 'fire' (arme épaulée, jambes campées).
  private infantryCache = new Map<string, HTMLCanvasElement>();
  private infantrySprite(type: string, owner: number, pose: string): HTMLCanvasElement {
    const key = `inf:${type}:${owner}:${pose}`;
    let cv = this.infantryCache.get(key);
    if (!cv) {
      cv = this.finishSprite(this.bakeInfantry(type, PLAYER_COLORS[owner], pose));
      this.infantryCache.set(key, cv);
    }
    return cv;
  }

  private bakeInfantry(type: string, team: string, pose: string): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = 34; cv.height = 44;
    const c = cv.getContext('2d')!;
    const cx = 15;                        // axe du corps (le canon dépasse à droite)
    const uniform = type === 'spy' ? '#8d8776' : type === 'elite' ? '#3a3f3c' : '#575e49';
    const uniformD = shade(uniform, -0.3);
    const helmet = type === 'engineer' ? '#d8a935' : type === 'elite' ? '#2c3130' : type === 'spy' ? '#6d6553' : '#49503f';
    const skin = '#c9a179';
    const o = (f: () => void) => { c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 1; f(); };

    // ---- SQUELETTE : phase de marche → jambes/bras articulés (le cœur de
    // l'animation : plus de blocs rigides, de vraies foulées)
    const wi = pose === 'w0' ? 0 : pose === 'w1' ? 1 : pose === 'w2' ? 2 : pose === 'w3' ? 3 : -1;
    // cycle 4 temps : contact (jambes écartées) → passage (jambe levée) →
    // contact miroir → passage miroir
    const stride = wi === 0 ? 1 : wi === 2 ? -1 : 0;
    const lift = wi === 1 || wi === 3 ? 1 : 0;
    const lean = wi >= 0 ? 1.4 : pose === 'fire' ? 0.8 : 0;   // buste penché en mouvement
    const hipY = 26, footY = 40;
    const leg = (sw: number, lf: number, near: boolean) => {
      // hanche → genou → pied, genou plié selon la levée
      const hx = cx + (near ? 1.4 : -1.4) + lean * 0.4;
      const fx2 = cx + sw * 6.2 + lean;
      const fy2 = footY - lf * 3.2;
      const kx = (hx + fx2) / 2 + 2.2 * lf + 0.8;
      const ky = (hipY + fy2) / 2 - 0.6;
      c.strokeStyle = near ? uniformD : shade(uniformD, -0.22);
      c.lineCap = 'round';
      c.lineWidth = 4.4;
      c.beginPath(); c.moveTo(hx, hipY); c.lineTo(kx, ky); c.stroke();
      c.lineWidth = 3.6;
      c.beginPath(); c.moveTo(kx, ky); c.lineTo(fx2, fy2); c.stroke();
      // ranger
      c.fillStyle = near ? '#23261f' : '#191c16';
      c.beginPath(); c.ellipse(fx2 + 1.6, fy2 + 0.6, 3.4, 1.9, 0, 0, Math.PI * 2); c.fill();
    };
    if (pose === 'fire') {
      leg(-0.55, 0, false);           // jambe arrière ancrée
      leg(0.72, 0, true);             // jambe avant fléchie (position de tir)
    } else if (wi >= 0) {
      leg(-stride, wi === 1 || wi === 3 ? 0 : lift, false);  // jambe opposée
      leg(stride, wi === 1 || wi === 3 ? lift : 0, true);
    } else {
      leg(-0.14, 0, false);
      leg(0.14, 0, true);
    }
    void lean;
    // torse (veste) + éclairage NO
    c.fillStyle = uniform;
    c.beginPath();
    c.moveTo(cx - 6, 14); c.lineTo(cx + 6, 14); c.lineTo(cx + 5, 28); c.lineTo(cx - 5, 28);
    c.closePath(); c.fill();
    o(() => c.stroke());
    c.fillStyle = 'rgba(255,250,230,0.18)';
    c.fillRect(cx - 5, 15, 3, 11);
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(cx + 2, 15, 3, 12);
    // brassard/plastron couleur d'équipe (identification immédiate)
    c.fillStyle = team;
    c.fillRect(cx - 6, 16, 12, 3);
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(cx - 6, 18, 12, 1);
    // bras droit (vers l'arme)
    c.fillStyle = uniform;
    c.fillRect(cx + 3, 17, 7, 3.5);
    // tête + casque
    c.fillStyle = skin;
    c.beginPath(); c.arc(cx, 10, 4.4, 0, Math.PI * 2); c.fill();
    c.fillStyle = helmet;
    if (type === 'elite') {
      // béret incliné
      c.beginPath(); c.ellipse(cx - 0.5, 6.6, 5.4, 3, -0.18, 0, Math.PI * 2); c.fill();
      c.fillStyle = shade(team, -0.1); c.fillRect(cx + 2.5, 5.5, 3, 2);
    } else if (type === 'spy') {
      // chapeau à bord
      c.beginPath(); c.ellipse(cx, 7.6, 6.4, 2.1, 0, 0, Math.PI * 2); c.fill();
      c.fillRect(cx - 4, 3.4, 8, 4.5);
    } else {
      c.beginPath(); c.arc(cx, 8.6, 5.2, Math.PI * 0.95, Math.PI * 2.05); c.fill();
      c.fillRect(cx - 5.2, 8, 10.4, 2.4);
      c.fillStyle = 'rgba(255,250,230,0.28)';
      c.beginPath(); c.arc(cx - 1.4, 7.2, 4, Math.PI, Math.PI * 1.55); c.stroke();
    }
    // équipement par type — l'angle de l'arme suit la pose : baissée au repos,
    // en joue au tir (avec léger recul), portée en marche
    const aim = pose === 'fire' ? -0.02 : pose === 'idle' ? 0.36 : -0.08;
    const recoil = pose === 'fire' ? -1.4 : 0;
    c.fillStyle = '#2f332c';
    if (type === 'bazooka' || type === 'rocketeer') {
      // tube sur l'épaule
      c.save();
      c.translate(cx + 1 + recoil, 13);
      c.rotate(pose === 'fire' ? -0.34 : -0.22);
      c.fillStyle = type === 'rocketeer' ? '#3c4440' : '#4a4438';
      c.fillRect(-7, -2.6, 20, 5.2);
      c.fillStyle = '#1d201c';
      c.fillRect(11, -3.2, 3.4, 6.4);
      c.fillStyle = shade(team, -0.15);
      c.fillRect(2, -2.6, 2.4, 5.2);
      c.restore();
      if (type === 'rocketeer') {           // rack dorsal de roquettes
        c.fillStyle = '#333a35';
        c.fillRect(cx - 9, 15, 4, 10);
        c.fillStyle = '#b8912f';
        c.fillRect(cx - 8.4, 16, 2.6, 2); c.fillRect(cx - 8.4, 19, 2.6, 2); c.fillRect(cx - 8.4, 22, 2.6, 2);
      }
    } else if (type === 'sniper') {
      c.save();
      c.translate(cx + 2 + recoil, 19);
      c.rotate(aim - 0.04);
      c.fillStyle = '#3c3a30';
      c.fillRect(-4, -1.1, 19, 2.2);        // long canon
      c.fillStyle = '#20241f';
      c.fillRect(3, -2.8, 4, 2);            // lunette
      c.restore();
    } else if (type === 'engineer') {
      c.fillStyle = '#7a4e26';               // mallette à outils
      c.fillRect(cx + 6, 24, 7, 6);
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.strokeRect(cx + 6, 24, 7, 6);
      c.fillStyle = '#d8a935';
      c.fillRect(cx + 8, 23, 3, 1.6);
    } else if (type === 'kamikaze') {
      // gilet de charges + détonateur (danger lisible)
      c.fillStyle = '#5d2721';
      c.fillRect(cx - 5, 19, 10, 7);
      c.fillStyle = '#c8372d';
      c.fillRect(cx - 4, 20, 2.6, 5); c.fillRect(cx - 0.8, 20, 2.6, 5); c.fillRect(cx + 2.4, 20, 2.6, 5);
      c.strokeStyle = '#1c1c1c';
      c.beginPath(); c.moveTo(cx + 5, 22); c.quadraticCurveTo(cx + 9, 20, cx + 8, 16); c.stroke();
    } else if (type === 'spy') {
      // manteau long
      c.fillStyle = shade('#8d8776', -0.12);
      c.beginPath();
      c.moveTo(cx - 6, 18); c.lineTo(cx + 6, 18); c.lineTo(cx + 7, 34); c.lineTo(cx - 7, 34);
      c.closePath(); c.fill();
      o(() => c.stroke());
    } else {
      // fusil d'assaut standard
      c.save();
      c.translate(cx + 2 + recoil, 19.5);
      c.rotate(aim);
      c.fillStyle = '#41453a';
      c.fillRect(-5, -1.4, 14, 2.8);
      c.fillStyle = '#6d5230';
      c.fillRect(-6.5, -1.2, 3, 3.4);       // crosse bois
      c.fillStyle = '#23261f';
      c.fillRect(3, 1, 2.2, 3.4);           // chargeur
      c.restore();
    }
    // liseré global léger (détache du fond)
    c.globalCompositeOperation = 'destination-over';
    c.fillStyle = 'rgba(0,0,0,0.001)';
    c.fillRect(0, 0, cv.width, cv.height);
    c.globalCompositeOperation = 'source-over';
    return cv;
  }

  // copie assombrie d'un sprite : sert de « flanc » pour l'extrusion 2.5D
  private darkenSprite(src: HTMLCanvasElement): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = src.width; cv.height = src.height;
    const c = cv.getContext('2d')!;
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'source-atop';
    // flanc à peine plus sombre que le toit : l'extrusion doit se lire sans
    // transformer le véhicule en silhouette noire
    c.fillStyle = 'rgba(12,15,20,0.34)';
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
      // sprites BRUTS vue de dessus : la finition (contour, soleil) est
      // appliquée par isoUnitDir APRÈS aplatissement, par direction — la
      // lumière reste ainsi fixe à l'écran quand l'unité tourne.
      // Véhicules et aéronefs : NOUVELLE bakery (vehicles.ts, refonte 100 %).
      const baked = bakeVehicle(type as keyof typeof UNITS, PLAYER_COLORS[owner])
        ?? this.bakeUnit(type, PLAYER_COLORS[owner]);
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

  // ---------------------- sprites d'unités PRÉ-PROJETÉS par direction (24)
  //
  // Pour chaque (type, équipe, cap) : le sprite vue-de-dessus est aplati sur
  // le plan iso, EXTRUDÉ (flancs empilés), détouré et éclairé par un soleil
  // NORD-OUEST fixe à l'écran. Résultat : vraie silhouette 2.5D, éclairage
  // cohérent quelle que soit l'orientation, et UN SEUL drawImage par unité
  // par frame (au lieu de 5-7 dessins transformés). Cuisson paresseuse par
  // direction (pas d'avalanche de bake).
  private static readonly NDIR = 24;
  private isoUnitCache = new Map<string, { cv: HTMLCanvasElement; ax: number; ay: number }>();

  static dirIndex(dir: number): number {
    const n = Renderer.NDIR;
    return ((Math.round((dir / (Math.PI * 2)) * n) % n) + n) % n;
  }

  private isoUnitDir(
    type: string, owner: number, di: number,
    part: 'body' | 'turret', hullPx: number, tint?: string,
  ): { cv: HTMLCanvasElement; ax: number; ay: number } | null {
    const key = `${type}:${owner}:${part}:${di}:${Math.round(hullPx)}`;
    const hit = this.isoUnitCache.get(key);
    if (hit) return hit;
    const spr = this.unitSprites(type, owner);
    const src = part === 'body' ? spr.body : spr.turret;
    const sideSrc = part === 'body' ? spr.side : spr.turretSide;
    if (!src || !sideSrc) return null;
    const th = (di / Renderer.NDIR) * Math.PI * 2;
    // Encombrement ÉCRAN exact du sprite aplati : sous [[1,0.5],[−1,0.5]], un
    // point à distance r s'étend jusqu'à ±1.415·r en X et ±0.708·r en Y.
    // Les anciennes marges tronquaient les véhicules selon leur cap.
    const rad = Math.hypot(src.width, src.height) / 2;
    const W2 = Math.ceil(rad * 2 * 1.415 + 8);
    const H2 = Math.ceil(rad * 2 * 0.708 + hullPx + 10);
    const cv = document.createElement('canvas');
    cv.width = W2; cv.height = H2;
    const c = cv.getContext('2d')!;
    const ax = W2 / 2, ay = Math.ceil(H2 - rad * 0.708 - 4);   // ancre = centre au sol
    const put = (img: HTMLCanvasElement, lift: number) => {
      c.save();
      c.translate(ax, ay - lift);
      c.transform(1, 0.5, -1, 0.5, 0, 0);
      c.rotate(th);
      c.drawImage(img, -img.width / 2, -img.height / 2);
      c.restore();
    };
    const steps = Math.max(2, Math.round(hullPx / 1.6));
    for (let k = 0; k < steps; k++) put(sideSrc, (hullPx * k) / steps);
    put(src, hullPx);
    // teinte de famille (différencie visuellement les classes de véhicules)
    if (tint) {
      c.save();
      c.globalCompositeOperation = 'source-atop';
      c.globalAlpha = 0.13;
      c.fillStyle = tint;
      c.fillRect(0, 0, W2, H2);
      c.restore();
    }
    const done = { cv: this.finishSprite(cv), ax, ay };
    this.isoUnitCache.set(key, done);
    if (this.isoUnitCache.size > 4000) this.isoUnitCache.clear();   // garde-fou mémoire
    return done;
  }

  // Finition commune des sprites d'unités : CONTOUR sombre net (détache
  // l'unité du terrain, style RA2) + passe de SOLEIL nord-ouest (toit éclairé
  // côté NO, ombré côté SE) → volume et lisibilité, cuits une seule fois.
  private finishSprite(src: HTMLCanvasElement): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const c = out.getContext('2d')!;
    // silhouette noire
    const sil = document.createElement('canvas');
    sil.width = src.width; sil.height = src.height;
    const sc = sil.getContext('2d')!;
    sc.drawImage(src, 0, 0);
    sc.globalCompositeOperation = 'source-in';
    sc.fillStyle = 'rgba(8,10,8,0.85)';
    sc.fillRect(0, 0, sil.width, sil.height);
    // contour : silhouette décalée dans 4 directions
    const o = Math.max(1, Math.round(SPX * 0.028));
    for (const [dx, dy] of [[o, 0], [-o, 0], [0, o], [0, -o]] as const) {
      c.drawImage(sil, dx, dy);
    }
    c.drawImage(src, 0, 0);
    // soleil NO : éclaire le quadrant haut-gauche, assombrit le bas-droit
    c.save();
    c.globalCompositeOperation = 'source-atop';
    const g2 = c.createLinearGradient(0, 0, out.width, out.height);
    g2.addColorStop(0, 'rgba(255,248,222,0.30)');
    g2.addColorStop(0.48, 'rgba(255,248,222,0)');
    g2.addColorStop(0.66, 'rgba(0,0,0,0)');
    g2.addColorStop(1, 'rgba(0,0,0,0.20)');
    c.fillStyle = g2;
    c.fillRect(0, 0, out.width, out.height);
    c.restore();
    return out;
  }

  private newSprite(tiles: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(tiles * SPX);
    const c = cv.getContext('2d')!;
    c.translate(cv.width / 2, cv.height / 2);
    return [cv, c];
  }

  private unitVisualScale(type: string, def: { armor: string; isAir?: boolean }) {
    // Échelle VISUELLE cohérente avec les bâtiments iso (hitbox/gameplay
    // inchangés). Les anciens ×1.22-1.32 hérités de la vue top-down
    // faisaient paraître les véhicules énormes à côté des bâtiments.
    if (def.armor === 'inf') return 1.0;
    if (def.isAir) return type === 'cargoheli' || type === 'transportheli' ? 1.1 : 1.06;
    if (type === 'harvester' || type === 'mobilecmd') return 1.16;
    if (type === 'heavytank' || type === 'heavyarty' || type === 'tankdestroyer') return 1.12;
    if (type === 'artillery' || type === 'tank') return 1.08;
    return 1.04;
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
      industrialFinish(c, -r * 1.35, -r * 1.35, r * 2.7, r * 2.7, type.length * 19, 0.55, false);
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
      industrialFinish(c, -Tz * 0.78, -Tz * 0.56, Tz * 1.56, Tz * 1.12, type.length * 29, 0.75, false);
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
    industrialFinish(c, -T * 1.35, -T * 1.1, T * 2.7, T * 2.2, seed, 0.95, false);
    if (turretCv) {
      const tc = turretCv.getContext('2d')!;
      industrialFinish(tc, -T * 1.1, -T * 1.1, T * 2.2, T * 2.2, seed + 17, 0.85, false);
    }
    return { body: cv, turret: turretCv };
  }

  // Rendu d'une unité en iso : le sprite vue-de-dessus est COUCHÉ sur le plan
  // du sol par la même transformation affine que le terrain (géométriquement
  // exact pour un véhicule plat), la rotation reste en angle MONDE. Ombre,
  // anneaux de sélection et marqueurs sont des ellipses au sol ; la barre de
  // vie reste un billboard écran.
  private drawUnitSprite(
    ctx: CanvasRenderingContext2D, g: Game, u: Unit,
    proj: Proj, selected: boolean,
    ox?: number, oy?: number,  // position visuelle alternative (sortie de bâtiment)
  ) {
    const def = UNITS[u.type];
    const z = proj.z;
    const wx = ox ?? u.x, wy = oy ?? u.y;
    const px = proj.sx(wx, wy);
    // Ancrage au relief visuel : décaler l'unité vers le haut selon la hauteur
    // du terrain sous elle — évite l'effet "glisse au-dessus" sur terrain élevé.
    const mH = g.map.height, mW = g.map.w, mHt = g.map.h;
    const clampMx = (v: number) => Math.max(0, Math.min(mW - 1, v | 0));
    const clampMy = (v: number) => Math.max(0, Math.min(mHt - 1, v | 0));
    const tx0h = clampMx(Math.floor(wx)), ty0h = clampMy(Math.floor(wy));
    const fxH = wx - Math.floor(wx), fyH = wy - Math.floor(wy);
    const terrH = (mH[ty0h * mW + tx0h] ?? 0.46) * (1 - fxH) * (1 - fyH)
                + (mH[ty0h * mW + clampMx(tx0h + 1)] ?? 0.46) * fxH * (1 - fyH)
                + (mH[clampMy(ty0h + 1) * mW + tx0h] ?? 0.46) * (1 - fxH) * fyH
                + (mH[clampMy(ty0h + 1) * mW + clampMx(tx0h + 1)] ?? 0.46) * fxH * fyH;
    // Décalage positif seulement (terrain en hauteur lève l'unité, creux imperceptible)
    const groundLift = Math.max(0, terrH - 0.44) * z * 0.38;
    const py = proj.sy(wx, wy) - groundLift;
    const col = PLAYER_COLORS[u.owner];
    const spr = this.unitSprites(u.type, u.owner);
    const visualScale = this.unitVisualScale(u.type, def);

    if (selected) {
      const rr0 = (def.radius + 0.42) * z;
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.beginPath(); ctx.ellipse(px, py, rr0 * 1.2, rr0 * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      const rr1 = (def.radius + 0.32) * z;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(3, z * 0.14);
      ctx.beginPath(); ctx.ellipse(px, py, rr1 * 1.2, rr1 * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(2, z * 0.1);
      ctx.beginPath(); ctx.ellipse(px, py, rr1 * 1.18, rr1 * 0.59, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(px, py, rr1 * 1.18, rr1 * 0.59, 0, 0, Math.PI * 2); ctx.stroke();
    }

    // ----- ombre de contact : ellipse plate DURE (ancrage net au sol) + halo doux
    {
      const inf = def.armor === 'inf';
      const rad = (inf ? def.radius * 0.95 : def.radius * 1.20 * visualScale) * z;
      const shx = px + z * 0.14, shy = py + z * 0.09;
      // ellipse de contact : sombre, définie, clairement au sol
      ctx.fillStyle = 'rgba(0,0,0,0.36)';
      ctx.beginPath(); ctx.ellipse(shx, shy, rad * 1.05, rad * 0.52, 0, 0, Math.PI * 2); ctx.fill();
      // halo diffus autour (profondeur, lumière rasante)
      const blob = this.shadowBlob();
      ctx.drawImage(blob, shx - rad * 1.55, shy - rad * 0.78, rad * 3.1, rad * 1.56);
    }

    // ----- infanterie : BILLBOARD DEBOUT ANIMÉ — cycle de marche articulé
    // (4 frames jambes/bras), pose de tir épaulée, repos arme basse. Le
    // mouvement est détecté sur la POSITION réelle (pas l'ordre) : un soldat
    // qui glisse sans bouger les jambes est banni.
    if (def.armor === 'inf') {
      const lp = this.lastPos.get(u.id);
      const movedNow = lp ? Math.hypot(u.x - lp.x, u.y - lp.y) > 0.004 : false;
      // hystérésis courte : évite le clignotement marche/repos aux micro-pauses
      const mv = this.lastPos.get(u.id);
      const movingUntil = movedNow ? g.time + 0.16 : (mv?.mu ?? 0);
      this.lastPos.set(u.id, { x: u.x, y: u.y, mu: movingUntil });
      const walking = g.time < movingUntil;
      const wdefI = def.weapon;
      const firing = !!(wdefI && u.engageId && u.cd > 0 && wdefI.cooldown - u.cd < 0.24);
      const pose = firing ? 'fire'
        : walking ? `w${Math.floor(((g.time * 7.5 + u.id * 0.63) % 1) * 4)}`
        : 'idle';
      const inf = this.infantrySprite(u.type, u.owner, pose);
      const hPx = z * 0.72 * visualScale;
      const s2 = hPx / 44;                                  // bake = 44 px de haut
      // respiration/houle légère au repos, à peine perceptible
      const sway = pose === 'idle' ? Math.sin(g.time * 1.8 + u.id) * 0.5 * s2 : 0;
      const flip = Math.cos(u.dir) < -0.05 ? -1 : 1;        // regarde vers l'ouest → miroir
      ctx.save();
      ctx.translate(px, py + sway);
      ctx.scale(flip * s2, s2);
      ctx.drawImage(inf, -inf.width / 2, -inf.height + 3);
      ctx.restore();
      // départ de coup : flash au bout de l'arme
      if (firing && wdefI && wdefI.cooldown - u.cd < 0.09) {
        const mx2 = px + flip * z * 0.34, my2 = py - hPx * 0.55;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.drawImage(this.warmGlow(), mx2 - z * 0.16, my2 - z * 0.16, z * 0.32, z * 0.32);
        ctx.restore();
      }
      if (selected || u.hp < u.maxHp) {
        this.healthBar(ctx, px, py - hPx - z * 0.18, Math.max(12, def.radius * 2.2 * z), u.hp / u.maxHp, selected);
      }
      return;
    }

    // ----- coque : SPRITE DIRECTIONNEL pré-cuit (extrusion + contour + soleil
    // écran FIXES) — un seul drawImage, silhouette et éclairage stables quelle
    // que soit l'orientation du véhicule.
    const hullH = u.type === 'harvester' ? 0.3
      : def.isAir ? 0.14
      : def.armor === 'heavy' ? 0.24
      : u.type === 'artillery' || u.type === 'heavyarty' || u.type === 'tankdestroyer' ? 0.2
      : 0.15;
    const hullBake = hullH * SPX * ISO_ELEV;
    const hullPx = hullH * z * ISO_ELEV * visualScale;
    // teinte de famille : lourds gris-vert froid, récolteur/soutien sable,
    // artillerie kaki — les classes se distinguent au premier coup d'œil
    const tint = def.armor === 'heavy' ? '#4c5a66'
      : u.type === 'harvester' || u.type === 'mobilecmd' ? '#a08a52'
      : u.type === 'artillery' || u.type === 'heavyarty' ? '#6b6d4f'
      : undefined;
    const sD = (z / SPX) * visualScale;
    const bodyD = this.isoUnitDir(u.type, u.owner, Renderer.dirIndex(u.dir), 'body', hullBake, tint);
    if (bodyD) {
      ctx.drawImage(bodyD.cv, px - bodyD.ax * sD, py - bodyD.ay * sD, bodyD.cv.width * sD, bodyD.cv.height * sD);
    }
    if (u.type === 'harvester' && u.cargo > 1) {
      // benne de minerai : dessinée dans le repère sol du véhicule (sur le toit)
      ctx.save();
      ctx.translate(px, py - hullPx);
      ctx.transform(1, 0.5, -1, 0.5, 0, 0);
      ctx.rotate(u.dir);
      const L = def.radius * 2.7 * z * visualScale, Wd = def.radius * 2.1 * z * visualScale;
      const fillF = Math.min(1, u.cargo / 320);
      ctx.fillStyle = u.cargoValue > u.cargo * 1.5 ? '#c43050' : '#e7c44a';
      this.rr(ctx, -L * 0.42, -Wd * 0.27, L * 0.52 * fillF, Wd * 0.54, z * 0.05 * visualScale);
      ctx.fill();
      ctx.restore();
    }

    // ----- tourelle pivotante : dir-sprite propre, posée SUR le toit
    let tAng = u.dir;
    if (spr.turret) {
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
      const pivotW = -def.radius * 0.12; // recul du pivot le long du cap, en tuiles
      const tx2 = wx + Math.cos(u.dir) * pivotW, ty2 = wy + Math.sin(u.dir) * pivotW;
      const tpx = proj.sx(tx2, ty2), tpy = proj.sy(tx2, ty2);
      const tD = this.isoUnitDir(u.type, u.owner, Renderer.dirIndex(tAng), 'turret', SPX * 0.05, tint);
      if (tD) {
        ctx.drawImage(tD.cv, tpx - tD.ax * sD, tpy - hullPx - tD.ay * sD, tD.cv.width * sD, tD.cv.height * sD);
      }
    }

    // ----- flash de tir : départ de coup au bout du canon (punch visuel)
    const wdefV = def.weapon;
    if (wdefV && u.engageId && u.cd > 0 && wdefV.cooldown - u.cd < 0.11) {
      const mwx = wx + Math.cos(tAng) * def.radius * 1.05;
      const mwy = wy + Math.sin(tAng) * def.radius * 1.05;
      const mpx2 = proj.sx(mwx, mwy), mpy2 = proj.sy(mwx, mwy) - hullPx;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.warmGlow(), mpx2 - z * 0.3, mpy2 - z * 0.3, z * 0.6, z * 0.6);
      ctx.fillStyle = 'rgba(255,248,215,0.95)';
      ctx.beginPath(); ctx.arc(mpx2, mpy2, Math.max(1.5, z * 0.07), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    {
      // phares avant : points projetés depuis le repère monde du véhicule,
      // à hauteur de coque (pas au ras du sol)
      const fx = Math.cos(u.dir), fy = Math.sin(u.dir);
      const nose = def.radius * 0.9;
      const side = def.radius * 0.42;
      const lampR = Math.max(1, z * 0.045);
      ctx.fillStyle = 'rgba(255,224,145,0.52)';
      for (const sgn of [1, -1]) {
        const lwx = wx + fx * nose - sgn * fy * side;
        const lwy = wy + fy * nose + sgn * fx * side;
        ctx.beginPath(); ctx.arc(proj.sx(lwx, lwy), proj.sy(lwx, lwy) - hullPx * 0.55, lampR, 0, Math.PI * 2); ctx.fill();
      }
    }

    // surcouches non orientées (au sol)
    if (u.type === 'kamikaze') {
      const pulse = 0.45 + 0.35 * Math.sin(g.time * 7 + u.id);
      ctx.strokeStyle = `rgba(255,70,70,${pulse})`;
      ctx.lineWidth = Math.max(1.5, z * 0.09);
      const rk = def.radius * 1.35 * z;
      ctx.beginPath(); ctx.ellipse(px, py, rk * 1.2, rk * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (u.type === 'radarvehicle') {
      const sweep = g.time * 2.4 + u.id;
      ctx.strokeStyle = '#9ad0ff';
      ctx.lineWidth = Math.max(2, z * 0.1);
      const rs = def.radius * 0.9 * z;
      ctx.beginPath(); ctx.ellipse(px, py - z * 0.25, rs, rs * 0.5, 0, sweep, sweep + Math.PI * 0.7); ctx.stroke();
    }

    if (selected || u.hp < u.maxHp) {
      this.healthBar(ctx, px, py - (def.radius * 1.1 + 0.42) * z, Math.max(14, def.radius * 2.4 * z), u.hp / u.maxHp, selected);
    }
  }

  // Rendu d'un bâtiment ISO : sprite pré-cuit (ou PNG du manifest assets.ts)
  // ancré sur le centre de son emprise, chantier en 3 phases dans la même
  // perspective, surcouches animées (fumée/vapeur/flamme/balise/soudure)
  // positionnées par les ancres du bake, tourelles pivotantes posées sur le
  // plan du sol, sélection et rally en losange/ellipses au sol.
  private drawBuildingSprite(
    ctx: CanvasRenderingContext2D, g: Game, b: Building,
    proj: Proj, selected: boolean,
  ) {
    const z = proj.z;
    const col = PLAYER_COLORS[b.owner];
    const x0 = b.tx - 0.5, y0 = b.ty - 0.5;              // coin monde de l'emprise
    const pc = proj.toScreen(x0 + b.w / 2, y0 + b.h / 2); // centre au sol
    const spr = this.isoSprite(b.type, b.owner);
    const s = z / ISO_S;
    const hgt = BUILDING_HEIGHTS[b.type as keyof typeof BUILDING_HEIGHTS] ?? 1.2;
    const topY = pc.y - hgt * z * ISO_ELEV - z * 0.45;

    const drawBuildProgress = (progress: number, fill: string) => {
      const barW = Math.max(18, Math.min(b.w, 3) * z * 0.8);
      const barH = Math.max(3, Math.min(5, z * 0.11));
      const barX = pc.x - barW / 2;
      const barY = pc.y + z * 0.3;
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

    // dessine le sprite du bâtiment (bake iso ou PNG externe)
    const asset = getBuildingAsset(b.type as keyof typeof BUILDINGS);
    const drawSprite = (alpha = 1, revealFrom = 0) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      let dx: number, dy: number, dw: number, dh: number;
      if (asset) {
        const sA = z / asset.pxPerTile;
        dx = pc.x - asset.ax * sA; dy = pc.y - asset.ay * sA;
        dw = asset.img.width * sA; dh = asset.img.height * sA;
      } else {
        dx = pc.x - spr.ax * s; dy = pc.y - spr.ay * s;
        dw = spr.canvas.width * s; dh = spr.canvas.height * s;
      }
      if (revealFrom > 0) {
        // chantier : révélation bas → haut
        ctx.beginPath();
        ctx.rect(dx - 4, dy + dh * (1 - revealFrom) - 0.5, dw + 8, dh * revealFrom + z, );
        ctx.clip();
      }
      if (asset) ctx.drawImage(asset.img, dx, dy, dw, dh);
      else ctx.drawImage(spr.canvas, dx, dy, dw, dh);
      ctx.restore();
      return { dx, dy, dw, dh };
    };

    if (!b.built) {
      // ================= CHANTIER ISO en trois phases (purement visuel)
      this.constructing.add(b.id);
      const pr = b.progress;
      // terre retournée qui déborde de l'emprise
      proj.footprintPath(ctx, b.tx - 0.22, b.ty - 0.22, b.w + 0.44, b.h + 0.44);
      ctx.fillStyle = 'rgba(62,52,38,0.4)';
      ctx.fill();
      // PHASE 1 — dalle coulée + quadrillage d'armatures
      const slabA = Math.min(1, pr / 0.22);
      proj.footprintPath(ctx, b.tx + 0.04, b.ty + 0.04, b.w - 0.08, b.h - 0.08);
      ctx.fillStyle = `rgba(125,130,134,${0.35 + 0.45 * slabA})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(58,62,66,0.55)';
      ctx.lineWidth = 1;
      const nG = 2 + b.w;
      for (let i = 1; i < nG; i++) {
        const fu = x0 + (i * b.w) / nG, fv = y0 + (i * b.h) / nG;
        ctx.beginPath();
        ctx.moveTo(proj.sx(fu, y0 + 0.05), proj.sy(fu, y0 + 0.05));
        ctx.lineTo(proj.sx(fu, y0 + b.h - 0.05), proj.sy(fu, y0 + b.h - 0.05));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(proj.sx(x0 + 0.05, fv), proj.sy(x0 + 0.05, fv));
        ctx.lineTo(proj.sx(x0 + b.w - 0.05, fv), proj.sy(x0 + b.w - 0.05, fv));
        ctx.stroke();
      }
      // contour du futur bâtiment (pointillés) sur l'emprise
      proj.footprintPath(ctx, b.tx, b.ty, b.w, b.h);
      ctx.strokeStyle = 'rgba(235,238,240,0.5)';
      ctx.lineWidth = Math.max(1, z * 0.05);
      ctx.setLineDash([z * 0.25, z * 0.2]);
      ctx.stroke();
      ctx.setLineDash([]);
      // PHASE 2 — échafaudage : montants aux 4 coins + traverses qui montent
      const scafT = Math.max(0, Math.min(1, (pr - 0.14) / 0.42));
      if (scafT > 0) {
        const hNow = hgt * 0.92 * scafT;
        const corners: [number, number][] = [[x0, y0], [x0 + b.w, y0], [x0 + b.w, y0 + b.h], [x0, y0 + b.h]];
        ctx.strokeStyle = 'rgba(198,178,120,0.75)';
        ctx.lineWidth = Math.max(1.2, z * 0.045);
        for (const [cu, cv] of corners) {
          ctx.beginPath();
          ctx.moveTo(proj.sx(cu, cv), proj.sy(cu, cv));
          ctx.lineTo(proj.sx(cu, cv), proj.sy(cu, cv, hNow));
          ctx.stroke();
        }
        ctx.lineWidth = Math.max(1, z * 0.03);
        const levels = Math.max(1, Math.floor(hNow / 0.4));
        for (let l = 1; l <= levels; l++) {
          const hh = (l * hNow) / levels;
          ctx.beginPath();
          ctx.moveTo(proj.sx(x0, y0 + b.h), proj.sy(x0, y0 + b.h, hh));
          ctx.lineTo(proj.sx(x0 + b.w, y0 + b.h), proj.sy(x0 + b.w, y0 + b.h, hh));
          ctx.lineTo(proj.sx(x0 + b.w, y0), proj.sy(x0 + b.w, y0, hh));
          ctx.stroke();
        }
        // flèche de levage au coin nord
        ctx.strokeStyle = 'rgba(184,145,47,0.85)';
        ctx.lineWidth = Math.max(1.5, z * 0.05);
        ctx.beginPath();
        ctx.moveTo(proj.sx(x0, y0), proj.sy(x0, y0));
        ctx.lineTo(proj.sx(x0, y0), proj.sy(x0, y0, hgt * 1.12));
        ctx.lineTo(proj.sx(x0 + b.w * 0.6, y0 + b.h * 0.35), proj.sy(x0 + b.w * 0.6, y0 + b.h * 0.35, hgt * 0.94));
        ctx.stroke();
      }
      // PHASE 3 — le bâtiment se révèle de bas en haut
      const reveal = Math.max(0, Math.min(1, (pr - 0.3) / 0.66));
      if (reveal > 0) drawSprite(0.96, reveal);
      // poussière de chantier discrète
      if (pr < 0.97) {
        const rngD = mulberry32(b.id * 31 + Math.floor(g.time * 3));
        ctx.fillStyle = 'rgba(150,138,112,0.16)';
        for (let i = 0; i < 3; i++) {
          const du = x0 + rngD() * b.w, dv = y0 + rngD() * b.h;
          ctx.beginPath();
          ctx.ellipse(proj.sx(du, dv), proj.sy(du, dv) - rngD() * z * 0.3, z * (0.2 + rngD() * 0.25), z * 0.12, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      drawBuildProgress(pr, '#e7c44a');
      if (selected) {
        proj.footprintPath(ctx, b.tx, b.ty, b.w, b.h);
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      }
      return;
    }

    // ================= BÂTIMENT ACHEVÉ
    if (this.constructing.has(b.id)) {
      this.constructing.delete(b.id);
      this.builtFlash.set(b.id, g.time);
    }
    drawSprite(1);

    // flash d'activation à l'achèvement
    const fT = this.builtFlash.get(b.id);
    if (fT !== undefined) {
      const dtF = g.time - fT;
      if (dtF < 0.7) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        drawSprite(0.4 * (1 - dtF / 0.7));
        ctx.restore();
      } else {
        this.builtFlash.delete(b.id);
      }
    }

    // ----- surcouches animées ancrées dans le bake
    if (!asset) {
      for (const o of spr.overlays) {
        const opx = proj.sx(x0 + o.u, y0 + o.v);
        const opy = proj.sy(x0 + o.u, y0 + o.v) - o.h * z * ISO_ELEV;
        if (o.kind === 'steam') this.steam(ctx, opx, opy, z, g.time + b.id * 1.7, o.s);
        else if (o.kind === 'flame') this.flame(ctx, opx, opy, z, g.time + b.id * 0.9, o.s);
        else if (o.kind === 'smoke') {
          // panache : 3 bouffées qui montent et dérivent
          for (let k = 0; k < 3; k++) {
            const tt = ((g.time * 0.5 + b.id * 0.37 + k / 3) % 1);
            const rr2 = z * (0.08 + tt * 0.22) * o.s;
            ctx.fillStyle = `rgba(72,70,66,${0.3 * (1 - tt)})`;
            ctx.beginPath();
            ctx.arc(opx + Math.sin((tt + k) * 4.2) * z * 0.08 + tt * z * 0.22, opy - tt * z * 0.85, rr2, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (o.kind === 'beacon') {
          const blink = 0.5 + 0.5 * Math.sin(g.time * 3.4 + b.id);
          ctx.fillStyle = `rgba(255,84,58,${0.35 + blink * 0.6})`;
          ctx.beginPath(); ctx.arc(opx, opy, Math.max(1.4, z * 0.05) * o.s, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `rgba(255,120,80,${blink * 0.18})`;
          ctx.beginPath(); ctx.arc(opx, opy, Math.max(3, z * 0.14) * o.s, 0, Math.PI * 2); ctx.fill();
        } else if (o.kind === 'weld' && b.queue.length > 0) {
          const fl = Math.sin(g.time * 23 + b.id * 3.1);
          if (fl > 0.25) {
            ctx.fillStyle = `rgba(255,244,200,${0.35 + fl * 0.5})`;
            ctx.beginPath(); ctx.arc(opx, opy, Math.max(1.5, z * 0.06) * o.s * (0.7 + fl * 0.5), 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = `rgba(255,210,120,${fl * 0.5})`;
            ctx.lineWidth = 1;
            for (let k = 0; k < 3; k++) {
              const a = fl * 9 + k * 2.1;
              ctx.beginPath();
              ctx.moveTo(opx, opy);
              ctx.lineTo(opx + Math.cos(a) * z * 0.12, opy + Math.sin(a) * z * 0.1);
              ctx.stroke();
            }
          }
        }
      }
      // lumière de porte quand une unité sort (le moteur pose doorT)
      if (spr.door && b.doorT !== undefined && g.time - b.doorT < 0.9) {
        const k2 = 1 - (g.time - b.doorT) / 0.9;
        const dpx = proj.sx(x0 + spr.door.u, y0 + spr.door.v);
        const dpy = proj.sy(x0 + spr.door.u, y0 + spr.door.v);
        ctx.save();
        ctx.globalAlpha = 0.75 * k2;
        ctx.drawImage(this.warmGlow(), dpx - z * 0.8, dpy - z * 0.4, z * 1.6, z * 0.8);
        ctx.restore();
      }
    }

    // ----- tourelle pivotante des défenses (posée sur le plan du sol surélevé)
    if (spr.turret && spr.turretMount) {
      let ang = g.time * 0.3 + b.id;   // veille : balayage lent
      if (b.engageId) {
        const tgt = g.unitById.get(b.engageId);
        if (tgt) ang = Math.atan2(tgt.y - (y0 + b.h / 2), tgt.x - (x0 + b.w / 2));
      }
      const m = spr.turretMount;
      const mpx = proj.sx(x0 + m.u, y0 + m.v);
      const mpy = proj.sy(x0 + m.u, y0 + m.v) - m.h * z * ISO_ELEV;
      // ombre de la pièce sur la plateforme
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(mpx + z * 0.05, mpy + z * 0.06, z * 0.34, z * 0.17, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(mpx, mpy);
      ctx.transform(1, 0.5, -1, 0.5, 0, 0);
      ctx.rotate(ang);
      const sT = z / 64;
      ctx.scale(sT, sT);
      ctx.drawImage(spr.turret, -spr.turret.width / 2, -spr.turret.height / 2);
      ctx.restore();
      // recul/flash de tir : cd vient d'être rechargé
      if (b.engageId && b.cd > 0) {
        const wdef = BUILDINGS[b.type as keyof typeof BUILDINGS].weapon;
        if (wdef && wdef.cooldown - b.cd < 0.09) {
          const fpx = mpx + Math.cos(ang) * z * 0.5 - Math.sin(ang) * 0;
          void fpx;
          const muz = proj.toScreen(x0 + m.u + Math.cos(ang) * 0.55, y0 + m.v + Math.sin(ang) * 0.55);
          ctx.fillStyle = 'rgba(255,240,190,0.9)';
          ctx.beginPath(); ctx.arc(muz.x, muz.y - m.h * z * ISO_ELEV, z * 0.12, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // ----- dégâts : fumée quand le bâtiment est amoché
    const ratio = b.hp / b.maxHp;
    if (ratio < 0.55) {
      const nSm = ratio < 0.28 ? 3 : 1;
      const rngS = mulberry32(b.id * 71);
      for (let k = 0; k < nSm; k++) {
        const su = x0 + 0.3 + rngS() * (b.w - 0.6), sv = y0 + 0.3 + rngS() * (b.h - 0.6);
        const sh = rngS() * hgt * 0.6;
        const tt = ((g.time * 0.6 + k * 0.4 + b.id * 0.21) % 1);
        const spx2 = proj.sx(su, sv), spy2 = proj.sy(su, sv) - sh * z * ISO_ELEV;
        ctx.fillStyle = `rgba(30,28,26,${0.4 * (1 - tt)})`;
        ctx.beginPath();
        ctx.arc(spx2 + tt * z * 0.18, spy2 - tt * z * 0.9, z * (0.1 + tt * 0.3), 0, Math.PI * 2);
        ctx.fill();
        if (ratio < 0.28 && k === 0) {
          const fl2 = 0.6 + 0.4 * Math.sin(g.time * 11 + b.id);
          ctx.fillStyle = `rgba(255,140,50,${0.4 * fl2})`;
          ctx.beginPath(); ctx.arc(spx2, spy2 - z * 0.05, z * 0.1 * fl2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // ----- sélection : losange d'emprise + coins + rally
    if (selected) {
      proj.footprintPath(ctx, b.tx, b.ty, b.w, b.h);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 3;
      ctx.stroke();
      proj.footprintPath(ctx, b.tx, b.ty, b.w, b.h);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (b.rally) {
        const cxw = x0 + b.w / 2, cyw = y0 + b.h / 2;
        const rp = proj.toScreen(b.rally.x, b.rally.y);
        const cp = proj.toScreen(cxw, cyw);
        ctx.strokeStyle = 'rgba(100,190,255,0.65)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([z * 0.18, z * 0.14]);
        ctx.beginPath(); ctx.moveTo(cp.x, cp.y); ctx.lineTo(rp.x, rp.y); ctx.stroke();
        ctx.setLineDash([]);
        // fanion de ralliement
        ctx.strokeStyle = '#cfe8ff';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(rp.x, rp.y); ctx.lineTo(rp.x, rp.y - z * 0.55); ctx.stroke();
        ctx.fillStyle = 'rgba(100,190,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(rp.x, rp.y - z * 0.55);
        ctx.lineTo(rp.x + z * 0.3, rp.y - z * 0.44);
        ctx.lineTo(rp.x, rp.y - z * 0.33);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.ellipse(rp.x, rp.y, z * 0.12, z * 0.06, 0, 0, Math.PI * 2); ctx.fill();
      }
    }

    // ----- réparation en cours : clé visuelle (étincelles) + jauge
    if (b.repairOn && b.hp < b.maxHp) {
      const fl3 = Math.sin(g.time * 13 + b.id * 2.7);
      if (fl3 > 0.1) {
        const ru = x0 + b.w * (0.3 + 0.4 * Math.abs(Math.sin(b.id + Math.floor(g.time)))), rv = y0 + b.h * 0.5;
        const rpx = proj.sx(ru, rv), rpy = proj.sy(ru, rv) - hgt * 0.4 * z * ISO_ELEV;
        ctx.fillStyle = `rgba(140,220,140,${0.4 + fl3 * 0.4})`;
        ctx.beginPath(); ctx.arc(rpx, rpy, z * 0.07, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (selected || b.hp < b.maxHp) {
      this.healthBar(ctx, pc.x, topY, Math.max(20, Math.min(b.w, 3) * z * 0.9), b.hp / b.maxHp, selected);
    }
    // production en file : jauge du premier élément
    if (b.queue.length > 0) {
      const q0 = b.queue[0];
      drawBuildProgress(q0.t / q0.time, '#7ec8ff');
    }
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
    // Cadre caméra : en iso le viewport écran est un LOSANGE dans le repère
    // monde — on projette les 4 coins de l'écran vers le monde → mini-carte.
    const proj = new Proj(v.cam.x, v.cam.y, v.cam.zoom, this.canvas.width, this.canvas.height);
    const corners = [
      proj.toWorld(0, 0), proj.toWorld(this.canvas.width, 0),
      proj.toWorld(this.canvas.width, this.canvas.height), proj.toWorld(0, this.canvas.height),
    ];
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const px = ox + corners[i].x * k, py = oy + corners[i].y * k;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }
}
