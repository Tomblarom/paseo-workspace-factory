import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WORKSPACE_ACTIVITY_LIMIT = 20;

const participant = z.union([
  z.enum(["Steer", "Worker"]),
  z.string().length(7).regex(/^Steer [A-Z]$/),
]);

export const factoryWorkspaceActivity = defineRpc({
  name: "factory.workspace.activity",
  input: z.strictObject({ workspaceId: z.string().min(1) }),
  output: z.object({
    workspaceId: z.string(),
    kind: z.literal("recent-recorded-activity"),
    events: z.array(z.object({
      kind: z.enum(["holder-change", "creation", "renewal", "recovery", "delivery", "takeover-request", "assignment", "worker-wake"]),
      state: z.enum(["recorded", "confirmed", "uncertain", "pending", "blocked", "delivered"]),
      reason: z.enum([
        "slot-changed", "holder-replaced", "steer-created", "worker-created", "context-cleared", "context-compacted",
        "context-rewound", "renewal-unconfirmed", "clear-reserved", "clear-attempt-unconfirmed", "daemon-restart", "provider-limit", "turn-failed",
        "brief-staged", "delivery-queued", "waiting-for-renewal", "delivery-unconfirmed", "delivery-blocked",
        "delivery-blocked-after-attempt", "dispatch-acknowledged", "takeover-recorded", "assignment-recorded", "assignment-report-delivered",
        "worker-completed", "worker-partial", "worker-blocked", "worker-interrupted", "worker-stale", "worker-update", "wake-recorded",
      ]),
      observedAt: z.iso.datetime().nullable(),
      participant: participant.optional(),
      participantAgentId: z.string().min(1).optional(),
      from: participant.optional(),
      fromAgentId: z.string().min(1).optional(),
      cause: z.enum(["no-answer", "no-holder", "provider-limit", "quota-exhausted", "advisor-holder", "privacy"]).optional(),
      renewal: z.enum(["clear", "rewind"]).optional(),
      group: z.object({
        kind: z.enum(["holder-change", "renewal", "recovery", "takeover-request"]),
        index: z.int().min(0).max(WORKSPACE_ACTIVITY_LIMIT - 1),
      }).optional(),
    })).max(WORKSPACE_ACTIVITY_LIMIT),
  }),
});
