import { z } from "zod";

export const GlancesParams = z.object({
  section: z
    .enum(["all", "cpu", "mem", "load"])
    .default("all")
    .describe("Which metrics set to fetch")
});

export const GlancesJSONSchema = {
  type: "object",
  properties: {
    section: {
      type: "string",
      enum: ["all", "cpu", "mem", "load"],
      description: "Which metrics set to fetch"
    }
  },
  required: [],
  additionalProperties: false,
  default: {
    section: "all"
  }
} as const;

