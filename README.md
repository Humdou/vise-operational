# Opération Minerai — RTS web stratégique

RTS minimaliste inspiré de l'ADN de Command & Conquer: Red Alert : construction de base,
récolte de minerai, brouillard de guerre, combats lisibles et IA honnête (sans triche,
soumise au même brouillard que vous). 100 % côté client, jouable sur PC et mobile.

## Lancer

```bash
npm install
npm run dev
```

Puis ouvrir http://localhost:3000.

Astuce : `http://localhost:3000/?autostart` lance directement une partie avec les
paramètres par défaut.

## Déployer sur Vercel

Le projet est une application Next.js statique sans backend : importez le dépôt dans
Vercel (ou `npx vercel`), aucune configuration nécessaire.

## Jouer

- **But** : détruisez le QG de chaque ennemi. Si votre QG tombe, vous perdez.
- **Départ** : 1 QG et 1000 minerai. Construisez une centrale, puis une raffinerie
  (livrée avec un récolteur), puis explorez et sécurisez les gisements.
- **Énergie** : si la consommation dépasse la production, défenses et production
  ralentissent.
- **Économie** : les gisements s'épuisent et se régénèrent très lentement ; les plus
  riches sont au centre, contestés. Les récolteurs changent automatiquement de
  gisement quand le leur s'épuise. Attaquer les récolteurs ennemis est rentable.
- **Minerai rare** (rouge, ~15 % des gisements) : valeur triple — des points de
  conflit majeurs. Visible en rouge vif sur la mini-carte.
- **Bâtiments avancés** : le Dépôt logistique booste les raffineries proches
  (+15 % de revenus, déchargement accéléré) ; le Centre radar avancé étend
  fortement la vision. L'Avion radar (aéroport) fait de la reconnaissance rapide
  non armée et rentre seul à sa base.
- **Niveau 2** : le Laboratoire avancé (1500) débloque la Caserne T2 (fusilier
  d'élite, lance-roquettes lourd, kamikaze), l'Usine T2 (tank lourd, chasseur de
  chars, artillerie lourde, véhicule radar), la Centrale T2 (+250 énergie) et la
  Raffinerie T2 (+30 % de revenus, déchargement rapide). Le T1 reste pertinent en
  début de partie et pour les expansions rapides.
- **Cartes spéciales** : France (vaste et ouverte, 8 joueurs) et Italie (longue
  et étroite, 4 joueurs), inspirées des formes réelles des pays, entourées de mer.

### Contrôles PC

| Action | Commande |
|---|---|
| Sélection / rectangle | clic gauche / glisser |
| Même type à l'écran | double-clic |
| Déplacer · attaquer · récolter · réparer | clic droit (contextuel) |
| Attaque-déplacement | `A` puis clic |
| Stop | `S` |
| Groupes | `Ctrl+1…9` puis `1…9` |
| Zoom | molette |
| Caméra | bords de l'écran, flèches, clic molette, mini-carte |
| Dernière alerte | `Espace` |

### Contrôles mobile

Tap = sélection puis ordre contextuel · glisser = caméra · pincer = zoom ·
bouton « Sélection multiple » pour le rectangle.

## Tests headless

```bash
npx tsx scripts/simtest.ts    # IA contre IA : économie, production, combat
npx tsx scripts/simtest2.ts   # difficulté facile + très grande carte (performance)
```

URL de test visuel : `http://localhost:3000/?autostart&demo` fait apparaître une
unité de chaque type près du QG.

## Architecture

```
src/game/
  data.ts     définitions unités / bâtiments / améliorations / équilibrage
  map.ts      génération procédurale de cartes équilibrées
  path.ts     A* 8 directions + lignes de vue / de tir
  engine.ts   simulation : ordres, économie, combat, brouillard, victoire
  ai.ts       IA : économie, expansion, défense, attaque, retraite, exploration
  render.ts   rendu Canvas 2D + mini-carte
  input.ts    contrôles souris / clavier / tactile
  audio.ts    sons synthétisés WebAudio
src/components/GameApp.tsx   menu, HUD, écran de fin
```
