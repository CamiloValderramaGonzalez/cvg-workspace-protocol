import { randomBytes } from "node:crypto";

import { invariant } from "./errors.js";

export interface IdGenerator {
  next(prefix: string, now_ms?: number): string;
}

export interface SortableIdGeneratorOptions {
  clock?: () => number;
  entropy?: () => Uint8Array;
}

/**
 * Genera IDs ordenables lexicográficamente dentro del proceso. Ante un reloj que
 * retrocede usa tiempo lógico; el contador preserva orden dentro del mismo ms.
 */
export class SortableIdGenerator implements IdGenerator {
  private last_ms = -1;
  private counter = 0;
  private readonly clock: () => number;
  private readonly entropy: () => Uint8Array;

  constructor(options: SortableIdGeneratorOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.entropy = options.entropy ?? (() => randomBytes(6));
  }

  next(prefix: string, now_ms = this.clock()): string {
    invariant(
      /^[a-z][a-z0-9-]*$/.test(prefix),
      "INVALID_INPUT",
      `Prefijo de ID inválido: ${prefix}`,
    );
    invariant(Number.isFinite(now_ms) && now_ms >= 0, "INVALID_INPUT", "Timestamp de ID inválido");

    let logical_ms = Math.max(Math.trunc(now_ms), this.last_ms);
    if (logical_ms === this.last_ms) {
      this.counter += 1;
      if (this.counter >= 36 ** 4) {
        logical_ms += 1;
        this.counter = 0;
      }
    } else {
      this.counter = 0;
    }
    this.last_ms = logical_ms;

    const time = logical_ms.toString(36).padStart(10, "0");
    const count = this.counter.toString(36).padStart(4, "0");
    const entropy = Buffer.from(this.entropy()).toString("hex").slice(0, 12).padEnd(12, "0");
    return `${prefix}_${time}${count}${entropy}`;
  }
}

const default_generator = new SortableIdGenerator();

export function createSortableId(prefix: string, now_ms?: number): string {
  return default_generator.next(prefix, now_ms);
}
