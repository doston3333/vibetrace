# RFC 0001: Source adapter contract

Status: accepted

Source adapters are bounded, deterministic translators at the trust boundary.
They may only normalize source-observable data. They must retain the immutable
raw payload, identify the adapter and source version, produce deterministic
UUIDv5 session/event IDs, and represent unavailable data with an explicit
`capture.gap` event.

Adapters must not execute captured strings, interpolate shell commands, emit
collector stdout, block the source application, or claim private reasoning.
Large output belongs in the encrypted blob store and is referenced from the
canonical event. A new adapter requires conformance fixtures for malformed
input, oversized frames, unknown fields, duplicate delivery, unsupported source
versions, and prompt-injection-shaped content.

The Codex hook adapter remains the default. App-server, generic JSONL, and OTel
are opt-in surfaces and share the same canonical schema and privacy profiles.
