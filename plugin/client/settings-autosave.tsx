import { settingsRpc, type SettingsDefinition } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsRow, type SettingsInputHandle, type SettingsInputProps } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { output, ZodType } from "zod";
import { applySettingsEdit, type EditResult, type SettingsEdit } from "./settings-edit.js";

type Change<Values> = (edit: SettingsEdit<Values>, isCurrent?: () => boolean) => Promise<EditResult<Values>>;

export function useAutosave<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
  const state = useSettings(definition);
  const rpc = useMemo(() => settingsRpc(definition.id), [definition.id]);
  const read = useRpc(rpc.read);
  const queue = useRef(Promise.resolve());
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  function change(section: string): Change<output<Schema>> {
    return (edit, isCurrent = () => true) => {
      const result = queue.current.then(async () => {
        if (isCurrent()) {
          setErrors((current) => current[section] ? { ...current, [section]: null } : current);
        }
        const result = await applySettingsEdit(
          async () => {
            const fresh = await read({});
            if (fresh.status !== "ready") throw new Error(fresh.error);
            return { values: definition.schema.parse(fresh.values), revision: fresh.revision };
          },
          state.save,
          edit,
          isCurrent,
        );
        if (result.status === "failed" && isCurrent()) {
          setErrors((current) => ({ ...current, [section]: result.error }));
        }
        return result;
      });
      queue.current = result.then(() => {});
      return result;
    };
  }

  return { state, change, errors };
}

export function SettingsSaveError({ error }: { error: string | null | undefined }) {
  return error ? <SettingsRow label="Settings change" error={error} /> : null;
}

interface AutosaveInputProps<Values> extends Omit<SettingsInputProps, "onChangeText" | "initialValue" | "ref"> {
  stored: string;
  edit: (text: string) => SettingsEdit<Values> | string;
  save: Change<Values>;
}

export function AutosaveInput<Values>({ stored, edit, save, error: storedError, ...props }: AutosaveInputProps<Values>) {
  const input = useRef<SettingsInputHandle>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; flush: () => void } | null>(null);
  const generation = useRef(0);
  const editing = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing.current && input.current?.getText() !== stored) input.current?.replaceText(stored);
  }, [stored]);

  useEffect(() => () => pending.current?.flush(), []);

  function onChangeText(text: string) {
    const current = ++generation.current;
    editing.current = true;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    const change = edit(text);
    setError(typeof change === "string" ? change : null);
    if (typeof change === "string") return;

    const isCurrent = () => generation.current === current;
    const flush = () => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
      void save(change, isCurrent).then((result) => {
        if (!isCurrent()) return;
        if (result.status === "saved") editing.current = false;
        if (result.status === "invalid") setError(result.error);
      });
    };
    pending.current = { timer: setTimeout(flush, 450), flush };
  }

  return <SettingsInput {...props} ref={input} initialValue={stored} error={error ?? storedError} onChangeText={onChangeText} />;
}
