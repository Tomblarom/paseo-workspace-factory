/**
 * Display name for a model. A catalog label that differs from the ID is used as
 * is. Otherwise the ID is formatted generically ("gpt-6.2-sol" → "GPT-6.2 Sol");
 * there is no per-model table, so new models need no change here.
 */
export function modelDisplayName(id: string | null | undefined, catalogLabel?: string | null): string | null {
  const label = catalogLabel?.trim();
  const raw = id?.trim();
  if (label && label.toLowerCase() !== raw?.toLowerCase()) return label;
  const source = raw || label;
  if (!source) return null;
  // IDs with paths, colons or spaces are not plain slugs; show them unchanged.
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(source)) return source;
  const words: string[] = [];
  for (const token of source.split("-").filter(Boolean)) {
    const previous = words.length - 1;
    if (/^gpt$/i.test(token)) words.push("GPT");
    else if (/^\d/.test(token) && words[previous] === "GPT") words[previous] = `GPT-${token}`;
    else words.push(/^\d/.test(token) ? token : token[0].toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}

export type SteerModel = {
  id: string;
  label?: string | null;
  aliases?: readonly string[] | null;
  thinkingOptions?: readonly { id: string; label?: string | null; isDefault?: boolean }[];
  defaultThinkingOptionId?: string;
};

function findSteerModel(model: string | null, catalog: readonly SteerModel[]) {
  if (!model) return {};
  const find = (id: string) => catalog.find((entry) => entry.id === id || entry.aliases?.includes(id));
  const bareId = /^[\w.-]+\/([\w.-]+)$/.exec(model)?.[1];
  const direct = find(model);
  const resolved = direct ?? (bareId ? find(bareId) : undefined);
  return { id: direct || !resolved ? model : bareId, resolved };
}

export function steerRouteNames(model: string | null, thinking: string | null, catalog: readonly SteerModel[] = []) {
  const { id, resolved } = findSteerModel(model, catalog);
  const options = resolved?.thinkingOptions;
  const thinkingId = thinking ?? resolved?.defaultThinkingOptionId ?? options?.find((option) => option.isDefault)?.id;
  return {
    modelName: modelDisplayName(id, resolved?.label) ?? "Model unknown",
    thinkingName: options?.find((option) => option.id === thinkingId)?.label || thinkingId || "Default thinking",
  };
}
