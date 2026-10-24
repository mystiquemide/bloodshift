import { readFileSync, existsSync } from "node:fs";

// Loads .env into process.env without overriding values already set.
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1] === undefined) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? "";
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}
