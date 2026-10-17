/**
 * Test-only protobuf encoder for small synthetic spark exports.
 * Field numbers mirror the schemas in spark-common/src/main/proto/spark.
 */

const encoder = new TextEncoder();

export function concat(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function varint(value) {
  let big = BigInt(value);
  if (big < 0n) {
    big = BigInt.asUintN(64, big);
  }
  const bytes = [];
  while (big >= 0x80n) {
    bytes.push(Number(big & 0x7fn) | 0x80);
    big >>= 7n;
  }
  bytes.push(Number(big));
  return Uint8Array.from(bytes);
}

function tag(field, wire) {
  return varint(field * 8 + wire);
}

export function fieldVarint(field, value) {
  return concat([tag(field, 0), varint(value)]);
}

export function fieldDouble(field, value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat([tag(field, 1), bytes]);
}

export function fieldBytes(field, bytes) {
  return concat([tag(field, 2), varint(bytes.length), bytes]);
}

export function fieldString(field, value) {
  return fieldBytes(field, encoder.encode(value));
}

export function packedDoubles(field, values) {
  const parts = [];
  for (const value of values) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    parts.push(bytes);
  }
  return fieldBytes(field, concat(parts));
}

export function packedInt32(field, values) {
  return fieldBytes(field, concat(values.map((value) => varint(value))));
}

export function message(field, bytes) {
  return fieldBytes(field, bytes);
}

export function stringMapEntry(key, value) {
  return concat([fieldString(1, key), fieldString(2, value)]);
}

export function stringIntMapEntry(key, value) {
  return concat([fieldString(1, key), fieldVarint(2, value)]);
}

export function stringMessageMapEntry(key, bytes) {
  return concat([fieldString(1, key), fieldBytes(2, bytes)]);
}

export function intMessageMapEntry(key, bytes) {
  return concat([fieldVarint(1, key), fieldBytes(2, bytes)]);
}

