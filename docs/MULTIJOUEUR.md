# Multijoueur — mise en service et architecture

## Mise en service (production)

1. Créer un projet sur https://supabase.com (offre gratuite suffisante).
2. SQL Editor → exécuter `supabase/schema.sql`.
3. Authentication → Providers → Email : activé (désactiver « Confirm email »
   pour des comptes immédiats, ou le laisser et confirmer par e-mail).
4. Variables d'environnement (local : `.env.local` ; Vercel : Settings →
   Environment Variables) :

       NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
       NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

5. Redéployer. L'onglet « Multijoueur en ligne » est actif.

Sans ces variables, le jeu reste 100 % fonctionnel en mode hors ligne.

## Mode test sans compte

`http://localhost:3000/?net=local` : multijoueur entre onglets du même
navigateur (BroadcastChannel). Identité par onglet, mêmes écrans, même
synchronisation — idéal pour valider salons, chat et lockstep.

## Architecture

- **Lockstep par relais de commandes** : la simulation (déterministe, RNG
  seedé unique, pas fixe de 40 ms) tourne sur chaque client. Les commandes
  joueur (`src/game/commands.ts`) sont envoyées à l'hôte qui scelle des
  « rounds » de 160 ms diffusés à tous (`src/net/sync.ts`). Un client
  n'exécute un round qu'après réception : tous les états restent identiques.
- **IA** : simulée localement par chaque client (déterministe), aucune
  donnée réseau. La difficulté vient des paramètres du salon.
- **Déconnexion en partie** : l'hôte scelle une commande `aitakeover` ;
  une IA reprend la base du joueur sur tous les clients.
- **Hôte déconnecté** : les rounds cessent, la partie se met en pause avec
  bandeau « Synchronisation… » (pas de migration d'hôte en v1).
- **Chat** : global + messages privés sur le même canal Realtime, hors
  simulation (aucun risque de désynchronisation).
- **Anti-triche léger** : `applyCommand` revalide la propriété des unités
  et bâtiments ; un client ne peut pas commander ce qui n'est pas à lui.
- **Détection de désync** : empreinte d'état comparée par l'hôte toutes les
  ~8 s (`stateHash`).
