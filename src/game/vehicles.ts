// BAKERY VÉHICULES — refonte 100 % : nouvelles silhouettes, nouvelle DA.
//
// Direction artistique : blindés MODERNES ANGULEUX (façon OTAN) — camouflage
// deux tons clair (olive sauge + sable), coques à FACETTES en coin, chenilles
// à galets apparents, roues à moyeux pour les véhicules légers, tourelles
// asymétriques, canons à frein de bouche et manchon thermique, marquages
// peints (chevrons, numéros) et panneaux couleur d'équipe. Rien n'est repris
// de l'ancienne bakery : chaque véhicule est redessiné de zéro.
//
// Convention : vue de DESSUS, avant du véhicule vers +x, échelle SPX px par
// tuile, canvas centré. Le pipeline runtime (aplatissement iso + extrusion +
// contour + soleil écran) transforme ces bakes en sprites 2.5D par direction.
// L'ombrage interne reste doux et neutre : la lumière directionnelle est
// appliquée à l'écran, après rotation (elle ne tourne pas avec le véhicule).
import { UNITS, type UnitTypeId } from './data';
import { mulberry32 } from './map';

const SPX = 48;

// palette commune — nettement plus CLAIRE que l'ancienne (lisibilité RTS)
const SAGE = '#6d7657';        // olive sauge (ton principal)
const SAGE_D = '#4a5140';      // creux / flancs
const SAGE_L = '#8d9770';      // arêtes éclairées
const TAN = '#a3936c';         // taches de camouflage sable
const GUN = '#4d5352';         // acier des canons
const GUN_D = '#2e3233';
const TRACK = '#2c2f2a';       // bande de chenille
const WHEEL = '#26292b';
const HAZARD = '#c2a13b';

