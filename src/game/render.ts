// Rendu Canvas 2D : terrain pré-rendu adouci, entités différenciées,
// brouillard à dégradé doux, mini-carte.
import { Game, Unit, Building } from './engine';
import { UNITS, BUILDINGS, THEMES, PLAYER_COLORS } from './data';
import { T_GRASS, T_ROUGH, T_WATER, T_ROCK, mulberry32 } from './map';

export interface Camera {
  x: number;   // centre, en tuiles
  y: number;
  zoom: number; // pixels par tuile
}

export interface ViewState {
  cam: Camera;
  selectedUnits: number[];
  selectedBuilding: number;
  placing: string | null;
  placeTx: number;
  placeTy: number;
  placeValid: boolean;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  attackMoveMode: boolean;
}

const TPX = 12; // pixels par tuile du terrain pré-rendu

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private mmCtx: CanvasRenderingContext2D;
  private mmTerrain: HTMLCanvasElement | null = null;
  private terrain: HTMLCanvasElement | null = null;
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogCtx: CanvasRenderingContext2D | null = null;
  private fogImg: ImageData | null = null;

  constructor(private canvas: HTMLCanvasElement, private minimap: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.mmCtx = minimap.getContext('2d')!;
  }

  // ------------------------------------------------ terrain pré-rendu (1 fois)

  private buildTerrain(g: Game) {
    const { w, h, terrain, shade } = g.map;
    const theme = THEMES[g.map.theme];
    const rng = mulberry32(w * 31 + h);
    const c = document.createElement('canvas');
    c.width = w * TPX; c.height = h * TPX;
    const tc = c.getContext('2d')!;

    const colorOf = (tx: number, ty: number): string => {
      const t = terrain[ty * w + tx];
      if (t === T_WATER) return theme.water;
      if (t === T_ROCK) return theme.rock[(tx * 7 + ty * 13) % theme.rock.length];
      if (t === T_ROUGH) return theme.rough[(tx * 3 + ty * 5) % theme.rough.length];
      return theme.grass[(tx * 11 + ty * 17) % theme.grass.length];
    };
    const isLand = (tx: number, ty: number) => {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
      const t = terrain[ty * w + tx];
      return t === T_GRASS || t === T_ROUGH;
    };

    // Passe 1 : couleurs de base.
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        tc.fillStyle = colorOf(tx, ty);
        tc.fillRect(tx * TPX, ty * TPX, TPX, TPX);
      }

    // Passe 2 : disques semi-transparents qui fondent les frontières de tuiles.
    tc.globalAlpha = 0.5;
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        tc.fillStyle = colorOf(tx, ty);
        tc.beginPath();
        tc.arc((tx + 0.5) * TPX, (ty + 0.5) * TPX, TPX * 0.78, 0, Math.PI * 2);
        tc.fill();
      }
    tc.globalAlpha = 1;

    // Passe 3 : ombrage doux + détails par type de terrain.
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        const i = ty * w + tx;
        const t = terrain[i];
        const px = tx * TPX, py = ty * TPX;
        const cx = px + TPX / 2, cy = py + TPX / 2;
        const sh = shade[i];
        if (sh !== 0) {
          tc.fillStyle = sh > 0 ? `rgba(255,255,255,${sh * 0.8})` : `rgba(0,0,0,${-sh * 0.8})`;
          tc.beginPath(); tc.arc(cx, cy, TPX * 0.8, 0, Math.PI * 2); tc.fill();
        }
        // Variation de teinte à grande échelle : casse l'uniformité.
        const macro = Math.sin(tx * 0.11) + Math.sin(ty * 0.14) + Math.sin((tx + ty) * 0.06);
        if (Math.abs(macro) > 0.8 && t !== T_WATER) {
          tc.fillStyle = macro > 0 ? 'rgba(255,250,220,0.045)' : 'rgba(20,30,50,0.05)';
          tc.fillRect(px, py, TPX, TPX);
        }
        // Bande de rivage sur les tuiles de terre bordant l'eau.
        if (t !== T_WATER && t !== T_ROCK) {
          tc.fillStyle = theme.shore;
          tc.globalAlpha = 0.75;
          const isWater = (xx: number, yy: number) =>
            xx >= 0 && yy >= 0 && xx < w && yy < h && terrain[yy * w + xx] === T_WATER;
          if (isWater(tx - 1, ty)) tc.fillRect(px, py, 3, TPX);
          if (isWater(tx + 1, ty)) tc.fillRect(px + TPX - 3, py, 3, TPX);
          if (isWater(tx, ty - 1)) tc.fillRect(px, py, TPX, 3);
          if (isWater(tx, ty + 1)) tc.fillRect(px, py + TPX - 3, TPX, 3);
          tc.globalAlpha = 1;
        }

        if (t === T_WATER) {
          // profondeur + écume le long des côtes
          tc.fillStyle = 'rgba(8,14,26,0.25)';
          tc.beginPath(); tc.arc(cx, cy, TPX * 0.42, 0, Math.PI * 2); tc.fill();
          tc.fillStyle = 'rgba(210,230,240,0.5)';
          if (isLand(tx - 1, ty)) tc.fillRect(px, py + 2, 1.5, TPX - 4);
          if (isLand(tx + 1, ty)) tc.fillRect(px + TPX - 1.5, py + 2, 1.5, TPX - 4);
          if (isLand(tx, ty - 1)) tc.fillRect(px + 2, py, TPX - 4, 1.5);
          if (isLand(tx, ty + 1)) tc.fillRect(px + 2, py + TPX - 1.5, TPX - 4, 1.5);
        } else if (t === T_ROCK) {
          // relief : crête claire, pied sombre, fissures, éboulis
          tc.fillStyle = 'rgba(255,255,255,0.13)';
          tc.fillRect(px, py, TPX, 2.5);
          tc.fillStyle = 'rgba(255,255,255,0.06)';
          tc.fillRect(px, py + 2.5, TPX, 2);
          tc.fillStyle = 'rgba(0,0,0,0.22)';
          tc.fillRect(px, py + TPX - 2.5, TPX, 2.5);
          if (rng() < 0.5) {
            tc.strokeStyle = 'rgba(0,0,0,0.3)';
            tc.lineWidth = 1;
            tc.beginPath();
            tc.moveTo(px + rng() * TPX, py + 2);
            tc.lineTo(px + rng() * TPX, py + TPX - 2);
            tc.stroke();
          }
          // éboulis au pied des parois (côté terre)
          if (!isLand(tx, ty + 1)) { /* mer en dessous : rien */ } else if (terrain[(ty + 1) * w + tx] === T_GRASS && rng() < 0.6) {
            tc.fillStyle = 'rgba(90,90,88,0.7)';
            for (let k = 0; k < 3; k++) {
              tc.beginPath();
              tc.arc(px + 2 + rng() * (TPX - 4), py + TPX - 1 + rng() * 2, 1 + rng(), 0, Math.PI * 2);
              tc.fill();
            }
          }
        } else if (t === T_ROUGH) {
          // cailloux et broussailles
          tc.fillStyle = 'rgba(0,0,0,0.18)';
          for (let k = 0; k < 3; k++) {
            tc.beginPath();
            tc.arc(px + 2 + rng() * (TPX - 4), py + 2 + rng() * (TPX - 4), 1 + rng() * 1.2, 0, Math.PI * 2);
            tc.fill();
          }
          tc.fillStyle = 'rgba(255,255,255,0.1)';
          tc.beginPath();
          tc.arc(px + 2 + rng() * (TPX - 4), py + 2 + rng() * (TPX - 4), 1.2, 0, Math.PI * 2);
          tc.fill();
        } else {
          // herbe : touffes éparses, parfois un buisson ou une éclaircie
          const r = rng();
          const tropical = g.map.theme === 'tropical';
          const nearWater = isLand(tx, ty) &&
            (terrain[Math.max(0, ty - 1) * w + tx] === T_WATER || terrain[Math.min(h - 1, ty + 1) * w + tx] === T_WATER ||
             terrain[ty * w + Math.max(0, tx - 1)] === T_WATER || terrain[ty * w + Math.min(w - 1, tx + 1)] === T_WATER);
          if (tropical && (r < 0.06 || (nearWater && r < 0.3))) {
            // palmier : tronc incliné + palmes rayonnantes
            const bx = px + 3 + rng() * (TPX - 6), by = py + TPX - 2;
            const tilt = (rng() - 0.5) * 3;
            const topX = bx + tilt, topY = by - TPX * 0.62;
            tc.strokeStyle = '#5d4a30';
            tc.lineWidth = 1.4;
            tc.beginPath(); tc.moveTo(bx, by); tc.lineTo(topX, topY); tc.stroke();
            tc.strokeStyle = '#1f5a2d';
            tc.lineWidth = 1.2;
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2 + rng() * 0.5;
              tc.beginPath();
              tc.moveTo(topX, topY);
              tc.quadraticCurveTo(
                topX + Math.cos(a) * 4, topY + Math.sin(a) * 2 - 1,
                topX + Math.cos(a) * 6.5, topY + Math.sin(a) * 3.4 + 1.4,
              );
              tc.stroke();
            }
            tc.fillStyle = '#2a6e38';
            tc.beginPath(); tc.arc(topX, topY, 1.6, 0, Math.PI * 2); tc.fill();
          } else if (tropical && r < 0.1) {
            // zone humide : flaque sombre turquoise
            tc.fillStyle = 'rgba(22,80,90,0.4)';
            tc.beginPath(); tc.ellipse(cx, cy, TPX * 0.45, TPX * 0.3, rng() * 3, 0, Math.PI * 2); tc.fill();
          } else if (r < 0.2) {
            // touffes bicolores (ombre + brin clair)
            for (let k = 0; k < 3; k++) {
              const gx = px + 2 + rng() * (TPX - 4), gy = py + 2 + rng() * (TPX - 4);
              tc.strokeStyle = 'rgba(0,0,0,0.2)';
              tc.lineWidth = 1;
              tc.beginPath(); tc.moveTo(gx, gy + 2); tc.lineTo(gx + (rng() - 0.5) * 2, gy - 1.5); tc.stroke();
              tc.strokeStyle = 'rgba(255,255,240,0.14)';
              tc.beginPath(); tc.moveTo(gx + 1, gy + 2); tc.lineTo(gx + 1 + (rng() - 0.5) * 2, gy - 1); tc.stroke();
            }
          } else if (r < 0.215) {
            // plaque de terre nue
            tc.fillStyle = 'rgba(96,78,52,0.3)';
            tc.beginPath(); tc.ellipse(cx, cy, TPX * 0.5, TPX * 0.32, rng() * 3, 0, Math.PI * 2); tc.fill();
          } else if (r < (tropical ? 0.26 : 0.225)) {
            // buisson (végétation dense en tropical)
            tc.fillStyle = tropical ? 'rgba(10,45,20,0.5)' : 'rgba(0,0,0,0.28)';
            for (let k = 0; k < (tropical ? 4 : 3); k++) {
              tc.beginPath();
              tc.arc(cx + (rng() - 0.5) * 5, cy + (rng() - 0.5) * 5, 1.8 + rng() * 1.2, 0, Math.PI * 2);
              tc.fill();
            }
          } else if (r < 0.275 && !tropical) {
            tc.fillStyle = 'rgba(255,255,255,0.07)';
            tc.beginPath(); tc.arc(cx, cy, TPX * 0.55, 0, Math.PI * 2); tc.fill();
          }
        }
      }
    this.terrain = c;
  }

  // ------------------------------------------------------------------- frame

  draw(g: Game, v: ViewState, dtFrame: number) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const { cam } = v;
    const z = cam.zoom;
    const theme = THEMES[g.map.theme];
    const fog = g.players[0].fog;
    const mw = g.map.w;

    const sx = (wx: number) => (wx - cam.x) * z + W / 2;
    const sy = (wy: number) => (wy - cam.y) * z + H / 2;

    ctx.fillStyle = '#0a0d10';
    ctx.fillRect(0, 0, W, H);

    // ----- terrain : une seule image pré-rendue, mise à l'échelle en douceur
    if (!this.terrain) this.buildTerrain(g);
    const viewW = W / z, viewH = H / z;
    const left = cam.x - viewW / 2, top = cam.y - viewH / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    this.drawImageClamped(
      ctx, this.terrain!,
      (left + 0.5) * TPX, (top + 0.5) * TPX, viewW * TPX, viewH * TPX,
      W, H,
    );

    const tx0 = Math.max(0, Math.floor(left) - 1);
    const tx1 = Math.min(mw - 1, Math.ceil(left + viewW) + 1);
    const ty0 = Math.max(0, Math.floor(top) - 1);
    const ty1 = Math.min(g.map.h - 1, Math.ceil(top + viewH) + 1);

    // ----- gisements : cristaux dorés (or) ou rouge sombre/bleu (minerai rare)
    for (const n of g.nodes) {
      if (n.amount < 10) continue;
      const i = n.ty * mw + n.tx;
      if (n.tx < tx0 || n.tx > tx1 || n.ty < ty0 || n.ty > ty1 || fog[i] === 0) continue;
      const px = sx(n.tx), py = sy(n.ty);
      const fill = Math.max(0.3, n.amount / n.max);
      const baseR = z * 0.46 * fill;
      const rare = n.kind === 'rare';
      const bodyCol = rare ? '#8e1f33' : theme.ore;
      const glowCol = rare ? '#3a4f8f' : theme.oreGlow;
      // ombre au sol + halo pulsant pour le minerai rare
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(px, py + z * 0.08, baseR, baseR * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      if (rare) {
        const pulse = 0.18 + 0.1 * Math.sin(g.time * 2.5 + n.id);
        ctx.fillStyle = `rgba(220,60,90,${pulse})`;
        ctx.beginPath(); ctx.arc(px, py, baseR * 1.5, 0, Math.PI * 2); ctx.fill();
      }
      // cristaux (déterministes par gisement)
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + n.id * 1.7;
        const cxk = px + Math.cos(a) * baseR * 0.5;
        const cyk = py + Math.sin(a) * baseR * 0.35;
        const hgt = baseR * (0.55 + ((n.id + k) % 3) * 0.2) * (rare ? 1.2 : 1);
        const wid = hgt * 0.45;
        ctx.fillStyle = bodyCol;
        ctx.beginPath();
        ctx.moveTo(cxk, cyk - hgt);
        ctx.lineTo(cxk + wid, cyk + hgt * 0.25);
        ctx.lineTo(cxk - wid, cyk + hgt * 0.25);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.moveTo(cxk, cyk - hgt);
        ctx.lineTo(cxk + wid * 0.35, cyk - hgt * 0.2);
        ctx.lineTo(cxk - wid * 0.1, cyk - hgt * 0.15);
        ctx.closePath(); ctx.fill();
      }
      // glint : étincelle périodique sur les cristaux
      const glint = (g.time * 0.7 + n.id * 0.37) % 1;
      if (glint < 0.12) {
        ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - glint / 0.12)})`;
        ctx.beginPath();
        ctx.arc(px + Math.cos(n.id) * baseR * 0.4, py - baseR * 0.4, Math.max(1, z * 0.06), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ----- bâtiments (visibles ou mémorisés ; le brouillard assombrit le reste)
    for (const b of g.buildings) {
      if (b.tx + b.w < tx0 || b.tx > tx1 || b.ty + b.h < ty0 || b.ty > ty1) continue;
      const ci = (b.ty + Math.floor(b.h / 2)) * mw + b.tx + Math.floor(b.w / 2);
      if (fog[ci] === 0) continue;
      this.drawBuilding(ctx, g, b, sx, sy, z, v.selectedBuilding === b.id);
    }

    // ----- unités au sol (seulement si visibles)
    for (const u of g.units) {
      if (u.airState) continue;
      if (u.x < tx0 - 1 || u.x > tx1 + 1 || u.y < ty0 - 1 || u.y > ty1 + 1) continue;
      if (u.owner !== 0 && !g.isVisibleTo(0, u.x, u.y)) continue;
      this.drawUnit(ctx, g, u, sx, sy, z, v.selectedUnits.includes(u.id));
    }

    // ----- projectiles
    for (const p of g.projectiles) {
      const px = sx(p.x), py = sy(p.y);
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      if (!g.isVisibleTo(0, p.x, p.y)) continue;
      let arcY = 0;
      if (p.indirect) arcY = Math.sin(p.t * Math.PI) * p.dist * 0.22 * z;
      if (p.kind === 'bullet' || p.kind === 'mg' || p.kind === 'sniper') {
        ctx.strokeStyle = '#ffe9a0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        const bx = (p.tx - p.sx) / p.dist, by = (p.ty - p.sy) / p.dist;
        ctx.beginPath();
        ctx.moveTo(px - bx * z * 0.3, py - by * z * 0.3);
        ctx.lineTo(px, py);
        ctx.stroke();
      } else if (p.kind === 'flak') {
        ctx.fillStyle = '#ffd3a0';
        ctx.beginPath(); ctx.arc(px, py, Math.max(1.5, z * 0.08), 0, Math.PI * 2); ctx.fill();
      } else {
        // traînée de fumée derrière les obus / roquettes
        for (let k = 1; k <= 3; k++) {
          const tt = Math.max(0, p.t - k * 0.045);
          const txp = sx(p.sx + (p.tx - p.sx) * tt);
          const typ = sy(p.sy + (p.ty - p.sy) * tt);
          const tArc = p.indirect ? Math.sin(tt * Math.PI) * p.dist * 0.22 * z : 0;
          ctx.fillStyle = `rgba(190,190,185,${0.3 - k * 0.08})`;
          ctx.beginPath(); ctx.arc(txp, typ - tArc, Math.max(1, z * (0.09 - k * 0.02)), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = p.kind === 'ap' ? '#ffb060' : '#fff3c0';
        ctx.beginPath(); ctx.arc(px, py - arcY, Math.max(2, z * 0.11), 0, Math.PI * 2); ctx.fill();
        if (p.kind === 'arty' || p.kind === 'bomb') {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.beginPath(); ctx.arc(px, py, Math.max(1, z * 0.07), 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // ----- effets
    for (const e of g.effects) {
      if (!g.isVisibleTo(0, e.x, e.y)) continue;
      const px = sx(e.x), py = sy(e.y);
      const f = e.age / e.dur;
      if (e.kind === 'boom') {
        // onde de choc + boule de feu + débris incandescents + fumée
        ctx.strokeStyle = `rgba(255,230,180,${(1 - f) * 0.55})`;
        ctx.lineWidth = Math.max(1, z * 0.08 * (1 - f));
        ctx.beginPath(); ctx.arc(px, py, e.r * z * (0.5 + f * 2.2), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(255,${Math.floor(190 - f * 120)},40,${1 - f})`;
        ctx.beginPath(); ctx.arc(px, py, e.r * z * (0.4 + f * 1.1), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,250,220,${(1 - f) * 0.9})`;
        ctx.beginPath(); ctx.arc(px, py, e.r * z * 0.32 * (1 - f), 0, Math.PI * 2); ctx.fill();
        // débris projetés (déterministes, avec gravité)
        const seed = Math.floor(e.x * 13 + e.y * 7);
        for (let k = 0; k < 6; k++) {
          const a = ((seed + k) % 12) / 12 * Math.PI * 2;
          const sp = 1.4 + ((seed + k * 3) % 5) * 0.3;
          const dx = Math.cos(a) * f * sp * e.r * z;
          const dy = Math.sin(a) * f * sp * e.r * z * 0.7 - f * z * 0.6 + f * f * z * 2.2;
          ctx.fillStyle = `rgba(255,${160 - Math.floor(f * 110)},60,${1 - f})`;
          ctx.beginPath(); ctx.arc(px + dx, py + dy, Math.max(1, z * 0.06 * (1 - f * 0.5)), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = `rgba(60,50,45,${(1 - f) * 0.5})`;
        ctx.beginPath(); ctx.arc(px, py - f * z * 0.5, e.r * z * f * 1.3, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'smoke') {
        // colonne de fumée qui s'élève et se dissipe
        const rise = f * z * 1.8;
        for (let k = 0; k < 3; k++) {
          const kf = Math.max(0, f - k * 0.18);
          if (kf <= 0) continue;
          ctx.fillStyle = `rgba(${52 + k * 8},${48 + k * 8},${46 + k * 8},${(1 - f) * (0.4 - k * 0.09)})`;
          ctx.beginPath();
          ctx.arc(
            px + Math.sin((f + k) * 5 + e.x) * z * 0.18,
            py - rise + k * z * 0.45,
            e.r * z * (0.4 + kf * 1.5),
            0, Math.PI * 2,
          );
          ctx.fill();
        }
      } else if (e.kind === 'flash') {
        // éclair de bouche en étoile
        ctx.fillStyle = `rgba(255,240,180,${1 - f})`;
        ctx.beginPath(); ctx.arc(px, py, e.r * z * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(255,250,200,${(1 - f) * 0.8})`;
        ctx.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI + e.x;
          ctx.beginPath();
          ctx.moveTo(px - Math.cos(a) * e.r * z * 0.9, py - Math.sin(a) * e.r * z * 0.9);
          ctx.lineTo(px + Math.cos(a) * e.r * z * 0.9, py + Math.sin(a) * e.r * z * 0.9);
          ctx.stroke();
        }
      } else if (e.kind === 'spark') {
        ctx.fillStyle = `rgba(255,210,120,${1 - f})`;
        ctx.beginPath(); ctx.arc(px, py, Math.max(1, e.r * z * (1 - f)), 0, Math.PI * 2); ctx.fill();
      }
    }

    // ----- unités aériennes (au-dessus de tout)
    for (const u of g.units) {
      if (!u.airState) continue;
      if (u.owner !== 0 && !g.isVisibleTo(0, u.x, u.y)) continue;
      const flying = u.airState !== 'pad';
      const px = sx(u.x), py = sy(u.y);
      if (flying) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.ellipse(px + z * 0.4, py + z * 0.5, z * 0.4, z * 0.18, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.save();
      ctx.translate(px, py - (flying ? z * 0.5 : 0));
      ctx.rotate(u.dir + Math.PI / 2);
      ctx.fillStyle = PLAYER_COLORS[u.owner];
      if (u.type === 'scoutplane') {
        // avion radar : fuselage fin, ailes droites, radôme bleu clair
        ctx.fillRect(-z * 0.06, -z * 0.42, z * 0.12, z * 0.78);
        ctx.fillRect(-z * 0.42, -z * 0.08, z * 0.84, z * 0.14);
        ctx.fillRect(-z * 0.18, z * 0.28, z * 0.36, z * 0.08);
        ctx.fillStyle = '#9ad0ff';
        ctx.beginPath(); ctx.arc(0, -z * 0.05, z * 0.11, 0, Math.PI * 2); ctx.fill();
      } else {
        // chasseur-bombardier : ailes en flèche, nacelles moteur, verrière
        ctx.beginPath();
        ctx.moveTo(0, -z * 0.5);                  // nez
        ctx.lineTo(z * 0.12, -z * 0.1);
        ctx.lineTo(z * 0.44, z * 0.22);           // aile droite en flèche
        ctx.lineTo(z * 0.4, z * 0.32);
        ctx.lineTo(z * 0.08, z * 0.18);
        ctx.lineTo(z * 0.1, z * 0.42);            // empennage droit
        ctx.lineTo(0, z * 0.34);
        ctx.lineTo(-z * 0.1, z * 0.42);
        ctx.lineTo(-z * 0.08, z * 0.18);
        ctx.lineTo(-z * 0.4, z * 0.32);
        ctx.lineTo(-z * 0.44, z * 0.22);          // aile gauche
        ctx.lineTo(-z * 0.12, -z * 0.1);
        ctx.closePath();
        ctx.fill();
        // nacelles moteur
        ctx.fillStyle = '#2c3136';
        ctx.fillRect(-z * 0.22, z * 0.05, z * 0.09, z * 0.22);
        ctx.fillRect(z * 0.13, z * 0.05, z * 0.09, z * 0.22);
        // verrière
        ctx.fillStyle = 'rgba(180,225,255,0.85)';
        ctx.beginPath(); ctx.ellipse(0, -z * 0.22, z * 0.06, z * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (v.selectedUnits.includes(u.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, z * 0.6, 0, Math.PI * 2); ctx.stroke();
      }
      this.healthBar(ctx, px, py - z * 0.9, z * 0.9, u.hp / u.maxHp, v.selectedUnits.includes(u.id));
    }

    // ----- brouillard : image alpha 1 px/tuile, mise à l'échelle adoucie
    this.drawFog(g, ctx, left, top, viewW, viewH, W, H);

    // ----- fantôme de placement
    if (v.placing) {
      const def = BUILDINGS[v.placing as keyof typeof BUILDINGS];
      const px = sx(v.placeTx - 0.5), py = sy(v.placeTy - 0.5);
      ctx.fillStyle = v.placeValid ? 'rgba(80,220,120,0.4)' : 'rgba(230,70,60,0.4)';
      ctx.fillRect(px, py, def.w * z, def.h * z);
      ctx.strokeStyle = v.placeValid ? '#50dc78' : '#e6463c';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, def.w * z, def.h * z);
    }

    // ----- rectangle de sélection
    if (v.box) {
      ctx.strokeStyle = 'rgba(140,220,140,0.9)';
      ctx.fillStyle = 'rgba(140,220,140,0.12)';
      ctx.lineWidth = 1;
      const bx = Math.min(v.box.x0, v.box.x1), by = Math.min(v.box.y0, v.box.y1);
      const bw = Math.abs(v.box.x1 - v.box.x0), bh = Math.abs(v.box.y1 - v.box.y0);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    }

    // ----- cycle jour/nuit + ambiance
    if (g.settings.dayNight) {
      const cycle = (g.time % 240) / 240;
      const night = Math.max(0, Math.sin(cycle * Math.PI * 2 - Math.PI / 2)) * 0.32;
      if (night > 0.01) {
        ctx.fillStyle = `rgba(10,16,42,${night})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    if (theme.mist) {
      const t = g.time * 0.06;
      ctx.fillStyle = `rgba(190,200,210,${theme.mist * (0.7 + 0.3 * Math.sin(t))})`;
      ctx.fillRect(0, 0, W, H);
    }

    this.drawMinimap(g, v, dtFrame);
  }

  // -------------------------------------------------------------- brouillard

  private drawFog(
    g: Game, ctx: CanvasRenderingContext2D,
    left: number, top: number, viewW: number, viewH: number, W: number, H: number,
  ) {
    const { w, h } = g.map;
    if (!this.fogCanvas) {
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.width = w; this.fogCanvas.height = h;
      this.fogCtx = this.fogCanvas.getContext('2d')!;
      this.fogImg = this.fogCtx.createImageData(w, h);
      const d = this.fogImg.data;
      for (let i = 0; i < w * h; i++) { d[i * 4] = 8; d[i * 4 + 1] = 10; d[i * 4 + 2] = 14; }
    }
    const fog = g.players[0].fog;
    const d = this.fogImg!.data;
    for (let i = 0; i < w * h; i++) {
      d[i * 4 + 3] = fog[i] === 2 ? 0 : fog[i] === 1 ? 118 : 255;
    }
    this.fogCtx!.putImageData(this.fogImg!, 0, 0);
    ctx.imageSmoothingEnabled = true;
    this.drawImageClamped(ctx, this.fogCanvas, left + 0.5, top + 0.5, viewW, viewH, W, H);
  }

  // drawImage avec rectangle source rogné aux bords de l'image : un rectangle
  // source hors limites est étiré par Safari (le brouillard "bougeait" au zoom).
  private drawImageClamped(
    ctx: CanvasRenderingContext2D, img: HTMLCanvasElement,
    srcX: number, srcY: number, srcW: number, srcH: number,
    dstW: number, dstH: number,
  ) {
    const x0 = Math.max(0, srcX), y0 = Math.max(0, srcY);
    const x1 = Math.min(img.width, srcX + srcW), y1 = Math.min(img.height, srcY + srcH);
    if (x1 <= x0 || y1 <= y0) return;
    const kx = dstW / srcW, ky = dstH / srcH;
    ctx.drawImage(
      img, x0, y0, x1 - x0, y1 - y0,
      (x0 - srcX) * kx, (y0 - srcY) * ky, (x1 - x0) * kx, (y1 - y0) * ky,
    );
  }

  // ------------------------------------------------------------------ unités

  private rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  private drawUnit(
    ctx: CanvasRenderingContext2D, g: Game, u: Unit,
    sx: (x: number) => number, sy: (y: number) => number, z: number, selected: boolean,
  ) {
    const def = UNITS[u.type];
    const px = sx(u.x), py = sy(u.y);
    const col = PLAYER_COLORS[u.owner];

    if (selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, (def.radius + 0.26) * z, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.save();
    ctx.translate(px, py);

    if (def.armor === 'inf') {
      const r = def.radius * z;
      // ombre + corps commun
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(z * 0.05, z * 0.08, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // reflet de casque (lumière zénithale)
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = Math.max(1, z * 0.05);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.72, -2.4, -1.2); ctx.stroke();
      const dirX = Math.cos(u.dir), dirY = Math.sin(u.dir);
      // épaules : petit trait perpendiculaire à la visée (donne une posture)
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = Math.max(1.4, z * 0.1);
      ctx.beginPath();
      ctx.moveTo(-dirY * r * 0.8, dirX * r * 0.8);
      ctx.lineTo(dirY * r * 0.8, -dirX * r * 0.8);
      ctx.stroke();

      if (u.type === 'rifle') {
        // fusilier : casque sombre, fusil deux tons (crosse bois + canon clair), sac à dos
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#6e5a3a';
        ctx.fillRect(-dirX * r * 1.0 - z * 0.06, -dirY * r * 1.0 - z * 0.06, z * 0.12, z * 0.12); // sac
        ctx.strokeStyle = '#7a5c34'; // crosse
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.2, dirY * r * 0.2);
        ctx.lineTo(dirX * r * 0.8, dirY * r * 0.8);
        ctx.stroke();
        ctx.strokeStyle = '#e8eef2'; // canon
        ctx.lineWidth = Math.max(1, z * 0.055);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.8, dirY * r * 0.8);
        ctx.lineTo(dirX * r * 1.6, dirY * r * 1.6);
        ctx.stroke();
      } else if (u.type === 'bazooka') {
        // bazooka : gros tube kaki sur l'épaule, gueule sombre, embout rouge, genou à terre
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.arc(-dirY * r * 0.55, dirX * r * 0.55, Math.max(1.2, z * 0.07), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#b09040';
        ctx.lineWidth = Math.max(2.4, z * 0.16);
        ctx.beginPath();
        ctx.moveTo(-dirX * r * 1.0, -dirY * r * 1.0);
        ctx.lineTo(dirX * r * 1.9, dirY * r * 1.9);
        ctx.stroke();
        ctx.strokeStyle = '#2c3136'; // gueule du tube
        ctx.lineWidth = Math.max(2.8, z * 0.2);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 1.55, dirY * r * 1.55);
        ctx.lineTo(dirX * r * 1.9, dirY * r * 1.9);
        ctx.stroke();
        ctx.fillStyle = '#ff5e72';
        ctx.beginPath(); ctx.arc(-dirX * r * 1.0, -dirY * r * 1.0, Math.max(1.5, z * 0.09), 0, Math.PI * 2); ctx.fill();
      } else if (u.type === 'sniper') {
        // sniper : ghillie sombre irrégulière, très long canon, lunette, bipied
        ctx.fillStyle = 'rgba(20,28,18,0.55)';
        for (const [ox, oy] of [[0, 0], [0.5, 0.3], [-0.4, 0.4], [0.2, -0.5]]) {
          ctx.beginPath(); ctx.arc(ox * r, oy * r, r * 0.62, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = '#dfe5ea';
        ctx.lineWidth = Math.max(1, z * 0.045);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.3, dirY * r * 0.3);
        ctx.lineTo(dirX * r * 2.7, dirY * r * 2.7);
        ctx.stroke();
        // bipied
        ctx.beginPath();
        ctx.moveTo(dirX * r * 2.3 - dirY * r * 0.35, dirY * r * 2.3 + dirX * r * 0.35);
        ctx.lineTo(dirX * r * 2.3 + dirY * r * 0.35, dirY * r * 2.3 - dirX * r * 0.35);
        ctx.stroke();
        ctx.fillStyle = '#9ad0ff'; // lunette
        ctx.beginPath(); ctx.arc(dirX * r * 1.0, dirY * r * 1.0, Math.max(1.3, z * 0.08), 0, Math.PI * 2); ctx.fill();
      } else if (u.type === 'engineer') {
        // ingénieur : casque de chantier à visière, boîte à outils orange, clé
        ctx.fillStyle = '#ffd84d';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.64, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#c79a20';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, r * 0.64, u.dir - 0.7, u.dir + 0.7); ctx.stroke();
        ctx.fillStyle = '#e07b2c'; // boîte à outils
        ctx.fillRect(-dirY * r * 1.05 - z * 0.09, dirX * r * 1.05 - z * 0.06, z * 0.18, z * 0.12);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath();
        ctx.moveTo(-r * 0.55, r * 0.55); ctx.lineTo(r * 0.55, -r * 0.55);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(r * 0.6, -r * 0.6, Math.max(1.2, z * 0.07), 0, Math.PI * 1.4); ctx.stroke();
      } else if (u.type === 'elite') {
        // fusilier d'élite : liseré doré, fusil à baïonnette, béret sombre
        ctx.strokeStyle = '#e7c44a';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath(); ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e8eef2';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 0.25, dirY * r * 0.25);
        ctx.lineTo(dirX * r * 1.75, dirY * r * 1.75);
        ctx.stroke();
        ctx.strokeStyle = '#e7c44a'; // baïonnette
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath();
        ctx.moveTo(dirX * r * 1.75, dirY * r * 1.75);
        ctx.lineTo(dirX * r * 2.05, dirY * r * 2.05);
        ctx.stroke();
      } else if (u.type === 'rocketeer') {
        // lance-roquettes lourd : double tube + râtelier de roquettes dorsal
        ctx.strokeStyle = '#8a7430';
        ctx.lineWidth = Math.max(3.2, z * 0.24);
        ctx.beginPath();
        ctx.moveTo(-dirX * r * 1.0, -dirY * r * 1.0);
        ctx.lineTo(dirX * r * 2.0, dirY * r * 2.0);
        ctx.stroke();
        ctx.strokeStyle = '#1d2126'; // séparation des deux tubes
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath();
        ctx.moveTo(-dirX * r * 1.0, -dirY * r * 1.0);
        ctx.lineTo(dirX * r * 2.0, dirY * r * 2.0);
        ctx.stroke();
        ctx.fillStyle = '#ff5e72';
        ctx.beginPath(); ctx.arc(dirX * r * 2.0, dirY * r * 2.0, Math.max(1.8, z * 0.11), 0, Math.PI * 2); ctx.fill();
        // râtelier dorsal
        ctx.fillStyle = '#5a4d28';
        ctx.fillRect(-dirX * r * 1.15 - z * 0.1, -dirY * r * 1.15 - z * 0.1, z * 0.2, z * 0.2);
      } else if (u.type === 'kamikaze') {
        // kamikaze : gilet d'explosifs visible + anneau rouge pulsant
        const pulse = 0.45 + 0.35 * Math.sin(g.time * 7 + u.id);
        ctx.strokeStyle = `rgba(255,70,70,${pulse})`;
        ctx.lineWidth = Math.max(1.5, z * 0.09);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#2c1416';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#c23030';
        for (const a of [-0.8, 0, 0.8]) {
          const bx = Math.cos(u.dir + a + Math.PI) * r * 0.45;
          const by = Math.sin(u.dir + a + Math.PI) * r * 0.45;
          ctx.fillRect(bx - z * 0.05, by - z * 0.05, z * 0.1, z * 0.1);
        }
      }
    } else {
      ctx.rotate(u.dir);

      if (u.type === 'jeep') {
        // jeep : petite, fine, 4 roues visibles, pare-brise clair, antenne
        const L = def.radius * 2.3 * z, Wd = def.radius * 1.35 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const wr = Math.max(1.5, z * 0.09);
        for (const [ox, oy] of [[-0.32, -0.62], [0.32, -0.62], [-0.32, 0.62], [0.32, 0.62]]) {
          ctx.fillRect(ox * L - wr, oy * Wd - wr, wr * 2, wr * 2);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = 'rgba(220,235,245,0.85)';
        ctx.fillRect(L * 0.05, -Wd * 0.32, L * 0.22, Wd * 0.64);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-L * 0.3, 0); ctx.lineTo(-L * 0.3, -Wd * 0.9); ctx.stroke();
      } else if (u.type === 'tank') {
        // tank : chenilles à galets, glacis, tourelle ORIENTABLE + canon à manchon
        const L = def.radius * 2.4 * z, Wd = def.radius * 2.0 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.06, -Wd / 2 + z * 0.08, L, Wd, z * 0.08); ctx.fill();
        // chenilles avec galets
        ctx.fillStyle = '#23282c';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.26, z * 0.06); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.26, L, Wd * 0.26, z * 0.06); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        for (let k = -2; k <= 2; k++) {
          ctx.beginPath(); ctx.arc(k * L * 0.18, -Wd * 0.37, Math.max(1, Wd * 0.07), 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(k * L * 0.18, Wd * 0.37, Math.max(1, Wd * 0.07), 0, Math.PI * 2); ctx.fill();
        }
        // caisse + glacis avant éclairci
        ctx.fillStyle = col;
        this.rr(ctx, -L * 0.46, -Wd * 0.27, L * 0.92, Wd * 0.54, z * 0.07); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.beginPath();
        ctx.moveTo(L * 0.3, -Wd * 0.27); ctx.lineTo(L * 0.46, 0); ctx.lineTo(L * 0.3, Wd * 0.27);
        ctx.closePath(); ctx.fill();
        // grilles moteur arrière
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.moveTo(-L * (0.42 - k * 0.05), -Wd * 0.18);
          ctx.lineTo(-L * (0.42 - k * 0.05), Wd * 0.18);
          ctx.stroke();
        }
        // tourelle orientée vers la cible engagée
        let tAng = 0;
        if (u.engageId) {
          const tgt = u.engageIsBuilding ? g.buildingById.get(u.engageId) : g.unitById.get(u.engageId);
          if (tgt) {
            const tx2 = 'x' in tgt ? (tgt as { x: number }).x : 0;
            const ty2 = 'y' in tgt ? (tgt as { y: number }).y : 0;
            const bx = u.engageIsBuilding ? (tgt as { tx: number; w: number }).tx + (tgt as { w: number }).w / 2 : tx2;
            const by = u.engageIsBuilding ? (tgt as { ty: number; h: number }).ty + (tgt as { h: number }).h / 2 : ty2;
            tAng = Math.atan2(by - u.y, bx - u.x) - u.dir;
          }
        }
        ctx.save();
        ctx.translate(-L * 0.05, 0);
        ctx.rotate(tAng);
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.31, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.23, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.11);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.74, 0); ctx.stroke();
        ctx.lineWidth = Math.max(2.5, z * 0.16);
        ctx.beginPath(); ctx.moveTo(L * 0.52, 0); ctx.lineTo(L * 0.68, 0); ctx.stroke();
        ctx.restore();
      } else if (u.type === 'artillery') {
        // artillerie : chenilles fines, plaque arrière hachurée, canon démesuré
        // avec cylindres de recul et frein de bouche
        const L = def.radius * 2.3 * z, Wd = def.radius * 1.5 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.08); ctx.fill();
        ctx.fillStyle = '#23282c';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.2, z * 0.05); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.2, L, Wd * 0.2, z * 0.05); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -L * 0.46, -Wd * 0.3, L * 0.92, Wd * 0.6, z * 0.08); ctx.fill();
        // plaque de stabilisation arrière à rayures de danger
        ctx.fillStyle = '#2c3136';
        ctx.fillRect(-L * 0.64, -Wd * 0.55, L * 0.2, Wd * 1.1);
        ctx.fillStyle = '#e8c84a';
        ctx.fillRect(-L * 0.64, -Wd * 0.55, L * 0.2, Wd * 0.16);
        ctx.fillRect(-L * 0.64, Wd * 0.39, L * 0.2, Wd * 0.16);
        // berceau + cylindres de recul + très long canon + frein de bouche
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-L * 0.15, -Wd * 0.22, L * 0.4, Wd * 0.44);
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.moveTo(-L * 0.05, -Wd * 0.12); ctx.lineTo(L * 0.45, -Wd * 0.12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-L * 0.05, Wd * 0.12); ctx.lineTo(L * 0.45, Wd * 0.12); ctx.stroke();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.12);
        ctx.beginPath(); ctx.moveTo(-L * 0.1, 0); ctx.lineTo(L * 1.1, 0); ctx.stroke();
        ctx.lineWidth = Math.max(2.6, z * 0.18);
        ctx.beginPath(); ctx.moveTo(L * 0.95, 0); ctx.lineTo(L * 1.1, 0); ctx.stroke();
        ctx.strokeStyle = '#ffb060';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.moveTo(L * 0.8, -Wd * 0.18); ctx.lineTo(L * 0.8, Wd * 0.18); ctx.stroke();
      } else if (u.type === 'harvester') {
        // récolteur industriel : tambour d'admission denté, benne, cheminées
        const L = def.radius * 2.7 * z, Wd = def.radius * 2.1 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.06, -Wd / 2 + z * 0.08, L, Wd, z * 0.12); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.12); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.18, z * 0.1); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.18, L, Wd * 0.18, z * 0.1); ctx.fill();
        // tambour d'admission denté à l'avant (tourne quand il récolte)
        const spin = u.order.kind === 'harvest' && !u.path ? g.time * 6 : 0;
        ctx.fillStyle = '#3a4148';
        this.rr(ctx, L * 0.42, -Wd * 0.52, L * 0.3, Wd * 1.04, z * 0.06); ctx.fill();
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        for (let k = 0; k < 4; k++) {
          const off = ((spin + k * 0.8) % 3.2) / 3.2;
          const yy = -Wd * 0.45 + off * Wd * 0.9;
          ctx.beginPath(); ctx.moveTo(L * 0.44, yy); ctx.lineTo(L * 0.7, yy); ctx.stroke();
        }
        // benne : remplissage doré (ou rouge si minerai rare) proportionnel
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        this.rr(ctx, -L * 0.44, -Wd * 0.34, L * 0.62, Wd * 0.68, z * 0.06); ctx.fill();
        const fillF = Math.min(1, u.cargo / 320);
        if (fillF > 0.03) {
          const rareCargo = u.cargoValue > u.cargo * 1.5;
          ctx.fillStyle = rareCargo ? '#c43050' : '#e7c44a';
          this.rr(ctx, -L * 0.42, -Wd * 0.3, L * 0.58 * fillF, Wd * 0.6, z * 0.05); ctx.fill();
        }
        // cheminées d'échappement
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(L * 0.28, -Wd * 0.34, Math.max(1.4, z * 0.09), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(L * 0.28, Wd * 0.34, Math.max(1.4, z * 0.09), 0, Math.PI * 2); ctx.fill();
        // bande de sécurité
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(L * 0.2, -Wd * 0.5, z * 0.07, Wd);
      } else if (u.type === 'heavytank') {
        // tank lourd : massif, jupes latérales, tourelle large à DOUBLE canon
        const L = def.radius * 2.5 * z, Wd = def.radius * 2.1 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        this.rr(ctx, -L / 2 + z * 0.07, -Wd / 2 + z * 0.09, L, Wd, z * 0.08); ctx.fill();
        ctx.fillStyle = '#1d2126'; // jupes blindées couvrant les chenilles
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.3, z * 0.05); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.3, L, Wd * 0.3, z * 0.05); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -L * 0.48, -Wd * 0.28, L * 0.96, Wd * 0.56, z * 0.06); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(L * 0.32, -Wd * 0.28); ctx.lineTo(L * 0.48, 0); ctx.lineTo(L * 0.32, Wd * 0.28);
        ctx.closePath(); ctx.fill();
        let tAng2 = 0;
        if (u.engageId) {
          const tgt = u.engageIsBuilding ? g.buildingById.get(u.engageId) : g.unitById.get(u.engageId);
          if (tgt) {
            const bx = u.engageIsBuilding
              ? (tgt as { tx: number; w: number }).tx + (tgt as { w: number }).w / 2
              : (tgt as { x: number }).x;
            const by = u.engageIsBuilding
              ? (tgt as { ty: number; h: number }).ty + (tgt as { h: number }).h / 2
              : (tgt as { y: number }).y;
            tAng2 = Math.atan2(by - u.y, bx - u.x) - u.dir;
          }
        }
        ctx.save();
        ctx.translate(-L * 0.06, 0);
        ctx.rotate(tAng2);
        ctx.fillStyle = '#1d2126';
        this.rr(ctx, -Wd * 0.34, -Wd * 0.3, Wd * 0.68, Wd * 0.6, z * 0.08); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        this.rr(ctx, -Wd * 0.22, -Wd * 0.2, Wd * 0.44, Wd * 0.4, z * 0.06); ctx.fill();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.1);
        ctx.beginPath(); ctx.moveTo(0, -Wd * 0.12); ctx.lineTo(L * 0.74, -Wd * 0.12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, Wd * 0.12); ctx.lineTo(L * 0.74, Wd * 0.12); ctx.stroke();
        ctx.lineWidth = Math.max(2.4, z * 0.15);
        ctx.beginPath(); ctx.moveTo(L * 0.56, -Wd * 0.12); ctx.lineTo(L * 0.7, -Wd * 0.12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(L * 0.56, Wd * 0.12); ctx.lineTo(L * 0.7, Wd * 0.12); ctx.stroke();
        ctx.restore();
      } else if (u.type === 'tankdestroyer') {
        // chasseur de chars : casemate basse fixe, très long canon, glacis anguleux
        const L = def.radius * 2.6 * z, Wd = def.radius * 1.8 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.06); ctx.fill();
        ctx.fillStyle = '#23282c';
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd * 0.22, z * 0.04); ctx.fill();
        this.rr(ctx, -L / 2, Wd / 2 - Wd * 0.22, L, Wd * 0.22, z * 0.04); ctx.fill();
        // coque anguleuse (pointe avant)
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(-L * 0.46, -Wd * 0.3);
        ctx.lineTo(L * 0.2, -Wd * 0.3);
        ctx.lineTo(L * 0.5, 0);
        ctx.lineTo(L * 0.2, Wd * 0.3);
        ctx.lineTo(-L * 0.46, Wd * 0.3);
        ctx.closePath(); ctx.fill();
        // casemate sombre fixe
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.moveTo(-L * 0.3, -Wd * 0.18);
        ctx.lineTo(L * 0.1, -Wd * 0.18);
        ctx.lineTo(L * 0.26, 0);
        ctx.lineTo(L * 0.1, Wd * 0.18);
        ctx.lineTo(-L * 0.3, Wd * 0.18);
        ctx.closePath(); ctx.fill();
        // canon démesuré avec gros frein de bouche
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = Math.max(2, z * 0.1);
        ctx.beginPath(); ctx.moveTo(L * 0.1, 0); ctx.lineTo(L * 1.15, 0); ctx.stroke();
        ctx.lineWidth = Math.max(2.8, z * 0.18);
        ctx.beginPath(); ctx.moveTo(L * 0.98, 0); ctx.lineTo(L * 1.15, 0); ctx.stroke();
      } else if (u.type === 'heavyarty') {
        // artillerie lourde : plateforme à 4 vérins déployés + mortier énorme
        const L = def.radius * 2.5 * z, Wd = def.radius * 2.0 * z;
        ctx.strokeStyle = '#2c3136'; // vérins de stabilisation
        ctx.lineWidth = Math.max(2, z * 0.12);
        for (const [vx2, vy2] of [[-0.5, -0.55], [-0.5, 0.55], [0.35, -0.55], [0.35, 0.55]]) {
          ctx.beginPath();
          ctx.moveTo(vx2 * L * 0.6, vy2 * Wd * 0.5);
          ctx.lineTo(vx2 * L, vy2 * Wd);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.06, -Wd / 2 + z * 0.08, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.1); ctx.fill();
        // plateau tournant + mortier massif
        ctx.fillStyle = '#1d2126';
        ctx.beginPath(); ctx.arc(-L * 0.1, 0, Wd * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.arc(-L * 0.1, 0, Wd * 0.38, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#dfe5ea';
        ctx.lineWidth = Math.max(4, z * 0.26);
        ctx.beginPath(); ctx.moveTo(-L * 0.1, 0); ctx.lineTo(L * 0.85, 0); ctx.stroke();
        ctx.strokeStyle = '#2c3136';
        ctx.lineWidth = Math.max(5, z * 0.34);
        ctx.beginPath(); ctx.moveTo(L * 0.6, 0); ctx.lineTo(L * 0.85, 0); ctx.stroke();
        ctx.fillStyle = '#e8c84a'; // rayures de danger
        ctx.fillRect(-L * 0.52, -Wd * 0.52, L * 0.1, Wd * 0.18);
        ctx.fillRect(-L * 0.52, Wd * 0.34, L * 0.1, Wd * 0.18);
      } else if (u.type === 'radarvehicle') {
        // véhicule radar : châssis 6 roues + grande parabole rotative
        const L = def.radius * 2.4 * z, Wd = def.radius * 1.6 * z;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const wr2 = Math.max(1.4, z * 0.08);
        for (const ox2 of [-0.36, 0, 0.36]) {
          ctx.fillRect(ox2 * L - wr2, -Wd * 0.62 - wr2, wr2 * 2, wr2 * 2);
          ctx.fillRect(ox2 * L - wr2, Wd * 0.62 - wr2, wr2 * 2, wr2 * 2);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        this.rr(ctx, -L / 2 + z * 0.05, -Wd / 2 + z * 0.07, L, Wd, z * 0.1); ctx.fill();
        ctx.fillStyle = col;
        this.rr(ctx, -L / 2, -Wd / 2, L, Wd, z * 0.1); ctx.fill();
        // parabole rotative (animée) + dôme
        const sweep = g.time * 2.4 + u.id;
        ctx.strokeStyle = '#9ad0ff';
        ctx.lineWidth = Math.max(2, z * 0.1);
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.55, sweep - u.dir, sweep - u.dir + Math.PI * 0.7); ctx.stroke();
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.24, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(0, 0, Wd * 0.1, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    if (selected || u.hp < u.maxHp) {
      this.healthBar(ctx, px, py - (def.radius + 0.45) * z, Math.max(14, def.radius * 2.4 * z), u.hp / u.maxHp, selected);
    }
  }

  // --------------------------------------------------------------- bâtiments

  private drawBuilding(
    ctx: CanvasRenderingContext2D, g: Game, b: Building,
    sx: (x: number) => number, sy: (y: number) => number, z: number,
    selected: boolean,
  ) {
    const px = sx(b.tx - 0.5), py = sy(b.ty - 0.5);
    const bw = b.w * z, bh = b.h * z;
    const col = PLAYER_COLORS[b.owner];
    ctx.save();

    // ----- infrastructure militaire : ombre, dalle béton, corps métallique
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    this.rr(ctx, px + z * 0.14, py + z * 0.18, bw, bh, z * 0.1); ctx.fill();
    // dalle de béton débordante avec coins renforcés
    ctx.fillStyle = '#24272c';
    this.rr(ctx, px - z * 0.12, py - z * 0.12, bw + z * 0.24, bh + z * 0.24, z * 0.08); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    this.rr(ctx, px - z * 0.12, py - z * 0.12, bw + z * 0.24, bh + z * 0.24, z * 0.08); ctx.stroke();
    // marquages de danger aux coins de la dalle
    ctx.fillStyle = '#caa536';
    const hz = Math.max(2, z * 0.16);
    for (const [cx2, cy2] of [[px - z * 0.12, py - z * 0.12], [px + bw + z * 0.12 - hz, py - z * 0.12],
                              [px - z * 0.12, py + bh + z * 0.12 - hz], [px + bw + z * 0.12 - hz, py + bh + z * 0.12 - hz]]) {
      ctx.fillRect(cx2, cy2, hz, hz * 0.4);
    }
    // corps métallique : tôle, éclairage zénithal, joints de panneaux
    ctx.fillStyle = '#41484f';
    this.rr(ctx, px, py, bw, bh, z * 0.1); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    this.rr(ctx, px, py, bw, bh * 0.26, z * 0.1); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    this.rr(ctx, px, py + bh * 0.78, bw, bh * 0.22, z * 0.1); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    for (let k = 1; k < b.w; k++) {
      ctx.beginPath(); ctx.moveTo(px + k * z, py + z * 0.1); ctx.lineTo(px + k * z, py + bh - z * 0.1); ctx.stroke();
    }
    // rivets d'angle
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (const [rx2, ry2] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
      ctx.beginPath(); ctx.arc(px + bw * rx2, py + bh * ry2, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
    }
    // bande d'identification du propriétaire (haut du bâtiment)
    ctx.fillStyle = col;
    this.rr(ctx, px, py, bw, Math.max(2.5, z * 0.16), z * 0.08); ctx.fill();
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, z * 0.05);
    this.rr(ctx, px + 0.5, py + 0.5, bw - 1, bh - 1, z * 0.09); ctx.stroke();
    ctx.globalAlpha = 1;

    // détail par type
    const cx = px + bw / 2, cy = py + bh / 2;
    ctx.fillStyle = col;
    ctx.strokeStyle = '#dfe5ea';
    switch (b.type) {
      case 'hq': {
        // centre de commandement : bloc blindé, hélisurface, antennes, radar
        ctx.fillStyle = '#353b42';
        this.rr(ctx, px + bw * 0.16, py + bh * 0.18, bw * 0.5, bh * 0.5, z * 0.08); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        this.rr(ctx, px + bw * 0.16, py + bh * 0.18, bw * 0.5, bh * 0.14, z * 0.08); ctx.fill();
        // hélisurface
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = Math.max(1, z * 0.06);
        ctx.beginPath(); ctx.arc(px + bw * 0.74, py + bh * 0.72, z * 0.5, 0, Math.PI * 2); ctx.stroke();
        ctx.font = `bold ${Math.max(7, z * 0.55)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText('H', px + bw * 0.74, py + bh * 0.72);
        // mâts d'antennes + feux clignotants
        ctx.strokeStyle = '#c9d1d9';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.26, py + bh * 0.42); ctx.lineTo(px + bw * 0.26, py + bh * 0.1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px + bw * 0.5, py + bh * 0.4); ctx.lineTo(px + bw * 0.56, py + bh * 0.14); ctx.stroke();
        ctx.fillStyle = `rgba(255,80,80,${0.5 + 0.5 * Math.sin(g.time * 4)})`;
        ctx.beginPath(); ctx.arc(px + bw * 0.26, py + bh * 0.1, Math.max(1.2, z * 0.07), 0, Math.PI * 2); ctx.fill();
        // petit radar tournant
        const ha = g.time * 2;
        ctx.strokeStyle = '#9ad0ff';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath(); ctx.arc(px + bw * 0.4, py + bh * 0.58, z * 0.3, ha, ha + Math.PI * 0.7); ctx.stroke();
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(px + bw * 0.4, py + bh * 0.58, z * 0.09, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'power': {
        // centrale : deux turbines à ailettes + cœur lumineux + câblage
        for (const tx2 of [0.32, 0.68]) {
          ctx.fillStyle = '#2c3136';
          ctx.beginPath(); ctx.arc(px + bw * tx2, cy, z * 0.42, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#6f7882';
          ctx.lineWidth = Math.max(1, z * 0.05);
          const ta = g.time * (tx2 < 0.5 ? 2.2 : -2.2);
          for (let k = 0; k < 3; k++) {
            const a = ta + (k / 3) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(px + bw * tx2, cy);
            ctx.lineTo(px + bw * tx2 + Math.cos(a) * z * 0.36, cy + Math.sin(a) * z * 0.36);
            ctx.stroke();
          }
          ctx.fillStyle = `rgba(255,216,77,${0.55 + 0.25 * Math.sin(g.time * 6 + tx2 * 9)})`;
          ctx.beginPath(); ctx.arc(px + bw * tx2, cy, z * 0.12, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = '#caa536';
        ctx.lineWidth = Math.max(1, z * 0.06);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.32, cy); ctx.lineTo(px + bw * 0.68, cy); ctx.stroke();
        break;
      }
      case 'refinery': {
        // site industriel : deux cuves cerclées, tuyauterie, torchère
        for (const [tx2, ty2, r2] of [[0.3, 0.36, 0.42], [0.62, 0.62, 0.34]]) {
          ctx.fillStyle = '#8a939d';
          ctx.beginPath(); ctx.arc(px + bw * tx2, py + bh * ty2, z * r2, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.beginPath(); ctx.arc(px + bw * tx2 - z * r2 * 0.3, py + bh * ty2 - z * r2 * 0.3, z * r2 * 0.35, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(px + bw * tx2, py + bh * ty2, z * r2 * 0.65, 0, Math.PI * 2); ctx.stroke();
        }
        // tuyauterie
        ctx.strokeStyle = '#6f7882';
        ctx.lineWidth = Math.max(1.6, z * 0.1);
        ctx.beginPath();
        ctx.moveTo(px + bw * 0.3, py + bh * 0.36);
        ctx.lineTo(px + bw * 0.62, py + bh * 0.62);
        ctx.lineTo(px + bw * 0.88, py + bh * 0.62);
        ctx.stroke();
        // torchère avec flamme vacillante
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1, z * 0.06);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.84, py + bh * 0.4); ctx.lineTo(px + bw * 0.84, py + bh * 0.14); ctx.stroke();
        ctx.fillStyle = `rgba(255,${150 + Math.floor(60 * Math.sin(g.time * 9))},60,0.9)`;
        ctx.beginPath(); ctx.arc(px + bw * 0.84, py + bh * 0.11, Math.max(1.5, z * 0.1 + z * 0.03 * Math.sin(g.time * 11)), 0, Math.PI * 2); ctx.fill();
        // quai doré de déchargement
        ctx.fillStyle = '#caa536';
        this.rr(ctx, px + bw * 0.22, py + bh - z * 0.42, bw * 0.56, z * 0.32, z * 0.06); ctx.fill();
        ctx.fillStyle = '#2c3136';
        for (let k = 0; k < 3; k++) ctx.fillRect(px + bw * (0.28 + k * 0.17), py + bh - z * 0.38, z * 0.1, z * 0.24);
        break;
      }
      case 'barracks': {
        // base militaire : toit à deux travées, porte, sacs de sable
        ctx.fillStyle = '#3a4046';
        this.rr(ctx, px + bw * 0.12, py + bh * 0.22, bw * 0.76, bh * 0.3, z * 0.05); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(px + bw * 0.12, py + bh * 0.22, bw * 0.76, bh * 0.08);
        ctx.fillStyle = '#3a4046';
        this.rr(ctx, px + bw * 0.12, py + bh * 0.58, bw * 0.76, bh * 0.3, z * 0.05); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(px + bw * 0.12, py + bh * 0.58, bw * 0.76, bh * 0.08);
        // porte éclairée
        ctx.fillStyle = '#1d2126';
        ctx.fillRect(px + bw * 0.44, py + bh * 0.66, bw * 0.12, bh * 0.22);
        ctx.fillStyle = 'rgba(255,230,150,0.6)';
        ctx.fillRect(px + bw * 0.46, py + bh * 0.68, bw * 0.08, bh * 0.05);
        // sacs de sable
        ctx.fillStyle = '#7a6f52';
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          ctx.ellipse(px + bw * (0.2 + k * 0.2), py + bh * 0.94, z * 0.11, z * 0.06, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'factory': {
        // complexe industriel : halle, portique roulant, baie à chevrons
        ctx.fillStyle = '#353b42';
        this.rr(ctx, px + bw * 0.1, py + bh * 0.2, bw * 0.8, bh * 0.62, z * 0.05); ctx.fill();
        // toit en dents de scie
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.moveTo(px + bw * (0.1 + k * 0.27), py + bh * 0.2);
          ctx.lineTo(px + bw * (0.23 + k * 0.27), py + bh * 0.3);
          ctx.lineTo(px + bw * (0.1 + k * 0.27), py + bh * 0.4);
          ctx.closePath(); ctx.fill();
        }
        // portique roulant (anime un léger va-et-vient)
        const gx = px + bw * (0.3 + 0.3 * (0.5 + 0.5 * Math.sin(g.time * 0.7)));
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = Math.max(1.4, z * 0.08);
        ctx.beginPath(); ctx.moveTo(gx, py + bh * 0.2); ctx.lineTo(gx, py + bh * 0.82); ctx.stroke();
        ctx.fillStyle = '#caa536';
        ctx.fillRect(gx - z * 0.1, py + bh * 0.46, z * 0.2, z * 0.16);
        // baie de sortie à chevrons
        ctx.fillStyle = '#1d2126';
        ctx.fillRect(px + bw * 0.32, py + bh * 0.84, bw * 0.36, bh * 0.12);
        ctx.fillStyle = '#caa536';
        for (let k = 0; k < 3; k++) ctx.fillRect(px + bw * (0.34 + k * 0.12), py + bh * 0.86, bw * 0.05, bh * 0.08);
        break;
      }
      case 'radar': {
        // station radar : dôme + parabole inclinée balayant + écran
        ctx.fillStyle = '#353b42';
        ctx.beginPath(); ctx.arc(cx, cy + z * 0.1, z * 0.42, 0, Math.PI * 2); ctx.fill();
        const a = g.time * 1.6;
        ctx.strokeStyle = '#cfe8ff';
        ctx.lineWidth = Math.max(1.6, z * 0.1);
        ctx.beginPath(); ctx.ellipse(cx, cy, z * 0.52, z * 0.34, a, -0.6, 2.2); ctx.stroke();
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(120,255,150,${0.4 + 0.3 * Math.sin(g.time * 3)})`;
        ctx.fillRect(px + bw * 0.14, py + bh * 0.7, bw * 0.2, bh * 0.12);
        break;
      }
      case 'airport': {
        // piste éclairée + manche à air + hangar
        ctx.fillStyle = '#2c3136';
        this.rr(ctx, px + bw * 0.1, py + bh * 0.25, bw * 0.8, bh * 0.52, z * 0.06); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.setLineDash([z * 0.15, z * 0.15]);
        ctx.beginPath(); ctx.moveTo(px + bw * 0.14, cy); ctx.lineTo(px + bw * 0.86, cy); ctx.stroke();
        ctx.setLineDash([]);
        // feux de piste séquentiels
        for (let k = 0; k < 5; k++) {
          const on = (Math.floor(g.time * 4) % 5) === k;
          ctx.fillStyle = on ? '#ffe27a' : 'rgba(255,226,122,0.25)';
          ctx.beginPath(); ctx.arc(px + bw * (0.16 + k * 0.17), py + bh * 0.72, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        }
        // manche à air
        ctx.strokeStyle = '#9aa6b0';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px + bw * 0.9, py + bh * 0.3); ctx.lineTo(px + bw * 0.9, py + bh * 0.12); ctx.stroke();
        ctx.fillStyle = '#e0344a';
        ctx.beginPath();
        ctx.moveTo(px + bw * 0.9, py + bh * 0.12);
        ctx.lineTo(px + bw * 0.98, py + bh * 0.16);
        ctx.lineTo(px + bw * 0.9, py + bh * 0.2);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'turret': case 'atgun': {
        // plateforme octogonale + tourelle blindée orientée + canon avec recul visuel
        ctx.fillStyle = '#2c3136';
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const a2 = (k / 8) * Math.PI * 2 + Math.PI / 8;
          const xx = cx + Math.cos(a2) * z * 0.42, yy = cy + Math.sin(a2) * z * 0.42;
          if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.closePath(); ctx.fill();
        const target = b.engageId ? g.unitById.get(b.engageId) : undefined;
        const ang = target ? Math.atan2(target.y - (b.ty + b.h / 2), target.x - (b.tx + b.w / 2)) : g.time * 0.3 + b.id;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(ang);
        ctx.fillStyle = '#41484f';
        this.rr(ctx, -z * 0.22, -z * 0.2, z * 0.44, z * 0.4, z * 0.07); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        this.rr(ctx, -z * 0.14, -z * 0.12, z * 0.28, z * 0.24, z * 0.05); ctx.fill();
        ctx.strokeStyle = b.type === 'turret' ? '#dfe5ea' : '#ffb060';
        if (b.type === 'turret') {
          // double mitrailleuse
          ctx.lineWidth = Math.max(1.4, z * 0.07);
          ctx.beginPath(); ctx.moveTo(0, -z * 0.08); ctx.lineTo(z * 0.6, -z * 0.08); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, z * 0.08); ctx.lineTo(z * 0.6, z * 0.08); ctx.stroke();
        } else {
          ctx.lineWidth = Math.max(2.2, z * 0.13);
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(z * 0.72, 0); ctx.stroke();
          ctx.lineWidth = Math.max(2.8, z * 0.2);
          ctx.beginPath(); ctx.moveTo(z * 0.58, 0); ctx.lineTo(z * 0.72, 0); ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'aa': {
        // batterie AA : rampe de 4 missiles inclinés + radar de tir
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 4 + 0.2 * Math.sin(g.time * 0.8));
        ctx.fillStyle = '#41484f';
        this.rr(ctx, -z * 0.3, -z * 0.24, z * 0.6, z * 0.48, z * 0.06); ctx.fill();
        ctx.strokeStyle = '#cfe8ff';
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        for (const off of [-z * 0.14, -z * 0.05, z * 0.05, z * 0.14]) {
          ctx.beginPath(); ctx.moveTo(-z * 0.2, off); ctx.lineTo(z * 0.42, off); ctx.stroke();
        }
        ctx.fillStyle = '#e0344a';
        for (const off of [-z * 0.14, -z * 0.05, z * 0.05, z * 0.14]) {
          ctx.beginPath(); ctx.arc(z * 0.42, off, Math.max(1, z * 0.05), 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 'tech': {
        // centre tactique : écrans, antenne fouet, éprouvette lumineuse
        ctx.fillStyle = '#1d2126';
        this.rr(ctx, px + bw * 0.16, py + bh * 0.3, bw * 0.42, bh * 0.32, z * 0.05); ctx.fill();
        ctx.fillStyle = `rgba(120,210,255,${0.5 + 0.2 * Math.sin(g.time * 2.4)})`;
        ctx.fillRect(px + bw * 0.2, py + bh * 0.35, bw * 0.14, bh * 0.1);
        ctx.fillRect(px + bw * 0.38, py + bh * 0.35, bw * 0.14, bh * 0.1);
        ctx.fillStyle = 'rgba(120,255,150,0.55)';
        ctx.fillRect(px + bw * 0.2, py + bh * 0.5, bw * 0.32, bh * 0.06);
        ctx.strokeStyle = '#c9d1d9';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px + bw * 0.76, py + bh * 0.6); ctx.lineTo(px + bw * 0.82, py + bh * 0.16); ctx.stroke();
        ctx.fillStyle = '#9ad0ff';
        ctx.beginPath(); ctx.arc(px + bw * 0.7, py + bh * 0.74, z * 0.18, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'radarcenter': {
        // double arc balayant + grand dôme
        ctx.strokeStyle = '#9ad0ff';
        ctx.lineWidth = Math.max(1.5, z * 0.1);
        const a2 = g.time * 2.2;
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.55, a2, a2 + Math.PI * 0.7); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.32, -a2, -a2 + Math.PI * 0.9); ctx.stroke();
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.16, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'depot': {
        // caisses empilées + pastille dorée
        ctx.fillStyle = '#8a6d3f';
        this.rr(ctx, px + bw * 0.18, py + bh * 0.4, bw * 0.28, bh * 0.32, z * 0.04); ctx.fill();
        this.rr(ctx, px + bw * 0.52, py + bh * 0.4, bw * 0.28, bh * 0.32, z * 0.04); ctx.fill();
        ctx.fillStyle = '#a8895a';
        this.rr(ctx, px + bw * 0.34, py + bh * 0.18, bw * 0.3, bh * 0.26, z * 0.04); ctx.fill();
        ctx.fillStyle = '#e7c44a';
        ctx.beginPath(); ctx.arc(cx, py + bh * 0.78, z * 0.12, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'lab': {
        // laboratoire : noyau lumineux + orbites animées (atome)
        const a3 = g.time * 1.4;
        ctx.strokeStyle = '#9ad0ff';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        for (let k2 = 0; k2 < 3; k2++) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, z * 0.75, z * 0.3, a3 + (k2 * Math.PI) / 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = '#cfe8ff';
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(154,208,255,${0.25 + 0.15 * Math.sin(g.time * 3)})`;
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.5, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'barracks2': {
        // caserne T2 : double chevron doré + deux silhouettes
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath(); ctx.arc(cx - z * 0.3, cy + z * 0.1, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx + z * 0.3, cy + z * 0.1, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#e7c44a';
        ctx.lineWidth = Math.max(1.6, z * 0.09);
        for (const off of [0, z * 0.22]) {
          ctx.beginPath();
          ctx.moveTo(cx - z * 0.32, cy - z * 0.18 - off + z * 0.14);
          ctx.lineTo(cx, cy - z * 0.4 - off + z * 0.14);
          ctx.lineTo(cx + z * 0.32, cy - z * 0.18 - off + z * 0.14);
          ctx.stroke();
        }
        break;
      }
      case 'factory2': {
        // usine T2 : chaînes superposées + double cheminée incandescente
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        this.rr(ctx, px + bw * 0.15, py + bh * 0.26, bw * 0.7, bh * 0.15, z * 0.05); ctx.fill();
        ctx.fillStyle = '#9aa6b0';
        this.rr(ctx, px + bw * 0.15, py + bh * 0.47, bw * 0.7, bh * 0.15, z * 0.05); ctx.fill();
        ctx.fillStyle = '#6f7882';
        this.rr(ctx, px + bw * 0.15, py + bh * 0.68, bw * 0.7, bh * 0.15, z * 0.05); ctx.fill();
        ctx.fillStyle = '#2c3136';
        ctx.beginPath(); ctx.arc(px + bw * 0.8, py + bh * 0.18, z * 0.16, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px + bw * 0.62, py + bh * 0.18, z * 0.16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,120,60,${0.5 + 0.3 * Math.sin(g.time * 4)})`;
        ctx.beginPath(); ctx.arc(px + bw * 0.8, py + bh * 0.18, z * 0.08, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'power2': {
        // centrale T2 : réacteur circulaire + double éclair
        ctx.strokeStyle = '#9ad0ff';
        ctx.lineWidth = Math.max(1.5, z * 0.09);
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.58, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(154,208,255,${0.2 + 0.12 * Math.sin(g.time * 5)})`;
        ctx.beginPath(); ctx.arc(cx, cy, z * 0.55, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd84d';
        for (const off of [-z * 0.16, z * 0.16]) {
          ctx.beginPath();
          ctx.moveTo(cx + off + z * 0.07, cy - z * 0.34);
          ctx.lineTo(cx + off - z * 0.16, cy + z * 0.06);
          ctx.lineTo(cx + off + z * 0.01, cy + z * 0.06);
          ctx.lineTo(cx + off - z * 0.07, cy + z * 0.38);
          ctx.lineTo(cx + off + z * 0.2, cy - z * 0.04);
          ctx.lineTo(cx + off + z * 0.01, cy - z * 0.04);
          ctx.closePath(); ctx.fill();
        }
        break;
      }
      case 'refinery2': {
        // raffinerie T2 : grand dôme doré cerclé + double quai + halo
        ctx.fillStyle = `rgba(231,196,74,${0.18 + 0.1 * Math.sin(g.time * 2.5)})`;
        ctx.beginPath(); ctx.arc(cx, cy - z * 0.1, z * 0.85, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d4af37';
        ctx.beginPath(); ctx.arc(cx, cy - z * 0.12, z * 0.62, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff0c0';
        ctx.lineWidth = Math.max(1.2, z * 0.07);
        ctx.beginPath(); ctx.arc(cx, cy - z * 0.12, z * 0.62, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath(); ctx.arc(cx - z * 0.18, cy - z * 0.3, z * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2c3136';
        this.rr(ctx, px + bw * 0.12, py + bh - z * 0.55, bw * 0.32, z * 0.45, z * 0.08); ctx.fill();
        this.rr(ctx, px + bw * 0.56, py + bh - z * 0.55, bw * 0.32, z * 0.45, z * 0.08); ctx.fill();
        break;
      }
    }

    // construction en cours
    if (!b.built) {
      ctx.fillStyle = 'rgba(10,12,15,0.55)';
      ctx.fillRect(px, py, bw, bh * (1 - b.progress));
      ctx.fillStyle = '#15181c';
      ctx.fillRect(px, py + bh + 3, bw, 4);
      ctx.fillStyle = '#50dc78';
      ctx.fillRect(px, py + bh + 3, bw * b.progress, 4);
    }

    // production en cours
    if (b.built && b.queue.length > 0) {
      const q = b.queue[0];
      ctx.fillStyle = '#15181c';
      ctx.fillRect(px, py + bh + 3, bw, 4);
      ctx.fillStyle = '#6db7ff';
      ctx.fillRect(px, py + bh + 3, bw * Math.min(1, q.t / q.time), 4);
    }

    if (b.repairOn) {
      ctx.fillStyle = '#ffe070';
      ctx.font = `bold ${Math.max(9, z * 0.6)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔧', px + bw - z * 0.4, py + z * 0.4);
    }

    if (selected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(px - 2, py - 2, bw + 4, bh + 4);
      ctx.setLineDash([]);
      if (b.rally) {
        const rx = sx(b.rally.x), ry = sy(b.rally.y);
        ctx.strokeStyle = 'rgba(120,255,150,0.8)';
        ctx.beginPath(); ctx.moveTo(px + bw / 2, py + bh / 2); ctx.lineTo(rx, ry); ctx.stroke();
        ctx.fillStyle = '#78ff96';
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx, ry - 10); ctx.lineTo(rx + 7, ry - 7); ctx.closePath(); ctx.fill();
      }
    }

    if (selected || b.hp < b.maxHp) {
      this.healthBar(ctx, px + bw / 2, py - 5, bw * 0.85, b.hp / b.maxHp, selected);
    }
    ctx.restore();
  }

  private healthBar(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, f: number, strong: boolean) {
    f = Math.max(0, Math.min(1, f));
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx - w / 2, cy, w, strong ? 4 : 3);
    ctx.fillStyle = f > 0.55 ? '#5fd96a' : f > 0.25 ? '#e8c84a' : '#e05a4e';
    ctx.fillRect(cx - w / 2, cy, w * f, strong ? 4 : 3);
  }

  // --------------------------------------------------------------- mini-carte

  private drawMinimap(g: Game, v: ViewState, dt: number) {
    const ctx = this.mmCtx;
    const S = this.minimap.width;
    const mw = g.map.w, mh = g.map.h;
    // Letterbox : les cartes spéciales (Italie…) ne sont pas carrées.
    const k = S / Math.max(mw, mh);
    const ox = (S - mw * k) / 2, oy = (S - mh * k) / 2;
    const fog = g.players[0].fog;
    const theme = THEMES[g.map.theme];
    const radar = g.hasRadar(0);

    // fond terrain mis en cache
    if (!this.mmTerrain) {
      const c = document.createElement('canvas');
      c.width = mw; c.height = mh;
      const cc = c.getContext('2d')!;
      const img = cc.createImageData(mw, mh);
      for (let i = 0; i < mw * mh; i++) {
        const t = g.map.terrain[i];
        const col = t === T_WATER ? theme.water : t === T_ROCK ? theme.rock[0] : t === T_ROUGH ? theme.rough[0] : theme.grass[0];
        const r = parseInt(col.slice(1, 3), 16), gg = parseInt(col.slice(3, 5), 16), bb = parseInt(col.slice(5, 7), 16);
        img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = bb; img.data[i * 4 + 3] = 255;
      }
      cc.putImageData(img, 0, 0);
      this.mmTerrain = c;
    }

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#06080a';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(this.mmTerrain, ox, oy, mw * k, mh * k);

    // brouillard
    ctx.fillStyle = '#06080a';
    const step = Math.max(1, Math.floor(mw / 96));
    for (let y = 0; y < mh; y += step)
      for (let x = 0; x < mw; x += step) {
        if (fog[y * mw + x] === 0) ctx.fillRect(ox + x * k, oy + y * k, k * step + 0.5, k * step + 0.5);
        else if (fog[y * mw + x] === 1) {
          ctx.fillStyle = 'rgba(6,8,10,0.45)';
          ctx.fillRect(ox + x * k, oy + y * k, k * step + 0.5, k * step + 0.5);
          ctx.fillStyle = '#06080a';
        }
      }

    // minerai découvert (le rare ressort en rouge vif)
    for (const n of g.nodes) {
      if (n.amount < 10 || fog[n.ty * mw + n.tx] === 0) continue;
      ctx.fillStyle = n.kind === 'rare' ? '#ff4d6d' : theme.oreGlow;
      ctx.fillRect(ox + n.tx * k - 1, oy + n.ty * k - 1, 2, 2);
    }

    // bâtiments
    for (const b of g.buildings) {
      const ci = (b.ty + 1) * mw + b.tx + 1;
      const own = b.owner === 0;
      if (!own) {
        if (fog[Math.min(ci, fog.length - 1)] === 0) continue;
        if (!radar && !g.buildingVisibleTo(0, b)) continue;
      }
      ctx.fillStyle = PLAYER_COLORS[b.owner];
      ctx.fillRect(ox + b.tx * k, oy + b.ty * k, Math.max(2, b.w * k), Math.max(2, b.h * k));
    }

    // unités
    for (const u of g.units) {
      const own = u.owner === 0;
      if (!own && (!radar || !g.isVisibleTo(0, u.x, u.y))) continue;
      ctx.fillStyle = own ? '#9fe0ff' : PLAYER_COLORS[u.owner];
      ctx.fillRect(ox + u.x * k - 1, oy + u.y * k - 1, 2.2, 2.2);
    }

    // alertes
    for (const p of g.pings) {
      const age = (g.time - p.t) % 1;
      ctx.strokeStyle = `rgba(255,80,60,${1 - age})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ox + p.x * k, oy + p.y * k, 3 + age * 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // cadre caméra
    const cw = (this.canvas.width / v.cam.zoom) * k;
    const ch = (this.canvas.height / v.cam.zoom) * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + v.cam.x * k - cw / 2, oy + v.cam.y * k - ch / 2, cw, ch);
  }
}
