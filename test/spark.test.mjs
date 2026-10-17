import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test, { after } from 'node:test';

import { apply } from '../index.js';
import { buildSummary, runQuery } from '../lib/analysis.js';
import { parseSparkFile } from '../lib/parse.js';
import {
  applyMappings,
  detectMinecraftVersion,
  looksObfuscated,
  parseProGuardMappings,
  remapDescriptor,
} from '../lib/mappings.js';
import { mappingFootprint, resolveMappings } from '../lib/mappings-source.js';
import {
  buildEmptySamplerFixture,
  buildHealthFixture,
  buildHeapFixture,
  buildLegacyFixture,
  buildNukkitFixture,
  buildObfuscatedSamplerFixture,
  buildOnCpuFallbackFixture,
  buildSamplerFixture,
} from './fixture-encoder.mjs';

// The suite must never touch the network: downloads are disabled globally and
// the download path is exercised below through an injected fetch.
process.env.SPARK_INSIGHTS_NO_NETWORK = '1';
const mappingsCacheDir = await mkdtemp(join(tmpdir(), 'spark-mappings-cache-'));
process.env.SPARK_INSIGHTS_MAPPINGS_DIR = mappingsCacheDir;
after(async () => {
  await rm(mappingsCacheDir, { recursive: true, force: true });
});

/** Maps the obfuscated names used by buildObfuscatedSamplerFixture. */
const MAPPING_TEXT = [
  'net.minecraft.server.level.ServerLevel -> agh:',
  '    void tick(java.util.function.BooleanSupplier) -> a',
  '    void tickChunk(net.minecraft.server.level.ServerChunkCache, boolean) -> a',
  '    void tickTime() -> b',
  '    int getEntityCount() -> b',
  'net.minecraft.server.level.ServerChunkCache -> abc:',
  '    void tick(boolean) -> a',
  'net.minecraft.world.entity.Entity -> wp:',
  '    void tick() -> c',
  'java.lang.Thread -> java.lang.Thread:',
  '    void sleep(long) -> sleep',
].join('\n');

const samplerBytes = buildSamplerFixture();
const heapBytes = buildHeapFixture();
const healthBytes = buildHealthFixture();
const legacyBytes = buildLegacyFixture();

test('parses a sampler tree, windows, and source maps', () => {
  const parsed = parseSparkFile(samplerBytes, { fileName: 'test.sparkprofile' });

  assert.equal(parsed.kind, 'sampler');
  assert.equal(parsed.metadata.platform.name, 'Paper');
  assert.equal(parsed.metadata.platform.minecraftVersion, '1.21.4');
  assert.equal(parsed.metadata.interval, 4000);
  assert.equal(parsed.metadata.numberOfTicks, 100);
  assert.equal(parsed.metadata.samplerMode, 0);
  assert.equal(parsed.metadata.samplerEngine, 1);
  assert.equal(parsed.metadata.samplerEngineVersion, '4.5');
  assert.equal(parsed.metadata.sourceCount, 1);
  assert.equal(parsed.threads.length, 1);

  const thread = parsed.threads[0];
  assert.equal(thread.name, 'Server thread');
  assert.equal(thread.total, 3000);
  assert.equal(thread.self, 1200);
  assert.equal(thread.nodeCount, 4);
  assert.equal(thread.maxDepth, 3);
  assert.equal(thread.windowCount, 2);
  assert.deepEqual(thread.times, [1000, 2000]);

  const root = thread.children[0];
  assert.equal(root.className, 'example.Root');
  assert.equal(root.total, 1800);
  assert.equal(root.self, 300);
  assert.equal(root.children.length, 2);
  assert.deepEqual(root.times, [600, 1200]);

  const work = root.children.find((node) => node.methodName === 'work');
  assert.equal(work.total, 1200);
  assert.equal(work.self, 900);
  assert.equal(work.children[0].className, 'example.Grandchild');
  assert.equal(work.children[0].self, 300);

  assert.equal(parsed.windowStatistics.length, 2);
  assert.equal(parsed.windowStatistics[1].tileEntities, -1);
  assert.equal(parsed.windowStatistics[1].msptMax, 60);
  assert.equal(parsed.classSources['example.Root'], 'TestPlugin');
  assert.equal(parsed.methodSources['example.Child;work;()V'], 'TestPlugin');
  assert.equal(parsed.file.compressed, false);
});

test('schema decoder exposes full metadata, sources, world data, and metrics', () => {
  const parsed = parseSparkFile(samplerBytes, { fileName: 'test.sparkprofile' });

  assert.equal(parsed.metadata.sourceCount, 1);
  assert.equal(parsed.metadata.sources.TestPlugin.version, '1.0.0');
  assert.equal(parsed.metadata.dataAggregator.type, 1);
  assert.equal(parsed.metadata.platformStatistics.world.entityCounts['minecraft:zombie'], 100);
  assert.deepEqual(parsed.metadata.metrics.tps.timestampDeltasMs, [60_000, 60_000]);
  assert.deepEqual(parsed.metadata.metrics.tps.values, [19.5, 18]);
});

test('gzip-wrapped exports parse identically', () => {
  const parsed = parseSparkFile(gzipSync(samplerBytes), { fileName: 'test.sparkprofile' });
  assert.equal(parsed.file.compressed, true);
  assert.equal(parsed.threads[0].total, 3000);
  assert.equal(parsed.threads[0].nodeCount, 4);
});

test('parses legacy nested sampler data', () => {
  const parsed = parseSparkFile(legacyBytes, { fileName: 'legacy.sparkprofile' });
  const thread = parsed.threads[0];
  assert.equal(thread.name, 'Server thread');
  assert.equal(thread.total, 1000);
  assert.equal(thread.self, 200);
  assert.equal(thread.nodeCount, 2);
  assert.equal(thread.children[0].total, 800);
  assert.equal(thread.children[0].self, 600);
  assert.equal(thread.children[0].children[0].self, 200);
});

test('summary includes performance, hotspots, attribution, and tick windows', () => {
  const parsed = parseSparkFile(samplerBytes, { fileName: 'test.sparkprofile' });
  const summary = buildSummary(parsed, { limit: 5 });

  assert.match(summary, /Spark profile summary/u);
  assert.match(summary, /Paper 1\.21\.4/u);
  assert.match(summary, /TPS: 19\.80 \/ 19\.50 \/ 19\.20/u);
  assert.match(summary, /example\.Child\.work/u);
  assert.match(summary, /Plugin\/mod attribution/u);
  assert.match(summary, /TestPlugin/u);
  assert.match(summary, /Unattributed \(Minecraft, Java, or unknown\): 1\.50 s \(50\.00%\)/u);
  assert.match(summary, /ticked aggregator/u);
  assert.match(summary, /Tick windows/u);
  assert.match(summary, /thread total|sampled in this thread/u);
  assert.doesNotMatch(summary, /4m 60s/u);
});

