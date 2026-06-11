// Sons synthétisés via WebAudio : aucun fichier audio nécessaire.
// Chaque famille d'événement a sa propre signature sonore.
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
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private beep(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(28, freq + slide), t + dur);
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

  // ------------------------------------------------------------- interface UI

  click() { this.ensure(); this.beep(900, 0.04, 'square', 0.04); }
  order() { this.ensure(); this.beep(620, 0.06, 'square', 0.05, 140); this.beep(840, 0.05, 'square', 0.03, 80, 0.05); }
  error() { this.ensure(); this.beep(170, 0.16, 'sawtooth', 0.07, -60); }

  // ------------------------------------------------------------- tirs par arme

  private shotSound(kind?: string) {
    switch (kind) {
      case 'sniper':
        this.noise(0.07, 0.06, 3500, 900);
        this.beep(1400, 0.05, 'square', 0.025, -800);
        break;
      case 'ap':
        this.noise(0.1, 0.05, 1200, 200, 0, -600);
        this.beep(220, 0.09, 'sawtooth', 0.04, -90);
        break;
      case 'shell':
        this.noise(0.12, 0.07, 900, 80);
        this.beep(120, 0.12, 'sine', 0.07, -50);
        break;
      case 'arty':
        this.noise(0.22, 0.09, 500, 50);
        this.beep(75, 0.22, 'sine', 0.09, -25);
        break;
      case 'flak':
        this.beep(520, 0.06, 'square', 0.045, -260);
        this.noise(0.05, 0.035, 2400, 500);
        break;
      case 'bomb':
        this.noise(0.3, 0.06, 700, 60, 0, -500); // sifflement de chute
        break;
      default: // bullet / mg
        this.noise(0.045, 0.035, 2600, 700);
        this.beep(340 + Math.random() * 160, 0.04, 'square', 0.02, -140);
    }
  }

  // --------------------------------------------------------------- événements

  handle(events: GameEvent[], now: number, isAudible: (x: number, y: number) => boolean) {
    if (!this.ctx || this.muted) return;
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          if (now - this.lastShot > 0.06 && e.x !== undefined && isAudible(e.x, e.y!)) {
            this.lastShot = now;
            this.shotSound(e.kind);
          }
          break;
        case 'explosion':
          if (now - this.lastExplosion > 0.1 && e.x !== undefined && isAudible(e.x, e.y!)) {
            this.lastExplosion = now;
            this.noise(0.3, 0.1, 650, 40, 0, -450);
            this.beep(95, 0.22, 'sine', 0.07, -55);
          }
          break;
        case 'bigboom':
          if (e.x !== undefined && isAudible(e.x, e.y!)) {
            this.noise(0.8, 0.2, 420, 30, 0, -320);
            this.beep(60, 0.65, 'sine', 0.17, -28);
            this.noise(0.4, 0.08, 1500, 300, 0.08);
          }
          break;
        case 'place':
          if (e.owner === 0) {
            this.noise(0.12, 0.09, 350, 40);
            this.beep(140, 0.1, 'sine', 0.07, -40);
          }
          break;
        case 'built':
          if (e.owner === 0) {
            this.noise(0.05, 0.05, 1800, 600);                 // coup de marteau
            this.beep(520, 0.09, 'sine', 0.07, 0, 0.05);
            this.beep(780, 0.14, 'sine', 0.07, 0, 0.13);
          }
          break;
        case 'trained':
          if (e.owner === 0) {
            const def = e.unit ? UNITS[e.unit] : undefined;
            if (def?.isAir) {
              this.noise(0.4, 0.05, 900, 300, 0, 1800);        // turbine qui monte
              this.beep(880, 0.12, 'triangle', 0.05, 160, 0.1);
            } else if (def && def.armor !== 'inf') {
              this.beep(55, 0.3, 'sawtooth', 0.06, 18);        // moteur diesel
              this.beep(660, 0.09, 'triangle', 0.06, 120, 0.12);
            } else {
              this.beep(660, 0.08, 'triangle', 0.06, 120);     // infanterie prête
              this.beep(880, 0.07, 'triangle', 0.04, 60, 0.07);
            }
          }
          break;
        case 'takeoff':
          if (now - this.lastTakeoff > 1 && (e.owner === 0 || (e.x !== undefined && isAudible(e.x, e.y!)))) {
            this.lastTakeoff = now;
            this.noise(0.55, 0.06, 600, 200, 0, 2400);         // réacteur au décollage
          }
          break;
        case 'research':
          if (e.owner === 0) {
            this.beep(440, 0.1, 'sine', 0.06);
            this.beep(660, 0.1, 'sine', 0.06, 0, 0.09);
            this.beep(880, 0.18, 'sine', 0.06, 0, 0.18);
          }
          break;
        case 'alert':
          if (e.owner === 0) {
            this.beep(820, 0.16, 'square', 0.09, -180);
            this.beep(620, 0.16, 'square', 0.09, -120, 0.18);
            this.beep(820, 0.16, 'square', 0.07, -180, 0.36);
          }
          break;
        case 'lowpower':
          if (e.owner === 0) {
            this.beep(180, 0.35, 'sawtooth', 0.05, -60);
            this.beep(90, 0.35, 'sine', 0.05, -20);
          }
          break;
        case 'eliminated':
          this.noise(1.1, 0.16, 320, 25, 0, -240);
          this.beep(160, 0.9, 'sawtooth', 0.06, -110);
          break;
      }
    }
  }
}