/* ---------------------------------------------------------------------------------------------- */
/* Shared metadata                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

function creator(name = 'Tester') {
  return concat([
    fieldVarint(1, 1),
    fieldString(2, name),
    fieldString(3, '00000000-0000-0000-0000-000000000000'),
  ]);
}

function platformMetadata() {
  return concat([
    fieldVarint(1, 0),
    fieldString(2, 'Paper'),
    fieldString(3, '1.21.4'),
    fieldString(4, '1.21.4'),
    fieldVarint(7, 2),
    fieldString(8, 'Paper'),
    fieldString(9, '2.0.0'),
  ]);
}

// A vanilla dedicated server: ProGuard-obfuscated runtime names.
function vanillaPlatformMetadata() {
  return concat([
    fieldVarint(1, 0),
    fieldString(2, 'Server'),
    fieldString(3, '1.21.4'),
    fieldString(4, '1.21.4'),
    fieldVarint(7, 2),
    fieldString(8, 'Vanilla'),
  ]);
}

function rolling(mean, max, min, median, p95) {
  return concat([
    fieldDouble(1, mean),
    fieldDouble(2, max),
    fieldDouble(3, min),
    fieldDouble(4, median),
    fieldDouble(5, p95),
  ]);
}

function metrics() {
  // Metrics.tps: DoubleMetricSeries
  return message(1, concat([
    fieldVarint(1, 1_700_000_000_000),
    packedInt32(2, [60_000, 60_000]),
    packedDoubles(3, [19.5, 18]),
  ]));
}

function memoryUsage(used, committed, init, max) {
  return concat([
    fieldVarint(1, used),
    fieldVarint(2, committed),
    fieldVarint(3, init),
    fieldVarint(4, max),
  ]);
}

function gcMessage(total, avgTime, avgFrequency) {
  return concat([
    fieldVarint(1, total),
    fieldDouble(2, avgTime),
    fieldDouble(3, avgFrequency),
  ]);
}

function memoryStatistics() {
  return concat([
    message(1, memoryUsage(1_000_000_000, 2_000_000_000, 512_000_000, 4_000_000_000)),
    message(2, memoryUsage(150_000_000, 200_000_000, 0, -1)),
    message(3, concat([
      fieldString(1, 'G1 Eden Space'),
      message(2, memoryUsage(500_000_000, 1_000_000_000, 0, -1)),
    ])),
    message(4, rolling(52_428_800, 100_000_000, 10_000_000, 50_000_000, 90_000_000)),
  ]);
}

function platformStatistics() {
  const memory = memoryStatistics();

  const tps = concat([
    fieldDouble(1, 19.8),
    fieldDouble(2, 19.5),
    fieldDouble(3, 19.2),
    fieldVarint(4, 20),
  ]);

  const mspt = concat([
    message(1, rolling(9, 40, 2, 8, 20)),
    message(2, rolling(10, 50, 2, 8, 22)),
    fieldVarint(3, 50),
  ]);

  const world = concat([
    fieldVarint(1, 1234),
    message(2, stringIntMapEntry('minecraft:zombie', 100)),
    message(3, concat([
      fieldString(1, 'world'),
      fieldVarint(2, 1000),
      message(3, concat([
        fieldVarint(1, 1000),
        message(2, concat([fieldVarint(1, 0), fieldVarint(2, 0)])),
        message(2, concat([fieldVarint(1, 1), fieldVarint(2, 1)])),
      ])),
    ])),
  ]);

  return concat([
    message(1, memory),
    message(2, stringMessageMapEntry('G1 Young Generation', gcMessage(10, 5.5, 2))),
    fieldVarint(3, 3600),
    message(4, tps),
    message(5, mspt),
    fieldVarint(7, 7),
    message(8, world),
    fieldVarint(9, 2),
  ]);
}

function systemStatistics() {
  const cpu = concat([
    fieldVarint(1, 8),
    message(2, concat([fieldDouble(1, 0.25), fieldDouble(2, 0.5)])),
    message(3, concat([fieldDouble(1, 0.3), fieldDouble(2, 0.6)])),
    fieldString(4, 'Test CPU'),
  ]);
  const memory = concat([
    message(1, concat([fieldVarint(1, 8_000_000_000), fieldVarint(2, 16_000_000_000)])),
    message(2, concat([fieldVarint(1, 0), fieldVarint(2, 0)])),
  ]);
  const disk = concat([fieldVarint(1, 100_000_000_000), fieldVarint(2, 500_000_000_000)]);
  const os = concat([fieldString(1, 'amd64'), fieldString(2, 'Linux'), fieldString(3, '6.8')]);
  const java = concat([
    fieldString(1, 'Eclipse Adoptium'),
    fieldString(2, '21.0.7'),
    fieldString(3, '21.0.7+6'),
    fieldString(4, '-Xmx4G'),
  ]);
  const jvm = concat([
    fieldString(1, 'OpenJDK 64-Bit Server VM'),
    fieldString(2, 'Eclipse Adoptium'),
    fieldString(3, '21.0.7+6'),
  ]);

  return concat([
    message(1, cpu),
    message(2, memory),
    message(3, stringMessageMapEntry('G1 Young Generation', gcMessage(10, 5.5, 2))),
    message(4, disk),
    message(5, os),
    message(6, java),
    fieldVarint(7, 7200),
    message(9, jvm),
  ]);
}

function samplerMetadata(samplerMode = 0, platform = platformMetadata()) {
  return concat([
    message(1, creator()),
    fieldVarint(2, 1_700_000_000_000),
    fieldVarint(3, samplerMode === 1 ? 524_287 : 4000),
    message(4, concat([fieldVarint(1, 0)])),
    message(5, concat([fieldVarint(1, 1), fieldVarint(2, 0)])),
    fieldString(6, 'synthetic test profile'),
    message(7, platform),
    message(8, platformStatistics()),
    message(9, systemStatistics()),
    message(10, stringMapEntry('view-distance', '10')),
    fieldVarint(11, 1_700_000_300_000),
    fieldVarint(12, 100),
    message(13, stringMessageMapEntry('TestPlugin', concat([
      fieldString(1, 'TestPlugin'),
      fieldString(2, '1.0.0'),
      fieldString(3, 'Tester'),
    ]))),
    message(14, stringMapEntry('server-type', 'test')),
    fieldVarint(15, samplerMode),
    fieldVarint(16, 1),
    fieldString(17, '4.5'),
    message(18, metrics()),
  ]);
}

function heapMetadata() {
  return concat([
    message(1, creator()),
    message(2, platformMetadata()),
    message(3, platformStatistics()),
    message(4, systemStatistics()),
    fieldVarint(5, 1_700_000_000_000),
    message(6, stringMapEntry('view-distance', '10')),
    message(7, stringMessageMapEntry('TestPlugin', concat([
      fieldString(1, 'TestPlugin'),
      fieldString(2, '1.0.0'),
    ]))),
    message(8, stringMapEntry('server-type', 'test')),
  ]);
}

function windowStatistics({ ticks, tps, msptMedian, msptMax, startTime, tileEntities = 12 }) {
  return concat([
    fieldVarint(1, ticks),
    fieldDouble(2, 0.2),
    fieldDouble(3, 0.3),
    fieldDouble(4, tps),
    fieldDouble(5, msptMedian),
    fieldDouble(6, msptMax),
    fieldVarint(7, 7),
    fieldVarint(8, 1234),
    fieldVarint(9, tileEntities),
    fieldVarint(10, 987),
    fieldVarint(11, startTime),
    fieldVarint(12, startTime + 60_000),
    fieldVarint(13, 60_000),
  ]);
}

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function stackNode({ className, methodName, methodDesc = '()V', line = 0, times, refs = [] }) {
  return concat([
    fieldString(3, className),
    fieldString(4, methodName),
    fieldString(7, methodDesc),
    fieldVarint(6, line),
    packedDoubles(8, times),
    refs.length > 0 ? packedInt32(9, refs) : new Uint8Array(),
  ]);
}

function samplerThread() {
  const nodes = [
    stackNode({ className: 'example.Root', methodName: 'run', times: [600, 1200], refs: [1, 2] }),
    stackNode({ className: 'example.Child', methodName: 'work', times: [400, 800], refs: [3] }),
    stackNode({ className: 'java.lang.Thread', methodName: 'sleep', times: [100, 200] }),
    stackNode({ className: 'example.Grandchild', methodName: 'step', times: [100, 200] }),
  ];

  return concat([
    fieldString(1, 'Server thread'),
    message(3, nodes[0]),
    message(3, nodes[1]),
    message(3, nodes[2]),
    message(3, nodes[3]),
    packedDoubles(4, [1000, 2000]),
    packedInt32(5, [0]),
  ]);
}

export function buildSamplerFixture({ mode = 0 } = {}) {
  const windows = [
    intMessageMapEntry(100, windowStatistics({
      ticks: 20,
      tps: 19.5,
      msptMedian: 8,
      msptMax: 40,
      startTime: 1_700_000_000_000,
    })),
    intMessageMapEntry(101, windowStatistics({
      ticks: 20,
      tps: 18,
      msptMedian: 12,
      msptMax: 60,
      startTime: 1_700_000_060_000,
      tileEntities: -1,
    })),
  ];

  return concat([
    message(1, samplerMetadata(mode)),
    message(2, samplerThread()),
    message(3, stringMapEntry('example.Root', 'TestPlugin')),
    message(3, stringMapEntry('example.Child', 'TestPlugin')),
    message(3, stringMapEntry('example.Grandchild', 'TestPlugin')),
    message(3, stringMapEntry('java.lang.Thread', 'java')),
    message(4, stringMapEntry('example.Child;work;()V', 'TestPlugin')),
    packedInt32(6, [100, 101]),
    ...windows.map((entry) => message(7, entry)),
  ]);
}

/**
 * A vanilla-server profile with ProGuard-obfuscated frames: "agh.a" is
 * ServerLevel.tick / tickChunk (same obfuscated name, different descriptors),
 * "agh.lambda$a$0" a synthetic lambda frame, "wp.c" Entity.tick. The mapping
 * text that remaps these lives in spark.test.mjs.
 */
