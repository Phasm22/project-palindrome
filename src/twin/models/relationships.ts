import { z } from "zod";

export enum TwinRelationshipType {
  HOSTS = "HOSTS",
  RUNS_ON = "RUNS_ON",
}

const BaseRelationshipSchema = z.object({
  id: z.string().optional(),
  type: z.nativeEnum(TwinRelationshipType),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  metadata: z.record(z.any()).optional(),
  collectedAt: z.date().default(() => new Date()),
});

export const HostsRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.HOSTS),
});

export const RunsOnRelationshipSchema = BaseRelationshipSchema.extend({
  type: z.literal(TwinRelationshipType.RUNS_ON),
});

export const TwinRelationshipSchema = z.union([
  HostsRelationshipSchema,
  RunsOnRelationshipSchema,
]);

export type TwinRelationship = z.infer<typeof TwinRelationshipSchema>;

