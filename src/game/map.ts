// Génération procédurale de cartes équilibrées + cartes spéciales (pays).
import { MapSizeId, MAP_SIZES, ThemeId, SpecialMapId } from './data';

export const T_GRASS = 0, T_ROUGH = 1, T_WATER = 2, T_ROCK = 3;

export type OreKind = 'gold' | 'rare';
export interface OreNodeInit { tx: number; ty: number; amount: number; max: number; kind: OreKind }

export interface GameMap {
  w: number;
  h: number;
  terrain: Uint8Array;          // T_*
  roads: Uint8Array;            // 0 = aucun, 1 = route de campagne/militaire
  shade: Float32Array;          // variation visuelle par tuile
  height: Float32Array;         // hauteur précalculée : rendu + léger bonus/malus de vision
  light: Float32Array;          // lightmap terrain précalculée
  cliff: Uint8Array;            // bits N/E/S/W quand une tuile domine un voisin
  starts: { x: number; y: number }[];
  nodes: OreNodeInit[];
  theme: ThemeId;
  /** Arbres CONCRETS : vrais objets du monde (bloquent déplacement, tirs
   *  directs, vision et construction ; rendus comme entités triées en
   *  profondeur). Génération déterministe → identique en multijoueur. */
  trees: TreeInit[];
  /** Occupation par tuile (1 = un arbre bloque cette tuile). */
  tree: Uint8Array;
}

export interface TreeInit {
  x: number; y: number;   // position monde (centre du pied, ± petit décalage)
  s: number;              // échelle visuelle
  v: number;              // variante visuelle (0-3)
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bruit de valeur simple avec interpolation lissée.
function makeNoise(rng: () => number, gridSize: number) {
  const g: number[] = [];
  for (let i = 0; i < gridSize * gridSize; i++) g.push(rng());
  const at = (x: number, y: number) =>
    g[((y % gridSize + gridSize) % gridSize) * gridSize + ((x % gridSize + gridSize) % gridSize)];
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// Cartes spéciales : contour inspiré du pays réel, ajusté pour le gameplay RTS.
export const SPECIAL_MAPS: Record<SpecialMapId, {
  name: string; desc: string;
  w: number; h: number; oreScale: number; maxPlayers: number;
  polygon: [number, number][];
}> = {
  france: {
    name: 'France', desc: 'L’Hexagone : vaste, ouvert, riche en gisements. Guerre de mouvement.',
    w: 180, h: 180, oreScale: 3.4, maxPlayers: 8,
    polygon: [
      [0.46, 0.03], [0.60, 0.10], [0.64, 0.20], [0.61, 0.33], [0.68, 0.45],
      [0.64, 0.58], [0.57, 0.63], [0.44, 0.60], [0.40, 0.68], [0.42, 0.75],
      [0.30, 0.78], [0.14, 0.73], [0.18, 0.55], [0.13, 0.45], [0.02, 0.40],
      [0.05, 0.33], [0.16, 0.34], [0.14, 0.24], [0.27, 0.17], [0.33, 0.06],
    ],
  },
  italy: {
    name: 'Italie', desc: 'La Botte : longue et étroite, couloirs et goulots. Guerre de position.',
    w: 116, h: 204, oreScale: 2.6, maxPlayers: 4,
    polygon: [
      [0.15, 0.03], [0.80, 0.03], [0.90, 0.10], [0.66, 0.18], [0.60, 0.30],
      [0.66, 0.42], [0.76, 0.52], [0.92, 0.60], [0.98, 0.66], [0.93, 0.72],
      [0.82, 0.64], [0.70, 0.60], [0.66, 0.68], [0.60, 0.80], [0.64, 0.92],
      [0.52, 0.97], [0.45, 0.86], [0.50, 0.72], [0.44, 0.58], [0.36, 0.44],
      [0.30, 0.30], [0.12, 0.16], [0.05, 0.10],
    ],
  },
};

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const CLIFF_N = 1, CLIFF_E = 2, CLIFF_S = 4, CLIFF_W = 8;

// ---------------------------------------------------------- arbres concrets
// Massifs forestiers denses (bruit basse fréquence) avec éclaircies. Jamais :
// sur/à côté d'une route (les routes relient les départs → connectivité
// garantie), à côté de l'eau ou de la roche, près d'un départ ou d'un
// gisement. Un arbre occupe UNE tuile qui devient infranchissable.
function generateTrees(
  w: number, h: number, terrain: Uint8Array, roads: Uint8Array,
  starts: { x: number; y: number }[], nodes: OreNodeInit[], seed: number,
): { trees: TreeInit[]; tree: Uint8Array } {
  const rng = mulberry32(seed * 7919 + 101);
  const forest = makeNoise(rng, 48);
  const tree = new Uint8Array(w * h);
  const trees: TreeInit[] = [];
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (t !== T_GRASS && t !== T_ROUGH) continue;
      const f = forest(x * 0.11, y * 0.11);
      if (f < 0.655) continue;                       // hors massif
      const dens = 0.26 + (f - 0.655) * 1.55;        // cœur plus dense
      if (rng() >= dens) continue;
      // voisinage interdit : eau, roche, route (Chebyshev 1)
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++)
        for (let dx = -1; dx <= 1 && ok; dx++) {
          const ni = (y + dy) * w + (x + dx);
          const nt = terrain[ni];
          if (nt === T_WATER || nt === T_ROCK || roads[ni]) ok = false;
        }
      if (!ok) continue;
      for (const s of starts) if (Math.hypot(x - s.x, y - s.y) < 11) { ok = false; break; }
      if (ok) for (const nd of nodes) if (Math.abs(x - nd.tx) <= 2 && Math.abs(y - nd.ty) <= 2) { ok = false; break; }
      if (!ok) continue;
      tree[i] = 1;
      trees.push({
        x: x + (rng() - 0.5) * 0.36,
        y: y + (rng() - 0.5) * 0.36,
        s: 0.85 + rng() * 0.5,
        v: (rng() * 4) | 0,
      });
    }
  return { trees, tree };
}

