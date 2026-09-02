// Virtual clock: play / pause / step / jump / speed. Everything the app
// renders is a pure function of (event log up to `nowMin`, config) — the
// clock is the only thing that drives time forward.

export class VirtualClock {
  constructor({ dayStartMin, dayEndMin, onTick }) {
    this.dayStartMin = dayStartMin;
    this.dayEndMin = dayEndMin;
    this.nowMin = dayStartMin;
    this.speed = 10; // simulated minutes per real second, default x10
    this.playing = false;
    this.onTick = onTick || (() => {});
    this._raf = null;
    this._lastReal = null;
  }

  _loop = (tReal) => {
    if (!this.playing) return;
    if (this._lastReal == null) this._lastReal = tReal;
    const dtSeconds = (tReal - this._lastReal) / 1000;
    this._lastReal = tReal;
    this.nowMin = Math.min(this.dayEndMin, this.nowMin + dtSeconds * this.speed);
    this.onTick(this.nowMin);
    if (this.nowMin >= this.dayEndMin) {
      this.pause();
      return;
    }
    this._raf = requestAnimationFrame(this._loop);
  };

  play() {
    if (this.playing) return;
    this.playing = true;
    this._lastReal = null;
    this._raf = requestAnimationFrame(this._loop);
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  step(minutes = 1) {
    this.pause();
    this.nowMin = Math.max(this.dayStartMin, Math.min(this.dayEndMin, this.nowMin + minutes));
    this.onTick(this.nowMin);
  }

  jumpTo(min) {
    this.pause();
    this.nowMin = Math.max(this.dayStartMin, Math.min(this.dayEndMin, min));
    this.onTick(this.nowMin);
  }

  setSpeed(mulPerSec) {
    this.speed = mulPerSec;
  }
}
