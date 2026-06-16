// Commandes joueur sérialisables : l'unique porte d'entrée des mutations de
// la simulation. En solo, elles sont appliquées immédiatement ; en
// multijoueur, elles sont diffusées puis appliquées au même tick sur tous
// les clients (lockstep). `applyCommand` revalide la propriété : un client
// ne peut commander que ses propres unités et bâtiments.
import { Game } from './engine';
import type { BuildingTypeId, UnitTypeId, UpgradeId } from './data';
import { mpDebug, mpDebugSetCommandContext } from '../net/debug';

export type Cmd =
  | { k: 'move'; ids: number[]; x: number; y: number; am: boolean }
  | { k: 'attack'; ids: number[]; t: number; b: boolean }
  | { k: 'harvest'; ids: number[]; n: number }
  | { k: 'repairT'; ids: number[]; t: number; b: boolean }
  | { k: 'escort'; ids: number[]; t: number }
  | { k: 'stop'; ids: number[] }
  | { k: 'rally'; bId: number; x: number; y: number }
  | { k: 'place'; t: BuildingTypeId; tx: number; ty: number }
  | { k: 'qunit'; bId: number; t: UnitTypeId }
  | { k: 'qup'; bId: number; up: UpgradeId }
  | { k: 'qcancel'; bId: number; i: number }
  | { k: 'repairOn'; bId: number; on: boolean }
  | { k: 'deploy'; ids: number[] }
  | { k: 'load'; ids: number[]; carrier: number }
  | { k: 'pickup'; ids: number[]; target: number }
  | { k: 'unload'; ids: number[]; x: number; y: number }
  // système (scellée par l'hôte) : un humain déconnecté passe sous contrôle IA
  | { k: 'aitakeover'; player: number };

/** Émetteur de commandes : solo = application directe, multi = diffusion. */
export type CommandSink = (c: Cmd) => void;

function ownUnits(g: Game, owner: number, ids: number[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const u = g.unitById.get(id);
    if (u && !u.dead && u.owner === owner) out.push(id);
  }
  return out;
}

function ownBuilding(g: Game, owner: number, id: number) {
  const b = g.buildingById.get(id);
  return b && !b.dead && b.owner === owner ? b : null;
}

export function applyCommand(g: Game, owner: number, c: Cmd) {
  mpDebug('command.apply', { playerId: owner, owner, command: c });
  switch (c.k) {
    case 'move': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdMove(ids, c.x, c.y, c.am);
      break;
    }
    case 'attack': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdAttack(ids, c.t, c.b);
      break;
    }
    case 'harvest': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdHarvest(ids, c.n);
      break;
    }
    case 'repairT': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdRepairTarget(ids, c.t, c.b);
      break;
    }
    case 'escort': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdEscort(ids, c.t);
      break;
    }
    case 'stop': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdStop(ids);
      break;
    }
    case 'rally': {
      if (ownBuilding(g, owner, c.bId)) g.setRally(c.bId, c.x, c.y);
      break;
    }
    case 'place':
      g.place(owner, c.t, c.tx, c.ty);
      break;
    case 'qunit': {
      if (ownBuilding(g, owner, c.bId)) g.queueUnit(c.bId, c.t);
      break;
    }
    case 'qup': {
      if (ownBuilding(g, owner, c.bId)) g.queueUpgrade(c.bId, c.up);
      break;
    }
    case 'qcancel': {
      if (ownBuilding(g, owner, c.bId)) g.cancelQueue(c.bId, c.i);
      break;
    }
    case 'repairOn': {
      if (ownBuilding(g, owner, c.bId)) g.setRepair(c.bId, c.on);
      break;
    }
    case 'deploy': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.deployMobileCommanders(ids);
      break;
    }
    case 'load': {
      const ids = ownUnits(g, owner, c.ids);
      if (ownUnits(g, owner, [c.carrier]).length && ids.length) g.cmdLoadInto(ids, c.carrier);
      break;
    }
    case 'pickup': {
      const ids = ownUnits(g, owner, c.ids);
      if (ownUnits(g, owner, [c.target]).length && ids.length) g.cmdPickup(ids, c.target);
      break;
    }
    case 'unload': {
      const ids = ownUnits(g, owner, c.ids);
      if (ids.length) g.cmdUnload(ids, c.x, c.y);
      break;
    }
    case 'aitakeover':
      // gérée hors simulation (création d'un contrôleur IA) — voir GameScreen
      break;
  }
}

export { mpDebugSetCommandContext };

/** Empreinte d'état rapide : détection de désynchronisation entre clients. */
export function stateHash(g: Game): number {
  let h = 0 | 0;
  const mix = (v: number) => { h = (h ^ ((v * 2654435761) | 0)) | 0; h = ((h << 13) | (h >>> 19)) | 0; };
  for (const u of g.units) {
    if (u.dead) continue;
    mix(u.id); mix(Math.round(u.x * 64)); mix(Math.round(u.y * 64)); mix(Math.round(u.hp));
  }
  for (const b of g.buildings) {
    if (b.dead) continue;
    mix(b.id); mix(b.tx); mix(b.ty); mix(Math.round(b.hp)); mix(Math.round(b.progress * 255));
  }
  for (const p of g.players) { mix(Math.round(p.ore)); mix(p.defeated ? 1 : 0); }
  return h >>> 0;
}
