# DSH Spark Insights

**English** | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that reads [spark](https://github.com/lucko/spark) performance exports from Minecraft servers and gives the agent two read-only tools for performance analysis.

## Features

- Parses spark protobuf exports:
  - `.sparkprofile` — execution, allocation, and lock sampler data
  - `.sparkheap` — heap summaries
  - raw spark health data (reports platform statistics only)
  - gzip-wrapped exports
  - legacy spark data with nested `children` / `time` fields
- Schema-generated decoder for current spark fields, with a hand-written
  fallback for legacy layouts
- Performance overview: platform/version, TPS, MSPT, CPU, heap/non-heap memory, GC, disk, players, uptime, world counts
- Sampler analysis:
  - thread-group totals with a wait / ≈on-CPU split (kernel-wait frames excluded), merge counts, and top-frame attribution
  - top methods by self and inclusive time
  - searchable call tree
  - per-window hotspots when the profile has per-window stack times
  - tick-window TPS / MSPT / CPU / entities / chunks, with a CPU-use fallback ordering when the platform records no tick statistics
  - plugin/mod source attribution
- Time-series metrics, plugin/mod metadata, world details, memory pools, network interfaces, and ping
- Heap analysis by class size or instance count
- Automatic Mojang mappings for obfuscated profiles (see [Mappings](#mappings))
- Results are cached per file version (two files), and no file contents leave the machine.

## Supported platforms

Any platform that produces spark's common protobuf format works: Paper, Spigot, Fabric, NeoForge, proxies, and the extra-platform builds.

### Nukkit

[spark-nukkit](https://github.com/lucko/spark-extra-platforms/tree/main/spark-nukkit) uses `spark-common`, so its `.sparkprofile` and `.sparkheap` files are the same format and need no conversion.

The Nukkit build currently does not implement tick hooks/reporters, so its exports have **no TPS/MSPT and no tick counts**; window statistics fall back to fixed time buckets that carry CPU use, and the tool orders and labels them accordingly. CPU, memory, GC, threads, stack hotspots, inclusive time, source attribution, and heap summaries still work. The report explicitly notes the missing tick statistics.

## Collect data

On the server:

```text
/spark profiler stop --save-to-file
/spark heapsummary --save-to-file
```

This creates a `.sparkprofile` (in `plugins/spark/` on Nukkit; the plugin data directory on other platforms) or a `.sparkheap` file.

## Tools

### `spark_analyze`

Returns a performance overview: metadata, performance snapshot, metric trends, plugins/mods, world and system details, thread totals, hotspots, worst tick windows, plugin attribution, and heap information.

| Parameter | Meaning |
|---|---|
| `file_path` | spark export path; relative paths use the session working directory |
| `mappings_path` | optional Mojang ProGuard mappings file (see [Mappings](#mappings)) |
| `thread` | optional thread group name or substring; defaults to the server main thread ("Server thread", "main", …), else the thread with the most on-CPU time (kernel waits excluded) |
| `limit` | hotspot rows, 1–50, default 10 |

### `spark_query`

| `view` | Result |
|---|---|
| `methods` | methods sorted by self or inclusive time; supports `query` |
| `threads` | all thread groups, sorted by on-CPU time (kernel waits excluded) |
| `tree` | call tree; `query` locates a class/method, `depth` controls levels below a match, `limit` raises the line budget (default 120, max 300) |
| `windows` | tick windows; `sort=time` or `sort=worst` (worst falls back from MSPT to TPS to CPU process use when tick statistics are missing) |
| `sources` | plugin/mod source attribution |
| `metrics` | spark metric series (TPS, MSPT, CPU, memory, allocation, world, ping) |
| `plugins` | plugin/mod name, version, author, builtin flag |
| `world` | entity types, worlds, chunks, game rules, data packs |
| `system` | CPU, heap, memory pools, network interfaces, OS/Java/JVM, ping |
| `heap` | heap classes; `sort=size` or `sort=instances` |

`spark_query` accepts the same `file_path` and optional `mappings_path` as
`spark_analyze` (see [Mappings](#mappings)), plus `view`, `query`, `window`,
`depth`, `sort`, and `limit` as listed above.

`methods`, `tree`, and `sources` accept `window` (1-based tick-window index) to
analyze only that window when the profile contains per-window stack times.

Examples:

```text
spark_analyze(file_path: "profile.sparkprofile")
spark_query(file_path: "profile.sparkprofile", view: "methods", sort: "total", limit: 20)
spark_query(file_path: "profile.sparkprofile", view: "methods", window: 3, limit: 20)
spark_query(file_path: "profile.sparkprofile", view: "tree", query: "tickChunk", depth: 5)
spark_query(file_path: "profile.sparkprofile", view: "sources", limit: 10)
spark_query(file_path: "profile.sparkprofile", view: "metrics")
spark_query(file_path: "profile.sparkprofile", view: "plugins", limit: 50)
spark_query(file_path: "profile.sparkprofile", view: "world")
spark_query(file_path: "profile.sparkprofile", view: "system")
spark_query(file_path: "heap.sparkheap", view: "heap", sort: "instances")
```

## Mappings

Profiles whose sampled frames still use ProGuard-obfuscated names (typically a
vanilla server; e.g. `agh.a`) are remapped to Mojang's official names
automatically — in hotspots, the call tree, source attribution, and heap
tables. Frames that already use readable class names (Paper, Spigot,
Forge/NeoForge, Fabric, proxies) are detected from the frames themselves, so
they never trigger a version-cache lookup or download; a co-located mapping
file is still honored when the platform itself is not skipped outright.
Resolution order:

1. an explicit `mappings_path` argument pointing at a ProGuard mapping file
   (Mojang's `server.txt` / `client.txt` for the matching version);
2. a sibling file next to the export: `<export>.mappings`, `<export>.map`,
   `server.txt`, or `client.txt`;
3. the version cache at `~/.dsh/spark-insights-mappings/<version>.txt` —
   downloaded mappings are stored here, and you can also drop files in
   yourself (useful for air-gapped machines);
4. an automatic download from Mojang's piston-meta service for the profile's
   Minecraft version, written back to the cache so later lookups reuse it
   (two concurrent first-time lookups for the same version may both fetch).

Every mapping file is parsed and validated first: a file that is not a
ProGuard mapping (a stray `server.txt`, a JSON source map, a reversed mapping
file) is ignored — or reported when passed explicitly — instead of being
applied or blocking the cache/download.

Downloads share one 25-second budget, are validated before they are cached,
and a transient download failure is retried after a couple of minutes.

Notes:

- Platforms and exports that do not need Mojang mappings are skipped with an
  explanatory note: Paper/Purpur/Folia ≥ 1.20.5 already run official names at
  runtime, Fabric reports intermediary names (`class_1234`, needs a different
  mapping format), Nukkit is Bedrock, and any profile whose frames already look
  readable is skipped after a bounded sample. An explicit `mappings_path`
  overrides the skip.
- Downloads can be disabled with `SPARK_INSIGHTS_NO_NETWORK=1`; the cache
  directory can be moved with `SPARK_INSIGHTS_MAPPINGS_DIR`.
- Method resolution uses the frame's JVM descriptor to pick the right
  overload; `lambda$…` frames are rewritten too. When several overloads share
  one obfuscated name and the descriptor matches none of them, the obfuscated
  name is kept rather than guessed. Legacy exports without method descriptors
  fall back to the first candidate for that obfuscated name. Line numbers are
  not remapped, and methods inherited from an unmapped superclass keep the
  obfuscated method name while the class name is still remapped.
- Obfuscated names are reused across Minecraft versions, so a mapping from the
  wrong version can coincidentally match a few names. The `Mappings` line
  reports how many frames were remapped; a suspiciously low count means the
  file probably does not belong to this export.

## Install

Install the published package by name:

```text
plugin_manager install_bundle(target: "dsh-spark-insights")
```

Or install directly from the GitHub repository:

```text
plugin_manager install_bundle(target: "https://github.com/MemoriesOfTime/DSH-Spark-Insights")
```

`install_bundle` resolves the package and installs its dependencies (including `protobufjs`, used by the schema-generated decoder) itself.

For development, clone the repository and install the checkout as a local bundle:

```bash
git clone https://github.com/MemoriesOfTime/DSH-Spark-Insights.git dsh-spark-insights
cd dsh-spark-insights
npm install
```

```text
plugin_manager install_bundle(target: "/absolute/path/to/dsh-spark-insights")
```

Changes to a local checkout are loaded on the next Harness restart.

## Development

Node.js 20+ and npm are required.

```bash
npm install
npm test
```

The schema decoder is generated from [`proto/spark/`](proto/spark/):

```bash
npm run generate:proto
```

To include a real export in the smoke test:

```bash
SPARK_SAMPLE=/path/to/profile.sparkprofile npm test
```

The suite covers synthetic sampler, heap, health, legacy, allocation/lock, gzip, Nukkit, mappings (parser, remap, source resolution with an injected fetch), plugin registration, and file-reading paths. CI runs on Node 20, 22, and 24; the suite itself never touches the network.

## Limits

- Local files only; the plugin does not fetch spark viewer URLs.
- The only network access is the optional Mojang mappings download described
  in [Mappings](#mappings); it can be disabled with `SPARK_INSIGHTS_NO_NETWORK=1`
  and is bounded to one 25-second budget per attempt.
- Fabric intermediary names and Forge/NeoForge SRG names are not remapped;
  line numbers are not remapped either.
- 256 MiB file cap, 512 MiB decompressed cap, 4M node cap, 64 MiB mapping cap;
  mapping files are validated before use, and parsed mappings are held under a
  bounded cache budget.
- Times in reports are UTC.
- Nukkit exports lack tick statistics for the reason described above.

## Security

See [SECURITY.md](SECURITY.md) for the read-only guarantees and parser limits.
