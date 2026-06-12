// Audio procédural moderne : design sonore militaire, lourd et non-rétro.
// Le jeu n'embarque pas de fichiers audio ; on fabrique des couches physiques
// avec WebAudio : bruit filtré, sub-graves, saturation douce, queues sombres.
import type { Game, GameEvent } from './engine';
import { UNITS, WeaponKind } from './data';

type NoiseTone = 'white' | 'brown' | 'crackle';

interface NoiseOpts {
  tone?: NoiseTone;
  highpass?: number;
  lowpass?: number;
  bandpass?: number;
  q?: number;
  drive?: number;
  delay?: number;
  attack?: number;
  tail?: number;
  out?: AudioNode | null;
}

interface ToneOpts {
  type?: OscillatorType;
  delay?: number;
  slide?: number;
  lowpass?: number;
  highpass?: number;
  drive?: number;
  attack?: number;
  release?: number;
  out?: AudioNode | null;
}

const SHOT_GAP: Partial<Record<WeaponKind, number>> = {
  bullet: 0.035,
  mg: 0.05,
  sniper: 0.2,
  ap: 0.11,
  shell: 0.14,
  arty: 0.28,
  bomb: 0.2,
  flak: 0.065,
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicTimer: number | null = null;
  private nextMusicAt = 0;
  private musicStep = 0;
  private shotT: Partial<Record<WeaponKind, number>> = {};
  private lastExplosion = 0;
  private lastBigBoom = 0;
  private lastTakeoff = 0;
  private lastUi = 0;
  private lastVehicle = 0;
  private lastAircraft = 0;
  private combatHeat = 0;
  private masterVolume = 0.82;
  private effectsVolume = 0.9;
  private musicVolume = 0.52;
  muted = false;

  ensure() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();

      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -17;
      comp.knee.value = 18;
      comp.ratio.value = 6.5;
      comp.attack.value = 0.002;
      comp.release.value = 0.28;

      const musicFilter = this.ctx.createBiquadFilter();
      musicFilter.type = 'lowpass';
      musicFilter.frequency.value = 3400;
      musicFilter.Q.value = 0.55;

      this.master = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.master.connect(comp).connect(this.ctx.destination);
      this.sfxBus.connect(this.master);
      this.musicBus.connect(musicFilter).connect(this.master);
      this.applyVolumes();
      this.startMusic();
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  dispose() {
    if (this.musicTimer !== null && typeof window !== 'undefined') window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
  }

  setVolume(value: number) {
    this.masterVolume = this.clamp(value);
    this.applyVolumes();
  }

  getVolume() {
    return this.masterVolume;
  }

  setEffectsVolume(value: number) {
    this.effectsVolume = this.clamp(value);
    this.applyVolumes();
  }

  getEffectsVolume() {
    return this.effectsVolume;
  }

  setMusicVolume(value: number) {
    this.musicVolume = this.clamp(value);
    this.applyVolumes();
  }

  getMusicVolume() {
    return this.musicVolume;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyVolumes();
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.master) {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, t, 0.025);
    }
    if (this.sfxBus) {
      this.sfxBus.gain.cancelScheduledValues(t);
      this.sfxBus.gain.setTargetAtTime(this.effectsVolume, t, 0.035);
    }
    if (this.musicBus) {
      this.musicBus.gain.cancelScheduledValues(t);
      const duck = Math.max(0.58, 1 - this.combatHeat * 0.18);
      this.musicBus.gain.setTargetAtTime(this.musicVolume * duck, t, 0.18);
    }
  }

  private clamp(v: number) {
    return Math.max(0, Math.min(1, v));
  }

  private vary(v: number, amount = 0.08): number {
    return v * (1 + (Math.random() * 2 - 1) * amount);
  }

  private cleanup(nodes: AudioNode[], afterSec: number) {
    if (typeof window === 'undefined') return;
    window.setTimeout(() => {
      for (const n of nodes) {
        try { n.disconnect(); } catch {}
      }
    }, Math.max(80, afterSec * 1000));
  }

  // --------------------------------------------------------------- primitives

  private distort(amount: number): WaveShaperNode | null {
    if (!this.ctx || amount <= 0) return null;
    const shaper = this.ctx.createWaveShaper();
    const samples = 256;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    return shaper;
  }

  private osc(
    freq: number, dur: number, vol: number,
    delay = 0, slide = 0, type: OscillatorType = 'sine', out: AudioNode | null = this.sfxBus,
  ) {
    if (!this.ctx || !out || this.muted || vol <= 0) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(18, freq), t);
    if (slide !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(18, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.018, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.03);
    this.cleanup([o, g], delay + dur + 0.18);
  }

  private tone(freq: number, dur: number, vol: number, opts: ToneOpts = {}) {
    if (!this.ctx || this.muted || vol <= 0) return;
    const out = opts.out ?? this.sfxBus;
    if (!out) return;
    const t = this.ctx.currentTime + (opts.delay ?? 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = opts.type ?? 'sawtooth';
    o.frequency.setValueAtTime(Math.max(18, freq), t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(18, freq + opts.slide), t + dur);

    let node: AudioNode = o;
    if (opts.highpass) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(opts.highpass, t);
      node.connect(hp); node = hp;
    }
    if (opts.lowpass) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(opts.lowpass, t);
      lp.Q.value = 0.8;
      node.connect(lp); node = lp;
    }
    const shaper = this.distort(opts.drive ?? 0);
    if (shaper) { node.connect(shaper); node = shaper; }

    const a = opts.attack ?? 0.025;
    const r = opts.release ?? 0.09;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.setTargetAtTime(vol * 0.72, t + Math.max(a, dur * 0.35), dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + r);
    node.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + r + 0.03);
    this.cleanup([o, g, node], (opts.delay ?? 0) + dur + r + 0.25);
  }

  private noise(dur: number, vol: number, opts: NoiseOpts = {}) {
    if (!this.ctx || this.muted || vol <= 0) return;
    const out = opts.out ?? this.sfxBus;
    if (!out) return;
    const t = this.ctx.currentTime + (opts.delay ?? 0);
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const n = Math.random() * 2 - 1;
      const e = 1 - i / len;
      if (opts.tone === 'brown') {
        brown = (brown + 0.035 * n) / 1.035;
        data[i] = brown * 3.2 * e;
      } else if (opts.tone === 'crackle') {
        data[i] = (Math.random() > 0.82 ? n : n * 0.18) * e;
      } else {
        data[i] = n * e;
      }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    let node: AudioNode = src;
    const nodes: AudioNode[] = [src];

    if (opts.highpass) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(opts.highpass, t);
      hp.Q.value = opts.q ?? 0.7;
      node.connect(hp); node = hp; nodes.push(hp);
    }
    if (opts.bandpass) {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(opts.bandpass, t);
      bp.Q.value = opts.q ?? 1.5;
      node.connect(bp); node = bp; nodes.push(bp);
    }
    if (opts.lowpass) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(opts.lowpass, t);
      lp.Q.value = opts.q ?? 0.8;
      node.connect(lp); node = lp; nodes.push(lp);
    }
    const shaper = this.distort(opts.drive ?? 0);
    if (shaper) { node.connect(shaper); node = shaper; nodes.push(shaper); }

    const g = this.ctx.createGain();
    const attack = opts.attack ?? 0.006;
    const end = t + dur;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    node.connect(g).connect(out);
    nodes.push(g);
    src.start(t);
    src.stop(end + 0.03);

    if (opts.tail && opts.tail > 0) {
      const delay = this.ctx.createDelay(0.6);
      const fb = this.ctx.createGain();
      const damp = this.ctx.createBiquadFilter();
      delay.delayTime.value = opts.tail;
      fb.gain.value = 0.22;
      damp.type = 'lowpass';
      damp.frequency.value = 900;
      g.connect(delay).connect(damp).connect(fb).connect(delay);
      delay.connect(out);
      nodes.push(delay, fb, damp);
    }
    this.cleanup(nodes, (opts.delay ?? 0) + dur + (opts.tail ? opts.tail * 5 : 0) + 0.35);
  }

  private sub(freq: number, dur: number, vol: number, delay = 0) {
    this.osc(freq, dur, vol, delay, -freq * 0.55, 'sine');
  }

  private mechClick(delay = 0, vol = 0.03) {
    this.noise(0.018, vol, { tone: 'crackle', highpass: 1200, lowpass: 5200, drive: 2.2, delay });
    this.noise(0.035, vol * 0.55, { tone: 'crackle', bandpass: 700, q: 5, drive: 1.8, delay: delay + 0.01 });
  }

  // ------------------------------------------------------------- interface UI

  click() {
    this.ensure();
    if (!this.ctx || this.ctx.currentTime - this.lastUi < 0.035) return;
    this.lastUi = this.ctx.currentTime;
    this.mechClick(0, 0.026);
    this.noise(0.04, 0.012, { tone: 'crackle', bandpass: 1600, q: 3.2, drive: 1.6, delay: 0.018 });
  }

  order() {
    this.ensure();
    this.noise(0.055, 0.032, { tone: 'crackle', highpass: 650, lowpass: 2600, drive: 2.4 });
    this.noise(0.08, 0.018, { tone: 'brown', highpass: 90, lowpass: 420, drive: 1.7, delay: 0.015 });
    this.mechClick(0.055, 0.018);
  }

  error() {
    this.ensure();
    this.noise(0.16, 0.038, { tone: 'brown', highpass: 55, lowpass: 260, drive: 2.4 });
    this.noise(0.11, 0.022, { tone: 'crackle', bandpass: 520, q: 4, drive: 2.2, delay: 0.08 });
  }

  // -------------------------------------------------------------- armes

  private rifleShot() {
    this.noise(0.026, 0.072, { tone: 'crackle', highpass: 950, lowpass: this.vary(5600, 0.16), drive: 4.1, tail: 0.055 });
    this.noise(0.052, 0.022, { tone: 'brown', highpass: 80, lowpass: 560, drive: 2.4 });
    this.mechClick(0.016, 0.013);
  }

  private machineGun() {
    for (let i = 0; i < 3; i++) {
      const d = i * 0.032;
      this.noise(0.026, 0.058, { tone: 'crackle', highpass: 720, lowpass: this.vary(4400, 0.16), drive: 4.4, delay: d });
      this.noise(0.044, 0.018, { tone: 'brown', highpass: 64, lowpass: 390, drive: 2.6, delay: d });
    }
  }

  private sniper() {
    this.noise(0.038, 0.135, { tone: 'crackle', highpass: 780, lowpass: 6800, drive: 5.8, tail: 0.16 });
    this.noise(0.24, 0.04, { tone: 'brown', highpass: 82, lowpass: 720, drive: 2.8, delay: 0.025, tail: 0.22 });
    this.sub(72, 0.12, 0.035);
    this.mechClick(0.09, 0.018);
  }

  private rocketLaunch() {
    this.noise(0.2, 0.084, { tone: 'brown', highpass: 72, lowpass: 1500, drive: 3.4 });
    this.noise(0.28, 0.044, { tone: 'white', bandpass: 1220, q: 3.6, drive: 2.8, delay: 0.035 });
    this.noise(0.1, 0.034, { tone: 'crackle', highpass: 880, lowpass: 3800, drive: 3.4 });
    this.sub(64, 0.16, 0.045);
  }

  private cannon(heavy: boolean) {
    this.noise(heavy ? 0.18 : 0.13, heavy ? 0.16 : 0.12, {
      tone: 'brown',
      highpass: heavy ? 28 : 45,
      lowpass: heavy ? 760 : 1050,
      drive: heavy ? 4.6 : 3.7,
      tail: heavy ? 0.2 : 0.12,
    });
    this.sub(heavy ? this.vary(41) : this.vary(58), heavy ? 0.56 : 0.38, heavy ? 0.2 : 0.135);
    this.noise(0.085, heavy ? 0.065 : 0.048, { tone: 'crackle', highpass: 610, lowpass: 2800, drive: 3.7, delay: 0.018 });
    this.noise(heavy ? 0.55 : 0.32, heavy ? 0.042 : 0.031, {
      tone: 'brown',
      highpass: 38,
      lowpass: heavy ? 280 : 420,
      drive: 1.8,
      delay: heavy ? 0.16 : 0.11,
      tail: 0.26,
    });
  }

  private flak() {
    for (let i = 0; i < 2; i++) {
      this.noise(0.032, 0.062, { tone: 'crackle', highpass: 880, lowpass: 3900, drive: 4.5, delay: i * 0.04 });
      this.noise(0.05, 0.02, { tone: 'brown', highpass: 70, lowpass: 340, drive: 2.6, delay: i * 0.04 });
    }
  }

  private bombDrop() {
    this.noise(0.45, 0.044, { tone: 'white', bandpass: 720, q: 5.5, drive: 1.6 });
    this.noise(0.16, 0.026, { tone: 'brown', highpass: 55, lowpass: 380, drive: 2.2, delay: 0.1 });
  }

  private shotSound(kind: WeaponKind = 'bullet') {
    switch (kind) {
      case 'bullet': this.rifleShot(); break;
      case 'mg': this.machineGun(); break;
      case 'sniper': this.sniper(); break;
      case 'ap': this.rocketLaunch(); break;
      case 'shell': this.cannon(false); break;
      case 'arty': this.cannon(true); break;
      case 'flak': this.flak(); break;
      case 'bomb': this.bombDrop(); break;
    }
  }

  // --------------------------------------------------------- explosions/état

  private explosion(large: boolean) {
    if (large) {
      this.noise(1.05, 0.25, { tone: 'brown', highpass: 20, lowpass: 450, drive: 5, tail: 0.26 });
      this.sub(this.vary(34), 0.95, 0.22);
      this.noise(0.2, 0.1, { tone: 'crackle', highpass: 600, lowpass: 3300, drive: 4.5, delay: 0.08 });
      this.noise(0.18, 0.06, { tone: 'crackle', highpass: 820, lowpass: 4200, drive: 4.8, delay: 0.24 });
      this.noise(0.72, 0.04, { tone: 'brown', highpass: 35, lowpass: 250, drive: 2, delay: 0.34, tail: 0.32 });
      this.combatHeat = Math.min(1, this.combatHeat + 0.38);
    } else {
      this.noise(0.42, 0.145, { tone: 'brown', highpass: 30, lowpass: this.vary(690, 0.2), drive: 4.4, tail: 0.13 });
      this.sub(this.vary(54), 0.38, 0.118);
      this.noise(0.12, 0.055, { tone: 'crackle', highpass: 720, lowpass: 3200, drive: 4, delay: 0.055 });
      this.combatHeat = Math.min(1, this.combatHeat + 0.18);
    }
    this.applyVolumes();
  }

  private constructionStart() {
    this.noise(0.13, 0.058, { tone: 'brown', highpass: 42, lowpass: 360, drive: 2.6 });
    this.mechClick(0.02, 0.024);
    this.noise(0.09, 0.022, { tone: 'crackle', highpass: 900, lowpass: 2700, drive: 2.7, delay: 0.075 });
  }

  private constructionDone() {
    this.noise(0.06, 0.048, { tone: 'crackle', highpass: 700, lowpass: 2400, drive: 2.7 });
    this.noise(0.12, 0.028, { tone: 'brown', highpass: 55, lowpass: 420, drive: 2.1, delay: 0.08 });
    this.mechClick(0.18, 0.022);
  }

  private trained(unit?: keyof typeof UNITS) {
    const def = unit ? UNITS[unit] : undefined;
    if (def?.isAir) {
      this.aircraftPass(0.72, 0.06);
      this.mechClick(0.18, 0.015);
    } else if (def && def.armor !== 'inf') {
      this.vehicleRumble(1, 0.11);
      this.mechClick(0.16, 0.02);
    } else {
      this.noise(0.05, 0.024, { tone: 'crackle', highpass: 850, lowpass: 2600, drive: 2.4 });
      this.mechClick(0.045, 0.017);
    }
  }

  private takeoff() {
    this.aircraftPass(1.0, 0.09);
    this.noise(0.22, 0.035, { tone: 'crackle', highpass: 1200, lowpass: 5200, drive: 2.2, delay: 0.28 });
  }

  private alert() {
    this.noise(0.08, 0.055, { tone: 'crackle', highpass: 820, lowpass: 2800, drive: 3.2 });
    this.noise(0.42, 0.052, { tone: 'brown', bandpass: 480, q: 5, drive: 2.4, delay: 0.06 });
    this.noise(0.08, 0.042, { tone: 'crackle', highpass: 820, lowpass: 2800, drive: 3.2, delay: 0.48 });
    this.noise(0.36, 0.038, { tone: 'brown', bandpass: 360, q: 5, drive: 2.2, delay: 0.54 });
  }

  private lowPower() {
    this.noise(0.46, 0.04, { tone: 'brown', highpass: 38, lowpass: 210, drive: 2.6 });
    this.noise(0.08, 0.026, { tone: 'crackle', bandpass: 430, q: 5, drive: 2.8, delay: 0.36 });
  }

  // ------------------------------------------------------------- véhicules

  private vehicleRumble(scale: number, vol = 0.05) {
    this.noise(0.42, vol * scale, { tone: 'brown', highpass: 28, lowpass: 180, drive: 2.4 });
    this.noise(0.08, vol * 0.35 * scale, { tone: 'crackle', bandpass: 520, q: 4, drive: 2.6, delay: 0.11 });
    this.noise(0.08, vol * 0.28 * scale, { tone: 'crackle', bandpass: 460, q: 4, drive: 2.4, delay: 0.26 });
  }

  private aircraftPass(scale: number, vol = 0.045) {
    this.noise(0.72, vol * scale, { tone: 'brown', highpass: 105, lowpass: 980, drive: 2.1 });
    this.noise(0.45, vol * 0.55 * scale, { tone: 'white', bandpass: 1450, q: 4.2, drive: 1.8, delay: 0.08 });
  }

  updateRuntime(game: Game, dt: number) {
    if (!this.ctx || this.muted) return;
    this.combatHeat = Math.max(0, this.combatHeat - dt * 0.1);
    this.applyVolumes();

    const t = this.ctx.currentTime;
    let movingArmor = 0;
    let aircraft = 0;
    for (const u of game.units) {
      if (u.dead || !game.isVisibleTo(0, u.x, u.y)) continue;
      const def = UNITS[u.type];
      if (def.isAir && u.airState === 'fly') aircraft++;
      if (!def.isAir && def.armor !== 'inf' && u.order.kind !== 'idle') movingArmor++;
    }
    if (movingArmor > 0 && t - this.lastVehicle > 0.9) {
      this.lastVehicle = t;
      this.vehicleRumble(Math.min(1.25, 0.55 + movingArmor * 0.12), 0.032);
    }
    if (aircraft > 0 && t - this.lastAircraft > 1.35) {
      this.lastAircraft = t;
      this.aircraftPass(Math.min(1.15, 0.65 + aircraft * 0.16), 0.032);
    }
  }

  // ---------------------------------------------------------- ambiance musique
  //
  // Underscore militaire moderne en ré mineur : nappe de sub-basses et drones
  // sombres, pouls sourd, cadence de caisse claire (flas, roulements), fûts
  // de guerre (taikos), ping sonar et appels de cors lointains. Quatre
  // mouvements de 16 s tournent en boucle — veille, mobilisation, offensive,
  // redéploiement — et l'intensité suit la chaleur du combat. Tout reste
  // discret : la musique soutient, les tirs et alertes passent au-dessus.

  private startMusic() {
    if (!this.ctx || !this.musicBus || typeof window === 'undefined' || this.musicTimer !== null) return;
    const schedule = () => {
      if (!this.ctx || !this.musicBus) return;
      const now = this.ctx.currentTime;
      if (now + 0.8 >= this.nextMusicAt) {
        const start = Math.max(now + 0.08, this.nextMusicAt);
        this.scheduleWarSection(start);
        this.nextMusicAt = start + 16;
      }
      this.musicTimer = window.setTimeout(schedule, 700);
    };
    this.nextMusicAt = this.ctx.currentTime + 0.2;
    schedule();
  }

  private scheduleWarSection(start: number) {
    if (!this.ctx || !this.musicBus) return;
    const movement = Math.floor(this.musicStep / 2) % 4;
    this.scheduleWarBar(start, movement, false);
    this.scheduleWarBar(start + 8, movement, true);
    this.musicStep += 2;
  }

  // Une mesure = 8 s = 16 pas de 0,5 s. Tout est calé sur cette grille.
  private scheduleWarBar(start: number, movement: number, half: boolean) {
    if (!this.ctx || !this.musicBus) return;
    const heat = Math.min(1, this.combatHeat + (movement === 2 ? 0.15 : 0));
    const s = (slot: number) => start + slot * 0.5;
    // gamme : ré mineur grave
    const D1 = 36.7, Eb1 = 38.9, A1 = 55, Bb1 = 58.27, C2 = 65.4, D2 = 73.4;
    const C3 = 130.8, D3 = 146.8, F3 = 174.6;

    // ---- lit de fond permanent
    this.musicDrone(start, 8.6, 0.015 + heat * 0.006 + movement * 0.001, movement === 2 || (movement === 3 && !half));

    // ---- pouls sourd (le cœur de la guerre)
    for (const sl of [0, 4, 8, 12]) this.musicHeartbeat(s(sl), 0.026 + heat * 0.008);
    if (movement >= 1 || heat > 0.3) {
      for (const sl of [6, 14]) this.musicHeartbeat(s(sl), 0.012 + heat * 0.005);
    }

    switch (movement) {
      // ===== veille : tension calme, on construit la base
      case 0: {
        if (!half) this.musicDrop(start, 0.038 + heat * 0.012);
        this.musicBass(s(0), D2, 0.03, 0.9);
        this.musicBass(s(6), D2, 0.024, 0.42);
        this.musicBass(s(8), C2, 0.028, 0.9);
        this.musicBass(s(14), Bb1, 0.024, 0.7);
        this.musicTaiko(s(0), 0.03 + heat * 0.01);
        this.musicTaiko(s(8), 0.026 + heat * 0.009);
        for (const sl of [3, 7, 11, 15]) this.musicTick(s(sl), 0.0045 + heat * 0.003);
        this.musicPing(s(half ? 13 : 5), half ? 440 : 587.3, 0.009);
        this.musicGhost(s(7.5), 0.007);
        this.musicGhost(s(15.5), 0.008);
        break;
      }

      // ===== mobilisation : la cadence militaire s'installe
      case 1: {
        const bass: [number, number, number][] = [
          [0, D2, 0.034], [3, D2, 0.026], [6, Bb1, 0.028],
          [8, D2, 0.034], [11, C2, 0.028], [14, A1, 0.026],
        ];
        for (const [sl, f, v] of bass) this.musicBass(s(sl), f, v + heat * 0.008, 0.46);
        this.musicRuff(s(0), 0.02 + heat * 0.008);
        this.musicRuff(s(8), 0.02 + heat * 0.008);
        for (const sl of [2, 4, 5, 7, 10, 13]) this.musicGhost(s(sl), 0.0065 + heat * 0.004);
        this.musicRoll(s(15), 4, 0.5, 0.011 + heat * 0.006);
        this.musicTaiko(s(0), 0.034 + heat * 0.012);
        this.musicTaiko(s(8), 0.034 + heat * 0.012);
        this.musicTaiko(s(12), 0.024 + heat * 0.009);
        for (let sl = 1; sl < 16; sl += 2) this.musicTick(s(sl), 0.004 + heat * 0.0025);
        this.musicPing(s(9), half ? 698.5 : 587.3, 0.008);
        if (half) this.musicHorn(s(0), D3, 0.011 + heat * 0.004, 2.2);
        break;
      }

      // ===== offensive : percussions pleines, cors de guerre, basse en croches
      case 2: {
        if (!half) this.musicDrop(start, 0.05 + heat * 0.014);
        for (let sl = 0; sl < 16; sl++) {
          const strong = sl % 4 === 0;
          const f = sl < 8 ? D2 : sl < 12 ? C2 : sl < 14 ? Bb1 : A1;
          this.musicBass(s(sl), strong ? f * 0.5 : f, (strong ? 0.034 : 0.02) + heat * 0.009, 0.4);
        }
        this.musicRuff(s(4), 0.021 + heat * 0.009);
        this.musicRuff(s(12), 0.021 + heat * 0.009);
        this.musicSnareM(s(4), 0.02 + heat * 0.009);
        this.musicSnareM(s(12), 0.022 + heat * 0.01);
        for (const sl of [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14]) this.musicGhost(s(sl), 0.007 + heat * 0.005);
        if (half) this.musicRoll(s(14), 7, 1.0, 0.013 + heat * 0.007);
        this.musicTaiko(s(0), 0.038 + heat * 0.014);
        this.musicTaiko(s(6), 0.026 + heat * 0.01);
        this.musicTaiko(s(8), 0.038 + heat * 0.014);
        this.musicTaiko(s(14), 0.028 + heat * 0.01);
        if (heat > 0.6) this.musicTaiko(s(8.25), 0.02);
        for (let sl = 1; sl < 16; sl += 2) this.musicTick(s(sl), 0.005 + heat * 0.003);
        // appels de cors : on prépare l'assaut
        if (!half) {
          this.musicHorn(s(0), D3, 0.013 + heat * 0.005, 2.5);
          this.musicHorn(s(8), F3, 0.012 + heat * 0.005, 2.0);
        } else {
          this.musicHorn(s(0), C3, 0.012 + heat * 0.005, 2.0);
          this.musicHorn(s(6), D3, 0.014 + heat * 0.005, 3.0);
        }
        break;
      }

      // ===== redéploiement : retombée, échos lointains, retour de la veille
      case 3: {
        if (!half) {
          this.musicBass(s(0), D2, 0.03, 1.6);
          this.musicBass(s(8), A1, 0.026, 1.6);
        } else {
          this.musicBass(s(0), Bb1, 0.028, 1.4);
          this.musicBass(s(8), C2, 0.026, 1.0);
          this.musicBass(s(14), D2, 0.03, 0.8);
        }
        this.musicTaiko(s(0), 0.026 + heat * 0.01);
        // grondements lointains (artillerie au loin)
        this.musicRumble(s(4), 0.01 + heat * 0.004);
        this.musicRumble(s(12), 0.009 + heat * 0.004);
        this.musicPing(s(3), 587.3, 0.009);
        this.musicPing(s(3.5), 440, 0.006);
        if (half) this.musicPing(s(11), 698.5, 0.008);
        this.musicGhost(s(7.5), 0.006);
        this.musicGhost(s(15.5), 0.007);
        if (half) {
          this.musicRiser(s(12), 2.0, 0.012 + heat * 0.005);
          this.musicRuff(s(15.5), 0.014);
        }
        break;
      }
    }

    // ---- surcouche de combat : la bataille densifie la cadence
    if (heat > 0.45) {
      for (const sl of [2.25, 6.25, 10.25, 14.25]) this.musicGhost(s(sl), 0.006 + heat * 0.004);
      this.musicTaiko(s(10), 0.018 + heat * 0.008);
    }
    if (heat > 0.75) {
      this.musicSnareM(s(2), 0.014);
      this.musicSnareM(s(10), 0.014);
      // sirène très lointaine, étouffée — l'alerte au front
      if (!half) this.tone(392, 1.6, 0.005, {
        type: 'triangle', lowpass: 700, attack: 0.7, release: 0.7, slide: 24,
        delay: this.atDelay(s(11)), out: this.musicBus,
      });
    }
  }

  private atDelay(at: number) {
    return Math.max(0, at - (this.ctx?.currentTime ?? 0));
  }

  // ---- nappe de fond : sub + drones détunés + souffle + air (option : dissonance)
  private musicDrone(at: number, dur: number, vol: number, dark: boolean) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    this.tone(36.7, dur, vol * 0.6, { type: 'sine', lowpass: 110, attack: 0.8, release: 1.2, delay: d, out: this.musicBus });
    this.tone(73.4, dur, vol * 0.28, { type: 'sawtooth', lowpass: 200, drive: 1.3, attack: 1.0, release: 1.4, delay: d, out: this.musicBus });
    this.tone(73.9, dur, vol * 0.2, { type: 'sawtooth', lowpass: 185, attack: 1.4, release: 1.4, delay: d, out: this.musicBus });
    this.tone(55, dur * 0.8, vol * 0.18, { type: 'triangle', lowpass: 240, attack: 1.6, release: 1.6, delay: d + 0.8, out: this.musicBus });
    this.noise(dur, vol * 0.7, { tone: 'brown', highpass: 22, lowpass: 130, drive: 1.5, attack: 1.2, delay: d, out: this.musicBus });
    // air lointain, très discret : le « ciel » au-dessus du champ de bataille
    this.noise(dur, vol * 0.09, { tone: 'brown', highpass: 1400, lowpass: 2900, attack: 2.4, delay: d, out: this.musicBus });
    if (dark) {
      // seconde mineure sourde contre la fondamentale : malaise permanent
      this.tone(38.9, dur * 0.9, vol * 0.16, { type: 'sine', lowpass: 100, attack: 2.0, release: 1.6, delay: d + 0.5, out: this.musicBus });
    }
  }

  // ---- pouls sourd : battement de cœur grave
  private musicHeartbeat(at: number, vol: number) {
    if (!this.musicBus) return;
    this.tone(44, 0.2, vol, { type: 'sine', slide: -10, attack: 0.008, release: 0.09, delay: this.atDelay(at), out: this.musicBus });
  }

  // ---- chute de sub : marque le départ d'un mouvement
  private musicDrop(at: number, vol: number) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    this.tone(58, 0.9, vol, { type: 'sine', slide: -32, attack: 0.01, release: 0.35, delay: d, out: this.musicBus });
    this.noise(0.5, vol * 0.7, { tone: 'brown', highpass: 22, lowpass: 150, drive: 2.6, delay: d, out: this.musicBus });
  }

  // ---- ostinato de basse feutré : senti plus qu'entendu
  private musicBass(at: number, freq: number, vol: number, len: number) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    this.tone(freq, len, vol, { type: 'sine', lowpass: 240, attack: 0.02, release: 0.1, delay: d, out: this.musicBus });
    this.tone(freq * 2, len * 0.9, vol * 0.4, { type: 'triangle', lowpass: 330, drive: 1.2, attack: 0.02, release: 0.09, delay: d, out: this.musicBus });
  }

  // ---- fût de guerre (taiko) : frappe profonde
  private musicTaiko(at: number, vol: number) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    this.noise(0.22, vol, { tone: 'brown', highpass: 26, lowpass: 240, drive: 2.6, delay: d, out: this.musicBus });
    this.tone(58, 0.2, vol * 0.66, { type: 'sine', slide: -18, attack: 0.006, release: 0.08, delay: d, out: this.musicBus });
  }

  // ---- caisse claire militaire
  private musicSnareM(at: number, vol: number) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    this.noise(0.075, vol, { tone: 'crackle', highpass: 900, lowpass: 3200, drive: 2.4, delay: d, out: this.musicBus });
    this.noise(0.13, vol * 0.4, { tone: 'brown', bandpass: 230, q: 3, drive: 1.8, delay: d, out: this.musicBus });
  }

  // ---- note fantôme : frappe de caisse étouffée (la trame de la cadence)
  private musicGhost(at: number, vol: number) {
    if (!this.musicBus) return;
    this.noise(0.045, vol, { tone: 'crackle', highpass: 1100, lowpass: 2800, drive: 1.8, delay: this.atDelay(at), out: this.musicBus });
  }

  // ---- fla militaire : deux frappes fantômes puis l'accent
  private musicRuff(at: number, vol: number) {
    this.musicGhost(at - 0.11, vol * 0.4);
    this.musicGhost(at - 0.055, vol * 0.55);
    this.musicSnareM(at, vol);
  }

  // ---- roulement : frappes resserrées en crescendo
  private musicRoll(at: number, n: number, dur: number, vol: number) {
    for (let i = 0; i < n; i++) {
      const f = i / Math.max(1, n - 1);
      this.musicGhost(at + f * dur, vol * (0.4 + 0.6 * f));
    }
  }

  // ---- tic discret : l'horloge de l'état-major
  private musicTick(at: number, vol: number) {
    if (!this.musicBus) return;
    this.noise(0.018, vol, { tone: 'crackle', highpass: 3200, lowpass: 6800, drive: 1.4, delay: this.atDelay(at), out: this.musicBus });
  }

  // ---- ping sonar/radar : la signature « futuriste » de la veille
  private musicPing(at: number, freq: number, vol: number) {
    if (!this.musicBus) return;
    this.tone(freq, 0.12, vol, {
      type: 'sine', lowpass: 3600, attack: 0.004, release: 0.85,
      delay: this.atDelay(at), out: this.musicBus,
    });
  }

  // ---- appel de cor lointain : empilement quinte/octave à attaque lente
  private musicHorn(at: number, freq: number, vol: number, dur: number) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    const a = dur * 0.32;
    this.tone(freq, dur, vol, { type: 'sawtooth', lowpass: 460, drive: 1.6, attack: a, release: 0.7, delay: d, out: this.musicBus });
    this.tone(freq * 1.498, dur * 0.92, vol * 0.5, { type: 'sawtooth', lowpass: 430, drive: 1.4, attack: a * 1.1, release: 0.7, delay: d + 0.06, out: this.musicBus });
    this.tone(freq * 0.5, dur, vol * 0.55, { type: 'triangle', lowpass: 300, attack: a, release: 0.8, delay: d, out: this.musicBus });
  }

  // ---- grondement lointain : artillerie derrière l'horizon
  private musicRumble(at: number, vol: number) {
    if (!this.musicBus) return;
    this.noise(2.8, vol, { tone: 'brown', highpass: 20, lowpass: 110, drive: 1.8, attack: 1.4, delay: this.atDelay(at), out: this.musicBus });
  }

  // ---- montée de tension : souffle qui enfle vers le mouvement suivant
  private musicRiser(at: number, dur: number, vol: number) {
    if (!this.musicBus) return;
    const d = this.atDelay(at);
    this.noise(dur, vol, { tone: 'brown', highpass: 240, lowpass: 1900, attack: dur * 0.85, delay: d, out: this.musicBus });
    this.tone(62, dur, vol * 0.7, { type: 'sawtooth', lowpass: 420, drive: 1.6, attack: dur * 0.8, release: 0.2, slide: 46, delay: d, out: this.musicBus });
  }

  // --------------------------------------------------------------- événements

  handle(events: GameEvent[], now: number, isAudible: (x: number, y: number) => boolean) {
    if (!this.ctx || this.muted) return;
    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          if (e.x === undefined || !isAudible(e.x, e.y!)) break;
          const kind = e.kind ?? 'bullet';
          const last = this.shotT[kind] ?? -100;
          const gap = SHOT_GAP[kind] ?? 0.08;
          if (now - last >= gap) {
            this.shotT[kind] = now;
            this.shotSound(kind);
            this.combatHeat = Math.min(1, this.combatHeat + (kind === 'bullet' || kind === 'mg' ? 0.035 : 0.09));
            this.applyVolumes();
          }
          break;
        }
        case 'explosion':
          if (now - this.lastExplosion > 0.085 && e.x !== undefined && isAudible(e.x, e.y!)) {
            this.lastExplosion = now;
            this.explosion(false);
          }
          break;
        case 'bigboom':
          if (now - this.lastBigBoom > 0.24 && e.x !== undefined && isAudible(e.x, e.y!)) {
            this.lastBigBoom = now;
            this.explosion(true);
          }
          break;
        case 'place':
          if (e.owner === 0) this.constructionStart();
          break;
        case 'built':
          if (e.owner === 0) this.constructionDone();
          break;
        case 'trained':
          if (e.owner === 0) this.trained(e.unit);
          break;
        case 'takeoff':
          if (now - this.lastTakeoff > 1 && (e.owner === 0 || (e.x !== undefined && isAudible(e.x, e.y!)))) {
            this.lastTakeoff = now;
            this.takeoff();
          }
          break;
        case 'research':
          if (e.owner === 0) {
            this.noise(0.08, 0.028, { tone: 'crackle', highpass: 900, lowpass: 2800, drive: 2.1 });
            this.noise(0.2, 0.022, { tone: 'brown', highpass: 70, lowpass: 430, drive: 1.8, delay: 0.08 });
            this.mechClick(0.22, 0.018);
          }
          break;
        case 'alert':
          if (e.owner === 0) this.alert();
          break;
        case 'lowpower':
          if (e.owner === 0) this.lowPower();
          break;
        case 'eliminated':
          this.noise(1.3, 0.16, { tone: 'brown', highpass: 24, lowpass: 260, drive: 3.4, tail: 0.3 });
          this.sub(38, 1.1, 0.13);
          this.noise(0.38, 0.035, { tone: 'crackle', highpass: 600, lowpass: 2600, drive: 2.7, delay: 0.28 });
          this.combatHeat = 1;
          this.applyVolumes();
          break;
      }
    }
  }
}