test('queries return the requested views', () => {
  const parsed = parseSparkFile(samplerBytes, { fileName: 'test.sparkprofile' });

  const self = runQuery(parsed, { view: 'methods', limit: 3, sort: 'self' });
  assert.match(self, /example\.Child\.work/u);
  const total = runQuery(parsed, { view: 'methods', limit: 3, sort: 'total' });
  assert.match(total, /example\.Root\.run/u);
  assert.match(total, /Sorted by total time/u);

  const tree = runQuery(parsed, { view: 'tree', query: 'work', depth: 3 });
  assert.match(tree, /example\.Child\.work/u);
  assert.match(tree, /example\.Grandchild\.step/u);

  const sources = runQuery(parsed, { view: 'sources', limit: 5 });
  assert.match(sources, /TestPlugin/u);
  assert.match(sources, /\(unattributed\)/u);

  const windows = runQuery(parsed, { view: 'windows', sort: 'worst', limit: 2 });
  assert.match(windows, /60\.00/u);
  assert.match(windows, /n\/a /u);

  const threads = runQuery(parsed, { view: 'threads' });
  assert.match(threads, /Server thread/u);
});

test('serves metric, plugin, world, system, and window queries', () => {
  const parsed = parseSparkFile(samplerBytes, { fileName: 'test.sparkprofile' });

  const metrics = runQuery(parsed, { view: 'metrics' });
  assert.match(metrics, /Time-series metrics/u);
  assert.match(metrics, /TPS/u);
  assert.match(metrics, /19\.50/u);

  const plugins = runQuery(parsed, { view: 'plugins' });
  assert.match(plugins, /TestPlugin/u);
  assert.match(plugins, /1\.0\.0/u);

  const world = runQuery(parsed, { view: 'world' });
  assert.match(world, /minecraft:zombie/u);
  assert.match(world, /World statistics/u);

  const system = runQuery(parsed, { view: 'system' });
  assert.match(system, /G1 Eden Space/u);
  assert.match(system, /CPU: process 25\.00%/u);

  const first = runQuery(parsed, { view: 'methods', window: 1, limit: 3 });
  assert.match(first, /window 1\/2/u);
  assert.match(first, /400\.0 ms/u);
  assert.match(first, /Thread total: 1\.00 s/u);

  const second = runQuery(parsed, { view: 'methods', window: 2, limit: 3 });
  assert.match(second, /800\.0 ms/u);
  assert.match(second, /Thread total: 2\.00 s/u);

  const tree = runQuery(parsed, { view: 'tree', window: 1, depth: 2 });
  assert.match(tree, /window 1\/2/u);

  assert.throws(
    () => runQuery(parsed, { view: 'methods', window: 3 }),
    /between 1 and 2/u,
  );
  assert.throws(
    () => runQuery(parsed, { view: 'threads', window: 1 }),
    /only supported for views/u,
  );
});

test('parses heap summaries and answers heap queries', () => {
  const parsed = parseSparkFile(heapBytes, { fileName: 'test.sparkheap' });
  assert.equal(parsed.kind, 'heap');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.metadata.platform.name, 'Paper');

  const summary = buildSummary(parsed, {});
  assert.match(summary, /Spark heap summary/u);
  assert.match(summary, /example\.Foo/u);
  assert.match(summary, /Top classes by size/u);

  const query = runQuery(parsed, { view: 'heap', sort: 'instances', limit: 2 });
  assert.match(query, /example\.Foo/u);
  assert.match(query, /java\.lang\.String/u);

  const plugins = runQuery(parsed, { view: 'plugins' });
  assert.match(plugins, /TestPlugin/u);
  const world = runQuery(parsed, { view: 'world' });
  assert.match(world, /World statistics/u);

  assert.throws(
    () => runQuery(parsed, { view: 'methods' }),
    /heap summary/u,
  );
  assert.throws(
    () => runQuery(parsed, { view: 'heap', window: 1 }),
    /sampler profiles/u,
  );
});

test('parses health reports and exposes tick windows', () => {
  const parsed = parseSparkFile(healthBytes, { fileName: 'test.sparkhealth' });
  assert.equal(parsed.kind, 'health');
  assert.equal(parsed.windowStatistics.length, 1);
  assert.equal(parsed.windowStatistics[0].tps, 19.5);

  const summary = buildSummary(parsed, {});
  assert.match(summary, /health report/u);
  assert.match(summary, /no sampled stack trace/u);

  const windows = runQuery(parsed, { view: 'windows' });
  assert.match(windows, /19\.50/u);
  const plugins = runQuery(parsed, { view: 'plugins' });
  assert.match(plugins, /TestPlugin/u);
  const system = runQuery(parsed, { view: 'system' });
  assert.match(system, /System and memory/u);
  assert.throws(
    () => runQuery(parsed, { view: 'methods' }),
    /health report/u,
  );
  assert.throws(
    () => runQuery(parsed, { view: 'windows', window: 1 }),
    /sampler profiles/u,
  );
});

test('rejects data that is not a spark export', () => {
  assert.throws(
    () => parseSparkFile(new TextEncoder().encode('not protobuf at all'), { fileName: 'bad.sparkprofile' }),
    /cannot parse/u,
  );
  assert.throws(
    () => parseSparkFile(new Uint8Array(), { fileName: 'empty.sparkprofile' }),
    /empty/u,
  );
});

