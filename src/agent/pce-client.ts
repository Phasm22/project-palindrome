import { PCE_API_URL } from "../config/pce";
import type { ApiQueryResponse } from "../pce/api/types";

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

  const data = await res.json();
  
  // Handle API response wrapper
  if (data.success === false) {
    throw new Error(`PCE API error: ${data.error || "Unknown error"}`);
  }

  // API returns { success: true, data: ApiQueryResponse }
  if (data.success === true && data.data) {
    return data.data;
  }

  // Fallback: return data directly if not wrapped
  return data;
}

