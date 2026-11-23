import type { RpcInput } from "@getpaseo/plugin";
import type { factoryPing } from "../shared/factory.js";

export function ping(_input: RpcInput<typeof factoryPing>): { ok: true; nodeVersion: string } {
  return { ok: true as const, nodeVersion: process.version };
}
