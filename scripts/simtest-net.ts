// Test headless du multijoueur : hôte + 2 clients reliés par un transport
// simulé (latence + gigue + PERTE de messages). Vérifie que malgré un réseau
// dégradé :
//  - toutes les commandes des clients finissent appliquées par l'hôte,
//    exactement une fois, dans l'ordre (couche de fiabilité de NetGame) ;
//  - les clients convergent vers l'état de l'hôte (snapshots auto-réparants) ;
//  - un silence prolongé déclenche une demande de resync qui aboutit.
//
// Usage : npx tsx scripts/simtest-net.ts
import { Game } from '../src/game/engine';
import { NetGame, SIM_DT } from '../src/net/netgame';
import type { Transport, PresenceMember } from '../src/net/transport';
import type { GameSlot } from '../src/net/types';
import type { Cmd } from '../src/game/commands';

// ------------------------------------------------------- transport simulé

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Wire { at: number; to: FakeTransport; type: string; data: unknown; from: string; }

class FakeHub {
  peers: FakeTransport[] = [];
  queue: Wire[] = [];
  now = 0;
  sent = 0;
  dropped = 0;
  constructor(readonly rng: () => number, public lossRate: number, public latencyMs: number, public jitterMs: number) {}

  send(from: FakeTransport, type: string, data: unknown) {
    for (const p of this.peers) {
      if (p === from || !p.connected) continue;
      this.sent++;
      if (this.rng() < this.lossRate) { this.dropped++; continue; }
      const at = this.now + this.latencyMs + this.rng() * this.jitterMs;
      // sérialisation JSON comme en production (pas de partage de références)
      this.queue.push({ at, to: p, type, data: JSON.parse(JSON.stringify(data)), from: from.self });
    }
  }

  /** Livre tous les messages dus à `now`, dans l'ordre d'échéance. */
  deliver(now: number) {
    this.now = now;
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length && this.queue[0].at <= now) {
      const w = this.queue.shift()!;
      w.to.dispatch(w.type, w.data, w.from);
    }
  }

  presence(): PresenceMember[] {
    return this.peers.filter(p => p.connected).map(p => ({ id: p.self, meta: {} }));
  }

  emitPresence() {
    for (const p of this.peers) p.pushPresence(this.presence());
  }
}

class FakeTransport implements Transport {
  connected = true;
  private handlers = new Map<string, Set<(data: unknown, from: string) => void>>();
  private presenceCb: ((m: PresenceMember[]) => void) | null = null;
  constructor(readonly self: string, private hub: FakeHub) {
    hub.peers.push(this);
  }
  async join() { /* déjà branché */ }
  leave() { this.connected = false; this.hub.emitPresence(); }
  send(type: string, data: unknown) { if (this.connected) this.hub.send(this, type, data); }
  on(type: string, cb: (data: unknown, from: string) => void) {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
  onPresence(cb: (m: PresenceMember[]) => void) { this.presenceCb = cb; cb(this.hub.presence()); }
  setMeta() { /* sans objet */ }
  dispatch(type: string, data: unknown, from: string) {
    if (!this.connected) return;
    for (const cb of this.handlers.get(type) ?? []) cb(data, from);
  }
  pushPresence(m: PresenceMember[]) { this.presenceCb?.(m); }
}

// ------------------------------------------------------------- scénario

function fail(msg: string): never {
  console.error(`\n❌ ÉCHEC : ${msg}`);
  process.exit(1);
}

function run(label: string, lossRate: number, latencyMs: number, jitterMs: number, seed: number) {
  console.log(`\n=== ${label} (perte ${Math.round(lossRate * 100)} %, latence ${latencyMs}±${jitterMs} ms) ===`);
  const rng = mulberry(seed);
  const hub = new FakeHub(rng, lossRate, latencyMs, jitterMs);

  const uids = ['host-uid', 'client1-uid', 'client2-uid'];
  const slots: GameSlot[] = uids.map((uid, i) => ({ player: i, kind: 'human' as const, uid, pseudo: `J${i}` }));
  const settings = {
    sizeId: 'small' as const, theme: 'temperate' as const, opponents: 2,
    difficulty: 'normal' as const, dayNight: false, seed,
    humanSlots: [0, 1, 2],
  };

  const games = uids.map(() => new Game(settings));
  const transports = uids.map(uid => new FakeTransport(uid, hub));
  const nets = uids.map((uid, i) => new NetGame(games[i], transports[i], i === 0, i, slots));
  const [hostGame, c1Game, c2Game] = games;
  const [, c1Net, c2Net] = nets;

  // commandes émises par les clients : déplacements répétés + placements
  const issued: { net: NetGame; cmds: Cmd[] } = { net: c1Net, cmds: [] };
  const c1Units = () => c1Game.units.filter(u => !u.dead && u.owner === 1).map(u => u.id);
  const hq1 = hostGame.buildings.find(b => b.owner === 1)!;

  let now = 0;
  const step = SIM_DT * 1000;
  const totalTicks = Math.round(30_000 / step);        // 30 s simulées
  let placed = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    now += step;
    hub.deliver(now);
    for (const g of games) g.update(SIM_DT);
    for (const n of nets) n.pump(now);

    // rafales de commandes côté clients pendant les 10 premières secondes
    if (tick % 25 === 0 && tick < 250) {
      const ids = c1Units();
      if (ids.length) {
        const c: Cmd = { k: 'move', ids, x: hq1.tx + 4 + (tick % 7), y: hq1.ty + 4 + (tick % 5), am: false };
        c1Net.issue(c);
        issued.cmds.push(c);
      }
      // placement d'une centrale (coûte du minerai : teste aussi l'économie)
      if (placed < 3 && tick % 75 === 0) {
        for (let dy = -8; dy <= 8 && placed < 3; dy++) {
          for (let dx = -8; dx <= 8 && placed < 3; dx++) {
            const tx = hq1.tx + dx, ty = hq1.ty + dy;
            if (c1Game.canPlace(1, 'power', tx, ty)) {
              c1Net.issue({ k: 'place', t: 'power', tx, ty });
              placed++;
            }
          }
        }
      }
      if (tick % 50 === 0) {
        const ids2 = c2Game.units.filter(u => !u.dead && u.owner === 2).map(u => u.id);
        if (ids2.length) c2Net.issue({ k: 'stop', ids: ids2 });
      }
    }
    // coupure réseau totale de 8 s à 15 s : teste le resync 'needsnap'
    if (label.includes('coupure')) {
      hub.lossRate = now >= 8000 && now < 15000 ? 1 : lossRate;
    }
  }

