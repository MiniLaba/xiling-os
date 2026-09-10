export interface ManagedResource<T> {
  start(): Promise<T> | T;
  stop(value: T): Promise<void> | void;
}

export class LazyResource<T> {
  #value: T | undefined;
  #starting: Promise<T> | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #leases = 0;

  constructor(
    private readonly resource: ManagedResource<T>,
    private readonly idleTimeoutMs = 5 * 60_000,
  ) {}

  get state(): "stopped" | "starting" | "ready" {
    if (this.#value !== undefined) return "ready";
    if (this.#starting) return "starting";
    return "stopped";
  }

  async acquire(): Promise<{ value: T; release: () => void }> {
    this.#cancelIdleStop();
    this.#leases += 1;
    try {
      const value = await this.#ensureStarted();
      let released = false;
      return {
        value,
        release: () => {
          if (released) return;
          released = true;
          this.#leases -= 1;
          this.#scheduleIdleStop();
        },
      };
    } catch (error) {
      this.#leases -= 1;
      throw error;
    }
  }

  async stopNow(): Promise<void> {
    this.#cancelIdleStop();
    const value = this.#value;
    this.#value = undefined;
    this.#starting = undefined;
    if (value !== undefined) await this.resource.stop(value);
  }

  async #ensureStarted(): Promise<T> {
    if (this.#value !== undefined) return this.#value;
    this.#starting ??= Promise.resolve(this.resource.start());
    try {
      this.#value = await this.#starting;
      return this.#value;
    } finally {
      this.#starting = undefined;
    }
  }

  #scheduleIdleStop(): void {
    if (this.#leases !== 0 || this.#value === undefined || this.idleTimeoutMs < 0) return;
    this.#idleTimer = setTimeout(() => void this.stopNow(), this.idleTimeoutMs);
    this.#idleTimer.unref();
  }

  #cancelIdleStop(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}
