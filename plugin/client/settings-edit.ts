export type SettingsEdit<Values> = (current: Values) => Values | string;

export type EditResult<Values> =
  | { status: "saved"; values: Values }
  | { status: "invalid"; error: string }
  | { status: "failed"; error: string }
  | { status: "superseded" };

export async function applySettingsEdit<Values>(
  read: () => Promise<{ values: Values; revision: string }>,
  save: (values: Values, revision: string) => Promise<boolean>,
  edit: SettingsEdit<Values>,
  isCurrent: () => boolean,
): Promise<EditResult<Values>> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!isCurrent()) return { status: "superseded" };
      const { values, revision } = await read();
      if (!isCurrent()) return { status: "superseded" };
      const next = edit(values);
      if (typeof next === "string") {
        return attempt === 0
          ? { status: "invalid", error: next }
          : { status: "failed", error: `Settings changed while saving. ${next}` };
      }
      if (JSON.stringify(next) === JSON.stringify(values) || await save(next, revision)) {
        return { status: "saved", values: next };
      }
    }
    return {
      status: "failed",
      error: "The edit could not be saved against the latest revision. Edit the field to try again.",
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function commaSeparated(text: string): string[] {
  return text.split(",").map((part) => part.trim()).filter(Boolean);
}

export function wholeNumber(text: string): number {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

export function percentage(text: string): number {
  const value = text.trim();
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : NaN;
}