test('registers tools and serves files through ctx.fs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spark-insights-test-'));
  try {
    const fixturePath = join(directory, 'fixture.sparkprofile');
    await writeFile(fixturePath, samplerBytes);

    const definitions = [];
    const ctx = {
      effect(fn) {
        return fn();
      },
      tools: {
        register(definition) {
          definitions.push(definition);
          return () => {};
        },
      },
      fs: {
        async resolve(path, { cwd }) {
          return {
            targetKey: path.startsWith('/') ? path : join(cwd, path),
            displayPath: path.startsWith('/') ? path : join(cwd, path),
          };
        },
        async stat(target) {
          try {
            const info = await readFile(target.targetKey);
            return { type: 'file', size: info.length, version: `${info.length}` };
          } catch {
            return undefined;
          }
        },
        async readBytes(target, _signal, max) {
          const bytes = await readFile(target.targetKey);
          assert.ok(bytes.length <= max);
          return bytes;
        },
      },
      workingDirectory: {
        async ensure() {
          return directory;
        },
        defaultDirectory: directory,
      },
    };

    apply(ctx);
    assert.deepEqual(definitions.map((definition) => definition.name), ['spark_analyze', 'spark_query']);

    const analyze = definitions.find((definition) => definition.name === 'spark_analyze');
    const query = definitions.find((definition) => definition.name === 'spark_query');
    const exec = { agent: {}, signal: new AbortController().signal };

    const summary = await analyze.execute({ file_path: 'fixture.sparkprofile', limit: 3 }, exec);
    assert.match(summary, /Paper 1\.21\.4/u);

    const reply = await query.execute(
      { file_path: 'fixture.sparkprofile', view: 'methods', limit: 2 },
      exec,
    );
    assert.match(reply, /example\.Child\.work/u);

    await assert.rejects(
      analyze.execute({ file_path: 'missing.sparkprofile' }, exec),
      /file was not found/u,
    );
    await assert.rejects(
      analyze.execute({ file_path: '' }, exec),
      /non-empty string/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('summarizes a metadata-only profile without throwing', () => {
  const parsed = parseSparkFile(buildEmptySamplerFixture(), {
    fileName: 'empty.sparkprofile',
  });
  assert.equal(parsed.kind, 'sampler');
  assert.equal(parsed.threads.length, 0);

  const summary = buildSummary(parsed, { limit: 3 });
  assert.match(summary, /contains no sampled threads/u);
  assert.match(summary, /TPS: 19\.80/u);
});

test('rejects a truncated export', () => {
  assert.throws(
    () => parseSparkFile(samplerBytes.slice(0, 17), { fileName: 'truncated.sparkprofile' }),
    /cannot parse/u,
  );
});

test('labels allocation and lock sampler modes', () => {
  const allocation = parseSparkFile(buildSamplerFixture({ mode: 1 }), {
    fileName: 'allocation.sparkprofile',
  });
  const allocationSummary = buildSummary(allocation, { limit: 3 });
  assert.match(allocationSummary, /allocation mode/u);
  assert.match(allocationSummary, /interval 512\.0 KiB|interval 512 KiB/u);
  assert.match(allocationSummary, /unattributed allocations/u);
  assert.match(allocationSummary, /KiB| B/u);

  const lock = parseSparkFile(buildSamplerFixture({ mode: 2 }), {
    fileName: 'lock.sparkprofile',
  });
  const lockSummary = buildSummary(lock, { limit: 3 });
  assert.match(lockSummary, /lock mode/u);
  assert.match(lockSummary, /lock wait/u);
});

test('handles a Nukkit export: main thread, CPU-only windows, on-CPU shares', () => {
  const parsed = parseSparkFile(buildNukkitFixture(), { fileName: 'nukkit.sparkprofile' });
  assert.equal(parsed.kind, 'sampler');
  assert.equal(parsed.metadata.platform.name, 'Nukkit');
  assert.equal(parsed.metadata.platformStatistics.tps, null);
  assert.equal(parsed.metadata.platformStatistics.mspt, null);
  assert.equal(parsed.threads.length, 8);

  const summary = buildSummary(parsed, { limit: 3 });

  // F1: the default analysis thread is the Nukkit tick thread "main", not the
  // sleeping merged async pool with 3× more raw sampled time.
  assert.match(summary, /Hotspots — main/u);
  assert.match(summary, /matched built-in main-thread name/u);
  assert.match(summary, /spark-nukkit build does not expose tick statistics/u);

  // Hotspot tables quantify the sleeping share instead of leaving it implicit.
  assert.match(summary, /Kernel-wait frames hold 1\.00 s \(16\.67%\); ≈On-CPU time is 5\.00 s \(83\.33%\)/u);

  // F3: thread table carries Wait / ≈On-CPU / Top frame and drops the dead
  // Self column; JVM-internal groups collapse into one row.
  assert.match(summary, /\| Thread \| xN \| Sampled \| Wait \| ≈On-CPU \| Share \| Top frame \|/u);
  assert.doesNotMatch(summary, /\| Thread \| xN \| Sampled \| Wait \| ≈On-CPU \| Share \| Self \|/u);
  assert.match(
    summary,
    /1\. main \| 1 \| 6\.00 s \| 16\.67% \| ≈5\.00 s \| 22\.73% \| cn\.nukkit\.Nukkit\.main/u,
  );
  assert.match(summary, /JVM internal — 5 groups/u);
  assert.match(summary, /Sampled totals sum to 7\.8× the 10\.00 s capture/u);

  // F2: windows fall back to CPU ordering and drop the empty tick columns.
  assert.match(summary, /ordered by CPU process use \(tick statistics not recorded; windows are time buckets\)/u);
  assert.doesNotMatch(summary, /MSPT med/u);
  assert.match(summary, /\| 2 \|[^|]*\| 40\.0 \/ 60\.0 \|/u);

  // F4: snapshot and series readings are reconciled; CPU states its denominator.
  assert.match(
    summary,
    /Allocation rate: 792 MiB\/s \(1m mean at export\) · series mean 528 MiB\/s, last sample 57\.2 MiB\/s/u,
  );
  assert.match(summary, /CPU: process 25\.00% of 8 threads total \(≈2\.00 cores\), system 30\.00% \(1m\)/u);
  assert.match(summary, /\| Series \| Points \| First \| Last \| Min \| Mean \| Max \|/u);
  assert.match(summary, /instantaneous samples taken ~10s apart/u);
});

test('falls back to on-CPU ranking when no known main-thread name exists', () => {
  const parsed = parseSparkFile(buildOnCpuFallbackFixture(), { fileName: 'fallback.sparkprofile' });
  const summary = buildSummary(parsed, { limit: 3 });

  // "Java: GC Thread (x2)" has the most on-CPU time overall but is JVM
  // internal; "[tid=7]" is launcher-shaped; "Business handler" must win.
  assert.match(summary, /Hotspots — Business handler/u);
  assert.doesNotMatch(summary, /Hotspots — Java: GC Thread/u);
  assert.match(
    summary,
    /No known server main-thread name matched; using the thread with the most on-CPU time \(kernel waits excluded\), Business handler \(≈6\.00 s of 6\.00 s\)/u,
  );

  // Filtered thread queries keep shares relative to all groups, not the match.
  const filtered = runQuery(parsed, { view: 'threads', query: 'Netty' });
  assert.match(filtered, /\| Netty IO thread \| 1 \| 10\.00 s \| 80\.00% \| ≈2\.00 s \| 7\.69% \|/u);
  // The Linux JNI-bridge wait shape (io.netty...Native.epollWait) also counts as wait.
  assert.match(filtered, /\| Netty epoll loop \| 1 \| 10\.00 s \| 80\.00% \| ≈2\.00 s \| 7\.69% \|/u);
  const all = runQuery(parsed, { view: 'threads' });
  assert.match(all, /\| Business handler \| 1 \| 6\.00 s \| 0\.00% \| ≈6\.00 s \| 23\.08% \|/u);
});

test('Nukkit thread and window queries sort by on-CPU and CPU use', () => {
  const parsed = parseSparkFile(buildNukkitFixture(), { fileName: 'nukkit.sparkprofile' });

  const threads = runQuery(parsed, { view: 'threads' });
  assert.match(threads, /sorted by on-CPU time/u);
  assert.match(
    threads,
    /main \| 1 \| 6\.00 s \| 16\.67% \| ≈5\.00 s \| 22\.73% \| cn\.nukkit\.Nukkit\.main/u,
  );
  // The sleeping pool and the parked launcher thread sink below main.
  assert.ok(threads.indexOf('| main |') < threads.indexOf('| Nukkit Asynchronous Task Handler'));
  assert.ok(threads.indexOf('| main |') < threads.indexOf('| [tid=42] |'));
  assert.match(
    threads,
    /Nukkit Asynchronous Task Handler \(x2\) \| 2 \| 20\.00 s \| 95\.00% \| ≈1\.00 s \| 4\.55%/u,
  );

  const windows = runQuery(parsed, { view: 'windows', sort: 'worst' });
  assert.match(windows, /ordered by CPU process use/u);
  assert.ok(windows.indexOf('| 2 |') < windows.indexOf('| 1 |'));
  assert.doesNotMatch(windows, /MSPT med/u);

  const metrics = runQuery(parsed, { view: 'metrics' });
  assert.match(metrics, /\| Allocation rate \| 3 \| 858 MiB\/s \| 57\.2 MiB\/s \| 57\.2 MiB\/s \| 528 MiB\/s \| 858 MiB\/s \|/u);

  // F5: tree truncation names the hottest frames it cut.
  const tree = runQuery(parsed, { view: 'tree', limit: 3 });
  assert.match(tree, /truncated at 3 lines/u);
  assert.match(tree, /hottest unshown frames: cn\.nukkit\.level\.Level\.doTick \(83\.33%\)/u);
});

test('parses ProGuard mappings and remaps obfuscated frames end to end', () => {
  const mapping = parseProGuardMappings(MAPPING_TEXT);
  assert.equal(mapping.classes.get('agh'), 'net.minecraft.server.level.ServerLevel');
  assert.equal(mapping.classes.get('wp'), 'net.minecraft.world.entity.Entity');
  // Identity lines carry no information and must not enter the table.
  assert.equal(mapping.classes.get('java.lang.Thread'), undefined);

  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });
  const info = applyMappings(parsed, mapping, { kind: 'file', label: 'server.txt' });

  const root = parsed.threads[0].children[0];
  assert.equal(root.className, 'net.minecraft.server.level.ServerLevel');
  assert.equal(root.methodName, 'tick');
  assert.equal(root.methodDesc, '(Ljava/util/function/BooleanSupplier;)V');

  // Same obfuscated name, different descriptor: the remapped descriptor
  // picks the tickChunk overload.
  const chunk = root.children[0];
  assert.equal(chunk.className, 'net.minecraft.server.level.ServerLevel');
  assert.equal(chunk.methodName, 'tickChunk');
  assert.equal(chunk.methodDesc, '(Lnet/minecraft/server/level/ServerChunkCache;Z)V');

  const lambda = root.children[1];
  assert.equal(lambda.methodName, 'lambda$tick$0');

  const entity = chunk.children[0];
  assert.equal(entity.className, 'net.minecraft.world.entity.Entity');
  assert.equal(entity.methodName, 'tick');

  // Source attribution keys follow the remapped names.
  assert.equal(parsed.classSources['net.minecraft.server.level.ServerLevel'], 'Minecraft');
  assert.equal(parsed.classSources['net.minecraft.world.entity.Entity'], 'Minecraft');
  assert.equal(
    parsed.methodSources['net.minecraft.server.level.ServerLevel;tick;(Ljava/util/function/BooleanSupplier;)V'],
    'Minecraft',
  );
  assert.equal(parsed.classSources.agh, undefined);

  assert.equal(info.applied, true);
  assert.equal(info.frames, 4);
  // Distinct identities, not per-node rewrites: agh and wp are the only
  // classes; the four methods are agh.a(BooleanSupplier) → tick,
  // agh.a(abc,boolean) → tickChunk, agh.lambda$a$0, and wp.c → tick.
  assert.equal(info.classes, 2);
  assert.equal(info.methods, 4);

  const summary = buildSummary(parsed, { limit: 5 });
  assert.match(summary, /net\.minecraft\.server\.level\.ServerLevel\.tick/u);
  assert.match(summary, /- Mappings: server\.txt — 4 frames remapped/u);

  const methods = runQuery(parsed, { view: 'methods', limit: 5 });
  assert.match(methods, /net\.minecraft\.world\.entity\.Entity\.tick/u);
});

