import type {
  DevLifecycleState,
  DevSignalController,
  DevSignalRecord,
} from "./control.js";

export const DEV_AUTOPLAY_SCENARIOS = [
  "TP3",
  "STOP_AFTER_ENTRY",
  "STOP_AFTER_TP1",
  "STOP_AFTER_TP2",
] as const;

export type DevAutoplayScenario = (typeof DEV_AUTOPLAY_SCENARIOS)[number];

export type DevAutoplayOptions = Readonly<{
  delayMs: number;
}>;

type ControllerPort = Pick<
  DevSignalController,
  "get" | "next" | "stop"
>;

type Sleep = (milliseconds: number) => Promise<void>;

const MAX_DELAY_MS = 60_000;

export function assertDevAutoplayDelay(delayMs: number): void {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    throw new Error(`Autoplay delayMs must be an integer between 0 and ${MAX_DELAY_MS}.`);
  }
}

function terminalTarget(scenario: DevAutoplayScenario): DevLifecycleState {
  return scenario === "TP3" ? "TP3_REACHED" : "STOP_REACHED";
}

function stopFromState(scenario: DevAutoplayScenario): DevLifecycleState | null {
  switch (scenario) {
    case "STOP_AFTER_ENTRY":
      return "ENTRY_REACHED";
    case "STOP_AFTER_TP1":
      return "TP1_REACHED";
    case "STOP_AFTER_TP2":
      return "TP2_REACHED";
    case "TP3":
      return null;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class DevAutoplayService {
  readonly #controller: ControllerPort;
  readonly #sleep: Sleep;
  readonly #inFlight = new Set<string>();

  constructor(controller: ControllerPort, sleep: Sleep = defaultSleep) {
    this.#controller = controller;
    this.#sleep = sleep;
  }

  isRunning(signalId: string): boolean {
    return this.#inFlight.has(signalId);
  }

  async run(
    signalId: string,
    scenario: DevAutoplayScenario,
    options: DevAutoplayOptions,
  ): Promise<DevSignalRecord> {
    assertDevAutoplayDelay(options.delayMs);

    if (this.#inFlight.has(signalId)) {
      throw new Error(`Autoplay already running for ${signalId}.`);
    }

    const initial = this.#controller.get(signalId);
    if (!initial) {
      throw new Error(`Unknown DEV signal: ${signalId}`);
    }
    if (initial.state !== "PUBLISHED" || initial.terminal) {
      throw new Error(`Autoplay requires PUBLISHED non-terminal signal: ${signalId}.`);
    }

    this.#inFlight.add(signalId);
    try {
      const stopAt = stopFromState(scenario);

      while (true) {
        const current = this.#controller.get(signalId);
        if (!current) {
          throw new Error(`Unknown DEV signal: ${signalId}`);
        }

        if (current.terminal) {
          if (current.state !== terminalTarget(scenario)) {
            throw new Error(`Autoplay reached unexpected terminal state ${current.state}.`);
          }
          return current;
        }

        if (stopAt !== null && current.state === stopAt) {
          await this.#sleep(options.delayMs);
          return await this.#controller.stop(signalId);
        }

        await this.#sleep(options.delayMs);
        const advanced = await this.#controller.next(signalId);

        if (advanced.terminal) {
          if (advanced.state !== terminalTarget(scenario)) {
            throw new Error(`Autoplay reached unexpected terminal state ${advanced.state}.`);
          }
          return advanced;
        }
      }
    } finally {
      this.#inFlight.delete(signalId);
    }
  }
}
