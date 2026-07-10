# Coalition 2045 — prompts de production

Les images finales ont été générées avec le générateur d'images intégré, puis
détourées localement depuis un fond chroma `#ff00ff`. La planche de style
[`coalition-2045-style-board.png`](./coalition-2045-style-board.png) a servi de
référence commune aux variantes.

## Prompt directeur

> Planche conceptuelle d'une famille complète de bâtiments pour un RTS
> militaire moderne « Coalition 2045 », vue isométrique 2.5D cohérente, caméra
> orthographique, réalisme stylisé haut de gamme. Architecture industrielle
> crédible et construisible : béton clair, composites sable et olive désaturés,
> graphite, acier technique, verre bleu fumé, petits accents orange. Volumes
> nets, détails fonctionnels lisibles, silhouette forte à petite taille, lumière
> venant du haut-gauche. Aucune unité, aucun personnage, aucun texte, aucun logo,
> aucun décor, aucune ombre portée intégrée. Tous les bâtiments appartiennent à
> la même faction et sont présentés sur un fond chroma magenta uniforme #ff00ff.

## Déclinaisons par asset

Chaque génération reprend le prompt directeur et ajoute la définition suivante :

- `hq` : bunker pentagonal, pont de commandement asymétrique, flèche tripode.
- `power` : turbine compacte avec admission diagonale et radiateurs en V.
- `power2` : réacteur horizontal sous anneau structurel, ailettes techniques.
- `refinery` : voie de déchargement, broyeur angulaire, convoyeur et tambour.
- `refinery2` : double ligne de traitement lourde et tambours horizontaux.
- `barracks` : cour militaire ouverte en U, accès blindé et volumes bas.
- `barracks2` : deux ailes reliées par une passerelle de contrôle surélevée.
- `factory` : baie d'assemblage ouverte sous portiques en porte-à-faux.
- `factory2` : carrousel hexagonal ouvert pour blindés lourds.
- `radar` : grand panneau AESA rectangulaire sur trépied mécanique.
- `radarcenter` : trois lames réseau verticales autour d'un noyau technique.
- `airport` : deux abris triangulaires et tour de contrôle élancée.
- `helipad` : plateforme hexagonale surélevée, services visibles sous le pont.
- `tech` : centre tactique semi-enterré en forme de coin.
- `lab` : campus asymétrique, chambre d'essai horizontale et portique robotisé.
- `depot` : cour logistique ouverte, conteneurs modulaires et grue cantilever.
- `turret` : station blindée double mitrailleuse, embase et arme séparées.
- `atgun` : casemate triangulaire antichar, embase et canon séparés.
- `aa` : lanceur antiaérien à quatre missiles en carré 2×2 et radar plan,
  embase et tête séparées.

Les 19 sprites de bâtiments et les 3 armes pivotantes finales sont livrés dans
`public/assets/buildings/`. Le manifeste central contient leurs ancres, effets,
panneaux d'équipe et montages de tourelle.
