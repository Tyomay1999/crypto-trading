export const USER_SIGNAL_PARTICIPATION_STATUSES = [
  "FOLLOWING",
  "PLANNED",
  "ACTIVE",
  "EXITED_EARLY",
  "COMPLETED",
  "STOPPED",
  "CANCELLED",
] as const;

export type UserSignalParticipationStatus =
  (typeof USER_SIGNAL_PARTICIPATION_STATUSES)[number];

export interface UserSignalParticipation {
  participationId: string;
  userId: string;
  signalId: string;
  status: UserSignalParticipationStatus;
  subscribedAt: string;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FollowSignalResult =
  | {
      kind: "CREATED";
      participation: UserSignalParticipation;
    }
  | {
      kind: "EXISTING";
      participation: UserSignalParticipation;
    }
  | {
      kind: "SIGNAL_NOT_FOUND";
    };

export type UnfollowSignalResult =
  | {
      kind: "CANCELLED";
      participation: UserSignalParticipation;
    }
  | {
      kind: "NOT_FOUND";
    }
  | {
      kind: "ACTIVE_CONFLICT";
      participation: UserSignalParticipation;
    }
  | {
      kind: "ALREADY_TERMINAL";
      participation: UserSignalParticipation;
    };

export interface ParticipationClock {
  nowIso(): string;
}

export interface ParticipationIdFactory {
  createParticipationId(): string;
}
