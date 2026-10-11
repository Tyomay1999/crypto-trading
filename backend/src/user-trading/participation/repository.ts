import type {
  UserSignalParticipation,
  UserSignalParticipationStatus,
} from "./types.js";

export interface CreateParticipationInput {
  participationId: string;
  userId: string;
  signalId: string;
  subscribedAt: string;
}

export interface ParticipationRepository {
  signalExists(signalId: string): Promise<boolean>;

  findLiveByUserSignal(
    userId: string,
    signalId: string,
  ): Promise<UserSignalParticipation | null>;

  findOwnedById(
    userId: string,
    participationId: string,
  ): Promise<UserSignalParticipation | null>;

  tryCreateFollowing(
    input: CreateParticipationInput,
  ): Promise<UserSignalParticipation | null>;

  transitionOwned(
    userId: string,
    participationId: string,
    expectedStatuses: readonly UserSignalParticipationStatus[],
    nextStatus: UserSignalParticipationStatus,
    observedAt: string,
    unsubscribedAt: string | null,
  ): Promise<UserSignalParticipation | null>;
}
