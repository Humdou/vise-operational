# Bâtiments Coalition 2045

Les 19 bâtiments du jeu utilisent exclusivement les sprites raster de ce dossier.
`manifest.json` décrit leurs ancres, leur hauteur, les panneaux recolorés par équipe,
les effets animés, les portes et les modules rotatifs des défenses.

Les PNG finaux sont en isométrie orthographique 2:1, sans sol ni ombre intégrée.
Le moteur génère les ombres selon la carte et compose les couleurs des 32 équipes.

Le script de production attend des sources chroma locales dans `sources/`
(intermédiaires non versionnés), puis régénère les PNG alpha et le manifeste :

```bash
python3 scripts/process-building-assets.py
```

Validation :

```bash
npm run validate:buildings
```

La route `/buildings` affiche la planche QA avec sélection du biome, de l’équipe,
lecture éloignée et silhouettes noires.
