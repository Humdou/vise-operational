// Tests complémentaires : difficulté facile, très grande carte, performance.
import { Game } from '../src/game/engine';
import { AIController } from '../src/game/ai';
import { Difficulty, MapSizeId } from '../src/game/data';

function run(label: string, opponents: number, sizeId: MapSizeId, diff: Difficulty, minutes: number, seed: number) {
  const game = new Game({ sizeId, theme: 'snow', opponents, difficulty: diff, dayNight: true, seed });
  const ais = game.players.map(p => new AIController(game, p.id, diff));
  const dt = 1 / 20;
  const steps = Math.floor(minutes * 60 / dt);
  const t0 = Date.now();
  let maxStepMs = 0;
  for (let i = 0; i < steps; i++) {
    const s0 = performance.now();
    game.update(dt);
    for (const ai of ais) ai.update(dt);
    const stepMs = performance.now() - s0;
    if (stepMs > maxStepMs && i > 100) maxStepMs = stepMs;
    game.events.length = 0;
    if (game.over) break;
  }
  const wall = Date.now() - t0;
  const totalUnits = game.units.length;
  console.log(`\n=== ${label}: simulé ${Math.round(game.time)}s en ${wall}ms (pire tick ${maxStepMs.toFixed(1)}ms, unités ${totalUnits}) ===`);
  console.log(`over=${game.over} winner=${game.winner}`);
  for (const p of game.players) {
    console.log(`  ${p.name}${p.defeated ? ' [X]' : ''}: récolté=${Math.floor(p.stats.oreHarvested)} armée_max=${p.stats.maxArmy} bât_construits=${p.stats.buildingsBuilt}`);
  }
}

run('Facile 1v1 moyenne', 1, 'medium', 'easy', 15, 7);
run('Très grande carte 4 joueurs difficile', 3, 'xlarge', 'hard', 15, 99);
