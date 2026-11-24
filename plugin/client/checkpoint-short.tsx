import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import { z } from "zod";

export const checkpointShortSchema = z.object({
  text: z.string(),
});

// The plugin SDK offers no Markdown renderer, so a shortened message
// renders as plain text; the text itself is unchanged apart from the
// collapsed CHECKPOINT block (see shortenCheckpoint).
export function CheckpointShort({
  item,
  theme,
}: PluginTimelineItemProps<z.output<typeof checkpointShortSchema>>) {
  return <Text style={{ color: theme.colors.foreground }}>{item.data.text}</Text>;
}