test('remaps heap class names, including array spellings', () => {
  const mapping = parseProGuardMappings(MAPPING_TEXT);
  const heap = {
    kind: 'heap',
    metadata: { platform: { name: 'Server', version: '1.21.4' } },
    entries: [
      { order: 0, instances: 1, size: 16, type: 'agh' },
      { order: 1, instances: 2, size: 32, type: 'agh[]' },
      { order: 2, instances: 3, size: 48, type: 'java.lang.String' },
      // A missing type (only reachable through hand-built objects, but the
      // API is exported) must not be counted as remapped.
      { order: 3, instances: 4, size: 64, type: undefined },
    ],
    warnings: [],
  };

  applyMappings(heap, mapping, { kind: 'file', label: 'server.txt' });

  assert.equal(heap.entries[0].type, 'net.minecraft.server.level.ServerLevel');
  assert.equal(heap.entries[1].type, 'net.minecraft.server.level.ServerLevel[]');
  assert.equal(heap.entries[2].type, 'java.lang.String');
  assert.equal(heap.entries[3].type, undefined);

  // Only rewritten entries count; an unmatched type (java.lang.String) and a
  // missing one must not inflate the statistics.
  assert.equal(heap.mappings.applied, true);
  assert.equal(heap.mappings.frames, 2);
  assert.equal(heap.mappings.classes, 2);
  assert.match(
    buildSummary(heap, { limit: 3 }),
    /- Mappings: server\.txt — 2 entries remapped \(2 classes\)/u,
  );

  // A heap mapping that matches nothing reports the heap noun.
  const unrelated = parseProGuardMappings('com.example.Foo -> xxx:\n    void bar() -> a\n');
  const other = {
    kind: 'heap',
    metadata: { platform: { name: 'Server', version: '1.21.4' } },
    entries: [{ order: 0, instances: 1, size: 16, type: 'agh' }],
    warnings: [],
  };
  applyMappings(other, unrelated, { kind: 'file', label: 'other-version.txt' });
  assert.match(
    buildSummary(other, { limit: 3 }),
    /- Mappings: not applied — other-version\.txt — matched no class names/u,
  );
});

test('malformed untrusted names are scanned in linear time', () => {
  const mapping = parseProGuardMappings(MAPPING_TEXT);

  // A heap type ending in a broken array suffix: the previous lazy regex
  // backtracked quadratically here, so the assertion doubles as a regression
  // guard for the manual suffix split.
  const broken = `agh${'[]'.repeat(100_000)}x`;
  const heap = {
    kind: 'heap',
    metadata: {},
    entries: [{ order: 0, instances: 1, size: 8, type: broken }],
    warnings: [],
  };
  applyMappings(heap, mapping, { kind: 'file', label: 'server.txt' });
  assert.equal(heap.entries[0].type, broken);
  assert.equal(heap.mappings.applied, false);

  // Valid suffixes still map; whitespace between the brackets is preserved.
  const spaced = {
    kind: 'heap',
    metadata: {},
    entries: [{ order: 0, instances: 1, size: 8, type: 'agh [ ]' }],
    warnings: [],
  };
  applyMappings(spaced, mapping, { kind: 'file', label: 'server.txt' });
  assert.equal(spaced.entries[0].type, 'net.minecraft.server.level.ServerLevel [ ]');

  // A descriptor full of reference starters with no terminator must not
  // backtrack (a 200k regression would take minutes rather than milliseconds).
  const descriptor = 'L'.repeat(200_000);
  assert.equal(remapDescriptor(mapping, descriptor), descriptor);
  // A malformed reference does not hide a valid one that follows it.
  assert.equal(
    remapDescriptor(mapping, 'Lbad-Lagh;x'),
    'Lbad-Lnet/minecraft/server/level/ServerLevel;x',
  );

  // Mapping lines with a pathological array suffix must parse in linear time
  // too (the old per-dimension re-slice was quadratic).
  const longType = `java.lang.String${'[]'.repeat(100_000)}`;
  const parsedMapping = parseProGuardMappings(
    `net.minecraft.Foo -> agh:\n    void heavy(${longType}) -> a\n`,
  );
  const candidates = parsedMapping.methods.get('agh').get('a');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].desc.length, 1 + 100_000 + 'Ljava/lang/String;'.length + 2);
});

