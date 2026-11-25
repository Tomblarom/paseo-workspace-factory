// Resolve hook for plugin tests (not a test file itself): the TypeScript
// sources import each other through `.js` specifiers (the TypeScript bundler
// maps them to `.ts` at compile time), so plain node:test remaps them to the
// `.ts` sources. Type stripping (--experimental-strip-types, also on by
// default) compiles them. Only resolutions that fail normally are remapped
// (the `.mjs` core and shared modules resolve natively and need no hook).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (
      (specifier.endsWith(".js") || specifier.endsWith(".ts")) &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const base = specifier.slice(0, -3);
      for (const ext of [".ts", ".js"]) {
        const abs = resolvePath(dirname(fileURLToPath(context.parentURL)), base + ext);
        if (existsSync(abs)) return { url: pathToFileURL(abs).href, shortCircuit: true };
      }
    }
    throw error;
  }
}
