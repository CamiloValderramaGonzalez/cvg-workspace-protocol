export type ProtocolErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_PATH"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "INTEGRITY_ERROR";

export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function invariant(
  condition: unknown,
  code: ProtocolErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) throw new ProtocolError(code, message, details);
}
