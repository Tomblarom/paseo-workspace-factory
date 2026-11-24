import { settingsRpc } from "@getpaseo/plugin";
import type {
  PluginClientContext,
  PluginTimelineTransformerContribution,
} from "@getpaseo/plugin/client";
import { shortenCheckpoint } from "../shared/checkpoint-display.js";

let checkpointInChat = true;
let clientRef: PluginClientContext | null = null;
let removeTransformer: (() => void) | undefined;
let settingGeneration = 0;

export function setCheckpointInChat(value: boolean): void {
  settingGeneration += 1;
  if (value === checkpointInChat) return;
  checkpointInChat = value;
  removeTransformer?.();
  removeTransformer = value ? undefined : clientRef?.addTimelineTransformer({
    id: "factory-checkpoint",
    query: { itemType: "assistant_message" },
    transform: transformCheckpointMessage,
  });
}

export function isCheckpointInChat(): boolean {
  return checkpointInChat;
}

export function initCheckpointDisplay(client: PluginClientContext): () => void {
  clientRef = client;
  return () => {
    setCheckpointInChat(true);
    clientRef = null;
  };
}

/** Reads the host setting at startup without overwriting a newer local save. */
export async function syncCheckpointDisplayFromSettings(): Promise<void> {
  if (!clientRef) return;
  const generation = settingGeneration;
  try {
    const state = await clientRef.rpc(settingsRpc("factory-display").read, {});
    if (generation === settingGeneration && state.status === "ready") {
      const values = state.values as unknown as { checkpointInChat?: unknown };
      if (typeof values.checkpointInChat === "boolean") {
        setCheckpointInChat(values.checkpointInChat);
      }
    }
  } catch {
    // Unreadable means default on.
  }
}

export const transformCheckpointMessage: PluginTimelineTransformerContribution<"assistant_message">["transform"] =
  ({ item, phase }) => {
    // Streaming-safe: partial text may hold a half-written block; the
    // completed message transforms when the turn lands.
    if (phase !== "complete") return undefined;
    if (checkpointInChat) return undefined;
    const shortened = shortenCheckpoint(item.text);
    if (!shortened) return undefined;
    return {
      items: [
        {
          type: "plugin",
          kind: "factory-checkpoint",
          version: 1,
          data: shortened,
        },
      ],
    };
  };
