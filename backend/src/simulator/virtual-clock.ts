export class VirtualClock {
  #epochMs: number;

  constructor(startTime: string) {
    const parsed = Date.parse(startTime);
    if (!Number.isFinite(parsed)) throw new Error("Invalid virtual clock start time.");
    this.#epochMs = parsed;
  }

  nowEpochMs(): number {
    return this.#epochMs;
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  advanceTo(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < this.#epochMs) {
      throw new Error("Virtual clock cannot move backwards.");
    }
    this.#epochMs = epochMs;
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Invalid virtual clock duration.");
    }
    this.advanceTo(this.#epochMs + milliseconds);
  }
}
