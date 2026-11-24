import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { z } from "zod";

export const checkpointShortSchema = z.object({
  before: z.string(),
  summary: z.string(),
  after: z.string(),
});

export function CheckpointShort({
  item,
}: PluginTimelineItemProps<z.output<typeof checkpointShortSchema>>) {
  const { before, summary, after } = item.data;
  const textBlock = `\`\`\`text\n✅ ${summary}\n\`\`\``;
  return <Markdown>{[before, textBlock, after].join("\n\n")}</Markdown>;
}
