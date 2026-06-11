// Test headless : fait jouer des IA l'une contre l'autre et vérifie les systèmes.
import { Game } from '../src/game/engine';
import { AIController } from '../src/game/ai';

function run(label: string, opponents: number, sizeId: 'small' | 'medium', minutes: number, seed: number) {
  const game = new Game({ sizeId, theme: 'temperate', opponents, difficulty: 'hard', dayNight: true, seed });
  const ais = game.players.map(p => new AIController(game, p.id, 'hard'));
  const dt = 1 / 20;
  const steps = Math.floor(minutes * 60 / dt);
  const t0 = Date.now();
  for (let i = 0; i < steps; i++) {
    game.update(dt);
    for (const ai of ais) ai.update(dt);
    game.events.length = 0;
    if (game.over) break;
  }
  const wall = Date.now() - t0;
  console.log(`\n=== ${label} (simulé ${Math.round(game.time)} s en ${wall} ms) ===`);
  console.log(`over=${game.over} winner=${game.winner}`);
  for (const p of game.players) {
    const units = game.units.filter(u => u.owner === p.id).length;
    const blds = game.buildings.filter(b => b.owner === p.id).length;
    const s = p.stats;
    console.log(
      `${p.name}${p.defeated ? ' [ÉLIMINÉ]' : ''}: minerai=${Math.floor(p.ore)} récolté=${Math.floor(s.oreHarvested)} ` +
      `unités=${units} bât=${blds} produits=${s.unitsProduced} perdus=${s.unitsLost} tués=${s.unitsKilled} ` +
      `bâtDétruits=${s.buildingsDestroyed} énergie=${Math.round(p.powerProd)}/${Math.round(p.powerUse)} ` +
      `exploré=${Math.round(p.exploredCount / (game.map.w * game.map.h) * 100)}%`,
    );
  }
  // Vérifications minimales
  const anyHarvest = game.players.some(p => p.stats.oreHarvested > 500);
  const anyArmy = game.players.some(p => p.stats.unitsProduced > 5);
  const anyCombat = game.players.some(p => p.stats.unitsKilled > 0);
  console.log(`récolte OK=${anyHarvest} production OK=${anyArmy} combat OK=${anyCombat}`);
  if (!anyHarvest || !anyArmy) process.exitCode = 1;
}

run('Duel 1v1 petite carte', 1, 'small', 25, 42);
run('Mêlée 4 joueurs carte moyenne', 3, 'medium', 10, 1337);
