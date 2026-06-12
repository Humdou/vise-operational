// Sons synthétisés via WebAudio : aucun fichier audio nécessaire.
// Mixage à travers un compresseur (rendu plus dense et professionnel),
// variations de hauteur aléatoires, couches + échos pour les détonations.
import { GameEvent } from './engine';
import { UNITS } from './data';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastShot = 0;
  private lastExplosion = 0;
  private lastTakeoff = 0;
  muted = false;

  ensure() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        // compresseur master : colle le mix et évite la saturation
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 18;
        comp.ratio.value = 5;
        comp.attack.value = 0.002;
        comp.release.value = 0.18;
        this.master = this.ctx.createGain();
        this.master.gain.value = 1.0;
        this.master.connect(comp).connect(this.ctx.destination);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // léger désaccord aléatoire : évite l'effet "mitraillette de bips identiques"
  private vary(f: number, amount = 0.1): number {
    return f * (1 + (Math.random() * 2 - 1) * amount);
  }

  private beep(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(26, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur);
  }

  private noise(dur: number, vol: number, lowpass = 800, highpass = 0, delay = 0, slideLp = 0) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    let node: AudioNode = src;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(lowpass, t);
    if (slideLp !== 0) lp.frequency.exponentialRampToValueAtTime(Math.max(60, lowpass + slideLp), t + dur);
    node.connect(lp); node = lp;
    if (highpass > 0) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = highpass;
      node.connect(hp); node = hp;
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    node.connect(g).connect(this.master);
    src.start(t);
  }

  // grondement grave avec attaque franche (canons, explosions)
  private thump(freq: number, dur: number, vol: number, delay = 0) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(24, freq * 0.4), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur);
  }

  // ------------------------------------------------------------- interface UI

  click() { this.ensure(); this.beep(880, 0.035, 'square', 0.035); }
  order() {
    this.ensure();
    this.beep(560, 0.05, 'square', 0.045, 140);
    this.beep(900, 0.06, 'sine', 0.04, 60, 0.045);
  }
  error() { this.ensure(); this.beep(160, 0.14, 'sawtooth', 0.06, -50); this.beep(120, 0.12, 'sawtooth', 0.05, -40, 0.1); }

  // ------------------------------------------------------------- tirs par arme

  private shotSound(kind?: string) {
    switch (kind) {
      case 'sniper':
        // claquement sec, fouet supersonique
        this.noise(0.05, 0.07, 4200, 1200);
        this.noise(0.14, 0.03, 2200, 500, 0.02, -1600);
        this.beep(this.vary(1500), 0.04, 'square', 0.02, -900);
        break;
      case 'ap':
        // départ de roquette : souffle qui file
        this.noise(0.16, 0.055, 1400, 250, 0, -900);
        this.beep(this.vary(240), 0.1, 'sawtooth', 0.035, -110);
        break;
      case 'mg':
        // rafale brève : deux impulsions rapprochées
        this.noise(0.035, 0.035, 2800, 800);
        this.noise(0.035, 0.03, 2600, 800, 0.05);
        break;
      case 'shell':
        // canon de char : claque + grave + écho lointain
        this.noise(0.08, 0.08, 1600, 200);
        this.thump(this.vary(110), 0.18, 0.09);
        this.noise(0.25, 0.02, 500, 60, 0.12);
        break;
      case 'arty':
        // départ d'obusier : très grave, long, écho
        this.noise(0.18, 0.09, 700, 60);
        this.thump(this.vary(70), 0.32, 0.11);
        this.noise(0.4, 0.025, 380, 40, 0.18);
        break;
      case 'flak':
        this.beep(this.vary(520), 0.05, 'square', 0.04, -260);
        this.noise(0.04, 0.03, 2600, 600);
        break;
      case 'bomb':
        // sifflement de chute
        this.noise(0.32, 0.05, 800, 80, 0, -560);
        this.beep(900, 0.3, 'sine', 0.02, -500);
        break;
      default: // bullet
        this.noise(0.04, 0.032, this.vary(2600, 0.2), 700);
        this.beep(this.vary(360), 0.035, 'square', 0.018, -150);
    }
  }

  // --------------------------------------------------------------- événements

  handle(events: GameEvent[], now: number, isAudible: (x: number, y: number) => boolean) {
    if (!this.ctx || this.muted) return;
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          if (now - this.lastShot > 0.055 && e.x !== undefined && isAudible(e.x, e.y!)) {
            this.lastShot = now;
            this.shotSound(e.kind);
          }
          break;
        case 'explosion':
          if (now - this.lastExplosion > 0.09 && e.x !== undefined && isAudible(e.x, e.y!)) {
            this.lastExplosion = now;
            this.noise(0.28, 0.1, this.vary(700, 0.25), 50, 0, -480);
            this.thump(this.vary(90), 0.24, 0.08);
          }
          break;
        case 'bigboom':
          if (e.x !== undefined && isAudible(e.x, e.y!)) {
            // détonation majeure : souffle + sub + crépitement de débris + écho
            this.noise(0.7, 0.2, 460, 30, 0, -340);
            this.thump(58, 0.7, 0.18);
            this.noise(0.12, 0.05, 2400, 700, 0.16);
            this.noise(0.1, 0.04, 2000, 600, 0.3);
            this.noise(0.55, 0.035, 300, 40, 0.34);
          }
          break;
        case 'place':
          if (e.owner === 0) {
            this.noise(0.1, 0.08, 380, 40);
            this.thump(120, 0.12, 0.06);
            this.beep(700, 0.05, 'square', 0.025, 0, 0.1); // servo
          }
          break;
        case 'built':
          if (e.owner === 0) {
            this.noise(0.04, 0.05, 2000, 700);              // marteau 1
            this.noise(0.04, 0.045, 1800, 650, 0.09);       // marteau 2
            this.beep(520, 0.09, 'sine', 0.06, 0, 0.16);
            this.beep(784, 0.14, 'sine', 0.06, 0, 0.24);
          }
          break;
        case 'trained':
          if (e.owner === 0) {
            const def = e.unit ? UNITS[e.unit] : undefined;
            if (def?.isAir) {
              this.noise(0.45, 0.05, 800, 300, 0, 2200);     // turbine qui monte
              this.beep(880, 0.1, 'triangle', 0.045, 160, 0.12);
            } else if (def && def.armor !== 'inf') {
              this.thump(52, 0.28, 0.06);                    // démarrage diesel
              this.noise(0.2, 0.025, 240, 60, 0.05);
              this.beep(660, 0.08, 'triangle', 0.05, 120, 0.18);
            } else {
              this.beep(660, 0.07, 'triangle', 0.05, 120);   // infanterie prête
              this.beep(880, 0.06, 'triangle', 0.04, 60, 0.06);
            }
          }
          break;
        case 'takeoff':
          if (now - this.lastTakeoff > 1 && (e.owner === 0 || (e.x !== undefined && isAudible(e.x, e.y!)))) {
            this.lastTakeoff = now;
            this.noise(0.6, 0.055, 500, 180, 0, 2600);       // réacteur au décollage
            this.beep(160, 0.5, 'sawtooth', 0.02, 480);
          }
          break;
        case 'research':
          if (e.owner === 0) {
            this.beep(440, 0.09, 'sine', 0.05);
            this.beep(660, 0.09, 'sine', 0.05, 0, 0.08);
            this.beep(880, 0.16, 'sine', 0.05, 0, 0.16);
            this.beep(1320, 0.2, 'sine', 0.03, 0, 0.24);
          }
          break;
        case 'alert':
          if (e.owner === 0) {
            // sirène montée-descente, deux cycles
            this.beep(540, 0.3, 'square', 0.07, 320);
            this.beep(860, 0.3, 'square', 0.07, -320, 0.3);
            this.beep(540, 0.26, 'square', 0.05, 320, 0.6);
          }
          break;
        case 'lowpower':
          if (e.owner === 0) {
            this.beep(170, 0.4, 'sawtooth', 0.045, -55);
            this.beep(85, 0.4, 'sine', 0.05, -18);
            this.beep(170, 0.2, 'sawtooth', 0.03, -40, 0.45);
          }
          break;
        case 'eliminated':
          this.noise(1.2, 0.15, 320, 25, 0, -250);
          this.thump(50, 1.0, 0.13);
          this.beep(220, 0.8, 'sawtooth', 0.04, -150, 0.15);
          break;
      }
    }
  }
}
