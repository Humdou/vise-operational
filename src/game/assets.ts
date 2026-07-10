// Pipeline raster Coalition 2045. Le manifeste est la source unique des
// sprites en jeu, des icônes HUD, du fantôme de pose et de la planche QA.
import { BUILDINGS, type BuildingTypeId } from './data';

// Disponible synchroniquement pour le picking avant la fin du préchargement.
export const BUILDING_HEIGHTS: Record<BuildingTypeId, number> = {
  hq: 3.25, power: 2.4, power2: 2.8, refinery: 1.8, refinery2: 2.05,
  barracks: 1.45, barracks2: 2.65, factory: 2.25, factory2: 2.65,
  radar: 3.0, radarcenter: 2.8, airport: 2.55, helipad: 1.55,
  turret: 1.0, atgun: 1.0, aa: 1.4, tech: 2.15, depot: 1.65, lab: 2.7,
};

export type BuildingEffectKind = 'smoke' | 'steam' | 'flame' | 'beacon' | 'weld';

interface Point { x: number; y: number }
type ManifestPoint = [number, number];

interface TeamMarkDef { points: ManifestPoint[]; opacity?: number }
interface EffectDef { kind: BuildingEffectKind; x: number; y: number; scale: number }
interface TurretDef { weapon: string; mount: ManifestPoint; scale: number }
interface BuildingDef {
  src: string;
  footprint: [number, number];
  pxPerTile: number;
  ax: number;
  ay: number;
  height: number;
  teamMarks?: TeamMarkDef[];
  effects?: EffectDef[];
  door?: ManifestPoint;
  turret?: TurretDef;
}
interface WeaponDef { src: string; pivot: ManifestPoint }
interface AssetManifest {
  version: number;
  style: string;
  buildings: Record<BuildingTypeId, BuildingDef>;
  weapons: Record<string, WeaponDef>;
}

export interface BuildingVisual {
  canvas: HTMLCanvasElement;
  pxPerTile: number;
  ax: number;
  ay: number;
  height: number;
  effects: EffectDef[];
  door?: Point;
  turret?: {
    canvas: HTMLCanvasElement;
    mount: Point;
    pivot: Point;
    scale: number;
  };
  ready: boolean;
}

let manifest: AssetManifest | null = null;
let preload: Promise<void> | null = null;
let revision = 0;
const bases = new Map<BuildingTypeId, HTMLImageElement>();
const weapons = new Map<string, HTMLImageElement>();
const visuals = new Map<string, BuildingVisual>();
const placeholders = new Map<BuildingTypeId, BuildingVisual>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Asset Coalition 2045 introuvable : ${src}`));
    img.src = src;
  });
}

export function preloadBuildingAssets(): Promise<void> {
  if (preload) return preload;
  if (typeof window === 'undefined') return Promise.resolve();
  preload = (async () => {
    const response = await fetch('/assets/buildings/manifest.json', { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Manifest bâtiments indisponible (${response.status})`);
    const next = await response.json() as AssetManifest;
    if (next.version !== 2) throw new Error(`Version de manifest bâtiments non supportée : ${next.version}`);
    manifest = next;
    await Promise.all([
      ...Object.entries(next.buildings).map(async ([id, def]) => {
        bases.set(id as BuildingTypeId, await loadImage(def.src));
      }),
      ...Object.entries(next.weapons).map(async ([id, def]) => {
        weapons.set(id, await loadImage(def.src));
      }),
    ]);
    visuals.clear();
    revision++;
  })().catch(error => {
    console.error('[Coalition 2045]', error);
    revision++;
  });
  return preload;
}

function tintSprite(img: HTMLImageElement, marks: TeamMarkDef[], team: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const c = canvas.getContext('2d')!;
  c.drawImage(img, 0, 0);
  c.save();
  for (const mark of marks) {
    if (mark.points.length < 3) continue;
    c.globalAlpha = mark.opacity ?? 0.72;
    c.fillStyle = team;
    c.beginPath();
    c.moveTo(mark.points[0][0], mark.points[0][1]);
    for (let i = 1; i < mark.points.length; i++) c.lineTo(mark.points[i][0], mark.points[i][1]);
    c.closePath();
    c.fill();
    c.globalAlpha = 0.42;
    c.strokeStyle = '#f2efe2';
    c.lineWidth = 1.5;
    c.stroke();
  }
  c.restore();
  return canvas;
}

function fallback(type: BuildingTypeId): BuildingVisual {
  const cached = placeholders.get(type);
  if (cached) return cached;
  const def = BUILDINGS[type];
  const px = 96;
  const canvas = document.createElement('canvas');
  canvas.width = (def.w + def.h) * px + 64;
  canvas.height = (def.w + def.h) * px / 2 + 96;
  const c = canvas.getContext('2d')!;
  const cx = canvas.width / 2, cy = canvas.height - 36;
  const rx = (def.w + def.h) * px / 2, ry = rx / 2;
  c.fillStyle = 'rgba(43,49,47,.92)';
  c.strokeStyle = '#c97b2d';
  c.lineWidth = 4;
  c.beginPath(); c.moveTo(cx, cy - ry); c.lineTo(cx + rx, cy); c.lineTo(cx, cy + ry); c.lineTo(cx - rx, cy); c.closePath(); c.fill(); c.stroke();
  c.strokeStyle = 'rgba(201,123,45,.8)'; c.lineWidth = 7;
  c.beginPath(); c.moveTo(cx - 28, cy - 16); c.lineTo(cx + 28, cy + 16); c.moveTo(cx + 28, cy - 16); c.lineTo(cx - 28, cy + 16); c.stroke();
  const visual: BuildingVisual = {
    canvas, pxPerTile: px, ax: cx, ay: cy, height: 1, effects: [], ready: false,
  };
  placeholders.set(type, visual);
  return visual;
}

export function getBuildingVisual(type: BuildingTypeId, team: string): BuildingVisual {
  void preloadBuildingAssets();
  const def = manifest?.buildings[type];
  const img = bases.get(type);
  if (!def || !img) return fallback(type);
  const key = `${type}:${team}`;
  const cached = visuals.get(key);
  if (cached) return cached;
  const canvas = tintSprite(img, def.teamMarks ?? [], team);
  let turret: BuildingVisual['turret'];
  if (def.turret) {
    const weaponDef = manifest?.weapons[def.turret.weapon];
    const weapon = weapons.get(def.turret.weapon);
    if (weaponDef && weapon) {
      turret = {
        canvas: tintSprite(weapon, [], team),
        mount: { x: def.turret.mount[0], y: def.turret.mount[1] },
        pivot: { x: weaponDef.pivot[0], y: weaponDef.pivot[1] },
        scale: def.turret.scale,
      };
    }
  }
  const visual: BuildingVisual = {
    canvas, pxPerTile: def.pxPerTile, ax: def.ax, ay: def.ay, height: def.height,
    effects: def.effects ?? [],
    door: def.door ? { x: def.door[0], y: def.door[1] } : undefined,
    turret,
    ready: true,
  };
  visuals.set(key, visual);
  return visual;
}

export function buildingAssetRevision(): number { return revision; }
export function buildingAssetsReady(): boolean { return manifest !== null && bases.size === Object.keys(BUILDINGS).length; }

if (typeof window !== 'undefined') void preloadBuildingAssets();
