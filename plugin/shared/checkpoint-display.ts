import { findCheckpointBlock } from "./checkpoint-block.mjs";

/** Extracts a short title for the last CHECKPOINT and preserves the Markdown on either side. */
export function shortenCheckpoint(text: string): { before: string; summary: string; after: string } | null {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  const block = findCheckpointBlock(lines);
  if (!block) return null;
  const { checkpoint, start, end } = block;
  return {
    before: lines.slice(0, start).join("\n"),
    summary: (checkpoint.next ?? checkpoint.status ?? checkpoint.task).replace(/\s+/g, " ").trim(),
    after: lines.slice(end + 1).join("\n"),
  };
}
