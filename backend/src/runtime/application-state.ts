export type ApplicationPhase =
  | "starting"
  | "ready"
  | "shutting_down";

export class ApplicationState {
  private phase: ApplicationPhase = "starting";

  getPhase(): ApplicationPhase {
    return this.phase;
  }

  isReady(): boolean {
    return this.phase === "ready";
  }

  markReady(): void {
    if (this.phase === "shutting_down") {
      throw new Error(
        "Application cannot become ready while shutting down.",
      );
    }

    this.phase = "ready";
  }

  markShuttingDown(): void {
    this.phase = "shutting_down";
  }
}