export function buildObfuscatedSamplerFixture() {
  const nodes = [
    stackNode({
      className: 'agh',
      methodName: 'a',
      methodDesc: '(Ljava/util/function/BooleanSupplier;)V',
      times: [600, 1200],
      refs: [1, 2],
    }),
    stackNode({
      className: 'agh',
      methodName: 'a',
      methodDesc: '(Labc;Z)V',
      times: [300, 600],
      refs: [3],
    }),
    stackNode({ className: 'agh', methodName: 'lambda$a$0', times: [100, 200] }),
    stackNode({ className: 'wp', methodName: 'c', times: [100, 200] }),
    stackNode({ className: 'java.lang.Thread', methodName: 'sleep', times: [100, 200] }),
  ];

  const thread = concat([
    fieldString(1, 'Server thread'),
    ...nodes.map((node) => message(3, node)),
    packedDoubles(4, [1000, 2000]),
    packedInt32(5, [0]),
  ]);

  return concat([
    message(1, samplerMetadata(0, vanillaPlatformMetadata())),
    message(2, thread),
    message(3, stringMapEntry('agh', 'Minecraft')),
    message(3, stringMapEntry('wp', 'Minecraft')),
    message(4, stringMapEntry('agh;a;(Ljava/util/function/BooleanSupplier;)V', 'Minecraft')),
  ]);
}

