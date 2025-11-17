import { z } from "zod";

export const OpnsenseParams = z.object({
  action: z
    .enum(["system_status", "list_aliases", "search_aliases"])
    .describe("The OPNsense operation to perform"),
  search_term: z
    .string()
    .optional()
    .describe("Optional search term for search_aliases action"),
});

