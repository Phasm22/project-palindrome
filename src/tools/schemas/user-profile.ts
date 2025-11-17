import { z } from "zod";

export const LookupUserProfileParams = z.object({
  identifier: z.string().min(2).describe("Username, email, or employee ID"),
  identifierType: z.enum(["username", "email", "employee_id"]).default("email"),
  includeContact: z.boolean().default(true),
  includeAccess: z.boolean().default(true),
});

export type LookupUserProfileParamsType = z.infer<typeof LookupUserProfileParams>;

export const LookupUserProfileJSONSchema = {
  type: "object",
  properties: {
    identifier: {
      type: "string",
      minLength: 2,
      description: "Username, email, or employee ID",
    },
    identifierType: {
      type: "string",
      enum: ["username", "email", "employee_id"],
      default: "email",
    },
    includeContact: {
      type: "boolean",
      default: true,
    },
    includeAccess: {
      type: "boolean",
      default: true,
    },
  },
  required: ["identifier"],
  additionalProperties: false,
} as const;
