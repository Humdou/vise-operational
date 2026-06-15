// Types partagés du multijoueur : salons, joueurs, messages réseau.
// Tout ce qui transite sur le réseau est sérialisable en JSON.
import type { MapSizeId, ThemeId, Difficulty } from '../game/data';

export interface NetIdentity {
  id: string;      // uid auth (Supabase) ou id local persistant
  pseudo: string;
}

// Paramètres choisis par l'hôte dans le salon.
export interface LobbySettings {
  name: string;
  sizeId: MapSizeId;
  theme: ThemeId;
  totalSlots: number;        // 2 | 3 | 4 | 8 | 16
  difficulty: Difficulty;    // difficulté des IA de remplissage
  fillAI: boolean;           // true = places vides remplies par des IA
  dayNight: boolean;
}

export interface LobbyMember {
  id: string;
  pseudo: string;
  ready: boolean;
  isHost: boolean;
}

// État du salon, diffusé par l'hôte (source de vérité avant lancement).
export interface LobbyState {
  code: string;
  hostId: string;
  settings: LobbySettings;
  members: LobbyMember[];
}

// Une entrée de l'annuaire public des salons.
export interface LobbyListing {
  code: string;
  name: string;
  host: string;
  players: number;
  totalSlots: number;
  fillAI: boolean;
}

// Slot d'une partie lancée : humain (uid) ou IA.
export interface GameSlot {
  player: number;            // index joueur dans la simulation
  kind: 'human' | 'ai';
  uid?: string;
  pseudo: string;
}

// Message de lancement diffusé par l'hôte : tout ce qu'il faut pour créer
// une simulation IDENTIQUE sur chaque client.
export interface LaunchPayload {
  seed: number;
  sizeId: MapSizeId;
  theme: ThemeId;
  difficulty: Difficulty;
  dayNight: boolean;
  slots: GameSlot[];
}

export interface ChatMessage {
  from: string;              // pseudo
  fromId: string;
  text: string;
  at: number;                // epoch ms
  to?: string;               // uid destinataire => message privé
}
