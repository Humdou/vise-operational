// IA adverse : joue comme un joueur, soumise au brouillard, sans triche.
import { Game, Building, Unit } from './engine';
import {
  UNITS, BUILDINGS, UnitTypeId, BuildingTypeId, UpgradeId, Difficulty,
} from './data';

interface KnownBuilding {
  id: number;
  x: number; y: number;
  type: BuildingTypeId;
  owner: number;
}

interface DiffParams {
  thinkInterval: number;     // cadence de décision
  reactionDelay: number;     // délai avant réaction défensive
  harvPerRefinery: number;
  maxHarvesters: number;
  maxRefineries: number;     // raffineries visées (expansion)
  defensesPerBase: number;   // défenses près du QG
  defPerRefinery: number;    // défenses près de chaque raffinerie
  attackBase: number;        // valeur d'armée pour attaquer
  retreatRatio: number;      // 0 = ne recule jamais
  harass: boolean;
  harassCooldown: number;
  protectHarvesters: boolean;
  expandSkill: number;       // 0..1 qualité du choix de gisement
  upgradeAppetite: number;   // 0..1
  armyGrowth: number;        // unités cibles / minute
  techTiming: number;        // moment (s) où radar/tech/aéroport deviennent prioritaires
  labTiming: number;         // moment (s) où le Laboratoire avancé devient prioritaire
  counterAttack: boolean;    // riposter sur le territoire de l'agresseur
  dithers: number;           // 0..1 probabilité de "rater" un cycle de décision
  maxFactories: number;
  maxBarracks: number;
}

const DIFF: Record<Difficulty, DiffParams> = {
  easy: {
    thinkInterval: 3.2, reactionDelay: 3.5, harvPerRefinery: 1.5, maxHarvesters: 4,
    maxRefineries: 2, defensesPerBase: 1, defPerRefinery: 0,
    attackBase: 2200, retreatRatio: 0, harass: false, harassCooldown: 90,
    protectHarvesters: false, expandSkill: 0.3, upgradeAppetite: 0.2,
    armyGrowth: 2.4, techTiming: 420, labTiming: 99999, counterAttack: false,
    dithers: 0.3, maxFactories: 1, maxBarracks: 1,
  },
  normal: {
    thinkInterval: 1.8, reactionDelay: 1.5, harvPerRefinery: 2.2, maxHarvesters: 7,
    maxRefineries: 4, defensesPerBase: 2, defPerRefinery: 1,
    attackBase: 2450, retreatRatio: 0.48, harass: true, harassCooldown: 44,
    protectHarvesters: true, expandSkill: 0.7, upgradeAppetite: 0.6,
    armyGrowth: 4.4, techTiming: 250, labTiming: 390, counterAttack: true,
    dithers: 0.08, maxFactories: 2, maxBarracks: 1,
  },
  hard: {
    thinkInterval: 0.75, reactionDelay: 0.55, harvPerRefinery: 3.2, maxHarvesters: 12,
    maxRefineries: 7, defensesPerBase: 3, defPerRefinery: 2,
    attackBase: 2550, retreatRatio: 0.66, harass: true, harassCooldown: 22,
    protectHarvesters: true, expandSkill: 1.0, upgradeAppetite: 1.0,
    armyGrowth: 8.2, techTiming: 165, labTiming: 245, counterAttack: true,
    dithers: 0, maxFactories: 4, maxBarracks: 2,
  },
};

const COMPOSITION: { type: UnitTypeId; weight: number }[] = [
  { type: 'tank', weight: 0.34 },
  { type: 'rifle', weight: 0.22 },
  { type: 'bazooka', weight: 0.16 },
  { type: 'jeep', weight: 0.10 },
  { type: 'artillery', weight: 0.10 },
  { type: 'sniper', weight: 0.08 },
  // Niveau 2 (pris en compte seulement si le bâtiment producteur existe).
  { type: 'heavytank', weight: 0.14 },
  { type: 'tankdestroyer', weight: 0.09 },
  { type: 'heavyarty', weight: 0.05 },
  { type: 'elite', weight: 0.12 },
  { type: 'rocketeer', weight: 0.08 },
  { type: 'kamikaze', weight: 0.05 },
];

const UPGRADE_ORDER: UpgradeId[] = ['refining', 'ammo', 'armor', 'powerplus', 'optics', 'repairs'];

export class AIController {
  private g: Game;
  private pid: number;
  private p: DiffParams;
  private thinkT: number;
  private known = new Map<number, KnownBuilding>();
  private scoutId = 0;
  private scoutTargetT = 0;
  private waveIds: number[] = [];
  private waveTarget: { x: number; y: number } | null = null;
  private waveStartT = 0;
  private attackThreshold: number;
  private harassIds: number[] = [];
  private harassT = 0;
  private reserve = 0; // minerai épargné pour l'objectif de construction
  private lastDefenseT = -100;
  private needAA = false;
  // Riposte : se souvenir de qui nous a attaqués récemment.
  private revengeOwner = -1;
  private revengeT = -999;
  // Alertes répétées : déclenche des défenses réactives au point chaud.
  private alertTimes: number[] = [];
  // Mémoire de composition adverse observée (décroît avec le temps).
  private seenVehicles = 0;
  private seenInfantry = 0;
  private lastScoutObjective: { x: number; y: number } | null = null;

  constructor(game: Game, playerId: number, difficulty: Difficulty) {
    this.g = game;
    this.pid = playerId;
    this.p = DIFF[difficulty];
    this.thinkT = 1 + playerId * 0.6; // décalage pour étaler la charge CPU
    this.attackThreshold = this.p.attackBase;
  }

  update(dt: number) {
    const me = this.g.players[this.pid];
    if (me.defeated || this.g.over) return;
    this.thinkT -= dt;
    if (this.thinkT > 0) return;
    this.thinkT = this.p.thinkInterval;
    this.think();
  }

  // ------------------------------------------------------------------ pensée

  private think() {
    this.observe();
    this.manageEconomyAndConstruction();
    this.manageProduction();
    this.manageDefense();
    if (this.p.protectHarvesters) this.protectHarvesters();
    this.manageScouting();
    this.manageTactics();
    this.manageAttack();
    this.manageRepairs();
  }

