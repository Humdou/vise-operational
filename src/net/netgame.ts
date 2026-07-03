// Coordinateur réseau « host-authoritative + prédiction client ».
//
// Principe (architecture classique client-serveur, l'hôte joue le serveur) :
//  - HÔTE : seule simulation autoritative. Applique ses propres commandes ET
//    celles reçues des clients, fait tourner l'IA, et diffuse un SNAPSHOT
//    d'état complet périodique. Aucune attente réseau → jamais bloqué.
//  - CLIENT : applique SES propres commandes localement IMMÉDIATEMENT
//    (prédiction → ressenti instantané), les envoie à l'hôte, et fait tourner
//    sa propre simulation pour prédire le reste. À chaque snapshot reçu, il se
//    cale sur l'état autoritatif puis REREJOUE ses commandes non confirmées.
//
// Fiabilité (le transport est du « fire-and-forget », des messages PEUVENT
// se perdre) :
//  - commandes client→hôte : chaque envoi contient TOUTES les commandes non
//    acquittées (+ renvoi périodique). L'hôte déduplique par numéro de
//    séquence : une commande est appliquée exactement une fois, dans l'ordre.
//  - snapshots hôte→clients : l'état complet est auto-réparant — un snapshot
//    perdu est remplacé par le suivant. Un client resté trop longtemps sans
//    snapshot en redemande un explicitement ('needsnap').
//
// Détermisme strict NON requis : le snapshot est la vérité.
import { Game } from '../game/engine';
import { applyCommand, Cmd } from '../game/commands';
import type { Transport } from './transport';
import type { GameSlot } from './types';
import { mpDebug } from './debug';

export const SIM_DT = 0.04;          // 25 Hz de simulation (inchangé)

// Cadence des snapshots : rapide sur petites parties, étirée quand l'état
// grossit pour rester sous les limites de débit/taille du transport (Supabase
// Realtime rejette les gros messages et étrangle les canaux trop bavards).
const SNAP_MS_MIN = 160;
const SNAP_MS_MAX = 450;
const SNAP_BYTES_PER_MS = 250;       // ~48 Ko → 192 ms ; ~112 Ko → 450 ms

const RESEND_MS = 250;               // client : renvoi des commandes non acquittées
const RESYNC_AFTER_MS = 1500;        // client : demande un snapshot après ce silence
const RESYNC_RETRY_MS = 1000;        // ... puis redemande au plus 1×/s
const PEER_GRACE_MS = 10_000;        // hôte : délai avant de confier un absent à l'IA
const MAX_OUTBOX = 300;              // garde-fou mémoire si l'hôte ne répond plus

// Les entités créées par prédiction côté client reçoivent des ids très
// au-dessus de ceux de l'hôte : aucune collision possible avec les ids
// autoritatifs qui arrivent au snapshot suivant.
const PREDICTED_ID_OFFSET = 1_000_000;

interface CmdsMsg { list: { seq: number; c: Cmd }[]; }
interface SnapMsg { s: ReturnType<Game['serialize']>; ack: Record<number, number>; n: number; }

export class NetGame {
  private unsubs: (() => void)[] = [];
  private seq = 0;
  private outbox: { seq: number; c: Cmd }[] = [];        // client : commandes non confirmées
  private lastSendWall = 0;                              // client : dernier envoi de commandes
  private lastResyncWall = 0;                            // client : dernier 'needsnap'
  private lastSeqByPlayer: Record<number, number> = {};  // hôte : dernier seq appliqué par joueur
  private snapN = 0;                                     // hôte : numéro de snapshot croissant
  private lastSnapN = -1;                                // client : dernier snapshot appliqué
  private lastSnapWall = 0;          // hôte : dernière diffusion ; client : dernière réception
  private forceSnap = false;         // hôte : un client a demandé un resync
  private gotSnapshot = false;       // client : a reçu au moins un snapshot
  private uidToPlayer = new Map<string, number>();
  private missingSince = new Map<number, number>();      // hôte : joueur → date de disparition
  private lost = new Set<number>();                      // hôte : joueurs confiés à l'IA
  onPeerLost: ((player: number) => void) | null = null;
  onPeerBack: ((player: number) => void) | null = null;

