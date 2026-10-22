import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicCreateFile, atomicWriteJson, readJsonFile } from "../atomic-fs.js";
import { withFileLock } from "../lock.js";
import { safePathSegment } from "../paths.js";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function segment(value: string): string { return safePathSegment(value); }
export async function readOptional<T>(file: string): Promise<T | null> {
  try { return await readJsonFile<T>(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function immutableJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicCreateFile(file, JSON.stringify(value, null, 2) + "\n");
}
export { atomicWriteJson, withFileLock };
