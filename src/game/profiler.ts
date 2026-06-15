// Profileur de performance : temps réels (performance.now) + compteurs par
// sous-système, et suivi des PICS (pire frame, freezes, cadence réelle de la
// simulation). Coût quasi nul quand désactivé. Activé par `?prof` ou `?perf`.
// Lecture live via window.__prof.
class Profiler {
  enabled = false;
  acc: Record<string, number> = {};   // ms cumulées par label
  cnt: Record<string, number> = {};    // nombre d'appels par label
  ctr: Record<string, number> = {};    // compteurs libres (msgs réseau, rerenders…)
  private t0 = 0;

  // ---- suivi des pics de frame
  private frames: number[] = [];        // anneau des dernières frames (ms)
  worstFrame = 0;                       // pire frame depuis le début
  freezes = 0;                          // frames > 50 ms depuis le début
  freezes100 = 0;                       // frames > 100 ms
  // ---- cadence réelle de la simulation (détecte le « pas saccadé » 160 ms)
  private lastSimWall = 0;
  simStepGapMax = 0;                    // pire écart entre deux avancées de sim (ms)
  private simGapWindow: number[] = [];

  reset() {
    this.acc = {}; this.cnt = {}; this.ctr = {};
    this.frames = []; this.worstFrame = 0; this.freezes = 0; this.freezes100 = 0;
    this.simStepGapMax = 0; this.simGapWindow = []; this.lastSimWall = 0;
    this.t0 = now();
  }

  add(label: string, ms: number) {
    if (!this.enabled) return;
    this.acc[label] = (this.acc[label] || 0) + ms;
    this.cnt[label] = (this.cnt[label] || 0) + 1;
  }

  count(label: string, n = 1) {
    if (!this.enabled) return;
    this.ctr[label] = (this.ctr[label] || 0) + n;
  }

  wrap<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn();
    const s = now();
    const r = fn();
    this.add(label, now() - s);
    return r;
  }

  // appelé une fois par frame d'affichage avec la durée totale de la frame
  frame(ms: number) {
    if (!this.enabled) return;
    this.frames.push(ms);
    if (this.frames.length > 180) this.frames.shift();
    if (ms > this.worstFrame) this.worstFrame = ms;
    if (ms > 50) this.freezes++;
    if (ms > 100) this.freezes100++;
  }

  // appelé quand la simulation a réellement avancé d'au moins un tick ce frame ;
  // mesure l'écart depuis la dernière avancée (révèle un pas saccadé)
  simAdvanced() {
    if (!this.enabled) return;
    const t = now();
    if (this.lastSimWall > 0) {
      const gap = t - this.lastSimWall;
      if (gap > this.simStepGapMax) this.simStepGapMax = gap;
      this.simGapWindow.push(gap);
      if (this.simGapWindow.length > 120) this.simGapWindow.shift();
    }
    this.lastSimWall = t;
  }

  // instantané pour l'overlay : FPS, frame moyenne/pire, freezes, écart sim
  live() {
    const f = this.frames;
    const n = f.length || 1;
    let sum = 0, worstWin = 0;
    for (const x of f) { sum += x; if (x > worstWin) worstWin = x; }
    const avg = sum / n;
    const recent = f.slice(-30);
    const ravg = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
    let gapWin = 0;
    for (const g of this.simGapWindow) if (g > gapWin) gapWin = g;
    return {
      fps: ravg > 0 ? 1000 / ravg : 0,
      frameAvg: avg, frameWorstWin: worstWin,
      worstFrame: this.worstFrame, freezes: this.freezes, freezes100: this.freezes100,
      simGapMax: this.simStepGapMax, simGapWin: gapWin,
    };
  }

  report() {
    return { wallMs: now() - this.t0, acc: { ...this.acc }, cnt: { ...this.cnt }, ctr: { ...this.ctr },
      worstFrame: this.worstFrame, freezes: this.freezes, freezes100: this.freezes100, simStepGapMax: this.simStepGapMax };
  }
}

function now() { return typeof performance !== 'undefined' ? performance.now() : 0; }

export const prof = new Profiler();

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__prof = prof;
}
