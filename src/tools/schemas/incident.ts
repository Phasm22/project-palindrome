import { z } from "zod";

export const CreateIncidentTicketParams = z.object({
  title: z.string().min(5).max(200),
  description: z.string().min(10).max(2000),
  severity: z.enum(["low", "medium", "high", "critical"]),
  service: z.string().min(2).max(120),
  assignedTo: z.string().optional(),
  tags: z.array(z.string()).max(10).default([]),
  autoNotify: z.boolean().default(true),
  linkedRunbook: z.string().url().optional(),
});

export type CreateIncidentTicketParamsType = z.infer<typeof CreateIncidentTicketParams>;

export const CreateIncidentTicketJSONSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 5,
      maxLength: 200,
    },
    description: {
      type: "string",
      minLength: 10,
      maxLength: 2000,
    },
    severity: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    service: {
      type: "string",
      minLength: 2,
      maxLength: 120,
    },
    assignedTo: {
      type: "string",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      maxItems: 10,
      default: [],
    },
    autoNotify: {
      type: "boolean",
      default: true,
    },
    linkedRunbook: {
      type: "string",
      format: "uri",
    },
  },
  required: ["title", "description", "severity", "service"],
  additionalProperties: false,
} as const;