  // Met à jour ce que l'IA sait : uniquement ce qu'elle voit réellement.
  private observe() {
    for (const b of this.g.buildings) {
      if (b.dead || b.owner === this.pid || this.g.players[b.owner].defeated) continue;
      if (this.g.buildingVisibleTo(this.pid, b)) {
        const c = this.g.buildingCenter(b);
        this.known.set(b.id, { id: b.id, x: c.x, y: c.y, type: b.type, owner: b.owner });
        if (b.type === 'airport') this.needAA = true;
      }
    }
    // Oublier un bâtiment seulement si son emplacement, visible, est vide.
    for (const [id, kb] of this.known) {
      const real = this.g.buildingById.get(id);
      if (!real || real.dead || this.g.players[kb.owner].defeated) {
        if (this.g.isVisibleTo(this.pid, kb.x, kb.y) || this.g.players[kb.owner].defeated) this.known.delete(id);
      }
    }
    this.seenVehicles *= 0.92;
    this.seenInfantry *= 0.92;
    for (const u of this.g.units) {
      if (u.dead || u.owner === this.pid || this.g.players[u.owner].defeated) continue;
      if (!this.g.isVisibleTo(this.pid, u.x, u.y)) continue;
      const def = UNITS[u.type];
      if (def.isAir) { this.needAA = true; continue; }
      if (!def.weapon) continue;
      if (def.armor === 'inf') this.seenInfantry += 1;
      else this.seenVehicles += 1;
    }
  }

  // -------------------------------------------------------------- aides état

  private myBuildings(type?: BuildingTypeId): Building[] {
    return this.g.buildings.filter(b => !b.dead && b.owner === this.pid && (!type || b.type === type));
  }

  private myUnits(type?: UnitTypeId): Unit[] {
    return this.g.units.filter(u => !u.dead && u.owner === this.pid && (!type || u.type === type));
  }

  private hq(): Building | null {
    return this.myBuildings('hq')[0] ?? null;
  }

  private baseCenter(): { x: number; y: number } {
    const hq = this.hq();
    if (hq) return this.g.buildingCenter(hq);
    const bs = this.myBuildings();
    if (bs.length === 0) return { x: this.g.map.w / 2, y: this.g.map.h / 2 };
    let x = 0, y = 0;
    for (const b of bs) { const c = this.g.buildingCenter(b); x += c.x; y += c.y; }
    return { x: x / bs.length, y: y / bs.length };
  }

  private enemyDirection(): { x: number; y: number } {
    const base = this.baseCenter();
    let x = 0, y = 0, n = 0;
    for (const kb of this.known.values()) { x += kb.x; y += kb.y; n++; }
    if (n === 0) return { x: this.g.map.w / 2, y: this.g.map.h / 2 };
    return { x: x / n, y: y / n };
  }

  private visibleEnemiesNear(x: number, y: number, r: number): Unit[] {
    const out: Unit[] = [];
    for (const u of this.g.units) {
      if (u.dead || u.owner === this.pid || this.g.players[u.owner].defeated) continue;
      if (Math.hypot(u.x - x, u.y - y) > r) continue;
      if (!this.g.isVisibleTo(this.pid, u.x, u.y)) continue;
      out.push(u);
    }
    return out;
  }

  private isCombat(u: Unit): boolean {
    return (!!UNITS[u.type].weapon || u.type === 'kamikaze') && !UNITS[u.type].isAir;
  }

  private armyValue(units: Unit[]): number {
    let v = 0;
    for (const u of units) if (this.isCombat(u)) v += UNITS[u.type].cost;
    return v;
  }

  private econBuildings(): Building[] {
    return [
      ...this.myBuildings('refinery'),
      ...this.myBuildings('refinery2'),
    ].filter(b => b.built);
  }

  private knownEnemyBuildings(...types: BuildingTypeId[]): KnownBuilding[] {
    return [...this.known.values()].filter(kb => types.includes(kb.type));
  }

  private nearestKnownEnemyEco(): KnownBuilding | null {
    const base = this.baseCenter();
    const ecos = this.knownEnemyBuildings('refinery', 'refinery2', 'depot', 'power', 'power2');
    let best: KnownBuilding | null = null, bestScore = -Infinity;
    for (const kb of ecos) {
      const d = Math.hypot(kb.x - base.x, kb.y - base.y);
      const value =
        kb.type === 'refinery2' ? 620 :
        kb.type === 'refinery' ? 560 :
        kb.type === 'depot' ? 430 :
        kb.type === 'power2' ? 360 : 300;
      const score = value - d * 3;
      if (score > bestScore) { bestScore = score; best = kb; }
    }
    return best;
  }

  private visibleEnemyHarvesters(): Unit[] {
    return this.g.units.filter(u =>
      !u.dead &&
      u.owner !== this.pid &&
      u.type === 'harvester' &&
      !this.g.players[u.owner].defeated &&
      this.g.isVisibleTo(this.pid, u.x, u.y));
  }

  // ------------------------------------------------------------ construction
  //
  // L'IA choisit UN objectif de construction et ÉPARGNE pour lui : la
  // production d'unités ne dépense que l'excédent (this.reserve). C'est ce
  // qui lui permet de réellement développer sa base au lieu de tout dépenser
  // en unités bon marché.

  private manageEconomyAndConstruction() {
    const me = this.g.players[this.pid];
    this.reserve = 0;
    if (this.myBuildings().some(b => !b.built)) return; // une construction à la fois
    if (this.g.rng() < this.p.dithers) return;          // IA faible : hésite parfois

    const goal = this.chooseConstructionGoal();
    if (!goal) {
      // Rien à construire : investir dans les améliorations.
      const tech = this.myBuildings('tech').find(b => b.built && b.queue.length === 0);
      if (tech && me.ore > 800 && this.g.rng() < this.p.upgradeAppetite) {
        for (const up of UPGRADE_ORDER) {
          if (!me.upgrades[up] && this.g.queueUpgrade(tech.id, up)) return;
        }
      }
      return;
    }

    const cost = BUILDINGS[goal.type].cost;
    if (me.ore >= cost && this.g.canBuild(this.pid, goal.type).ok) {
      if (this.placeNear(goal.type, goal.ax, goal.ay, goal.maxR)) return;
      // Emplacement introuvable : repli près de la base.
      const base = this.baseCenter();
      if (this.placeNear(goal.type, base.x, base.y, 14)) return;
    } else {
      this.reserve = cost; // épargner pour l'objectif
    }
  }