function shade(color: string, f: number): string {
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  const k = (v: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${k(r)},${k(g)},${k(b)})`;
}

// ------------------------------------------------------------------- kit

class VKit {
  c: CanvasRenderingContext2D;
  rng: () => number;
  constructor(c: CanvasRenderingContext2D, seed: number) {
    this.c = c;
    this.rng = mulberry32(seed);
  }

  /** Polygone de coque à facettes : remplissage + panneaux + arête avant claire. */
  hull(pts: [number, number][], base = SAGE, opts?: { panels?: boolean; bevel?: boolean }) {
    const c = this.c;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.fillStyle = base;
    c.fill();
    c.strokeStyle = 'rgba(14,16,12,0.65)';
    c.lineWidth = 1.6;
    c.stroke();
    if (opts?.bevel !== false) {
      // arête AVANT éclairée (les facettes de coin se lisent immédiatement)
      let xmax = -1e9;
      for (const p of pts) xmax = Math.max(xmax, p[0]);
      c.strokeStyle = 'rgba(240,240,220,0.4)';
      c.lineWidth = 1.4;
      c.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p[0] > xmax - 8) {
          if (!started) { c.moveTo(p[0], p[1]); started = true; } else c.lineTo(p[0], p[1]);
        }
      }
      c.stroke();
    }
    if (opts?.panels !== false) {
      // lignes de panneaux discrètes
      c.strokeStyle = 'rgba(20,24,18,0.3)';
      c.lineWidth = 1;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      for (let i = 1; i <= 2; i++) {
        const xx = x0 + ((x1 - x0) * i) / 3;
        c.beginPath(); c.moveTo(xx, y0 + 2); c.lineTo(xx, y1 - 2); c.stroke();
      }
    }
  }

  /** Taches de camouflage sable, découpées dans une zone. */
  camo(x0: number, y0: number, x1: number, y1: number, n = 4, col = TAN) {
    const c = this.c;
    c.save();
    c.globalAlpha = 0.55;
    c.fillStyle = col;
    for (let i = 0; i < n; i++) {
      const cx = x0 + this.rng() * (x1 - x0), cy = y0 + this.rng() * (y1 - y0);
      const rw = 4 + this.rng() * 7, rh = 3 + this.rng() * 5;
      c.beginPath();
      c.moveTo(cx - rw, cy);
      c.lineTo(cx - rw * 0.3, cy - rh);
      c.lineTo(cx + rw * 0.6, cy - rh * 0.5);
      c.lineTo(cx + rw, cy + rh * 0.4);
      c.lineTo(cx - rw * 0.2, cy + rh);
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  /** Chenille moderne : bande sombre + galets ronds + dents de barbotin. */
  trackUnit(x0: number, y: number, len: number, w: number) {
    const c = this.c;
    c.fillStyle = TRACK;
    c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(x0, y - w / 2, len, w, w * 0.45);
    else c.rect(x0, y - w / 2, len, w);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = 1.2;
    c.stroke();
    // galets de roulement
    const n = Math.max(3, Math.floor(len / (w * 1.05)));
    for (let k = 0; k < n; k++) {
      const cx = x0 + w * 0.65 + (k * (len - w * 1.3)) / (n - 1);
      c.fillStyle = '#454a44';
      c.beginPath(); c.arc(cx, y, w * 0.3, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#20231f';
      c.beginPath(); c.arc(cx, y, w * 0.13, 0, Math.PI * 2); c.fill();
    }
    // maillons visibles sur le pourtour
    c.strokeStyle = 'rgba(160,165,150,0.25)';
    c.lineWidth = 1;
    for (let xx = x0 + 2; xx < x0 + len - 2; xx += 3.2) {
      c.beginPath(); c.moveTo(xx, y - w / 2 + 0.8); c.lineTo(xx, y - w / 2 + 2.4); c.stroke();
      c.beginPath(); c.moveTo(xx, y + w / 2 - 0.8); c.lineTo(xx, y + w / 2 - 2.4); c.stroke();
    }
  }

  /** Roue tout-terrain (véhicules légers) : pneu + moyeu étoilé. */
  wheel(x: number, y: number, r: number) {
    const c = this.c;
    c.fillStyle = WHEEL;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = '#5a6157';
    c.beginPath(); c.arc(x, y, r * 0.45, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#23261f'; c.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * r * 0.42, y + Math.sin(a) * r * 0.42); c.stroke();
    }
  }

  /** Canon : tube conique + frein de bouche + manchon thermique. */
  gun(x: number, y: number, len: number, w: number, opts?: { brake?: boolean; sleeve?: boolean }) {
    const c = this.c;
    const g = c.createLinearGradient(0, y - w / 2, 0, y + w / 2);
    g.addColorStop(0, shade(GUN, 0.28));
    g.addColorStop(0.5, GUN);
    g.addColorStop(1, GUN_D);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x, y - w / 2);
    c.lineTo(x + len, y - w * 0.36);
    c.lineTo(x + len, y + w * 0.36);
    c.lineTo(x, y + w / 2);
    c.closePath();
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 1; c.stroke();
    if (opts?.sleeve !== false) {
      c.fillStyle = shade(SAGE_D, -0.1);
      c.fillRect(x + len * 0.3, y - w * 0.62, len * 0.24, w * 1.24);
      c.strokeRect(x + len * 0.3, y - w * 0.62, len * 0.24, w * 1.24);
    }
    if (opts?.brake !== false) {
      c.fillStyle = GUN_D;
      c.fillRect(x + len - 5.5, y - w * 0.75, 5.5, w * 1.5);
      c.fillStyle = 'rgba(0,0,0,0.5)';
      c.fillRect(x + len - 3.8, y - w * 0.75, 1.4, w * 1.5);
    }
  }

  /** Panneau couleur d'équipe + liseré (identification, pas de repeinte totale). */
  teamPanel(x: number, y: number, w: number, h: number, team: string) {
    const c = this.c;
    c.fillStyle = team;
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 1;
    c.strokeRect(x, y, w, h);
    c.fillStyle = 'rgba(255,255,255,0.25)';
    c.fillRect(x, y, w, 1.4);
  }

  /** Chevron peint (marquage tactique). */
  chevron(x: number, y: number, s: number, col = 'rgba(230,228,210,0.8)') {
    const c = this.c;
    c.strokeStyle = col;
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(x - s, y - s);
    c.lineTo(x + s * 0.6, y);
    c.lineTo(x - s, y + s);
    c.stroke();
  }

  /** Phares + feux arrière. */
  lights(xF: number, xR: number, yHalf: number) {
    const c = this.c;
    c.fillStyle = '#e8dfae';
    c.fillRect(xF - 1.6, -yHalf + 1, 2.6, 2);
    c.fillRect(xF - 1.6, yHalf - 3, 2.6, 2);
    c.fillStyle = '#a03a2c';
    c.fillRect(xR, -yHalf + 1, 1.8, 2);
    c.fillRect(xR, yHalf - 3, 1.8, 2);
  }

  /** Grilles moteur (arrière de coque). */
  vents(x: number, y: number, w: number, h: number) {
    const c = this.c;
    c.fillStyle = 'rgba(20,24,20,0.55)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(150,155,140,0.3)';
    c.lineWidth = 1;
    const n = Math.max(2, Math.floor(h / 2.6));
    for (let k = 1; k < n; k++) {
      const yy = y + (h * k) / n;
      c.beginPath(); c.moveTo(x + 1, yy); c.lineTo(x + w - 1, yy); c.stroke();
    }
  }
}

function mk(wTiles: number, hTiles: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(wTiles * SPX);
  cv.height = Math.ceil(hTiles * SPX);
  const c = cv.getContext('2d')!;
  c.translate(cv.width / 2, cv.height / 2);
  return [cv, c];
}

// ---------------------------------------------------------------- véhicules

export function bakeVehicle(type: UnitTypeId, team: string): { body: HTMLCanvasElement; turret?: HTMLCanvasElement } | null {
  const def = UNITS[type];
  const r = def.radius * SPX;      // rayon gameplay en px de bake
  const seed = type.length * 977 + type.charCodeAt(0) * 31;

  switch (type) {
    // ================= JEEP → 4×4 d'assaut à plateau ouvert
    case 'jeep': {
      const [cv, c] = mk(1.6, 1.3);
      const K = new VKit(c, seed);
      const L = r * 2.5, W = r * 1.5;
      // roues (dépassent de la caisse — silhouette de 4×4)
      for (const sx of [-0.62, 0.55]) for (const sy of [-1, 1]) K.wheel(L * sx * 0.5 + L * 0.06, (W / 2 + 1.2) * sy - 1.2 * sy, W * 0.24);
      // caisse anguleuse, capot en coin
      K.hull([
        [-L * 0.5, -W * 0.38], [L * 0.18, -W * 0.42], [L * 0.5, -W * 0.2],
        [L * 0.5, W * 0.2], [L * 0.18, W * 0.42], [-L * 0.5, W * 0.38],
      ], SAGE);
      K.camo(-L * 0.45, -W * 0.35, L * 0.4, W * 0.35, 3);
      // pare-brise incliné + arceau + plateau arrière avec mitrailleuse
      c.fillStyle = '#2d3336';
      c.beginPath();
      c.moveTo(L * 0.12, -W * 0.3); c.lineTo(L * 0.26, -W * 0.22); c.lineTo(L * 0.26, W * 0.22); c.lineTo(L * 0.12, W * 0.3);
      c.closePath(); c.fill();
      c.fillStyle = 'rgba(200,225,235,0.3)';
      c.fillRect(L * 0.14, -W * 0.2, 3, W * 0.4);
      c.strokeStyle = SAGE_D; c.lineWidth = 2.4;
      c.strokeRect(-L * 0.36, -W * 0.3, L * 0.4, W * 0.6);      // arceau du plateau
      // roue de secours sur le capot + jerrycans
      c.fillStyle = WHEEL;
      c.beginPath(); c.arc(L * 0.38, 0, W * 0.16, 0, Math.PI * 2); c.fill();
      c.fillStyle = HAZARD;
      c.fillRect(-L * 0.48, -W * 0.16, 4, W * 0.32);
      K.teamPanel(-L * 0.3, -W * 0.44, L * 0.24, 3.2, team);
      K.teamPanel(-L * 0.3, W * 0.44 - 3.2, L * 0.24, 3.2, team);
      K.lights(L * 0.5, -L * 0.5, W * 0.34);
      // tourelle : mitrailleuse sur pivot arrière
      const [tv, tc2] = mk(1.0, 0.7);
      const TK = new VKit(tc2, seed + 3);
      tc2.fillStyle = '#3a413c';
      tc2.beginPath(); tc2.arc(0, 0, r * 0.34, 0, Math.PI * 2); tc2.fill();
      tc2.strokeStyle = 'rgba(0,0,0,0.5)'; tc2.stroke();
      TK.gun(r * 0.1, 0, r * 1.0, 3.2, { sleeve: false, brake: false });
      tc2.fillStyle = '#20241f';
      tc2.fillRect(-r * 0.28, -2.4, r * 0.3, 4.8);              // culasse + crosse
      return { body: cv, turret: tv };
    }

    // ================= TANK → char de bataille : coque basse, tourelle en coin
    case 'tank': {
      const [cv, c] = mk(1.9, 1.5);
      const K = new VKit(c, seed);
      const L = r * 2.75, W = r * 1.75;
      K.trackUnit(-L * 0.5, -W * 0.38, L, W * 0.3);
      K.trackUnit(-L * 0.5, W * 0.38, L, W * 0.3);
      // coque : glacis en pointe, arrière droit
      K.hull([
        [-L * 0.46, -W * 0.26], [L * 0.2, -W * 0.26], [L * 0.5, 0],
        [L * 0.2, W * 0.26], [-L * 0.46, W * 0.26],
      ], SAGE);
      K.camo(-L * 0.4, -W * 0.22, L * 0.3, W * 0.22, 3);
      K.vents(-L * 0.44, -W * 0.18, L * 0.14, W * 0.36);
      K.chevron(L * 0.3, 0, W * 0.1);
      K.lights(L * 0.47, -L * 0.47, W * 0.24);
      K.teamPanel(-L * 0.2, -W * 0.31, L * 0.2, 3.4, team);
      K.teamPanel(-L * 0.2, W * 0.31 - 3.4, L * 0.2, 3.4, team);
      // tourelle : coin asymétrique + canon long, épiscopes, coffre arrière
      const [tv, tc2] = mk(1.7, 0.9);
      const TK = new VKit(tc2, seed + 7);
      TK.hull([
        [-r * 0.62, -r * 0.34], [r * 0.18, -r * 0.44], [r * 0.52, -r * 0.14],
        [r * 0.52, r * 0.14], [r * 0.18, r * 0.44], [-r * 0.62, r * 0.34],
      ], shade(SAGE, -0.06), { panels: false });
      TK.gun(r * 0.4, 0, r * 1.5, 4.6);
      tc2.fillStyle = '#31383a';
      tc2.beginPath(); tc2.arc(-r * 0.18, -r * 0.12, r * 0.13, 0, Math.PI * 2); tc2.fill();  // trappe
      tc2.strokeStyle = 'rgba(0,0,0,0.4)'; tc2.stroke();
      tc2.fillStyle = shade(SAGE_D, -0.12);
      tc2.fillRect(-r * 0.62, -r * 0.24, r * 0.14, r * 0.48);   // coffre arrière
      TK.teamPanel(-r * 0.1, -r * 0.4, r * 0.32, 3, team);
      return { body: cv, turret: tv };
    }

    // ================= HEAVYTANK → super-lourd : jupes latérales, double canon
    case 'heavytank': {
      const [cv, c] = mk(2.2, 1.8);
      const K = new VKit(c, seed);
      const L = r * 2.8, W = r * 1.85;
      K.trackUnit(-L * 0.5, -W * 0.4, L, W * 0.26);
      K.trackUnit(-L * 0.5, W * 0.4, L, W * 0.26);
      // jupes blindées par-dessus les chenilles
      c.fillStyle = shade(SAGE_D, -0.05);
      c.fillRect(-L * 0.42, -W * 0.52, L * 0.8, W * 0.13);
      c.fillRect(-L * 0.42, W * 0.39, L * 0.8, W * 0.13);
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.2;
      c.strokeRect(-L * 0.42, -W * 0.52, L * 0.8, W * 0.13);
      c.strokeRect(-L * 0.42, W * 0.39, L * 0.8, W * 0.13);
      K.hull([
        [-L * 0.46, -W * 0.3], [L * 0.14, -W * 0.32], [L * 0.5, -W * 0.08],
        [L * 0.5, W * 0.08], [L * 0.14, W * 0.32], [-L * 0.46, W * 0.3],
      ], shade(SAGE, -0.08));
      K.camo(-L * 0.4, -W * 0.26, L * 0.3, W * 0.26, 4, '#6e6250');
      K.vents(-L * 0.44, -W * 0.2, L * 0.16, W * 0.4);
      K.chevron(L * 0.26, 0, W * 0.09);
      K.chevron(L * 0.34, 0, W * 0.09);
      K.teamPanel(-L * 0.16, -W * 0.36, L * 0.22, 3.6, team);
      K.teamPanel(-L * 0.16, W * 0.36 - 3.6, L * 0.22, 3.6, team);
      // tourelle massive : DEUX canons + lance-pots fumigènes
      const [tv, tc2] = mk(1.9, 1.1);
      const TK = new VKit(tc2, seed + 11);
      TK.hull([
        [-r * 0.6, -r * 0.4], [r * 0.3, -r * 0.46], [r * 0.56, -r * 0.2],
        [r * 0.56, r * 0.2], [r * 0.3, r * 0.46], [-r * 0.6, r * 0.4],
      ], shade(SAGE_D, 0.06), { panels: false });
      TK.gun(r * 0.42, -r * 0.16, r * 1.35, 4.2);
      TK.gun(r * 0.42, r * 0.16, r * 1.35, 4.2);
      for (let k = 0; k < 3; k++) {                             // fumigènes
        tc2.fillStyle = GUN_D;
        tc2.beginPath(); tc2.arc(-r * 0.1 + k * 4.4, -r * 0.4, 1.7, 0, Math.PI * 2); tc2.fill();
        tc2.beginPath(); tc2.arc(-r * 0.1 + k * 4.4, r * 0.4, 1.7, 0, Math.PI * 2); tc2.fill();
      }
      TK.teamPanel(-r * 0.52, -r * 0.14, 3.4, r * 0.28, team);
      return { body: cv, turret: tv };
    }

    // ================= TANKDESTROYER → casemate basse SANS tourelle, canon fixe géant
    case 'tankdestroyer': {
      const [cv, c] = mk(2.5, 1.6);
      const K = new VKit(c, seed);
      const L = r * 2.7, W = r * 1.8;
      K.trackUnit(-L * 0.5, -W * 0.38, L, W * 0.3);
      K.trackUnit(-L * 0.5, W * 0.38, L, W * 0.3);
      // casemate trapézoïdale très effilée vers l'avant
      K.hull([
        [-L * 0.46, -W * 0.3], [-L * 0.05, -W * 0.32], [L * 0.5, -W * 0.1],
        [L * 0.5, W * 0.1], [-L * 0.05, W * 0.32], [-L * 0.46, W * 0.3],
      ], shade(SAGE, -0.04));
      // superstructure plate décalée arrière
      K.hull([
        [-L * 0.4, -W * 0.2], [-L * 0.02, -W * 0.22], [L * 0.14, -W * 0.08],
        [L * 0.14, W * 0.08], [-L * 0.02, W * 0.22], [-L * 0.4, W * 0.2],
      ], shade(SAGE_D, 0.1), { panels: false });
      K.camo(-L * 0.38, -W * 0.18, L * 0.1, W * 0.18, 3);
      // canon FIXE monumental dans l'axe
      K.gun(L * 0.1, 0, L * 0.52, 5.4);
      c.fillStyle = GUN_D;                                       // berceau du canon
      c.fillRect(L * 0.04, -4.4, L * 0.1, 8.8);
      K.vents(-L * 0.44, -W * 0.16, L * 0.12, W * 0.32);
      K.chevron(-L * 0.2, 0, W * 0.1, 'rgba(210,60,50,0.75)');   // marquage chasseur
      K.teamPanel(-L * 0.34, -W * 0.36, L * 0.26, 3.4, team);
      K.teamPanel(-L * 0.34, W * 0.36 - 3.4, L * 0.26, 3.4, team);
      K.lights(L * 0.48, -L * 0.47, W * 0.26);
      return { body: cv };
    }

    // ================= ARTILLERY → obusier automoteur à casemate arrière
    case 'artillery': {
      const [cv, c] = mk(2.3, 1.5);
      const K = new VKit(c, seed);
      const L = r * 2.7, W = r * 1.7;
      K.trackUnit(-L * 0.5, -W * 0.36, L * 0.94, W * 0.28);
      K.trackUnit(-L * 0.5, W * 0.36, L * 0.94, W * 0.28);
      K.hull([
        [-L * 0.47, -W * 0.26], [L * 0.28, -W * 0.26], [L * 0.44, -W * 0.1],
        [L * 0.44, W * 0.1], [L * 0.28, W * 0.26], [-L * 0.47, W * 0.26],
      ], SAGE);
      // casemate d'obusier à L'ARRIÈRE (silhouette typique SPG)
      K.hull([
        [-L * 0.44, -W * 0.22], [-L * 0.06, -W * 0.22], [-L * 0.06, W * 0.22], [-L * 0.44, W * 0.22],
      ], shade(SAGE_D, 0.08), { bevel: false });
      // long obusier au-dessus de la coque + bêche de recul arrière
      K.gun(-L * 0.12, 0, L * 0.6, 4.6);
      c.fillStyle = GUN_D;
      c.fillRect(-L * 0.5, -W * 0.12, L * 0.05, W * 0.24);       // bêche
      K.camo(-L * 0.4, -W * 0.2, L * 0.2, W * 0.2, 3);
      c.fillStyle = HAZARD;                                       // bandes de sécurité culasse
      c.fillRect(-L * 0.2, -W * 0.24, 3, W * 0.48);
      K.teamPanel(L * 0.02, -W * 0.3, L * 0.18, 3.2, team);
      K.teamPanel(L * 0.02, W * 0.3 - 3.2, L * 0.18, 3.2, team);
      K.lights(L * 0.44, -L * 0.48, W * 0.22);
      return { body: cv };
    }

    // ================= HEAVYARTY → lance-roquettes multiple (nouvelle identité !)
    case 'heavyarty': {
      const [cv, c] = mk(2.4, 1.7);
      const K = new VKit(c, seed);
      const L = r * 2.75, W = r * 1.8;
      K.trackUnit(-L * 0.5, -W * 0.38, L, W * 0.27);
      K.trackUnit(-L * 0.5, W * 0.38, L, W * 0.27);
      K.hull([
        [-L * 0.47, -W * 0.28], [L * 0.3, -W * 0.28], [L * 0.48, -W * 0.1],
        [L * 0.48, W * 0.1], [L * 0.3, W * 0.28], [-L * 0.47, W * 0.28],
      ], shade(SAGE, -0.05));
      // batterie de 2×4 tubes lance-roquettes inclinés (dépasse à l'arrière)
      for (const sy of [-1, 1]) {
        c.fillStyle = '#3b4240';
        c.fillRect(-L * 0.52, sy * W * 0.06 + (sy < 0 ? -W * 0.2 : W * 0.02), L * 0.62, W * 0.18);
        c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 1.2;
        c.strokeRect(-L * 0.52, sy * W * 0.06 + (sy < 0 ? -W * 0.2 : W * 0.02), L * 0.62, W * 0.18);
        for (let k = 0; k < 4; k++) {
          const yy = sy * W * 0.06 + (sy < 0 ? -W * 0.2 : W * 0.02) + W * 0.045 + k * 0.001 + (k % 2) * W * 0.09;
          const xx = -L * 0.5 + (k % 2 === 0 ? 0 : 2);
          c.fillStyle = '#171a18';
          c.beginPath(); c.arc(xx + L * 0.6, yy + W * 0.045, 2.6, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#8c2f26';
          c.beginPath(); c.arc(xx + L * 0.6, yy + W * 0.045, 1.2, 0, Math.PI * 2); c.fill();
        }
      }
      // cabine blindée à l'avant
      K.hull([
        [L * 0.16, -W * 0.24], [L * 0.4, -W * 0.18], [L * 0.46, 0],
        [L * 0.4, W * 0.18], [L * 0.16, W * 0.24],
      ], shade(SAGE_D, 0.12), { panels: false });
      c.fillStyle = 'rgba(200,225,235,0.3)';
      c.fillRect(L * 0.34, -W * 0.12, 2.6, W * 0.24);
      K.camo(-L * 0.1, -W * 0.24, L * 0.14, W * 0.24, 2);
      K.teamPanel(L * 0.05, -W * 0.33, L * 0.16, 3.4, team);
      K.teamPanel(L * 0.05, W * 0.33 - 3.4, L * 0.16, 3.4, team);
      K.chevron(L * 0.44, 0, W * 0.08);
      return { body: cv };
    }

    // ================= HARVESTER → tombereau minier 6 roues, pelle frontale
    case 'harvester': {
      const [cv, c] = mk(2.2, 1.8);
      const K = new VKit(c, seed);
      const L = r * 2.6, W = r * 1.9;
      // 6 grosses roues
      for (const sx of [-0.68, 0, 0.6]) for (const sy of [-1, 1]) K.wheel(L * sx * 0.5, (W / 2) * sy, W * 0.19);
      // châssis + benne trapézoïdale À L'ARRIÈRE (rebords hauts)
      K.hull([
        [-L * 0.5, -W * 0.34], [L * 0.28, -W * 0.36], [L * 0.5, -W * 0.16],
        [L * 0.5, W * 0.16], [L * 0.28, W * 0.36], [-L * 0.5, W * 0.34],
      ], '#8f8256');
      // benne (l'overlay de cargaison du moteur se dessine dedans)
      c.fillStyle = '#6d6242';
      c.beginPath();
      c.moveTo(-L * 0.46, -W * 0.3); c.lineTo(L * 0.05, -W * 0.3);
      c.lineTo(L * 0.05, W * 0.3); c.lineTo(-L * 0.46, W * 0.3);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(30,26,16,0.7)'; c.lineWidth = 2.2; c.stroke();
      c.strokeStyle = 'rgba(240,230,190,0.25)'; c.lineWidth = 1;
      c.strokeRect(-L * 0.43, -W * 0.26, L * 0.45, W * 0.52);
      // cabine avant décalée + pelle/collecteur frontal à dents
      K.hull([
        [L * 0.12, -W * 0.3], [L * 0.34, -W * 0.3], [L * 0.4, -W * 0.1], [L * 0.4, W * 0.1], [L * 0.34, W * 0.3], [L * 0.12, W * 0.3],
      ], '#a29260', { panels: false });
      c.fillStyle = 'rgba(200,225,235,0.35)';
      c.fillRect(L * 0.3, -W * 0.1, 3, W * 0.2);
      c.fillStyle = '#5a5246';
      c.beginPath();
      c.moveTo(L * 0.42, -W * 0.34); c.lineTo(L * 0.56, -W * 0.22); c.lineTo(L * 0.56, W * 0.22); c.lineTo(L * 0.42, W * 0.34);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.stroke();
      for (let k = 0; k < 5; k++) {                              // dents de pelle
        const yy = -W * 0.2 + (k * W * 0.4) / 4;
        c.fillStyle = '#3a352c';
        c.fillRect(L * 0.55, yy - 1.2, 4, 2.4);
      }
      // hazard stripes minières
      c.fillStyle = HAZARD;
      for (let k = 0; k < 3; k++) c.fillRect(L * 0.07, -W * 0.3 + k * W * 0.26, 2.6, W * 0.08);
      K.teamPanel(-L * 0.5, -W * 0.4, L * 0.2, 3.6, team);
      K.teamPanel(-L * 0.5, W * 0.4 - 3.6, L * 0.2, 3.6, team);
      K.lights(L * 0.4, -L * 0.5, W * 0.3);
      return { body: cv };
    }

    // ================= RADARVEHICLE → camion C2 à antenne plate orientable
    case 'radarvehicle': {
      const [cv, c] = mk(1.9, 1.4);
      const K = new VKit(c, seed);
      const L = r * 2.55, W = r * 1.6;
      for (const sx of [-0.6, 0.55]) for (const sy of [-1, 1]) K.wheel(L * sx * 0.5, (W / 2) * sy, W * 0.2);
      K.hull([
        [-L * 0.5, -W * 0.34], [L * 0.2, -W * 0.36], [L * 0.48, -W * 0.14],
        [L * 0.48, W * 0.14], [L * 0.2, W * 0.36], [-L * 0.5, W * 0.34],
      ], '#77806a');
      // shelter électronique (caisse arrière) + climatiseur
      K.hull([
        [-L * 0.46, -W * 0.28], [L * 0.02, -W * 0.28], [L * 0.02, W * 0.28], [-L * 0.46, W * 0.28],
      ], '#8b947c', { bevel: false, panels: false });
      c.fillStyle = '#5b6355';
      c.fillRect(-L * 0.42, -W * 0.22, 6, 6);
      K.camo(-L * 0.4, -W * 0.24, 0, W * 0.24, 2);
      // cabine + pare-brise
      c.fillStyle = 'rgba(200,225,235,0.35)';
      c.fillRect(L * 0.26, -W * 0.16, 3, W * 0.32);
      K.teamPanel(L * 0.06, -W * 0.32, L * 0.14, 3.2, team);
      K.teamPanel(L * 0.06, W * 0.32 - 3.2, L * 0.14, 3.2, team);
      K.lights(L * 0.48, -L * 0.5, W * 0.28);
      // tourelle = grand panneau radar plat rotatif (l'anim de balayage runtime reste)
      const [tv, tc2] = mk(1.4, 0.9);
      tc2.fillStyle = '#39413b';
      tc2.beginPath(); tc2.arc(0, 0, r * 0.2, 0, Math.PI * 2); tc2.fill();
      tc2.fillStyle = '#9aa595';
      tc2.fillRect(-r * 0.12, -r * 0.55, r * 0.16, r * 1.1);
      tc2.strokeStyle = 'rgba(0,0,0,0.55)'; tc2.lineWidth = 1.2;
      tc2.strokeRect(-r * 0.12, -r * 0.55, r * 0.16, r * 1.1);
      tc2.strokeStyle = 'rgba(30,36,32,0.5)';
      for (let k = 1; k < 6; k++) {
        const yy = -r * 0.55 + (k * r * 1.1) / 6;
        tc2.beginPath(); tc2.moveTo(-r * 0.12, yy); tc2.lineTo(r * 0.04, yy); tc2.stroke();
      }
      tc2.fillStyle = '#c8d2c2';
      tc2.fillRect(-r * 0.04, -r * 0.02, r * 0.5, r * 0.04);     // bras d'alimentation
      return { body: cv, turret: tv };
    }

    // ================= MOBILECMD → QG mobile : châssis 8 roues + module d'état-major
    case 'mobilecmd': {
      const [cv, c] = mk(2.3, 1.8);
      const K = new VKit(c, seed);
      const L = r * 2.6, W = r * 1.85;
      for (const sx of [-0.7, -0.25, 0.2, 0.62]) for (const sy of [-1, 1]) K.wheel(L * sx * 0.5, (W / 2) * sy, W * 0.16);
      K.hull([
        [-L * 0.5, -W * 0.32], [L * 0.3, -W * 0.34], [L * 0.5, -W * 0.12],
        [L * 0.5, W * 0.12], [L * 0.3, W * 0.34], [-L * 0.5, W * 0.32],
      ], '#7d8468');
      // module d'état-major (toit surélevé) + antennes + parabole repliée
      K.hull([
        [-L * 0.44, -W * 0.26], [L * 0.08, -W * 0.26], [L * 0.08, W * 0.26], [-L * 0.44, W * 0.26],
      ], '#949c82', { bevel: false });
      c.strokeStyle = '#3c423a'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(-L * 0.36, -W * 0.2); c.lineTo(-L * 0.3, -W * 0.44); c.stroke();
      c.beginPath(); c.moveTo(-L * 0.14, W * 0.2); c.lineTo(-L * 0.08, W * 0.44); c.stroke();
      c.fillStyle = '#a8b19c';
      c.beginPath(); c.ellipse(-L * 0.26, W * 0.1, 6, 4.4, 0.4, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.stroke();
      c.fillStyle = 'rgba(200,225,235,0.35)';
      c.fillRect(L * 0.32, -W * 0.14, 3, W * 0.28);
      // large bande d'équipe (c'est LE véhicule à protéger)
      K.teamPanel(L * 0.1, -W * 0.3, L * 0.16, W * 0.6, team);
      K.chevron(L * 0.44, 0, W * 0.09);
      K.lights(L * 0.5, -L * 0.5, W * 0.28);
      return { body: cv };
    }

    // ================= BOMBER → aile delta furtive bimoteur
    case 'bomber': {
      const [cv, c] = mk(2.0, 1.9);
      const K = new VKit(c, seed);
      const L = r * 2.9, W = r * 2.6;
      // aile delta
      K.hull([
        [L * 0.5, 0], [-L * 0.2, -W * 0.5], [-L * 0.42, -W * 0.34],
        [-L * 0.28, 0], [-L * 0.42, W * 0.34], [-L * 0.2, W * 0.5],
      ], '#5d6660', { panels: true });
      // fuselage central + verrière
      K.hull([
        [L * 0.5, 0], [L * 0.1, -W * 0.09], [-L * 0.3, -W * 0.06], [-L * 0.3, W * 0.06], [L * 0.1, W * 0.09],
      ], '#6c756d', { panels: false });
      c.fillStyle = 'rgba(180,215,230,0.45)';
      c.beginPath(); c.ellipse(L * 0.24, 0, 6.5, 3.4, 0, 0, Math.PI * 2); c.fill();
      // entrées d'air + tuyères
      for (const sy of [-1, 1]) {
        c.fillStyle = '#2f3634';
        c.fillRect(-L * 0.1, sy * W * 0.14 - 2.6, L * 0.16, 5.2);
        c.fillStyle = '#1c211f';
        c.fillRect(-L * 0.32, sy * W * 0.12 - 2.2, L * 0.06, 4.4);
      }
      // bande d'équipe sur les bords d'attaque
      c.strokeStyle = team; c.lineWidth = 2.4;
      c.beginPath(); c.moveTo(L * 0.42, -W * 0.05); c.lineTo(-L * 0.16, -W * 0.46); c.stroke();
      c.beginPath(); c.moveTo(L * 0.42, W * 0.05); c.lineTo(-L * 0.16, W * 0.46); c.stroke();
      K.chevron(-L * 0.05, 0, W * 0.06);
      return { body: cv };
    }

    // ================= SCOUTPLANE → drone de reconnaissance à ailes droites
    case 'scoutplane': {
      const [cv, c] = mk(1.9, 2.0);
      const K = new VKit(c, seed);
      const L = r * 2.7, W = r * 3.0;
      // longues ailes fines droites
      c.fillStyle = '#8a9284';
      c.fillRect(-L * 0.08, -W * 0.5, L * 0.2, W);
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.2;
      c.strokeRect(-L * 0.08, -W * 0.5, L * 0.2, W);
      // fuselage fin + nez capteur boule + empennage en V
      K.hull([
        [L * 0.5, 0], [L * 0.3, -3.4], [-L * 0.42, -2.6], [-L * 0.42, 2.6], [L * 0.3, 3.4],
      ], '#9aa294', { panels: false });
      c.fillStyle = '#333a3d';
      c.beginPath(); c.arc(L * 0.42, 0, 4.4, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(160,200,220,0.6)';
      c.beginPath(); c.arc(L * 0.43, -1, 1.6, 0, Math.PI * 2); c.fill();
      for (const sy of [-1, 1]) {
        c.fillStyle = '#7c8476';
        c.beginPath();
        c.moveTo(-L * 0.3, sy * 2);
        c.lineTo(-L * 0.5, sy * W * 0.16);
        c.lineTo(-L * 0.44, sy * W * 0.18);
        c.lineTo(-L * 0.26, sy * 3.4);
        c.closePath(); c.fill();
      }
      c.strokeStyle = team; c.lineWidth = 2;
      c.beginPath(); c.moveTo(L * 0.06, -W * 0.48); c.lineTo(L * 0.06, W * 0.48); c.stroke();
      return { body: cv };
    }

    // ================= TRANSPORTHELI → hélico utilitaire à queue haute
    case 'transportheli': {
      const [cv, c] = mk(2.0, 1.3);
      const K = new VKit(c, seed);
      const L = r * 2.9, W = r * 1.35;
      // poutre de queue + rotor anticouple
      c.fillStyle = '#6f785f';
      c.fillRect(-L * 0.52, -2.6, L * 0.42, 5.2);
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.2;
      c.strokeRect(-L * 0.52, -2.6, L * 0.42, 5.2);
      c.fillStyle = '#454d42';
      c.fillRect(-L * 0.56, -W * 0.22, 4, W * 0.44);            // dérive
      c.strokeStyle = 'rgba(200,205,195,0.5)'; c.lineWidth = 1;
      c.beginPath(); c.arc(-L * 0.54, -W * 0.26, W * 0.14, 0, Math.PI * 2); c.stroke();
      // cellule cabine arrondie-anguleuse
      K.hull([
        [L * 0.42, 0], [L * 0.28, -W * 0.34], [-L * 0.1, -W * 0.42],
        [-L * 0.22, 0], [-L * 0.1, W * 0.42], [L * 0.28, W * 0.34],
      ], '#7c8568', { panels: false });
      c.fillStyle = 'rgba(180,215,230,0.5)';
      c.beginPath(); c.ellipse(L * 0.3, 0, 5.5, W * 0.24, 0, 0, Math.PI * 2); c.fill();
      // patins
      c.strokeStyle = '#2f342c'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(L * 0.22, -W * 0.5); c.lineTo(-L * 0.12, -W * 0.5); c.stroke();
      c.beginPath(); c.moveTo(L * 0.22, W * 0.5); c.lineTo(-L * 0.12, W * 0.5); c.stroke();
      K.teamPanel(-L * 0.06, -W * 0.3, L * 0.14, W * 0.6, team);
      return { body: cv };
    }

    // ================= CARGOHELI → grue volante bi-rotor à double poutre
    case 'cargoheli': {
      const [cv, c] = mk(2.2, 1.5);
      const K = new VKit(c, seed);
      const L = r * 2.8, W = r * 1.6;
      // double poutre longitudinale + cadre de levage central
      for (const sy of [-1, 1]) {
        c.fillStyle = '#6a7360';
        c.fillRect(-L * 0.5, sy * W * 0.3 - 3, L, 6);
        c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.2;
        c.strokeRect(-L * 0.5, sy * W * 0.3 - 3, L, 6);
      }
      // traverses + treuil
      c.fillStyle = '#4c5348';
      c.fillRect(-L * 0.34, -W * 0.32, 6, W * 0.64);
      c.fillRect(L * 0.28, -W * 0.32, 6, W * 0.64);
      c.fillStyle = HAZARD;
      c.fillRect(-4, -4, 8, 8);
      c.strokeStyle = 'rgba(0,0,0,0.55)'; c.strokeRect(-4, -4, 8, 8);
      // cabine avant courte
      K.hull([
        [L * 0.5, 0], [L * 0.4, -W * 0.24], [L * 0.18, -W * 0.28], [L * 0.18, W * 0.28], [L * 0.4, W * 0.24],
      ], '#7c8568', { panels: false });
      c.fillStyle = 'rgba(180,215,230,0.5)';
      c.fillRect(L * 0.4, -W * 0.14, 3, W * 0.28);
      K.teamPanel(-L * 0.14, -W * 0.26, L * 0.24, 4, team);
      K.teamPanel(-L * 0.14, W * 0.26 - 4, L * 0.24, 4, team);
      return { body: cv };
    }

    default:
      return null;
  }
}