function nukkitPlatformMetadata() {
  return concat([
    fieldVarint(1, 0),
    fieldString(2, 'Nukkit'),
    fieldString(3, '1.0.5'),
    fieldString(4, '1.20.0'),
    fieldVarint(7, 2),
    fieldString(8, 'Nukkit'),
  ]);
}

// Mirrors the real defect shape: heap + a high rolling 1m allocation average,
// while the metrics series decays to a tiny last sample.
function nukkitMemoryStatistics() {
  return concat([
    message(1, memoryUsage(1_000_000_000, 2_000_000_000, 512_000_000, 4_000_000_000)),
    message(2, memoryUsage(150_000_000, 200_000_000, 0, -1)),
    message(3, concat([
      fieldString(1, 'G1 Eden Space'),
      message(2, memoryUsage(500_000_000, 1_000_000_000, 0, -1)),
    ])),
    message(4, rolling(830_000_000, 1_600_000_000, 50_000_000, 850_000_000, 1_400_000_000)),
  ]);
}

function nukkitPlatformStatistics() {
  return concat([
    message(1, nukkitMemoryStatistics()),
    message(2, stringMessageMapEntry('G1 Young Generation', gcMessage(10, 5.5, 2))),
    fieldVarint(3, 7200),
    fieldVarint(7, 3),
  ]);
}

function nukkitMetrics() {
  // Metrics.memory_allocation: decaying tail (900 MB/s → 60 MB/s, ~10s apart)
  const allocation = message(7, concat([
    fieldVarint(1, 1_700_000_000_000),
    packedInt32(2, [0, 10_000, 10_000]),
    packedDoubles(3, [900_000_000, 700_000_000, 60_000_000]),
  ]));
  const cpuProcess = message(3, concat([
    fieldVarint(1, 1_700_000_000_000),
    packedInt32(2, [0, 10_000]),
    packedDoubles(3, [0.05, 0.1]),
  ]));
  return concat([cpuProcess, allocation]);
}

function nukkitMetadata() {
  // 10s capture so the summed sample time (78s) overshoots the window and the
  // share-semantics footnote fires.
  return concat([
    message(1, creator('NukkitAdmin')),
    fieldVarint(2, 1_700_000_000_000),
    fieldVarint(3, 4000),
    message(4, concat([fieldVarint(1, 0)])),
    message(5, concat([fieldVarint(1, 1), fieldVarint(2, 0)])),
    fieldString(6, 'synthetic nukkit profile'),
    message(7, nukkitPlatformMetadata()),
    message(8, nukkitPlatformStatistics()),
    message(9, systemStatistics()),
    fieldVarint(11, 1_700_000_010_000),
    fieldVarint(15, 0),
    fieldVarint(16, 0),
    message(18, nukkitMetrics()),
  ]);
}