test('a mapping that matches nothing is reported as not applied', () => {
  const unrelated = parseProGuardMappings('com.example.Foo -> xxx:\n    void bar() -> a\n');
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });

  const info = applyMappings(parsed, unrelated, { kind: 'file', label: 'other-version.txt' });

  assert.equal(info.applied, false);
  assert.equal(info.frames, 0);
  assert.equal(info.classes, 0);
  assert.equal(info.methods, 0);
  // Names and source-attribution keys are left untouched.
  assert.equal(parsed.threads[0].children[0].className, 'agh');
  assert.equal(parsed.classSources.agh, 'Minecraft');
  assert.equal(
    parsed.methodSources['agh;a;(Ljava/util/function/BooleanSupplier;)V'],
    'Minecraft',
  );

  const summary = buildSummary(parsed, { limit: 3 });
  assert.match(
    summary,
    /- Mappings: not applied — other-version\.txt — matched no frames; the mapping may be for a different version, or the export already uses official names/u,
  );
  assert.doesNotMatch(summary, /frames remapped/u);
});

test('applying mappings twice keeps the applied state', () => {
  // Two concurrent tool calls can retry resolution on the same cached
  // profile; the second applyMappings must not overwrite the applied state
  // with "matched no frames" (the obfuscated names are already gone).
  const mapping = parseProGuardMappings(MAPPING_TEXT);
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });

  applyMappings(parsed, mapping, { kind: 'file', label: 'server.txt' });
  const again = applyMappings(parsed, mapping, { kind: 'file', label: 'server.txt' });

  assert.equal(again.applied, true);
  assert.equal(again.frames, 4);
  assert.equal(parsed.threads[0].children[0].className, 'net.minecraft.server.level.ServerLevel');
  assert.doesNotMatch(buildSummary(parsed, { limit: 3 }), /not applied/u);
});

test('lambda frames prefer the exact mapping entry over the enclosing-method heuristic', () => {
  const text = [
    'net.minecraft.server.level.ServerLevel -> agh:',
    '    void tickTime() -> a',
    '    void lambda$tick$0() -> lambda$a$0',
  ].join('\n');
  const mapping = parseProGuardMappings(text);
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });

  applyMappings(parsed, mapping, { kind: 'file', label: 'server.txt' });

  // The heuristic would pick the first 'a' overload (tickTime) for the
  // enclosing method; the exact lambda entry must win instead.
  const lambda = parsed.threads[0].children[0].children[1];
  assert.equal(lambda.methodName, 'lambda$tick$0');
});

test('Mojang-convention lambda entries resolve short runtime names by descriptor', () => {
  // Mojang's official files use "17:17:int lambda$tick$0(...) -> c": the
  // named lambda maps to a SHORT obfuscated name, so the runtime frame is
  // the short name and the descriptor picks the lambda candidate. The line
  // number prefixes mirror the real file format.
  const text = [
    'net.minecraft.server.level.ServerLevel -> agh:',
    '    14:14:void tickTime() -> b',
    '    17:17:int lambda$tick$0(java.util.function.BooleanSupplier) -> c',
  ].join('\n');
  const mapping = parseProGuardMappings(text);
  assert.equal(mapping.classCount, 1);

  const node = {
    className: 'agh',
    methodName: 'c',
    methodDesc: '(Ljava/util/function/BooleanSupplier;)I',
    times: [1, 2],
    children: [],
  };
  const parsed = {
    kind: 'sampler',
    threads: [{ name: 'Server thread', children: [node], times: [1], total: 1 }],
    metadata: {},
    classSources: {},
    methodSources: {},
    lineSources: {},
    warnings: [],
  };
  applyMappings(parsed, mapping, { kind: 'file', label: 'server.txt' });
  assert.equal(node.methodName, 'lambda$tick$0');

  // A lambda-shaped frame whose enclosing method resolves to another lambda
  // must not synthesize a doubled prefix.
  const lambdaFrame = { className: 'agh', methodName: 'lambda$e$0', times: [1, 2], children: [] };
  const parsed2 = {
    kind: 'sampler',
    threads: [{ name: 'Server thread', children: [lambdaFrame], times: [1], total: 1 }],
    metadata: {},
    classSources: {},
    methodSources: {},
    lineSources: {},
    warnings: [],
  };
  const text2 = [
    'net.minecraft.server.level.ServerLevel -> agh:',
    '    17:17:int lambda$spin$0(java.util.function.BooleanSupplier) -> e',
  ].join('\n');
  applyMappings(parsed2, parseProGuardMappings(text2), { kind: 'file', label: 'server.txt' });
  assert.equal(lambdaFrame.methodName, 'lambda$e$0');
});

test('repeated class blocks merge their methods', () => {
  // Merged or hand-patched mapping files can list one obfuscated class
  // twice; methods from both blocks must survive.
  const text = [
    'net.minecraft.server.level.ServerLevel -> agh:',
    '    void tick(java.util.function.BooleanSupplier) -> a',
    'net.minecraft.world.entity.Entity -> wp:',
    '    void tick() -> c',
    'net.minecraft.server.level.ServerChunkCache -> abc:',
    'net.minecraft.server.level.ServerLevel -> agh:',
    '    void tickChunk(net.minecraft.server.level.ServerChunkCache, boolean) -> a',
  ].join('\n');
  const mapping = parseProGuardMappings(text);
  // agh, wp, abc — and agh's two blocks count once.
  assert.equal(mapping.classCount, 3);

  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });
  applyMappings(parsed, mapping, { kind: 'file', label: 'merged.txt' });
  const root = parsed.threads[0].children[0];
  assert.equal(root.methodName, 'tick');
  assert.equal(root.children[0].methodName, 'tickChunk');
});

test('a leading BOM does not lose the first class', () => {
  // Cached mapping files read with readFile(path, 'utf8') keep the BOM.
  const mapping = parseProGuardMappings(`\uFEFF${MAPPING_TEXT}`);
  assert.equal(mapping.classes.get('agh'), 'net.minecraft.server.level.ServerLevel');
});

