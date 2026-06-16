'use client';

// Application : menu principal, écran de jeu (HUD), écran de fin.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Game, GameSettings, Building } from '../game/engine';
import { AIController } from '../game/ai';
import { Renderer } from '../game/render';
import { Controls } from '../game/input';
import { Sfx } from '../game/audio';
import {
  UNITS, BUILDINGS, UPGRADES, MAP_SIZES, THEMES, BUILD_ORDER_UI, PLAYER_COUNT_CHOICES,
  UnitTypeId, BuildingTypeId, UpgradeId, MapSizeId, ThemeId, Difficulty, SpecialMapId,
} from '../game/data';
import { SPECIAL_MAPS } from '../game/map';
import { MultiplayerPanel, ChatPanel, MpRun } from './Multiplayer';
import { NetGame, SIM_DT } from '../net/netgame';
import { prof } from '../game/profiler';
import { PerfOverlay } from './PerfOverlay';
import type { ChatMessage } from '../net/types';
import { mpDebug as mpDebugLog, mpDebugSetPlayerContext } from '../net/debug';

type Screen = 'menu' | 'game' | 'end';
type InfoKind = 'building' | 'unit' | 'upgrade';
type InfoOrigin = 'bottom' | 'right';
type InfoTarget = { kind: InfoKind; id: string; origin: InfoOrigin };

const DIFF_LABELS: Record<Difficulty, string> = { easy: 'Facile', normal: 'Moyen', hard: 'Difficile' };
const lastTopbarOreByPov = new Map<number, number>();

export default function GameApp() {
  // ?autostart : lance directement une partie (pratique pour les tests).
  const [screen, setScreen] = useState<Screen>(() =>
    typeof window !== 'undefined' && window.location.search.includes('autostart') ? 'game' : 'menu');
  const [settings, setSettings] = useState<GameSettings>(() => {
    // ?special=france|italy : utile pour tester les cartes spéciales directement.
    const q = typeof window !== 'undefined' ? window.location.search : '';
    const special = q.includes('special=france') ? 'france' as const
      : q.includes('special=italy') ? 'italy' as const : null;
    // ?seed=N : carte reproductible (tests visuels et debug)
    const seedMatch = q.match(/seed=(\d+)/);
    const seed = seedMatch ? parseInt(seedMatch[1], 10) : undefined;
    return { sizeId: 'medium', theme: 'temperate', opponents: 1, difficulty: 'normal', dayNight: true, special, seed };
  });
  const [endedGame, setEndedGame] = useState<Game | null>(null);
  const [mp, setMp] = useState<MpRun | null>(null);

  const launch = useCallback((s: GameSettings) => {
    setSettings(s);
    setScreen('game');
  }, []);

  // lancement multijoueur : la charge utile de l'hôte décrit une simulation
  // identique pour tous (seed, slots humains + IA, paramètres)
  const launchMp = useCallback((run: MpRun) => {
    const pl = run.payload;
    mpDebugLog('launch.received', {
      source: 'GameApp.launchMp',
      self: run.lobby.transport.self,
      me: run.lobby.me,
      localPlayer: run.localPlayer,
      slots: pl.slots,
    });
    setMp(run);
    setSettings({
      sizeId: pl.sizeId, theme: pl.theme, opponents: pl.slots.length - 1,
      difficulty: pl.difficulty, dayNight: pl.dayNight, special: null, seed: pl.seed,
      playerNames: pl.slots.map(sl => sl.pseudo),
      humanSlots: pl.slots.filter(sl => sl.kind === 'human').map(sl => sl.player),
    });
    setScreen('game');
  }, []);

  const leaveMp = useCallback(() => {
    if (mp) { mp.lobby.transport.leave(); setMp(null); }
  }, [mp]);

  if (screen === 'menu') return <MainMenu initial={settings} onLaunch={launch} onLaunchMp={launchMp} />;
  if (screen === 'game') {
    return (
      <GameScreen
        settings={settings}
        mp={mp}
        onEnd={(g) => { setEndedGame(g); setScreen('end'); }}
        onQuit={() => { leaveMp(); setScreen('menu'); }}
      />
    );
  }
  return (
    <EndScreen
      game={endedGame!}
      pov={mp ? mp.localPlayer : 0}
      canReplay={!mp}
      onReplay={() => {
        setSettings(s => ({ ...s, seed: Math.floor(Math.random() * 1e9) }));
        setScreen('game');
      }}
      onMenu={() => { leaveMp(); setScreen('menu'); }}
    />
  );
}

// =============================================================== MENU

function MenuBackdrop() {
  return (
    <div className="menu-bg" aria-hidden="true">
      {/* Scène militaire en silhouette : industrie, radar, blindé, cristaux rares */}
      <svg className="menu-scene" viewBox="0 0 1400 380" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="mg-ground" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1a0508" />
            <stop offset="1" stopColor="#050507" />
          </linearGradient>
          <radialGradient id="mg-glow" cx="0.5" cy="1" r="1">
            <stop offset="0" stopColor="#8f1424" stopOpacity="0.55" />
            <stop offset="0.55" stopColor="#4a0c16" stopOpacity="0.22" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x="0" y="120" width="1400" height="260" fill="url(#mg-glow)" />
        {/* skyline industrielle lointaine */}
        <g fill="#0e0e12">
          <rect x="40" y="210" width="70" height="130" />
          <rect x="95" y="180" width="14" height="160" />
          <rect x="130" y="240" width="110" height="100" />
          <rect x="180" y="195" width="18" height="145" />
          <rect x="1130" y="225" width="120" height="115" />
          <rect x="1265" y="190" width="22" height="150" />
          <rect x="1300" y="245" width="80" height="95" />
        </g>
        {/* tour radar */}
        <g>
          <rect x="1185" y="150" width="10" height="80" fill="#15151a" />
          <path d="M 1158 152 A 36 36 0 0 1 1222 152 L 1190 168 Z" fill="#1c1c23" />
          <circle cx="1190" cy="146" r="4" fill="#e0344a">
            <animate attributeName="opacity" values="1;0.15;1" dur="2.2s" repeatCount="indefinite" />
          </circle>
        </g>
        {/* blindé en silhouette */}
        <g fill="#0b0b0e">
          <path d="M 250 332 l 18 -22 h 120 l 16 22 z" />
          <rect x="296" y="290" width="52" height="22" rx="4" />
          <rect x="340" y="296" width="86" height="7" rx="3" />
          <ellipse cx="327" cy="334" rx="78" ry="10" fill="#08080a" />
        </g>
        {/* cristaux de minerai rare */}
        <g>
          <path d="M 1020 340 l 16 -58 l 17 58 z" fill="#6e1120" />
          <path d="M 1043 340 l 11 -36 l 13 36 z" fill="#8f1424" />
          <path d="M 1003 340 l 9 -28 l 11 28 z" fill="#591020" />
          <path d="M 1036 282 l 6 14 l -10 4 z" fill="#d8425c" opacity="0.85" />
          <ellipse cx="1030" cy="342" rx="46" ry="8" fill="#1f070c" />
        </g>
        <rect x="0" y="336" width="1400" height="44" fill="url(#mg-ground)" />
      </svg>
      <div className="menu-sweep" />
      <div className="menu-vignette" />
    </div>
  );
}