function samplerThreadMessage(name, times, nodes) {
  return concat([
    fieldString(1, name),
    ...nodes.map((node) => message(3, node)),
    packedDoubles(4, times),
    packedInt32(5, [0]),
  ]);
}

function nukkitThreads() {
  // The Nukkit tick loop runs on the JVM startup thread, literally "main".
  const main = [
    stackNode({ className: 'cn.nukkit.Nukkit', methodName: 'main', times: [2000, 4000], refs: [1] }),
    stackNode({ className: 'cn.nukkit.Server', methodName: 'tickProcessor', times: [2000, 4000], refs: [2, 3] }),
    stackNode({ className: 'libsystem_kernel.dylib', methodName: '__psynch_cvwait', times: [500, 500] }),
    stackNode({ className: 'cn.nukkit.Server', methodName: 'doTick', times: [1500, 3500], refs: [4] }),
    stackNode({ className: 'cn.nukkit.level.Level', methodName: 'doTick', times: [1500, 3500], refs: [5] }),
    stackNode({ className: 'cn.nukkit.level.Level', methodName: 'tickChunks', times: [1000, 2000] }),
  ];
  // A merged pool that mostly sleeps: far more raw sampled time than main.
  const asyncPool = [
    stackNode({ className: 'java.util.concurrent.ThreadPoolExecutor', methodName: 'runWorker', times: [10000, 10000], refs: [1, 2] }),
    stackNode({ className: 'libsystem_kernel.dylib', methodName: '__psynch_cvwait', times: [9500, 9500] }),
    stackNode({ className: 'cn.nukkit.level.generator.task.GenerationTask', methodName: 'run', times: [500, 500] }),
  ];
  // JVM-internal group with real CPU (no wait frames).
  const gc = [
    stackNode({ className: 'libjvm.dylib', methodName: 'G1_conc_marking_loop', times: [8000, 8000] }),
  ];
  // Launcher-shaped anonymous thread parked in java.main.
  const launcher = [
    stackNode({ className: 'libsystem_pthread.dylib', methodName: 'thread_start', times: [6000, 6000], refs: [1] }),
    stackNode({ className: 'java', methodName: 'main', times: [6000, 6000] }),
  ];
  const parked = [stackNode({ className: 'libsystem_kernel.dylib', methodName: '__psynch_cvwait', times: [3000, 3000] })];
  return [
    samplerThreadMessage('main', [2000, 4000], main),
    samplerThreadMessage('Nukkit Asynchronous Task Handler (x2)', [10000, 10000], asyncPool),
    samplerThreadMessage('Java: GC Thread (x2)', [8000, 8000], gc),
    samplerThreadMessage('[tid=42]', [6000, 6000], launcher),
    samplerThreadMessage('Finalizer', [3000, 3000], parked),
    samplerThreadMessage('Notification Thread', [3000, 3000], parked),
    samplerThreadMessage('Common-Cleaner', [3000, 3000], parked),
    samplerThreadMessage('Reference Handler', [3000, 3000], parked),
  ];
}

function nukkitWindowStatistics(cpuProcess, cpuSystem, startTime) {
  // No tick hooks on Nukkit: CPU (and time bounds) only.
  return concat([
    fieldDouble(2, cpuProcess),
    fieldDouble(3, cpuSystem),
    fieldVarint(11, startTime),
    fieldVarint(12, startTime + 10_000),
    fieldVarint(13, 10_000),
  ]);
}

export function buildEmptySamplerFixture() {
  return message(1, samplerMetadata());
}

export function buildNukkitFixture() {
  return concat([
    message(1, nukkitMetadata()),
    ...nukkitThreads().map((thread) => message(2, thread)),
    packedInt32(6, [200, 201]),
    message(7, intMessageMapEntry(200, nukkitWindowStatistics(0.1, 0.5, 1_700_000_000_000))),
    message(7, intMessageMapEntry(201, nukkitWindowStatistics(0.4, 0.6, 1_700_000_010_000))),
  ]);
}

