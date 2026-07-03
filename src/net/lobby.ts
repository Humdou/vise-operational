// Client de salon : création, annuaire, adhésion, présence, paramètres,
// chat (global + privé) et lancement. L'hôte est la source de vérité de
// l'état du salon ; les invités le reçoivent et l'affichent.
import { Transport, LocalTransport } from './transport';
import { SupabaseTransport, sbListLobbies, sbUpsertLobby, sbDeleteLobby } from './supabase';
import { netMode } from './auth';
import type { NetIdentity, LobbySettings, LobbyState, LobbyListing, LobbyMember, LaunchPayload, GameSlot, ChatMessage } from './types';
import { MAP_SIZES, PLAYER_NAMES } from '../game/data';
import { mpDebug } from './debug';

export function makeTransport(selfId: string): Transport {
  return netMode() === 'local' ? new LocalTransport(selfId) : new SupabaseTransport(selfId);
}

function randomCode(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

// ---------------------------------------------------------------- annuaire

export async function listLobbies(): Promise<LobbyListing[]> {
  if (netMode() === 'supabase') return sbListLobbies();
  // mode local : on interroge les hôtes présents sur un canal d'annonce
  return new Promise(resolve => {
    const bc = new BroadcastChannel('vo-lobbies');
    const found = new Map<string, LobbyListing>();
    bc.onmessage = ev => {
      const m = ev.data as { kind: string; listing?: LobbyListing };
      if (m?.kind === 'listing' && m.listing) found.set(m.listing.code, m.listing);
    };
    bc.postMessage({ kind: 'query' });
    setTimeout(() => { bc.close(); resolve([...found.values()]); }, 700);
  });
}

// ------------------------------------------------------------------ client

export class LobbyClient {
  state: LobbyState;
  chat: ChatMessage[] = [];
  readonly isHost: boolean;
  onState: (() => void) | null = null;
  onChat: ((m: ChatMessage) => void) | null = null;
  onLaunch: ((p: LaunchPayload) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  private joinOrder = new Map<string, number>();
  private ready = new Map<string, boolean>();
  private joinSeq = 0;
  private unsubs: (() => void)[] = [];
  private announcer: BroadcastChannel | null = null;
  private dirTimer: number | null = null;
  private launchPayload: LaunchPayload | null = null;
  launched = false;

  private constructor(
    readonly transport: Transport,
    readonly me: NetIdentity,
    isHost: boolean,
    state: LobbyState,
  ) {
    this.isHost = isHost;
    this.state = state;
  }

  // ---- création (hôte)
  static async host(me: NetIdentity, settings: LobbySettings): Promise<LobbyClient> {
    const code = randomCode();
    const t = makeTransport(me.id);
    t.setMeta({ pseudo: me.pseudo });
    await t.join(code);
    const state: LobbyState = {
      code, hostId: me.id, settings,
      members: [{ id: me.id, pseudo: me.pseudo, ready: true, isHost: true }],
    };
    const c = new LobbyClient(t, me, true, state);
    c.joinOrder.set(me.id, c.joinSeq++);
    c.ready.set(me.id, true);
    c.wire();
    c.publishDirectory();
    return c;
  }

  // ---- adhésion par code (invité)
  static async join(me: NetIdentity, code: string): Promise<LobbyClient> {
    const t = makeTransport(me.id);
    t.setMeta({ pseudo: me.pseudo });
    await t.join(code.toUpperCase());
    const placeholder: LobbyState = {
      code: code.toUpperCase(), hostId: '', members: [],
      settings: { name: '…', sizeId: 'medium', theme: 'temperate', totalSlots: 4, difficulty: 'normal', fillAI: true, dayNight: true },
    };
    const c = new LobbyClient(t, me, false, placeholder);
    c.wire();
    // attendre le premier état diffusé par l'hôte
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Salon introuvable (aucune réponse de l’hôte).')), 5000);
      const prev = c.onState;
      c.onState = () => { clearTimeout(to); c.onState = prev; prev?.(); resolve(); };
      t.send('hello_host', {});
    });
    return c;
  }

  private wire() {
    const t = this.transport;
    this.unsubs.push(t.on('lobby_state', d => {
      if (this.isHost) return;
      this.state = d as LobbyState;
      if (!this.state.members.some(m => m.id === this.me.id) && this.state.members.length >= this.state.settings.totalSlots) {
        this.onClosed?.('Salon complet.');
        this.leave();
        return;
      }
      this.onState?.();
    }));
    this.unsubs.push(t.on('chat', d => this.pushChat(d as ChatMessage)));
    this.unsubs.push(t.on('launch', d => {
      if (this.launched) return;   // le lancement est re-diffusé (fiabilité) : dédupliquer
      this.launched = true;
      this.onLaunch?.(d as LaunchPayload);
    }));
    this.unsubs.push(t.on('lobby_closed', () => {
      if (!this.isHost && !this.launched) this.onClosed?.('L’hôte a fermé le salon.');
    }));

    if (this.isHost) {
      this.unsubs.push(t.on('hello_host', () => {
        // un invité qui (re)demande l'état après le lancement a probablement
        // raté le message 'launch' : on le lui renvoie au lieu de le laisser
        // bloqué dans le salon.
        if (this.launched && this.launchPayload) this.transport.send('launch', this.launchPayload);
        else this.broadcastState();
      }));
      this.unsubs.push(t.on('set_ready', (d, from) => {
        this.ready.set(from, Boolean((d as { ready: boolean }).ready));
        this.rebuildMembers();
      }));
      t.onPresence(members => {
        for (const m of members) {
          if (!this.joinOrder.has(m.id)) this.joinOrder.set(m.id, this.joinSeq++);
        }
        const present = new Set(members.map(m => m.id));
        for (const id of this.joinOrder.keys()) {
          if (!present.has(id) && id !== this.me.id) { this.joinOrder.delete(id); this.ready.delete(id); }
        }
        this.presencePseudos = new Map(members.map(m => [m.id, String(m.meta?.pseudo ?? 'Joueur')]));
        this.rebuildMembers();
      });
    } else {
      t.onPresence(() => { /* l'état vient de l'hôte */ });
    }
  }

  private presencePseudos = new Map<string, string>();

  private rebuildMembers() {
    if (!this.isHost) return;
    const ids = [...this.joinOrder.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    const max = this.state.settings.totalSlots;
    const members: LobbyMember[] = [];
    for (const id of ids.slice(0, max)) {
      members.push({
        id,
        pseudo: id === this.me.id ? this.me.pseudo : this.presencePseudos.get(id) ?? 'Joueur',
        ready: id === this.me.id ? true : this.ready.get(id) ?? false,
        isHost: id === this.me.id,
      });
    }
    this.state = { ...this.state, members };
    this.broadcastState();
    this.publishDirectory();
    this.onState?.();
  }

  private broadcastState() {
    if (this.isHost) this.transport.send('lobby_state', this.state);
  }

  // ---- annuaire (hôte uniquement)
  private publishDirectory() {
    if (!this.isHost || this.launched) return;
    const listing: LobbyListing = {
      code: this.state.code,
      name: this.state.settings.name,
      host: this.me.pseudo,
      players: this.state.members.length,
      totalSlots: this.state.settings.totalSlots,
      fillAI: this.state.settings.fillAI,
    };
    if (netMode() === 'supabase') {
      void sbUpsertLobby({ ...listing, hostId: this.me.id, status: 'open' }).catch(() => undefined);
      if (this.dirTimer === null) {
        this.dirTimer = window.setInterval(() => this.publishDirectory(), 45_000);
      }
    } else {
      if (!this.announcer) {
        this.announcer = new BroadcastChannel('vo-lobbies');
        this.announcer.onmessage = ev => {
          if ((ev.data as { kind: string })?.kind === 'query' && !this.launched) {
            this.announcer?.postMessage({ kind: 'listing', listing: this.currentListing() });
          }
        };
      }
      this.announcer.postMessage({ kind: 'listing', listing });
    }
  }

  private currentListing(): LobbyListing {
    return {
      code: this.state.code,
      name: this.state.settings.name,
      host: this.me.pseudo,
      players: this.state.members.length,
      totalSlots: this.state.settings.totalSlots,
      fillAI: this.state.settings.fillAI,
    };
  }

  // ---- actions
  setSettings(s: Partial<LobbySettings>) {
    if (!this.isHost) return;
    const next = { ...this.state.settings, ...s };
    // règle : le nombre de joueurs doit rester compatible avec la carte
    const max = MAP_SIZES[next.sizeId].maxPlayers;
    if (next.totalSlots > max) next.totalSlots = max;
    this.state = { ...this.state, settings: next };
    this.rebuildMembers();
  }

  setReady(ready: boolean) {
    if (this.isHost) return;
    this.transport.send('set_ready', { ready });
  }

  sendChat(text: string, to?: string) {
    const msg: ChatMessage = { from: this.me.pseudo, fromId: this.me.id, text, at: Date.now(), to };
    this.transport.send('chat', msg);
    this.pushChat(msg); // affichage local immédiat
  }

  private pushChat(m: ChatMessage) {
    // un message privé n'est conservé que par l'expéditeur et le destinataire
    if (m.to && m.to !== this.me.id && m.fromId !== this.me.id) return;
    this.chat.push(m);
    if (this.chat.length > 200) this.chat.shift();
    this.onChat?.(m);
  }

  /** Lance la partie (hôte). Retourne une erreur lisible si impossible. */
  launch(): string | null {
    if (!this.isHost) return 'Seul l’hôte peut lancer.';
    const s = this.state.settings;
    const humans = this.state.members;
    if (humans.length < 1) return 'Salon vide.';
    if (!s.fillAI && humans.length < s.totalSlots) {
      return `Il manque ${s.totalSlots - humans.length} joueur(s) — salon sans IA.`;
    }
    if (humans.length < 2 && !s.fillAI) return 'Au moins 2 joueurs sont nécessaires.';
    const notReady = humans.filter(m => !m.ready && !m.isHost);
    if (notReady.length > 0) return `En attente de : ${notReady.map(m => m.pseudo).join(', ')}`;

    const slots: GameSlot[] = humans.map((m, i) => ({ player: i, kind: 'human' as const, uid: m.id, pseudo: m.pseudo }));
    for (let i = humans.length; i < s.totalSlots; i++) {
      slots.push({ player: i, kind: 'ai', pseudo: `IA ${PLAYER_NAMES[i] ?? i + 1}` });
    }
    if (slots.length < 2) return 'Il faut au moins 2 participants (humains ou IA).';

    const payload: LaunchPayload = {
      seed: Math.floor(Math.random() * 1e9),
      sizeId: s.sizeId, theme: s.theme, difficulty: s.difficulty, dayNight: s.dayNight,
      slots,
    };
    mpDebug('lobby.launch', {
      source: 'LobbyClient.launch.beforeSend',
      hostUid: this.me.id,
      members: humans,
      slots,
      seed: payload.seed,
    });
    this.launched = true;
    this.launchPayload = payload;
    this.transport.send('launch', payload);
    // re-diffusions rapides : un 'launch' perdu laisserait un invité bloqué
    // dans le salon (les invités dédupliquent via leur drapeau `launched`)
    window.setTimeout(() => this.transport.send('launch', payload), 600);
    window.setTimeout(() => this.transport.send('launch', payload), 1800);
    mpDebug('lobby.launch.sent', {
      source: 'LobbyClient.launch.afterSend',
      hostUid: this.me.id,
      slots,
      seed: payload.seed,
    });
    if (netMode() === 'supabase') void sbDeleteLobby(this.state.code).catch(() => undefined);
    this.announcer?.close();
    this.announcer = null;
    mpDebug('lobby.launch.localOnLaunch', {
      source: 'LobbyClient.launch.beforeLocalOnLaunch',
      hostUid: this.me.id,
      slots,
      seed: payload.seed,
    });
    this.onLaunch?.(payload);
    return null;
  }

  leave() {
    if (this.isHost && !this.launched) {
      this.transport.send('lobby_closed', {});
      if (netMode() === 'supabase') void sbDeleteLobby(this.state.code).catch(() => undefined);
    }
    this.announcer?.close();
    this.announcer = null;
    if (this.dirTimer !== null) { clearInterval(this.dirTimer); this.dirTimer = null; }
    for (const u of this.unsubs) u();
    if (!this.launched) this.transport.leave();
  }
}
