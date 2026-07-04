// Projection 2.5D isométrique « diamant 2:1 » — LE point unique de conversion
// monde ↔ écran. La simulation reste en coordonnées monde (grille carrée,
// 1 unité = 1 tuile) ; seul le rendu et l'entrée passent par ce module.
//
//   écran.x = (x − y) · z + ox
//   écran.y = (x + y) · z/2 + oy − hauteur · z · ELEV
//
// avec z = pixels par tuile (zoom). Une tuile devient un losange 2z × z.
// La projection du PLAN DU SOL est affine → tout ce qui est plat (terrain,
// brouillard, décals, routes, cercles de sélection) peut être dessiné en
// coordonnées monde sous un simple ctx.setTransform, sans réécriture.
// Ce qui a de la hauteur (bâtiments, infanterie, avions, barres de vie) est
// dessiné en « billboard » ancré au point projeté.

export const ISO_ELEV = 0.72;     // pixels d'élévation par tuile de hauteur (× z)

export interface ScreenPt { x: number; y: number; }

export class Proj {
  readonly ox: number;
  readonly oy: number;
  constructor(
    readonly camX: number,
    readonly camY: number,
    readonly z: number,       // pixels par tuile
    readonly W: number,       // taille du canvas en pixels physiques
    readonly H: number,
  ) {
    this.ox = W / 2 - (camX - camY) * z;
    this.oy = H / 2 - (camX + camY) * z * 0.5;
  }

  /** Monde → écran (h = hauteur en tuiles au-dessus du sol). */
  sx(x: number, y: number): number { return (x - y) * this.z + this.ox; }
  sy(x: number, y: number, h = 0): number { return (x + y) * this.z * 0.5 + this.oy - h * this.z * ISO_ELEV; }
  toScreen(x: number, y: number, h = 0): ScreenPt {
    return { x: this.sx(x, y), y: this.sy(x, y, h) };
  }

  /** Écran → monde (point du plan du sol). Inverse exact de toScreen(h=0). */
  toWorld(px: number, py: number): ScreenPt {
    const a = (px - this.ox) / this.z;          // x − y
    const b = (py - this.oy) / (this.z * 0.5);  // x + y
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  /** Déplacement écran → déplacement monde (pour le pan caméra). */
  deltaToWorld(dx: number, dy: number): ScreenPt {
    const a = dx / this.z, b = dy / (this.z * 0.5);
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  /**
   * Transformation affine plan-du-sol pour ctx.setTransform : les coordonnées
   * dessinées sont alors en unités MONDE (échelle `unitsPerWorld` px par tuile
   * pour les images pré-rendues : passer tpx ; 1 pour dessiner en tuiles).
   * L'image/dessin source est supposé décalé d'une demi-tuile (convention des
   * caches terrain/brouillard : le pixel (0,0) correspond au monde (−0.5,−0.5)).
   */
  groundTransform(unitsPerWorld = 1, halfTileOffset = false): [number, number, number, number, number, number] {
    const k = this.z / unitsPerWorld;
    const off = halfTileOffset ? 0.5 * unitsPerWorld : 0;
    // x' = k·(ix − off) − k·(iy − off) + ox  = k·ix − k·iy + ox        (les off s'annulent)
    // y' = k/2·(ix − off) + k/2·(iy − off) + oy = k/2·ix + k/2·iy + oy − off·k
    return [k, k * 0.5, -k, k * 0.5, this.ox, this.oy - off * k];
  }

  /** AABB monde couvrant tout l'écran (pour le culling par tuiles). */
  worldAABB(margin = 2): { x0: number; y0: number; x1: number; y1: number } {
    const c = [
      this.toWorld(0, 0), this.toWorld(this.W, 0),
      this.toWorld(0, this.H), this.toWorld(this.W, this.H),
    ];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of c) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    return { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
  }

  /** Clé de tri peintre : plus grand = plus « devant » (dessiné après). */
  static depthKey(x: number, y: number): number { return x + y; }

  /** Clé de tri d'un bâtiment : son coin avant (sud, bas d'écran). */
  static buildingDepthKey(tx: number, ty: number, w: number, h: number): number {
    return tx + w + ty + h - 0.35;   // léger retrait : les unités collées à la façade passent devant
  }

  /** Angle écran d'un cap monde (pour les billboards orientés : avions). */
  headingToScreen(dir: number): number {
    const cx = Math.cos(dir), cy = Math.sin(dir);
    return Math.atan2((cx + cy) * 0.5, cx - cy);
  }

  /** Trace le losange-emprise d'un rectangle monde (fantômes, surbrillances). */
  footprintPath(ctx: CanvasRenderingContext2D, tx: number, ty: number, w: number, h: number) {
    // convention : la tuile (tx,ty) couvre le monde [tx−0.5 .. tx+w−0.5]
    const x0 = tx - 0.5, y0 = ty - 0.5, x1 = x0 + w, y1 = y0 + h;
    ctx.beginPath();
    ctx.moveTo(this.sx(x0, y0), this.sy(x0, y0));
    ctx.lineTo(this.sx(x1, y0), this.sy(x1, y0));
    ctx.lineTo(this.sx(x1, y1), this.sy(x1, y1));
    ctx.lineTo(this.sx(x0, y1), this.sy(x0, y1));
    ctx.closePath();
  }

  /**
   * Enveloppe écran d'un bâtiment (hexagone : losange d'emprise extrudé de
   * `height` tuiles). Sert au picking « ce que je vois est cliquable ».
   */
  buildingScreenPoly(tx: number, ty: number, w: number, h: number, height: number): ScreenPt[] {
    const x0 = tx - 0.5, y0 = ty - 0.5, x1 = x0 + w, y1 = y0 + h;
    const lift = height * this.z * ISO_ELEV;
    const N = this.toScreen(x0, y0);   // coin nord (haut)
    const E = this.toScreen(x1, y0);   // coin est (droite)
    const S = this.toScreen(x1, y1);   // coin sud (bas)
    const O = this.toScreen(x0, y1);   // coin ouest (gauche)
    return [
      { x: N.x, y: N.y - lift },
      { x: E.x, y: E.y - lift },
      { x: E.x, y: E.y },
      { x: S.x, y: S.y },
      { x: O.x, y: O.y },
      { x: O.x, y: O.y - lift },
    ];
  }

  static pointInPoly(px: number, py: number, poly: ScreenPt[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /** Boîte écran approximative d'une unité (sélection rectangle, culling). */
  unitScreenBounds(x: number, y: number, radius: number, tall = 0.6): { x0: number; y0: number; x1: number; y1: number } {
    const p = this.toScreen(x, y);
    const rw = radius * this.z * 1.5;
    return { x0: p.x - rw, y0: p.y - rw * 0.5 - tall * this.z * ISO_ELEV, x1: p.x + rw, y1: p.y + rw * 0.55 };
  }
}
