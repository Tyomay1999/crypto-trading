import type {
  AccountSnapshotRequest,
  ExchangeAccountSnapshot,
} from "./types.js";

export interface ExchangeAccountSnapshotProvider {
  getSnapshot(request: AccountSnapshotRequest): Promise<ExchangeAccountSnapshot>;
}

function keyOf(request: {
  userId: string;
  exchange: string;
  accountReference: string | null;
  currency: string;
}): string {
  return [
    request.userId,
    request.exchange,
    request.accountReference ?? "",
    request.currency,
  ].join("\u001f");
}

export class DeterministicExchangeAccountSnapshotProvider
  implements ExchangeAccountSnapshotProvider
{
  readonly #snapshots: ReadonlyMap<string, ExchangeAccountSnapshot>;

  constructor(
    fixtures: readonly {
      request: AccountSnapshotRequest;
      snapshot: ExchangeAccountSnapshot;
    }[],
  ) {
    const entries = fixtures.map(({ request, snapshot }) => [
      keyOf(request),
      Object.freeze({ ...snapshot }),
    ] as const);

    this.#snapshots = new Map(entries);
  }

  async getSnapshot(
    request: AccountSnapshotRequest,
  ): Promise<ExchangeAccountSnapshot> {
    const snapshot = this.#snapshots.get(keyOf(request));
    if (!snapshot) {
      throw new Error("Exchange account snapshot fixture is unavailable");
    }

    return { ...snapshot };
  }
}
