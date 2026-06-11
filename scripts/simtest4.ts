// Tests : cartes spéciales (France, Italie) + progression T2 de l'IA + kamikaze.
import { Game } from '../src/game/engine';
import { AIController } from '../src/game/ai';
import { T_WATER } from '../src/game/map';

// ---- cartes spéciales : génération, terre suffisante, départs espacés
for (const special of ['france', 'italy'] as const) {
  const game = new Game({ sizeId: 'large', theme: 'temperate', opponents: 3, difficulty: 'normal', dayNight: true, special, seed: 99 });
  const { w, h, terrain, starts } = game.map;
  let land = 0;
  for (let i = 0; i < w * h; i++) if (terrain[i] !== T_WATER) land++;
  let minDist = Infinity;
  for (let i = 0; i < starts.length; i++)
    for (let j = i + 1; j < starts.length; j++)
      minDist = Math.min(minDist, Math.hypot(starts[i].x - starts[j].x, starts[i].y - starts[j].y));
  console.log(`${special}: ${w}x${h} terre=${Math.round(land / (w * h) * 100)}% départs=${starts.length} distMin=${Math.round(minDist)} gisements=${game.nodes.length}`);
  if (land / (w * h) < 0.25 || minDist < 25 || game.nodes.length < 30) { console.log(`ÉCHEC ${special}`); process.exitCode = 1; }
}

// ---- IA difficile sur France : doit construire le labo et produire du T2
{
  const game = new Game({ sizeId: 'large', theme: 'temperate', opponents: 1, difficulty: 'hard', dayNight: true, special: 'france', seed: 7 });
  const ais = game.players.map(p => new AIController(game, p.id, 'hard'));
  const dt = 1 / 20;
  const t0 = Date.now();
  let maxStep = 0;
  for (let i = 0; i < 900 / dt; i++) {
    const s0 = performance.now();
    game.update(dt);
    for (const ai of ais) ai.update(dt);
    const ms = performance.now() - s0;
    if (i > 100 && ms > maxStep) maxStep = ms;
    game.events.length = 0;
    if (game.over) break;
  }
  console.log(`France 1v1 difficile: simulé ${Math.round(game.time)}s en ${Date.now() - t0}ms (pire tick ${maxStep.toFixed(1)}ms)`);
  for (const p of game.players) {
    const labs = game.buildings.filter(b => b.owner === p.id && b.type === 'lab').length;
    const t2b = game.buildings.filter(b => b.owner === p.id && ['barracks2', 'factory2', 'power2', 'refinery2'].includes(b.type)).length;
    const t2u = game.units.filter(u => u.owner === p.id &&
      ['elite', 'rocketeer', 'kamikaze', 'heavytank', 'tankdestroyer', 'heavyarty', 'radarvehicle'].includes(u.type)).length;
    console.log(`  ${p.name}${p.defeated ? ' [X]' : ''}: récolté=${Math.floor(p.stats.oreHarvested)} labo=${labs} bâtT2=${t2b} unitésT2=${t2u}`);
  }
  const anyT2 = game.players.some(p =>
    game.buildings.some(b => b.owner === p.id && b.type === 'lab') ||
    game.units.some(u => u.owner === p.id && ['heavytank', 'elite'].includes(u.type)));
  if (!anyT2) { console.log('ÉCHEC : aucune IA n’a atteint le T2'); process.exitCode = 1; }
}

// ---- kamikaze : doit détruire un groupe serré
{
  const game = new Game({ sizeId: 'small', theme: 'temperate', opponents: 1, difficulty: 'easy', dayNight: false, seed: 3 });
  const s = game.map.starts[0];
  const kami = game.spawnUnit(0, 'kamikaze', s.x + 2, s.y);
  const foes = [0, 1, 2].map(i => game.spawnUnit(1, 'rifle', s.x + 8 + (i % 2), s.y + Math.floor(i / 2)));
  game.cmdAttack([kami.id], foes[0].id, false);
  const dt = 1 / 20;
  for (let i = 0; i < 20 / dt; i++) { game.update(dt); game.events.length = 0; if (kami.dead) break; }
  const dead = foes.filter(f => f.dead).length;
  console.log(`kamikaze: explosé=${kami.dead} fusiliers ennemis détruits=${dead}/3`);
  if (!kami.dead || dead < 2) { console.log('ÉCHEC kamikaze'); process.exitCode = 1; }
  else console.log('OK kamikaze');
}