  // --- vérifications -------------------------------------------------------
  // 1. tous les placements du client existent chez l'HÔTE (fiabilité cmds)
  const hostP1Power = hostGame.buildings.filter(b => !b.dead && b.owner === 1 && b.type === 'power').length;
  if (hostP1Power !== placed) fail(`hôte : ${hostP1Power}/${placed} centrales du client 1 (commandes perdues ?)`);
  // ... et exactement une fois (pas de double application malgré les renvois)
  const c1PowerOnHost = hostGame.buildings.filter(b => !b.dead && b.owner === 1 && b.type === 'power');
  const keys = new Set(c1PowerOnHost.map(b => `${b.tx},${b.ty}`));
  if (keys.size !== c1PowerOnHost.length) fail('hôte : bâtiment dupliqué (commande appliquée deux fois)');

  // 2. convergence : les clients voient les mêmes bâtiments que l'hôte
  for (const [name, g] of [['client1', c1Game], ['client2', c2Game]] as const) {
    const h = new Set(hostGame.buildings.filter(b => !b.dead).map(b => `${b.id}:${b.type}:${b.tx}:${b.ty}:${b.owner}`));
    const c = new Set(g.buildings.filter(b => !b.dead).map(b => `${b.id}:${b.type}:${b.tx}:${b.ty}:${b.owner}`));
    for (const k of h) if (!c.has(k)) fail(`${name} : bâtiment manquant ${k}`);
    for (const k of c) if (!h.has(k)) fail(`${name} : bâtiment fantôme ${k}`);
    // ressources cohérentes (l'arrondi de sérialisation autorise un petit écart)
    for (let p = 0; p < 3; p++) {
      const dOre = Math.abs(g.players[p].ore - hostGame.players[p].ore);
      if (dOre > 25) fail(`${name} : minerai joueur ${p} diverge de ${Math.round(dOre)}`);
    }
    // unités : mêmes vivantes, positions proches (corrections résorbées)
    const hu = new Map(hostGame.units.filter(u => !u.dead).map(u => [u.id, u]));
    const cu = new Map(g.units.filter(u => !u.dead).map(u => [u.id, u]));
    for (const [id, u] of hu) {
      const v = cu.get(id);
      if (!v) fail(`${name} : unité ${id} absente`);
      const d = Math.hypot(u.x - v.x, u.y - v.y);
      if (d > 1.5) fail(`${name} : unité ${id} à ${d.toFixed(2)} tuiles de la position hôte`);
    }
    for (const id of cu.keys()) if (!hu.has(id) && (id as number) < 1_000_000) fail(`${name} : unité fantôme ${id}`);
  }

  console.log(`✓ ${placed} placements fiables, bâtiments/unités/minerai convergents`);
  console.log(`  trafic : ${hub.sent} messages émis, ${hub.dropped} perdus (${Math.round(hub.dropped / Math.max(1, hub.sent) * 100)} %)`);
  for (const n of nets) n.dispose();
}

run('Réseau correct', 0.02, 80, 40, 42);
run('Réseau dégradé', 0.25, 200, 150, 1337);
run('Avec coupure totale de 7 s', 0.05, 120, 80, 777);
console.log('\n✅ simtest-net : tous les scénarios passent');
