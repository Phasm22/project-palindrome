import type { OperatorMemoryStore } from "../pce/api/operator-memory-store";

export interface HistoricalScore {
  successRate: number;
  recencyWeight: number;
  confirmationSkipRate: number;
  sampleCount: number;
}

export class HistoricalScorer {
  constructor(private store: OperatorMemoryStore) {}

  getScore(userId: string, intentType: string, actionName?: string): HistoricalScore {
    const profile = this.store.getUserProfile(userId, intentType, actionName);
    if (!profile || profile.totalRuns === 0) {
      return { successRate: 0, recencyWeight: 0, confirmationSkipRate: 0, sampleCount: 0 };
    }

    const successRate = profile.successCount / profile.totalRuns;

    const daysSinceLast = (Date.now() - profile.lastSeen) / (1000 * 60 * 60 * 24);
    const recencyWeight = Math.exp(-daysSinceLast / 7);

    const confirmationSkipRate =
      profile.confirmationRequiredCount > 0
        ? 1 - profile.confirmationGivenCount / profile.confirmationRequiredCount
        : 0;

    return {
      successRate,
      recencyWeight,
      confirmationSkipRate,
      sampleCount: profile.totalRuns,
    };
  }

  hasEnoughData(score: HistoricalScore): boolean {
    return score.sampleCount >= 3;
  }
}
