import {
  RawSourceEventSchema,
  TraceEventSchema,
  type RawSourceEvent,
  type TraceEvent,
} from '@vibetrace/schema';

export interface AdapterCapabilities {
  readonly prompts: boolean;
  readonly messages: boolean;
  readonly plans: boolean;
  readonly reasoning: boolean;
  readonly toolInputs: boolean;
  readonly toolOutputs: boolean;
  readonly approvals: boolean;
  readonly compaction: boolean;
  readonly subagents: boolean;
  readonly tokenUsage: boolean;
  readonly diffs: boolean;
  readonly verification: boolean;
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly capabilities: AdapterCapabilities;
}

export interface AdapterMappedEvent {
  readonly raw: RawSourceEvent;
  readonly event: TraceEvent;
}

export interface SourceAdapter<Input = unknown> {
  readonly descriptor: AdapterDescriptor;
  capture(input: Input): AsyncIterable<AdapterMappedEvent>;
}

/** Validate an adapter output before it reaches a spool or repository. */
export function validateMappedEvent(
  value: AdapterMappedEvent,
): AdapterMappedEvent {
  return {
    raw: RawSourceEventSchema.parse(value.raw),
    event: TraceEventSchema.parse(value.event),
  };
}

/** Minimal conformance oracle reusable by external adapters and fixtures. */
export async function assertAdapterConformance(
  adapter: SourceAdapter,
  input: unknown,
): Promise<readonly AdapterMappedEvent[]> {
  const seen = new Set<string>();
  const output: AdapterMappedEvent[] = [];
  let previousSequence = 0;
  for await (const candidate of adapter.capture(input)) {
    const mapped = validateMappedEvent(candidate);
    if (mapped.event.provenance.adapter !== adapter.descriptor.id)
      throw new Error('Mapped event provenance does not identify the adapter.');
    if (mapped.event.sequence <= previousSequence)
      throw new Error('Adapter event sequence is not strictly increasing.');
    previousSequence = mapped.event.sequence;
    if (seen.has(mapped.event.id))
      throw new Error('Adapter emitted duplicate event IDs.');
    seen.add(mapped.event.id);
    output.push(mapped);
  }
  return output;
}