function computeVisualRelief(
  w: number, h: number, terrain: Uint8Array, roads: Uint8Array, shade: Float32Array,
  elev?: Float32Array,
) {
  const n = w * h;
  const raw = new Float32Array(n);
  const height = new Float32Array(n);
  const light = new Float32Array(n);
  const cliff = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    let base: number;
    if (elev) {
      // VRAI champ d'altitude continu : collines, pentes et vallées réelles
      // sur toute la carte (et plus seulement par type de terrain) → relief
      // visible partout, pas une plaine plate.
      const e = elev[i];
      base = 0.26 + e * 0.66;
      if (t === T_WATER) base = 0.04 + e * 0.10;          // fonds bas
      else if (t === T_ROCK) base = Math.max(base, 0.95); // massifs hauts → falaises franches
      else if (t === T_ROUGH) base += 0.05;               // contreforts un peu surélevés
    } else {
      base = 0.44;
      if (t === T_WATER) base = 0.10;
      else if (t === T_ROUGH) base = 0.66;
      else if (t === T_ROCK) base = 1.0;
    }
    if (roads[i]) base -= 0.04;
    raw[i] = Math.max(0, Math.min(1, base + shade[i] * 0.30));
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = raw[i] * 4.5;
      let weight = 4.5;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const ww = dx === 0 || dy === 0 ? 1.0 : 0.45;
          sum += raw[yy * w + xx] * ww;
          weight += ww;
        }
      }
      height[i] = sum / weight;
    }
  }

  const at = (x: number, y: number) => height[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const lightRaw = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      const slopeLight = (-dx - dy) * 5.5; // lumière franche venant du nord-ouest
      const altitude = (height[i] - 0.46) * 0.32;
      let valley = 0;
      if (terrain[i] !== T_WATER && height[i] < (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.25 - 0.02) valley = -0.10;
      lightRaw[i] = Math.max(0.5, Math.min(1.55, 0.99 + slopeLight + altitude + valley));

      // Les FACES de falaise ne sont dessinées qu'au bord de la ROCHE
      // (= terrain réellement infranchissable). Ainsi « ça ressemble à une
      // falaise » ⟺ « on ne peut pas passer » : la carte devient lisible et
      // logique. Les pentes praticables gardent un ombrage doux (pas de falaise).
      let mask = 0;
      if (terrain[i] === T_ROCK) {
        if (y > 0 && terrain[(y - 1) * w + x] !== T_ROCK) mask |= CLIFF_N;
        if (x < w - 1 && terrain[y * w + (x + 1)] !== T_ROCK) mask |= CLIFF_E;
        if (y < h - 1 && terrain[(y + 1) * w + x] !== T_ROCK) mask |= CLIFF_S;
        if (x > 0 && terrain[y * w + (x - 1)] !== T_ROCK) mask |= CLIFF_W;
      }
      cliff[i] = mask;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = lightRaw[i] * 3.2;
      let weight = 3.2;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += lightRaw[yy * w + xx];
          weight += 1;
        }
      }
      light[i] = Math.max(0.48, Math.min(1.62, sum / weight));
    }
  }

  return { height, light, cliff };
}

export function generateMap(
  sizeId: MapSizeId, theme: ThemeId, playerCount: number, seed: number, special?: SpecialMapId,
): GameMap {
  if (special) return generateSpecialMap(special, theme, playerCount, seed);
  return generateStandardMap(sizeId, theme, playerCount, seed);
}

