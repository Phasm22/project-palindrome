import { z } from "zod";

export const SSHToolParams = z.object({
  host: z.string().describe("Hostname or IP address of the target host"),
  command: z.string().describe("The command to execute (must be pre-approved for this host)"),
  category: z
    .enum(["filesystem", "system", "custom"])
    .optional()
    .describe("Category of command (for organization)"),
});

