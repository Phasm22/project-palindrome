import type { ACLGroup } from "../types";
import type { ApiHistoryEntry, ApiQueryResponse } from "./types";

export class ContextHistoryStore {
  private limit: number;
  private store: Map<string, ApiHistoryEntry[]> = new Map();

  constructor(limit: number = 10) {
    this.limit = limit;
  }

  record(userId: string, query: string, aclGroup: ACLGroup, response: ApiQueryResponse): void {
    if (!userId) {
      return;
    }

    const trimmedUserId = userId.trim();
    if (!trimmedUserId) {
      return;
    }

    const entries = this.store.get(trimmedUserId) || [];
    const newEntry: ApiHistoryEntry = {
      timestamp: new Date().toISOString(),
      query,
      aclGroup,
      response,
    };

    entries.unshift(newEntry);
    if (entries.length > this.limit) {
      entries.pop();
    }

    this.store.set(trimmedUserId, entries);
  }

  getHistory(userId: string): ApiHistoryEntry[] {
    const key = userId?.trim();
    if (!key) {
      return [];
    }
    return this.store.get(key) || [];
  }
}
