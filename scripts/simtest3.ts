// Tests : 16 joueurs sur très grande carte (performance) + ordre d'escorte.
import { Game } from '../src/game/engine';
import { AIController } from '../src/game/ai';

// ---- 16 joueurs, difficulté difficile, 6 minutes simulées
{
  const game = new Game({ sizeId: 'xlarge', theme: 'tropical', opponents: 15, difficulty: 'hard', dayNight: true, seed: 2026 });
  const ais = game.players.map(p => new AIController(game, p.id, 'hard'));
  console.log(`joueurs=${game.players.length} départs=${game.map.starts.length} gisements=${game.nodes.length}`);
  const dt = 1 / 20;
  const t0 = Date.now();
  let maxStep = 0;
  for (let i = 0; i < 360 / dt; i++) {
    const s0 = performance.now();
    game.update(dt);
    for (const ai of ais) ai.update(dt);
    const ms = performance.now() - s0;
    if (i > 100 && ms > maxStep) maxStep = ms;
    game.events.length = 0;
    if (game.over) break;
  }
  const alive = game.players.filter(p => !p.defeated).length;
  const totalHarvest = game.players.reduce((s, p) => s + p.stats.oreHarvested, 0);
  console.log(`16 joueurs: simulé ${Math.round(game.time)}s en ${Date.now() - t0}ms (pire tick ${maxStep.toFixed(1)}ms)`);
  console.log(`vivants=${alive} unités=${game.units.length} récolte totale=${Math.floor(totalHarvest)}`);
  if (totalHarvest < 5000) { console.log('ÉCHEC éco 16j'); process.exitCode = 1; }
}

// ---- escorte : 2 tanks escortent un récolteur, un ennemi approche
{
  const game = new Game({ sizeId: 'small', theme: 'temperate', opponents: 1, difficulty: 'easy', dayNight: false, seed: 5 });
  const s = game.map.starts[0];
  const harv = game.spawnUnit(0, 'harvester', s.x + 5, s.y);
  const t1 = game.spawnUnit(0, 'tank', s.x + 2, s.y + 2);
  const t2 = game.spawnUnit(0, 'tank', s.x + 2, s.y - 2);
  game.cmdEscort([t1.id, t2.id], harv.id);
  // le récolteur part vers un point éloigné ; l'escorte doit suivre
  game.cmdMove([harv.id], s.x + 14, s.y + 6);
  const dt = 1 / 20;
  for (let i = 0; i < 30 / dt; i++) { game.update(dt); game.events.length = 0; }
  const d1 = Math.hypot(t1.x - harv.x, t1.y - harv.y);
  const d2 = Math.hypot(t2.x - harv.x, t2.y - harv.y);
  console.log(`escorte: ordres=[${t1.order.kind},${t2.order.kind}] distances=[${d1.toFixed(1)},${d2.toFixed(1)}]`);
  // un ennemi attaque le récolteur : l'escorte doit l'engager
  const foe = game.spawnUnit(1, 'jeep', harv.x + 4, harv.y);
  game.cmdAttack([foe.id], harv.id, false);
  let engaged = false;
  for (let i = 0; i < 25 / dt; i++) {
    game.update(dt);
    game.events.length = 0;
    if (foe.dead) { engaged = true; break; }
  }
  console.log(`escorte engage la menace: ${engaged ? 'OUI (jeep ennemie détruite)' : 'NON'}`);
  const suit = t1.order.kind === 'escort' && d1 < 6 && d2 < 6;
  if (!suit || !engaged) { console.log('ÉCHEC escorte'); process.exitCode = 1; }
  else console.log('OK escorte');
}