test('rejects mapping files whose columns are reversed', () => {
  // Some tools publish obfuscated -> named; applying such a file would rewrite
  // readable names back to short ones.
  const reversed = [
    'agh -> net.minecraft.server.level.ServerLevel:',
    '    a -> tick(java.util.function.BooleanSupplier)',
    'wp -> net.minecraft.world.entity.Entity:',
    '    c -> tick()',
    'abc -> net.minecraft.server.level.ServerChunkCache:',
  ].join('\n');

  assert.throws(() => parseProGuardMappings(reversed), /reversed direction/u);
});

test('detects Minecraft versions and obfuscated frame shapes', () => {
  assert.equal(detectMinecraftVersion({ minecraftVersion: '1.21.4' }), '1.21.4');
  assert.equal(detectMinecraftVersion({ version: '1.21.4-R0.1' }), '1.21.4');
  assert.equal(detectMinecraftVersion({ version: '1.20' }), '1.20');
  assert.equal(detectMinecraftVersion({ version: 'git-Spigot-abc' }), null);
  assert.equal(detectMinecraftVersion({}), null);

  // Obfuscated frames: flat class names plus a JVM frame that must be ignored.
  assert.equal(looksObfuscated(parseSparkFile(buildObfuscatedSamplerFixture())), true);
  // Readable frames: example.* / java.* / net.minecraft.* names.
  assert.equal(looksObfuscated(parseSparkFile(buildSamplerFixture())), false);
  assert.equal(looksObfuscated(parseSparkFile(buildHeapFixture())), false);
  assert.equal(looksObfuscated({ kind: 'sampler', threads: [] }), false);
  // Heap array spellings are not class names and must not fake obfuscation.
  assert.equal(looksObfuscated({ kind: 'heap', entries: [{ type: '[B' }, { type: 'java.lang.String' }] }), false);
  assert.equal(looksObfuscated({ kind: 'heap', entries: [{ type: 'agh' }] }), true);
});

test('resolves mappings: explicit path, sibling, cache, then download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-resolve-'));
  try {
    const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), {
      fileName: join(directory, 'obf.sparkprofile'),
    });
    const readExternal = async (path) => {
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    };

    await writeFile(join(directory, 'explicit.txt'), MAPPING_TEXT);
    let resolved = await resolveMappings({
      parsed,
      explicitPath: join(directory, 'explicit.txt'),
      readExternal,
    });
    assert.equal(resolved.source.kind, 'file');
    assert.ok(resolved.mapping);

    await writeFile(join(directory, 'server.txt'), MAPPING_TEXT);
    resolved = await resolveMappings({ parsed, readExternal });
    assert.equal(resolved.source.kind, 'file');
    assert.match(resolved.source.label, /server\.txt$/u);

    await rm(join(directory, 'server.txt'));
    const cacheFile = join(mappingsCacheDir, '1.21.4.txt');
    await writeFile(cacheFile, MAPPING_TEXT);
    resolved = await resolveMappings({ parsed, readExternal });
    assert.equal(resolved.source.kind, 'cache');
    assert.ok(resolved.mapping);

    await rm(cacheFile);
    delete process.env.SPARK_INSIGHTS_NO_NETWORK;
    let fetches = 0;
    const fakeFetch = async (url) => {
      fetches += 1;
      if (url.includes('version_manifest')) {
        return JSON.stringify({
          versions: [{ id: '1.21.4', url: 'https://example.test/version-1.21.4.json' }],
        });
      }
      if (url.includes('version-1.21.4.json')) {
        return JSON.stringify({
          downloads: { server_mappings: { url: 'https://example.test/server.txt' } },
        });
      }
      return MAPPING_TEXT;
    };

    try {
      resolved = await resolveMappings({ parsed, readExternal, fetchText: fakeFetch });
      assert.equal(resolved.source.kind, 'download');
      assert.equal(fetches, 3);
      assert.equal(resolved.mapping.classes.get('agh'), 'net.minecraft.server.level.ServerLevel');
      // The download was persisted and the next resolution reuses it.
      assert.ok(existsSync(cacheFile));
      resolved = await resolveMappings({ parsed, readExternal, fetchText: fakeFetch });
      assert.equal(resolved.source.kind, 'cache');
      assert.equal(fetches, 3);
      // Leave no cache file behind for the tests that follow.
      await rm(cacheFile, { force: true });
    } finally {
      process.env.SPARK_INSIGHTS_NO_NETWORK = '1';
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('falls back to client mappings when server mappings have no URL', async () => {
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });
  parsed.metadata.platform.minecraftVersion = '1.21.2';
  const cacheFile = join(mappingsCacheDir, '1.21.2.txt');
  const previous = process.env.SPARK_INSIGHTS_NO_NETWORK;
  delete process.env.SPARK_INSIGHTS_NO_NETWORK;
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url);
    if (url.includes('version_manifest')) {
      return JSON.stringify({ versions: [{ id: '1.21.2', url: 'https://example.test/v.json' }] });
    }
    if (url.endsWith('v.json')) {
      // A server_mappings object without a URL must not mask client_mappings.
      return JSON.stringify({
        downloads: {
          server_mappings: {},
          client_mappings: { url: 'https://example.test/client.txt' },
        },
      });
    }
    return MAPPING_TEXT;
  };

  try {
    const resolved = await resolveMappings({ parsed, readExternal: async () => null, fetchText: fakeFetch });
    assert.equal(resolved.source.kind, 'download');
    assert.match(resolved.source.label, /client_mappings/u);
    assert.ok(requested.includes('https://example.test/client.txt'));
  } finally {
    process.env.SPARK_INSIGHTS_NO_NETWORK = previous;
    await rm(cacheFile, { force: true });
  }
});

test('explains why no mappings apply for platforms that do not need them', async () => {
  const paper = parseSparkFile(samplerBytes, { fileName: 'paper.sparkprofile' });
  const resolved = await resolveMappings({ parsed: paper, readExternal: async () => null });
  assert.equal(resolved.mapping, null);
  assert.equal(resolved.skipped, true);
  assert.match(resolved.note, /official names at runtime/u);

  // Skips are phrased as "not needed" rather than the failure wording.
  paper.mappings = { applied: false, ...resolved.source, skipped: true, note: resolved.note };
  assert.match(buildSummary(paper, { limit: 2 }), /- Mappings: not needed — /u);
});

test('profiles whose frames are already readable skip automatic mappings', async () => {
  // Spigot is not in the platform skip list, but its frames use readable class
  // names; with no co-located mapping, the shape check must stop the lookup
  // before the version cache or a download.
  const parsed = parseSparkFile(samplerBytes, { fileName: 'spigot.sparkprofile' });
  parsed.metadata.platform = { name: 'Spigot', brand: 'Spigot', version: '1.21.4' };

  const resolved = await resolveMappings({ parsed, readExternal: async () => null });
  assert.equal(resolved.mapping, null);
  assert.equal(resolved.skipped, true);
  assert.match(resolved.note, /no obfuscated class names/u);
});

