# Adapter SDK

`@vibetrace/adapter-sdk` defines the source-neutral adapter descriptor,
capability declaration, immutable raw/canonical event pair, and a small
conformance oracle. External adapters can depend on this package without
importing the daemon or storage implementation.