// No known main-thread name anywhere: the on-CPU fallback must pick the
// business thread, not the busier-by-sample-time JVM-internal GC group and
// not the launcher-shaped anonymous thread.
export function buildOnCpuFallbackFixture() {
  const gc = [
    stackNode({ className: 'libjvm.dylib', methodName: 'G1_conc_marking_loop', times: [8000, 8000] }),
  ];
  const launcher = [
    stackNode({ className: 'libsystem_pthread.dylib', methodName: 'thread_start', times: [6000, 6000], refs: [1] }),
    stackNode({ className: 'java', methodName: 'main', times: [6000, 6000] }),
  ];
  const netty = [
    stackNode({ className: 'io.netty.channel.nio.NioEventLoop', methodName: 'run', times: [5000, 5000], refs: [1, 2] }),
    stackNode({ className: 'libsystem_kernel.dylib', methodName: 'kevent', times: [4000, 4000] }),
    stackNode({ className: 'io.netty.handler.codec.MessageToByteEncoder', methodName: 'encode', times: [1000, 1000] }),
  ];
  // Linux shape: the event loop parks in a JNI bridge frame, not a dylib.
  const nettyEpoll = [
    stackNode({ className: 'io.netty.channel.epoll.EpollEventLoop', methodName: 'run', times: [5000, 5000], refs: [1, 2] }),
    stackNode({ className: 'io.netty.channel.epoll.Native', methodName: 'epollWait', times: [4000, 4000] }),
    stackNode({ className: 'io.netty.handler.codec.MessageToByteEncoder', methodName: 'encode', times: [1000, 1000] }),
  ];
  const business = [
    stackNode({ className: 'com.example.Worker', methodName: 'run', times: [3000, 3000], refs: [1] }),
    stackNode({ className: 'com.example.Job', methodName: 'process', times: [3000, 3000] }),
  ];
  return concat([
    message(1, nukkitMetadata()),
    message(2, samplerThreadMessage('Java: GC Thread (x2)', [8000, 8000], gc)),
    message(2, samplerThreadMessage('[tid=7]', [6000, 6000], launcher)),
    message(2, samplerThreadMessage('Netty IO thread', [5000, 5000], netty)),
    message(2, samplerThreadMessage('Netty epoll loop', [5000, 5000], nettyEpoll)),
    message(2, samplerThreadMessage('Business handler', [3000, 3000], business)),
  ]);
}

export function buildHeapFixture() {
  const entries = [
    concat([
      fieldVarint(1, 1),
      fieldVarint(2, 10),
      fieldVarint(3, 1000),
      fieldString(4, 'example.Foo'),
    ]),
    concat([
      fieldVarint(1, 2),
      fieldVarint(2, 5),
      fieldVarint(3, 500),
      fieldString(4, 'java.lang.String'),
    ]),
  ];
  return concat([
    message(1, heapMetadata()),
    ...entries.map((entry) => message(2, entry)),
  ]);
}

export function buildHealthFixture() {
  return concat([
    message(1, heapMetadata()),
    message(2, intMessageMapEntry(100, windowStatistics({
      ticks: 20,
      tps: 19.5,
      msptMedian: 8,
      msptMax: 40,
      startTime: 1_700_000_000_000,
    }))),
  ]);
}

function legacyNode({ className, methodName, time, children = [] }) {
  return concat([
    fieldDouble(1, time),
    ...children.map((child) => message(2, child)),
    fieldString(3, className),
    fieldString(4, methodName),
  ]);
}

export function buildLegacyFixture() {
  const child = legacyNode({ className: 'example.Child', methodName: 'work', time: 200 });
  const root = legacyNode({
    className: 'example.Root',
    methodName: 'run',
    time: 800,
    children: [child],
  });
  const thread = concat([
    fieldString(1, 'Server thread'),
    fieldDouble(2, 1000),
    message(3, root),
  ]);
  return concat([message(1, samplerMetadata()), message(2, thread)]);
}
