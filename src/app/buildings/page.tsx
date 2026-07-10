'use client';

import { useEffect, useState } from 'react';
import type { BuildingTypeId, ThemeId } from '../../game/data';
import { BUILDINGS, PLAYER_COLORS, THEMES } from '../../game/data';
import { getBuildingVisual, preloadBuildingAssets } from '../../game/assets';

type ViewMode = 'normal' | 'mini' | 'silhouette';

const GROUPS: { title: string; ids: BuildingTypeId[] }[] = [
  { title: 'Commandement & recherche', ids: ['hq', 'tech', 'lab'] },
  { title: 'Énergie & économie', ids: ['power', 'power2', 'refinery', 'refinery2', 'depot'] },
  { title: 'Production', ids: ['barracks', 'barracks2', 'factory', 'factory2'] },
  { title: 'Détection & aérien', ids: ['radar', 'radarcenter', 'airport', 'helipad'] },
  { title: 'Défenses', ids: ['turret', 'atgun', 'aa'] },
];

function Preview({ type, team, theme, mode, ready }: {
  type: BuildingTypeId; team: string; theme: ThemeId; mode: ViewMode; ready: boolean;
}) {
  return <canvas ref={canvas => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = 310 * dpr; canvas.height = 218 * dpr;
    canvas.style.width = '100%'; canvas.style.height = '218px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const palette = THEMES[theme];
    const ground = ctx.createRadialGradient(155, 145, 8, 155, 145, 155);
    ground.addColorStop(0, palette.grass[1] ?? palette.grass[0]);
    ground.addColorStop(.72, palette.grass[0]);
    ground.addColorStop(1, palette.rough[0]);
    ctx.fillStyle = ground; ctx.fillRect(0, 0, 310, 218);
    ctx.strokeStyle = 'rgba(235,235,220,.09)'; ctx.lineWidth = 1;
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(155 + i * 40, 48); ctx.lineTo(325 + i * 40, 133); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(155 + i * 40, 48); ctx.lineTo(-15 + i * 40, 133); ctx.stroke();
    }
    const visual = getBuildingVisual(type, team);
    const sprite = document.createElement('canvas');
    sprite.width = visual.canvas.width; sprite.height = visual.canvas.height;
    const sc = sprite.getContext('2d')!; sc.drawImage(visual.canvas, 0, 0);
    if (visual.turret) {
      const t = visual.turret;
      sc.save(); sc.translate(t.mount.x, t.mount.y); sc.transform(1, .5, -1, .5, 0, 0);
      sc.rotate(-.38); sc.scale(t.scale, t.scale); sc.drawImage(t.canvas, -t.pivot.x, -t.pivot.y); sc.restore();
    }
    if (mode === 'silhouette') {
      sc.globalCompositeOperation = 'source-in'; sc.fillStyle = '#070908'; sc.fillRect(0, 0, sprite.width, sprite.height);
    }
    const distance = mode === 'mini' ? .56 : 1;
    const scale = Math.min(1.1, 286 / sprite.width, 188 / sprite.height) * distance;
    const x = (310 - sprite.width * scale) / 2;
    const y = 204 - sprite.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sprite, x, y, sprite.width * scale, sprite.height * scale);
    if (!ready || !visual.ready) {
      ctx.fillStyle = 'rgba(10,14,12,.72)'; ctx.fillRect(0, 0, 310, 218);
      ctx.fillStyle = '#d8b34c'; ctx.font = '700 12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('CHARGEMENT DES ASSETS', 155, 112);
    }
  }} aria-label={`Aperçu ${mode} : ${BUILDINGS[type].name}`} />;
}

export default function BuildingsArtBoard() {
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<ThemeId>('temperate');
  const [teamIndex, setTeamIndex] = useState(0);
  const [mode, setMode] = useState<ViewMode>('normal');
  useEffect(() => { void preloadBuildingAssets().finally(() => setReady(true)); }, []);
  const control = { background: '#202923', color: '#e5e2d5', border: '1px solid #4a574e', borderRadius: 5, padding: '8px 10px' };
  return (
    <main style={{ minHeight: '100vh', background: '#101512', color: '#e5e2d5', padding: '34px clamp(18px,4vw,64px)', fontFamily: 'system-ui,sans-serif' }}>
      <header style={{ maxWidth: 1060, marginBottom: 28 }}>
        <p style={{ color: '#d08a38', letterSpacing: '.22em', fontSize: 12, fontWeight: 800, margin: 0 }}>COALITION 2045 // ASSET REVIEW</p>
        <h1 style={{ fontSize: 'clamp(28px,4vw,52px)', lineHeight: 1, margin: '10px 0 14px' }}>Nouvelle génération de bâtiments</h1>
        <p style={{ color: '#aeb5aa', maxWidth: 780, lineHeight: 1.6 }}>Une source raster unique pour le jeu, le HUD et la pose. Cette planche contrôle les silhouettes, les biomes, les couleurs d’équipe et la lecture à distance.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 18 }}>
          <select aria-label="Biome" value={theme} onChange={e => setTheme(e.target.value as ThemeId)} style={control}>
            {(Object.keys(THEMES) as ThemeId[]).map(id => <option key={id} value={id}>{THEMES[id].name}</option>)}
          </select>
          <select aria-label="Couleur d’équipe" value={teamIndex} onChange={e => setTeamIndex(Number(e.target.value))} style={control}>
            {PLAYER_COLORS.map((color, i) => <option key={color} value={i}>Équipe {i + 1} · {color}</option>)}
          </select>
          <select aria-label="Mode d’affichage" value={mode} onChange={e => setMode(e.target.value as ViewMode)} style={control}>
            <option value="normal">Vue normale</option><option value="mini">Lecture éloignée</option><option value="silhouette">Silhouette noire</option>
          </select>
        </div>
      </header>
      {GROUPS.map(group => <section key={group.title} id={group.title === 'Défenses' ? 'defenses' : undefined} style={{ marginBottom: 36 }}>
        <h2 style={{ color: '#c2c9bd', fontSize: 14, letterSpacing: '.12em', textTransform: 'uppercase', borderBottom: '1px solid #39433d', paddingBottom: 9 }}>{group.title}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(270px,1fr))', gap: 14 }}>
          {group.ids.map(type => <article key={type} style={{ overflow: 'hidden', background: '#1a211d', border: '1px solid #39433d', borderRadius: 8, boxShadow: '0 12px 28px rgba(0,0,0,.24)' }}>
            <Preview type={type} team={PLAYER_COLORS[teamIndex]} theme={theme} mode={mode} ready={ready} />
            <div style={{ padding: '12px 15px 15px', borderTop: '1px solid #39433d' }}><strong style={{ display: 'block' }}>{BUILDINGS[type].name}</strong><span style={{ color: '#8f998f', fontSize: 12 }}>{BUILDINGS[type].w} × {BUILDINGS[type].h} · {BUILDINGS[type].desc}</span></div>
          </article>)}
        </div>
      </section>)}
    </main>
  );
}
