// Moteur de simulation : entités, ordres, économie, combat, brouillard, victoire.
import {
  UNITS, BUILDINGS, UPGRADES, DMG_MULT, PLAYER_COLORS, PLAYER_NAMES,
  UnitTypeId, BuildingTypeId, UpgradeId, Difficulty, ThemeId, MapSizeId,
  START_ORE, HARVEST_RATE, HARVESTER_CAPACITY, UNLOAD_TIME,
  REPAIR_HP_PER_SEC, REPAIR_ORE_PER_HP, ENGINEER_REPAIR_RATE,
  LOW_POWER_FACTOR, BUILD_RADIUS, FORWARD_BUILD_RADIUS, BOMBER_AMMO, BOMBER_REARM_TIME,
  SCOUT_REARM_TIME, RARE_ORE_MULT, DEPOT_RADIUS, DEPOT_INCOME_BONUS, DEPOT_UNLOAD_FACTOR,
  REFINERY2_INCOME_BONUS, REFINERY2_UNLOAD_FACTOR, KAMIKAZE_DMG, KAMIKAZE_SPLASH,
  SpecialMapId, WeaponDef,
} from './data';
import { generateMap, GameMap, OreKind, mulberry32, T_GRASS, T_ROUGH, T_WATER, T_ROCK } from './map';
import { NavGrid, findPath, fireLineClear } from './path';

export interface GameSettings {
  sizeId: MapSizeId;
  theme: ThemeId;
  opponents: number;       // 1 à 15
  difficulty: Difficulty;
  dayNight: boolean;
  special?: SpecialMapId | null; // carte spéciale (France, Italie…)
  seed?: number;
}

export type OrderKind = 'idle' | 'move' | 'attackmove' | 'attack' | 'harvest' | 'repair' | 'escort';

export interface Order {
  kind: OrderKind;
  x?: number;
  y?: number;
  targetId?: number;
  targetIsBuilding?: boolean;
  nodeId?: number;
  deliver?: boolean; // récolteur : forcer la livraison même cargaison partielle
}

export interface Unit {
  id: number;
  owner: number;
  type: UnitTypeId;
  x: number; y: number;
  dir: number;
  hp: number; maxHp: number;
  order: Order;
  path: { x: number; y: number }[] | null;
  pathI: number;
  repathT: number;
  stuckT: number;
  cd: number;
  engageId: number;          // cible de tir actuelle (0 = aucune)
  engageIsBuilding: boolean;
  cargo: number;
  cargoValue: number; // valeur de la cargaison (minerai rare = ×3)
  unloadT: number;
  // aviation
  airState?: 'pad' | 'fly' | 'return';
  padBuildingId?: number;
  ammo?: number;
  rearmT?: number;
  dead: boolean;
}

export interface QueueItem {
  kind: 'unit' | 'up';
  unit?: UnitTypeId;
  up?: UpgradeId;
  t: number;
  time: number;
  cost: number;
}

export interface Building {
  id: number;
  owner: number;
  type: BuildingTypeId;
  tx: number; ty: number; w: number; h: number;
  hp: number; maxHp: number;
  built: boolean;
  progress: number;
  queue: QueueItem[];
  rally: { x: number; y: number } | null;
  repairOn: boolean;
  cd: number;
  engageId: number;
  dead: boolean;
}

export interface OreNode {
  id: number;
  tx: number; ty: number;
  amount: number; max: number;
  kind: OreKind;
}

export interface Projectile {
  sx: number; sy: number;
  tx: number; ty: number;
  x: number; y: number;
  t: number;
  dist: number;
  speed: number;
  kind: WeaponDef['kind'];
  dmg: number;
  splash: number;
  indirect: boolean;
  owner: number;
  targetId: number;
  targetIsBuilding: boolean;
  targetIsAir: boolean;
}

export interface Effect {
  kind: 'boom' | 'flash' | 'spark' | 'dust';
  x: number; y: number;
  age: number; dur: number; r: number;
}

export interface GameEvent {
  type: 'shot' | 'explosion' | 'bigboom' | 'built' | 'trained' | 'alert' | 'research'
    | 'eliminated' | 'lowpower' | 'place' | 'takeoff';
  x?: number; y?: number;
  owner?: number;
  kind?: WeaponDef['kind'];  // pour les tirs : son selon l'arme
  unit?: UnitTypeId;         // pour la production : son selon l'unité
}

export interface PlayerStats {
  oreHarvested: number;
  unitsProduced: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsBuilt: number;
  buildingsLost: number;
  buildingsDestroyed: number;
  harvestersLost: number;
  maxArmy: number;
  valueKilled: number;
}

export interface Player {
  id: number;
  name: string;
  color: string;
  isHuman: boolean;
  difficulty: Difficulty;
  defeated: boolean;
  ore: number;
  powerProd: number;
  powerUse: number;
  energyRatio: number;
  upgrades: Partial<Record<UpgradeId, boolean>>;
  fog: Uint8Array;            // 0 inconnu, 1 exploré, 2 visible
  exploredCount: number;
  alertT: number;             // dernier moment où ce joueur a été attaqué
  alertX: number; alertY: number;
  stats: PlayerStats;
}

const FOG_INTERVAL = 0.25;
const ACQUIRE_BONUS = 1.6;    // portée d'acquisition au-delà de la portée d'arme

function emptyStats(): PlayerStats {
  return {
    oreHarvested: 0, unitsProduced: 0, unitsLost: 0, unitsKilled: 0,
    buildingsBuilt: 0, buildingsLost: 0, buildingsDestroyed: 0,
    harvestersLost: 0, maxArmy: 0, valueKilled: 0,
  };
}

export class Game {
  settings: GameSettings;
  map: GameMap;
  nav: NavGrid;
  buildGrid: Int32Array;       // id du bâtiment occupant chaque tuile (0 = libre)
  players: Player[] = [];
  units: Unit[] = [];
  buildings: Building[] = [];
  nodes: OreNode[] = [];
  projectiles: Projectile[] = [];
  effects: Effect[] = [];
  events: GameEvent[] = [];
  pings: { x: number; y: number; t: number }[] = [];
  unitById = new Map<number, Unit>();
  buildingById = new Map<number, Building>();
  nodeById = new Map<number, OreNode>();
  time = 0;
  over = false;
  winner = -1;
  nextId = 1;
  rng: () => number;
  private fogTimer = 0;
  private winTimer = 0;
  private hash = new Map<number, number[]>();
  private pathBudget = 0;
  humanAlertSoundT = -100;
  oreRegenPerSec: number;

  constructor(settings: GameSettings) {
    this.settings = settings;
    const seed = settings.seed ?? Math.floor(Math.random() * 1e9);
    this.rng = mulberry32(seed + 7);
    const count = 1 + settings.opponents;
    this.map = generateMap(settings.sizeId, settings.theme, count, seed, settings.special ?? undefined);
    // Régénération très lente, proportionnelle à la durée visée de la partie.
    this.oreRegenPerSec = 0.6;

    const { w, h, terrain } = this.map;
    this.buildGrid = new Int32Array(w * h);
    const pass = new Uint8Array(w * h);
    const cost = new Float32Array(w * h);
    const fireBlock = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const t = terrain[i];
      pass[i] = t === T_GRASS || t === T_ROUGH ? 1 : 0;
      cost[i] = t === T_ROUGH ? 1.6 : 1;
      fireBlock[i] = t === T_ROCK ? 1 : 0;
    }
    this.nav = { w, h, pass, cost, fireBlock };

    for (const n of this.map.nodes) {
      const node: OreNode = { id: this.nextId++, tx: n.tx, ty: n.ty, amount: n.amount, max: n.max, kind: n.kind };
      this.nodes.push(node);
      this.nodeById.set(node.id, node);
    }

