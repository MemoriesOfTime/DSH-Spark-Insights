# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-17

### Added

- Initial release.
- `spark_analyze` tool: overall performance report for a spark export — platform/Minecraft/spark versions, capture window, TPS/MSPT/CPU/memory/GC/players/world snapshot, time-series metrics, plugin/mod list, thread groups, hotspots (self + inclusive) with tick-window filtering, worst tick windows, plugin/mod attribution, and heap summaries.
- `spark_query` tool: per-view queries over the same file — `methods`, `threads`, `tree`, `windows`, `sources`, `metrics`, `plugins`, `world`, `system`, and `heap`.
- Support for spark data version 2 (flat `childrenRefs` trees) and legacy nested `children`/`time` exports.
- gzip-wrapped exports, spark health raw data (degrades to a health report when no sampler stacks are present), and execution/allocation/lock sampler modes.
- Platforms: Paper / Spigot / Fabric / Forge / NeoForge, proxies, and spark-nukkit (Nukkit exports parse identically; tick statistics are reported as unavailable).
- Automatic Mojang mappings: profiles whose sampled frames look ProGuard-obfuscated (flat class names such as `agh.a`, typically vanilla servers) are remapped to official names in every view; frames that already use readable names (Paper, Spigot, Forge/NeoForge SRG, Fabric intermediary, proxies) are detected and skipped with an explanatory note. Resolution order: an explicit `mappings_path` tool parameter, a validated sibling file next to the export (`<export>.mappings`, `<export>.map`, `server.txt`, `client.txt`), the on-disk version cache (`~/.dsh/spark-insights-mappings/<version>.txt`, also user-populated), and a download from Mojang's piston-meta service that is validated before being cached atomically. Downloads share one 25-second budget and a transient failure is retried after two minutes instead of being disabled for the process (definitive answers such as a version without mappings are not retried); cache changes are detected via a stat footprint so edited or newly added mapping files refresh cached profiles. Descriptor-aware overload resolution (ambiguous overloads keep the obfuscated name), `lambda$…` frame rewriting, source-attribution key rewriting, and a bounded parsed-mapping cache are included. `SPARK_INSIGHTS_NO_NETWORK=1` disables downloads; `SPARK_INSIGHTS_MAPPINGS_DIR` relocates the cache.
- Schema-generated protobuf decoder from official spark protos with a hand-written wire-format fallback.
- Parse-result cache keyed by file version (most recent 2 files).
- Safety limits for untrusted input: 256 MiB per file, 512 MiB decompressed, 4 million nodes, 4096-frame depth, 64 MiB validated mapping files, and a bounded parsed-mapping cache.
- English and Chinese locales; no telemetry, and the only network requests are the optional Mojang mappings downloads described above.

[1.0.0]: https://github.com/MemoriesOfTime/DSH-Spark-Insights/releases/tag/v1.0.0
