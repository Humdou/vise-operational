// Contrôles : caméra, sélection, ordres. Souris/clavier PC et tactile mobile.
import { Game } from './engine';
import { applyCommand, CommandSink } from './commands';
import { UNITS, BUILDINGS, BuildingTypeId, UnitTypeId } from './data';
import { Camera, ViewState } from './render';
import { Sfx } from './audio';

interface PointerInfo { id: number; x: number; y: number; sx: number; sy: number; t: number }
type OrderMarker = ViewState['orderMarkers'][number];

export class Controls {
  cam: Camera = { x: 0, y: 0, zoom: 26 };
  selectedUnits: number[] = [];
  selectedBuilding = 0;
  placing: BuildingTypeId | null = null;
  attackMoveMode = false;
  escortMode = false;        // prochain clic sur une unité alliée = escorter
  unloadMode = false;        // prochain clic/tap = largage des transports sélectionnés
  boxSelectMode = false;     // mobile : le glisser devient une sélection
  dpr = 1;

  private g: Game;
  private sfx: Sfx;
  private canvas: HTMLCanvasElement;
  private minimap: HTMLCanvasElement;
  private onChange: () => void;
  private pointers = new Map<number, PointerInfo>();
  private boxStart: { x: number; y: number } | null = null;
  private boxNow: { x: number; y: number } | null = null;
  private panLast: { x: number; y: number } | null = null;
  private rightDrag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  private pinchDist = 0;
  private mouse = { x: 0, y: 0, inside: false };
  private keys = new Set<string>();
  private groups = new Map<number, number[]>();
  private lastClickT = 0;
  private lastClickUnit = 0;
  private lastEmptyTapT = 0;
  private lastEmptyTap = { x: 0, y: 0 };
  private mmDragging = false;
  private orderMarkers: OrderMarker[] = [];
  // feedback optimiste : builds demandés localement, en attente de confirmation
  // réseau (le round qui crée le vrai bâtiment). Purgés à l'apparition du
  // bâtiment ou après expiration (commande rejetée / perdue).
  private pendingBuilds: { type: BuildingTypeId; tx: number; ty: number; t: number }[] = [];
  private detachFns: (() => void)[] = [];
  /** index du joueur local (0 en solo, slot attribué en multijoueur) */
  readonly pov: number;
  /** émetteur de commandes : solo = application directe, multi = lockstep */
  readonly issue: CommandSink;

  constructor(
    game: Game, sfx: Sfx, canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, onChange: () => void,
    pov = 0, issue?: CommandSink,
  ) {
    this.g = game;
    this.sfx = sfx;
    this.canvas = canvas;
    this.minimap = minimap;
    this.onChange = onChange;
    this.pov = pov;
    this.issue = issue ?? (c => applyCommand(this.g, this.pov, c));
    const start = game.map.starts[this.pov];
    this.cam.x = start.x;
    this.cam.y = start.y;
    this.attach();
  }

  // ------------------------------------------------------------- conversions

  private toWorld(px: number, py: number): { x: number; y: number } {
    const W = this.canvas.width, H = this.canvas.height;
    return {
      x: (px * this.dpr - W / 2) / this.cam.zoom + this.cam.x,
      y: (py * this.dpr - H / 2) / this.cam.zoom + this.cam.y,
    };
  }

  private clampCam() {
    const { w, h } = this.g.map;
    this.cam.x = Math.max(2, Math.min(w - 2, this.cam.x));
    this.cam.y = Math.max(2, Math.min(h - 2, this.cam.y));
    this.cam.zoom = Math.max(9, Math.min(64, this.cam.zoom));
  }

  centerOn(x: number, y: number) {
    this.cam.x = x; this.cam.y = y;
    this.clampCam();
  }

  // --------------------------------------------------------------- listeners

  private attach() {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window, ev: string, fn: (e: never) => void, opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(ev, fn as EventListener, opts);
      this.detachFns.push(() => el.removeEventListener(ev, fn as EventListener));
    };