function generateStandardMap(sizeId: MapSizeId, theme: ThemeId, playerCount: number, seed: number): GameMap {
  const rng = mulberry32(seed);
  const n = MAP_SIZES[sizeId].tiles;
  const oreScale = MAP_SIZES[sizeId].oreScale;
  const terrain = new Uint8Array(n * n);
  const roads = new Uint8Array(n * n);
  const shade = new Float32Array(n * n);
  const passageMask = new Uint8Array(n * n);
  // Trois octaves : continents (basse fréquence) + collines + détail. Donne un
  // relief plus lisible et varié qu'un simple bruit à deux octaves.
  const noiseLow = makeNoise(rng, 16);
  const noiseMid = makeNoise(rng, 16);
  const noiseHi = makeNoise(rng, 16);
  const moisture = makeNoise(rng, 16);   // pilote la part de terrain accidenté
  const detail = makeNoise(rng, 16);     // micro-variation de teinte

  // Relief de base : eau (bas), plaine, terrain accidenté, montagne (haut).
  // Le thème tropical a plus de lagunes, en archipel.
  const waterLevel = theme === 'tropical' ? 0.30 : 0.23;
  const elev = new Float32Array(n * n);   // altitude continue conservée → relief réel
  const fL = 4.2 / n, fM = 9 / n, fH = 19 / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const e =
        noiseLow(x * fL, y * fL) * 0.58 +
        noiseMid(x * fM, y * fM) * 0.30 +
        noiseHi(x * fH, y * fH) * 0.12;
      const m = moisture(x * fM * 0.6, y * fM * 0.6);
      let t = T_GRASS;
      if (e < waterLevel) t = T_WATER;
      else if (e > 0.80) t = T_ROCK;
      else if (e > 0.62 + (m - 0.5) * 0.12) t = T_ROUGH;  // accidenté plus étendu là où c'est « sec »
      terrain[y * n + x] = t;
      elev[y * n + x] = e;
      // Teinte : micro-grain seulement (le relief vient désormais du champ d'altitude).
      shade[y * n + x] = (detail(x * 0.7, y * 0.7) - 0.5) * 0.13;
    }
  }

  // Helpers de modelage (utilisés pour lacs, massifs, clairières).
  const blob = (x0: number, y0: number, r: number, fill: number, jitter = 0.35) => {
    const ri = Math.ceil(r);
    for (let y = Math.max(1, y0 - ri); y <= Math.min(n - 2, y0 + ri); y++)
      for (let x = Math.max(1, x0 - ri); x <= Math.min(n - 2, x0 + ri); x++) {
        const d = Math.hypot(x - x0, y - y0);
        if (d <= r * (1 - jitter + jitter * noiseMid(x * 0.5, y * 0.5) * 2)) terrain[y * n + x] = fill;
      }
  };

  // Lacs intérieurs : quelques plans d'eau aux contours irréguliers, plus
  // nombreux sur les grandes cartes (repères visuels + obstacles tactiques).
  const lakeCount = 3 + Math.floor(n / 55) + (theme === 'tropical' ? 4 : 0);
  for (let i = 0; i < lakeCount; i++) {
    blob(Math.floor(n * (0.16 + rng() * 0.68)), Math.floor(n * (0.16 + rng() * 0.68)), 5 + rng() * (n * 0.065), T_WATER);
  }
  const largeLakeCount = 1 + Math.floor(n / 150) + (theme === 'tropical' ? 1 : 0);
  for (let i = 0; i < largeLakeCount; i++) {
    blob(Math.floor(n * (0.16 + rng() * 0.68)), Math.floor(n * (0.16 + rng() * 0.68)), 9 + rng() * (n * 0.075), T_WATER, 0.58);
  }
  // Massifs rocheux : barrières naturelles qui structurent les couloirs.
  const ridgeCount = 2 + Math.floor(n / 75);
  for (let i = 0; i < ridgeCount; i++) {
    blob(Math.floor(n * (0.15 + rng() * 0.7)), Math.floor(n * (0.15 + rng() * 0.7)), 3 + rng() * (n * 0.03), T_ROCK, 0.5);
  }

  const paintTerrain = (x: number, y: number, fill: number, minElev?: number) => {
    if (x <= 1 || y <= 1 || x >= n - 1 || y >= n - 1) return;
    const i = y * n + x;
    terrain[i] = fill;
    if (minElev !== undefined && elev[i] < minElev) elev[i] = minElev;
  };

  // CHAÎNES MONTAGNEUSES : longues crêtes rocheuses infranchissables qui
  // découpent la carte en vallées. Elles serpentent sur une grande distance et
  // sont assez épaisses pour structurer les déplacements ; les corridors tracés
  // plus bas y percent les rares PASSAGES → vrais goulots stratégiques.
  const rangeCount = Math.max(2, Math.floor(n / 105) + Math.floor(playerCount / 12));
  const rangeThick = 2 + Math.floor(n / 150);
  for (let i = 0; i < rangeCount; i++) {
    let rx = n * (0.15 + rng() * 0.7), ry = n * (0.15 + rng() * 0.7);
    let ang = rng() * Math.PI * 2;
    const len = Math.floor(n * (0.62 + rng() * 0.55));
    for (let s = 0; s < len; s++) {
      ang += (noiseMid(rx * 0.06, ry * 0.06) - 0.5) * 0.45;       // méandre naturel
      const tw = rangeThick + Math.round((noiseHi(rx * 0.25, ry * 0.25) - 0.5) * 2.6);
      const px2 = Math.cos(ang + Math.PI / 2), py2 = Math.sin(ang + Math.PI / 2);
      for (let wph = -tw - 3; wph <= tw + 3; wph++) {
        const mx = Math.round(rx + px2 * wph), my = Math.round(ry + py2 * wph);
        const dist = Math.abs(wph);
        if (dist <= tw) paintTerrain(mx, my, T_ROCK, 0.9);
        else if (rng() < 0.78) paintTerrain(mx, my, T_ROUGH, 0.66);
      }
      if (s % 18 === 0 && rng() < 0.48) {
        const spurAng = ang + (rng() < 0.5 ? 1 : -1) * (0.75 + rng() * 0.65);
        const spurLen = Math.floor(n * (0.06 + rng() * 0.08));
        let sx = rx, sy = ry;
        for (let q = 0; q < spurLen; q++) {
          const sw = Math.max(1, Math.round(tw * (1 - q / Math.max(1, spurLen)) * 0.75));
          const nx = Math.cos(spurAng + Math.PI / 2), ny = Math.sin(spurAng + Math.PI / 2);
          for (let wph = -sw - 2; wph <= sw + 2; wph++) {
            const mx = Math.round(sx + nx * wph), my = Math.round(sy + ny * wph);
            if (Math.abs(wph) <= sw) paintTerrain(mx, my, T_ROCK, 0.9);
            else if (rng() < 0.82) paintTerrain(mx, my, T_ROUGH, 0.64);
          }
          sx += Math.cos(spurAng); sy += Math.sin(spurAng);
          if (sx < 3 || sy < 3 || sx > n - 3 || sy > n - 3) break;
        }
      }
      rx += Math.cos(ang); ry += Math.sin(ang);
      if (rx < 2 || ry < 2 || rx > n - 2 || ry > n - 2) break;
    }
  }

  // Contreforts/plateaux : transformer une partie des grandes plaines proches
  // des massifs ou hautes altitudes en terrain accidenté. C'est franchissable,
  // donc cela ajoute du relief et des zones d'embuscade sans casser le pathfinding.
  const rugged = terrain.slice();
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      const i = y * n + x;
      if (terrain[i] !== T_GRASS) continue;
      let rockNear = 0, roughNear = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const t = terrain[(y + dy) * n + (x + dx)];
          if (t === T_ROCK) rockNear++;
          else if (t === T_ROUGH) roughNear++;
        }
      const high = elev[i] > 0.56 + (moisture(x * 0.08, y * 0.08) - 0.5) * 0.08;
      if ((rockNear >= 2 && rng() < 0.72) || (roughNear >= 5 && rng() < 0.34) || (high && rng() < 0.32)) {
        rugged[i] = T_ROUGH;
        elev[i] = Math.max(elev[i], 0.6 + rng() * 0.08);
      }
    }
  }
  terrain.set(rugged);

  // Plateaux fracturés : grandes zones rugueuses avec quelques dents rocheuses.
  // Elles donnent des axes d'embuscade et cassent les plaines, tout en restant
  // majoritairement franchissables.
  const plateauCount = 4 + Math.floor(n / 62);
  for (let k = 0; k < plateauCount; k++) {
    const px0 = Math.floor(n * (0.12 + rng() * 0.76));
    const py0 = Math.floor(n * (0.12 + rng() * 0.76));
    const rx = 5 + rng() * (n * 0.035);
    const ry = 4 + rng() * (n * 0.028);
    const ang = rng() * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let y = Math.max(2, Math.floor(py0 - ry * 1.8)); y <= Math.min(n - 3, Math.ceil(py0 + ry * 1.8)); y++) {
      for (let x = Math.max(2, Math.floor(px0 - rx * 1.8)); x <= Math.min(n - 3, Math.ceil(px0 + rx * 1.8)); x++) {
        const lx = (x - px0) * ca + (y - py0) * sa;
        const ly = -(x - px0) * sa + (y - py0) * ca;
        const d = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry);
        if (d > 1.15) continue;
        const edge = noiseHi(x * 0.18, y * 0.18);
        if (d < 0.72 + edge * 0.32) {
          if (Math.abs(ly) < 1.35 && edge > 0.62 && rng() < 0.46) paintTerrain(x, y, T_ROCK, 0.86);
          else if (rng() < 0.9) paintTerrain(x, y, T_ROUGH, 0.63 + rng() * 0.08);
        }
      }
    }
  }

  // Bandes de terrain cassé à très basse fréquence : elles évitent les immenses
  // tapis de plaine sur les grandes cartes. Tout reste passable ; les clears et
  // corridors garantis plus bas reprennent la priorité autour des bases.
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      const i = y * n + x;
      if (terrain[i] !== T_GRASS) continue;
      const band =
        noiseLow(x * 0.035 + 19.4, y * 0.035 + 7.1) * 0.55 +
        noiseMid(x * 0.055 + 3.7, y * 0.055 + 31.2) * 0.45;
      if (band > 0.72 && elev[i] > waterLevel + 0.16) paintTerrain(x, y, T_ROUGH, 0.58 + (band - 0.72) * 0.5);
    }
  }

  // Cohérence des massifs : les chaînes doivent être lisibles comme de vrais
  // obstacles. Cette passe ferme les micro-trous accidentels au coeur des roches
  // et transforme leur bord immédiat en contreforts, avant que les clairières et
  // corridors garantis ne percent les passages voulus.
  for (let pass = 0; pass < 2; pass++) {
    const tightened = terrain.slice();
    for (let y = 2; y < n - 2; y++) {
      for (let x = 2; x < n - 2; x++) {
        const i = y * n + x;
        if (terrain[i] === T_ROCK || terrain[i] === T_WATER) continue;
        let rock4 = 0, rock8 = 0, water8 = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const t = terrain[(y + dy) * n + (x + dx)];
            if (t === T_ROCK) {
              rock8++;
              if (dx === 0 || dy === 0) rock4++;
            } else if (t === T_WATER) {
              water8++;
            }
          }
        }
        if (rock4 >= 3 || rock8 >= 6) {
          tightened[i] = T_ROCK;
          elev[i] = Math.max(elev[i], 0.91);
        } else if (terrain[i] === T_GRASS && rock8 >= 2 && water8 === 0) {
          tightened[i] = T_ROUGH;
          elev[i] = Math.max(elev[i], 0.64);
        }
      }
    }
    terrain.set(tightened);
  }

  // Bordure rocheuse.
  for (let i = 0; i < n; i++) {
    terrain[i] = T_ROCK; terrain[(n - 1) * n + i] = T_ROCK;
    terrain[i * n] = T_ROCK; terrain[i * n + n - 1] = T_ROCK;
  }

  // Positions de départ sur un cercle autour du centre.
  const starts: { x: number; y: number }[] = [];
  const cx = n / 2, cy = n / 2;
  const rad = n * 0.37;
  const baseAngle = rng() * Math.PI * 2;
  for (let i = 0; i < playerCount; i++) {
    const a = baseAngle + (i / playerCount) * Math.PI * 2 + (rng() - 0.5) * 0.22;
    starts.push({
      x: Math.round(cx + Math.cos(a) * rad),
      y: Math.round(cy + Math.sin(a) * rad),
    });
  }

  // Dégager une zone plate autour de chaque départ (légèrement plus large sur
  // les grandes cartes pour laisser respirer une grosse base).
  const clear = (x0: number, y0: number, r: number) => {
    for (let y = Math.max(1, y0 - r); y <= Math.min(n - 2, y0 + r); y++)
      for (let x = Math.max(1, x0 - r); x <= Math.min(n - 2, x0 + r); x++)
        if ((x - x0) ** 2 + (y - y0) ** 2 <= r * r) terrain[y * n + x] = T_GRASS;
  };
  const startClearR = Math.round(9 + n / 130);
  for (const s of starts) clear(s.x, s.y, startClearR);

  // Clairière centrale + clairières stratégiques à mi-distance : zones ouvertes
  // pour les grands affrontements (et accueil de gros gisements contestés).
  const openZones: { x: number; y: number }[] = [{ x: Math.round(cx), y: Math.round(cy) }];
  const centerClearR = Math.round(7 + n / 90);
  const midClearR = Math.round(5 + n / 130);
  clear(Math.round(cx), Math.round(cy), centerClearR);
  const midRingCount = Math.min(8, 2 + Math.floor(playerCount / 2));
  for (let i = 0; i < midRingCount; i++) {
    const a = baseAngle + (i / midRingCount) * Math.PI * 2 + 0.4;
    const zx = Math.round(cx + Math.cos(a) * n * 0.2);
    const zy = Math.round(cy + Math.sin(a) * n * 0.2);
    clear(zx, zy, midClearR);
    openZones.push({ x: zx, y: zy });
  }

  // Corridors garantis (largeur croissante avec la taille de carte → flux fluide
  // des armées massives). Tracés APRÈS les lacs/massifs : aucune base enfermée.
  const cwidth = n > 230 ? 2 : 1;
  const carve = (x0: number, y0: number, x1: number, y1: number, markRoad = false) => {
    let x = x0, y = y0;
    while (x !== x1 || y !== y1) {
      if (rng() < 0.5 && x !== x1) x += Math.sign(x1 - x);
      else if (y !== y1) y += Math.sign(y1 - y);
      else if (x !== x1) x += Math.sign(x1 - x);
      for (let dy = -cwidth; dy <= cwidth; dy++)
        for (let dx = -cwidth; dx <= cwidth; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx > 0 && yy > 0 && xx < n - 1 && yy < n - 1) {
            const i = yy * n + xx;
            const wasBlocked = terrain[i] === T_ROCK || terrain[i] === T_WATER;
            terrain[i] = wasBlocked ? T_ROUGH : T_GRASS;
            passageMask[i] = 1;
            elev[i] = Math.min(elev[i], wasBlocked ? 0.58 : 0.5);
            if (markRoad && Math.abs(dx) + Math.abs(dy) <= Math.max(1, cwidth)) roads[i] = 1;
          }
        }
    }
  };
  // IMPORTANT : les corridors assurent la CONNECTIVITÉ (terrain) mais ne sont
  // PLUS marqués comme routes — sinon les routes trahiraient la position des
  // bases (corridors base→centre, base→base, anneau autour du QG).
  for (const s of starts) carve(s.x, s.y, Math.round(cx), Math.round(cy), false);
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i], b = starts[(i + 1) % starts.length];
    if (starts.length > 1) carve(a.x, a.y, b.x, b.y, false);
  }

  // ----- ROUTES ALÉATOIRES : pistes de campagne réparties au hasard, SANS lien
  // avec les bases (on ne doit pas pouvoir en déduire l'emplacement ennemi).
  // Elles relient des points neutres (clairières / points aléatoires) et serpentent.
  const traceRoad = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0, y = y0, guard = 0;
    while ((x !== x1 || y !== y1) && guard++ < n * 4) {
      if (rng() < 0.5 && x !== x1) x += Math.sign(x1 - x);
      else if (y !== y1) y += Math.sign(y1 - y);
      else if (x !== x1) x += Math.sign(x1 - x);
      if (rng() < 0.28) { x += Math.round((rng() - 0.5) * 2.4); y += Math.round((rng() - 0.5) * 2.4); } // méandre
      if (x > 1 && y > 1 && x < n - 1 && y < n - 1) {
        const t = terrain[y * n + x];
        if (t === T_GRASS || t === T_ROUGH) roads[y * n + x] = 1;   // pas sur l'eau/la roche
      }
    }
  };
  const randLand = (): { x: number; y: number } => {
    for (let tries = 0; tries < 40; tries++) {
      const x = 3 + Math.floor(rng() * (n - 6)), y = 3 + Math.floor(rng() * (n - 6));
      const t = terrain[y * n + x];
      if (t === T_GRASS || t === T_ROUGH) return { x, y };
    }
    return { x: Math.round(cx), y: Math.round(cy) };
  };
  const segCount = 3 + Math.floor(n / 65);
  // certaines pistes relient des clairières neutres (mi-carte), d'autres sont libres
  for (let k = 0; k < segCount; k++) {
    const a = openZones.length > 1 && rng() < 0.5
      ? openZones[Math.floor(rng() * openZones.length)] : randLand();
    const b = randLand();
    if (Math.hypot(a.x - b.x, a.y - b.y) < n * 0.55) traceRoad(a.x, a.y, b.x, b.y);
  }
  if (n >= 200) {
    const branchCount = Math.floor(n / 110);
    for (let k = 0; k < branchCount; k++) {
      const a = randLand();
      const ang = rng() * Math.PI * 2;
      const d = n * (0.12 + rng() * 0.12);
      const b = {
        x: Math.max(3, Math.min(n - 4, Math.round(a.x + Math.cos(ang) * d))),
        y: Math.max(3, Math.min(n - 4, Math.round(a.y + Math.sin(ang) * d))),
      };
      if (terrain[b.y * n + b.x] === T_GRASS || terrain[b.y * n + b.x] === T_ROUGH) traceRoad(a.x, a.y, b.x, b.y);
    }
  }

  // Bassins/plateaux isolés : vraies poches constructibles, riches en minerai,
  // volontairement coupées par roche/eau. Elles donnent une raison stratégique
  // aux transports aériens sans menacer les départs ni les corridors principaux.
  const isolatedZones: { x: number; y: number; r: number }[] = [];
  const isoCount = n < 150 ? 0 : 1 + Math.floor(n / 210);
  const farFromStrategic = (x: number, y: number, r: number) => {
    if (Math.hypot(x - cx, y - cy) < n * 0.18 + r) return false;
    for (const s of starts) if (Math.hypot(x - s.x, y - s.y) < startClearR + r + 8) return false;
    return true;
  };
  for (let z = 0; z < isoCount; z++) {
    let zx = 0, zy = 0, zr = 0, ok = false;
    for (let tries = 0; tries < 70 && !ok; tries++) {
      zr = Math.round(7 + rng() * (n >= 260 ? 5 : 3));
      zx = Math.round(n * (0.14 + rng() * 0.72));
      zy = Math.round(n * (0.14 + rng() * 0.72));
      ok = farFromStrategic(zx, zy, zr) && isolatedZones.every(o => Math.hypot(o.x - zx, o.y - zy) > o.r + zr + 12);
    }
    if (!ok) continue;
    isolatedZones.push({ x: zx, y: zy, r: zr });
    const barrier = rng() < 0.25 ? T_WATER : T_ROCK;
    const outer = zr + 4;
    for (let y = Math.max(2, zy - outer); y <= Math.min(n - 3, zy + outer); y++) {
      for (let x = Math.max(2, zx - outer); x <= Math.min(n - 3, zx + outer); x++) {
        const d = Math.hypot(x - zx, y - zy);
        const roughEdge = zr - 2 + (noiseHi(x * 0.23, y * 0.23) - 0.5) * 2.2;
        const wallEdge = zr + 2 + (noiseMid(x * 0.16, y * 0.16) - 0.5) * 2.4;
        const i = y * n + x;
        if (d <= roughEdge) {
          terrain[i] = d > zr * 0.55 && rng() < 0.35 ? T_ROUGH : T_GRASS;
          elev[i] = Math.max(elev[i], 0.58 + rng() * 0.08);
          roads[i] = 0;
        } else if (d <= wallEdge) {
          terrain[i] = barrier;
          elev[i] = barrier === T_ROCK ? Math.max(elev[i], 0.92) : Math.min(elev[i], 0.18);
          roads[i] = 0;
        }
      }
    }
  }

  // Passe finale anti-micro-passages : après tous les creusements, on ferme les
  // ouvertures rocheuses non volontaires. Les corridors garantis, clairières de
  // départ, zones centrales et poches isolées restent explicitement protégés.
  const protectedPassage = (x: number, y: number) => {
    const i = y * n + x;
    if (passageMask[i]) return true;
    for (const s of starts) if (Math.hypot(x - s.x, y - s.y) <= startClearR + 2) return true;
    for (let zi = 0; zi < openZones.length; zi++) {
      const z = openZones[zi];
      const rr = zi === 0 ? centerClearR + 2 : midClearR + 2;
      if (Math.hypot(x - z.x, y - z.y) <= rr) return true;
    }
    for (const z of isolatedZones) if (Math.hypot(x - z.x, y - z.y) <= z.r + 1) return true;
    return false;
  };
  for (let pass = 0; pass < 3; pass++) {
    const sealed = terrain.slice();
    for (let y = 2; y < n - 2; y++) {
      for (let x = 2; x < n - 2; x++) {
        const i = y * n + x;
        if (terrain[i] === T_ROCK || terrain[i] === T_WATER || protectedPassage(x, y)) continue;
        const left = terrain[i - 1] === T_ROCK;
        const right = terrain[i + 1] === T_ROCK;
        const up = terrain[i - n] === T_ROCK;
        const down = terrain[i + n] === T_ROCK;
        let rock8 = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (terrain[(y + dy) * n + (x + dx)] === T_ROCK) rock8++;
          }
        }
        const rock4 = (left ? 1 : 0) + (right ? 1 : 0) + (up ? 1 : 0) + (down ? 1 : 0);
        const slit = (left && right) || (up && down);
        if (rock4 >= 3 || rock8 >= 6 || (slit && rock8 >= 4)) {
          sealed[i] = T_ROCK;
          elev[i] = Math.max(elev[i], 0.92);
          roads[i] = 0;
        } else if (terrain[i] === T_GRASS && rock8 >= 3) {
          sealed[i] = T_ROUGH;
          elev[i] = Math.max(elev[i], 0.66);
        }
      }
    }
    terrain.set(sealed);
  }
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (!passageMask[i] || terrain[i] === T_WATER || terrain[i] === T_ROCK) continue;
      if (terrain[i - 1] === T_ROCK || terrain[i + 1] === T_ROCK || terrain[i - n] === T_ROCK || terrain[i + n] === T_ROCK) {
        terrain[i] = T_ROUGH;
        elev[i] = Math.max(elev[i], 0.62);
      }
    }
  }
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (terrain[i] === T_ROCK || terrain[i] === T_WATER) continue;
      if (terrain[i - 1] === T_ROCK && terrain[i + 1] === T_ROCK && terrain[i - n] === T_ROCK && terrain[i + n] === T_ROCK) {
        terrain[i] = T_ROCK;
        elev[i] = Math.max(elev[i], 0.92);
        roads[i] = 0;
      }
    }
  }

  // ===================================================================
  // COHÉRENCE STRUCTURELLE FINALE — garantit une carte LISIBLE et LOGIQUE
  // quelle que soit la complexité des passes amont :
  //   1. eau regroupée (pas de flaques isolées) ;
  //   2. roche regroupée (pas d'éclats parasites) ;
  //   3. murs scellés (aucune fuite diagonale → montagnes vraiment infranchissables) ;
  //   4. connectivité garantie (chaque base reliée par un col propre).
  // ===================================================================
  const N = n * n;
  const NB4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // -- helper : composantes connexes 4-voisins d'un type, retire celles trop petites
  const cleanupType = (type: number, minSize: number, replace: number) => {
    const seen = new Uint8Array(N);
    const stack: number[] = [];
    for (let i0 = 0; i0 < N; i0++) {
      if (terrain[i0] !== type || seen[i0]) continue;
      stack.length = 0; stack.push(i0); seen[i0] = 1;
      const comp: number[] = [i0];
      while (stack.length) {
        const c = stack.pop()!; const cx2 = c % n, cy2 = (c / n) | 0;
        for (const [dx, dy] of NB4) {
          const xx = cx2 + dx, yy = cy2 + dy;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          const j = yy * n + xx;
          if (terrain[j] === type && !seen[j]) { seen[j] = 1; stack.push(j); comp.push(j); }
        }
      }
      if (comp.length < minSize) for (const j of comp) {
        terrain[j] = replace;
        if (type === T_WATER) elev[j] = Math.max(elev[j], waterLevel + 0.05);
      }
    }
  };
  // 1) lacs cohérents : supprime les plans d'eau minuscules (le seuil de bruit
  //    en sème beaucoup) → ne restent que de vraies masses d'eau continues.
  cleanupType(T_WATER, Math.max(14, Math.floor(N * 0.0009)), T_GRASS);
  // remplir les trous d'1 tuile DANS l'eau (berges plus nettes)
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = y * n + x;
    if (terrain[i] === T_WATER) continue;
    let wn = 0; for (const [dx, dy] of NB4) if (terrain[(y + dy) * n + (x + dx)] === T_WATER) wn++;
    if (wn === 4) { terrain[i] = T_WATER; elev[i] = Math.min(elev[i], waterLevel - 0.04); }
  }
  // 2) roche cohérente : supprime les éclats rocheux isolés (parasites) → seules
  //    les chaînes/massifs lisibles subsistent. (La bordure est une grande
  //    composante, conservée.)
  cleanupType(T_ROCK, 7, T_ROUGH);

  // 3) ÉTANCHÉITÉ DES MURS : scelle tout pincement diagonal de roche (2×2 avec
  //    une diagonale rocheuse et l'autre praticable) — sinon une unité se faufile
  //    en diagonale « à travers » la crête. On ne scelle jamais un passage voulu.
  const isRockT = (x: number, y: number) => terrain[y * n + x] === T_ROCK;
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const a = isRockT(x, y), b = isRockT(x + 1, y), c = isRockT(x, y + 1), d = isRockT(x + 1, y + 1);
      if (a && d && !b && !c) {
        if (!passageMask[y * n + (x + 1)]) { terrain[y * n + (x + 1)] = T_ROCK; elev[y * n + (x + 1)] = Math.max(elev[y * n + (x + 1)], 0.92); }
        else if (!passageMask[(y + 1) * n + x]) { terrain[(y + 1) * n + x] = T_ROCK; elev[(y + 1) * n + x] = Math.max(elev[(y + 1) * n + x], 0.92); }
      } else if (b && c && !a && !d) {
        if (!passageMask[y * n + x]) { terrain[y * n + x] = T_ROCK; elev[y * n + x] = Math.max(elev[y * n + x], 0.92); }
        else if (!passageMask[(y + 1) * n + (x + 1)]) { terrain[(y + 1) * n + (x + 1)] = T_ROCK; elev[(y + 1) * n + (x + 1)] = Math.max(elev[(y + 1) * n + (x + 1)], 0.92); }
      }
    }
  }

  // 4) CONNECTIVITÉ GARANTIE : flood-fill praticable depuis le centre ; si une
  //    base est isolée (un mur scellé l'a coupée), on perce un COL propre (large,
  //    en herbe, clairement franchissable) vers le centre.
  const passable = (x: number, y: number) => { const t = terrain[y * n + x]; return t === T_GRASS || t === T_ROUGH; };
  const carveCol = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0, y = y0, guard = 0;
    while ((x !== x1 || y !== y1) && guard++ < n * 4) {
      if (Math.abs(x1 - x) > Math.abs(y1 - y)) x += Math.sign(x1 - x);
      else if (y !== y1) y += Math.sign(y1 - y);
      else x += Math.sign(x1 - x);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx > 0 && yy > 0 && xx < n - 1 && yy < n - 1 && Math.abs(dx) + Math.abs(dy) <= 3) {
          const i = yy * n + xx; terrain[i] = T_GRASS; elev[i] = Math.min(elev[i], 0.5); passageMask[i] = 1; roads[i] = 0;
        }
      }
    }
  };
  {
    const seen = new Uint8Array(N); const stack: number[] = [];
    const start0 = Math.round(cy) * n + Math.round(cx);
    if (passable(Math.round(cx), Math.round(cy))) { stack.push(start0); seen[start0] = 1; }
    while (stack.length) {
      const c = stack.pop()!; const x2 = c % n, y2 = (c / n) | 0;
      for (const [dx, dy] of NB4) {
        const xx = x2 + dx, yy = y2 + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        if (!seen[j] && passable(xx, yy)) { seen[j] = 1; stack.push(j); }
      }
    }
    for (const s of starts) if (!seen[s.y * n + s.x]) carveCol(s.x, s.y, Math.round(cx), Math.round(cy));
  }

  // Gisements de minerai.
  const nodes: OreNodeInit[] = [];
  const occupied = (tx: number, ty: number) =>
    nodes.some(o => Math.abs(o.tx - tx) <= 1 && Math.abs(o.ty - ty) <= 1);

  const addCluster = (x0: number, y0: number, tiles: number, perTile: number, kind: OreKind = 'gold') => {
    let placed = 0, attempts = 0;
    let x = x0, y = y0;
    while (placed < tiles && attempts < tiles * 30) {
      attempts++;
      if (x > 1 && y > 1 && x < n - 2 && y < n - 2 &&
          terrain[y * n + x] !== T_WATER && terrain[y * n + x] !== T_ROCK && !occupied(x, y)) {
        const amount = perTile * (0.8 + rng() * 0.4);
        nodes.push({ tx: x, ty: y, amount, max: amount, kind });
        placed++;
      }
      x = x0 + Math.round((rng() - 0.5) * 6);
      y = y0 + Math.round((rng() - 0.5) * 6);
    }
  };

  // 1) Gisement de départ pour chaque joueur (proche, taille moyenne).
  for (const s of starts) {
    const a = rng() * Math.PI * 2;
    const d = 7 + rng() * 3;
    addCluster(
      Math.round(s.x + Math.cos(a) * d),
      Math.round(s.y + Math.sin(a) * d),
      7, 900 * oreScale,
    );
  }
  // 2) Gros gisements stratégiques contestés, ancrés dans les clairières
  // ouvertes (centre + anneau médian) : les zones ouvertes deviennent ainsi de
  // véritables enjeux. ~18 % de minerai rare (valeur triple).
  // Le nombre de gisements grandit avec oreScale et le nombre de joueurs.
  const bigCount = 2 + Math.floor(oreScale) + Math.floor(playerCount / 4);
  for (let i = 0; i < bigCount; i++) {
    const z = openZones[i % openZones.length];
    const a = rng() * Math.PI * 2;
    const d = rng() * (n * 0.05);
    const rare = rng() < 0.18;
    addCluster(
      Math.round(z.x + Math.cos(a) * d),
      Math.round(z.y + Math.sin(a) * d),
      rare ? 6 : 10, (rare ? 800 : 1800) * oreScale, rare ? 'rare' : 'gold',
    );
  }
  // 3) Petits gisements secondaires dispersés.
  const smallCount = 4 + Math.floor(oreScale * 3) + playerCount;
  for (let i = 0; i < smallCount; i++) {
    const rare = rng() < 0.15;
    addCluster(
      2 + Math.floor(rng() * (n - 4)),
      2 + Math.floor(rng() * (n - 4)),
      rare ? 3 : 4, (rare ? 450 : 700) * oreScale, rare ? 'rare' : 'gold',
    );
  }
  // 4) Récompenses aériennes : ressources riches dans les poches isolées.
  for (const z of isolatedZones) {
    addCluster(z.x - 2, z.y, 7, 1200 * oreScale, 'gold');
    addCluster(z.x + 3, z.y + 2, 4, 650 * oreScale, 'rare');
  }

  const relief = computeVisualRelief(n, n, terrain, roads, shade, elev);
  const forestry = generateTrees(n, n, terrain, roads, starts, nodes, seed);
  return { w: n, h: n, terrain, roads, shade, ...relief, starts, nodes, theme, ...forestry };
}

