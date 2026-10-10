import type { ProjectionScenario } from "./types.js";

export class ScenarioRegistry {
  readonly #scenarios = new Map<string, ProjectionScenario>();

  register(scenario: ProjectionScenario): void {
    if (this.#scenarios.has(scenario.name)) {
      throw new Error(`Scenario already registered: ${scenario.name}`);
    }
    this.#scenarios.set(scenario.name, structuredClone(scenario));
  }

  get(name: string): ProjectionScenario | null {
    const scenario = this.#scenarios.get(name);
    return scenario === undefined ? null : structuredClone(scenario);
  }

  list(): readonly ProjectionScenario[] {
    return [...this.#scenarios.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((scenario) => structuredClone(scenario));
  }
}
