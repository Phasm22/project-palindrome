import { z } from "zod";

export const ActionStepSchema = z.object({
  stepNumber: z.number(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().optional(),
  dependencies: z.array(z.number()).optional(),
  estimatedRisk: z.enum(["READ", "WRITE_LOW", "WRITE_HIGH", "DESTRUCTIVE"]),
  requiresConfirmation: z.boolean(),
});

export const ActionPlanSchema = z.object({
  id: z.string(),
  steps: z.array(ActionStepSchema).min(1),
  rationale: z.string(),
  summary: z.string(),
});

export type ActionStep = z.infer<typeof ActionStepSchema>;
export type ActionPlan = z.infer<typeof ActionPlanSchema>;
