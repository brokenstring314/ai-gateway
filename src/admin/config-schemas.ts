/**
 * Request bodies of the runtime-config Admin API (0.3.0 P4). Every object
 * is strict: an unknown field is a 400, never silently ignored.
 */

import { z } from "zod";
import {
  BALANCE_MODES,
  CircuitBreakerConfigSchema,
  CompatibilityConfigSchema,
  ConcurrencyConfigSchema,
  KEY_STRATEGIES,
  LimitsConfigSchema,
  ModelMetadataSchema,
  PluginConfigSchema,
  RetryConfigSchema,
  StrategyConfigSchema,
} from "../config/schema.js";
import { REMOVED_TARGET_KEYS } from "../config/removed.js";
import { strictObject } from "../config/strict.js";

const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, "use letters, digits and . _ : @ / - (no spaces)");

/** An upstream key as typed by an admin: a literal, never an environment reference. */
const upstreamKey = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("${"), {
    message: "environment references (${VAR}) are only allowed in the config file; paste the key itself",
  })
  .refine((v) => !v.includes("\n") && !v.includes("\r") && !v.includes(String.fromCharCode(0)), {
    message: "the key must be a single line",
  });

const baseURL = z.string().min(1).max(2048);

/** Target settings an admin may set on a channel (everything else is its own field). */
export const ChannelSettingsSchema = strictObject(
  {
    weight: z.number().nonnegative().max(1_000_000).optional(),
    retry: RetryConfigSchema.optional(),
    circuitBreaker: CircuitBreakerConfigSchema.optional(),
    concurrency: ConcurrencyConfigSchema.optional(),
  },
  {
    costPer1kInputTokens: REMOVED_TARGET_KEYS["costPer1kInputTokens"]!,
    costPer1kOutputTokens: REMOVED_TARGET_KEYS["costPer1kOutputTokens"]!,
  },
);

export const NewKeySchema = strictObject({
  key: upstreamKey,
  weight: z.number().nonnegative().max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});

const channelFields = {
  name,
  preset: z.string().min(1).max(64),
  baseURL: baseURL.nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  models: z.array(z.string().min(1).max(200)).max(5000).optional(),
  keyStrategy: z.enum(KEY_STRATEGIES).optional(),
  keyCooldownSeconds: z.number().int().positive().max(3600).optional(),
  settings: ChannelSettingsSchema.optional(),
};

export const ChannelCreateSchema = strictObject({
  ...channelFields,
  keys: z.array(NewKeySchema).max(100).optional(),
});

export const ChannelPatchSchema = strictObject({
  name: channelFields.name.optional(),
  preset: channelFields.preset.optional(),
  baseURL: channelFields.baseURL,
  enabled: channelFields.enabled,
  priority: channelFields.priority,
  models: channelFields.models,
  keyStrategy: channelFields.keyStrategy.nullable(),
  keyCooldownSeconds: channelFields.keyCooldownSeconds.nullable(),
  settings: channelFields.settings,
});

export const KeysAddSchema = strictObject({
  keys: z.array(NewKeySchema).min(1).max(100),
});

export const KeyPatchSchema = strictObject({
  enabled: z.boolean().optional(),
  weight: z.number().nonnegative().max(1_000_000).optional(),
});

export const BindingSchema = strictObject({
  channelId: z.string().min(1).max(100).optional(),
  channel: z.string().min(1).max(100).optional(),
  upstreamModel: z.string().min(1).max(200).optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  weight: z.number().nonnegative().max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
}).superRefine((b, ctx) => {
  if ((b.channelId === undefined) === (b.channel === undefined)) {
    ctx.addIssue({ code: "custom", message: 'a binding needs exactly one of "channelId" or "channel" (name)' });
  }
});

const modelName = z.string().min(1).max(200);

export const ModelCreateSchema = strictObject({
  name: modelName,
  displayName: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  metadata: ModelMetadataSchema.optional(),
  strategy: z.enum(["fallback", "loadbalance"]).optional(),
  balance: z.enum(BALANCE_MODES).optional(),
  bindings: z.array(BindingSchema).max(200).optional(),
});

export const ModelPatchSchema = strictObject({
  name: modelName.optional(),
  displayName: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  metadata: ModelMetadataSchema.optional(),
  strategy: z.enum(["fallback", "loadbalance"]).optional(),
  balance: z.enum(BALANCE_MODES).optional(),
  /** Replaces every binding in the same transaction as the other fields (console model drawer: one atomic save). */
  bindings: z.array(BindingSchema).max(200).optional(),
});

export const BindingsPutSchema = strictObject({
  bindings: z.array(BindingSchema).max(200),
});

export const SettingsPatchSchema = strictObject({
  strategy: StrategyConfigSchema.optional(),
  aliases: z.record(z.string().min(1).max(200), z.string().min(1).max(200)).optional(),
  plugins: z.array(PluginConfigSchema).max(100).optional(),
  compatibility: CompatibilityConfigSchema.nullable().optional(),
  limits: LimitsConfigSchema.nullable().optional(),
  modelSource: z.enum(["explicit", "derived"]).optional(),
});

export const ChannelTestSchema = strictObject({
  keyId: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
});

export type ChannelCreate = z.infer<typeof ChannelCreateSchema>;
export type ChannelPatch = z.infer<typeof ChannelPatchSchema>;
export type BindingInput = z.infer<typeof BindingSchema>;