const THEME_DESC: Record<ThemeId, string> = {
  temperate: 'Plaines ouvertes et bosquets : le champ de bataille classique.',
  snow: 'Étendues polaires et lacs sombres. Lisibilité maximale.',
  desert: 'Dunes arides et canyons : le minerai y brille de loin.',
  mist: 'Brume permanente : visibilité réduite, embuscades favorisées.',
  badlands: 'Terres calcinées et hostiles, ambiance de fin du monde.',
  tropical: 'Archipel luxuriant : plages, palmiers et lagunes turquoise.',
};

// Aperçu stylisé d'un environnement (couleurs réelles du thème).
function EnvPreview({ t }: { t: ThemeId }) {
  const th = THEMES[t];
  return (
    <svg viewBox="0 0 120 68" preserveAspectRatio="none" aria-hidden="true">
      <rect width="120" height="68" fill={th.grass[0]} />
      <rect x="62" y="4" width="52" height="22" rx="8" fill={th.rough[0]} opacity="0.85" />
      <ellipse cx="22" cy="60" rx="36" ry="18" fill={th.shore} />
      <ellipse cx="19" cy="61" rx="29" ry="13" fill={th.water} />
      <circle cx="96" cy="48" r="5" fill={th.rock[0]} />
      <circle cx="105" cy="53" r="3.5" fill={th.rock[1] ?? th.rock[0]} />
      {[0, 1, 2, 3].map(k => (
        <circle key={k} cx={66 + (k % 2) * 7 + k} cy={36 + Math.floor(k / 2) * 6} r="2.6" fill={th.ore} />
      ))}
      <circle cx={84} cy={40} r="2.6" fill="#c2304a" />
      {t === 'tropical' && (
        <g>
          <path d="M 47 46 q 2 -8 1 -13" stroke="#5d4a30" strokeWidth="2" fill="none" />
          {[-150, -100, -50, 10, 60].map(a => (
            <path
              key={a}
              d={`M 48 33 q ${8 * Math.cos((a * Math.PI) / 180)} ${5 * Math.sin((a * Math.PI) / 180) - 3} ${13 * Math.cos((a * Math.PI) / 180)} ${8 * Math.sin((a * Math.PI) / 180)}`}
              stroke="#1f5a2d" strokeWidth="1.8" fill="none"
            />
          ))}
        </g>
      )}
      {t === 'snow' && [12, 40, 75, 100, 58].map((x, k) => (
        <circle key={k} cx={x} cy={10 + k * 9} r="1.5" fill="#fff" opacity="0.8" />
      ))}
      {t === 'badlands' && (
        <path d="M 10 18 l 14 6 l 10 -4 M 70 60 l 12 -5" stroke="rgba(0,0,0,0.4)" strokeWidth="1.5" fill="none" />
      )}
      {t === 'mist' && <rect width="120" height="68" fill="#aeb6bd" opacity="0.3" />}
      <rect width="120" height="68" fill="none" />
    </svg>
  );
}