    for (let i = 0; i < count; i++) {
      this.players.push({
        id: i,
        name: i === 0 ? PLAYER_NAMES[0] : `IA ${PLAYER_NAMES[i]}`,
        color: PLAYER_COLORS[i],
        isHuman: i === 0,
        difficulty: settings.difficulty,
        defeated: false,
        ore: START_ORE,
        powerProd: 0, powerUse: 0, energyRatio: 1,
        upgrades: {},
        fog: new Uint8Array(w * h),
        exploredCount: 0,
        alertT: -100, alertX: 0, alertY: 0,
        stats: emptyStats(),
      });
      const s = this.map.starts[i];
      const def = BUILDINGS.hq;
      this.createBuilding(i, 'hq', s.x - Math.floor(def.w / 2), s.y - Math.floor(def.h / 2), true);
    }
    for (const p of this.players) this.updateFog(p);
    this.recomputePower();
  }

  // ---------------------------------------------------------------- création

  private createBuilding(owner: number, type: BuildingTypeId, tx: number, ty: number, instant = false): Building {
    const def = BUILDINGS[type];
    const b: Building = {
      id: this.nextId++, owner, type, tx, ty, w: def.w, h: def.h,
      hp: instant ? def.hp : def.hp * 0.15, maxHp: def.hp,
      built: instant, progress: instant ? 1 : 0,
      queue: [], rally: null, repairOn: false, cd: 0, engageId: 0, dead: false,
    };
    this.buildings.push(b);
    this.buildingById.set(b.id, b);
    for (let y = ty; y < ty + def.h; y++)
      for (let x = tx; x < tx + def.w; x++) {
        const i = y * this.map.w + x;
        this.buildGrid[i] = b.id;
        this.nav.pass[i] = 0;
        this.nav.fireBlock[i] = 1;
      }
    return b;
  }

  spawnUnit(owner: number, type: UnitTypeId, x: number, y: number): Unit {
    const def = UNITS[type];
    const p = this.players[owner];
    let maxHp = def.hp;
    if (p.upgrades.armor && (def.armor === 'light' || def.armor === 'heavy') && !def.isAir) maxHp *= 1.1;
    const u: Unit = {
      id: this.nextId++, owner, type, x, y, dir: this.rng() * Math.PI * 2,
      hp: maxHp, maxHp,
      order: { kind: 'idle' }, path: null, pathI: 0, repathT: 0, stuckT: 0,
      cd: 0, engageId: 0, engageIsBuilding: false, cargo: 0, cargoValue: 0, unloadT: 0, dead: false,
    };
    if (def.isAir) { u.airState = 'pad'; u.ammo = BOMBER_AMMO; u.rearmT = 0; }
    this.units.push(u);
    this.unitById.set(u.id, u);
    p.stats.unitsProduced++;
    return u;
  }

  // --------------------------------------------------------------- requêtes

  buildingCenter(b: Building): { x: number; y: number } {
    return { x: b.tx + b.w / 2, y: b.ty + b.h / 2 };
  }

  countBuildings(owner: number, type: BuildingTypeId, builtOnly = true): number {
    let n = 0;
    for (const b of this.buildings)
      if (!b.dead && b.owner === owner && b.type === type && (!builtOnly || b.built)) n++;
    return n;
  }

  countUnits(owner: number, type?: UnitTypeId): number {
    let n = 0;
    for (const u of this.units)
      if (!u.dead && u.owner === owner && (!type || u.type === type)) n++;
    return n;
  }

  hasRadar(owner: number): boolean {
    return this.countBuildings(owner, 'radar') > 0 && this.players[owner].energyRatio >= 1;
  }

  isVisibleTo(owner: number, x: number, y: number): boolean {
    const tx = Math.round(x), ty = Math.round(y);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return false;
    return this.players[owner].fog[ty * this.map.w + tx] === 2;
  }

  isExploredBy(owner: number, x: number, y: number): boolean {
    const tx = Math.round(x), ty = Math.round(y);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return false;
    return this.players[owner].fog[ty * this.map.w + tx] >= 1;
  }

  buildingVisibleTo(owner: number, b: Building): boolean {
    for (let y = b.ty; y < b.ty + b.h; y++)
      for (let x = b.tx; x < b.tx + b.w; x++)
        if (this.players[owner].fog[y * this.map.w + x] === 2) return true;
    return false;
  }

  // Point d'un bâtiment le plus proche d'une position (pour portées).
  closestPointOfBuilding(b: Building, x: number, y: number): { x: number; y: number } {
    return {
      x: Math.max(b.tx, Math.min(b.tx + b.w, x)),
      y: Math.max(b.ty, Math.min(b.ty + b.h, y)),
    };
  }

  canBuild(owner: number, type: BuildingTypeId): { ok: boolean; reason: string } {
    const def = BUILDINGS[type];
    for (const pre of def.prereq)
      if (this.countBuildings(owner, pre) === 0)
        return { ok: false, reason: `Requiert : ${BUILDINGS[pre].name}` };
    if (this.players[owner].ore < def.cost) return { ok: false, reason: 'Minerai insuffisant' };
    return { ok: true, reason: '' };
  }

  canPlace(owner: number, type: BuildingTypeId, tx: number, ty: number): boolean {
    const def = BUILDINGS[type];
    const { w, h } = this.map;
    if (tx < 1 || ty < 1 || tx + def.w > w - 1 || ty + def.h > h - 1) return false;
    for (let y = ty; y < ty + def.h; y++)
      for (let x = tx; x < tx + def.w; x++) {
        const i = y * w + x;
        const t = this.map.terrain[i];
        if (t === T_WATER || t === T_ROCK) return false;
        if (this.buildGrid[i] !== 0) return false;
        if (this.players[owner].isHuman && this.players[owner].fog[i] === 0) return false;
      }
    for (const n of this.nodes)
      if (n.amount > 1 && n.tx >= tx - 1 && n.tx < tx + def.w + 1 && n.ty >= ty - 1 && n.ty < ty + def.h + 1) return false;
    // Pas d'unité au sol sur l'emprise.
    for (const u of this.units) {
      if (u.dead || UNITS[u.type].isAir) continue;
      if (u.x > tx - 0.5 && u.x < tx + def.w + 0.5 && u.y > ty - 0.5 && u.y < ty + def.h + 0.5) return false;
    }
    // Proximité : près d'un bâtiment allié, ou d'une unité alliée (avant-poste).
    const cx = tx + def.w / 2, cy = ty + def.h / 2;
    let near = false;
    for (const b of this.buildings) {
      if (b.dead || b.owner !== owner) continue;
      const c = this.buildingCenter(b);
      if (Math.hypot(c.x - cx, c.y - cy) <= BUILD_RADIUS + Math.max(b.w, b.h)) { near = true; break; }
    }
    if (!near) {
      for (const u of this.units) {
        if (u.dead || u.owner !== owner || UNITS[u.type].isAir) continue;
        if (Math.hypot(u.x - cx, u.y - cy) <= FORWARD_BUILD_RADIUS) { near = true; break; }
      }
    }
    return near;
  }

  place(owner: number, type: BuildingTypeId, tx: number, ty: number): boolean {
    if (!this.canBuild(owner, type).ok || !this.canPlace(owner, type, tx, ty)) return false;
    this.players[owner].ore -= BUILDINGS[type].cost;
    this.createBuilding(owner, type, tx, ty);
    this.events.push({ type: 'place', owner, x: tx, y: ty });
    return true;
  }

  // ------------------------------------------------------------- production

  canQueueUnit(buildingId: number, type: UnitTypeId): { ok: boolean; reason: string } {
    const b = this.buildingById.get(buildingId);
    if (!b || b.dead || !b.built) return { ok: false, reason: '' };
    const def = UNITS[type];
    if (def.builtAt !== b.type) return { ok: false, reason: '' };
    if (this.players[b.owner].ore < def.cost) return { ok: false, reason: 'Minerai insuffisant' };
    if (b.queue.length >= 5) return { ok: false, reason: 'File pleine' };
    if (type === 'bomber' || type === 'scoutplane') {
      let count = 0;
      for (const u of this.units) if (!u.dead && u.owner === b.owner && u.type === type && u.padBuildingId === b.id) count++;
      for (const q of b.queue) if (q.unit === type) count++;
      if (count >= 1) return { ok: false, reason: type === 'bomber' ? 'Un bombardier par aéroport' : 'Un avion radar par aéroport' };
    }
    return { ok: true, reason: '' };
  }

  queueUnit(buildingId: number, type: UnitTypeId): boolean {
    const chk = this.canQueueUnit(buildingId, type);
    if (!chk.ok) return false;
    const b = this.buildingById.get(buildingId)!;
    const def = UNITS[type];
    this.players[b.owner].ore -= def.cost;
    b.queue.push({ kind: 'unit', unit: type, t: 0, time: def.time, cost: def.cost });
    return true;
  }

  queueUpgrade(buildingId: number, up: UpgradeId): boolean {
    const b = this.buildingById.get(buildingId);
    if (!b || b.dead || !b.built || b.type !== 'tech') return false;
    const p = this.players[b.owner];
    const def = UPGRADES[up];
    if (p.upgrades[up] || p.ore < def.cost) return false;
    if (b.queue.some(q => q.up === up) || b.queue.length >= 3) return false;
    p.ore -= def.cost;
    b.queue.push({ kind: 'up', up, t: 0, time: def.time, cost: def.cost });
    return true;
  }

  cancelQueue(buildingId: number, index: number) {
    const b = this.buildingById.get(buildingId);
    if (!b || index >= b.queue.length) return;
    this.players[b.owner].ore += b.queue[index].cost;
    b.queue.splice(index, 1);
  }

  setRepair(buildingId: number, on: boolean) {
    const b = this.buildingById.get(buildingId);
    if (b && !b.dead && b.built) b.repairOn = on;
  }

  setRally(buildingId: number, x: number, y: number) {
    const b = this.buildingById.get(buildingId);
    if (b) b.rally = { x, y };
  }

  // ----------------------------------------------------------------- ordres

  cmdMove(ids: number[], x: number, y: number, attackMove = false) {
    const spots = this.formationSpots(x, y, ids.length);
    let i = 0;
    for (const id of ids) {
      const u = this.unitById.get(id);
      if (!u || u.dead) continue;
      const s = spots[Math.min(i++, spots.length - 1)];
      if (u.airState) { this.airOrder(u, { kind: attackMove ? 'attackmove' : 'move', x: s.x, y: s.y }); continue; }
      if (u.type === 'harvester' && attackMove) continue;
      const canFight = !!UNITS[u.type].weapon || u.type === 'kamikaze';
      u.order = { kind: attackMove && canFight ? 'attackmove' : 'move', x: s.x, y: s.y };
      u.engageId = 0;
      u.path = null;
      u.unloadT = 0;
    }
  }

  cmdAttack(ids: number[], targetId: number, targetIsBuilding: boolean) {
    for (const id of ids) {
      const u = this.unitById.get(id);
      if (!u || u.dead) continue;
      if (!UNITS[u.type].weapon && u.type !== 'kamikaze') continue;
      if (u.airState) { this.airOrder(u, { kind: 'attack', targetId, targetIsBuilding }); continue; }
      u.order = { kind: 'attack', targetId, targetIsBuilding };
      u.engageId = targetId;
      u.engageIsBuilding = targetIsBuilding;
      u.path = null;
    }
  }

  cmdHarvest(ids: number[], nodeId: number) {
    for (const id of ids) {
      const u = this.unitById.get(id);
      if (!u || u.dead || u.type !== 'harvester') continue;
      u.order = { kind: 'harvest', nodeId };
      u.path = null;
      u.unloadT = 0;
    }
  }

  cmdRepairTarget(ids: number[], targetId: number, targetIsBuilding: boolean) {
    for (const id of ids) {
      const u = this.unitById.get(id);
      if (!u || u.dead || u.type !== 'engineer') continue;
      u.order = { kind: 'repair', targetId, targetIsBuilding };
      u.path = null;
    }
  }

  // Escorter une unité alliée : suivre, protéger, revenir.
  cmdEscort(ids: number[], targetId: number) {
    const target = this.unitById.get(targetId);
    if (!target || target.dead) return;
    for (const id of ids) {
      if (id === targetId) continue;
      const u = this.unitById.get(id);
      if (!u || u.dead || u.airState) continue;
      if (u.owner !== target.owner) continue;
      u.order = { kind: 'escort', targetId };
      u.engageId = 0;
      u.path = null;
    }
  }

  cmdStop(ids: number[]) {
    for (const id of ids) {
      const u = this.unitById.get(id);
      if (!u || u.dead) continue;
      if (u.airState && u.airState !== 'pad') { this.airOrder(u, { kind: 'move' }); continue; }
      u.order = { kind: 'idle' };
      u.path = null;
      u.engageId = 0;
    }
  }

  private airOrder(u: Unit, order: Order) {
    if (u.type === 'scoutplane') {
      // L'avion radar vole vers n'importe quel point puis rentre seul.
      if ((order.kind === 'move' || order.kind === 'attackmove' || order.kind === 'attack')
          && order.x !== undefined && (u.rearmT ?? 0) <= 0) {
        if (u.airState === 'pad') this.events.push({ type: 'takeoff', owner: u.owner, x: u.x, y: u.y });
        u.order = { kind: 'move', x: order.x, y: order.y };
        u.airState = 'fly';
      } else if (order.kind === 'move' && order.x === undefined) {
        u.order = { kind: 'idle' };
        u.airState = 'return';
      }
      return;
    }
    if (order.kind === 'attack' || order.kind === 'attackmove') {
      if ((u.ammo ?? 0) > 0 && (u.rearmT ?? 0) <= 0) {
        if (u.airState === 'pad') this.events.push({ type: 'takeoff', owner: u.owner, x: u.x, y: u.y });
        u.order = order;
        u.airState = 'fly';
      }
    } else {
      // move/stop : retour au hangar
      u.order = { kind: 'idle' };
      u.airState = 'return';
    }
  }

  private formationSpots(x: number, y: number, count: number): { x: number; y: number }[] {
    if (count <= 1) return [{ x, y }];
    const spots: { x: number; y: number }[] = [];
    const side = Math.ceil(Math.sqrt(count));
    const space = 1.0;
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / side), c = i % side;
      spots.push({
        x: x + (c - (side - 1) / 2) * space,
        y: y + (r - (side - 1) / 2) * space,
      });
    }
    return spots;
  }

  // --------------------------------------------------------------- recherche

  nearestNode(x: number, y: number, owner: number, requireExplored = true): OreNode | null {
    let best: OreNode | null = null, bestD = Infinity;
    for (const n of this.nodes) {
      if (n.amount < 20) continue;
      if (requireExplored && !this.isExploredBy(owner, n.tx, n.ty)) continue;
      const d = Math.hypot(n.tx - x, n.ty - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // Meilleur gisement pour un récolteur : pondère richesse (rare ×3), distance
  // et nombre de récolteurs alliés déjà assignés (évite l'entassement).
  bestNodeFor(owner: number, x: number, y: number, excludeId = 0): OreNode | null {
    const assigned = new Map<number, number>();
    for (const u of this.units) {
      if (u.dead || u.owner !== owner || u.type !== 'harvester') continue;
      const nid = u.order.nodeId;
      if (nid) assigned.set(nid, (assigned.get(nid) ?? 0) + 1);
    }
    let best: OreNode | null = null, bestScore = -Infinity;
    let fallback: OreNode | null = null, fallbackD = Infinity;
    for (const n of this.nodes) {
      if (n.id === excludeId || n.amount < 15) continue;
      if (!this.isExploredBy(owner, n.tx, n.ty)) continue;
      const d = Math.hypot(n.tx - x, n.ty - y);
      if (d < fallbackD) { fallbackD = d; fallback = n; }
      if (n.amount < 80) continue; // les fonds de gisement ne valent pas le détour
      const value = n.amount * (n.kind === 'rare' ? RARE_ORE_MULT : 1);
      const score = value - d * 26 - (assigned.get(n.id) ?? 0) * 220;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best ?? fallback;
  }

  nearestRefinery(owner: number, x: number, y: number): Building | null {
    let best: Building | null = null, bestD = Infinity;
    for (const b of this.buildings) {
      if (b.dead || !b.built || b.owner !== owner) continue;
      if (b.type !== 'refinery' && b.type !== 'refinery2') continue;
      const c = this.buildingCenter(b);
      let d = Math.hypot(c.x - x, c.y - y);
      // La raffinerie T2 rapporte plus : légère préférence à distance similaire.
      if (b.type === 'refinery2') d *= 0.8;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  findFreeTileNear(x: number, y: number): { x: number; y: number } {
    const { w, h } = this.map;
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = Math.round(x) + dx, ty = Math.round(y) + dy;
          if (tx < 1 || ty < 1 || tx >= w - 1 || ty >= h - 1) continue;
          if (this.nav.pass[ty * w + tx]) return { x: tx, y: ty };
        }
    }
    return { x, y };
  }

  // ------------------------------------------------------------------ tick

  update(dt: number) {
    if (this.over) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.pathBudget = 20;

    this.rebuildHash();
    this.updateProduction(dt);
    this.updateUnits(dt);
    this.updateBuildingWeapons(dt);
    this.updateProjectiles(dt);
    this.updateRepairs(dt);
    this.updateOre(dt);
    this.updateEffects(dt);

    this.fogTimer -= dt;
    if (this.fogTimer <= 0) {
      this.fogTimer = FOG_INTERVAL;
      for (const p of this.players) if (!p.defeated) this.updateFog(p);
    }

    this.winTimer -= dt;
    if (this.winTimer <= 0) {
      this.winTimer = 0.5;
      this.recomputePower();
      this.checkVictory();
      for (const p of this.players) {
        if (p.defeated) continue;
        let army = 0;
        for (const u of this.units)
          if (!u.dead && u.owner === p.id && UNITS[u.type].weapon) army++;
        if (army > p.stats.maxArmy) p.stats.maxArmy = army;
      }
    }

    this.sweepDead();
  }

  // ------------------------------------------------------------- spatial hash

  private cellOf(x: number, y: number): number {
    return (Math.floor(y / 4) * 1024 + Math.floor(x / 4));
  }

  private rebuildHash() {
    this.hash.clear();
    for (const u of this.units) {
      if (u.dead) continue;
      const c = this.cellOf(u.x, u.y);
      let arr = this.hash.get(c);
      if (!arr) { arr = []; this.hash.set(c, arr); }
      arr.push(u.id);
    }
  }

  unitsNear(x: number, y: number, r: number, out: Unit[] = []): Unit[] {
    out.length = 0;
    const c0x = Math.floor((x - r) / 4), c1x = Math.floor((x + r) / 4);
    const c0y = Math.floor((y - r) / 4), c1y = Math.floor((y + r) / 4);
    for (let cy = c0y; cy <= c1y; cy++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const arr = this.hash.get(cy * 1024 + cx);
        if (!arr) continue;
        for (const id of arr) {
          const u = this.unitById.get(id);
          if (u && !u.dead && Math.hypot(u.x - x, u.y - y) <= r) out.push(u);
        }
      }
    return out;
  }

  // --------------------------------------------------------------- production

  private updateProduction(dt: number) {
    for (const b of this.buildings) {
      if (b.dead) continue;
      const p = this.players[b.owner];
      const ratio = p.energyRatio;

      if (!b.built) {
        const def = BUILDINGS[b.type];
        const d = (dt / def.time) * ratio;
        b.progress = Math.min(1, b.progress + d);
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.85 * d);
        if (b.progress >= 1) {
          b.built = true;
          p.stats.buildingsBuilt++;
          this.recomputePower();
          this.events.push({ type: 'built', owner: b.owner, x: b.tx, y: b.ty });
          if (b.type === 'refinery' || b.type === 'refinery2') {
            const c = this.buildingCenter(b);
            const spot = this.findFreeTileNear(c.x, b.ty + b.h + 0.5);
            const harv = this.spawnUnit(b.owner, 'harvester', spot.x, spot.y);
            const node = this.bestNodeFor(b.owner, harv.x, harv.y);
            if (node) harv.order = { kind: 'harvest', nodeId: node.id };
          }
        }
        continue;
      }

      if (b.queue.length > 0) {
        const item = b.queue[0];
        item.t += dt * ratio;
        if (item.t >= item.time) {
          b.queue.shift();
          if (item.kind === 'unit' && item.unit) {
            const def = UNITS[item.unit];
            if (def.isAir) {
              const c = this.buildingCenter(b);
              const u = this.spawnUnit(b.owner, item.unit, c.x, c.y);
              u.padBuildingId = b.id;
            } else {
              const spot = this.findFreeTileNear(b.tx + b.w / 2, b.ty + b.h + 0.5);
              const u = this.spawnUnit(b.owner, item.unit, spot.x, spot.y);
              if (item.unit === 'harvester') {
                const node = this.bestNodeFor(b.owner, u.x, u.y);
                if (node) u.order = { kind: 'harvest', nodeId: node.id };
              } else if (b.rally) {
                u.order = {
                  kind: def.weapon ? 'attackmove' : 'move',
                  x: b.rally.x + (this.rng() - 0.5) * 2,
                  y: b.rally.y + (this.rng() - 0.5) * 2,
                };
              }
            }
            this.events.push({ type: 'trained', owner: b.owner, unit: item.unit });
          } else if (item.kind === 'up' && item.up) {
            const pl = this.players[b.owner];
            pl.upgrades[item.up] = true;
            if (item.up === 'armor') {
              for (const u of this.units) {
                if (u.dead || u.owner !== b.owner) continue;
                const ud = UNITS[u.type];
                if ((ud.armor === 'light' || ud.armor === 'heavy') && !ud.isAir) {
                  const f = u.hp / u.maxHp;
                  u.maxHp = ud.hp * 1.1;
                  u.hp = u.maxHp * f;
                }
              }
            }
            this.recomputePower();
            this.events.push({ type: 'research', owner: b.owner });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ unités

  private scratch: Unit[] = [];

  private updateUnits(dt: number) {
    for (const u of this.units) {
      if (u.dead) continue;
      if (u.cd > 0) u.cd -= dt;
      if (u.airState) { this.updateAircraft(u, dt); continue; }
      const def = UNITS[u.type];

      // Kamikaze : logique dédiée (fonce et explose au contact).
      if (u.type === 'kamikaze' && (u.order.kind === 'attack' || u.order.kind === 'attackmove')) {
        this.updateKamikaze(u, dt);
        continue;
      }

      switch (u.order.kind) {
        case 'idle': {
          if (def.weapon) {
            this.autoAcquire(u, def.weapon);
            if (u.engageId) this.engageTarget(u, def.weapon, dt, false);
          }
          if (u.type === 'harvester') {
            // Un récolteur ne reste jamais les bras croisés si du minerai est connu.
            if (u.cargo > 0) u.order = { kind: 'harvest', deliver: true };
            else if (u.repathT > 0) u.repathT -= dt;
            else {
              u.repathT = 2.5;
              const node = this.bestNodeFor(u.owner, u.x, u.y);
              if (node) u.order = { kind: 'harvest', nodeId: node.id };
            }
          }
          break;
        }
        case 'move': {
          this.moveAlong(u, u.order.x!, u.order.y!, dt, () => { u.order = { kind: 'idle' }; });
          break;
        }
        case 'attackmove': {
          if (def.weapon) {
            if (!u.engageId) this.autoAcquire(u, def.weapon);
            if (u.engageId) {
              const done = this.engageTarget(u, def.weapon, dt, true);
              if (done) u.engageId = 0;
              break;
            }
          }
          this.moveAlong(u, u.order.x!, u.order.y!, dt, () => { u.order = { kind: 'idle' }; });
          break;
        }
        case 'attack': {
          if (!def.weapon) { u.order = { kind: 'idle' }; break; }
          u.engageId = u.order.targetId!;
          u.engageIsBuilding = !!u.order.targetIsBuilding;
          const done = this.engageTarget(u, def.weapon, dt, true);
          if (done) u.order = { kind: 'idle' };
          break;
        }
        case 'harvest': this.updateHarvester(u, dt); break;
        case 'repair': this.updateEngineer(u, dt); break;
        case 'escort': this.updateEscort(u, dt); break;
      }
    }
  }

  // Escorte : rester près du protégé, engager les menaces, revenir (laisse courte).
  private updateEscort(u: Unit, dt: number) {
    const target = this.unitById.get(u.order.targetId!);
    if (!target || target.dead) { u.order = { kind: 'idle' }; return; }
    const def = UNITS[u.type];
    const dTarget = Math.hypot(target.x - u.x, target.y - u.y);

    if (def.weapon) {
      // Menace proche du protégé ou de l'escorte ?
      if (!u.engageId) {
        const w = def.weapon;
        const threats = this.unitsNear(target.x, target.y, 7, this.scratch);
        let best: Unit | null = null, bestD = Infinity;
        for (const t of threats) {
          if (t.owner === u.owner || t.dead || this.players[t.owner].defeated) continue;
          if (!UNITS[t.type].weapon) continue;
          if (UNITS[t.type].isAir && t.airState !== 'pad') continue;
          if (!this.isVisibleTo(u.owner, t.x, t.y)) continue;
          if (DMG_MULT[w.kind][UNITS[t.type].armor] <= 0.05) continue;
          const d = Math.hypot(t.x - target.x, t.y - target.y);
          if (d < bestD) { bestD = d; best = t; }
        }
        if (best) { u.engageId = best.id; u.engageIsBuilding = false; }
      }
      if (u.engageId) {
        // Laisse : ne jamais s'éloigner à plus de 9 tuiles du protégé.
        if (dTarget > 9) { u.engageId = 0; }
        else {
          const done = this.engageTarget(u, def.weapon, dt, true);
          if (done) u.engageId = 0;
          return;
        }
      }
    }

    // Suivre en formation lâche autour du protégé.
    if (dTarget > 2.2) {
      const slot = (u.id % 6) / 6 * Math.PI * 2;
      this.moveAlong(u, target.x + Math.cos(slot) * 1.6, target.y + Math.sin(slot) * 1.6, dt, () => {});
    } else {
      u.path = null;
    }
  }

  // ---------------------------------------------------------------- kamikaze

  private updateKamikaze(u: Unit, dt: number) {
    const o = u.order;
    // Cible directe : entité ; sinon (attaque-déplacement) acquérir en chemin.
    let tx = o.x ?? u.x, ty = o.y ?? u.y;
    let hasTarget = false, contact = 1.0;
    if (o.kind === 'attack') {
      if (o.targetIsBuilding) {
        const b = this.buildingById.get(o.targetId!);
        if (!b || b.dead) { u.order = { kind: 'idle' }; return; }
        const cp = this.closestPointOfBuilding(b, u.x, u.y);
        tx = cp.x; ty = cp.y; hasTarget = true; contact = 1.1;
      } else {
        const t = this.unitById.get(o.targetId!);
        if (!t || t.dead || (UNITS[t.type].isAir && t.airState !== 'pad')) { u.order = { kind: 'idle' }; return; }
        tx = t.x; ty = t.y; hasTarget = true; contact = 0.8 + UNITS[t.type].radius;
      }
    } else {
      // attaque-déplacement : se jeter sur le premier ennemi visible proche
      const near = this.unitsNear(u.x, u.y, 6, this.scratch);
      let best: Unit | null = null, bestD = Infinity;
      for (const t of near) {
        if (t.owner === u.owner || t.dead || this.players[t.owner].defeated) continue;
        if (UNITS[t.type].isAir && t.airState !== 'pad') continue;
        if (!this.isVisibleTo(u.owner, t.x, t.y)) continue;
        const d = Math.hypot(t.x - u.x, t.y - u.y);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best) { u.order = { kind: 'attack', targetId: best.id, targetIsBuilding: false }; return; }
      for (const b of this.buildings) {
        if (b.dead || b.owner === u.owner || this.players[b.owner].defeated) continue;
        const cp = this.closestPointOfBuilding(b, u.x, u.y);
        if (Math.hypot(cp.x - u.x, cp.y - u.y) <= 6 && this.buildingVisibleTo(u.owner, b)) {
          u.order = { kind: 'attack', targetId: b.id, targetIsBuilding: true };
          return;
        }
      }
    }
    const d = Math.hypot(tx - u.x, ty - u.y);
    if (hasTarget && d <= contact) { this.detonateKamikaze(u); return; }
    if (!hasTarget && d <= 0.4) { u.order = { kind: 'idle' }; return; }
    this.moveAlong(u, tx, ty, dt, () => { if (!hasTarget) u.order = { kind: 'idle' }; });
  }

  private detonateKamikaze(u: Unit) {
    const x = u.x, y = u.y;
    this.killUnit(u, -1);
    this.effects.push({ kind: 'boom', x, y, age: 0, dur: 0.7, r: KAMIKAZE_SPLASH * 0.8 });
    this.events.push({ type: 'bigboom', x, y });
    // Dégâts de zone (type bombe) sur unités et bâtiments ennemis.
    const near = this.unitsNear(x, y, KAMIKAZE_SPLASH + 0.5, []);
    for (const t of near) {
      if (t.owner === u.owner || t.dead) continue;
      if (UNITS[t.type].isAir && t.airState !== 'pad') continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d > KAMIKAZE_SPLASH) continue;
      const fall = 1 - (d / KAMIKAZE_SPLASH) * 0.6;
      this.damageUnit(t, KAMIKAZE_DMG * DMG_MULT.bomb[UNITS[t.type].armor] * fall, u.owner);
    }
    for (const b of this.buildings) {
      if (b.dead || b.owner === u.owner) continue;
      const cp = this.closestPointOfBuilding(b, x, y);
      const d = Math.hypot(cp.x - x, cp.y - y);
      if (d > KAMIKAZE_SPLASH) continue;
      const fall = 1 - (d / KAMIKAZE_SPLASH) * 0.6;
      this.damageBuilding(b, KAMIKAZE_DMG * DMG_MULT.bomb.building * fall, u.owner);
    }
  }

  // Cherche une cible automatiquement (unités au sol).
  private autoAcquire(u: Unit, w: WeaponDef) {
    if (!w.targetsGround) return;
    const range = w.range + ACQUIRE_BONUS;
    const candidates = this.unitsNear(u.x, u.y, range, this.scratch);
    let best: Unit | null = null, bestScore = -Infinity;
    for (const t of candidates) {
      if (t.owner === u.owner || t.dead) continue;
      if (this.players[t.owner].defeated) continue;
      if (UNITS[t.type].isAir && t.airState !== 'pad') continue;
      if (!this.isVisibleTo(u.owner, t.x, t.y)) continue;
      const mult = DMG_MULT[w.kind][UNITS[t.type].armor];
      if (mult <= 0.05) continue;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      const score = mult * 10 - d;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best) {
      u.engageId = best.id;
      u.engageIsBuilding = false;
      return;
    }
    // Bâtiments ennemis à portée.
    for (const b of this.buildings) {
      if (b.dead || b.owner === u.owner || this.players[b.owner].defeated) continue;
      const cp = this.closestPointOfBuilding(b, u.x, u.y);
      const d = Math.hypot(cp.x - u.x, cp.y - u.y);
      if (d <= range && this.buildingVisibleTo(u.owner, b)) {
        u.engageId = b.id;
        u.engageIsBuilding = true;
        return;
      }
    }
  }

  // Poursuit et tire sur la cible. Retourne true si la cible n'existe plus.
  private engageTarget(u: Unit, w: WeaponDef, dt: number, chase: boolean): boolean {
    let tx: number, ty: number, talive = false, isAirTarget = false;
    if (u.engageIsBuilding) {
      const b = this.buildingById.get(u.engageId);
      if (b && !b.dead) {
        const cp = this.closestPointOfBuilding(b, u.x, u.y);
        tx = cp.x; ty = cp.y; talive = true;
      } else { tx = u.x; ty = u.y; }
    } else {
      const t = this.unitById.get(u.engageId);
      if (t && !t.dead) {
        tx = t.x; ty = t.y; talive = true;
        isAirTarget = !!UNITS[t.type].isAir && t.airState !== 'pad';
      } else { tx = u.x; ty = u.y; }
    }
    if (!talive) { u.engageId = 0; return true; }
    if (isAirTarget && !w.targetsAir) { u.engageId = 0; return true; }

    const d = Math.hypot(tx - u.x, ty - u.y);
    const inRange = d <= w.range && (!w.minRange || d >= w.minRange);
    const clear = w.indirect || isAirTarget ||
      fireLineClear(this.nav, u.x, u.y, tx, ty) || (u.engageIsBuilding && d <= w.range);

    if (inRange && clear) {
      u.path = null;
      u.dir = Math.atan2(ty - u.y, tx - u.x);
      if (u.cd <= 0) this.fire(u.owner, u.x, u.y, tx, ty, w, u.engageId, u.engageIsBuilding, isAirTarget, u);
      return false;
    }
    if (!chase) { if (d > w.range + ACQUIRE_BONUS + 1) u.engageId = 0; return false; }
    // Trop loin / pas de ligne de tir : avancer vers la cible.
    this.moveAlong(u, tx, ty, dt, () => {});
    return false;
  }

  private fire(
    owner: number, sx: number, sy: number, tx: number, ty: number,
    w: WeaponDef, targetId: number, targetIsBuilding: boolean, targetIsAir: boolean, shooter: Unit | null,
  ) {
    if (shooter) shooter.cd = w.cooldown;
    // Anticipation + dispersion : les cibles mobiles peuvent esquiver.
    let aimX = tx, aimY = ty;
    if (!targetIsBuilding) {
      const t = this.unitById.get(targetId);
      if (t && t.path && t.pathI < (t.path?.length ?? 0)) {
        const err = 0.55;
        aimX += (this.rng() - 0.5) * 2 * err;
        aimY += (this.rng() - 0.5) * 2 * err;
      }
    }
    const dist = Math.max(0.2, Math.hypot(aimX - sx, aimY - sy));
    const p = this.players[owner];
    const dmg = w.dmg * (p.upgrades.ammo ? 1.1 : 1);
    this.projectiles.push({
      sx, sy, tx: aimX, ty: aimY, x: sx, y: sy, t: 0, dist,
      speed: w.projSpeed, kind: w.kind, dmg, splash: w.splash ?? 0,
      indirect: !!w.indirect, owner, targetId, targetIsBuilding, targetIsAir,
    });
    this.events.push({ type: 'shot', x: sx, y: sy, owner, kind: w.kind });
    this.effects.push({ kind: 'flash', x: sx, y: sy, age: 0, dur: 0.08, r: 0.3 });
  }

  // ---------------------------------------------------------------- mouvement

  private moveAlong(u: Unit, tx: number, ty: number, dt: number, onArrive: () => void) {
    const def = UNITS[u.type];
    const arriveDist = 0.35;

    if (Math.hypot(tx - u.x, ty - u.y) <= arriveDist) { u.path = null; onArrive(); return; }

    if (!u.path || u.pathI >= u.path.length) {
      if (u.repathT > 0) { u.repathT -= dt; return; }
      if (this.pathBudget <= 0) { u.repathT = 0.15; return; }
      this.pathBudget--;
      const path = findPath(this.nav, u.x, u.y, tx, ty);
      if (!path || path.length === 0) { u.repathT = 1.2; onArrive(); return; }
      u.path = path;
      u.pathI = 0;
      u.stuckT = 0;
    }

    const wp = u.path[u.pathI];
    const dx = wp.x - u.x, dy = wp.y - u.y;
    const d = Math.hypot(dx, dy);
    const last = u.pathI === u.path.length - 1;
    if (d < (last ? arriveDist : 0.45)) {
      u.pathI++;
      if (u.pathI >= u.path.length) { u.path = null; onArrive(); }
      return;
    }

    const ti = Math.round(u.y) * this.map.w + Math.round(u.x);
    const terrainFactor = this.map.terrain[ti] === T_ROUGH ? 0.72 : 1;
    const speed = def.speed * terrainFactor;
    let vx = (dx / d) * speed, vy = (dy / d) * speed;

    // Séparation douce entre unités proches.
    const near = this.unitsNear(u.x, u.y, 1.1, this.scratch);
    for (const o of near) {
      if (o === u || o.airState) continue;
      const ox = u.x - o.x, oy = u.y - o.y;
      const od = Math.hypot(ox, oy);
      const minD = def.radius + UNITS[o.type].radius + 0.12;
      if (od < minD && od > 0.001) {
        const push = (minD - od) / minD * 2.2;
        vx += (ox / od) * push;
        vy += (oy / od) * push;
      }
    }

    let nx = u.x + vx * dt, ny = u.y + vy * dt;
    const txi = Math.round(nx), tyi = Math.round(ny);
    if (txi < 0 || tyi < 0 || txi >= this.map.w || tyi >= this.map.h ||
        !this.nav.pass[tyi * this.map.w + txi]) {
      // Glissement le long de l'obstacle.
      const xOk = this.nav.pass[Math.round(u.y) * this.map.w + Math.round(nx)] === 1;
      const yOk = this.nav.pass[Math.round(ny) * this.map.w + Math.round(u.x)] === 1;
      if (xOk) { ny = u.y; }
      else if (yOk) { nx = u.x; }
      else {
        u.stuckT += dt;
        if (u.stuckT > 0.8) { u.path = null; u.repathT = 0.1; u.stuckT = 0; }
        return;
      }
    }
    u.dir = Math.atan2(ny - u.y, nx - u.x);
    u.x = nx; u.y = ny;
  }

  // ---------------------------------------------------------------- récolteur

  private updateHarvester(u: Unit, dt: number) {
    const o = u.order;

    // ---- livraison (cargaison pleine, ou livraison forcée après un gisement vidé)
    if (u.cargo >= HARVESTER_CAPACITY || (o.deliver && u.cargo > 0)) {
      const ref = this.nearestRefinery(u.owner, u.x, u.y);
      if (!ref) { u.order = { kind: 'idle' }; return; }
      const dock = this.closestPointOfBuilding(ref, u.x, u.y);
      // Dépôt logistique proche : revenus +15 % et déchargement accéléré.
      const refC = this.buildingCenter(ref);
      let hasDepot = false;
      for (const b of this.buildings) {
        if (b.dead || !b.built || b.owner !== u.owner || b.type !== 'depot') continue;
        const c = this.buildingCenter(b);
        if (Math.hypot(c.x - refC.x, c.y - refC.y) <= DEPOT_RADIUS) { hasDepot = true; break; }
      }
      const isT2 = ref.type === 'refinery2';
      if (Math.hypot(dock.x - u.x, dock.y - u.y) < 1.4) {
        u.path = null;
        u.unloadT += dt;
        u.dir = Math.atan2(ref.ty + ref.h / 2 - u.y, ref.tx + ref.w / 2 - u.x);
        if (u.unloadT >= UNLOAD_TIME * (hasDepot ? DEPOT_UNLOAD_FACTOR : 1) * (isT2 ? REFINERY2_UNLOAD_FACTOR : 1)) {
          const p = this.players[u.owner];
          const credit = u.cargoValue
            * (p.upgrades.refining ? 1.15 : 1)
            * (hasDepot ? DEPOT_INCOME_BONUS : 1)
            * (isT2 ? REFINERY2_INCOME_BONUS : 1);
          p.ore += credit;
          p.stats.oreHarvested += credit;
          u.cargo = 0;
          u.cargoValue = 0;
          u.unloadT = 0;
          o.deliver = false;
          // Repartir vers le meilleur gisement connu.
          if (!this.validNode(o.nodeId)) {
            const n = this.bestNodeFor(u.owner, u.x, u.y);
            if (n) o.nodeId = n.id; else { u.order = { kind: 'idle' }; return; }
          }
        }
      } else {
        this.moveAlong(u, dock.x, dock.y, dt, () => {});
      }
      return;
    }

    // ---- choisir / valider le gisement
    if (!this.validNode(o.nodeId)) {
      const n = this.bestNodeFor(u.owner, u.x, u.y, o.nodeId ?? 0);
      if (n) { o.nodeId = n.id; }
      else if (u.cargo > 0) { o.deliver = true; return; }
      else { u.order = { kind: 'idle' }; return; }
    }
    const node = this.nodeById.get(o.nodeId!)!;

    // ---- gisement presque vide : changer automatiquement au lieu de gratter
    // les miettes de la régénération (c'était le bug des récolteurs "inutiles").
    if (node.amount < 30) {
      const better = this.bestNodeFor(u.owner, u.x, u.y, node.id);
      if (better && better.id !== node.id && better.amount >= 80) {
        o.nodeId = better.id;
        u.path = null;
      } else if (u.cargo > HARVESTER_CAPACITY * 0.25) {
        o.deliver = true;
        return;
      }
    }

    const d = Math.hypot(node.tx - u.x, node.ty - u.y);
    if (d < 1.25) {
      u.path = null;
      const take = Math.min(HARVEST_RATE * dt, node.amount, HARVESTER_CAPACITY - u.cargo);
      node.amount -= take;
      u.cargo += take;
      u.cargoValue += take * (node.kind === 'rare' ? RARE_ORE_MULT : 1);
      u.dir = Math.atan2(node.ty - u.y, node.tx - u.x);
    } else {
      this.moveAlong(u, node.tx, node.ty, dt, () => {});
    }
  }

  private validNode(nodeId?: number): boolean {
    if (!nodeId) return false;
    const n = this.nodeById.get(nodeId);
    return !!n && n.amount >= 15;
  }

  // ---------------------------------------------------------------- ingénieur

  private updateEngineer(u: Unit, dt: number) {
    const o = u.order;
    const p = this.players[u.owner];
    const rate = ENGINEER_REPAIR_RATE * (p.upgrades.repairs ? 1.25 : 1);
    if (o.targetIsBuilding) {
      const b = this.buildingById.get(o.targetId!);
      if (!b || b.dead || b.owner !== u.owner || b.hp >= b.maxHp) { u.order = { kind: 'idle' }; return; }
      const cp = this.closestPointOfBuilding(b, u.x, u.y);
      if (Math.hypot(cp.x - u.x, cp.y - u.y) < 1.1) {
        u.path = null;
        b.hp = Math.min(b.maxHp, b.hp + rate * dt);
        this.effects.push({ kind: 'spark', x: cp.x, y: cp.y, age: 0, dur: 0.3, r: 0.2 });
      } else this.moveAlong(u, cp.x, cp.y, dt, () => {});
    } else {
      const t = this.unitById.get(o.targetId!);
      if (!t || t.dead || t.owner !== u.owner || t.hp >= t.maxHp) { u.order = { kind: 'idle' }; return; }
      if (Math.hypot(t.x - u.x, t.y - u.y) < 1.1) {
        u.path = null;
        t.hp = Math.min(t.maxHp, t.hp + rate * 0.7 * dt);
        this.effects.push({ kind: 'spark', x: t.x, y: t.y, age: 0, dur: 0.3, r: 0.2 });
      } else this.moveAlong(u, t.x, t.y, dt, () => {});
    }
  }

  // ------------------------------------------------------------------ avions

  private updateAircraft(u: Unit, dt: number) {
    const def = UNITS[u.type];
    const pad = u.padBuildingId ? this.buildingById.get(u.padBuildingId) : undefined;

    if (!pad || pad.dead) {
      // Chercher un autre aéroport libre, sinon crash.
      let found: Building | null = null;
      for (const b of this.buildings) {
        if (b.dead || !b.built || b.owner !== u.owner || b.type !== 'airport') continue;
        let taken = false;
        for (const o of this.units)
          if (!o.dead && o !== u && o.type === 'bomber' && o.padBuildingId === b.id) { taken = true; break; }
        if (!taken) { found = b; break; }
      }
      if (found) { u.padBuildingId = found.id; }
      else { this.killUnit(u, -1); return; }
      return;
    }

    const padC = this.buildingCenter(pad);
    // L'avion radar se gare en décalé pour cohabiter avec le bombardier.
    if (u.type === 'scoutplane') { padC.x += 0.95; padC.y += 0.55; }

    if (u.airState === 'pad') {
      u.x = padC.x; u.y = padC.y;
      if ((u.rearmT ?? 0) > 0) {
        u.rearmT! -= dt;
        if (u.rearmT! <= 0) u.ammo = BOMBER_AMMO;
      }
      return;
    }

    const speed = def.speed;
    if (u.airState === 'return') {
      const d = Math.hypot(padC.x - u.x, padC.y - u.y);
      if (d < 0.6) {
        u.airState = 'pad';
        u.rearmT = u.type === 'scoutplane' ? SCOUT_REARM_TIME : BOMBER_REARM_TIME;
        u.order = { kind: 'idle' };
      } else {
        u.dir = Math.atan2(padC.y - u.y, padC.x - u.x);
        u.x += Math.cos(u.dir) * speed * dt;
        u.y += Math.sin(u.dir) * speed * dt;
      }
      return;
    }

    // Avion radar : survole le point demandé puis rentre.
    if (u.type === 'scoutplane') {
      const tx = u.order.x ?? u.x, ty = u.order.y ?? u.y;
      const d = Math.hypot(tx - u.x, ty - u.y);
      u.dir = Math.atan2(ty - u.y, tx - u.x);
      u.x += Math.cos(u.dir) * speed * dt;
      u.y += Math.sin(u.dir) * speed * dt;
      if (d < 1) u.airState = 'return';
      return;
    }

    // En vol vers la cible.
    let tx = u.order.x ?? u.x, ty = u.order.y ?? u.y, targetId = 0, targetIsBuilding = false;
    if (u.order.kind === 'attack') {
      targetId = u.order.targetId!;
      targetIsBuilding = !!u.order.targetIsBuilding;
      if (targetIsBuilding) {
        const b = this.buildingById.get(targetId);
        if (!b || b.dead) { u.airState = 'return'; return; }
        const c = this.buildingCenter(b);
        tx = c.x; ty = c.y;
      } else {
        const t = this.unitById.get(targetId);
        if (!t || t.dead) { u.airState = 'return'; return; }
        tx = t.x; ty = t.y;
      }
    }
    const d = Math.hypot(tx - u.x, ty - u.y);
    u.dir = Math.atan2(ty - u.y, tx - u.x);
    u.x += Math.cos(u.dir) * speed * dt;
    u.y += Math.sin(u.dir) * speed * dt;

    if (d < (def.weapon!.range) && u.cd <= 0 && (u.ammo ?? 0) > 0) {
      this.fire(u.owner, u.x, u.y, tx, ty, def.weapon!, targetId, targetIsBuilding, false, u);
      u.ammo!--;
      if (u.ammo! <= 0) u.airState = 'return';
    }
    if (u.order.kind === 'attackmove' && d < 1) {
      // Largage en zone puis retour.
      if ((u.ammo ?? 0) > 0 && u.cd <= 0) {
        this.fire(u.owner, u.x, u.y, tx, ty, def.weapon!, 0, false, false, u);
        u.ammo!--;
      }
      if ((u.ammo ?? 0) <= 0) u.airState = 'return';
    }
  }

  // ------------------------------------------------------- défenses statiques

  private updateBuildingWeapons(dt: number) {
    for (const b of this.buildings) {
      if (b.dead || !b.built) continue;
      const def = BUILDINGS[b.type];
      if (!def.weapon) continue;
      const p = this.players[b.owner];
      if (b.cd > 0) { b.cd -= dt * p.energyRatio; continue; }
      const c = this.buildingCenter(b);
      const w = def.weapon;
      const candidates = this.unitsNear(c.x, c.y, w.range, this.scratch);
      let best: Unit | null = null, bestScore = -Infinity;
      for (const t of candidates) {
        if (t.owner === b.owner || t.dead || this.players[t.owner].defeated) continue;
        const isAir = !!UNITS[t.type].isAir && t.airState !== 'pad';
        if (isAir && !w.targetsAir) continue;
        if (!isAir && !w.targetsGround) continue;
        if (!this.isVisibleTo(b.owner, t.x, t.y)) continue;
        if (!isAir && !w.indirect && !fireLineClear(this.nav, c.x, c.y, t.x, t.y)) continue;
        const mult = DMG_MULT[w.kind][UNITS[t.type].armor];
        if (mult <= 0.05) continue;
        const d = Math.hypot(t.x - c.x, t.y - c.y);
        const score = mult * 10 - d;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best) {
        const isAir = !!UNITS[best.type].isAir;
        this.fire(b.owner, c.x, c.y, best.x, best.y, w, best.id, false, isAir, null);
        b.cd = w.cooldown / Math.max(LOW_POWER_FACTOR, p.energyRatio);
      }
    }
  }

  // -------------------------------------------------------------- projectiles

  private updateProjectiles(dt: number) {
    for (const pr of this.projectiles) {
      pr.t += (pr.speed * dt) / pr.dist;
      pr.x = pr.sx + (pr.tx - pr.sx) * pr.t;
      pr.y = pr.sy + (pr.ty - pr.sy) * pr.t;
      if (pr.t < 1) continue;
      this.resolveImpact(pr);
    }
    this.projectiles = this.projectiles.filter(p => p.t < 1);
  }

  private resolveImpact(pr: Projectile) {
    const isBig = pr.kind === 'arty' || pr.kind === 'bomb' || pr.kind === 'shell';
    this.effects.push({
      kind: isBig ? 'boom' : 'spark',
      x: pr.tx, y: pr.ty, age: 0, dur: isBig ? 0.45 : 0.18, r: isBig ? 0.4 + pr.splash * 0.6 : 0.18,
    });
    if (isBig) this.events.push({ type: 'explosion', x: pr.tx, y: pr.ty });

    let directHit = false;
    if (pr.targetId) {
      if (pr.targetIsBuilding) {
        const b = this.buildingById.get(pr.targetId);
        if (b && !b.dead &&
            pr.tx >= b.tx - 0.4 && pr.tx <= b.tx + b.w + 0.4 &&
            pr.ty >= b.ty - 0.4 && pr.ty <= b.ty + b.h + 0.4) {
          this.damageBuilding(b, pr.dmg * DMG_MULT[pr.kind].building, pr.owner);
          directHit = true;
        }
      } else {
        const t = this.unitById.get(pr.targetId);
        if (t && !t.dead) {
          const hitR = 0.5 + UNITS[t.type].radius;
          if (Math.hypot(t.x - pr.tx, t.y - pr.ty) <= hitR) {
            this.damageUnit(t, pr.dmg * DMG_MULT[pr.kind][UNITS[t.type].armor], pr.owner);
            directHit = true;
          }
        }
      }
    }

    if (pr.splash > 0) {
      // Dégâts de zone (jamais sur ses propres troupes : pas de tir allié).
      const near = this.unitsNear(pr.tx, pr.ty, pr.splash + 0.5, []);
      for (const t of near) {
        if (t.owner === pr.owner || t.dead) continue;
        if (directHit && t.id === pr.targetId) continue;
        if (UNITS[t.type].isAir && t.airState !== 'pad' && pr.kind !== 'flak') continue;
        const d = Math.hypot(t.x - pr.tx, t.y - pr.ty);
        if (d > pr.splash) continue;
        const fall = 1 - (d / pr.splash) * 0.6;
        this.damageUnit(t, pr.dmg * DMG_MULT[pr.kind][UNITS[t.type].armor] * fall, pr.owner);
      }
      for (const b of this.buildings) {
        if (b.dead || b.owner === pr.owner) continue;
        if (directHit && pr.targetIsBuilding && b.id === pr.targetId) continue;
        const cp = this.closestPointOfBuilding(b, pr.tx, pr.ty);
        const d = Math.hypot(cp.x - pr.tx, cp.y - pr.ty);
        if (d > pr.splash) continue;
        const fall = 1 - (d / pr.splash) * 0.6;
        this.damageBuilding(b, pr.dmg * DMG_MULT[pr.kind].building * fall, pr.owner);
      }
    } else if (!directHit && pr.targetId && !pr.targetIsBuilding) {
      // Tir direct raté : peut toucher le bâtiment situé au point d'impact.
      const ti = Math.round(pr.ty) * this.map.w + Math.round(pr.tx);
      if (ti >= 0 && ti < this.buildGrid.length && this.buildGrid[ti] !== 0) {
        const b = this.buildingById.get(this.buildGrid[ti]);
        if (b && !b.dead && b.owner !== pr.owner)
          this.damageBuilding(b, pr.dmg * DMG_MULT[pr.kind].building, pr.owner);
      }
    }
  }

  damageUnit(u: Unit, dmg: number, attacker: number) {
    if (dmg <= 0 || u.dead) return;
    u.hp -= dmg;
    this.notifyAttacked(u.owner, u.x, u.y);
    if (u.hp <= 0) this.killUnit(u, attacker);
  }

  damageBuilding(b: Building, dmg: number, attacker: number) {
    if (dmg <= 0 || b.dead) return;
    b.hp -= dmg;
    const c = this.buildingCenter(b);
    this.notifyAttacked(b.owner, c.x, c.y);
    if (b.hp <= 0) this.killBuilding(b, attacker);
  }

  private notifyAttacked(owner: number, x: number, y: number) {
    const p = this.players[owner];
    const isNew = this.time - p.alertT > 6;
    p.alertT = this.time;
    p.alertX = x; p.alertY = y;
    if (p.isHuman && isNew && !this.isVisibleTo(0, x, y)) {
      // sera quand même notifié : ping mini-carte + son
    }
    if (p.isHuman && this.time - this.humanAlertSoundT > 9) {
      this.humanAlertSoundT = this.time;
      this.pings.push({ x, y, t: this.time });
      this.events.push({ type: 'alert', x, y, owner });
    }
  }

  killUnit(u: Unit, attacker: number) {
    if (u.dead) return;
    u.dead = true;
    const def = UNITS[u.type];
    const p = this.players[u.owner];
    p.stats.unitsLost++;
    if (u.type === 'harvester') p.stats.harvestersLost++;
    if (attacker >= 0 && attacker !== u.owner) {
      this.players[attacker].stats.unitsKilled++;
      this.players[attacker].stats.valueKilled += def.cost;
    }
    this.effects.push({ kind: 'boom', x: u.x, y: u.y, age: 0, dur: 0.5, r: 0.5 + def.radius });
    this.events.push({ type: 'explosion', x: u.x, y: u.y });
  }

  killBuilding(b: Building, attacker: number) {
    if (b.dead) return;
    b.dead = true;
    const def = BUILDINGS[b.type];
    const p = this.players[b.owner];
    p.stats.buildingsLost++;
    if (attacker >= 0 && attacker !== b.owner) {
      this.players[attacker].stats.buildingsDestroyed++;
      this.players[attacker].stats.valueKilled += def.cost || 1500;
    }
    // Remboursement de la file en cours.
    for (const q of b.queue) p.ore += q.cost;
    b.queue = [];
    // Libérer les tuiles.
    for (let y = b.ty; y < b.ty + b.h; y++)
      for (let x = b.tx; x < b.tx + b.w; x++) {
        const i = y * this.map.w + x;
        this.buildGrid[i] = 0;
        const t = this.map.terrain[i];
        this.nav.pass[i] = t === T_GRASS || t === T_ROUGH ? 1 : 0;
        this.nav.fireBlock[i] = t === T_ROCK ? 1 : 0;
      }
    const c = this.buildingCenter(b);
    this.effects.push({ kind: 'boom', x: c.x, y: c.y, age: 0, dur: 0.8, r: Math.max(b.w, b.h) * 0.8 });
    this.events.push({ type: 'bigboom', x: c.x, y: c.y });
    this.recomputePower();
  }

  // ------------------------------------------------------------- réparations

  private updateRepairs(dt: number) {
    for (const b of this.buildings) {
      if (b.dead || !b.built || !b.repairOn) continue;
      if (b.hp >= b.maxHp) { b.repairOn = false; continue; }
      const p = this.players[b.owner];
      const heal = REPAIR_HP_PER_SEC * (p.upgrades.repairs ? 1.25 : 1) * dt;
      const cost = heal * REPAIR_ORE_PER_HP;
      if (p.ore >= cost) {
        p.ore -= cost;
        b.hp = Math.min(b.maxHp, b.hp + heal);
      }
    }
  }

  private updateOre(dt: number) {
    // Régénération très lente des gisements non épuisés.
    for (const n of this.nodes) {
      if (n.amount > 0.5 && n.amount < n.max) {
        n.amount = Math.min(n.max, n.amount + this.oreRegenPerSec * dt);
      }
    }
  }

  private updateEffects(dt: number) {
    for (const e of this.effects) e.age += dt;
    this.effects = this.effects.filter(e => e.age < e.dur);
    this.pings = this.pings.filter(p => this.time - p.t < 5);
  }

  // ---------------------------------------------------------------- pouvoir

  recomputePower() {
    for (const p of this.players) {
      let prod = 0, use = 0;
      for (const b of this.buildings) {
        if (b.dead || b.owner !== p.id || !b.built) continue;
        const def = BUILDINGS[b.type];
        if (def.power > 0) prod += def.power * (p.upgrades.powerplus && (b.type === 'power' || b.type === 'power2') ? 1.15 : 1);
        else use += -def.power;
      }
      const wasLow = p.energyRatio < 1;
      p.powerProd = prod;
      p.powerUse = use;
      p.energyRatio = use <= prod ? 1 : Math.max(LOW_POWER_FACTOR, prod / Math.max(1, use));
      if (p.isHuman && !wasLow && p.energyRatio < 1) this.events.push({ type: 'lowpower', owner: p.id });
    }
  }

  // -------------------------------------------------------------- brouillard

  private updateFog(p: Player) {
    const { w, h } = this.map;
    const fog = p.fog;
    for (let i = 0; i < fog.length; i++) if (fog[i] === 2) fog[i] = 1;

    // Le centre radar avancé surclasse le radar simple.
    const hasCenter = this.countBuildings(p.id, 'radarcenter') > 0 && p.energyRatio >= 1;
    const radarMult = hasCenter ? 1.6 : this.hasRadar(p.id) ? 1.25 : 1;
    const unitMult = hasCenter ? 1.15 : 1;
    const opticsMult = p.upgrades.optics ? 1.25 : 1;

    const stamp = (cx: number, cy: number, r: number) => {
      const r2 = r * r;
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= r2) fog[y * w + x] = 2;
        }
    };

    for (const u of this.units) {
      if (u.dead || u.owner !== p.id) continue;
      stamp(u.x, u.y, UNITS[u.type].vision * unitMult);
    }
    for (const b of this.buildings) {
      if (b.dead || b.owner !== p.id) continue;
      const c = this.buildingCenter(b);
      stamp(c.x, c.y, BUILDINGS[b.type].vision * radarMult * opticsMult * (b.built ? 1 : 0.6));
    }
    let count = 0;
    for (let i = 0; i < fog.length; i++) if (fog[i] > 0) count++;
    p.exploredCount = count;
  }

  // ---------------------------------------------------------------- victoire

  private checkVictory() {
    for (const p of this.players) {
      if (p.defeated) continue;
      let hqAlive = false;
      for (const b of this.buildings)
        if (!b.dead && b.owner === p.id && b.type === 'hq') { hqAlive = true; break; }
      if (!hqAlive) this.eliminate(p);
    }
    const alive = this.players.filter(p => !p.defeated);
    const human = this.players[0];
    if (human.defeated) {
      this.over = true;
      this.winner = alive.length === 1 ? alive[0].id : (alive[0]?.id ?? -1);
    } else if (alive.length === 1) {
      this.over = true;
      this.winner = 0;
    }
  }

  private eliminate(p: Player) {
    p.defeated = true;
    for (const u of this.units) if (!u.dead && u.owner === p.id) this.killUnit(u, -1);
    for (const b of this.buildings) if (!b.dead && b.owner === p.id) this.killBuilding(b, -1);
    this.events.push({ type: 'eliminated', owner: p.id });
  }

  private sweepDead() {
    let hasDead = false;
    for (const u of this.units) if (u.dead) { hasDead = true; this.unitById.delete(u.id); }
    if (hasDead) this.units = this.units.filter(u => !u.dead);
    hasDead = false;
    for (const b of this.buildings) if (b.dead) { hasDead = true; this.buildingById.delete(b.id); }
    if (hasDead) this.buildings = this.buildings.filter(b => !b.dead);
  }

  // Gisements contrôlés (raffinerie à proximité) — pour les statistiques.
  depositsControlled(owner: number): number {
    let n = 0;
    for (const node of this.nodes) {
      if (node.amount < 20) continue;
      const ref = this.nearestRefinery(owner, node.tx, node.ty);
      if (ref) {
        const c = this.buildingCenter(ref);
        if (Math.hypot(c.x - node.tx, c.y - node.ty) <= 12) n++;
      }
    }
    return n;
  }
}
