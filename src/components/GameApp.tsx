'use client';

// Application : menu principal, écran de jeu (HUD), écran de fin.
import { useCallback, useEffect, useRef, useState } from 'react';
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

type Screen = 'menu' | 'game' | 'end';

const DIFF_LABELS: Record<Difficulty, string> = { easy: 'Facile', normal: 'Moyen', hard: 'Difficile' };

export default function GameApp() {
  // ?autostart : lance directement une partie (pratique pour les tests).
  const [screen, setScreen] = useState<Screen>(() =>
    typeof window !== 'undefined' && window.location.search.includes('autostart') ? 'game' : 'menu');
  const [settings, setSettings] = useState<GameSettings>(() => {
    // ?special=france|italy : utile pour tester les cartes spéciales directement.
    const q = typeof window !== 'undefined' ? window.location.search : '';
    const special = q.includes('special=france') ? 'france' as const
      : q.includes('special=italy') ? 'italy' as const : null;
    return { sizeId: 'medium', theme: 'temperate', opponents: 1, difficulty: 'normal', dayNight: true, special };
  });
  const [endedGame, setEndedGame] = useState<Game | null>(null);

  const launch = useCallback((s: GameSettings) => {
    setSettings(s);
    setScreen('game');
  }, []);

  if (screen === 'menu') return <MainMenu initial={settings} onLaunch={launch} />;
  if (screen === 'game') {
    return (
      <GameScreen
        settings={settings}
        onEnd={(g) => { setEndedGame(g); setScreen('end'); }}
        onQuit={() => setScreen('menu')}
      />
    );
  }
  return (
    <EndScreen
      game={endedGame!}
      onReplay={() => {
        setSettings(s => ({ ...s, seed: Math.floor(Math.random() * 1e9) }));
        setScreen('game');
      }}
      onMenu={() => setScreen('menu')}
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

function MainMenu({ initial, onLaunch }: { initial: GameSettings; onLaunch: (s: GameSettings) => void }) {
  const [s, setS] = useState<GameSettings>(initial);
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
    </div>
  );
}

// =============================================================== JEU

function GameScreen({ settings, onEnd, onQuit }: {
  settings: GameSettings;
  onEnd: (g: Game) => void;
  onQuit: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mmRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const controlsRef = useRef<Controls | null>(null);
  const sfxRef = useRef<Sfx | null>(null);
  const pausedRef = useRef(false);
  const [, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const mm = mmRef.current!;
    const game = new Game(settings);
    gameRef.current = game;
    // ?demo : fait apparaître une unité de chaque type + un exemplaire de
    // chaque bâtiment (vérification visuelle).
    if (window.location.search.includes('demo')) {
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
    const ais: AIController[] = [];
    for (let i = 1; i < game.players.length; i++) ais.push(new AIController(game, i, settings.difficulty));
    const sfx = new Sfx();
    sfxRef.current = sfx;
    const controls = new Controls(game, sfx, canvas, mm, () => setTick(t => t + 1));
    controlsRef.current = controls;
    const renderer = new Renderer(canvas, mm);

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
    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(0.08, (now - last) / 1000));
      last = now;
      if (!pausedRef.current && !game.over) {
        game.update(dt);
        for (const ai of ais) ai.update(dt);
      }
      controls.update(dt);
      const events = game.events.splice(0, game.events.length);
      sfx.handle(events, game.time, (x, y) => game.isVisibleTo(0, x, y));
      renderer.draw(game, controls.getViewState(), dt);
      if (game.over && !endScheduled) {
        endScheduled = true;
        setTimeout(() => onEnd(game), 2400);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const hudTimer = setInterval(() => setTick(t => t + 1), 180);

    // Touche P : bascule pause / reprise.
    const keyPause = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'p') {
        pausedRef.current = !pausedRef.current;
        setPaused(pausedRef.current);
      }
    };
    window.addEventListener('keydown', keyPause);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(hudTimer);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', keyPause);
      controls.detach();
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
    if (sfxRef.current) { sfxRef.current.muted = !sfxRef.current.muted; setMuted(sfxRef.current.muted); }
  };

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />
      {game && controls && <TopBar game={game} paused={paused} muted={muted} onPause={togglePause} onMute={toggleMute} onQuit={onQuit} />}
      <div className="minimap-wrap"><canvas ref={mmRef} /></div>
      {game && controls && <BottomBar game={game} controls={controls} refresh={() => setTick(t => t + 1)} />}
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

function TopBar({ game, paused, muted, onPause, onMute, onQuit }: {
  game: Game; paused: boolean; muted: boolean;
  onPause: () => void; onMute: () => void; onQuit: () => void;
}) {
  const p = game.players[0];
  const mins = Math.floor(game.time / 60);
  const secs = Math.floor(game.time % 60);
  const lowPower = p.powerUse > p.powerProd;
  const underAttack = game.time - p.alertT < 5;
  const unitCount = game.units.reduce((n, u) => n + (u.owner === 0 && !u.dead ? 1 : 0), 0);

  return (
    <div className="topbar">
      <div className="stat ore">◆ {Math.floor(p.ore)}</div>
      <div className={`stat ${lowPower ? 'power-low' : 'power-ok'}`}>⚡ {Math.round(p.powerProd)} / {Math.round(p.powerUse)}</div>
      <div className="stat">⏱ {mins}:{secs.toString().padStart(2, '0')}</div>
      <div className="stat hide-mobile">Unités : {unitCount}</div>
      <div className="stat hide-mobile">IA : {DIFF_LABELS[game.settings.difficulty]}</div>
      {underAttack && <div className="alert-flash">⚠ ATTAQUE !</div>}
      <div className="spacer" />
      <button className="icon-btn" onClick={onMute}>{muted ? '🔇' : '🔊'}</button>
      <button className="icon-btn" onClick={onPause}>{paused ? '▶' : 'II'}</button>
      <button className="icon-btn" onClick={onQuit}>✕</button>
    </div>
  );
}

// ----------------------------------------------------------- barre du bas

function BottomBar({ game, controls, refresh }: { game: Game; controls: Controls; refresh: () => void }) {
  const selB = controls.selectedBuilding ? game.buildingById.get(controls.selectedBuilding) : undefined;
  const selUnits = controls.selectedUnits
    .map(id => game.unitById.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u && !u.dead);

  if (selUnits.length > 0) {
    return <UnitPanel game={game} controls={controls} refresh={refresh} units={selUnits.map(u => u.id)} />;
  }
  if (selB && !selB.dead && selB.type !== 'hq') {
    return <BuildingPanel game={game} controls={controls} refresh={refresh} b={selB} />;
  }
  return <ConstructionPanel game={game} controls={controls} refresh={refresh} />;
}

function ConstructionPanel({ game, controls, refresh }: { game: Game; controls: Controls; refresh: () => void }) {
  return (
    <div className="bottombar">
      <div className="panel-title">
        Construction
        <span className="sub">Choisissez un bâtiment puis cliquez sur le terrain</span>
      </div>
      <div className="cmd-row">
        {BUILD_ORDER_UI.map(id => {
          const def = BUILDINGS[id];
          const chk = game.canBuild(0, id);
          return (
            <button
              key={id}
              className={`build-btn ${controls.placing === id ? 'placing-now' : ''}`}
              disabled={!chk.ok}
              onClick={() => { controls.startPlacement(id); refresh(); }}
            >
              <span className="bname">{def.name}</span>
              <span className="bcost">◆ {def.cost}</span>
              {!chk.ok && <span className="breason">{chk.reason}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BuildingPanel({ game, controls, refresh, b }: { game: Game; controls: Controls; refresh: () => void; b: Building }) {
  const def = BUILDINGS[b.type];
  const producible = (Object.keys(UNITS) as UnitTypeId[]).filter(t => UNITS[t].builtAt === b.type);
  const isProd = producible.length > 0;
  const isTech = b.type === 'tech';
  const p = game.players[0];

  return (
    <div className="bottombar">
      <div className="panel-title">
        {def.name}
        <span className="sub">
          PV {Math.ceil(b.hp)} / {b.maxHp}
          {!b.built && ` — construction ${Math.round(b.progress * 100)} %`}
          {isProd && b.built && ' — clic droit sur la carte : point de ralliement'}
        </span>
      </div>
      <div className="cmd-row">
        {b.built && isProd && producible.map(t => {
          const u = UNITS[t];
          const chk = game.canQueueUnit(b.id, t);
          return (
            <button
              key={t}
              className="build-btn"
              disabled={!chk.ok}
              title={u.desc}
              onClick={() => { if (game.queueUnit(b.id, t)) refresh(); }}
            >
              <span className="bname">{u.name}</span>
              <span className="bcost">◆ {u.cost}</span>
              {!chk.ok && chk.reason && <span className="breason">{chk.reason}</span>}
            </button>
          );
        })}
        {b.built && isTech && (Object.keys(UPGRADES) as UpgradeId[]).map(id => {
          const up = UPGRADES[id];
          const owned = !!p.upgrades[id];
          const queued = b.queue.some(q => q.up === id);
          return (
            <button
              key={id}
              className={`build-btn ${owned ? 'researched' : ''}`}
              disabled={owned || queued || p.ore < up.cost}
              title={up.desc}
              onClick={() => { if (game.queueUpgrade(b.id, id)) refresh(); }}
            >
              <span className="bname">{owned ? '✓ ' : ''}{up.name}</span>
              <span className="bcost">{owned ? 'Acquis' : `◆ ${up.cost}`}</span>
            </button>
          );
        })}
        {b.built && b.queue.length > 0 && b.queue.map((q, i) => (
          <button
            key={i}
            className="queue-chip"
            title="Cliquer pour annuler (remboursé)"
            onClick={() => { game.cancelQueue(b.id, i); refresh(); }}
          >
            <div className="qprog" style={{ width: `${i === 0 ? Math.min(100, (q.t / q.time) * 100) : 0}%` }} />
            <span>{q.kind === 'unit' ? UNITS[q.unit!].name : UPGRADES[q.up!].name} ✕</span>
          </button>
        ))}
        {b.built && b.hp < b.maxHp && (
          <button
            className={`action-btn ${b.repairOn ? 'on' : ''}`}
            onClick={() => { game.setRepair(b.id, !b.repairOn); refresh(); }}
          >
            🔧 Réparer {b.repairOn ? '(en cours)' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

function UnitPanel({ game, controls, refresh, units }: { game: Game; controls: Controls; refresh: () => void; units: number[] }) {
  const byType = new Map<UnitTypeId, number>();
  for (const id of units) {
    const u = game.unitById.get(id);
    if (u) byType.set(u.type, (byType.get(u.type) ?? 0) + 1);
  }
  const hasCombat = [...byType.keys()].some(t => UNITS[t].weapon);

  return (
    <div className="bottombar">
      <div className="panel-title">
        Unités sélectionnées
        <span className="sub">clic droit / tap : déplacer · attaquer · récolter · réparer</span>
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

function EndScreen({ game, onReplay, onMenu }: { game: Game; onReplay: () => void; onMenu: () => void }) {
  const human = game.players[0];
  const won = game.winner === 0;
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
