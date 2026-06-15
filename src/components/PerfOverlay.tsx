'use client';

// Overlay de performance en jeu (activé par ?prof ou ?perf). Lit window.__prof
// en continu et affiche FPS, pire frame, freezes, CPU par système, réseau,
// mémoire, unités, ordres, et la cadence réelle de la simulation. Conçu pour
// diagnostiquer les PICS (pas seulement les moyennes) directement en partie.
import { useEffect, useRef, useState } from 'react';
import { prof } from '../game/profiler';

interface Snap { acc: Record<string, number>; cnt: Record<string, number>; ctr: Record<string, number>; t: number }

function ms(v: number | undefined) { return (v ?? 0).toFixed(2); }

export function PerfOverlay() {
  const [, force] = useState(0);
  const prev = useRef<Snap | null>(null);
  const view = useRef<Record<string, number>>({});

  useEffect(() => {
    const id = setInterval(() => {
      const r = prof.report();
      const live = prof.live();
      const now = performance.now();
      const p = prev.current;
      prev.current = { acc: r.acc, cnt: r.cnt, ctr: r.ctr, t: now };
      if (p) {
        const dtS = (now - p.t) / 1000;
        const accD = (k: string) => ((r.acc[k] || 0) - (p.acc[k] || 0));
        const cntD = (k: string) => ((r.cnt[k] || 0) - (p.cnt[k] || 0));
        const ctrD = (k: string) => ((r.ctr[k] || 0) - (p.ctr[k] || 0));
        const frames = Math.max(1, cntD('loop.fps'));
        // ms par seconde de jeu pour chaque système (charge réelle)
        const perSec = (k: string) => accD(k) / dtS;
        const g = (window as unknown as { __vo?: { game?: { units: { dead: boolean }[] } } }).__vo;
        const units = g?.game ? g.game.units.filter(u => !u.dead).length : -1;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        view.current = {
          fps: live.fps,
          frameAvg: live.frameAvg,
          frameWorstWin: live.frameWorstWin,
          worstFrame: live.worstFrame,
          freezes: live.freezes,
          freezes100: live.freezes100,
          simHz: cntD('sim.ticks') / dtS,
          simGapWin: live.simGapWin,
          simGapMax: live.simGapMax,
          render: accD('loop.render') / frames,
          fog: accD('render.fog') / frames,
          minimap: accD('render.minimap') / frames,
          entities: accD('render.entities') / frames,
          simUpd: perSec('sim.update'),
          ai: perSec('sim.ai'),
          path: perSec('sim.pathfind'),
          engineFog: perSec('sim.fog'),
          input: accD('loop.input') / frames,
          audio: accD('loop.audio') / frames,
          netMsgs: (ctrD('net.send') + ctrD('net.recv')) / dtS,
          netCmds: ctrD('net.cmds') / dtS,
          rerenders: (ctrD('react.GameScreen') + ctrD('react.BottomBar') + ctrD('react.ProductionSidebar')) / dtS,
          units,
          memMB: mem ? mem.usedJSHeapSize / 1048576 : -1,
        };
        force(t => t + 1);
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const v = view.current;
  const freezeBad = (v.freezes ?? 0) > 0;
  const gapBad = (v.simGapWin ?? 0) > 80;

  return (
    <div className="perf-overlay">
      <div className="perf-row head">PERF — diagnostic</div>
      <div className={`perf-row ${(v.fps ?? 0) < 50 ? 'warn' : ''}`}>
        FPS <b>{(v.fps ?? 0).toFixed(0)}</b> · frame {ms(v.frameAvg)}ms · pire(1s) {ms(v.frameWorstWin)}ms
      </div>
      <div className={`perf-row ${freezeBad ? 'bad' : ''}`}>
        pire frame totale <b>{ms(v.worstFrame)}ms</b> · freezes&gt;50ms <b>{v.freezes ?? 0}</b> · &gt;100ms {v.freezes100 ?? 0}
      </div>
      <div className={`perf-row ${gapBad ? 'bad' : ''}`}>
        sim <b>{(v.simHz ?? 0).toFixed(1)}Hz</b> · pas sim max(1s) <b>{ms(v.simGapWin)}ms</b> · global {ms(v.simGapMax)}ms
      </div>
      <div className="perf-sep">CPU / frame</div>
      <div className="perf-row">rendu canvas {ms(v.render)}ms · brouillard {ms(v.fog)}ms · minimap {ms(v.minimap)}ms</div>
      <div className="perf-row">entités {ms(v.entities)}ms · input {ms(v.input)}ms · audio {ms(v.audio)}ms</div>
      <div className="perf-sep">CPU / seconde de jeu</div>
      <div className="perf-row">sim {ms(v.simUpd)}ms/s · IA {ms(v.ai)}ms/s · pathfind {ms(v.path)}ms/s · fog moteur {ms(v.engineFog)}ms/s</div>
      <div className="perf-sep">réseau · mémoire · état</div>
      <div className="perf-row">Supabase {(v.netMsgs ?? 0).toFixed(1)} msg/s · ordres {(v.netCmds ?? 0).toFixed(1)}/s · rerenders React {(v.rerenders ?? 0).toFixed(1)}/s</div>
      <div className="perf-row">unités {v.units ?? -1} · mémoire {(v.memMB ?? -1) < 0 ? 'n/a' : (v.memMB ?? 0).toFixed(0) + ' Mo'}</div>
    </div>
  );
}
