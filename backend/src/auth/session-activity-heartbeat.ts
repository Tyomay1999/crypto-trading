export type SessionActivityTouch =
  (
    sessionId: string,
    observedAt: Date,
  ) => Promise<unknown>;

export type SessionActivityHeartbeatOptions = {
  intervalMs?: number;
  maxTrackedSessions?: number;
};

const DEFAULT_INTERVAL_MS =
  5 * 60 * 1_000;

const DEFAULT_MAX_TRACKED_SESSIONS =
  10_000;

function requirePositiveInteger(
  value: number,
  name: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer.`,
    );
  }
}

export class SessionActivityHeartbeat {
  private readonly touch:
    SessionActivityTouch;

  private readonly intervalMs:
    number;

  private readonly maxTrackedSessions:
    number;

  private readonly nextEligibleAt =
    new Map<string, number>();

  constructor(
    touch: SessionActivityTouch,
    options:
      SessionActivityHeartbeatOptions = {},
  ) {
    this.touch = touch;

    this.intervalMs =
      options.intervalMs ??
      DEFAULT_INTERVAL_MS;

    this.maxTrackedSessions =
      options.maxTrackedSessions ??
      DEFAULT_MAX_TRACKED_SESSIONS;

    requirePositiveInteger(
      this.intervalMs,
      "Session activity interval",
    );

    requirePositiveInteger(
      this.maxTrackedSessions,
      "Maximum tracked sessions",
    );
  }

  async observe(
    sessionId: string,
    observedAt: Date,
  ): Promise<boolean> {
    if (
      sessionId.trim().length === 0
    ) {
      throw new Error(
        "Session ID must not be empty.",
      );
    }

    const observedAtMs =
      observedAt.getTime();

    if (
      Number.isNaN(observedAtMs)
    ) {
      throw new Error(
        "Session activity timestamp must be valid.",
      );
    }

    const currentEligibility =
      this.nextEligibleAt.get(
        sessionId,
      );

    if (
      currentEligibility !== undefined &&
      observedAtMs < currentEligibility
    ) {
      return false;
    }

    const nextEligibility =
      observedAtMs +
      this.intervalMs;

    /*
     * Delete before set so Map insertion order
     * acts as a minimal LRU ordering.
     */
    this.nextEligibleAt.delete(
      sessionId,
    );

    this.nextEligibleAt.set(
      sessionId,
      nextEligibility,
    );

    while (
      this.nextEligibleAt.size >
      this.maxTrackedSessions
    ) {
      const oldest =
        this.nextEligibleAt
          .keys()
          .next()
          .value;

      if (
        typeof oldest !==
        "string"
      ) {
        break;
      }

      this.nextEligibleAt.delete(
        oldest,
      );
    }

    try {
      await this.touch(
        sessionId,
        observedAt,
      );

      return true;
    } catch (error) {
      /*
       * Release only our own gate.
       * A newer concurrent observation may
       * already have installed a later marker.
       */
      if (
        this.nextEligibleAt.get(
          sessionId,
        ) === nextEligibility
      ) {
        this.nextEligibleAt.delete(
          sessionId,
        );
      }

      throw error;
    }
  }
}
