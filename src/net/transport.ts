// Transport temps réel abstrait : la même interface sert au salon, au chat et
// à la synchronisation de la partie. Deux implémentations :
//  - LocalTransport (BroadcastChannel) : multijoueur local entre onglets du
//    même navigateur — zéro compte, sert aussi de banc de test (?net=local) ;
//  - SupabaseTransport (net/supabase.ts) : production via Supabase Realtime.

import { prof } from '../game/profiler';
import { mpDebug } from './debug';

export interface PresenceMember {
  id: string;
  meta: Record<string, unknown>;
}

export interface Transport {
  readonly self: string;
  join(room: string): Promise<void>;
  leave(): void;
  /** Diffuse à tous les autres membres du canal (pas à soi-même). */
  send(type: string, data: unknown): void;
  on(type: string, cb: (data: unknown, from: string) => void): () => void;
  onPresence(cb: (members: PresenceMember[]) => void): void;
  setMeta(meta: Record<string, unknown>): void;
}

// ------------------------------------------------- BroadcastChannel (local)

interface LocalPacket {
  kind: 'msg' | 'hello' | 'bye';
  from: string;
  type?: string;
  data?: unknown;
  meta?: Record<string, unknown>;
}

export class LocalTransport implements Transport {
  readonly self: string;
  private bc: BroadcastChannel | null = null;
  private handlers = new Map<string, Set<(data: unknown, from: string) => void>>();
  private presenceCb: ((m: PresenceMember[]) => void) | null = null;
  private members = new Map<string, { meta: Record<string, unknown>; seen: number }>();
  private meta: Record<string, unknown> = {};
  private beat: number | null = null;

  constructor(selfId: string) {
    this.self = selfId;
  }

  async join(room: string) {
    this.leave();
    mpDebug('transport.local.join', { source: 'LocalTransport.join', self: this.self, room });
    this.bc = new BroadcastChannel(`vo-room-${room}`);
    this.bc.onmessage = (ev: MessageEvent<LocalPacket>) => {
      const p = ev.data;
      if (!p || p.from === this.self) return;
      if (p.kind === 'hello') {
        const known = this.members.has(p.from);
        this.members.set(p.from, { meta: p.meta ?? {}, seen: Date.now() });
        if (!known) this.hello(); // se présenter au nouveau venu
        this.emitPresence();
      } else if (p.kind === 'bye') {
        this.members.delete(p.from);
        this.emitPresence();
      } else if (p.kind === 'msg' && p.type) {
        prof.count('net.recv');
        mpDebug('transport.local.recv', { source: 'BroadcastChannel.onmessage', self: this.self, from: p.from, type: p.type });
        for (const cb of this.handlers.get(p.type) ?? []) cb(p.data, p.from);
      }
    };
    this.hello();
    // Purge des absents : large (10 s), car les navigateurs étranglent les
    // timers des onglets cachés — un onglet en arrière-plan ne doit pas
    // passer pour déconnecté. La fermeture réelle est signalée par 'bye'
    // (pagehide ci-dessous), donc détectée immédiatement.
    this.beat = window.setInterval(() => {
      this.hello();
      const cut = Date.now() - 10_000;
      let changed = false;
      for (const [id, m] of this.members) if (m.seen < cut) { this.members.delete(id); changed = true; }
      if (changed) this.emitPresence();
    }, 1000);
    window.addEventListener('pagehide', this.onPageHide);
  }

  private onPageHide = () => {
    this.post({ kind: 'bye', from: this.self });
  };

  leave() {
    window.removeEventListener('pagehide', this.onPageHide);
    if (this.bc) {
      this.post({ kind: 'bye', from: this.self });
      this.bc.close();
      this.bc = null;
    }
    if (this.beat !== null) { clearInterval(this.beat); this.beat = null; }
    this.members.clear();
  }

  send(type: string, data: unknown) {
    prof.count('net.send');
    mpDebug('transport.local.send', { source: 'LocalTransport.send', self: this.self, type, data });
    this.post({ kind: 'msg', from: this.self, type, data });
  }

  on(type: string, cb: (data: unknown, from: string) => void) {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  onPresence(cb: (m: PresenceMember[]) => void) {
    this.presenceCb = cb;
    this.emitPresence();
  }

  setMeta(meta: Record<string, unknown>) {
    this.meta = meta;
    this.hello();
  }

  private hello() {
    this.post({ kind: 'hello', from: this.self, meta: this.meta });
  }

  private post(p: LocalPacket) {
    try { this.bc?.postMessage(p); } catch { /* canal fermé */ }
  }

  private emitPresence() {
    if (!this.presenceCb) return;
    const list: PresenceMember[] = [{ id: this.self, meta: this.meta }];
    for (const [id, m] of this.members) list.push({ id, meta: m.meta });
    this.presenceCb(list);
  }
}