function MainMenu({ initial, onLaunch, onLaunchMp }: {
  initial: GameSettings;
  onLaunch: (s: GameSettings) => void;
  onLaunchMp: (run: MpRun) => void;
}) {
  const [s, setS] = useState<GameSettings>(initial);
  // ?join=CODE ou ?net=local ouvrent directement l'onglet multijoueur
  const [mode, setMode] = useState<'solo' | 'multi'>(() =>
    typeof window !== 'undefined' && /[?&](join|net)=/.test(window.location.search) ? 'multi' : 'solo');
  const maxPlayers = s.special ? SPECIAL_MAPS[s.special].maxPlayers : MAP_SIZES[s.sizeId].maxPlayers;
  const players = s.opponents + 1;

  const pickSize = (id: MapSizeId) => {
    setS(prev => ({
      ...prev,
      sizeId: id,
      opponents: Math.min(prev.opponents, MAP_SIZES[id].maxPlayers - 1),
    }));
  };
  const pickSpecial = (id: SpecialMapId | null) => {
    setS(prev => ({
      ...prev,
      special: id,
      opponents: Math.min(prev.opponents, (id ? SPECIAL_MAPS[id].maxPlayers : MAP_SIZES[prev.sizeId].maxPlayers) - 1),
    }));
  };

  return (
    <div className="menu-root">
      <MenuBackdrop />
      <div className="menu-shell">
        <div className="mode-tabs">
          <button className={`mode-tab ${mode === 'solo' ? 'on' : ''}`} onClick={() => setMode('solo')}>
            🛡 JOUER HORS LIGNE
          </button>
          <button className={`mode-tab ${mode === 'multi' ? 'on' : ''}`} onClick={() => setMode('multi')}>
            🌐 MULTIJOUEUR EN LIGNE
          </button>
        </div>

        {mode === 'multi' ? (
          <div className="menu-multi">
            <MultiplayerPanel onLaunch={onLaunchMp} />
          </div>
        ) : (
        <div className="menu-body">
        <div className="menu-left">
          <div className="menu-emblem">▲</div>
          <div className="menu-title">VISE<br /><span>OPERATIONAL</span></div>
          <div className="menu-slogan">L’économie gagne les guerres.</div>

          <button className="launch-btn" onClick={() => onLaunch({ ...s, seed: Math.floor(Math.random() * 1e9) })}>
            <span className="launch-glow" />
            LANCER LA PARTIE
          </button>
          <div className="launch-sub">
            {players} joueurs · {s.special ? `carte ${SPECIAL_MAPS[s.special].name}` : `carte ${MAP_SIZES[s.sizeId].name.toLowerCase()}`} · IA {DIFF_LABELS[s.difficulty].toLowerCase()} · {THEMES[s.theme].name}
          </div>

          <div className="menu-help">
            <b>PC :</b> clic gauche = sélection (glisser = rectangle) · clic droit = ordre contextuel (maintenir = caméra) ·
            molette = zoom · <b>A</b> = attaque-dépl. · <b>E</b> = escorter · <b>S</b> = stop · <b>P</b> = pause · Ctrl+1–9 = groupes.<br />
            <b>Mobile :</b> tap = sélection puis ordre · glisser = caméra · pincer = zoom.<br />
            <b>But :</b> détruisez les QG ennemis. Le minerai rare (rouge) vaut triple : contrôlez-le.
          </div>
        </div>

        <div className="menu-right">
          <div className="menu-grid2">
            <div className="opt-group">
              <div className="opt-label">Taille de la carte</div>
              <div className="opt-row">
                {(Object.keys(MAP_SIZES) as MapSizeId[]).map(id => (
                  <button
                    key={id}
                    className={`opt-btn ${!s.special && s.sizeId === id ? 'active' : ''}`}
                    disabled={!!s.special}
                    onClick={() => pickSize(id)}
                  >
                    {MAP_SIZES[id].name}
                  </button>
                ))}
              </div>
              <div className="opt-hint">
                {s.special ? 'Taille fixée par la carte spéciale' : `Durée estimée : ${MAP_SIZES[s.sizeId].duration}`}
              </div>
            </div>

            <div className="opt-group">
              <div className="opt-label">Cartes spéciales</div>
              <div className="opt-row">
                <button
                  className={`opt-btn ${!s.special ? 'active' : ''}`}
                  onClick={() => pickSpecial(null)}
                >
                  Aléatoire
                </button>
                {(Object.keys(SPECIAL_MAPS) as SpecialMapId[]).map(id => (
                  <button
                    key={id}
                    className={`opt-btn ${s.special === id ? 'active' : ''}`}
                    onClick={() => pickSpecial(id)}
                  >
                    {SPECIAL_MAPS[id].name}
                  </button>
                ))}
              </div>
              <div className="opt-hint">
                {s.special ? SPECIAL_MAPS[s.special].desc : 'Cartes uniques inspirées de pays réels'}
              </div>
            </div>

            <div className="opt-group">
              <div className="opt-label">Joueurs (chacun pour soi)</div>
              <div className="opt-row">
                {PLAYER_COUNT_CHOICES.map(n => (
                  <button
                    key={n}
                    className={`opt-btn ${players === n ? 'active' : ''}`}
                    disabled={n > maxPlayers}
                    title={n > maxPlayers ? `Nécessite une carte plus grande` : ''}
                    onClick={() => setS({ ...s, opponents: n - 1 })}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="opt-hint">Vous + {s.opponents} IA · 16 joueurs : carte Très grande uniquement</div>
            </div>

            <div className="opt-group">
              <div className="opt-label">Difficulté de l’IA</div>
              <div className="opt-row">
                {(['easy', 'normal', 'hard'] as Difficulty[]).map(d => (
                  <button
                    key={d}
                    className={`opt-btn ${s.difficulty === d ? 'active' : ''}`}
                    onClick={() => setS({ ...s, difficulty: d })}
                  >
                    {DIFF_LABELS[d]}
                  </button>
                ))}
              </div>
            </div>

            <div className="opt-group">
              <div className="opt-label">Cycle jour / nuit</div>
              <div className="opt-row">
                <button className={`opt-btn ${s.dayNight ? 'active' : ''}`} onClick={() => setS({ ...s, dayNight: true })}>Activé</button>
                <button className={`opt-btn ${!s.dayNight ? 'active' : ''}`} onClick={() => setS({ ...s, dayNight: false })}>Désactivé</button>
              </div>
            </div>
          </div>

          <div className="opt-group">
            <div className="opt-label">Théâtre d’opérations</div>
            <div className="env-grid">
              {(Object.keys(THEMES) as ThemeId[]).map(t => (
                <button
                  key={t}
                  className={`env-card ${s.theme === t ? 'active' : ''}`}
                  onClick={() => setS({ ...s, theme: t })}
                >
                  <EnvPreview t={t} />
                  <span>{THEMES[t].name}</span>
                </button>
              ))}
            </div>
            <div className="env-detail">
              <div className="env-detail-preview"><EnvPreview t={s.theme} /></div>
              <div>
                <div className="env-detail-name">{THEMES[s.theme].name}</div>
                <div className="env-detail-desc">{THEME_DESC[s.theme]}</div>
              </div>
            </div>
          </div>
        </div>
        </div>
        )}

      </div>
    </div>
  );
}

// =============================================================== JEU

function GameScreen({ settings, mp, onEnd, onQuit }: {
  settings: GameSettings;
  mp?: MpRun | null;
  onEnd: (g: Game) => void;
  onQuit: () => void;
}) {
  const pov = mp ? mp.localPlayer : 0;
  // outillage de test : expose l'état + trace les empreintes (jamais en prod normale)
  const mpDebugActive = typeof window !== 'undefined' && /[?&](net=local|mpdebug)/.test(window.location.search);
  if (prof.enabled) prof.count('react.GameScreen');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mmRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const controlsRef = useRef<Controls | null>(null);
  const sfxRef = useRef<Sfx | null>(null);
  const pausedRef = useRef(false);
  const [, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.82);
  const [musicVolume, setMusicVolume] = useState(0.52);
  const [effectsVolume, setEffectsVolume] = useState(0.9);
  const [infoTarget, setInfoTarget] = useState<InfoTarget | null>(null);
  const [netNote, setNetNote] = useState<string | null>(null);
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([]);

  useEffect(() => {
    mpDebugLog('gamescreen.effect.start', {
      source: 'GameScreen.useEffect.start',
      hasMp: Boolean(mp),
      localPlayer: pov,
      uid: mp?.lobby.me.id ?? null,
    });
    if (typeof window !== 'undefined' && /[?&](prof|perf)/.test(window.location.search)) {
      prof.enabled = true;
      prof.reset();
    }
    const canvas = canvasRef.current!;
    const mm = mmRef.current!;
    const game = new Game(settings);
    gameRef.current = game;
    mpDebugLog('gamescreen.game.created', {
      source: 'new Game(settings)',
      hasMp: Boolean(mp),
      localPlayer: pov,
      players: game.players.map(p => ({ playerId: p.id, name: p.name, isHuman: p.isHuman, ore: p.ore })),
    });
    // ?demo : fait apparaître une unité de chaque type + un exemplaire de
    // chaque bâtiment (vérification visuelle).
    if (!mp && window.location.search.includes('demo')) {
      const s = game.map.starts[0];
      ([
        'rifle', 'bazooka', 'sniper', 'engineer',
        'jeep', 'tank', 'artillery', 'harvester',
        'elite', 'rocketeer', 'kamikaze', 'radarvehicle',
        'heavytank', 'tankdestroyer', 'heavyarty',
      ] as UnitTypeId[])
        .forEach((t, i) => game.spawnUnit(0, t, s.x - 14 + (i % 4) * 2.6, s.y - 5 + Math.floor(i / 4) * 2.8));
      const placeDemo = (t: BuildingTypeId, tx: number, ty: number) => {
        game.players[0].ore = 99999;
        if (game.place(0, t, tx, ty)) {
          const nb = game.buildings[game.buildings.length - 1];
          nb.built = true; nb.progress = 1; nb.hp = nb.maxHp;
        }
      };
      const blds: BuildingTypeId[] = [
        'power', 'refinery', 'depot', 'barracks', 'factory', 'radar',
        'radarcenter', 'airport', 'tech', 'lab', 'power2', 'refinery2',
        'barracks2', 'factory2', 'turret', 'atgun', 'aa',
      ];
      blds.forEach((t, i) => {
        placeDemo(t, Math.round(s.x - 2 + (i % 5) * 4), Math.round(s.y + 4 + Math.floor(i / 5) * 4));
      });
      game.players[0].ore = 1000;
      game.recomputePower();
    }
    // L'IA ne tourne QUE sur l'hôte (autoritatif). En solo, sur la machine
    // unique. Le client NE crée PAS de contrôleurs IA : il prédit les unités
    // adverses en continuant leurs ordres, corrigé par les snapshots de l'hôte.
    const ais: AIController[] = [];
    const aiOwned = new Set<number>();
    const runsAI = !mp || mp.lobby.isHost;
    if (mp) {
      if (runsAI) {
        for (const sl of mp.payload.slots) {
          if (sl.kind === 'ai') { ais.push(new AIController(game, sl.player, settings.difficulty)); aiOwned.add(sl.player); }
        }
      }
    } else {
      for (let i = 1; i < game.players.length; i++) ais.push(new AIController(game, i, settings.difficulty));
    }
    // synchronisation réseau : host-authoritative + prédiction client (NetGame)
    const sync = mp ? new NetGame(game, mp.lobby.transport, mp.lobby.isHost, mp.localPlayer, mp.payload.slots) : null;
    if (mp) mpDebugSetPlayerContext(mp.localPlayer, mp.payload.slots);
    if (sync) {
      // hôte : un joueur déconnecté est repris par une IA (host-side)
      sync.onPeerLost = player => {
        if (!aiOwned.has(player)) {
          aiOwned.add(player);
          ais.push(new AIController(game, player, settings.difficulty));
          game.players[player].name += ' (IA)';
          setNetNote(`${game.players[player].name} : joueur déconnecté, une IA reprend sa base.`);
          window.setTimeout(() => setNetNote(null), 6000);
        }
      };
    }
    // chat de partie : on continue d'utiliser le canal du salon
    let restoreChat: (() => void) | null = null;
    if (mp) {
      const lobby = mp.lobby;
      const prevChat = lobby.onChat;
      lobby.onChat = m => { prevChat?.(m); setChatMsgs([...lobby.chat]); };
      setChatMsgs([...lobby.chat]);
      restoreChat = () => { lobby.onChat = prevChat; };
    }
    const sfx = new Sfx();
    sfx.setVolume(volume);
    sfx.setMusicVolume(musicVolume);
    sfx.setEffectsVolume(effectsVolume);
    sfxRef.current = sfx;
    const controls = new Controls(
      game, sfx, canvas, mm, () => setTick(t => t + 1),
      pov, sync ? (c => sync.issue(c)) : undefined,
    );
    controlsRef.current = controls;
    const renderer = new Renderer(canvas, mm);
    renderer.pov = pov;
    // banc de test : accès à l'état pour l'outillage (?net=local, ?mpdebug, ?prof)
    if (mpDebugActive || prof.enabled) {
      (window as unknown as Record<string, unknown>).__vo = { game, sync, controls };
    }

    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    controls.dpr = dpr;
    const resize = () => {
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      mm.width = 192; mm.height = 192;
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let last = performance.now();
    let endScheduled = false;
    let acc = 0;
    // Host-authoritative + prédiction client : hôte ET client font tourner la
    // simulation à pas fixe à chaque frame (fluide, jamais bloqué). L'hôte
    // diffuse des snapshots ; le client se cale dessus à réception (NetGame).
    const simStep = (now: number, dt: number) => {
      if (!game.over && (!pausedRef.current || sync)) {
        if (sync) sync.pump(now);               // hôte : diffuse l'état si dû
        // Rattrapage borné. En solo (grandes cartes), on borne plus court pour
        // éviter qu'une frame lente ne déclenche une rafale de ticks (= « gros
        // à-coups »). En multijoueur, on garde la marge plus large (le timing
        // partagé / les snapshots corrigent la dérive) — inchangé.
        acc = Math.min(acc + dt, sync ? 0.25 : 0.12);
        let advanced = 0;
        while (acc >= SIM_DT) {
          prof.wrap('sim.update', () => game.update(SIM_DT));
          // l'IA ne tourne que là où elle est autoritative (hôte / solo)
          if (ais.length) prof.wrap('sim.ai', () => { for (const ai of ais) ai.update(SIM_DT); });
          advanced++;
          acc -= SIM_DT;
        }
        if (advanced > 0) prof.simAdvanced();
        // bannière UNIQUEMENT sur vraie coupure : aucun snapshot depuis >3 s
        if (sync && !sync.isHost) {
          if (sync.msSinceSnapshot(now) > 3000) setNetNote('Connexion interrompue avec l’hôte…');
          else setNetNote(prev => prev === 'Connexion interrompue avec l’hôte…' ? null : prev);
        }
      }
      if (game.over && !endScheduled) {
        endScheduled = true;
        setTimeout(() => onEnd(game), 2400);
      }
    };
    const frame = (now: number) => {
      const frameStart = performance.now();
      const dt = Math.max(0, Math.min(0.08, (now - last) / 1000));
      last = now;
      prof.wrap('loop.sim', () => simStep(now, dt));
      prof.wrap('loop.input', () => controls.update(dt));
      const events = game.events.splice(0, game.events.length);
      prof.wrap('loop.audio', () => { sfx.handle(events, game.time, (x, y) => game.isVisibleTo(pov, x, y)); sfx.updateRuntime(game, dt); });
      prof.wrap('loop.render', () => renderer.draw(game, controls.getViewState(), dt));
      const ft = performance.now() - frameStart;
      prof.add('loop.frame', ft);
      prof.frame(ft);
      prof.count('loop.fps', 1);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // onglet caché : rAF est gelé, on continue la simulation (multijoueur
    // surtout : l'hôte doit sceller ET avancer ; les événements sonores
    // sont purgés pour ne pas s'accumuler).
    const bgTimer = window.setInterval(() => {
      if (!document.hidden) return;
      const now = performance.now();
      const dt = Math.max(0, Math.min(0.2, (now - last) / 1000));
      last = now;
      simStep(now, dt);
      game.events.length = 0;
    }, 100);

    const hudTimer = setInterval(() => setTick(t => t + 1), 180);

    // Touche P : bascule pause / reprise.
    const keyPause = (e: KeyboardEvent) => {
      if (mp) return; // multijoueur : le temps est partagé, pas de pause locale
      if (e.key.toLowerCase() === 'p') {
        pausedRef.current = !pausedRef.current;
        setPaused(pausedRef.current);
      }
    };
    window.addEventListener('keydown', keyPause);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(hudTimer);
      clearInterval(bgTimer);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', keyPause);
      controls.detach();
      sync?.dispose();
      restoreChat?.();
      sfx.dispose();
      if (sfxRef.current === sfx) sfxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const game = gameRef.current;
  const controls = controlsRef.current;

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  };
  const toggleMute = () => {
    if (sfxRef.current) {
      const next = !sfxRef.current.muted;
      sfxRef.current.setMuted(next);
      setMuted(next);
    }
  };
  const changeVolume = (value: number) => {
    setVolume(value);
    if (sfxRef.current) {
      sfxRef.current.ensure();
      sfxRef.current.setVolume(value);
      if (value > 0 && sfxRef.current.muted) {
        sfxRef.current.setMuted(false);
        setMuted(false);
      }
    }
  };
  const changeMusicVolume = (value: number) => {
    setMusicVolume(value);
    if (sfxRef.current) {
      sfxRef.current.ensure();
      sfxRef.current.setMusicVolume(value);
      if (value > 0 && sfxRef.current.muted) {
        sfxRef.current.setMuted(false);
        setMuted(false);
      }
    }
  };
  const changeEffectsVolume = (value: number) => {
    setEffectsVolume(value);
    if (sfxRef.current) {
      sfxRef.current.ensure();
      sfxRef.current.setEffectsVolume(value);
      if (value > 0 && sfxRef.current.muted) {
        sfxRef.current.setMuted(false);
        setMuted(false);
      }
    }
  };

  return (
    <div
      className="game-root"
      onPointerDown={e => {
        const el = e.target as HTMLElement;
        if (!el.closest('.info-popover') && !el.closest('.info-btn')) setInfoTarget(null);
      }}
    >
      <canvas ref={canvasRef} className="game-canvas" />
      {prof.enabled && <PerfOverlay />}
      {netNote && <div className="net-note">{netNote}</div>}
      {mp && (
        <ChatPanel
          inGame
          messages={chatMsgs}
          me={{ id: mp.lobby.me.id, pseudo: mp.lobby.me.pseudo }}
          members={mp.payload.slots
            .filter(sl => sl.kind === 'human' && sl.uid)
            .map(sl => ({ id: sl.uid!, pseudo: sl.pseudo }))}
          onSend={(t, to) => mp.lobby.sendChat(t, to)}
        />
      )}
      {game && controls && (
        <TopBar
          game={game}
          pov={pov}
          paused={paused}
          muted={muted}
          volume={volume}
          musicVolume={musicVolume}
          effectsVolume={effectsVolume}
          onVolume={changeVolume}
          onMusicVolume={changeMusicVolume}
          onEffectsVolume={changeEffectsVolume}
          onPause={togglePause}
          onMute={toggleMute}
          onQuit={onQuit}
        />
      )}
      <div className="minimap-wrap"><canvas ref={mmRef} /></div>
      {game && controls && (
        <ProductionSidebar
          game={game}
          controls={controls}
          refresh={() => setTick(t => t + 1)}
          infoTarget={infoTarget}
          setInfoTarget={setInfoTarget}
        />
      )}
      {game && controls && (
        <BottomBar
          game={game}
          controls={controls}
          refresh={() => setTick(t => t + 1)}
          infoTarget={infoTarget}
          setInfoTarget={setInfoTarget}
        />
      )}
      {infoTarget && <InfoPopover target={infoTarget} />}
      {controls?.placing && (
        <div className="hint-banner">
          Placement : {BUILDINGS[controls.placing].name} — cliquez sur le terrain (près de votre base) · Échap pour annuler
        </div>
      )}
      {controls?.attackMoveMode && (
        <div className="hint-banner red">Attaque-déplacement : cliquez sur la destination</div>
      )}
      {controls?.escortMode && (
        <div className="hint-banner">Escorte : cliquez sur l’unité alliée à protéger</div>
      )}
      {controls?.boxSelectMode && (
        <div className="hint-banner">Sélection multiple : glissez pour encadrer vos unités</div>
      )}
      {paused && (
        <div className="pause-overlay">
          <div>PAUSE</div>
          <button className="resume-btn" onClick={togglePause}>▶ REPRENDRE</button>
          <div className="pause-hint">ou touche P</div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------- barre du haut

function TopBar({
  game, paused, muted, volume, musicVolume, effectsVolume,
  pov, onVolume, onMusicVolume, onEffectsVolume, onPause, onMute, onQuit,
}: {
  game: Game; pov: number; paused: boolean; muted: boolean; volume: number; musicVolume: number; effectsVolume: number;
  onVolume: (value: number) => void;
  onMusicVolume: (value: number) => void;
  onEffectsVolume: (value: number) => void;
  onPause: () => void; onMute: () => void; onQuit: () => void;
}) {
  // pov = joueur LOCAL : en multijoueur chaque client n'affiche que SON économie
  const p = game.players[pov];
  const lastOre = lastTopbarOreByPov.get(pov);
  if (lastOre !== p.ore) {
    lastTopbarOreByPov.set(pov, p.ore);
    mpDebugLog('ui.topbar.ore', {
      source: 'TopBar.render',
      pov,
      playerId: p.id,
      displayedOre: Math.round(p.ore),
      allOre: game.players.map(pl => ({ playerId: pl.id, ore: Math.round(pl.ore) })),
    });
  }
  const mins = Math.floor(game.time / 60);
  const secs = Math.floor(game.time % 60);
  const lowPower = p.powerUse > p.powerProd;
  const underAttack = game.time - p.alertT < 5;
  const unitCount = game.units.reduce((n, u) => n + (u.owner === pov && !u.dead ? 1 : 0), 0);

  return (
    <div className="topbar">
      <div className="stat ore">◆ {Math.floor(p.ore)}</div>
      <div className={`stat ${lowPower ? 'power-low' : 'power-ok'}`}>⚡ {Math.round(p.powerProd)} / {Math.round(p.powerUse)}</div>
      <div className="stat">⏱ {mins}:{secs.toString().padStart(2, '0')}</div>
      <div className="stat hide-mobile">Unités : {unitCount}</div>
      <div className="stat hide-mobile">IA : {DIFF_LABELS[game.settings.difficulty]}</div>
      {underAttack && <div className="alert-flash">⚠ ATTAQUE !</div>}
      <div className="spacer" />
      <label className="volume-ctrl" title="Volume">
        <span>VOL</span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(volume * 100)}
          onChange={e => onVolume(Number(e.currentTarget.value) / 100)}
        />
      </label>
      <label className="volume-ctrl hide-mobile" title="Musique">
        <span>MUS</span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(musicVolume * 100)}
          onChange={e => onMusicVolume(Number(e.currentTarget.value) / 100)}
        />
      </label>
      <label className="volume-ctrl hide-mobile" title="Effets">
        <span>FX</span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(effectsVolume * 100)}
          onChange={e => onEffectsVolume(Number(e.currentTarget.value) / 100)}
        />
      </label>
      <button className="icon-btn" onClick={onMute}>{muted ? '🔇' : '🔊'}</button>
      <button className="icon-btn" onClick={onPause}>{paused ? '▶' : 'II'}</button>
      <button className="icon-btn" onClick={onQuit}>✕</button>
    </div>
  );
}

// ----------------------------------------------------------- barre du bas

type ProductionCategoryId = 'infantry' | 'vehicles' | 'air';

const BUILDING_INFO: Record<BuildingTypeId, string> = {
  hq: 'Centre vital de ta base. Protège-le en priorité : s’il tombe, la partie est perdue.',
  power: 'Produit l’énergie nécessaire aux bâtiments. Construis-en avant d’étendre ta base pour éviter les pénuries.',
  refinery: 'Transforme le minerai récolté en ressources utilisables. Place-la près des gisements pour accélérer ton économie.',
  depot: 'Améliore la logistique autour des raffineries. Utile quand ton économie commence à s’étendre.',
  barracks: 'Produit l’infanterie. Utile pour défendre rapidement, explorer et soutenir tes véhicules.',
  factory: 'Produit les véhicules terrestres. Indispensable pour créer tanks, artilleries, récolteurs et unités mécaniques.',
  radar: 'Améliore la vision stratégique et la lecture de la carte. À construire quand tu veux mieux anticiper les attaques.',
  radarcenter: 'Renforce fortement la vision de ton armée et de tes bâtiments. Excellent pour contrôler la carte en milieu de partie.',
  airport: 'Produit et réarme les avions. Utilise-le pour reconnaissance rapide et frappes ciblées.',
  tech: 'Débloque les améliorations globales. À utiliser quand ton économie peut financer une montée en puissance durable.',
  lab: 'Débloque les bâtiments et unités de niveau 2. Un investissement important pour dominer le milieu et la fin de partie.',
  power2: 'Centrale avancée à forte production. Idéale pour alimenter une base T2 dense sans multiplier les petites centrales.',
  refinery2: 'Raffinerie avancée plus rentable et plus rapide. Construis-la pour sécuriser une économie de fin de partie.',
  barracks2: 'Centre d’infanterie avancée. Sert à produire des soldats spécialisés capables de peser contre les blindés et les bases.',
  factory2: 'Complexe de véhicules avancés. Produit les blindés lourds, véhicules spécialisés et artilleries de fin de partie.',
  turret: 'Défense fixe anti-infanterie. Place-la près des accès ou des récolteurs vulnérables.',
  atgun: 'Défense fixe anti-véhicule. Efficace contre les tanks, mais dépend d’une bonne position.',
  aa: 'Défense anti-aérienne. Protège les zones importantes contre les avions ennemis.',
};

const UNIT_INFO: Record<UnitTypeId, string> = {
  rifle: 'Infanterie de base bon marché. Utile pour tenir le terrain tôt, protéger une zone et accompagner les véhicules.',
  bazooka: 'Infanterie anti-véhicule. Idéal contre tanks et blindés, mais vulnérable contre l’infanterie.',
  sniper: 'Infanterie longue portée. Très efficace contre les soldats, mais fragile face aux véhicules.',
  engineer: 'Unité de soutien qui répare bâtiments et véhicules. Garde-la en retrait et envoie-la là où les combats usent tes forces.',
  jeep: 'Véhicule rapide de reconnaissance et harcèlement. Utilise-le pour explorer, chasser les cibles isolées ou tester une défense.',
  tank: 'Unité blindée principale. Solide, polyvalente, efficace pour tenir une ligne de front.',
  artillery: 'Unité longue portée. Parfaite pour détruire bâtiments et défenses, mais vulnérable au contact.',
  harvester: 'Récolte automatiquement le minerai et le rapporte à une raffinerie. Protège-le : sans récolteurs, ton économie s’écroule.',
  bomber: 'Avion d’attaque rapide. Excellent pour frapper une cible importante puis rentrer se réarmer.',
  scoutplane: 'Avion de reconnaissance non armé. Utilise-le pour révéler la carte, trouver des expansions ou repérer une attaque.',
  elite: 'Infanterie T2 polyvalente et résistante. Bonne pour renforcer une ligne, nettoyer l’infanterie et tenir les points clés.',
  rocketeer: 'Infanterie anti-blindé avancée. Très utile contre véhicules lourds et bâtiments, mais à protéger contre les tirs directs.',
  kamikaze: 'Unité d’assaut à usage unique. À envoyer sur des groupes ou bâtiments importants quand l’échange vaut le sacrifice.',
  spy: 'Unité d’infiltration sans arme. Peut saboter un QG ennemi pour couper son radar et réduire fortement sa vision.',
  heavytank: 'Char lourd de rupture. Lent mais très robuste, parfait pour mener une attaque frontale.',
  tankdestroyer: 'Véhicule spécialisé anti-char. Très fort contre blindés, moins flexible contre l’infanterie et les attaques multiples.',
  heavyarty: 'Artillerie lourde de siège. Dévastatrice à longue portée, mais lente et fragile si l’ennemi approche.',
  radarvehicle: 'Véhicule de reconnaissance avancée. Sert à surveiller la carte et sécuriser les mouvements de ton armée.',
  mobilecmd: 'Camion de commandement très coûteux. Déploie-le dans un secteur sécurisé pour créer un nouveau QG.',
};

const UPGRADE_INFO: Record<UpgradeId, string> = {
  refining: 'Augmente les revenus de minerai. Très rentable si tu as déjà plusieurs récolteurs actifs.',
  powerplus: 'Améliore la production énergétique. Utile pour soutenir une base dense sans construire trop de centrales.',
  armor: 'Renforce les véhicules. À choisir si ton armée repose sur les blindés et les engagements prolongés.',
  ammo: 'Augmente les dégâts globaux. Bon choix quand tu veux transformer une armée existante en vraie force offensive.',
  optics: 'Améliore la vision. Utile pour repérer plus tôt les attaques et contrôler les zones contestées.',
  repairs: 'Accélère les réparations. Fort dans les parties longues où bâtiments et véhicules survivent après les combats.',
};

function infoDetails(target: InfoTarget): { title: string; body: string } {
  if (target.kind === 'building') {
    const id = target.id as BuildingTypeId;
    return { title: BUILDINGS[id].name, body: BUILDING_INFO[id] ?? BUILDINGS[id].desc };
  }
  if (target.kind === 'unit') {
    const id = target.id as UnitTypeId;
    return { title: UNITS[id].name, body: UNIT_INFO[id] ?? UNITS[id].desc };
  }
  const id = target.id as UpgradeId;
  return { title: UPGRADES[id].name, body: UPGRADE_INFO[id] ?? UPGRADES[id].desc };
}

function sameInfo(a: InfoTarget | null, b: InfoTarget) {
  return !!a && a.kind === b.kind && a.id === b.id && a.origin === b.origin;
}

function InfoButton({
  target, current, setInfoTarget,
}: {
  target: InfoTarget;
  current: InfoTarget | null;
  setInfoTarget: (target: InfoTarget | null) => void;
}) {
  const active = sameInfo(current, target);
  return (
    <button
      type="button"
      className={`info-btn ${active ? 'active' : ''}`}
      aria-label="Informations"
      aria-pressed={active}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        setInfoTarget(active ? null : target);
      }}
    >
      i
    </button>
  );
}

function InfoPopover({ target }: { target: InfoTarget }) {
  const info = infoDetails(target);
  return (
    <div className={`info-popover info-${target.origin}`} onPointerDown={e => e.stopPropagation()}>
      <div className="info-popover-title">{info.title}</div>
      <div className="info-popover-body">{info.body}</div>
    </div>
  );
}

function InfoTile({
  children, target, current, setInfoTarget, className = '',
}: {
  children: ReactNode;
  target: InfoTarget;
  current: InfoTarget | null;
  setInfoTarget: (target: InfoTarget | null) => void;
  className?: string;
}) {
  return (
    <div className={`info-tile ${className}`}>
      {children}
      <InfoButton target={target} current={current} setInfoTarget={setInfoTarget} />
    </div>
  );
}

const PRODUCTION_CATEGORIES: { id: ProductionCategoryId; label: string; sub: string; producers: BuildingTypeId[] }[] = [
  { id: 'infantry', label: 'Caserne', sub: 'Infanterie', producers: ['barracks', 'barracks2'] },
  { id: 'vehicles', label: 'Usine', sub: 'Véhicules', producers: ['factory', 'factory2'] },
  { id: 'air', label: 'Aéroport', sub: 'Aérien', producers: ['airport'] },
];

function findBestProducer(game: Game, type: UnitTypeId, pov: number): { building: Building | null; reason: string } {
  const unit = UNITS[type];
  const producers = game.buildings
    .filter(b => b.owner === pov && !b.dead && b.built && b.type === unit.builtAt)
    .sort((a, b) => a.queue.length - b.queue.length || a.id - b.id);

  if (producers.length === 0) {
    return { building: null, reason: `Requiert : ${BUILDINGS[unit.builtAt].name}` };
  }

  for (const b of producers) {
    if (game.canQueueUnit(b.id, type).ok) return { building: b, reason: '' };
  }

  const reason = producers
    .map(b => game.canQueueUnit(b.id, type).reason)
    .find(Boolean) ?? 'Indisponible';
  return { building: null, reason };
}

function ProductionSidebar({
  game, controls, refresh, infoTarget, setInfoTarget,
}: {
  game: Game;
  controls: Controls;
  refresh: () => void;
  infoTarget: InfoTarget | null;
  setInfoTarget: (target: InfoTarget | null) => void;
}) {
  if (prof.enabled) prof.count('react.ProductionSidebar');
  const [active, setActive] = useState<ProductionCategoryId>('infantry');
  const cat = PRODUCTION_CATEGORIES.find(c => c.id === active) ?? PRODUCTION_CATEGORIES[0];
  const units = (Object.keys(UNITS) as UnitTypeId[])
    .filter(t => cat.producers.includes(UNITS[t].builtAt));

  return (
    <aside className="prod-sidebar">
      <div className="prod-head">
        <div>Production</div>
        <span>globale</span>
      </div>
      <div className="prod-tabs">
        {PRODUCTION_CATEGORIES.map(c => (
          <button
            key={c.id}
            className={`prod-tab ${active === c.id ? 'active' : ''}`}
            onClick={() => setActive(c.id)}
          >
            <b>{c.label}</b>
            <span>{c.sub}</span>
          </button>
        ))}
      </div>
      <div className="prod-list">
        {units.map(t => {
          const unit = UNITS[t];
          const { building, reason } = findBestProducer(game, t, controls.pov);
          const queueLabel = building ? `${building.queue.length}/5` : '—';
          return (
            <InfoTile
              key={t}
              className="prod-info-tile"
              target={{ kind: 'unit', id: t, origin: 'right' }}
              current={infoTarget}
              setInfoTarget={setInfoTarget}
            >
              <button
                className={`prod-unit ${building ? '' : 'disabled'}`}
                disabled={!building}
                title={unit.desc}
                onClick={() => {
                  if (building) { controls.issue({ k: 'qunit', bId: building.id, t }); refresh(); }
                }}
              >
                <span className="prod-unit-main">
                  <span className="prod-unit-name">{unit.name}</span>
                  <span className="prod-cost">◆ {unit.cost}</span>
                </span>
                <span className="prod-unit-meta">
                  <span>{building ? BUILDINGS[building.type].name : reason}</span>
                  <span>file {queueLabel}</span>
                </span>
              </button>
            </InfoTile>
          );
        })}
      </div>
    </aside>
  );
}

function BottomBar({
  game, controls, refresh, infoTarget, setInfoTarget,
}: {
  game: Game;
  controls: Controls;
  refresh: () => void;
  infoTarget: InfoTarget | null;
  setInfoTarget: (target: InfoTarget | null) => void;
}) {
  if (prof.enabled) prof.count('react.BottomBar');
  const [mobileOpen, setMobileOpen] = useState(false);
  const selB = controls.selectedBuilding ? game.buildingById.get(controls.selectedBuilding) : undefined;
  const selUnits = controls.selectedUnits
    .map(id => game.unitById.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u && !u.dead);

  if (selUnits.length > 0) {
    return <UnitPanel game={game} controls={controls} refresh={refresh} units={selUnits.map(u => u.id)} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />;
  }
  if (selB && !selB.dead && selB.type !== 'hq') {
    return <BuildingPanel game={game} controls={controls} refresh={refresh} b={selB} infoTarget={infoTarget} setInfoTarget={setInfoTarget} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />;
  }
  return <ConstructionPanel game={game} controls={controls} refresh={refresh} infoTarget={infoTarget} setInfoTarget={setInfoTarget} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />;
}

function ConstructionPanel({
  game, controls, refresh, infoTarget, setInfoTarget, mobileOpen, setMobileOpen,
}: {
  game: Game;
  controls: Controls;
  refresh: () => void;
  infoTarget: InfoTarget | null;
  setInfoTarget: (target: InfoTarget | null) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean | ((open: boolean) => boolean)) => void;
}) {
  return (
    <div className={`bottombar ${mobileOpen ? 'mobile-open' : 'mobile-closed'}`}>
      <div className="panel-title">
        Construction
        <span className="sub">Choisissez un bâtiment puis cliquez sur le terrain</span>
        <button className="mobile-panel-toggle" onClick={() => setMobileOpen(o => !o)}>
          {mobileOpen ? 'Fermer' : 'Ouvrir'}
        </button>
      </div>
      <div className="cmd-row">
        {BUILD_ORDER_UI.map(id => {
          const def = BUILDINGS[id];
          const chk = game.canBuild(controls.pov, id);
          return (
            <InfoTile
              key={id}
              target={{ kind: 'building', id, origin: 'bottom' }}
              current={infoTarget}
              setInfoTarget={setInfoTarget}
            >
              <button
                className={`build-btn ${controls.placing === id ? 'placing-now' : ''}`}
                disabled={!chk.ok}
                onClick={() => { controls.startPlacement(id); refresh(); }}
              >
                <span className="bname">{def.name}</span>
                <span className="bcost">◆ {def.cost}</span>
                {!chk.ok && <span className="breason">{chk.reason}</span>}
              </button>
            </InfoTile>
          );
        })}
      </div>
    </div>
  );
}

function BuildingPanel({
  game, controls, refresh, b, infoTarget, setInfoTarget, mobileOpen, setMobileOpen,
}: {
  game: Game;
  controls: Controls;
  refresh: () => void;
  b: Building;
  infoTarget: InfoTarget | null;
  setInfoTarget: (target: InfoTarget | null) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean | ((open: boolean) => boolean)) => void;
}) {
  const def = BUILDINGS[b.type];
  const producible = (Object.keys(UNITS) as UnitTypeId[]).filter(t => UNITS[t].builtAt === b.type);
  const isProd = producible.length > 0;
  const isTech = b.type === 'tech';
  const p = game.players[controls.pov];

  return (
    <div className={`bottombar ${mobileOpen ? 'mobile-open' : 'mobile-closed'}`}>
      <div className="panel-title">
        {def.name}
        <span className="sub">
          PV {Math.ceil(b.hp)} / {b.maxHp}
          {!b.built && ` — construction ${Math.round(b.progress * 100)} %`}
          {isProd && b.built && ' — clic droit sur la carte : point de ralliement'}
        </span>
        <button className="mobile-panel-toggle" onClick={() => setMobileOpen(o => !o)}>
          {mobileOpen ? 'Fermer' : 'Ouvrir'}
        </button>
      </div>
      <div className="cmd-row">
        {b.built && isProd && producible.map(t => {
          const u = UNITS[t];
          const chk = game.canQueueUnit(b.id, t);
          return (
            <InfoTile
              key={t}
              target={{ kind: 'unit', id: t, origin: 'bottom' }}
              current={infoTarget}
              setInfoTarget={setInfoTarget}
            >
              <button
                className="build-btn"
                disabled={!chk.ok}
                title={u.desc}
                onClick={() => { controls.issue({ k: 'qunit', bId: b.id, t }); refresh(); }}
              >
                <span className="bname">{u.name}</span>
                <span className="bcost">◆ {u.cost}</span>
                {!chk.ok && chk.reason && <span className="breason">{chk.reason}</span>}
              </button>
            </InfoTile>
          );
        })}
        {b.built && isTech && (Object.keys(UPGRADES) as UpgradeId[]).map(id => {
          const up = UPGRADES[id];
          const owned = !!p.upgrades[id];
          const queued = b.queue.some(q => q.up === id);
          return (
            <InfoTile
              key={id}
              target={{ kind: 'upgrade', id, origin: 'bottom' }}
              current={infoTarget}
              setInfoTarget={setInfoTarget}
            >
              <button
                className={`build-btn ${owned ? 'researched' : ''}`}
                disabled={owned || queued || p.ore < up.cost}
                title={up.desc}
                onClick={() => { controls.issue({ k: 'qup', bId: b.id, up: id }); refresh(); }}
              >
                <span className="bname">{owned ? '✓ ' : ''}{up.name}</span>
                <span className="bcost">{owned ? 'Acquis' : `◆ ${up.cost}`}</span>
              </button>
            </InfoTile>
          );
        })}
        {b.built && b.queue.length > 0 && b.queue.map((q, i) => (
          <button
            key={i}
            className="queue-chip"
            title="Cliquer pour annuler (remboursé)"
            onClick={() => { controls.issue({ k: 'qcancel', bId: b.id, i }); refresh(); }}
          >
            <div className="qprog" style={{ width: `${i === 0 ? Math.min(100, (q.t / q.time) * 100) : 0}%` }} />
            <span>{q.kind === 'unit' ? UNITS[q.unit!].name : UPGRADES[q.up!].name} ✕</span>
          </button>
        ))}
        {b.built && b.hp < b.maxHp && (
          <button
            className={`action-btn ${b.repairOn ? 'on' : ''}`}
            onClick={() => { controls.issue({ k: 'repairOn', bId: b.id, on: !b.repairOn }); refresh(); }}
          >
            🔧 Réparer {b.repairOn ? '(en cours)' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

function UnitPanel({
  game, controls, refresh, units, mobileOpen, setMobileOpen,
}: {
  game: Game;
  controls: Controls;
  refresh: () => void;
  units: number[];
  mobileOpen: boolean;
  setMobileOpen: (open: boolean | ((open: boolean) => boolean)) => void;
}) {
  const byType = new Map<UnitTypeId, number>();
  for (const id of units) {
    const u = game.unitById.get(id);
    if (u) byType.set(u.type, (byType.get(u.type) ?? 0) + 1);
  }
  const hasCombat = [...byType.keys()].some(t => UNITS[t].weapon);
  const hasMobileCommand = byType.has('mobilecmd');

  return (
    <div className={`bottombar ${mobileOpen ? 'mobile-open' : 'mobile-closed'}`}>
      <div className="panel-title">
        Unités sélectionnées
        <span className="sub">clic droit / tap : déplacer · attaquer · récolter · réparer</span>
        <button className="mobile-panel-toggle" onClick={() => setMobileOpen(o => !o)}>
          {mobileOpen ? 'Fermer' : 'Ouvrir'}
        </button>
      </div>
      <div className="cmd-row sel-summary">
        {[...byType.entries()].map(([t, n]) => (
          <span key={t} className="sel-pill">{UNITS[t].name} × {n}</span>
        ))}
        {hasCombat && (
          <button
            className={`action-btn ${controls.attackMoveMode ? 'toggled' : ''}`}
            onClick={() => { controls.attackMoveMode = !controls.attackMoveMode; controls.escortMode = false; refresh(); }}
          >
            ⚔ Attaque-dépl.
          </button>
        )}
        <button
          className={`action-btn ${controls.escortMode ? 'on' : ''}`}
          title="Puis cliquez sur l'unité alliée à protéger (récolteur, artillerie…)"
          onClick={() => { controls.escortMode = !controls.escortMode; controls.attackMoveMode = false; refresh(); }}
        >
          🛡 Escorter
        </button>
        <button className="action-btn" onClick={() => { controls.stopSelection(); refresh(); }}>■ Stop</button>
        {hasMobileCommand && (
          <button className="action-btn" onClick={() => { controls.deploySelection(); refresh(); }}>
            Déployer QG
          </button>
        )}
        <button
          className={`action-btn ${controls.boxSelectMode ? 'on' : ''}`}
          onClick={() => { controls.boxSelectMode = !controls.boxSelectMode; refresh(); }}
        >
          ▭ Sélection multiple
        </button>
        <button
          className="action-btn"
          onClick={() => { controls.selectedUnits = []; refresh(); }}
        >
          Désélectionner
        </button>
      </div>
    </div>
  );
}

// =============================================================== FIN

function EndScreen({ game, onReplay, onMenu, pov = 0, canReplay = true }: {
  game: Game; onReplay: () => void; onMenu: () => void; pov?: number; canReplay?: boolean;
}) {
  const human = game.players[pov];
  const won = game.winner === pov;
  const mins = Math.floor(game.time / 60);
  const secs = Math.floor(game.time % 60);
  const mapTiles = game.map.w * game.map.h;

  const rows: { label: string; get: (i: number) => number | string }[] = [
    { label: 'Minerai récolté', get: i => Math.floor(game.players[i].stats.oreHarvested) },
    { label: 'Unités produites', get: i => game.players[i].stats.unitsProduced },
    { label: 'Unités perdues', get: i => game.players[i].stats.unitsLost },
    { label: 'Unités détruites', get: i => game.players[i].stats.unitsKilled },
    { label: 'Bâtiments construits', get: i => game.players[i].stats.buildingsBuilt },
    { label: 'Bâtiments détruits', get: i => game.players[i].stats.buildingsDestroyed },
    { label: 'Récolteurs perdus', get: i => game.players[i].stats.harvestersLost },
    { label: 'Gisements contrôlés', get: i => game.depositsControlled(i) },
    { label: 'Plus grosse armée', get: i => game.players[i].stats.maxArmy },
    { label: 'Carte explorée', get: i => `${Math.round((game.players[i].exploredCount / mapTiles) * 100)} %` },
  ];

  const ecoScore = (i: number) => Math.round(game.players[i].stats.oreHarvested);
  const milScore = (i: number) => Math.round(game.players[i].stats.valueKilled);
  const stratScore = (i: number) => Math.round(
    ecoScore(i) * 0.35 + milScore(i) * 0.45 +
    (game.players[i].exploredCount / mapTiles) * 2000 +
    game.depositsControlled(i) * 150,
  );

  return (
    <div className="end-root">
      <div className="end-card">
        <div className={`end-title ${won ? 'win' : 'lose'}`}>
          {won ? '★ VICTOIRE ★' : 'DÉFAITE'}
        </div>
        <div className="end-sub">
          {won
            ? 'Toutes les forces ennemies ont été anéanties.'
            : `${game.winner >= 0 ? game.players[game.winner].name : 'L’ennemi'} contrôle le champ de bataille.`}
          {' '}Durée : {mins} min {secs.toString().padStart(2, '0')} s.
        </div>
        <div className="stats-scroll">
        <table className="stats-table">
          <thead>
            <tr>
              <th>Statistique</th>
              {game.players.map(p => (
                <th key={p.id} style={{ color: p.color }} className={p.id === game.winner ? 'winner-col' : ''}>
                  {p.name}{p.id === game.winner ? ' 🏆' : p.defeated ? ' ✝' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {game.players.map(p => (
                  <td key={p.id} className={p.id === game.winner ? 'winner-col' : ''}>{r.get(p.id)}</td>
                ))}
              </tr>
            ))}
            <tr className="score-row">
              <td>Score économique</td>
              {game.players.map(p => <td key={p.id}>{ecoScore(p.id)}</td>)}
            </tr>
            <tr className="score-row">
              <td>Score militaire</td>
              {game.players.map(p => <td key={p.id}>{milScore(p.id)}</td>)}
            </tr>
            <tr className="score-row">
              <td>Score stratégique</td>
              {game.players.map(p => <td key={p.id}>{stratScore(p.id)}</td>)}
            </tr>
          </tbody>
        </table>
        </div>
        <div className="end-buttons">
          <button className="launch-btn" style={{ flex: 1, maxWidth: 240 }} onClick={onReplay}>REJOUER</button>
          <button className="action-btn" style={{ maxWidth: 200 }} onClick={onMenu}>Menu principal</button>
        </div>
      </div>
    </div>
  );
}
