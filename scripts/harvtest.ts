// Vérifie la réassignation automatique des récolteurs (priorité 1).
import { Game } from '../src/game/engine';

const game = new Game({ sizeId: 'small', theme: 'temperate', opponents: 1, difficulty: 'normal', dayNight: false, seed: 11 });
const start = game.map.starts[0];

// Gisement A presque vide près du départ, gisement B riche un peu plus loin.
const nodeA = game.nodes.reduce((best, n) =>
  Math.hypot(n.tx - start.x, n.ty - start.y) < Math.hypot(best.tx - start.x, best.ty - start.y) ? n : best);
nodeA.amount = 90; nodeA.max = 900;

// Une raffinerie est nécessaire pour livrer (et la centrale est son prérequis).
game.players[0].ore = 5000;
const placeAnywhere = (type: 'power' | 'refinery'): boolean => {
  for (let dy = -12; dy <= 12; dy++)
    for (let dx = -12; dx <= 12; dx++) {
      const tx = Math.round(start.x) + dx, ty = Math.round(start.y) + dy;
      if (game.canPlace(0, type, tx, ty) && game.place(0, type, tx, ty)) return true;
    }
  return false;
};
const powerOk = placeAnywhere('power');
for (let i = 0; i < 300; i++) game.update(0.05); // construction de la centrale
const refOk = placeAnywhere('refinery');
for (let i = 0; i < 400; i++) game.update(0.05); // construction de la raffinerie
console.log(`centrale=${powerOk} raffinerie=${refOk}`);

// Scénario propre : un récolteur vide sur le gisement A presque épuisé.
nodeA.amount = 90;
const harv = game.spawnUnit(0, 'harvester', nodeA.tx + 1, nodeA.ty);
harv.order = { kind: 'harvest', nodeId: nodeA.id };
console.log(`gisement A id=${nodeA.id} amount=${Math.round(nodeA.amount)}`);

const dt = 1 / 20;
let switched = false, switchT = 0;
for (let i = 0; i < 240 / dt; i++) {
  game.update(dt);
  game.events.length = 0;
  if (!switched && harv.order.kind === 'harvest' && harv.order.nodeId && harv.order.nodeId !== nodeA.id) {
    switched = true;
    switchT = game.time;
  }
}
const p = game.players[0];
console.log(`changement de gisement: ${switched ? `OUI à t=${Math.round(switchT)}s` : 'NON'}`);
console.log(`gisement actuel=${harv.order.nodeId} | récolté total=${Math.floor(p.stats.oreHarvested)}`);
if (!switched || p.stats.oreHarvested < 500) { console.log('ÉCHEC'); process.exitCode = 1; }
else console.log('OK : le récolteur se réassigne automatiquement');
