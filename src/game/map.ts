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
  height: Float32Array;         // hauteur visuelle précalculée (aucun impact gameplay)
  light: Float32Array;          // lightmap terrain précalculée
  cliff: Uint8Array;            // bits N/E/S/W quand une tuile domine un voisin
  starts: { x: number; y: number }[];
  nodes: OreNodeInit[];
  theme: ThemeId;
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
      else if (t === T_ROCK) base = Math.max(base, 0.92); // massifs hauts → falaises franches
      else if (t === T_ROUGH) base += 0.05;               // contreforts un peu surélevés
    } else {
      base = 0.44;
      if (t === T_WATER) base = 0.10;
      else if (t === T_ROUGH) base = 0.66;
      else if (t === T_ROCK) base = 0.98;
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
  const rawAt = (x: number, y: number) => raw[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
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

      let mask = 0;
      const here = rawAt(x, y);
      if (here - rawAt(x, y - 1) > 0.09) mask |= CLIFF_N;
      if (here - rawAt(x + 1, y) > 0.09) mask |= CLIFF_E;
      if (here - rawAt(x, y + 1) > 0.09) mask |= CLIFF_S;
      if (here - rawAt(x - 1, y) > 0.09) mask |= CLIFF_W;
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
  const lakeCount = 1 + Math.floor(n / 90) + (theme === 'tropical' ? 2 : 0);
  for (let i = 0; i < lakeCount; i++) {
    blob(Math.floor(n * (0.2 + rng() * 0.6)), Math.floor(n * (0.2 + rng() * 0.6)), 4 + rng() * (n * 0.04), T_WATER);
  }
  // Massifs rocheux : barrières naturelles qui structurent les couloirs.
  const ridgeCount = 2 + Math.floor(n / 75);
  for (let i = 0; i < ridgeCount; i++) {
    blob(Math.floor(n * (0.15 + rng() * 0.7)), Math.floor(n * (0.15 + rng() * 0.7)), 3 + rng() * (n * 0.03), T_ROCK, 0.5);
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
  clear(Math.round(cx), Math.round(cy), Math.round(7 + n / 90));
  const midRingCount = Math.min(8, 2 + Math.floor(playerCount / 2));
  for (let i = 0; i < midRingCount; i++) {
    const a = baseAngle + (i / midRingCount) * Math.PI * 2 + 0.4;
    const zx = Math.round(cx + Math.cos(a) * n * 0.2);
    const zy = Math.round(cy + Math.sin(a) * n * 0.2);
    clear(zx, zy, Math.round(5 + n / 130));
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
            terrain[i] = T_GRASS;
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
  const segCount = 2 + Math.floor(n / 80);
  // certaines pistes relient des clairières neutres (mi-carte), d'autres sont libres
  for (let k = 0; k < segCount; k++) {
    const a = openZones.length > 1 && rng() < 0.5
      ? openZones[Math.floor(rng() * openZones.length)] : randLand();
    const b = randLand();
    if (Math.hypot(a.x - b.x, a.y - b.y) < n * 0.55) traceRoad(a.x, a.y, b.x, b.y);
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

  const relief = computeVisualRelief(n, n, terrain, roads, shade, elev);
  return { w: n, h: n, terrain, roads, shade, ...relief, starts, nodes, theme };
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
  return { w, h, terrain, roads, shade, ...relief, starts, nodes, theme };
}
