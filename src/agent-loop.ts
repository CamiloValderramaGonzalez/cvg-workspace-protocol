import type { JsonObject, JsonValue } from "./types.js";

export interface LoopStep<TOutput extends JsonValue = JsonValue> {
  index: number;
  kind: string;
  ok: boolean;
  output?: TOutput;
  detail?: string;
}

export type StopFn<TOutput extends JsonValue = JsonValue> = (
  steps: readonly LoopStep<TOutput>[],
) => boolean;

export const StopCondition = {
  lastSucceeded: <TOutput extends JsonValue = JsonValue>(): StopFn<TOutput> =>
    (steps) => steps.length > 0 && steps.at(-1)?.ok === true,

  maxSteps: <TOutput extends JsonValue = JsonValue>(maximum: number): StopFn<TOutput> => {
    const limit = assertMaximum(maximum);
    return (steps) => steps.length >= limit;
  },

  anyOf: <TOutput extends JsonValue = JsonValue>(
    ...conditions: StopFn<TOutput>[]
  ): StopFn<TOutput> => (steps) => conditions.some((condition) => condition(steps)),

  allOf: <TOutput extends JsonValue = JsonValue>(
    ...conditions: StopFn<TOutput>[]
  ): StopFn<TOutput> => (steps) => conditions.every((condition) => condition(steps)),
};

export type StepFn<
  TContext extends JsonObject = JsonObject,
  TOutput extends JsonValue = JsonValue,
> = (
  previous: LoopStep<TOutput> | null,
  context: TContext,
  signal?: AbortSignal,
) => Promise<LoopStep<TOutput>> | LoopStep<TOutput>;

export type PrepareStepFn<
  TContext extends JsonObject = JsonObject,
  TOutput extends JsonValue = JsonValue,
> = (
  previous: LoopStep<TOutput> | null,
  context: TContext,
) => TContext;

export interface AgentLoopOptions<
  TContext extends JsonObject = JsonObject,
  TOutput extends JsonValue = JsonValue,
> {
  max_steps?: number;
  stop_on_exception?: boolean;
  signal?: AbortSignal;
  prepare_step?: PrepareStepFn<TContext, TOutput>;
  on_step?: (step: LoopStep<TOutput>) => void | Promise<void>;
}

function assertMaximum(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("max_steps must be an integer between 1 and 1000");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(signal.reason === undefined ? "Agent loop aborted" : String(signal.reason));
}

export class AgentLoop<
  TContext extends JsonObject = JsonObject,
  TOutput extends JsonValue = JsonValue,
> {
  readonly steps: LoopStep<TOutput>[] = [];
  private running = false;

  async run(
    step: StepFn<TContext, TOutput>,
    stop_when: StopFn<TOutput>,
    initial_context: TContext,
    options: AgentLoopOptions<TContext, TOutput> = {},
  ): Promise<readonly LoopStep<TOutput>[]> {
    if (this.running) throw new Error("AgentLoop is already running");
    this.running = true;
    try {
      this.steps.length = 0;
      const hard_cap = assertMaximum(options.max_steps ?? 10);
      let context = structuredClone(initial_context);
      let previous: LoopStep<TOutput> | null = null;

      while (this.steps.length < hard_cap) {
        throwIfAborted(options.signal);
        if (options.prepare_step) context = options.prepare_step(previous, context);

        let current: LoopStep<TOutput>;
        try {
          current = await step(previous, context, options.signal);
        } catch (error) {
          if (options.stop_on_exception) throw error;
          current = {
            index: this.steps.length,
            kind: "error",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }

        current = { ...current, index: this.steps.length };
        this.steps.push(current);
        previous = current;
        await options.on_step?.(structuredClone(current));
        if (stop_when(this.steps)) break;
      }

      return structuredClone(this.steps);
    } finally {
      this.running = false;
    }
  }

  get succeeded(): boolean {
    return this.steps.at(-1)?.ok === true;
  }

  get attempts(): number {
    return this.steps.length;
  }
}
