import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function pathExists(file_path: string): Promise<boolean> {
  try {
    await fs.access(file_path);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(
  file_path: string,
  content: string | Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(file_path), { recursive: true });
  const temp = path.join(
    path.dirname(file_path),
    `.${path.basename(file_path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file_path);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Crea un archivo de forma atómica y falla con EEXIST si ya existe. */
export async function atomicCreateFile(
  file_path: string,
  content: string | Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(file_path), { recursive: true });
  const temp = path.join(
    path.dirname(file_path),
    `.${path.basename(file_path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temp, file_path);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(file_path: string, value: unknown): Promise<void> {
  await atomicWriteFile(file_path, JSON.stringify(value, null, 2) + "\n");
}

export async function readJsonFile<T>(file_path: string): Promise<T> {
  return JSON.parse(await fs.readFile(file_path, "utf-8")) as T;
}

export async function appendJsonLine(file_path: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file_path), { recursive: true });
  const handle = await fs.open(file_path, "a");
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines<T>(file_path: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(file_path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values: T[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(`JSONL inválido en ${file_path}:${index + 1}: ${String(error)}`);
    }
  }
  return values;
}