  private chooseConstructionGoal(): { type: BuildingTypeId; ax: number; ay: number; maxR: number } | null {
    const me = this.g.players[this.pid];
    const base = this.baseCenter();
    const counts = (t: BuildingTypeId) => this.g.countBuildings(this.pid, t, false);
    const at = (x: number, y: number, type: BuildingTypeId, maxR = 12) => ({ type, ax: x, ay: y, maxR });

    // 1. L'énergie ne doit jamais manquer (Centrale T2 une fois le labo construit).
    const hasLab = this.g.countBuildings(this.pid, 'lab') > 0;
    if (me.energyRatio < 1 || (counts('power') > 0 && me.powerUse > me.powerProd * 0.85)) {
      return at(base.x, base.y, hasLab ? 'power2' : 'power');
    }
    if (counts('power') === 0) return at(base.x, base.y, 'power');

    // 2. Première raffinerie, collée au gisement le plus proche.
    if (counts('refinery') === 0) {
      const node = this.pickExpansionNode(base, 22);
      return node ? at(node.x, node.y, 'refinery', 8) : at(base.x, base.y, 'refinery');
    }

    // 3. Chaîne de production de base.
    if (counts('barracks') === 0) return at(base.x, base.y, 'barracks');
    if (counts('factory') === 0) return at(base.x, base.y, 'factory');

    // 3 bis. Production doublée en milieu de partie (économie le permettant).
    const refsBuilt = this.econBuildings();
    if (counts('factory') < this.p.maxFactories && this.g.time > 330 && refsBuilt.length >= 2) {
      return at(base.x, base.y, 'factory');
    }
    if (counts('barracks') < this.p.maxBarracks && this.g.time > 400 && refsBuilt.length >= 2) {
      return at(base.x, base.y, 'barracks');
    }

    // 4. Expansion économique : une raffinerie par gisement découvert non couvert.
    // Quand l'heure du Laboratoire est venue, l'expansion au-delà de 3 raffineries
    // attend : la supériorité technologique passe d'abord.
    const refs = this.econBuildings();
    const labDue = this.g.time > this.p.labTiming && counts('lab') === 0;
    const refCap = labDue ? Math.min(this.p.maxRefineries, this.p.expandSkill >= 1 ? 4 : 3) : this.p.maxRefineries;
    const wantRefs = Math.min(refCap, 1 + Math.floor(this.g.time / (this.p.expandSkill >= 1 ? 155 : 200)) + (me.ore > 1300 ? 1 : 0));
    if (refs.length < wantRefs && this.g.rng() < this.p.expandSkill + 0.25) {
      const node = this.pickExpansionNode(base, 999, refs);
      if (node) return at(node.x, node.y, 'refinery', 7);
    }

    // 4 bis. Laboratoire avancé : investissement prioritaire dès l'heure venue.
    if (labDue && refs.length >= 2 && counts('factory') > 0) return at(base.x, base.y, 'lab');

    // 5. Défenses : QG puis chaque raffinerie (selon la difficulté).
    if (this.g.time > 140) {
      const defAround = (x: number, y: number) => {
        let n = 0;
        for (const b of this.myBuildings()) {
          if (b.type !== 'turret' && b.type !== 'atgun' && b.type !== 'aa') continue;
          const c = this.g.buildingCenter(b);
          if (Math.hypot(c.x - x, c.y - y) <= 10) n++;
        }
        return n;
      };
      // Défense réactive : attaques répétées => fortifier le point chaud.
      if (this.alertTimes.length >= 3 && defAround(me.alertX, me.alertY) < this.p.defensesPerBase + 2) {
        const type: BuildingTypeId = counts('turret') <= counts('atgun') ? 'turret' : 'atgun';
        return at(me.alertX, me.alertY, type, 6);
      }
      const spots: { x: number; y: number; want: number }[] = [
        { x: base.x, y: base.y, want: this.p.defensesPerBase },
        ...refs.map(r => {
          const c = this.g.buildingCenter(r);
          // Une raffinerie posée sur du minerai rare mérite une garde renforcée.
          const nearRare = this.g.nodes.some(n =>
            n.kind === 'rare' && n.amount > 100 && Math.hypot(n.tx - c.x, n.ty - c.y) < 9);
          return { x: c.x, y: c.y, want: this.p.defPerRefinery + (nearRare ? 1 : 0) };
        }),
      ];
      for (const s of spots) {
        if (defAround(s.x, s.y) >= s.want) continue;
        // Orienter la défense vers l'ennemi connu.
        const dir = this.enemyDirection();
        const dd = Math.max(1, Math.hypot(dir.x - s.x, dir.y - s.y));
        const px = s.x + ((dir.x - s.x) / dd) * 5 + (this.g.rng() - 0.5) * 3;
        const py = s.y + ((dir.y - s.y) / dd) * 5 + (this.g.rng() - 0.5) * 3;
        const type: BuildingTypeId =
          this.needAA && counts('aa') < counts('turret') ? 'aa' :
          counts('turret') <= counts('atgun') ? 'turret' : 'atgun';
        return at(px, py, type, 7);
      }
    }
    if (this.needAA && counts('aa') < 2) return at(base.x, base.y, 'aa', 9);

    // 6. Technologie : radar → centre tactique → aéroport → bâtiments avancés.
    const t = this.p.techTiming;
    if (counts('radar') === 0 && this.g.time > t) return at(base.x, base.y, 'radar');
    if (counts('tech') === 0 && this.g.time > t * 1.4 && this.p.upgradeAppetite > 0.3) return at(base.x, base.y, 'tech');
    if (counts('airport') === 0 && this.g.time > t * 1.8 && this.p.upgradeAppetite > 0.5) return at(base.x, base.y, 'airport');

    // 7. Dépôt logistique près des raffineries, centre radar avancé.
    if (counts('depot') === 0 && refs.length >= 2 && this.g.time > 300 && this.p.upgradeAppetite >= 0.5) {
      const c = this.g.buildingCenter(refs[0]);
      return at(c.x, c.y, 'depot', 6);
    }
    if (counts('radarcenter') === 0 && counts('radar') > 0 && this.g.time > t * 2.2 && this.p.upgradeAppetite > 0.5) {
      return at(base.x, base.y, 'radarcenter');
    }

    // 8. Niveau 2 : le Laboratoire avancé est l'investissement de milieu de
    // partie (économie solide requise), puis la filière T2 se déploie.
    if (refs.length >= 2 && this.g.time > this.p.labTiming) {
      if (counts('lab') === 0) return at(base.x, base.y, 'lab');
      if (this.g.countBuildings(this.pid, 'lab') > 0) { // labo terminé
        if (counts('power2') === 0 && me.powerUse > me.powerProd * 0.6) return at(base.x, base.y, 'power2');
        if (counts('factory2') === 0) return at(base.x, base.y, 'factory2');
        if (counts('barracks2') === 0) return at(base.x, base.y, 'barracks2');
        if (this.p.expandSkill >= 1 && counts('factory2') < 2 && refs.length >= 4 && me.ore > 1200) {
          return at(base.x, base.y, 'factory2');
        }
        // Raffinerie T2 sur le gisement couvert le plus riche : zone économique forte.
        if (counts('refinery2') < 1 + Math.floor(this.g.time / 700) && me.ore > 800) {
          let bestN: { x: number; y: number } | null = null, bestA = 0;
          for (const n of this.g.nodes) {
            if (n.amount < 400 || !this.g.isExploredBy(this.pid, n.tx, n.ty)) continue;
            const v = n.amount * (n.kind === 'rare' ? 3 : 1);
            if (v > bestA) { bestA = v; bestN = { x: n.tx, y: n.ty }; }
          }
          if (bestN) return at(bestN.x, bestN.y, 'refinery2', 8);
        }
      }
    }

    return null;
  }

