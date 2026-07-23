/**
 * Qdrant collection names for PCE RAG.
 * Production uses the default; tests and scripts use dedicated collections
 * so they never pollute or clear the main store.
 */

export const DEFAULT_COLLECTION =
  process.env.PCE_COLLECTION_NAME || "pce_documents";

/** Used by unit/integration tests. */
export const TEST_COLLECTION = "pce_documents_test";

/** Used by run-provenance-audit.ts. */
export const AUDIT_COLLECTION = "pce_documents_audit";

/** Used by run-gold-path.ts. */
export const GOLDPATH_COLLECTION = "pce_documents_goldpath";
