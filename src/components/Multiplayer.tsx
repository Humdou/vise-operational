'use client';

// Écrans multijoueur : authentification, navigateur de salons, salon
// d'attente (paramètres, présence, chat, lancement) et panneau de chat
// réutilisé en partie. Tout repose sur src/net/*.
import { useCallback, useEffect, useRef, useState } from 'react';
import { netMode, currentIdentity, signIn, signUp, signInGuest, signOut, localSignIn } from '../net/auth';
import { sbHealth } from '../net/supabase';
import { LobbyClient, listLobbies } from '../net/lobby';
import type { NetIdentity, LobbyListing, LobbySettings, LaunchPayload, ChatMessage } from '../net/types';
import { MAP_SIZES, THEMES, PLAYER_COUNT_CHOICES, MapSizeId, ThemeId, Difficulty } from '../game/data';
import { mpDebug } from '../net/debug';

export interface MpRun {
  lobby: LobbyClient;
  payload: LaunchPayload;
  localPlayer: number;
}

const DIFF_LABELS: Record<Difficulty, string> = { easy: 'Facile', normal: 'Moyen', hard: 'Difficile' };

// ================================================================= AUTH

function AuthForm({ onDone }: { onDone: (id: NetIdentity) => void }) {
  const mode = netMode();
  const [tab, setTab] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pseudo, setPseudo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (mode === 'off') {
    return (
      <div className="mp-card">
        <h3>Multijoueur non configuré</h3>
        <p className="mp-hint">
          Le multijoueur en ligne nécessite un projet Supabase (gratuit) :
          renseignez <code>NEXT_PUBLIC_SUPABASE_URL</code> et <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>,
          puis exécutez <code>supabase/schema.sql</code> (voir <code>docs/MULTIJOUEUR.md</code>).
        </p>
        <p className="mp-hint">
          Pour essayer sans compte : ajoutez <code>?net=local</code> à l’URL — multijoueur
          entre onglets de ce navigateur (idéal pour tester).
        </p>
      </div>
    );
  }

  if (mode === 'local') {
    return (
      <div className="mp-card">
        <h3>Multijoueur local (test)</h3>
        <p className="mp-hint">Identité par onglet — ouvrez plusieurs onglets pour simuler plusieurs joueurs.</p>
        <div className="mp-row">
          <input
            placeholder="Votre pseudo"
            value={pseudo}
            maxLength={16}
            onChange={e => setPseudo(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && pseudo.trim()) onDone(localSignIn(pseudo.trim())); }}
          />
          <button className="launch-btn" disabled={!pseudo.trim()} onClick={() => onDone(localSignIn(pseudo.trim()))}>
            Entrer
          </button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      const id = tab === 'in' ? await signIn(email.trim(), pw) : await signUp(email.trim(), pw, pseudo.trim() || email.split('@')[0]);
      onDone(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    setErr(null); setBusy(true);
    try {
      onDone(await signInGuest(pseudo.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mp-card">
      <h3>Jouer en ligne</h3>
      <div className="mp-row">
        <input
          placeholder="Votre pseudo" value={pseudo} maxLength={16}
          onChange={e => setPseudo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && pseudo.trim() && !busy) void guest(); }}
        />
        <button className="launch-btn" disabled={busy || !pseudo.trim()} onClick={() => void guest()}>
          {busy ? '…' : 'Jouer en invité'}
        </button>
      </div>
      <p className="mp-hint">Aucun compte requis : un pseudo suffit pour créer ou rejoindre un salon.</p>

      <div className="mp-tabs">
        <button className={tab === 'in' ? 'on' : ''} onClick={() => setTab('in')}>Connexion</button>
        <button className={tab === 'up' ? 'on' : ''} onClick={() => setTab('up')}>Créer un compte</button>
      </div>
      <input placeholder="E-mail" type="email" value={email} onChange={e => setEmail(e.target.value)} />
      <input
        placeholder="Mot de passe" type="password" value={pw}
        onChange={e => setPw(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
      />
      {err && <div className="mp-error">{err}</div>}
      <button className="launch-btn" disabled={busy || !email || pw.length < 6} onClick={() => void submit()}>
        {busy ? '…' : tab === 'in' ? 'Se connecter' : 'Créer le compte'}
      </button>
      {tab === 'up' && <p className="mp-hint">6 caractères minimum pour le mot de passe. Le pseudo du haut sera votre nom en partie.</p>}
    </div>
  );
}

// ================================================================= CHAT

export function ChatPanel({
  messages, me, members, onSend, inGame = false,
}: {
  messages: ChatMessage[];
  me: NetIdentity;
  members: { id: string; pseudo: string }[];
  onSend: (text: string, to?: string) => void;
  inGame?: boolean;
}) {
  const [open, setOpen] = useState(!inGame);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string>('');     // '' = tous
  const [unread, setUnread] = useState(0);
  const seen = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      seen.current = messages.length;
      setUnread(0);
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      setUnread(messages.length - seen.current);
    }
  }, [messages.length, open]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t, target || undefined);
    setText('');
  };

  const others = members.filter(m => m.id !== me.id);
  const hasPm = unread > 0 && messages.slice(seen.current).some(m => m.to === me.id);

  if (inGame && !open) {
    return (
      <button className="chat-toggle" onClick={() => setOpen(true)} title="Chat (discussions, diplomatie)">
        💬{unread > 0 && <span className={`chat-badge ${hasPm ? 'pm' : ''}`}>{unread > 9 ? '9+' : unread}</span>}
      </button>
    );
  }

  return (
    <div className={`chat-panel ${inGame ? 'ingame' : ''}`}>
      <div className="chat-head">
        <b>Communications</b>
        {inGame && <button className="chat-min" onClick={() => setOpen(false)}>—</button>}
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.to ? 'pm' : ''}`}>
            <span className="chat-when">{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <b>{m.fromId === me.id ? 'Vous' : m.from}</b>
            {m.to && <i>{m.fromId === me.id ? ` → ${members.find(x => x.id === m.to)?.pseudo ?? 'privé'}` : ' (privé)'}</i>} : {m.text}
          </div>
        ))}
        {messages.length === 0 && <div className="mp-hint">Aucun message. Diplomatie, alliances, bluff… à vous de jouer.</div>}
      </div>
      <div className="chat-input">
        {others.length > 0 && (
          <select value={target} onChange={e => setTarget(e.target.value)} title="Destinataire">
            <option value="">Tous</option>
            {others.map(m => <option key={m.id} value={m.id}>→ {m.pseudo}</option>)}
          </select>
        )}
        <input
          placeholder={target ? 'Message privé…' : 'Message à tous…'}
          value={text} maxLength={240}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); e.stopPropagation(); }}
        />
        <button onClick={send} disabled={!text.trim()}>Envoyer</button>
      </div>
    </div>
  );
}

// ============================================================ NAVIGATEUR

export function MultiplayerPanel({ onLaunch }: { onLaunch: (run: MpRun) => void }) {
  const [identity, setIdentity] = useState<NetIdentity | null>(null);
  const [checked, setChecked] = useState(false);
  // santé du serveur : 'checking' (sonde en cours), 'ok', 'down' (re-sonde
  // automatique toutes les 5 s — un projet Supabase qui sort de pause met
  // 1 à 2 minutes à se réveiller, l'écran se débloque tout seul)
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>(netMode() === 'supabase' ? 'checking' : 'ok');
  const [lobby, setLobby] = useState<LobbyClient | null>(null);
  const [, force] = useState(0);
  const refresh = useCallback(() => force(t => t + 1), []);
  const [list, setList] = useState<LobbyListing[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [createName, setCreateName] = useState('');

  useEffect(() => {
    // identité (bornée à 5 s dans sbCurrentUser : ne pend jamais) et santé
    // du serveur sont sondées EN PARALLÈLE — l'écran affiche toujours un
    // état honnête en quelques secondes.
    void currentIdentity().then(id => { setIdentity(id); setChecked(true); });
    if (netMode() !== 'supabase') return;
    let stop = false;
    let timer = 0;
    const probe = async () => {
      const ok = await sbHealth(4000);
      if (stop) return;
      setHealth(ok ? 'ok' : 'down');
      if (!ok) timer = window.setTimeout(() => void probe(), 5000);
    };
    void probe();
    return () => { stop = true; clearTimeout(timer); };
  }, []);

  const retryHealth = useCallback(() => {
    setHealth('checking');
    void sbHealth(4000).then(ok => setHealth(ok ? 'ok' : 'down'));
  }, []);

  const reloadList = useCallback(() => {
    void listLobbies().then(setList).catch(e => setErr(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    if (identity && !lobby) {
      reloadList();
      const t = setInterval(reloadList, 4000);
      return () => clearInterval(t);
    }
  }, [identity, lobby, reloadList]);

  const wireLobby = useCallback((c: LobbyClient) => {
    c.onState = refresh;
    c.onChat = refresh;
    c.onLaunch = payload => {
      const slot = payload.slots.find(s => s.kind === 'human' && s.uid === c.me.id);
      mpDebug('multiplayer.launch.slot', {
        source: 'LobbyClient.onLaunch',
        self: c.transport.self,
        uid: c.me.id,
        slot: slot ?? null,
        slots: payload.slots,
      });
      if (slot) onLaunch({ lobby: c, payload, localPlayer: slot.player });
    };
    c.onClosed = reason => { setErr(reason); setLobby(null); };
    setLobby(c);
  }, [onLaunch, refresh]);

  // ?join=CODE : invitation directe par lien
  useEffect(() => {
    if (!identity || lobby) return;
    const m = window.location.search.match(/join=([A-Za-z0-9]{6})/);
    if (m) {
      setBusy(true);
      LobbyClient.join(identity, m[1]).then(wireLobby).catch(e => setErr(String(e?.message ?? e))).finally(() => setBusy(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // écran d'état honnête : jamais plus de ~5 s sans information claire
  if (health === 'down') {
    return (
      <div className="mp-card">
        <h3>Serveur multijoueur injoignable</h3>
        <p className="mp-hint">
          Le serveur ne répond pas. S’il sort de pause (offre gratuite Supabase),
          il se réveille en 1 à 2 minutes — cette page réessaie automatiquement
          toutes les 5 secondes.
        </p>
        <div className="mp-row">
          <button className="launch-btn" onClick={retryHealth}>Réessayer maintenant</button>
        </div>
        <p className="mp-hint">
          En attendant : le mode <b>solo</b> reste entièrement disponible, et
          <code> ?net=local</code> permet de jouer entre onglets sans serveur.
        </p>
      </div>
    );
  }
  if (!checked || health === 'checking') return <div className="mp-card mp-hint">Connexion au serveur multijoueur…</div>;
  if (!identity) return <AuthForm onDone={setIdentity} />;

  // ------------------------------------------------------------- salon ouvert
  if (lobby) {
    return (
      <LobbyRoom
        lobby={lobby}
        onLeave={() => { lobby.leave(); setLobby(null); reloadList(); }}
      />
    );
  }

  // --------------------------------------------------------------- navigateur
  const doCreate = async () => {
    setErr(null); setBusy(true);
    try {
      const settings: LobbySettings = {
        name: createName.trim() || `Salon de ${identity.pseudo}`,
        sizeId: 'medium', theme: 'temperate', totalSlots: 4,
        difficulty: 'normal', fillAI: true, dayNight: true,
      };
      wireLobby(await LobbyClient.host(identity, settings));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const doJoin = async (code: string) => {
    setErr(null); setBusy(true);
    try {
      wireLobby(await LobbyClient.join(identity, code));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="mp-wrap">
      <div className="mp-card">
        <div className="mp-row mp-profile">
          <span>Connecté : <b>{identity.pseudo}</b></span>
          <button
            className="mp-link"
            onClick={() => { void signOut().then(() => setIdentity(null)); }}
          >
            Se déconnecter
          </button>
        </div>
      </div>

      <div className="mp-card">
        <h3>Créer un salon</h3>
        <div className="mp-row">
          <input placeholder="Nom du salon" value={createName} maxLength={28} onChange={e => setCreateName(e.target.value)} />
          <button className="launch-btn" disabled={busy} onClick={() => void doCreate()}>Créer</button>
        </div>
      </div>

      <div className="mp-card">
        <h3>Rejoindre</h3>
        <div className="mp-row">
          <input
            placeholder="Code d’invitation (6 caractères)" value={joinCode} maxLength={6}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
          />
          <button disabled={busy || joinCode.length !== 6} onClick={() => void doJoin(joinCode)}>Rejoindre</button>
        </div>
        <div className="mp-list">
          {list.length === 0 && <div className="mp-hint">Aucun salon ouvert pour le moment.</div>}
          {list.map(l => (
            <div key={l.code} className="mp-listing">
              <div>
                <b>{l.name}</b>
                <span className="mp-hint"> — hôte : {l.host} · {l.players}/{l.totalSlots} joueurs{l.fillAI ? ' · IA autorisées' : ' · sans IA'}</span>
              </div>
              <button disabled={busy || l.players >= l.totalSlots} onClick={() => void doJoin(l.code)}>
                {l.players >= l.totalSlots ? 'Complet' : 'Rejoindre'}
              </button>
            </div>
          ))}
        </div>
        <button className="mp-link" onClick={reloadList}>↻ Actualiser</button>
      </div>
      {err && <div className="mp-error">{err}</div>}
    </div>
  );
}

// ==================================================================== SALON

function LobbyRoom({ lobby, onLeave }: { lobby: LobbyClient; onLeave: () => void }) {
  const [, force] = useState(0);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const prevState = lobby.onState, prevChat = lobby.onChat;
    lobby.onState = () => { force(t => t + 1); prevState?.(); };
    lobby.onChat = m => { force(t => t + 1); prevChat?.(m); };
    return () => { lobby.onState = prevState; lobby.onChat = prevChat; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby]);

  const st = lobby.state;
  const s = st.settings;
  const isHost = lobby.isHost;
  const meReady = st.members.find(m => m.id === lobby.me.id)?.ready ?? false;
  const aiCount = s.fillAI ? Math.max(0, s.totalSlots - st.members.length) : 0;

  const inviteLink = () => {
    const base = `${window.location.origin}${window.location.pathname}`;
    const local = netMode() === 'local' ? 'net=local&' : '';
    return `${base}?${local}join=${st.code}`;
  };
  const copyInvite = () => {
    void navigator.clipboard?.writeText(inviteLink()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const set = (patch: Partial<LobbySettings>) => lobby.setSettings(patch);

  return (
    <div className="mp-wrap">
      <div className="mp-card">
        <div className="mp-row mp-profile">
          <h3 style={{ margin: 0 }}>{s.name}</h3>
          <span className="mp-hint">Code : <b className="mp-code">{st.code}</b></span>
          <button className="mp-link" onClick={copyInvite}>{copied ? '✓ Copié' : '🔗 Copier l’invitation'}</button>
          <button className="mp-link" onClick={onLeave}>Quitter</button>
        </div>
      </div>

      <div className="mp-cols">
        <div className="mp-card">
          <h3>Joueurs ({st.members.length}/{s.totalSlots})</h3>
          <div className="mp-members">
            {st.members.map(m => (
              <div key={m.id} className="mp-member">
                <span className={`mp-dot ${m.ready || m.isHost ? 'ok' : ''}`} />
                <b>{m.pseudo}</b>
                {m.isHost && <span className="mp-tag">hôte</span>}
                {!m.isHost && <span className="mp-hint">{m.ready ? 'prêt' : 'pas prêt'}</span>}
              </div>
            ))}
            {Array.from({ length: aiCount }).map((_, i) => (
              <div key={`ai${i}`} className="mp-member ai">
                <span className="mp-dot ai" /><span>IA ({DIFF_LABELS[s.difficulty]})</span>
              </div>
            ))}
            {!s.fillAI && Array.from({ length: Math.max(0, s.totalSlots - st.members.length) }).map((_, i) => (
              <div key={`v${i}`} className="mp-member empty">
                <span className="mp-dot" /><span className="mp-hint">En attente d’un joueur…</span>
              </div>
            ))}
          </div>

          {!isHost && (
            <button className={`launch-btn ${meReady ? 'ready-on' : ''}`} onClick={() => lobby.setReady(!meReady)}>
              {meReady ? '✓ Prêt' : 'Je suis prêt'}
            </button>
          )}
          {isHost && (
            <>
              <button
                className="launch-btn"
                onClick={() => {
                  const e = lobby.launch();
                  setLaunchErr(e);
                }}
              >
                ⚔ Lancer la partie
              </button>
              {launchErr && <div className="mp-error">{launchErr}</div>}
            </>
          )}
        </div>

        <div className="mp-card">
          <h3>Paramètres {isHost ? '' : '(choisis par l’hôte)'}</h3>
          <div className="mp-settings">
            <label>Carte
              <select disabled={!isHost} value={s.sizeId} onChange={e => set({ sizeId: e.target.value as MapSizeId })}>
                {(Object.keys(MAP_SIZES) as MapSizeId[]).map(id => (
                  <option key={id} value={id}>{MAP_SIZES[id].name} (max {MAP_SIZES[id].maxPlayers} j.)</option>
                ))}
              </select>
            </label>
            <label>Environnement
              <select disabled={!isHost} value={s.theme} onChange={e => set({ theme: e.target.value as ThemeId })}>
                {(Object.keys(THEMES) as ThemeId[]).map(id => <option key={id} value={id}>{THEMES[id].name}</option>)}
              </select>
            </label>
            <label>Participants
              <select disabled={!isHost} value={s.totalSlots} onChange={e => set({ totalSlots: parseInt(e.target.value, 10) })}>
                {PLAYER_COUNT_CHOICES.filter(n => n <= MAP_SIZES[s.sizeId].maxPlayers).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>Difficulté des IA
              <select disabled={!isHost} value={s.difficulty} onChange={e => set({ difficulty: e.target.value as Difficulty })}>
                {(Object.keys(DIFF_LABELS) as Difficulty[]).map(d => <option key={d} value={d}>{DIFF_LABELS[d]}</option>)}
              </select>
            </label>
            <label className="mp-check">
              <input type="checkbox" disabled={!isHost} checked={s.fillAI} onChange={e => set({ fillAI: e.target.checked })} />
              Compléter les places vides avec des IA
            </label>
            <label className="mp-check">
              <input type="checkbox" disabled={!isHost} checked={s.dayNight} onChange={e => set({ dayNight: e.target.checked })} />
              Cycle jour / nuit
            </label>
          </div>
          <p className="mp-hint">
            {s.fillAI
              ? `Lancement possible dès maintenant : ${st.members.length} humain(s) + ${aiCount} IA.`
              : 'Sans IA : toutes les places doivent être occupées par des humains.'}
          </p>
        </div>
      </div>

      <ChatPanel
        messages={lobby.chat}
        me={lobby.me}
        members={st.members.map(m => ({ id: m.id, pseudo: m.pseudo }))}
        onSend={(t, to) => lobby.sendChat(t, to)}
      />
    </div>
  );
}
