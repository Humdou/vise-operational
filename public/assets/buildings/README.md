# Sprites PNG des bâtiments (optionnels)

Déposez ici `<type>.png` pour remplacer le sprite procédural d'un bâtiment
(types : hq, power, power2, refinery, refinery2, barracks, barracks2, factory,
factory2, radar, radarcenter, airport, helipad, turret, atgun, aa, tech,
depot, lab).

Format attendu :
- isométrie diamant 2:1 (mêmes angles que le jeu), bâtiment SEUL, fond
  transparent, pas de décor ni d'unités ;
- ombre portée intégrée (vers le bas-droite) ou aucune ;
- cadrage au plus près : le bas du PNG = coin sud (avant) de l'emprise.

Métadonnées optionnelles `<type>.json` :
```json
{ "pxPerTile": 44, "ax": 120, "ay": 180 }
```
`pxPerTile` = pixels par tuile (demi-largeur du losange d'une tuile) ;
`(ax, ay)` = point du PNG posé sur le centre de l'emprise au sol.
Sans JSON : `pxPerTile = largeur/(w+h)`, `ax = largeur/2`,
`ay = hauteur − (w+h)·pxPerTile/4`.

Le moteur garde ses jauges/sélection/chantier ; la couleur d'équipe n'est pas
appliquée aux PNG (prévoir des marquages neutres ou une variante par équipe).