  // Choisit un gisement à exploiter (qualité selon la difficulté).
  private pickExpansionNode(
    base: { x: number; y: number }, maxDist: number, existingRefs: Building[] = [],
  ): { x: number; y: number } | null {
    const candidates: { x: number; y: number; score: number }[] = [];
    for (const n of this.g.nodes) {
      if (n.amount < 300) continue;
      if (!this.g.isExploredBy(this.pid, n.tx, n.ty)) continue;
      const d = Math.hypot(n.tx - base.x, n.ty - base.y);
      if (d > maxDist) continue;
      let covered = false;
      for (const r of existingRefs) {
        const c = this.g.buildingCenter(r);
        if (Math.hypot(c.x - n.tx, c.y - n.ty) < 11) { covered = true; break; }
      }
      if (covered) continue;
      // Le minerai rare (valeur triple) attire fortement l'expansion.
      const value = n.amount * (n.kind === 'rare' ? 2.5 : 1);
      candidates.push({ x: n.tx, y: n.ty, score: value - d * 18 });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    // Une IA faible choisit parfois un gisement médiocre.
    if (this.g.rng() > this.p.expandSkill && candidates.length > 1) {
      return candidates[Math.floor(this.g.rng() * candidates.length)];
    }
    return candidates[0];
  }

  // Recherche en spirale d'un emplacement valide autour d'un point.
  private placeNear(type: BuildingTypeId, ax: number, ay: number, maxR = 14): boolean {
    const def = BUILDINGS[type];
    let best: { tx: number; ty: number; score: number } | null = null;
    for (let r = 1; r <= maxR; r += 1) {
      const steps = Math.max(6, r * 5);
      const a0 = this.g.rng() * Math.PI * 2;
      for (let s = 0; s < steps; s++) {
        const a = a0 + (s / steps) * Math.PI * 2;
        const tx = Math.round(ax + Math.cos(a) * r - def.w / 2);
        const ty = Math.round(ay + Math.sin(a) * r - def.h / 2);
        if (this.aiKnowsFootprint(tx, ty, def.w, def.h) && this.g.canPlace(this.pid, type, tx, ty)) {
          const score = this.scorePlacement(type, tx, ty, ax, ay);
          if (!best || score > best.score) best = { tx, ty, score };
        }
      }
    }
    return best ? this.g.place(this.pid, type, best.tx, best.ty) : false;
  }

  private aiKnowsFootprint(tx: number, ty: number, w: number, h: number): boolean {
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) {
        if (!this.g.isExploredBy(this.pid, x, y)) return false;
      }
    }
    return true;
  }

  private scorePlacement(type: BuildingTypeId, tx: number, ty: number, ax: number, ay: number): number {
    const def = BUILDINGS[type];
    const cx = tx + def.w / 2, cy = ty + def.h / 2;
    const base = this.baseCenter();
    const enemy = this.enemyDirection();
    const toEnemyX = enemy.x - base.x, toEnemyY = enemy.y - base.y;
    const toEnemyD = Math.max(1, Math.hypot(toEnemyX, toEnemyY));
    const frontX = base.x + (toEnemyX / toEnemyD) * 7;
    const frontY = base.y + (toEnemyY / toEnemyD) * 7;
    const backX = base.x - (toEnemyX / toEnemyD) * 5;
    const backY = base.y - (toEnemyY / toEnemyD) * 5;

    let score = -Math.hypot(cx - ax, cy - ay) * 10;

    for (const b of this.myBuildings()) {
      const bc = this.g.buildingCenter(b);
      const d = Math.hypot(cx - bc.x, cy - bc.y);
      if (d < Math.max(def.w, def.h) + Math.max(b.w, b.h) + 1.5) score -= 180;
      if (d < 8) score -= 18;
      if (b.type === type && d < 13) score -= 90;
      if ((type === 'power' || type === 'power2') && d < 7) score += 12;
    }

    if (type === 'refinery' || type === 'refinery2') {
      let bestNode = Infinity;
      let rareBonus = 0;
      for (const n of this.g.nodes) {
        if (n.amount < 80 || !this.g.isExploredBy(this.pid, n.tx, n.ty)) continue;
        const d = Math.hypot(cx - n.tx, cy - n.ty);
        if (d < bestNode) {
          bestNode = d;
          rareBonus = n.kind === 'rare' ? 120 : 0;
        }
      }
      score += Math.max(0, 260 - bestNode * 28) + rareBonus;
      score += Math.max(0, 80 - Math.hypot(cx - base.x, cy - base.y) * 2);
    } else if (type === 'turret' || type === 'atgun' || type === 'aa') {
      score += Math.max(0, 180 - Math.hypot(cx - frontX, cy - frontY) * 18);
      score += Math.max(0, 120 - Math.hypot(cx - ax, cy - ay) * 20);
      if (type === 'aa' && this.needAA) score += 80;
    } else if (type === 'factory' || type === 'factory2' || type === 'barracks' || type === 'barracks2') {
      score += Math.max(0, 150 - Math.hypot(cx - frontX, cy - frontY) * 10);
      score += type.endsWith('2') ? Math.max(0, 80 - Math.hypot(cx - base.x, cy - base.y) * 6) : 0;
    } else if (type === 'power' || type === 'power2' || type === 'tech' || type === 'lab') {
      score += Math.max(0, 140 - Math.hypot(cx - backX, cy - backY) * 12);
    } else if (type === 'radar' || type === 'radarcenter' || type === 'airport') {
      score += Math.max(0, 120 - Math.hypot(cx - base.x, cy - base.y) * 8);
    } else {
      score += Math.max(0, 100 - Math.hypot(cx - base.x, cy - base.y) * 7);
    }

    if (this.p.expandSkill < 0.6) score += (this.g.rng() - 0.5) * 220;
    else score += (this.g.rng() - 0.5) * 35;
    return score;
  }

  // -------------------------------------------------------------- production

  private manageProduction() {
    const me = this.g.players[this.pid];
    // La production ne touche pas à l'épargne destinée à la construction.
    const spendable = () => me.ore - this.reserve;

    // Récolteurs : l'économie passe avant tout (les 2 premiers ignorent l'épargne).
    const refs = this.econBuildings();
    let harvesters = this.myUnits('harvester').length;
    const richEco = refs.filter(r => r.type === 'refinery2').length;
    const wantHarv = Math.min(
      Math.max(2, Math.round(refs.length * this.p.harvPerRefinery + richEco * 0.8)),
      this.p.maxHarvesters,
    );
    const factories = this.myBuildings('factory').filter(b => b.built);

    // File de production plus profonde quand l'économie le permet.
    const queueDepth = spendable() > 1700 && refs.length >= 3 ? 3 : spendable() > 900 ? 2 : 1;
    for (const f of factories) {
      while (f.queue.length < queueDepth) {
        if (harvesters < wantHarv) {
          const budget = harvesters < 2 ? me.ore : spendable();
          if (budget >= UNITS.harvester.cost && this.g.queueUnit(f.id, 'harvester')) {
            harvesters++;
            continue;
          }
        }
        const pick = this.pickArmyUnit('factory');
        if (pick && spendable() > UNITS[pick].cost + 50 && this.g.queueUnit(f.id, pick)) continue;
        break;
      }
    }

    const barracks = this.myBuildings('barracks').filter(b => b.built);
    for (const b of barracks) {
      if (b.queue.length > 0) continue;
      // Garder un ingénieur en réserve (difficile/moyen).
      if (this.p.protectHarvesters && this.myUnits('engineer').length < 1 && spendable() > 600 && this.g.time > 200) {
        this.g.queueUnit(b.id, 'engineer');
        continue;
      }
      const pick = this.pickArmyUnit('barracks');
      if (pick && spendable() > UNITS[pick].cost + 50) this.g.queueUnit(b.id, pick);
    }

    // Production de niveau 2.
    const factories2 = this.myBuildings('factory2').filter(b => b.built);
    for (const f of factories2) {
      if (f.queue.length >= queueDepth) continue;
      // Un véhicule radar pour l'information, puis les blindés lourds.
      if (this.myUnits('radarvehicle').length === 0 && spendable() > UNITS.radarvehicle.cost + 200) {
        if (this.g.queueUnit(f.id, 'radarvehicle')) continue;
      }
      const pick = this.pickArmyUnit('factory2');
      if (pick && spendable() > UNITS[pick].cost + 100) this.g.queueUnit(f.id, pick);
    }
    const barracks2 = this.myBuildings('barracks2').filter(b => b.built);
    for (const b of barracks2) {
      if (b.queue.length >= queueDepth) continue;
      const pick = this.pickArmyUnit('barracks2');
      if (pick && spendable() > UNITS[pick].cost + 50) this.g.queueUnit(b.id, pick);
    }

    for (const a of this.myBuildings('airport').filter(b => b.built)) {
      if (a.queue.length > 0) continue;
      // L'avion radar (pas cher) d'abord : l'information guide tout le reste.
      if (this.myUnits('scoutplane').length === 0 && spendable() > UNITS.scoutplane.cost + 100) {
        if (this.g.queueUnit(a.id, 'scoutplane')) continue;
      }
      if (spendable() > UNITS.bomber.cost + 300) this.g.queueUnit(a.id, 'bomber');
    }

    // Points de ralliement vers l'avant de la base.
    const base = this.baseCenter();
    const dir = this.enemyDirection();
    const dd = Math.max(1, Math.hypot(dir.x - base.x, dir.y - base.y));
    const rally = { x: base.x + ((dir.x - base.x) / dd) * 7, y: base.y + ((dir.y - base.y) / dd) * 7 };
    for (const b of [...factories, ...barracks, ...factories2, ...barracks2]) {
      if (!b.rally) this.g.setRally(b.id, rally.x, rally.y);
    }
  }

  private pickArmyUnit(from: 'factory' | 'barracks' | 'factory2' | 'barracks2'): UnitTypeId | null {
    const targetSize = Math.min(60, 6 + (this.g.time / 60) * this.p.armyGrowth);
    const counts: Partial<Record<UnitTypeId, number>> = {};
    let total = 0;
    for (const u of this.myUnits()) {
      if (!this.isCombat(u)) continue;
      counts[u.type] = (counts[u.type] ?? 0) + 1;
      total++;
    }
    if (total >= targetSize) return null;
    // Contre-composition selon ce que l'IA a réellement observé.
    const vehHeavy = this.seenVehicles > this.seenInfantry * 1.5 && this.seenVehicles > 3;
    const infHeavy = this.seenInfantry > this.seenVehicles * 1.5 && this.seenInfantry > 4;
    const counterMult = (t: UnitTypeId): number => {
      if (vehHeavy) {
        if (t === 'bazooka' || t === 'rocketeer') return 2.0;
        if (t === 'tankdestroyer') return 1.8;
        if (t === 'tank' || t === 'heavytank') return 1.2;
        if (t === 'sniper') return 0.35;
      } else if (infHeavy) {
        if (t === 'sniper') return 1.9;
        if (t === 'elite') return 1.6;
        if (t === 'rifle') return 1.3;
        if (t === 'bazooka' || t === 'rocketeer') return 0.5;
        if (t === 'tankdestroyer') return 0.4;
      }
      return 1;
    };
    let best: UnitTypeId | null = null, bestDeficit = 0;
    for (const c of COMPOSITION) {
      if (UNITS[c.type].builtAt !== from) continue;
      if (c.type === 'artillery' && this.g.countBuildings(this.pid, 'factory') === 0) continue;
      const want = c.weight * counterMult(c.type) * targetSize;
      const deficit = want - (counts[c.type] ?? 0);
      if (deficit > bestDeficit) { bestDeficit = deficit; best = c.type; }
    }
    return best;
  }

  // ----------------------------------------------------------------- défense

  private manageDefense() {
    const me = this.g.players[this.pid];
    const since = this.g.time - me.alertT;
    if (since > 7 || since < this.p.reactionDelay) return;
    if (this.g.time - this.lastDefenseT < 5) return;

    const base = this.baseCenter();
    const alertNearBase = Math.hypot(me.alertX - base.x, me.alertY - base.y) < 26;
    if (!alertNearBase) return;
    this.lastDefenseT = this.g.time;
    this.alertTimes.push(this.g.time);
    this.alertTimes = this.alertTimes.filter(t => this.g.time - t < 150);

    // Identifier l'agresseur (s'il est visible) pour riposter plus tard.
    if (this.p.counterAttack) {
      const aggressors = this.visibleEnemiesNear(me.alertX, me.alertY, 9).filter(u => UNITS[u.type].weapon);
      if (aggressors.length > 0) {
        this.revengeOwner = aggressors[0].owner;
        this.revengeT = this.g.time;
      }
    }

    // Rappeler les unités de combat proches (les vagues d'attaque continuent).
    const defenders: number[] = [];
    for (const u of this.myUnits()) {
      if (!this.isCombat(u)) continue;
      if (this.waveIds.includes(u.id)) continue;
      if (Math.hypot(u.x - base.x, u.y - base.y) < 30) defenders.push(u.id);
    }
    if (defenders.length > 0) this.g.cmdMove(defenders, me.alertX, me.alertY, true);

    // L'aviation frappe l'attaquant si possible.
    for (const b of this.myUnits('bomber')) {
      if (b.airState === 'pad' && (b.ammo ?? 0) > 0 && (b.rearmT ?? 0) <= 0) {
        const enemies = this.visibleEnemiesNear(me.alertX, me.alertY, 8);
        if (enemies.length > 0) this.g.cmdAttack([b.id], enemies[0].id, false);
      }
    }
  }

  private protectHarvesters() {
    const availableGuards = this.myUnits().filter(u =>
      this.isCombat(u) &&
      u.order.kind === 'idle' &&
      !this.waveIds.includes(u.id) &&
      !this.harassIds.includes(u.id) &&
      u.id !== this.scoutId);

    if (availableGuards.length > 0) {
      const existingEscorts = this.myUnits().filter(u => this.isCombat(u) && u.order.kind === 'escort').length;
      let escortBudget = Math.max(0, (this.p.expandSkill >= 1 ? 4 : 2) - existingEscorts);
      for (const h of this.myUnits('harvester')) {
        if (availableGuards.length === 0 || escortBudget <= 0) break;
        const farFromGuard = !this.myUnits().some(u =>
          this.isCombat(u) &&
          u.order.kind === 'escort' &&
          u.order.targetId === h.id);
        const farFromBase = Math.hypot(h.x - this.baseCenter().x, h.y - this.baseCenter().y) > 16;
        if (farFromGuard && farFromBase) {
          const escort = availableGuards.shift()!;
          this.g.cmdEscort([escort.id], h.id);
          escortBudget--;
        }
      }
    }

    for (const h of this.myUnits('harvester')) {
      const threats = this.visibleEnemiesNear(h.x, h.y, 6).filter(t => UNITS[t.type].weapon);
      if (threats.length === 0) continue;
      const ref = this.g.nearestRefinery(this.pid, h.x, h.y);
      if (ref) {
        // Replier le récolteur ; il reprendra la récolte au prochain cycle.
        const c = this.g.buildingCenter(ref);
        this.g.cmdMove([h.id], c.x, c.y + ref.h);
      }
      const defenders: number[] = [];
      for (const u of this.myUnits()) {
        if (!this.isCombat(u)) continue;
        if (this.waveIds.includes(u.id)) continue;
        if (Math.hypot(u.x - h.x, u.y - h.y) < 22) defenders.push(u.id);
      }
      if (defenders.length > 0) {
        // Les deux plus proches passent en escorte durable du récolteur,
        // les autres chargent la menace.
        const escorts = defenders.slice(0, 2);
        const strikers = defenders.slice(2);
        this.g.cmdEscort(escorts, h.id);
        if (strikers.length > 0) this.g.cmdAttack(strikers, threats[0].id, false);
      }
      break;
    }
    // Récolteurs au repos : reprendre le travail.
    for (const h of this.myUnits('harvester')) {
      if (h.order.kind === 'idle') {
        const threats = this.visibleEnemiesNear(h.x, h.y, 7);
        if (threats.length === 0) {
          const n = this.g.nearestNode(h.x, h.y, this.pid);
          if (n) this.g.cmdHarvest([h.id], n.id);
        }
      }
    }
  }

  private manageTactics() {
    const base = this.baseCenter();
    const enemyEco = this.pickPressureTarget();

    for (const u of this.myUnits()) {
      if (!this.isCombat(u)) continue;
      const def = UNITS[u.type];
      if (u.hp < def.hp * 0.28 && !this.harassIds.includes(u.id)) {
        this.waveIds = this.waveIds.filter(id => id !== u.id);
        const ref = this.g.nearestRefinery(this.pid, u.x, u.y);
        const fallback = ref ? this.g.buildingCenter(ref) : base;
        this.g.cmdMove([u.id], fallback.x, fallback.y);
        continue;
      }

      if (u.order.kind !== 'idle' && u.order.kind !== 'escort') continue;
      const enemies = this.visibleEnemiesNear(u.x, u.y, 8).filter(e => UNITS[e.type].weapon || e.type === 'harvester');
      if (enemies.length > 0) {
        enemies.sort((a, b) => this.targetUnitScore(b, u.x, u.y) - this.targetUnitScore(a, u.x, u.y));
        this.g.cmdAttack([u.id], enemies[0].id, false);
      } else if (enemyEco && u.order.kind === 'idle' && this.p.expandSkill >= 1 && Math.hypot(u.x - base.x, u.y - base.y) > 18) {
        this.g.cmdMove([u.id], enemyEco.x, enemyEco.y, true);
      }
    }
  }

  private targetUnitScore(u: Unit, x: number, y: number): number {
    const d = Math.hypot(u.x - x, u.y - y);
    const def = UNITS[u.type];
    const role =
      u.type === 'harvester' ? 120 :
      u.type === 'artillery' || u.type === 'heavyarty' ? 95 :
      u.type === 'bomber' ? 90 :
      def.armor === 'heavy' ? 70 :
      def.armor === 'inf' ? 45 : 55;
    const weak = (1 - u.hp / Math.max(1, def.hp)) * 45;
    return role + weak - d * 4;
  }

  // ------------------------------------------------------------- exploration

  private manageScouting() {
    const me = this.g.players[this.pid];
    const exploredFrac = me.exploredCount / (this.g.map.w * this.g.map.h);
    // Une IA compétente continue d'explorer plus longtemps (information = pouvoir).
    if (exploredFrac > 0.76 + this.p.expandSkill * 0.16) return;

    // Avion radar disponible : reconnaissance large et sans risque.
    const plane = this.myUnits('scoutplane').find(u => u.airState === 'pad' && (u.rearmT ?? 0) <= 0);
    if (plane) {
      const target = this.pickScoutTarget(48);
      const bx = target?.x ?? -1, by = target?.y ?? -1;
      if (bx >= 0) this.g.cmdMove([plane.id], bx, by);
    }
    const scout = this.scoutId ? this.g.unitById.get(this.scoutId) : undefined;
    if (scout && !scout.dead) {
      if (scout.order.kind !== 'idle' && this.g.time - this.scoutTargetT < 25) return;
    } else {
      this.scoutId = 0;
    }
    // Choisir un éclaireur : véhicule radar (vision énorme), sinon jeep, sinon fusilier.
    if (!this.scoutId) {
      const idleOf = (t: UnitTypeId) =>
        this.myUnits(t).filter(u => u.order.kind === 'idle' && !this.waveIds.includes(u.id));
      const pick = idleOf('radarvehicle')[0] ?? idleOf('jeep')[0] ?? idleOf('rifle')[0];
      if (!pick) return;
      this.scoutId = pick.id;
    }
    const target = this.pickScoutTarget(36);
    if (target) {
      this.g.cmdMove([this.scoutId], target.x, target.y);
      this.lastScoutObjective = target;
      this.scoutTargetT = this.g.time;
    }
  }

  private pickScoutTarget(samples: number): { x: number; y: number } | null {
    const me = this.g.players[this.pid];
    const { w, h } = this.g.map;
    const base = this.baseCenter();
    const refs = this.econBuildings();
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;

    for (const n of this.g.nodes) {
      if (n.amount < 250) continue;
      if (this.g.isExploredBy(this.pid, n.tx, n.ty)) continue;
      const d = Math.hypot(n.tx - base.x, n.ty - base.y);
      const nearRef = refs.some(r => {
        const c = this.g.buildingCenter(r);
        return Math.hypot(c.x - n.tx, c.y - n.ty) < 12;
      });
      if (nearRef) continue;
      const score = n.amount * (n.kind === 'rare' ? 3.2 : 1) - d * 9;
      if (score > bestScore) { bestScore = score; best = { x: n.tx, y: n.ty }; }
    }

    const enemy = this.enemyDirection();
    for (let tries = 0; tries < samples; tries++) {
      let tx: number, ty: number;
      if (this.known.size > 0 && this.g.rng() < 0.45) {
        tx = Math.round(enemy.x + (this.g.rng() - 0.5) * 34);
        ty = Math.round(enemy.y + (this.g.rng() - 0.5) * 34);
      } else {
        tx = 2 + Math.floor(this.g.rng() * (w - 4));
        ty = 2 + Math.floor(this.g.rng() * (h - 4));
      }
      if (tx < 2 || ty < 2 || tx >= w - 2 || ty >= h - 2) continue;
      const i = ty * w + tx;
      if (me.fog[i] !== 0 || !this.g.nav.pass[i]) continue;
      const dBase = Math.hypot(tx - base.x, ty - base.y);
      const dLast = this.lastScoutObjective ? Math.hypot(tx - this.lastScoutObjective.x, ty - this.lastScoutObjective.y) : 20;
      const enemyBias = this.known.size > 0 ? 70 - Math.hypot(tx - enemy.x, ty - enemy.y) : 0;
      const score = dBase * 2 + enemyBias + Math.min(20, dLast);
      if (score > bestScore) { bestScore = score; best = { x: tx, y: ty }; }
    }
    return best;
  }

  // ----------------------------------------------------------------- attaque

  private manageAttack() {
    const me = this.g.players[this.pid];

    // Harcèlement : petits groupes rapides contre récolteurs/économie connus.
    this.harassT -= this.p.thinkInterval;
    if (this.p.harass && this.harassT <= 0) {
      this.harassIds = this.harassIds.filter(id => this.g.unitById.get(id) && !this.g.unitById.get(id)!.dead);
      if (this.harassIds.length === 0) {
        const raiders = this.myUnits().filter(u =>
          this.isCombat(u) &&
          u.order.kind === 'idle' &&
          !this.waveIds.includes(u.id) &&
          u.id !== this.scoutId &&
          (u.type === 'jeep' || u.type === 'rifle' || u.type === 'bazooka' || u.type === 'elite' || u.type === 'rocketeer'));
        const minRaiders = this.p.expandSkill >= 1 ? 2 : 3;
        if (raiders.length >= minRaiders) {
          const target = this.visibleEnemyHarvesters()
            .sort((a, b) => Math.hypot(a.x - this.baseCenter().x, a.y - this.baseCenter().y) -
                            Math.hypot(b.x - this.baseCenter().x, b.y - this.baseCenter().y))[0] ?? null;
          const kref = this.nearestKnownEnemyEco();
          const raidSize = Math.min(this.p.expandSkill >= 1 ? 5 : 3, raiders.length);
          if (target) {
            this.harassIds = raiders.slice(0, raidSize).map(j => j.id);
            this.g.cmdAttack(this.harassIds, target.id, false);
            this.harassT = this.p.harassCooldown;
          } else if (kref) {
            this.harassIds = raiders.slice(0, raidSize).map(j => j.id);
            this.g.cmdMove(this.harassIds, kref.x, kref.y, true);
            this.harassT = this.p.harassCooldown * 1.25;
          }
        }
      }
    }

    // Vague en cours : surveiller, replier si le combat tourne mal.
    this.waveIds = this.waveIds.filter(id => {
      const u = this.g.unitById.get(id);
      return u && !u.dead;
    });
    if (this.waveIds.length > 0 && this.waveTarget) {
      let cx = 0, cy = 0;
      const waveUnits: Unit[] = [];
      for (const id of this.waveIds) {
        const u = this.g.unitById.get(id)!;
        waveUnits.push(u); cx += u.x; cy += u.y;
      }
      cx /= waveUnits.length; cy /= waveUnits.length;

      if (this.p.retreatRatio > 0) {
        const myV = this.armyValue(waveUnits);
        const enemies = this.visibleEnemiesNear(cx, cy, 11).filter(u => UNITS[u.type].weapon);
        let enemyV = this.armyValue(enemies);
        for (const kb of this.known.values()) {
          if ((kb.type === 'turret' || kb.type === 'atgun') && Math.hypot(kb.x - cx, kb.y - cy) < 11) enemyV += 350;
        }
        if (enemyV > 0 && myV / Math.max(1, enemyV) < this.p.retreatRatio) {
          const base = this.baseCenter();
          this.g.cmdMove(this.waveIds, base.x, base.y);
          this.waveIds = [];
          this.waveTarget = null;
          this.attackThreshold *= 1.25;
          return;
        }
      }
      // Vague arrivée et zone nettoyée : nouvelle cible ou fin de vague.
      const dt = Math.hypot(this.waveTarget.x - cx, this.waveTarget.y - cy);
      if (dt < 6 || this.g.time - this.waveStartT > 110) {
        const next = this.pickAttackTarget();
        if (next && this.g.time - this.waveStartT <= 110) {
          this.waveTarget = next;
          this.g.cmdMove(this.waveIds, next.x, next.y, true);
          this.waveStartT = this.g.time;
        } else {
          this.waveIds = [];
          this.waveTarget = null;
        }
      }
      return;
    }

    // Lancer une nouvelle vague ?
    const idle = this.myUnits().filter(u =>
      this.isCombat(u) &&
      (u.order.kind === 'idle' || u.order.kind === 'attackmove') &&
      u.id !== this.scoutId && !this.harassIds.includes(u.id));
    const value = this.armyValue(idle);
    // En fin de partie, l'IA force la décision au lieu de camper.
    const lateGame = this.g.time > 480 ? 0.5 : 1;
    this.attackThreshold = Math.min(this.attackThreshold, this.p.attackBase * 2.5);
    const threshold = this.attackThreshold * (1 + this.g.time / 1500) * lateGame;
    // Sans cible connue, partir en reconnaissance en force dès la moitié du seuil.
    if (this.known.size === 0 && value >= threshold * 0.5 && idle.length >= 4) {
      const { w, h } = this.g.map;
      const base = this.baseCenter();
      let bx = -1, by = -1, bd = -1;
      for (let tries = 0; tries < 25; tries++) {
        const tx = 4 + Math.floor(this.g.rng() * (w - 8));
        const ty = 4 + Math.floor(this.g.rng() * (h - 8));
        if (me.fog[ty * w + tx] !== 0 || !this.g.nav.pass[ty * w + tx]) continue;
        const d = Math.hypot(tx - base.x, ty - base.y);
        if (d > bd) { bd = d; bx = tx; by = ty; }
      }
      if (bx >= 0) this.g.cmdMove(idle.slice(0, 6).map(u => u.id), bx, by, true);
      return;
    }

    const pressureTarget = this.pickPressureTarget();
    if (pressureTarget && value >= threshold * (this.p.expandSkill >= 1 ? 0.42 : 0.58) && idle.length >= 3) {
      const squad = this.pickAttackForce(idle, threshold * 0.5, true);
      if (squad.length > 0) {
        this.g.cmdMove(squad.map(u => u.id), pressureTarget.x, pressureTarget.y, true);
        this.attackThreshold = Math.max(this.p.attackBase * 0.85, this.attackThreshold * 0.94);
        return;
      }
    }

    if (value >= threshold) {
      const target = this.pickAttackTarget();
      if (target) {
        this.waveIds = this.pickAttackForce(idle, threshold, false).map(u => u.id);
        this.waveTarget = target;
        this.waveStartT = this.g.time;
        this.g.cmdMove(this.waveIds, target.x, target.y, true);
        // L'aviation accompagne les grosses vagues.
        for (const b of this.myUnits('bomber')) {
          if (b.airState === 'pad' && (b.ammo ?? 0) > 0 && (b.rearmT ?? 0) <= 0) {
            const arty = [...this.known.values()].find(kb => kb.type === 'turret' || kb.type === 'atgun');
            this.g.cmdMove([b.id], (arty ?? target).x, (arty ?? target).y, true);
          }
        }
      } else if (idle.length >= 4) {
        // Aucune cible connue : reconnaissance en force.
        const { w, h } = this.g.map;
        for (let tries = 0; tries < 20; tries++) {
          const tx = 4 + Math.floor(this.g.rng() * (w - 8));
          const ty = 4 + Math.floor(this.g.rng() * (h - 8));
          if (me.fog[ty * w + tx] === 0 && this.g.nav.pass[ty * w + tx]) {
            this.g.cmdMove(idle.slice(0, 5).map(u => u.id), tx, ty, true);
            break;
          }
        }
      }
    }
  }

  // Cible de vague : économie exposée d'abord, puis production, puis QG.
  // Riposte : forte préférence pour le joueur qui nous a attaqués récemment.
  private pickPressureTarget(): { x: number; y: number } | null {
    const harvesters = this.visibleEnemyHarvesters();
    if (harvesters.length > 0) {
      const base = this.baseCenter();
      harvesters.sort((a, b) => Math.hypot(a.x - base.x, a.y - base.y) - Math.hypot(b.x - base.x, b.y - base.y));
      return { x: harvesters[0].x, y: harvesters[0].y };
    }
    const eco = this.nearestKnownEnemyEco();
    if (eco) return { x: eco.x, y: eco.y };
    return null;
  }

  private pickAttackForce(idle: Unit[], threshold: number, raid: boolean): Unit[] {
    const base = this.baseCenter();
    const sorted = [...idle].sort((a, b) => {
      const av =
        a.type === 'heavytank' || a.type === 'heavyarty' || a.type === 'tankdestroyer' ? 4 :
        a.type === 'tank' || a.type === 'artillery' ? 3 :
        a.type === 'jeep' || a.type === 'elite' || a.type === 'rocketeer' ? 2 : 1;
      const bv =
        b.type === 'heavytank' || b.type === 'heavyarty' || b.type === 'tankdestroyer' ? 4 :
        b.type === 'tank' || b.type === 'artillery' ? 3 :
        b.type === 'jeep' || b.type === 'elite' || b.type === 'rocketeer' ? 2 : 1;
      return bv - av;
    });
    const reserveValue = raid ? 500 : (this.p.expandSkill >= 1 ? 650 : 900);
    const maxUnits = raid ? (this.p.expandSkill >= 1 ? 6 : 4) : sorted.length;
    const out: Unit[] = [];
    let picked = 0;
    let leftValue = this.armyValue(sorted);
    for (const u of sorted) {
      if (out.length >= maxUnits) break;
      const cost = UNITS[u.type].cost;
      const closeToBase = Math.hypot(u.x - base.x, u.y - base.y) < 22;
      if (!raid && closeToBase && leftValue - cost < reserveValue) continue;
      out.push(u);
      picked += cost;
      leftValue -= cost;
      if (raid && out.length >= 3 && picked >= threshold * 0.35) break;
    }
    return out.length > 0 ? out : sorted.slice(0, Math.min(maxUnits, sorted.length));
  }

  private pickAttackTarget(): { x: number; y: number } | null {
    const base = this.baseCenter();
    const prio: Record<string, number> = {
      refinery: 6.2, refinery2: 7.0, power: 4.6, power2: 4.8, factory: 4.4, factory2: 5.1,
      barracks: 3.2, barracks2: 3.9, airport: 4.2, lab: 5.4, depot: 4.8,
      turret: 1.2, atgun: 1.3, aa: 1.8, radar: 3.0, radarcenter: 3.2, tech: 3.8, hq: 3.6,
    };
    const revengeActive = this.p.counterAttack && this.g.time - this.revengeT < 120;
    let best: KnownBuilding | null = null, bestScore = -Infinity;
    for (const kb of this.known.values()) {
      const d = Math.hypot(kb.x - base.x, kb.y - base.y);
      let score = (prio[kb.type] ?? 1) * 100 - d;
      if (revengeActive && kb.owner === this.revengeOwner) score += 260;
      if (score > bestScore) { bestScore = score; best = kb; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  // -------------------------------------------------------------- réparation

  private manageRepairs() {
    const me = this.g.players[this.pid];
    const prio: Record<string, number> = {
      hq: 10, refinery: 8, power: 7, factory: 6, barracks: 5,
      airport: 5, radar: 4, tech: 4, turret: 3, atgun: 3, aa: 3,
    };
    const damaged = this.myBuildings()
      .filter(b => b.built && b.hp < b.maxHp * 0.75)
      .sort((a, b) => (prio[b.type] ?? 0) - (prio[a.type] ?? 0));
    for (const b of damaged) {
      if (me.ore > 350) this.g.setRepair(b.id, true);
    }
    // Envoyer l'ingénieur sur le bâtiment le plus important.
    const eng = this.myUnits('engineer').find(u => u.order.kind === 'idle');
    if (eng && damaged.length > 0) {
      this.g.cmdRepairTarget([eng.id], damaged[0].id, true);
    }
  }
}
