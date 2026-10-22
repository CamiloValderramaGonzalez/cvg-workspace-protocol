import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, canonical, digest, immutableJson, readOptional, segment, withFileLock } from "./storage.js";

export interface SourceIdentity { provider: string; organization: string; project: string; ticket_id: string }
export interface SourceContent { ticket: Record<string, unknown>; conversations: unknown[]; native?: unknown }
export interface SourceSnapshot {
  schema_version: 1; version: number; captured_at: string; source: SourceIdentity;
  content_hash: string; content: SourceContent; origin: "capture" | "legacy_import";
}
export interface CaptureResult { changed: boolean; snapshot: SourceSnapshot; checked_at: string }
export interface SnapshotHistory { versions: SourceSnapshot[]; baseline_version: number | null; latest_version: number | null }

export class SnapshotStore {
  constructor(private readonly root: string) {}
  private dir(workspace: string, source: SourceIdentity): string {
    if (!source.provider || !source.organization || !source.project || !source.ticket_id) throw new Error("Identidad de origen incompleta");
    return path.join(this.root, segment(workspace), "source-versions", digest(source));
  }
  async history(workspace: string, source: SourceIdentity): Promise<SnapshotHistory> {
    const dir = this.dir(workspace, source);
    let names: string[];
    try { names = await fs.readdir(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { versions: [], baseline_version: null, latest_version: null }; throw error; }
    const versions: SourceSnapshot[] = [];
    for (const name of names.filter(n => /^v\d{8}\.json$/.test(n)).sort()) {
      const snap = await readOptional<SourceSnapshot>(path.join(dir, name));
      if (!snap || snap.content_hash !== digest(snap.content) || canonical(snap.source) !== canonical(source) || snap.version !== versions.length + 1) throw new Error("Historial de origen corrupto: no se sobrescribirá");
      versions.push(snap);
    }
    const baseline = await readOptional<{ version: number }>(path.join(dir, "baseline.json"));
    const baselineVersion = baseline?.version ?? versions[0]?.version ?? null;
    if (baselineVersion !== null && !versions.some(v => v.version === baselineVersion)) throw new Error("Baseline no encontrado");
    return { versions, baseline_version: baselineVersion, latest_version: versions.at(-1)?.version ?? null };
  }
  /** Serialize the fetch as well as publication: a slower request cannot publish older source last. */
  async capture(workspace: string, source: SourceIdentity, fetchComplete: () => Promise<SourceContent>, origin: SourceSnapshot["origin"] = "capture"): Promise<CaptureResult> {
    const dir = this.dir(workspace, source);
    return withFileLock(path.join(dir, ".capture.lock"), async () => {
      try {
        const content = await fetchComplete();
        if (!content || !content.ticket || !Array.isArray(content.conversations)) throw new Error("Captura incompleta");
        const checked_at = new Date().toISOString();
        const { versions } = await this.history(workspace, source);
        const previous = versions.at(-1);
        if (origin === "legacy_import" && previous) return { changed: false, snapshot: previous, checked_at };
        const hash = digest(content);
        const changed = !previous || previous.content_hash !== hash;
        const snapshot: SourceSnapshot = changed ? {
          schema_version: 1, version: versions.length + 1, captured_at: checked_at, source,
          content_hash: hash, content, origin,
        } : previous;
        if (changed) await immutableJson(path.join(dir, `v${String(snapshot.version).padStart(8, "0")}.json`), snapshot);
        await immutableJson(path.join(dir, "checks", `${randomUUID()}.json`), { checked_at, outcome: changed ? "changed" : "unchanged", version: snapshot.version });
        return { changed, snapshot, checked_at };
      } catch (error) {
        // Failed or partial network reads never become versions, nor clear existing comments.
        await immutableJson(path.join(dir, "checks", `${randomUUID()}.json`), { checked_at: new Date().toISOString(), outcome: "failed" });
        throw error;
      }
    }, { timeout_ms: 180_000 });
  }
  async useBaseline(workspace: string, source: SourceIdentity, version: number, expectedBaseline: number): Promise<SnapshotHistory> {
    const dir = this.dir(workspace, source);
    return withFileLock(path.join(dir, ".capture.lock"), async () => {
      const history = await this.history(workspace, source);
      if (history.baseline_version !== expectedBaseline) throw new Error("CONFLICT: la versión utilizada cambió");
      if (!history.versions.some(v => v.version === version)) throw new Error("Versión inexistente");
      await atomicWriteJson(path.join(dir, "baseline.json"), { version, selected_at: new Date().toISOString() });
      return { ...history, baseline_version: version };
    });
  }
}

export function changedFields(before: SourceContent, after: SourceContent): string[] {
  const fields: string[] = [];
  function walk(a: unknown, b: unknown, prefix: string): void {
    if (canonical(a) === canonical(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key);
    } else fields.push(prefix);
  }
  walk(before, after, "");
  return fields.sort();
}
