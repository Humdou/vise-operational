// Coordinateur réseau « host-authoritative + prédiction client ».
//
// Remplace le lockstep. Principe :
//  - HÔTE : seule simulation autoritative. Applique ses propres commandes ET
//    celles reçues des clients immédiatement, fait tourner l'IA, et diffuse un
//    SNAPSHOT d'état périodique (≈ 6 Hz). Aucune attente réseau → fluide.
//  - CLIENT : applique SES propres commandes localement IMMÉDIATEMENT
//    (prédiction → ressenti < frame), les envoie à l'hôte, et fait tourner sa
//    propre simulation pour prédire le reste. À chaque snapshot reçu, il se
//    cale sur l'état autoritatif puis REREJOUE ses commandes non encore
//    confirmées (pour que ses constructions prédites ne clignotent pas).
//
// Détermisme strict NON requis : le snapshot est la vérité. Beaucoup plus
// robuste à la latence/gigue de Supabase que le lockstep.
import { Game } from '../game/engine';
import { applyCommand, Cmd } from '../game/commands';
import type { Transport } from './transport';
import type { GameSlot } from './types';

export const SIM_DT = 0.04;          // 25 Hz de simulation (inchangé)
const SNAPSHOT_MS = 160;             // l'hôte diffuse l'état ~6×/s

interface CmdMsg { c: Cmd; seq: number; }
interface SnapMsg { s: ReturnType<Game['serialize']>; ack: Record<number, number>; }

export class NetGame {
  private unsubs: (() => void)[] = [];
  private seq = 0;
  private pendingLocal: { seq: number; c: Cmd }[] = [];   // client : commandes non confirmées
  private ackByPlayer: Record<number, number> = {};        // hôte : dernier seq appliqué par joueur
  private lastSnapWall = 0;          // hôte : dernière diffusion ; client : dernière réception
  private gotSnapshot = false;       // client : a reçu au moins un snapshot
  private uidToPlayer = new Map<string, number>();
  private lost = new Set<number>();
  onPeerLost: ((player: number) => void) | null = null;

  constructor(
    private game: Game,
    private transport: Transport,
    readonly isHost: boolean,
    readonly localPlayer: number,
    private slots: GameSlot[],
  ) {
    for (const s of slots) if (s.kind === 'human' && s.uid) this.uidToPlayer.set(s.uid, s.player);

    if (isHost) {
      // commandes des clients : appliquées immédiatement (autoritatif)
      this.unsubs.push(transport.on('cmd', (d, from) => {
        const p = this.uidToPlayer.get(from);
        const m = d as CmdMsg;
        if (p === undefined || !m || !m.c) return;
        applyCommand(this.game, p, m.c);
        this.ackByPlayer[p] = m.seq;
      }));
      // un humain disparu → l'hôte le confie à une IA (reflété par les snapshots)
      transport.onPresence(members => {
        const present = new Set(members.map(m => m.id));
        for (const s of slots) {
          if (s.kind === 'human' && s.uid && !present.has(s.uid) && !this.lost.has(s.player)) {
            this.lost.add(s.player);
            this.onPeerLost?.(s.player);
          }
        }
      });
    } else {
      // client : reçoit les snapshots autoritatifs
      this.unsubs.push(transport.on('snap', d => {
        const m = d as SnapMsg;
        if (!m || !m.s) return;
        this.game.applySnapshot(m.s);
        const ack = m.ack[this.localPlayer] ?? -1;
        // rejoue les commandes locales que l'hôte n'a pas encore confirmées
        this.pendingLocal = this.pendingLocal.filter(p => p.seq > ack);
        for (const p of this.pendingLocal) applyCommand(this.game, this.localPlayer, p.c);
        this.gotSnapshot = true;
        this.lastSnapWall = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      }));
    }
  }

  /** Émet une commande locale : application IMMÉDIATE (prédiction) + envoi. */
  issue(c: Cmd) {
    // appliquée tout de suite sur la simulation locale → ressenti instantané
    applyCommand(this.game, this.localPlayer, c);
    if (this.isHost) {
      this.ackByPlayer[this.localPlayer] = ++this.seq;
    } else {
      const seq = ++this.seq;
      this.pendingLocal.push({ seq, c });
      this.transport.send('cmd', { c, seq } satisfies CmdMsg);
    }
  }

  /** Commande système (ex. aitakeover) appliquée par l'hôte. */
  issueSystem(c: Cmd, player: number) {
    if (this.isHost) applyCommand(this.game, player, c);
  }

  /** Hôte : diffuse un snapshot si l'intervalle est écoulé. Appelée chaque frame. */
  pump(nowMs: number) {
    if (!this.isHost) return;
    if (nowMs - this.lastSnapWall < SNAPSHOT_MS) return;
    this.lastSnapWall = nowMs;
    this.transport.send('snap', { s: this.game.serialize(), ack: { ...this.ackByPlayer } } satisfies SnapMsg);
  }

  /** Client : ms depuis le dernier snapshot reçu (0 si jamais reçu). */
  msSinceSnapshot(nowMs: number): number {
    return this.gotSnapshot ? nowMs - this.lastSnapWall : 0;
  }

  dispose() {
    for (const u of this.unsubs) u();
  }
}