test('a co-located mapping file is still honored for readable frames', async () => {
  // A file the user placed next to the export is explicit intent: readability
  // of the frames only gates the version cache and downloads.
  const directory = await mkdtemp(join(tmpdir(), 'spark-readable-sibling-'));
  try {
    await writeFile(join(directory, 'server.txt'), MAPPING_TEXT);
    const parsed = parseSparkFile(samplerBytes, { fileName: join(directory, 'spigot.sparkprofile') });
    parsed.metadata.platform = { name: 'Spigot', brand: 'Spigot', version: '1.21.4' };
    const readExternal = async (path) => {
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    };

    const resolved = await resolveMappings({ parsed, readExternal });
    assert.equal(resolved.source.kind, 'file');
    assert.ok(resolved.mapping);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('platforms that run official names also skip sibling and cache mappings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-platform-skip-'));
  try {
    // A sibling server.txt would be picked up without the platform gate.
    await writeFile(join(directory, 'server.txt'), MAPPING_TEXT);
    const paper = parseSparkFile(samplerBytes, { fileName: join(directory, 'paper.sparkprofile') });
    const readExternal = async (path) => {
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    };

    const resolved = await resolveMappings({ parsed: paper, readExternal });
    assert.equal(resolved.mapping, null);
    assert.match(resolved.note, /official names at runtime/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mapping size limits are enforced in bytes', async () => {
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 1, 120); // 'x'
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });

  // An explicit path past the byte cap is explained instead of parsed.
  const explicit = await resolveMappings({ parsed, explicitPath: 'big.txt', readExternal: async () => oversized });
  assert.equal(explicit.mapping, null);
  assert.match(explicit.note, /exceeds the \d+ byte limit/u);

  // An oversized cache file is skipped by the stat gate instead of read.
  const cacheFile = join(mappingsCacheDir, '1.21.4.txt');
  await writeFile(cacheFile, oversized);
  try {
    const resolved = await resolveMappings({ parsed, readExternal: async () => null });
    assert.equal(resolved.mapping, null);
    assert.notEqual(resolved.source.kind, 'cache');
  } finally {
    await rm(cacheFile, { force: true });
  }
});

test('rejects explicit and sibling files that are not ProGuard mappings', async () => {
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });

  const explicit = await resolveMappings({
    parsed,
    explicitPath: 'notes.txt',
    readExternal: async () => Buffer.from('{"not":"a mapping"}'),
  });
  assert.equal(explicit.mapping, null);
  assert.match(explicit.note, /is not a ProGuard mapping file/u);

  // An unrelated server.txt next to the export must not mask the valid cache
  // entry behind it; the sibling is skipped and resolution falls through.
  const directory = await mkdtemp(join(tmpdir(), 'spark-junk-sibling-'));
  const cacheFile = join(mappingsCacheDir, '1.21.4.txt');
  try {
    await writeFile(join(directory, 'server.txt'), '{"not":"a mapping"}');
    await writeFile(cacheFile, MAPPING_TEXT);
    const scoped = parseSparkFile(buildObfuscatedSamplerFixture(), {
      fileName: join(directory, 'obf.sparkprofile'),
    });
    const readExternal = async (path) => {
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    };

    const resolved = await resolveMappings({ parsed: scoped, readExternal });
    assert.equal(resolved.source.kind, 'cache');
    assert.ok(resolved.mapping);
  } finally {
    await rm(cacheFile, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('supports ProGuard line-number prefixes on both sides of the signature', () => {
  const text = [
    'net.minecraft.server.level.ServerLevel -> agh:',
    '    17:17:void tick(java.util.function.BooleanSupplier) -> a',
    '    1:1:void tickChunk(net.minecraft.server.level.ServerChunkCache, boolean):10:12 -> a',
  ].join('\n');
  const mapping = parseProGuardMappings(text);
  const candidates = mapping.methods.get('agh').get('a');

  assert.deepEqual(
    candidates.map((candidate) => candidate.desc),
    ['(Ljava/util/function/BooleanSupplier;)V', '(Lnet/minecraft/server/level/ServerChunkCache;Z)V'],
  );
});

test('keeps the obfuscated method name when overloads cannot be told apart', () => {
  const mapping = parseProGuardMappings(MAPPING_TEXT);
  // agh.a is tick(BooleanSupplier) or tickChunk(ServerChunkCache, boolean);
  // a frame whose descriptor matches neither must not be guessed.
  const node = {
    className: 'agh',
    methodName: 'a',
    methodDesc: '(J)V',
    times: [1, 2],
    children: [],
  };
  const parsed = {
    kind: 'sampler',
    threads: [{ name: 'Server thread', children: [node], times: [1], total: 1 }],
    metadata: {},
    classSources: {},
    methodSources: {},
    lineSources: {},
    warnings: [],
  };

  applyMappings(parsed, mapping, { kind: 'file', label: 'server.txt' });

  assert.equal(node.className, 'net.minecraft.server.level.ServerLevel');
  assert.equal(node.methodName, 'a');
});

test('mapping footprint detects sibling and cache changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spark-footprint-'));
  try {
    const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), {
      fileName: join(directory, 'obf.sparkprofile'),
    });
    const stats = new Map();
    const statExternal = async (path) => stats.get(path) ?? null;

    const initial = await mappingFootprint({ parsed, statExternal });
    stats.set(join(directory, 'server.txt'), { size: 10, version: 'v1' });
    const withSibling = await mappingFootprint({ parsed, statExternal });
    assert.notEqual(initial, withSibling);

    stats.set(join(directory, 'server.txt'), { size: 11, version: 'v2' });
    const changed = await mappingFootprint({ parsed, statExternal });
    assert.notEqual(withSibling, changed);

    const cacheFile = join(mappingsCacheDir, '1.21.4.txt');
    stats.set(cacheFile, { size: 12, version: 'v3' });
    const withCache = await mappingFootprint({ parsed, statExternal });
    assert.notEqual(changed, withCache);

    // Explicit paths are tracked on their own.
    const explicitMissing = await mappingFootprint({ parsed, explicitPath: 'custom.txt', statExternal });
    stats.set('custom.txt', { size: 5, version: 'v4' });
    const explicitPresent = await mappingFootprint({ parsed, explicitPath: 'custom.txt', statExternal });
    assert.notEqual(explicitMissing, explicitPresent);

    // Platforms that never consult mappings have a constant footprint, so
    // mapping files appearing next to a Paper export do not force re-parses.
    const paper = parseSparkFile(samplerBytes, { fileName: join(directory, 'paper.sparkprofile') });
    assert.equal(await mappingFootprint({ parsed: paper, statExternal }), 'skip');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed cache write still returns the mapping and remembers it in memory', async () => {
  const blocked = join(tmpdir(), `spark-cache-blocked-${process.pid}-${Date.now()}`);
  await writeFile(blocked, 'not a directory');
  const previousDir = process.env.SPARK_INSIGHTS_MAPPINGS_DIR;
  process.env.SPARK_INSIGHTS_MAPPINGS_DIR = blocked;
  delete process.env.SPARK_INSIGHTS_NO_NETWORK;

  const fetches = { count: 0 };
  const fakeFetch = async (url) => {
    fetches.count += 1;
    if (url.includes('version_manifest')) {
      return JSON.stringify({
        versions: [{ id: '1.21.1', url: 'https://example.test/version-1.21.1.json' }],
      });
    }
    if (url.includes('version-1.21.1.json')) {
      return JSON.stringify({
        downloads: { server_mappings: { url: 'https://example.test/server.txt' } },
      });
    }
    return MAPPING_TEXT;
  };

  try {
    // A version of its own: the memo this test leaves behind is keyed by
    // version, and the tool-level tests below must not inherit it.
    const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });
    parsed.metadata.platform.minecraftVersion = '1.21.1';
    const resolved = await resolveMappings({ parsed, readExternal: async () => null, fetchText: fakeFetch });

    assert.equal(resolved.source.kind, 'download');
    assert.ok(resolved.mapping);
    assert.doesNotMatch(resolved.source.label, /cached locally/u);
    assert.equal(fetches.count, 3);

    // The in-memory memo avoids refetching on the next profile of that version.
    const again = await resolveMappings({ parsed, readExternal: async () => null, fetchText: fakeFetch });
    assert.ok(again.mapping);
    assert.equal(fetches.count, 3);

    // Reusing the memo is not a network request, so disabling downloads must
    // not hide the mapping that is already in memory.
    process.env.SPARK_INSIGHTS_NO_NETWORK = '1';
    const offline = await resolveMappings({ parsed, readExternal: async () => null, fetchText: fakeFetch });
    assert.ok(offline.mapping);
    assert.equal(fetches.count, 3);
  } finally {
    process.env.SPARK_INSIGHTS_MAPPINGS_DIR = previousDir;
    process.env.SPARK_INSIGHTS_NO_NETWORK = '1';
    await rm(blocked, { force: true });
  }
});