    on(c, 'pointerdown', (e: PointerEvent) => this.pointerDown(e));
    on(c, 'pointermove', (e: PointerEvent) => this.pointerMove(e));
    on(c, 'pointerup', (e: PointerEvent) => this.pointerUp(e));
    on(c, 'pointercancel', (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.panLast = null;
      this.rightDrag = null;
    });
    on(c, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(c, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(c, 'pointerleave', () => { this.mouse.inside = false; });
    on(window, 'keydown', (e: KeyboardEvent) => this.keyDown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));

    const mm = this.minimap;
    on(mm, 'pointerdown', (e: PointerEvent) => {
      this.mmDragging = true;
      this.mmMove(e);
      mm.setPointerCapture(e.pointerId);
    });
    on(mm, 'pointermove', (e: PointerEvent) => { if (this.mmDragging) this.mmMove(e); });
    on(mm, 'pointerup', () => { this.mmDragging = false; });
    on(mm, 'contextmenu', (e: MouseEvent) => e.preventDefault());
  }

  detach() {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
  }

  private mmMove(e: PointerEvent) {
    // Même transformation letterbox que le rendu de la mini-carte.
    const r = this.minimap.getBoundingClientRect();
    const S = this.minimap.width;
    const { w, h } = this.g.map;
    const k = S / Math.max(w, h);
    const ox = (S - w * k) / 2, oy = (S - h * k) / 2;
    const px = ((e.clientX - r.left) / r.width) * S;
    const py = ((e.clientY - r.top) / r.height) * S;
    this.centerOn((px - ox) / k, (py - oy) / k);
  }

  // ----------------------------------------------------------------- pointer

  private pointerDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.sfx.ensure();
    const info: PointerInfo = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
    this.pointers.set(e.pointerId, info);