// ---------------------------------------------------------- cartes spéciales

function generateSpecialMap(special: SpecialMapId, theme: ThemeId, playerCount: number, seed: number): GameMap {
  const def = SPECIAL_MAPS[special];
  const rng = mulberry32(seed);
  const { w, h, polygon, oreScale } = def;
  const terrain = new Uint8Array(w * h).fill(T_WATER); // mer tout autour du pays
  const roads = new Uint8Array(w * h);
  const shade = new Float32Array(w * h);
  const noise1 = makeNoise(rng, 16);
  const noise2 = makeNoise(rng, 16);

  // Terre à l'intérieur du contour du pays, avec relief et petits lacs.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      shade[y * w + x] = (noise2(x * 0.7, y * 0.7) - 0.5) * 0.14;
      if (!pointInPolygon((x + 0.5) / w, (y + 0.5) / h, polygon)) continue;
      const f = 8 / Math.max(w, h);
      const e = noise1(x * f, y * f) * 0.65 + noise2(x * f * 3.1, y * f * 3.1) * 0.35;
      let t = T_GRASS;
      if (e < 0.15) t = T_WATER;       // lacs intérieurs rares
      else if (e > 0.8) t = T_ROCK;    // massifs
      else if (e > 0.68) t = T_ROUGH;
      terrain[y * w + x] = t;
    }
  }

  // Distance grossière à la côte (pour placer les départs à l'intérieur des terres).
  const inland = (tx: number, ty: number, r: number): boolean => {
    for (let dy = -r; dy <= r; dy += 2)
      for (let dx = -r; dx <= r; dx += 2) {
        const xx = tx + dx, yy = ty + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return false;
        if (terrain[yy * w + xx] === T_WATER) return false;
      }
    return true;
  };

  // Candidats de départ, puis échantillonnage du point le plus éloigné :
  // répartit naturellement les joueurs sur toute la longueur du pays.
  const candidates: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 4000 && candidates.length < 300; tries++) {
    const x = 6 + Math.floor(rng() * (w - 12));
    const y = 6 + Math.floor(rng() * (h - 12));
    if (terrain[y * w + x] === T_GRASS && inland(x, y, 5)) candidates.push({ x, y });
  }
  const starts: { x: number; y: number }[] = [];
  if (candidates.length > 0) {
    starts.push(candidates[Math.floor(rng() * candidates.length)]);
    while (starts.length < playerCount) {
      let best = candidates[0], bestD = -1;
      for (const c of candidates) {
        let minD = Infinity;
        for (const s of starts) minD = Math.min(minD, Math.hypot(c.x - s.x, c.y - s.y));
        if (minD > bestD) { bestD = minD; best = c; }
      }
      starts.push(best);
    }
  }

  // Dégager les zones de départ.
  const clear = (x0: number, y0: number, r: number) => {
    for (let y = Math.max(1, y0 - r); y <= Math.min(h - 2, y0 + r); y++)
      for (let x = Math.max(1, x0 - r); x <= Math.min(w - 2, x0 + r); x++)
        if ((x - x0) ** 2 + (y - y0) ** 2 <= r * r) terrain[y * w + x] = T_GRASS;
  };
  for (const s of starts) clear(s.x, s.y, 8);

  // Connectivité : corridor entre départs voisins le long de l'axe principal
  // (suit la péninsule au lieu de couper à travers la mer).
  const axis = h >= w ? 'y' : 'x';
  const chain = [...starts].sort((a, b) => (axis === 'y' ? a.y - b.y : a.x - b.x));
  const carve = (x0: number, y0: number, x1: number, y1: number, markRoad = false) => {
    let x = x0, y = y0;
    while (x !== x1 || y !== y1) {
      if (rng() < 0.5 && x !== x1) x += Math.sign(x1 - x);
      else if (y !== y1) y += Math.sign(y1 - y);
      else if (x !== x1) x += Math.sign(x1 - x);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx > 0 && yy > 0 && xx < w - 1 && yy < h - 1) {
            const i = yy * w + xx;
            terrain[i] = T_GRASS;
            if (markRoad && Math.abs(dx) + Math.abs(dy) <= 1) roads[i] = 1;
          }
        }
    }
  };
  for (let i = 0; i + 1 < chain.length; i++) carve(chain[i].x, chain[i].y, chain[i + 1].x, chain[i + 1].y, true);

  // Gisements (uniquement sur la terre ferme).
  const nodes: OreNodeInit[] = [];
  const occupied = (tx: number, ty: number) =>
    nodes.some(o => Math.abs(o.tx - tx) <= 1 && Math.abs(o.ty - ty) <= 1);
  const addCluster = (x0: number, y0: number, tiles: number, perTile: number, kind: OreKind = 'gold') => {
    let placed = 0, attempts = 0;
    let x = x0, y = y0;
    while (placed < tiles && attempts < tiles * 30) {
      attempts++;
      if (x > 1 && y > 1 && x < w - 2 && y < h - 2 &&
          terrain[y * w + x] !== T_WATER && terrain[y * w + x] !== T_ROCK && !occupied(x, y)) {
        const amount = perTile * (0.8 + rng() * 0.4);
        nodes.push({ tx: x, ty: y, amount, max: amount, kind });
        placed++;
      }
      x = x0 + Math.round((rng() - 0.5) * 6);
      y = y0 + Math.round((rng() - 0.5) * 6);
    }
  };

  // 1) Gisement de départ pour chaque joueur.
  for (const s of starts) {
    const a = rng() * Math.PI * 2;
    addCluster(Math.round(s.x + Math.cos(a) * 8), Math.round(s.y + Math.sin(a) * 8), 7, 900 * oreScale);
  }
  // 2) Gros gisements stratégiques répartis dans les terres.
  const bigCount = 3 + Math.floor(oreScale) + Math.floor(playerCount / 4);
  for (let i = 0; i < bigCount && candidates.length > 0; i++) {
    const c = candidates[Math.floor(rng() * candidates.length)];
    const rare = rng() < 0.18;
    addCluster(c.x, c.y, rare ? 6 : 10, (rare ? 800 : 1800) * oreScale, rare ? 'rare' : 'gold');
  }
  // 3) Petits gisements secondaires.
  const smallCount = 6 + Math.floor(oreScale * 3) + playerCount;
  for (let i = 0; i < smallCount; i++) {
    const x = 2 + Math.floor(rng() * (w - 4));
    const y = 2 + Math.floor(rng() * (h - 4));
    if (terrain[y * w + x] === T_WATER) continue;
    const rare = rng() < 0.15;
    addCluster(x, y, rare ? 3 : 4, (rare ? 450 : 700) * oreScale, rare ? 'rare' : 'gold');
  }

  const relief = computeVisualRelief(w, h, terrain, roads, shade);
  const forestry = generateTrees(w, h, terrain, roads, starts, nodes, seed);
  return { w, h, terrain, roads, shade, ...relief, starts, nodes, theme, ...forestry };
}