test('a failed download is remembered briefly instead of retried on every call', async () => {
  const parsed = parseSparkFile(buildObfuscatedSamplerFixture(), { fileName: 'obf.sparkprofile' });
  // Use a version the fake manifest does not list, so the failure is
  // definitive and does not collide with the 1.21.4 tests.
  parsed.metadata.platform.minecraftVersion = '1.21.3';

  const fetches = { count: 0 };
  const fakeFetch = async () => {
    fetches.count += 1;
    return JSON.stringify({
      versions: [{ id: '1.21.4', url: 'https://example.test/version-1.21.4.json' }],
    });
  };

  const previous = process.env.SPARK_INSIGHTS_NO_NETWORK;
  delete process.env.SPARK_INSIGHTS_NO_NETWORK;
  try {
    const first = await resolveMappings({ parsed, readExternal: async () => null, fetchText: fakeFetch });
    assert.equal(first.mapping, null);
    assert.match(first.note, /download failed/u);
    assert.equal(fetches.count, 1);

    // Within the failure TTL the next call reports the memoized reason without
    // another network attempt.
    const second = await resolveMappings({ parsed, readExternal: async () => null, fetchText: fakeFetch });
    assert.equal(second.mapping, null);
    assert.match(second.note, /unavailable/u);
    assert.equal(fetches.count, 1);
  } finally {
    process.env.SPARK_INSIGHTS_NO_NETWORK = previous;
  }
});

test('tools apply a sibling mappings file automatically, including after it appears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spark-insights-mappings-'));
  try {
    await writeFile(join(directory, 'obf.sparkprofile'), buildObfuscatedSamplerFixture());

    const definitions = [];
    const ctx = {
      effect(fn) {
        return fn();
      },
      tools: {
        register(definition) {
          definitions.push(definition);
          return () => {};
        },
      },
      fs: {
        async resolve(path, { cwd }) {
          return {
            targetKey: path.startsWith('/') ? path : join(cwd, path),
            displayPath: path.startsWith('/') ? path : join(cwd, path),
          };
        },
        async stat(target) {
          try {
            const info = await readFile(target.targetKey);
            return { type: 'file', size: info.length, version: `${info.length}` };
          } catch {
            return undefined;
          }
        },
        async readBytes(target, _signal, max) {
          const bytes = await readFile(target.targetKey);
          assert.ok(bytes.length <= max);
          return bytes;
        },
      },
      workingDirectory: {
        async ensure() {
          return directory;
        },
        defaultDirectory: directory,
      },
    };

    apply(ctx);
    const analyze = definitions.find((definition) => definition.name === 'spark_analyze');
    const query = definitions.find((definition) => definition.name === 'spark_query');
    const exec = { agent: {}, signal: new AbortController().signal };

    // First call: no mapping exists anywhere (downloads are disabled in this
    // suite), so the summary explains that nothing was applied.
    const before = await analyze.execute({ file_path: 'obf.sparkprofile', limit: 5 }, exec);
    assert.match(before, /agh\.a/u);
    assert.match(before, /- Mappings: not applied — /u);

    // Dropping server.txt next to the export also remaps the cached result.
    await writeFile(join(directory, 'server.txt'), MAPPING_TEXT);
    const summary = await analyze.execute({ file_path: 'obf.sparkprofile', limit: 5 }, exec);
    assert.match(summary, /net\.minecraft\.server\.level\.ServerLevel\.tick/u);
    assert.match(summary, /- Mappings: .*server\.txt — 4 frames remapped/u);

    const methods = await query.execute(
      { file_path: 'obf.sparkprofile', view: 'methods', limit: 5 },
      exec,
    );
    assert.match(methods, /net\.minecraft\.world\.entity\.Entity\.tick/u);

    // Replacing server.txt with a different valid mapping refreshes the cached
    // profile instead of serving the previous names.
    await writeFile(join(directory, 'server.txt'), [
      'net.minecraft.server.level.ServerLevel -> agh:',
      '    void tickTime() -> b',
    ].join('\n'));
    const changed = await analyze.execute({ file_path: 'obf.sparkprofile', limit: 5 }, exec);
    assert.match(changed, /net\.minecraft\.server\.level\.ServerLevel\.a/u);
    assert.match(changed, /wp\.c/u);
    assert.doesNotMatch(changed, /ServerLevel\.tick/u);

    // An explicit mappings_path takes precedence over the sibling file and is
    // visible in the report (a relative path is resolved against the cwd).
    await writeFile(join(directory, 'explicit.txt'), MAPPING_TEXT);
    const explicit = await analyze.execute(
      { file_path: 'obf.sparkprofile', mappings_path: 'explicit.txt', limit: 5 },
      exec,
    );
    assert.match(explicit, /net\.minecraft\.server\.level\.ServerLevel\.tick/u);
    assert.match(explicit, /- Mappings: explicit\.txt — 4 frames remapped/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A real export can be supplied for a local smoke test; CI runs without one.
const realSample = process.env.SPARK_SAMPLE;
test(
  'parses a real spark export from SPARK_SAMPLE',
  { skip: !realSample || !existsSync(realSample) },
  async () => {
    const parsed = parseSparkFile(await readFile(realSample), { fileName: realSample });
    assert.ok(['sampler', 'heap', 'health'].includes(parsed.kind));
    assert.doesNotThrow(() => buildSummary(parsed, { limit: 3 }));
    if (parsed.kind === 'sampler') {
      assert.ok(Array.isArray(parsed.threads));
    }
  },
);
