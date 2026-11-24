import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { z } from "zod";

export const checkpointShortSchema = z.object({
  before: z.string(),
  summary: z.string(),
  after: z.string(),
});

export function CheckpointShort({
  item,
  theme,
}: PluginTimelineItemProps<z.output<typeof checkpointShortSchema>>) {
  const { before, summary, after } = item.data;
  return (
    <View style={{ gap: 8 }}>
      {before.trim() ? <Markdown>{before}</Markdown> : null}
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      }}>
        <Icon name="Check" size={16} color={theme.colors.statusSuccess} />
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, flexShrink: 1 }}>
          {summary}
        </Text>
      </View>
      {after.trim() ? <Markdown>{after}</Markdown> : null}
    </View>
  );
}
