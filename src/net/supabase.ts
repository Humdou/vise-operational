// Intégration Supabase : auth (email + mot de passe + pseudo), annuaire des
// salons (table `lobbies`) et transport temps réel (Realtime broadcast +
// presence). Tout est chargé paresseusement : si les variables d'environnement
// ne sont pas définies, le jeu fonctionne intégralement hors ligne.
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { Transport, PresenceMember } from './transport';
import type { LobbyListing } from './types';
import { prof } from '../game/profiler';
import { mpDebug } from './debug';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function supabaseConfigured(): boolean {
  return Boolean(URL_ENV && KEY_ENV);
}

let client: SupabaseClient | null = null;

export async function getSupabase(): Promise<SupabaseClient> {
  if (!URL_ENV || !KEY_ENV) throw new Error('Supabase non configuré');
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(URL_ENV, KEY_ENV, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}

// ------------------------------------------------------------------- auth

export interface AuthUser { id: string; pseudo: string; email?: string }

export async function sbSignUp(email: string, password: string, pseudo: string): Promise<AuthUser> {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { pseudo } } });
  if (error) throw new Error(error.message);
  if (!data.user) throw new Error('Inscription en attente de confirmation par e-mail.');
  return { id: data.user.id, pseudo, email };
}

export async function sbSignIn(email: string, password: string): Promise<AuthUser> {
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  const u = data.user!;
  return { id: u.id, pseudo: (u.user_metadata?.pseudo as string) ?? email.split('@')[0], email };
}

export async function sbSignOut(): Promise<void> {
  const sb = await getSupabase();
  await sb.auth.signOut();
}

export async function sbCurrentUser(): Promise<AuthUser | null> {
  if (!supabaseConfigured()) return null;
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  const u = data.session?.user;
  if (!u) return null;
  return { id: u.id, pseudo: (u.user_metadata?.pseudo as string) ?? 'Commandant', email: u.email ?? undefined };
}

// -------------------------------------------------------- annuaire des salons

export async function sbListLobbies(): Promise<LobbyListing[]> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .from('lobbies')
    .select('code,name,host,players,total_slots,fill_ai')
    .eq('status', 'open')
    .gt('updated_at', new Date(Date.now() - 90_000).toISOString())
    .order('updated_at', { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => ({
    code: r.code, name: r.name, host: r.host,
    players: r.players, totalSlots: r.total_slots, fillAI: r.fill_ai,
  }));
}

export async function sbUpsertLobby(l: LobbyListing & { hostId: string; status: 'open' | 'started' }): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.from('lobbies').upsert({
    code: l.code, name: l.name, host: l.host, host_id: l.hostId,
    players: l.players, total_slots: l.totalSlots, fill_ai: l.fillAI,
    status: l.status, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function sbDeleteLobby(code: string): Promise<void> {
  const sb = await getSupabase();
  await sb.from('lobbies').delete().eq('code', code);
}

// ------------------------------------------------------- transport Realtime

export class SupabaseTransport implements Transport {
  readonly self: string;
  private channel: RealtimeChannel | null = null;
  private handlers = new Map<string, Set<(data: unknown, from: string) => void>>();
  private presenceCb: ((m: PresenceMember[]) => void) | null = null;
  private meta: Record<string, unknown> = {};

  constructor(selfId: string) {
    this.self = selfId;
  }

  async join(room: string) {
    const sb = await getSupabase();
    this.leaveSync(sb);
    mpDebug('transport.supabase.join', { source: 'SupabaseTransport.join', self: this.self, room });
    const ch = sb.channel(`vo-room-${room}`, {
      config: { broadcast: { self: false }, presence: { key: this.self } },
    });
    ch.on('broadcast', { event: 'msg' }, payload => {
      const p = payload.payload as { type: string; data: unknown; from: string };
      if (!p || p.from === this.self) return;
      prof.count('net.recv');
      mpDebug('transport.supabase.recv', { source: 'Realtime.broadcast.msg', self: this.self, from: p.from, type: p.type });
      for (const cb of this.handlers.get(p.type) ?? []) cb(p.data, p.from);
    });
    ch.on('presence', { event: 'sync' }, () => this.emitPresence());
    this.channel = ch;
    await new Promise<void>((resolve, reject) => {
      ch.subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          await ch.track(this.meta);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Canal temps réel indisponible (${status})`));
        }
      });
    });
  }

  leave() {
    if (client) this.leaveSync(client);
  }

  private leaveSync(sb: SupabaseClient) {
    if (this.channel) {
      sb.removeChannel(this.channel);
      this.channel = null;
    }
  }

  send(type: string, data: unknown) {
    prof.count('net.send');
    mpDebug('transport.supabase.send', { source: 'SupabaseTransport.send', self: this.self, type, data });
    this.channel?.send({ type: 'broadcast', event: 'msg', payload: { type, data, from: this.self } });
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
    void this.channel?.track(meta);
  }

  private emitPresence() {
    if (!this.presenceCb || !this.channel) return;
    const state = this.channel.presenceState<Record<string, unknown>>();
    const list: PresenceMember[] = [];
    for (const key of Object.keys(state)) {
      const metas = state[key];
      list.push({ id: key, meta: (metas[0] as Record<string, unknown>) ?? {} });
    }
    this.presenceCb(list);
  }
}
