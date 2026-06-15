// Façade d'identité : trois modes.
//  - 'supabase' : comptes réels (e-mail + mot de passe + pseudo) ;
//  - 'local'    : ?net=local — identité par onglet, sans compte (tests LAN) ;
//  - 'off'      : multijoueur non configuré, seul le mode hors ligne existe.
import { supabaseConfigured, sbCurrentUser, sbSignIn, sbSignUp, sbSignOut } from './supabase';
import type { NetIdentity } from './types';

export type NetMode = 'off' | 'local' | 'supabase';

export function netMode(): NetMode {
  if (typeof window === 'undefined') return 'off';
  if (window.location.search.includes('net=local')) return 'local';
  return supabaseConfigured() ? 'supabase' : 'off';
}

const LOCAL_KEY = 'vo-local-identity';

function localIdentity(): NetIdentity | null {
  try {
    const raw = sessionStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as NetIdentity) : null;
  } catch { return null; }
}

export async function currentIdentity(): Promise<NetIdentity | null> {
  const mode = netMode();
  if (mode === 'local') return localIdentity();
  if (mode === 'supabase') {
    const u = await sbCurrentUser();
    return u ? { id: u.id, pseudo: u.pseudo } : null;
  }
  return null;
}

export async function signIn(email: string, password: string): Promise<NetIdentity> {
  const u = await sbSignIn(email, password);
  return { id: u.id, pseudo: u.pseudo };
}

export async function signUp(email: string, password: string, pseudo: string): Promise<NetIdentity> {
  const u = await sbSignUp(email, password, pseudo);
  return { id: u.id, pseudo: u.pseudo };
}

export async function signOut(): Promise<void> {
  if (netMode() === 'supabase') await sbSignOut();
  else sessionStorage.removeItem(LOCAL_KEY);
}

// Mode local : « connexion » = choisir un pseudo (identité par onglet, ce qui
// permet de tester le multijoueur avec plusieurs onglets du même navigateur).
export function localSignIn(pseudo: string): NetIdentity {
  const existing = localIdentity();
  const id = existing?.id ?? `loc-${Math.random().toString(36).slice(2, 10)}`;
  const ident: NetIdentity = { id, pseudo };
  try { sessionStorage.setItem(LOCAL_KEY, JSON.stringify(ident)); } catch { /* privé */ }
  return ident;
}
