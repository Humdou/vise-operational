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

// --------------------------------------------------------- robustesse réseau

/** Coupe une promesse après `ms` : AUCUN appel réseau ne doit pendre l'UI. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Traduit les erreurs Supabase/réseau en messages lisibles (français). */
export function frError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.toLowerCase();
  if (m.startsWith('timeout:') || m.includes('load failed') || m.includes('failed to fetch')
    || m.includes('networkerror') || m.includes('network request failed') || m.includes('fetch failed')) {
    return 'Serveur multijoueur injoignable. S’il sort de pause (offre gratuite Supabase), il se réveille en 1 à 2 minutes — réessayez.';
  }
  if (m.includes('invalid login credentials')) return 'E-mail ou mot de passe incorrect.';
  if (m.includes('already registered')) return 'Un compte existe déjà avec cet e-mail — utilisez « Connexion ».';
  if (m.includes('at least 6 characters')) return 'Mot de passe : 6 caractères minimum.';
  if (m.includes('email not confirmed')) return 'E-mail non confirmé : vérifiez votre boîte de réception.';
  if (m.includes('anonymous sign-ins are disabled')) {
    return 'Le mode invité n’est pas activé sur le serveur (Supabase → Authentication → Sign In / Up → « Allow anonymous sign-ins »). Utilisez un compte e-mail.';
  }
  if (m.includes('for security purposes') || m.includes('rate limit')) return 'Trop de tentatives : patientez une minute puis réessayez.';
  if (m.includes('invalid email') || m.includes('unable to validate email')) return 'Adresse e-mail invalide.';
  return raw;
}

/**
 * Sonde de santé : répond en < `ms`, jamais d'exception. Sert à afficher un
 * état clair (« serveur en cours de réveil ») au lieu d'un blocage muet.
 */
export async function sbHealth(ms = 4000): Promise<boolean> {
  if (!URL_ENV || !KEY_ENV) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(`${URL_ENV}/auth/v1/health`, { headers: { apikey: KEY_ENV }, signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
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

// Tous les appels d'auth sont bornés dans le temps et remontent des messages
// lisibles : l'UI ne doit JAMAIS rester bloquée sur un serveur qui ne répond
// pas (projet en pause, réseau mobile, DNS mort…).
const AUTH_TIMEOUT_MS = 10_000;

export async function sbSignUp(email: string, password: string, pseudo: string): Promise<AuthUser> {
  try {
    const sb = await getSupabase();
    const { data, error } = await withTimeout(
      sb.auth.signUp({ email, password, options: { data: { pseudo } } }), AUTH_TIMEOUT_MS, 'signup');
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Inscription en attente de confirmation par e-mail.');
    return { id: data.user.id, pseudo, email };
  } catch (e) {
    throw new Error(frError(e));
  }
}

export async function sbSignIn(email: string, password: string): Promise<AuthUser> {
  try {
    const sb = await getSupabase();
    const { data, error } = await withTimeout(
      sb.auth.signInWithPassword({ email, password }), AUTH_TIMEOUT_MS, 'signin');
    if (error) throw new Error(error.message);
    const u = data.user!;
    return { id: u.id, pseudo: (u.user_metadata?.pseudo as string) ?? email.split('@')[0], email };
  } catch (e) {
    throw new Error(frError(e));
  }
}

/** Mode invité : session anonyme Supabase (uid réel, aucun compte à créer). */
export async function sbSignInGuest(pseudo: string): Promise<AuthUser> {
  try {
    const sb = await getSupabase();
    const { data, error } = await withTimeout(
      sb.auth.signInAnonymously({ options: { data: { pseudo } } }), AUTH_TIMEOUT_MS, 'guest');
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Connexion invité refusée par le serveur.');
    return { id: data.user.id, pseudo };
  } catch (e) {
    throw new Error(frError(e));
  }
}

export async function sbSignOut(): Promise<void> {
  const sb = await getSupabase();
  try { await withTimeout(sb.auth.signOut(), 5000, 'signout'); } catch { /* session locale purgée quand même */ }
}

export async function sbCurrentUser(): Promise<AuthUser | null> {
  if (!supabaseConfigured()) return null;
  try {
    const sb = await getSupabase();
    // getSession lit le stockage local mais peut déclencher un refresh réseau
    // (token expiré) : borné pour ne jamais suspendre l'écran « session… ».
    const { data } = await withTimeout(sb.auth.getSession(), 5000, 'session');
    const u = data.session?.user;
    if (!u) return null;
    return { id: u.id, pseudo: (u.user_metadata?.pseudo as string) ?? 'Commandant', email: u.email ?? undefined };
  } catch {
    return null;   // session indécidable (serveur endormi) → écran de connexion
  }
}

// -------------------------------------------------------- annuaire des salons

export async function sbListLobbies(): Promise<LobbyListing[]> {
  const sb = await getSupabase();
  const q = sb
    .from('lobbies')
    .select('code,name,host,players,total_slots,fill_ai')
    .eq('status', 'open')
    .gt('updated_at', new Date(Date.now() - 90_000).toISOString())
    .order('updated_at', { ascending: false })
    .limit(30);
  const { data, error } = await withTimeout(Promise.resolve(q), 6000, 'lobbies').catch(e => { throw new Error(frError(e)); });
  if (error) throw new Error(frError(new Error(error.message)));
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
    await withTimeout(new Promise<void>((resolve, reject) => {
      ch.subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          await ch.track(this.meta);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Canal temps réel indisponible (${status})`));
        }
      });
    }), 12_000, 'realtime').catch(e => { throw new Error(frError(e)); });
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
