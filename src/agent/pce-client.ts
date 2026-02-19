import { PCE_API_URL } from "../config/pce";
import type { ApiQueryResponse } from "../pce/api/types";

type PceQueryEnvelope = {
  success?: boolean;
  data?: unknown;
  error?: unknown;
};

function isApiQueryResponse(value: unknown): value is ApiQueryResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.answer === "string" && "context" in record && "sources" in record;
}

export async function queryPCE(userId: string, prompt: string): Promise<ApiQueryResponse> {
  const res = await fetch(`${PCE_API_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      userId, 
      query: prompt, // API expects 'query' not 'prompt'
      aclGroup: "viewer" // default ACL group
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`PCE error: ${res.status} - ${errorText}`);
  }

  const data: unknown = await res.json();
  const envelope = (data && typeof data === "object" ? data : {}) as PceQueryEnvelope;
  
  // Handle API response wrapper
  if (envelope.success === false) {
    throw new Error(`PCE API error: ${String(envelope.error || "Unknown error")}`);
  }

  // API returns { success: true, data: ApiQueryResponse }
  if (envelope.success === true && isApiQueryResponse(envelope.data)) {
    return envelope.data;
  }

  // Fallback: return data directly if not wrapped
  if (isApiQueryResponse(data)) {
    return data;
  }

  throw new Error("PCE API returned an unexpected response shape");
}
