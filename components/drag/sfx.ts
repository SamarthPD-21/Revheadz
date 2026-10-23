/** Little synthesized drag-strip sounds: tree beeps, the red-light buzzer and the crowd. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Call from a tap or key handler. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.5;
      this.out.connect(this.ctx.destination);
      const n = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine") {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  amber() {
    this.tone(880, 0.09, 0.18, "triangle");
  }
  green() {
    this.tone(1320, 0.28, 0.22, "triangle");
    this.tone(1760, 0.2, 0.08, "sine");
  }
  red() {
    this.tone(150, 0.5, 0.25, "square");
    this.tone(155, 0.5, 0.2, "sawtooth");
  }
  stage() {
    this.tone(520, 0.05, 0.08, "sine");
  }
  good() {
    this.tone(1046, 0.08, 0.1, "sine");
  }

  /** A swell of crowd noise: cheering at the finish, a groan for a red light. */
  crowd(cheer: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = cheer ? 1400 : 500;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(cheer ? 0.28 : 0.16, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (cheer ? 2.6 : 1.4));
    src.connect(bp).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + 2.8);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
