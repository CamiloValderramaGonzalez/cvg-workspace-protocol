import * as path from "node:path";

import { ProtocolError, invariant } from "./errors.js";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const UNSAFE_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Convierte separadores a `/` y rechaza rutas ambiguas o que escapen del workspace. */
export function safeRelativePath(input: string): string {
  invariant(typeof input === "string" && input.trim().length > 0, "UNSAFE_PATH", "Path relativo vacío");
  const normalized = input.trim().replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new ProtocolError("UNSAFE_PATH", `Path absoluto o inseguro: ${input}`);
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(" ") ||
      segment.endsWith(".") ||
      WINDOWS_RESERVED.test(segment) ||
      UNSAFE_CHARS.test(segment)
    ) {
      throw new ProtocolError("UNSAFE_PATH", `Segmento de path inseguro: ${segment || "(vacío)"}`);
    }
  }
  return segments.join("/");
}

export function safePathSegment(input: string, label = "segmento"): string {
  const value = safeRelativePath(input);
  invariant(!value.includes("/"), "UNSAFE_PATH", `${label} no puede contener separadores: ${input}`);
  return value;
}

export function resolveInside(root: string, relative_path: string): string {
  const relative = safeRelativePath(relative_path);
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...relative.split("/"));
  if (resolved === base || !resolved.startsWith(base + path.sep)) {
    throw new ProtocolError("UNSAFE_PATH", `Path fuera del workspace: ${relative_path}`);
  }
  return resolved;
}
