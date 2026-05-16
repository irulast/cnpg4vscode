/**
 * Visibility-aware refresh timer (US3; FR-006).
 *
 * Polls a callback on a configurable interval *only* while the bound tree
 * view is visible AND the editor window is focused. Stops cleanly when
 * either condition is false; resumes when both become true again.
 *
 * The implementation accepts an injectable clock so it can be unit-tested
 * with fake timers — see test/unit/refresh-timer.test.ts.
 */

export interface RefreshTimerOptions {
  /** Interval between ticks, in milliseconds. Clamped to ≥ 5000. */
  intervalMs: number;
  /** Called on each tick. */
  onTick: () => void;
}

export interface RefreshTimerEvents {
  /** Initial view visibility. */
  visible: boolean;
  /** Initial window-focused state. */
  focused: boolean;
}

export interface Clock {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultClock: Clock = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export class RefreshTimer {
  private handle: unknown = null;
  private visible: boolean;
  private focused: boolean;
  private readonly intervalMs: number;
  private readonly onTick: () => void;
  private readonly clock: Clock;

  constructor(opts: RefreshTimerOptions, initial: RefreshTimerEvents, clock: Clock = defaultClock) {
    this.intervalMs = Math.max(5000, opts.intervalMs);
    this.onTick = opts.onTick;
    this.visible = initial.visible;
    this.focused = initial.focused;
    this.clock = clock;
    this.evaluate();
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.evaluate();
  }

  setFocused(v: boolean): void {
    if (this.focused === v) return;
    this.focused = v;
    this.evaluate();
  }

  dispose(): void {
    this.stop();
  }

  /** Exposed for assertions. */
  get isRunning(): boolean {
    return this.handle !== null;
  }

  private evaluate(): void {
    const shouldRun = this.visible && this.focused;
    if (shouldRun && !this.handle) this.start();
    else if (!shouldRun && this.handle) this.stop();
  }

  private start(): void {
    this.handle = this.clock.setInterval(() => this.onTick(), this.intervalMs);
  }

  private stop(): void {
    if (this.handle !== null) {
      this.clock.clearInterval(this.handle);
      this.handle = null;
    }
  }
}
