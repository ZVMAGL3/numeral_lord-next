import { z } from "zod";

export * from "./workshop.js";

export const modManifestSchema = z.object({
  id: z.string().regex(/^mod-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string(),
  apiVersion: z.literal(1),
  contentKind: z.literal("terrain-data"),
  dependencies: z.record(z.string(), z.string()).default({}),
  definition: z.record(z.string(), z.unknown())
});

export type ModManifest = z.infer<typeof modManifestSchema>;

export const mapSettingsSchema = z.object({
  friendlyFire: z.boolean().default(false),
  modLocks: z.array(z.object({
    id: z.string(),
    version: z.string(),
    contentHash: z.string()
  }))
});

export type MapSettings = z.infer<typeof mapSettingsSchema>;
