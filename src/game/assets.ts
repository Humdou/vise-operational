// Manifest d'assets bâtiments : permet de remplacer chaque sprite procédural
// par un PNG isométrique « 1:1 » déposé dans public/assets/buildings/.
//
// Convention par bâtiment <type> :
//   /assets/buildings/<type>.png          — le sprite (fond transparent,
//                                           bâtiment seul, angle diamant 2:1,
//                                           ombre intégrée ou non)
//   /assets/buildings/<type>.json (option) — métadonnées :
//     { "pxPerTile": 44,   // px par tuile (demi-largeur du losange)
//       "ax": 120,          // point du PNG posé sur le CENTRE de l'emprise au sol
//       "ay": 180 }
//
// Sans JSON, on suppose un sprite cadré au plus près d'une emprise w×h :
//   pxPerTile = largeur / (w + h) ; ax = largeur / 2 ;
//   ay = hauteur − (w + h) · pxPerTile / 4  (le bas du PNG = coin sud).
//
// Le chargement est paresseux et silencieux : pas de PNG → bakery procédurale.
import { BUILDINGS, type BuildingTypeId } from './data';

export interface BuildingAsset {
  img: HTMLImageElement;
  pxPerTile: number;
  ax: number;
  ay: number;
}

const cache = new Map<string, BuildingAsset | 'missing' | 'loading'>();

export function getBuildingAsset(type: BuildingTypeId): BuildingAsset | null {
  const state = cache.get(type);
  if (state && state !== 'loading' && state !== 'missing') return state;
  if (state) return null;
  cache.set(type, 'loading');
  const img = new Image();
  img.onload = async () => {
    const def = BUILDINGS[type];
    let pxPerTile = img.width / (def.w + def.h);
    let ax = img.width / 2;
    let ay = img.height - ((def.w + def.h) * pxPerTile) / 4;
    try {
      const r = await fetch(`/assets/buildings/${type}.json`, { cache: 'force-cache' });
      if (r.ok) {
        const m = (await r.json()) as Partial<BuildingAsset>;
        if (typeof m.pxPerTile === 'number') pxPerTile = m.pxPerTile;
        if (typeof m.ax === 'number') ax = m.ax;
        if (typeof m.ay === 'number') ay = m.ay;
      }
    } catch { /* pas de méta : défauts */ }
    cache.set(type, { img, pxPerTile, ax, ay });
  };
  img.onerror = () => { cache.set(type, 'missing'); };
  img.src = `/assets/buildings/${type}.png`;
  return null;
}