  constructor(
    private game: Game,
    private transport: Transport,
    readonly isHost: boolean,
    readonly localPlayer: number,
    private slots: GameSlot[],
  ) {
    for (const s of slots) if (s.kind === 'human' && s.uid) this.uidToPlayer.set(s.uid, s.player);

    if (isHost) {
      // commandes des clients : dédupliquées par seq, appliquées dans l'ordre
      this.unsubs.push(transport.on('cmds', (d, from) => {
        const p = this.uidToPlayer.get(from);
        const m = d as CmdsMsg;
        if (p === undefined || !m || !Array.isArray(m.list)) return;
        const last = this.lastSeqByPlayer[p] ?? -1;
        const fresh = m.list.filter(e => e && e.c && e.seq > last).sort((a, b) => a.seq - b.seq);
        for (const e of fresh) {
          applyCommand(this.game, p, e.c);
          this.lastSeqByPlayer[p] = e.seq;
        }
      }));
      // un client resté sans snapshot en redemande un (reprise après coupure)
      this.unsubs.push(transport.on('needsnap', () => { this.forceSnap = true; }));
      // présence : une disparition n'est actée qu'après un délai de grâce
      // (voir pump) ; un retour avant/après annule ou rend le contrôle.
      transport.onPresence(members => {
        const present = new Set(members.map(m => m.id));
        for (const s of slots) {
          if (s.kind !== 'human' || !s.uid) continue;
          if (present.has(s.uid)) {
            this.missingSince.delete(s.player);
            if (this.lost.delete(s.player)) {
              mpDebug('netgame.peerBack', { player: s.player, uid: s.uid });
              this.onPeerBack?.(s.player);
            }
          } else if (s.uid !== transport.self && !this.lost.has(s.player) && !this.missingSince.has(s.player)) {
            this.missingSince.set(s.player, this.clock);
          }
        }
      });
    } else {
      // client : reçoit les snapshots autoritatifs
      this.unsubs.push(transport.on('snap', d => {
        const m = d as SnapMsg;
        if (!m || !m.s) return;
        if (typeof m.n === 'number' && m.n <= this.lastSnapN) return; // en retard → ignoré
        this.lastSnapN = m.n ?? this.lastSnapN;
        this.game.applySnapshot(m.s);
        // ids de prédiction hors de la plage autoritaire (anti-collision)
        this.game.nextId += PREDICTED_ID_OFFSET;
        const ack = m.ack[this.localPlayer] ?? -1;
        // rejoue les commandes locales que l'hôte n'a pas encore confirmées
        this.outbox = this.outbox.filter(p => p.seq > ack);
        for (const p of this.outbox) applyCommand(this.game, this.localPlayer, p.c);
        this.gotSnapshot = true;
        this.lastSnapWall = this.clock;
      }));
    }
  }

  // Horloge unique : la valeur passée à pump() par la boucle de jeu. Les
  // événements réseau (reçus entre deux frames) datent au plus d'une frame —
  // et les tests headless peuvent piloter un temps virtuel cohérent.
  private clock = 0;

  /** Émet une commande locale : application IMMÉDIATE (prédiction) + envoi fiable. */
  issue(c: Cmd) {
    // appliquée tout de suite sur la simulation locale → ressenti instantané
    applyCommand(this.game, this.localPlayer, c);
    if (this.isHost) {
      this.lastSeqByPlayer[this.localPlayer] = ++this.seq;
    } else {
      this.outbox.push({ seq: ++this.seq, c });
      if (this.outbox.length > MAX_OUTBOX) this.outbox.splice(0, this.outbox.length - MAX_OUTBOX);
      this.sendCmds();
    }
  }

  /** Commande système (ex. aitakeover) appliquée par l'hôte. */
  issueSystem(c: Cmd, player: number) {
    if (this.isHost) applyCommand(this.game, player, c);
  }

  private sendCmds() {
    this.lastSendWall = this.clock;
    // toujours TOUTES les commandes non acquittées : la perte d'un message
    // est réparée par l'envoi suivant, l'hôte déduplique par seq.
    this.transport.send('cmds', { list: this.outbox } satisfies CmdsMsg);
  }

  /** Cadence adaptative : étire l'intervalle quand l'état devient volumineux. */
  private snapIntervalMs(): number {
    let units = 0, buildings = 0;
    for (const u of this.game.units) if (!u.dead) units++;
    for (const b of this.game.buildings) if (!b.dead) buildings++;
    const estBytes = 200 + units * 110 + buildings * 150 + this.game.nodes.length * 14;
    return Math.min(SNAP_MS_MAX, Math.max(SNAP_MS_MIN, estBytes / SNAP_BYTES_PER_MS));
  }

  /** Appelée chaque frame (hôte ET client). */
  pump(nowMs: number) {
    this.clock = nowMs;
    if (this.isHost) {
      // délai de grâce des absents : évite qu'un simple changement d'onglet
      // ou une micro-coupure ne confie une base vivante à l'IA
      for (const [player, since] of this.missingSince) {
        if (nowMs - since < PEER_GRACE_MS) continue;
        this.missingSince.delete(player);
        this.lost.add(player);
        this.onPeerLost?.(player);
      }
      const due = this.forceSnap
        ? nowMs - this.lastSnapWall >= 80        // resync demandé : réponse quasi immédiate
        : nowMs - this.lastSnapWall >= this.snapIntervalMs();
      if (!due) return;
      this.forceSnap = false;
      this.lastSnapWall = nowMs;
      this.snapN++;
      this.transport.send('snap', {
        s: this.game.serialize(), ack: { ...this.lastSeqByPlayer }, n: this.snapN,
      } satisfies SnapMsg);
    } else {
      // renvoi périodique des commandes non confirmées (fiabilité)
      if (this.outbox.length > 0 && nowMs - this.lastSendWall >= RESEND_MS) this.sendCmds();
      // silence prolongé de l'hôte : on redemande explicitement un snapshot
      if (this.gotSnapshot && nowMs - this.lastSnapWall >= RESYNC_AFTER_MS
        && nowMs - this.lastResyncWall >= RESYNC_RETRY_MS) {
        this.lastResyncWall = nowMs;
        this.transport.send('needsnap', {});
      }
    }
  }

  /** Client : ms depuis le dernier snapshot reçu (0 si jamais reçu). */
  msSinceSnapshot(nowMs: number): number {
    return this.gotSnapshot ? nowMs - this.lastSnapWall : 0;
  }

  dispose() {
    for (const u of this.unsubs) u();
  }
}
