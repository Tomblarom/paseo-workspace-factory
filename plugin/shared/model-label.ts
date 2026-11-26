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
