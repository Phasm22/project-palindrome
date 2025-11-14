import { z } from "zod";

export const GlancesParams = z.object({
  section: z
    .enum(["all", "cpu", "mem", "load"])
    .default("all")
    .describe("Which metrics set to fetch")
});

