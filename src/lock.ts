import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ProtocolError } from "./errors.js";

/** Mutex por clave. Protege writers concurrentes dentro de este proceso. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface FileLockOptions {
  timeout_ms?: number;
  stale_ms?: number;
  retry_ms?: number;
}

interface FileLockOwner {
  token: string;
  pid: number;
  created_at: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 25;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientFileContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function removeFileWithRetries(file_path: string): Promise<void> {
  let last_error: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(file_path, { force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!isTransientFileContention(error)) throw error;
      last_error = error;
      await delay(Math.min(attempt + 1, 10));
    }
  }
  throw last_error;
}

async function releaseOwnedLock(lock_path: string, token: string): Promise<void> {
  let last_error: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const owner = JSON.parse(await fs.readFile(lock_path, "utf-8")) as Partial<FileLockOwner>;
      if (owner.token === token) await removeFileWithRetries(lock_path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (!isTransientFileContention(error)) throw error;
      last_error = error;
      await delay(Math.min(attempt + 1, 10));
    }
  }
  throw last_error;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but this process cannot signal it. Unknown
    // failures are handled conservatively so an active owner is never stolen.
    return true;
  }
}

async function publishLockOwner(lock_path: string, owner: FileLockOwner): Promise<boolean> {
  const candidate_path = `${lock_path}.candidate.${owner.token}`;
  let candidate_handle: fs.FileHandle | undefined;
  try {
    candidate_handle = await fs.open(candidate_path, "wx");
    await candidate_handle.writeFile(JSON.stringify(owner) + "\n", "utf-8");
    await candidate_handle.sync();
    await candidate_handle.close();
    candidate_handle = undefined;

    try {
      // A hard link publishes the already-complete inode without ever exposing an
      // empty or partially-written canonical lock file.
      await fs.link(candidate_path, lock_path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM" || code === "EACCES") return false;
      throw error;
    }
  } finally {
    await candidate_handle?.close().catch(() => undefined);
    await removeFileWithRetries(candidate_path).catch(() => undefined);
  }
}

async function removeStaleLock(lock_path: string, stale_ms: number, token: string): Promise<boolean> {
  const recovery_path = `${lock_path}.reclaim`;
  let recovery_handle: fs.FileHandle | undefined;
  try {
    recovery_handle = await fs.open(recovery_path, "wx");
    await recovery_handle.writeFile(token + "\n", "utf-8");
    await recovery_handle.sync();
    await recovery_handle.close();
    recovery_handle = undefined;
  } catch (error) {
    const recovery_created = recovery_handle !== undefined;
    await recovery_handle?.close().catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (!recovery_created && (code === "EEXIST" || code === "EPERM" || code === "EACCES")) {
      return false;
    }
    if (recovery_created) await removeFileWithRetries(recovery_path).catch(() => undefined);
    throw error;
  }

  try {
    let stats;
    try {
      stats = await fs.stat(lock_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      if (isTransientFileContention(error)) return false;
      throw error;
    }
    if (Date.now() - stats.mtimeMs < stale_ms) return false;

    let owner: Partial<FileLockOwner> | undefined;
    try {
      const serialized = await fs.readFile(lock_path, "utf-8");
      try {
        owner = JSON.parse(serialized) as Partial<FileLockOwner>;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // An old malformed lock has no verifiable live owner and can be recovered.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      // Read failures are treated conservatively: do not steal a lock whose owner
      // could not be inspected.
      return false;
    }
    if (typeof owner?.pid === "number" && isProcessAlive(owner.pid)) return false;

    const stale_path = `${lock_path}.stale.${token}`;
    try {
      await fs.rename(lock_path, stale_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    await removeFileWithRetries(stale_path);
    return true;
  } finally {
    await removeFileWithRetries(recovery_path);
  }
}

/**
 * Exclusive cross-process lock based on atomic creation. The token prevents a
 * late owner from deleting its successor's lock after stale-lock recovery.
 */
export async function withFileLock<T>(
  lock_path: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeout_ms = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const stale_ms = options.stale_ms ?? DEFAULT_STALE_MS;
  const retry_ms = options.retry_ms ?? DEFAULT_RETRY_MS;
  const token = `${process.pid}-${randomUUID()}`;
  const started_at = Date.now();
  await fs.mkdir(path.dirname(lock_path), { recursive: true });

  while (true) {
    const acquired = await publishLockOwner(lock_path, {
      token,
      pid: process.pid,
      created_at: new Date().toISOString(),
    });
    if (acquired) break;
    const recovered = await removeStaleLock(lock_path, stale_ms, token);
    if (Date.now() - started_at >= timeout_ms) {
      throw new ProtocolError("CONFLICT", `Timeout esperando lock ${path.basename(lock_path)}`);
    }
    if (recovered) continue;
    await delay(retry_ms);
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lock_path, token);
  }
}
