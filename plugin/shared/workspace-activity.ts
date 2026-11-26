import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const factoryWorkspaceActivity = defineRpc({
  name: "factory.workspace.activity",
  input: z.strictObject({ workspaceId: z.string().min(1) }),
  output: z.object({
    workspaceId: z.string(),
    kind: z.literal("recent-recorded-activity"),
    events: z.array(z.object({
      kind: z.enum(["holder-change", "creation", "renewal", "recovery", "delivery", "assignment", "worker-wake"]),
      state: z.enum(["recorded", "confirmed", "uncertain", "pending", "blocked", "delivered"]),
      reason: z.enum([
        "slot-changed", "holder-replaced", "steer-created", "worker-created", "context-cleared", "context-compacted",
        "context-rewound", "renewal-unconfirmed", "daemon-restart", "provider-limit", "turn-failed",
        "brief-staged", "delivery-queued", "waiting-for-renewal", "delivery-unconfirmed", "delivery-blocked",
        "delivery-blocked-after-attempt", "dispatch-acknowledged", "assignment-recorded", "assignment-report-delivered",
        "worker-completed", "worker-partial", "worker-blocked", "worker-interrupted", "worker-stale", "worker-update", "wake-recorded",
      ]),
      observedAt: z.iso.datetime().nullable(),
    })),
  }),
});
