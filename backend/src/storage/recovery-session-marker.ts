import type { DBTransactionAdapter } from "better-auth";

export async function insertRecoverySessionMarker(
  adapter: DBTransactionAdapter,
  sessionId: string,
  authenticatedAt: Date,
): Promise<void> {
  if (!sessionId || !Number.isFinite(authenticatedAt.getTime()))
    throw new Error("Invalid recovery provenance.");
  const marker = await adapter.create({
    model: "recoverySessionMarker",
    data: { sessionId, authenticatedAt },
  });
  if (!marker) throw new Error("Recovery provenance insertion failed.");
}
