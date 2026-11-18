import { performance } from 'node:perf_hooks';

/** Process-local active time. Only the trusted scheduler may pause this clock. */
export class ExecutionBudget {
  private remaining: number;
  private since = performance.now();
  private timer?: ReturnType<typeof setTimeout>;
  private waiting = false;
  private disposed = false;
  constructor(milliseconds: number, private expire: () => void) {
    this.remaining = Math.max(0, milliseconds); this.arm();
  }
  milliseconds() { return Math.max(0, this.remaining - (this.waiting || this.disposed ? 0 : Math.max(0, performance.now() - this.since))); }
  pause() {
    if (this.disposed || this.waiting) throw new Error('Execution queue clock is no longer active');
    this.remaining = this.milliseconds(); clearTimeout(this.timer); this.waiting = true;
    if (this.remaining <= 0) { this.expire(); throw new Error('Run call or time limit reached'); }
  }
  resume() {
    if (this.disposed || !this.waiting) return;
    this.waiting = false; this.since = performance.now(); this.arm();
  }
  private arm() { this.timer = setTimeout(this.expire, this.remaining); }
  dispose() { this.remaining = this.milliseconds(); clearTimeout(this.timer); this.disposed = true; }
}
