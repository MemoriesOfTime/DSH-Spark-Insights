# Security

`dsh-spark-insights` is a read-only parser for local spark exports.

- It never modifies the parsed files or the workspace.
- The only network requests it can make are Mojang mappings downloads: when a
  profile's frames look obfuscated and no usable local mapping file exists, the
  plugin fetches the official mappings for the profile's Minecraft version from
  Mojang's `piston-meta`/`piston-data` hosts over HTTPS. The only
  profile-derived value sent is the Minecraft version used to address the
  mappings download: stack traces, class names, player data, and file contents
  are never uploaded. Requests follow Mojang's own redirects. Set
  `SPARK_INSIGHTS_NO_NETWORK=1` to disable downloads entirely.
- Downloaded mappings are validated before use and written atomically under
  `~/.dsh/spark-insights-mappings/` (override with
  `SPARK_INSIGHTS_MAPPINGS_DIR`) so later lookups reuse the cached file (two
  concurrent first-time lookups for one version may both fetch it); the plugin
  may also read mapping files you place there yourself. Files that are not
  ProGuard mappings are ignored.
- Its only runtime dependency is `protobufjs` (BSD-3-Clause). The plugin itself
  adds no install scripts; review dependency install behavior before deploying.
- Parsing untrusted files is bounded by a 256 MiB file cap, a 512 MiB
  decompressed cap, a 4,000,000-node cap, a 4,096-frame depth cap, and — for
  mapping files — a 64 MiB cap with bounded parsing and a bounded in-memory
  parse cache.
- Tool output is bounded (tables and call trees are truncated).

Report a security issue through GitHub Security Advisories on the repository,
or open a private issue if advisories are unavailable. Please include the spark
data version and a minimal reproducer if possible.