    if (e.pointerType === 'mouse') {
      if (e.button === 0) {
        if (this.placing) { this.tryPlace(e.clientX, e.clientY); return; }
        if (this.unloadMode) {
          const w = this.toWorld(e.clientX, e.clientY);
          this.contextOrder(w.x, w.y);
          return;
        }
        if (this.attackMoveMode) {
          const w = this.toWorld(e.clientX, e.clientY);
          this.issueAttackMove(w.x, w.y);
          this.attackMoveMode = false;
          this.onChange();
          return;
        }
        if (this.escortMode) {
          const w = this.toWorld(e.clientX, e.clientY);
          this.issueEscort(w.x, w.y);
          this.escortMode = false;
          this.onChange();
          return;
        }
        this.boxStart = { x: e.clientX, y: e.clientY };
        this.boxNow = null;
      } else if (e.button === 2) {
        if (this.placing) { this.placing = null; this.onChange(); return; }
        // L'ordre est donné au relâchement ; un glissement déplace la caméra.
        this.rightDrag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
      } else if (e.button === 1) {
        this.panLast = { x: e.clientX, y: e.clientY };
      }
    } else {
      // tactile
      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        this.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.boxStart = null;
        this.panLast = null;
      } else if (this.boxSelectMode) {
        this.boxStart = { x: e.clientX, y: e.clientY };
        this.boxNow = null;
      } else if (this.isEmptyDoubleTapStart(e.clientX, e.clientY)) {
        this.boxSelectMode = true;
        this.selectedBuilding = 0;
        this.selectedUnits = [];
        this.boxStart = { x: e.clientX, y: e.clientY };
        this.boxNow = null;
        this.panLast = null;
        this.lastEmptyTapT = 0;
        this.onChange();
      }
    }
  }

  private pointerMove(e: PointerEvent) {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true;
    const info = this.pointers.get(e.pointerId);
    if (info) { info.x = e.clientX; info.y = e.clientY; }

    if (e.pointerType === 'mouse') {
      if (this.panLast) {
        this.cam.x -= (e.clientX - this.panLast.x) * this.dpr / this.cam.zoom;
        this.cam.y -= (e.clientY - this.panLast.y) * this.dpr / this.cam.zoom;
        this.panLast = { x: e.clientX, y: e.clientY };
        this.clampCam();
      }
      if (this.rightDrag) {
        if (!this.rightDrag.moved &&
            Math.hypot(e.clientX - this.rightDrag.sx, e.clientY - this.rightDrag.sy) > 5) {
          this.rightDrag.moved = true;
        }
        if (this.rightDrag.moved) {
          this.cam.x -= (e.clientX - this.rightDrag.x) * this.dpr / this.cam.zoom;
          this.cam.y -= (e.clientY - this.rightDrag.y) * this.dpr / this.cam.zoom;
          this.clampCam();
        }
        this.rightDrag.x = e.clientX;
        this.rightDrag.y = e.clientY;
      }
      if (this.boxStart && (Math.abs(e.clientX - this.boxStart.x) > 4 || Math.abs(e.clientY - this.boxStart.y) > 4)) {
        this.boxNow = { x: e.clientX, y: e.clientY };
      }
      return;
    }

    // tactile
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinchDist > 0) {
        this.cam.zoom *= d / this.pinchDist;
        this.clampCam();
      }
      this.pinchDist = d;
      return;
    }
    if (!info) return;
    const moved = Math.hypot(info.x - info.sx, info.y - info.sy);
    if (this.boxSelectMode && this.boxStart) {
      if (moved > 6) this.boxNow = { x: e.clientX, y: e.clientY };
      return;
    }
    if (moved > 8) {
      if (!this.panLast) this.panLast = { x: info.sx, y: info.sy };
      this.cam.x -= (e.clientX - this.panLast.x) * this.dpr / this.cam.zoom;
      this.cam.y -= (e.clientY - this.panLast.y) * this.dpr / this.cam.zoom;
      this.panLast = { x: e.clientX, y: e.clientY };
      this.clampCam();
    }
  }

  private pointerUp(e: PointerEvent) {
    const info = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;

    if (e.pointerType === 'mouse') {
      if (e.button === 1) { this.panLast = null; return; }
      if (e.button === 2) {
        if (this.rightDrag && !this.rightDrag.moved) {
          const w = this.toWorld(e.clientX, e.clientY);
          this.contextOrder(w.x, w.y);
        }
        this.rightDrag = null;
        return;
      }
      if (e.button !== 0) return;
      if (this.boxNow && this.boxStart) {
        this.selectBox(this.boxStart, this.boxNow, e.shiftKey);
      } else if (this.boxStart) {
        this.clickSelect(e.clientX, e.clientY, e.shiftKey);
      }
      this.boxStart = null;
      this.boxNow = null;
      return;
    }

    // tactile
    if (!info) return;
    const moved = Math.hypot(info.x - info.sx, info.y - info.sy);
    const dur = performance.now() - info.t;
    if (this.boxSelectMode && this.boxStart) {
      if (this.boxNow) {
        this.selectBox(this.boxStart, this.boxNow, false);
        this.boxSelectMode = false;
        this.boxStart = null;
        this.boxNow = null;
        this.onChange();
        return;
      }
      this.boxStart = null;
      this.boxNow = null;
      this.panLast = null;
      this.onChange();
      return;
    }
    this.boxStart = null;
    this.boxNow = null;
    this.panLast = null;
    if (moved < 10 && dur < 600) this.tap(info.sx, info.sy);
  }

  private isEmptyDoubleTapStart(px: number, py: number) {
    const now = performance.now();
    if (now - this.lastEmptyTapT >= 360) return false;
    if (Math.hypot(px - this.lastEmptyTap.x, py - this.lastEmptyTap.y) >= 42) return false;
    const w = this.toWorld(px, py);
    return !this.pickUnit(w.x, w.y) && !this.pickBuilding(w.x, w.y);
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const before = this.toWorld(e.clientX, e.clientY);
    this.cam.zoom *= e.deltaY < 0 ? 1.13 : 1 / 1.13;
    this.clampCam();
    const after = this.toWorld(e.clientX, e.clientY);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCam();
  }

  // -------------------------------------------------------------------- tap

  private tap(px: number, py: number) {
    if (this.placing) { this.tryPlace(px, py); return; }
    const w = this.toWorld(px, py);
    if (this.unloadMode) {
      this.contextOrder(w.x, w.y);
      return;
    }
    if (this.attackMoveMode) {
      this.issueAttackMove(w.x, w.y);
      this.attackMoveMode = false;
      this.onChange();
      return;
    }
    if (this.escortMode) {
      this.issueEscort(w.x, w.y);
      this.escortMode = false;
      this.onChange();
      return;
    }
    const unit = this.pickUnit(w.x, w.y);
    const building = this.pickBuilding(w.x, w.y);
    const empty = !unit && !building;

    if (empty) {
      const now = performance.now();
      const closeTap = Math.hypot(px - this.lastEmptyTap.x, py - this.lastEmptyTap.y) < 42;
      if (now - this.lastEmptyTapT < 360 && closeTap) {
        this.boxSelectMode = true;
        this.selectedBuilding = 0;
        this.selectedUnits = [];
        this.lastEmptyTapT = 0;
        this.onChange();
        return;
      }
      this.lastEmptyTapT = now;
      this.lastEmptyTap = { x: px, y: py };
    }

    if (unit && unit.owner === this.pov) { this.selectUnits([unit.id]); return; }
    if (building && building.owner === this.pov && this.selectedUnits.length === 0) {
      this.selectedBuilding = building.id;
      this.selectedUnits = [];
      this.sfx.click();
      this.onChange();
      return;
    }
    if (this.selectedUnits.length > 0) { this.contextOrder(w.x, w.y); return; }
    if (building && building.owner === this.pov) {
      this.selectedBuilding = building.id;
      this.sfx.click();
      this.onChange();
      return;
    }
    // tap dans le vide : désélection
    this.selectedBuilding = 0;
    this.onChange();
  }

  // ------------------------------------------------------------------ select

  private pickUnit(wx: number, wy: number, ownOnly = false) {
    let best = null, bestD = 0.75;
    for (const u of this.g.units) {
      if (u.dead) continue;
      if (u.transportedBy) continue;
      if (ownOnly && u.owner !== this.pov) continue;
      if (u.owner !== this.pov && !this.g.isVisibleTo(this.pov, u.x, u.y)) continue;
      const d = Math.hypot(u.x - wx, u.y - wy);
      if (d < bestD + UNITS[u.type].radius) { bestD = d; best = u; }
    }
    return best;
  }

  private pickBuilding(wx: number, wy: number) {
    const tx = Math.round(wx), ty = Math.round(wy);
    if (tx < 0 || ty < 0 || tx >= this.g.map.w || ty >= this.g.map.h) return null;
    const id = this.g.buildGrid[ty * this.g.map.w + tx];
    if (!id) return null;
    const b = this.g.buildingById.get(id);
    if (!b || b.dead) return null;
    if (b.owner !== this.pov && !this.g.buildingVisibleTo(this.pov, b)) return null;
    return b;
  }

  private pickNode(wx: number, wy: number) {
    for (const n of this.g.nodes) {
      if (n.amount < 15) continue;
      if (Math.hypot(n.tx - wx, n.ty - wy) < 0.8 && this.g.isExploredBy(this.pov, n.tx, n.ty)) return n;
    }
    return null;
  }

  private selectUnits(ids: number[]) {
    this.selectedUnits = ids;
    this.selectedBuilding = 0;
    if (ids.length > 0) this.sfx.click();
    this.onChange();
  }

  private clickSelect(px: number, py: number, additive: boolean) {
    const w = this.toWorld(px, py);
    const unit = this.pickUnit(w.x, w.y, true);
    const now = performance.now();

    if (unit) {
      // double-clic : toutes les unités du même type à l'écran
      if (now - this.lastClickT < 350 && unit.id === this.lastClickUnit) {
        const ids: number[] = [];
        const vw = this.canvas.width / this.cam.zoom / 2, vh = this.canvas.height / this.cam.zoom / 2;
    for (const u of this.g.units) {
      if (u.dead || u.owner !== this.pov || u.type !== unit.type) continue;
      if (u.transportedBy) continue;
          if (Math.abs(u.x - this.cam.x) < vw && Math.abs(u.y - this.cam.y) < vh) ids.push(u.id);
        }
        this.selectUnits(ids);
        return;
      }
      this.lastClickT = now;
      this.lastClickUnit = unit.id;
      if (additive) {
        if (this.selectedUnits.includes(unit.id)) this.selectUnits(this.selectedUnits.filter(i => i !== unit.id));
        else this.selectUnits([...this.selectedUnits, unit.id]);
      } else {
        this.selectUnits([unit.id]);
      }
      return;
    }

    const building = this.pickBuilding(w.x, w.y);
    if (building && building.owner === this.pov) {
      this.selectedBuilding = building.id;
      this.selectedUnits = [];
      this.sfx.click();
      this.onChange();
      return;
    }
    if (!additive) {
      this.selectedUnits = [];
      this.selectedBuilding = 0;
      this.onChange();
    }
  }

  private selectBox(a: { x: number; y: number }, b: { x: number; y: number }, additive: boolean) {
    const w0 = this.toWorld(Math.min(a.x, b.x), Math.min(a.y, b.y));
    const w1 = this.toWorld(Math.max(a.x, b.x), Math.max(a.y, b.y));
    const ids: number[] = additive ? [...this.selectedUnits] : [];
    for (const u of this.g.units) {
      if (u.transportedBy) continue;
      if (u.dead || u.owner !== this.pov) continue;
      if (u.x >= w0.x && u.x <= w1.x && u.y >= w0.y && u.y <= w1.y && !ids.includes(u.id)) ids.push(u.id);
    }
    // priorité aux unités de combat dans une sélection mixte
    const combat = ids.filter(id => {
      const u = this.g.unitById.get(id);
      return u && UNITS[u.type].weapon;
    });
    this.selectUnits(combat.length > 0 && combat.length < ids.length ? combat : ids);
  }

  // ------------------------------------------------------------------ ordres

  private aliveSelection(): number[] {
    this.selectedUnits = this.selectedUnits.filter(id => {
      const u = this.g.unitById.get(id);
      return u && !u.dead;
    });
    return this.selectedUnits;
  }

  private contextOrder(wx: number, wy: number) {
    const sel = this.aliveSelection();
    if (sel.length === 0) {
      // clic droit avec bâtiment sélectionné : point de ralliement
      if (this.selectedBuilding) {
        const b = this.g.buildingById.get(this.selectedBuilding);
        if (b && (b.type === 'barracks' || b.type === 'factory' || b.type === 'airport')) {
          this.issue({ k: 'rally', bId: b.id, x: wx, y: wy });
          this.addOrderMarker('rally', wx, wy);
          this.sfx.order();
        }
      }
      return;
    }

    if (this.unloadMode) {
      const carriers = sel.filter(id => this.canUnloadCarrier(this.g.unitById.get(id)?.type));
      if (carriers.length > 0) {
        this.issue({ k: 'unload', ids: carriers, x: wx, y: wy });
        this.addOrderMarker('move', wx, wy);
        this.sfx.order();
      } else {
        this.sfx.error();
      }
      this.unloadMode = false;
      this.onChange();
      return;
    }

    const enemyUnit = (() => {
      const u = this.pickUnit(wx, wy);
      return u && u.owner !== this.pov ? u : null;
    })();
    const building = this.pickBuilding(wx, wy);
    const node = this.pickNode(wx, wy);

    if (enemyUnit) {
      this.issue({ k: 'attack', ids: sel, t: enemyUnit.id, b: false });
      this.addOrderMarker('attack', enemyUnit.x, enemyUnit.y);
      this.sfx.order();
      return;
    }
    if (building && building.owner !== this.pov) {
      const spies = sel.filter(id => this.g.unitById.get(id)?.type === 'spy');
      const attackers = sel.filter(id => this.g.unitById.get(id)?.type !== 'spy');
      if (spies.length > 0 && building.type === 'hq') {
        this.issue({ k: 'attack', ids: spies, t: building.id, b: true });
        this.addOrderMarker('attack', wx, wy);
        this.sfx.order();
      }
      if (attackers.length > 0) {
        this.issue({ k: 'attack', ids: attackers, t: building.id, b: true });
        this.addOrderMarker('attack', wx, wy);
        this.sfx.order();
      } else if (spies.length > 0 && building.type !== 'hq') {
        this.issue({ k: 'move', ids: spies, x: wx, y: wy, am: false });
        this.addOrderMarker('move', wx, wy);
        this.sfx.order();
      }
      return;
    }
    if (node) {
      const harvesters = sel.filter(id => this.g.unitById.get(id)?.type === 'harvester');
      const rest = sel.filter(id => !harvesters.includes(id));
      if (harvesters.length > 0) this.issue({ k: 'harvest', ids: harvesters, n: node.id });
      if (rest.length > 0) this.issue({ k: 'move', ids: rest, x: wx, y: wy, am: false });
      this.addOrderMarker('harvest', node.tx, node.ty);
      this.sfx.order();
      return;
    }
    if (building && building.owner === this.pov) {
      const engineers = sel.filter(id => this.g.unitById.get(id)?.type === 'engineer');
      if (engineers.length > 0 && building.hp < building.maxHp) {
        this.issue({ k: 'repairT', ids: engineers, t: building.id, b: true });
        const rest = sel.filter(id => !engineers.includes(id));
        if (rest.length > 0) this.issue({ k: 'move', ids: rest, x: wx, y: wy, am: false });
        this.addOrderMarker('move', wx, wy);
        this.sfx.order();
        return;
      }
    }
    // clic droit sur une unité alliée : ingénieurs réparent, le reste escorte
    const ownUnit = this.pickUnit(wx, wy, true);
    if (ownUnit && !sel.includes(ownUnit.id)) {
      const selectedTransports = sel.filter(id => {
        const u = this.g.unitById.get(id);
        return u && this.canUnloadCarrier(u.type) && this.canTransportUnit(u.type, ownUnit.type);
      });
      if (selectedTransports.length > 0) {
        this.issue({ k: 'pickup', ids: selectedTransports, target: ownUnit.id });
        this.addOrderMarker('move', ownUnit.x, ownUnit.y);
        this.sfx.order();
        return;
      }
      if (this.canUnloadCarrier(ownUnit.type)) {
        const cargo = sel.filter(id => {
          const u = this.g.unitById.get(id);
          return u && !UNITS[u.type].isAir && this.canTransportUnit(ownUnit.type, u.type);
        });
        if (cargo.length > 0) {
          this.issue({ k: 'load', ids: cargo, carrier: ownUnit.id });
          this.addOrderMarker('move', ownUnit.x, ownUnit.y);
          this.sfx.order();
          return;
        }
      }
      const engineers = sel.filter(id => this.g.unitById.get(id)?.type === 'engineer');
      const others = sel.filter(id => !engineers.includes(id));
      let acted = false;
      if (engineers.length > 0 && ownUnit.hp < ownUnit.maxHp && UNITS[ownUnit.type].armor !== 'inf') {
        this.issue({ k: 'repairT', ids: engineers, t: ownUnit.id, b: false });
        acted = true;
      }
      if (others.length > 0 && !UNITS[ownUnit.type].isAir) {
        this.issue({ k: 'escort', ids: others, t: ownUnit.id });
        acted = true;
      }
      if (acted) { this.sfx.order(); return; }
    }
    this.issue({ k: 'move', ids: sel, x: wx, y: wy, am: false });
    this.addOrderMarker('move', wx, wy);
    this.sfx.order();
  }

  private issueEscort(wx: number, wy: number) {
    const sel = this.aliveSelection();
    if (sel.length === 0) return;
    const target = this.pickUnit(wx, wy, true);
    if (target && !sel.includes(target.id) && !UNITS[target.type].isAir) {
      this.issue({ k: 'escort', ids: sel, t: target.id });
      this.addOrderMarker('move', target.x, target.y);
      this.sfx.order();
    } else {
      this.sfx.error();
    }
  }

  private issueAttackMove(wx: number, wy: number) {
    const sel = this.aliveSelection();
    if (sel.length === 0) return;
    this.issue({ k: 'move', ids: sel, x: wx, y: wy, am: true });
    this.addOrderMarker('attack', wx, wy);
    this.sfx.order();
  }

  private addOrderMarker(kind: OrderMarker['kind'], x: number, y: number) {
    this.orderMarkers.push({ kind, x, y, t: this.g.time });
    if (this.orderMarkers.length > 24) this.orderMarkers.splice(0, this.orderMarkers.length - 24);
  }

  private cursorKind(): ViewState['cursor']['kind'] {
    if (this.placing) return this.getViewStatePlacementValid() ? 'place-ok' : 'place-bad';
    if (!this.mouse.inside) return 'default';
    const w = this.toWorld(this.mouse.x, this.mouse.y);
    const unit = this.pickUnit(w.x, w.y);
    const building = this.pickBuilding(w.x, w.y);
    if ((unit && unit.owner !== this.pov) || (building && building.owner !== this.pov)) return 'enemy';
    const node = this.pickNode(w.x, w.y);
    if (node) return 'ore';
    if ((unit && unit.owner === this.pov) || (building && building.owner === this.pov)) return 'ally';
    if (this.attackMoveMode) return 'attack';
    if (this.selectedUnits.length > 0 || this.selectedBuilding) return 'move';
    return 'default';
  }

  private getViewStatePlacementValid() {
    if (!this.placing) return false;
    const w = this.toWorld(this.mouse.x, this.mouse.y);
    const def = BUILDINGS[this.placing];
    const tx = Math.round(w.x - def.w / 2), ty = Math.round(w.y - def.h / 2);
    return this.g.canPlace(this.pov, this.placing, tx, ty) && this.g.canBuild(this.pov, this.placing).ok;
  }

  stopSelection() {
    this.issue({ k: 'stop', ids: this.aliveSelection() });
    this.sfx.order();
  }

  deploySelection() {
    const ids = this.aliveSelection().filter(id => this.g.unitById.get(id)?.type === 'mobilecmd');
    if (ids.length === 0) { this.sfx.error(); return; }
    this.issue({ k: 'deploy', ids });
    this.sfx.order();
  }

  startUnloadMode() {
    const ids = this.aliveSelection().filter(id => this.canUnloadCarrier(this.g.unitById.get(id)?.type));
    if (ids.length === 0) { this.sfx.error(); return; }
    this.unloadMode = true;
    this.attackMoveMode = false;
    this.escortMode = false;
    this.onChange();
  }

  private canUnloadCarrier(type?: UnitTypeId) {
    return !!type && (UNITS[type].transportCapacity ?? 0) > 0;
  }

  private canTransportUnit(carrierType: UnitTypeId, unitType: UnitTypeId) {
    const carrier = UNITS[carrierType];
    const unit = UNITS[unitType];
    return !!carrier.transportArmor && carrier.transportArmor.includes(unit.armor) && !unit.isAir;
  }

  // -------------------------------------------------------------- placement

  startPlacement(type: BuildingTypeId) {
    this.placing = type;
    this.selectedUnits = [];
    this.onChange();
  }

  private tryPlace(px: number, py: number) {
    if (!this.placing) return;
    const w = this.toWorld(px, py);
    const def = BUILDINGS[this.placing];
    const tx = Math.round(w.x - def.w / 2), ty = Math.round(w.y - def.h / 2);
    if (this.g.canPlace(this.pov, this.placing, tx, ty) && this.g.canBuild(this.pov, this.placing).ok) {
      this.issue({ k: 'place', t: this.placing, tx, ty });
      // feedback optimiste : fantôme immédiat en attendant le round réseau
      this.pendingBuilds.push({ type: this.placing, tx, ty, t: this.g.time });
      this.sfx.order();
      this.placing = null;
      this.onChange();
    } else {
      this.sfx.error();
    }
  }

  // --------------------------------------------------------------- clavier

  private keyDown(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (k === 'escape') {
      this.placing = null;
      this.attackMoveMode = false;
      this.escortMode = false;
      this.unloadMode = false;
      this.selectedUnits = [];
      this.selectedBuilding = 0;
      this.onChange();
    } else if (k === 'a' && this.selectedUnits.length > 0) {
      this.attackMoveMode = true;
      this.escortMode = false;
      this.unloadMode = false;
      this.onChange();
    } else if (k === 'e' && this.selectedUnits.length > 0) {
      this.escortMode = true;
      this.attackMoveMode = false;
      this.unloadMode = false;
      this.onChange();
    } else if (k === 's') {
      this.stopSelection();
    } else if (k >= '1' && k <= '9') {
      const n = parseInt(k, 10);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.groups.set(n, [...this.selectedUnits]);
      } else {
        const ids = (this.groups.get(n) ?? []).filter(id => this.g.unitById.get(id));
        if (ids.length > 0) {
          this.selectUnits(ids);
          const u = this.g.unitById.get(ids[0])!;
          if (e.shiftKey) this.centerOn(u.x, u.y);
        }
      }
    } else if (k === ' ') {
      e.preventDefault();
      const p = this.g.players[this.pov];
      if (this.g.time - p.alertT < 30) this.centerOn(p.alertX, p.alertY);
    }
  }

  // appelé chaque frame : défilement aux bords + clavier
  update(dt: number) {
    const pan = 22 * dt * (40 / this.cam.zoom);
    if (this.keys.has('arrowleft')) this.cam.x -= pan;
    if (this.keys.has('arrowright')) this.cam.x += pan;
    if (this.keys.has('arrowup')) this.cam.y -= pan;
    if (this.keys.has('arrowdown')) this.cam.y += pan;
    if (this.mouse.inside && this.pointers.size === 0) {
      const M = 14;
      const r = this.canvas.getBoundingClientRect();
      if (this.mouse.x - r.left < M) this.cam.x -= pan;
      if (r.right - this.mouse.x < M) this.cam.x += pan;
      if (this.mouse.y - r.top < M) this.cam.y -= pan;
      if (r.bottom - this.mouse.y < M) this.cam.y += pan;
    }
    this.clampCam();
  }

  getViewState(): ViewState {
    let placeTx = 0, placeTy = 0, placeValid = false;
    if (this.placing) {
      const w = this.toWorld(this.mouse.x, this.mouse.y);
      const def = BUILDINGS[this.placing];
      placeTx = Math.round(w.x - def.w / 2);
      placeTy = Math.round(w.y - def.h / 2);
      placeValid = this.g.canPlace(this.pov, this.placing, placeTx, placeTy) && this.g.canBuild(this.pov, this.placing).ok;
    }
    let box: ViewState['box'] = null;
    if (this.boxStart && this.boxNow) {
      box = {
        x0: this.boxStart.x * this.dpr, y0: this.boxStart.y * this.dpr,
        x1: this.boxNow.x * this.dpr, y1: this.boxNow.y * this.dpr,
      };
    }
    this.orderMarkers = this.orderMarkers.filter(m => this.g.time - m.t < 0.85);
    // purge les fantômes : confirmés (un bâtiment du joueur occupe la case) ou
    // expirés (commande perdue/rejetée — 6 s de garde).
    if (this.pendingBuilds.length) {
      this.pendingBuilds = this.pendingBuilds.filter(pb => {
        if (this.g.time - pb.t > 6) return false;
        const occupied = this.g.buildGrid[pb.ty * this.g.map.w + pb.tx];
        if (occupied) {
          const b = this.g.buildingById.get(occupied);
          if (b && b.owner === this.pov && b.type === pb.type) return false;
        }
        return true;
      });
    }
    return {
      cam: this.cam,
      selectedUnits: this.selectedUnits,
      selectedBuilding: this.selectedBuilding,
      placing: this.placing,
      placeTx, placeTy, placeValid,
      box,
      attackMoveMode: this.attackMoveMode,
      cursor: {
        x: this.mouse.x * this.dpr,
        y: this.mouse.y * this.dpr,
        inside: this.mouse.inside,
        kind: this.cursorKind(),
      },
      orderMarkers: [...this.orderMarkers],
      pendingBuilds: this.pendingBuilds.map(pb => ({ type: pb.type, tx: pb.tx, ty: pb.ty })),
    };
  }
}
