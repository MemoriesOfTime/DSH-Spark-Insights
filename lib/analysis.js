/**
 * Read-only analysis and reporting for parsed spark exports.
 *
 * All time values follow spark's own units:
 *   execution mode -> milliseconds of sampled CPU time
 *   allocation mode -> bytes allocated
 *   lock mode -> milliseconds of lock wait
 */

const MODE_EXECUTION = 0;
const MODE_ALLOCATION = 1;
const MODE_LOCK = 2;

const MAX_LIMIT = 50;
const MAX_TREE_LINES = 120;
const MAX_TREE_LINE_BUDGET = 300;
const MAX_CELL = 118;

/*
 * Execution-mode on-CPU model.
 *
 * A sampled thread that is parked in the kernel shows its wait primitive
 * (__psynch_cvwait, kevent, poll, ...) as the hot leaf frame. Raw sampled
 * time therefore ranks sleeping pools above the tick thread. For ranking
 * and display we estimate on-CPU time as the total minus every subtree
 * rooted at a kernel-wait frame. It is a heuristic (marked ≈ in output):
 * a business method that happens to share a wait-primitive name could be
 * misclassified, which only shifts the estimate.
 */

// Native wait primitives, matched against the method name alone when the
// frame belongs to a native library (dylib/so/dll/kernel).
const NATIVE_WAIT_METHODS = new Set([
  '__psynch_cvwait',
  '__psynch_mutexwait',
  'semaphore_wait_trap',
  '__ulock_wait',
  'os_sync_wait_on_address',
  'kevent',
  'kevent64',
  'poll',
  'epoll_wait',
  'select',
  '__select',
  'pselect',
  'do_sigtimedwait',
  'do_nanosleep',
  '__semwait_signal',
  'pthread_cond_wait',
  'pthread_cond_timedwait',
  'pthread_join',
  'sched_yield',
  'futex',
  'read0',
  'socketread0',
  'accept',
  'accept0',
  'connect',
  'connect0',
  'recvfrom',
  'recvmsg',
  'sendmsg',
  'sendto',
  'read',
  'write',
  'writev',
  'pread',
  'pwrite',
  'fsync',
  'fdatasync',
  'mach_msg',
  'mach_msg_trap',
  'mach_msg_overwrite',
  'mach_msg_overwrite_trap',
  'mach_msg2_trap',
  'waitforsingleobject',
  'waitformultipleobjects',
  'sleepex',
]);
const NATIVE_WAIT_METHOD_PARTS = [
  '__psynch',
  'ulock_wait',
  'wait_on_address',
  'semwait',
  'sigtimedwait',
  'nanosleep',
  'epollwait',
  'kevent',
  'cond_wait',
  'mach_msg',
];
// Blocking primitives on the Java side, only when the frame is a JDK or
// netty class (netty parks its event loops in a JNI bridge frame on Linux).
const JAVA_WAIT_METHODS = new Set(['wait', 'sleep', 'park', 'parknanos', 'park0', 'join', 'readline', 'epollwait', 'epollwait0']);
const NATIVE_OWNER_RE = /(\.dylib|\.so|\.dll|\.jnilib|^lib[a-z0-9_]+$|_kernel|^native$|^os::|^std::)/iu;

function isWaitFrame(node) {
  const method = String(node.methodName || '').toLowerCase();
  if (!method) {
    return false;
  }
  const owner = String(node.className || '').toLowerCase();
  if (NATIVE_OWNER_RE.test(owner)) {
    return NATIVE_WAIT_METHODS.has(method) || NATIVE_WAIT_METHOD_PARTS.some((part) => method.includes(part));
  }
  if (/^(java|jdk|sun|javax)\./.test(owner) || /^io\.netty\./.test(owner)) {
    return JAVA_WAIT_METHODS.has(method);
  }
  return false;
}

function threadWaitInfo(thread) {
  if (thread._waitInfo) {
    return thread._waitInfo;
  }
  let wait = 0;
  const walk = (node) => {
    if (isWaitFrame(node)) {
      wait += node.total;
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const root of thread.children) {
    walk(root);
  }
  // A thread whose whole stack is the JVM launcher skeleton (thread_start →
  // _pthread_start → apple_main/JLI_Launch → java.main) is parked before or
  // after the application runs; count it as waiting, not on-CPU.
  if (wait < thread.total && isLauncherThread(thread)) {
    wait = thread.total;
  }
  const info = { wait, onCpu: Math.max(0, (thread.total || 0) - wait) };
  thread._waitInfo = info;
  return info;
}

const LAUNCHER_FRAMES = new Set([
  'libsystem_pthread.dylib.thread_start',
  'libsystem_pthread.dylib._pthread_start',
  'libjli.dylib.apple_main',
  'libjli.dylib.jli_launch',
  'libjli.dylib.createexecutionenvironment',
  'libjli.dylib.continueinnewthread',
  'libjli.dylib.calljavamaininnewthread',
  'libjnode.dylib.nodemain',
  'java.main',
  'native.unknown',
]);

function isLauncherThread(thread) {
  if (thread._launcherShape !== undefined) {
    return thread._launcherShape;
  }
  let nonLauncherSelf = 0;
  const walk = (node) => {
    const key = `${node.className}.${node.methodName}`.toLowerCase();
    if (!LAUNCHER_FRAMES.has(key)) {
      nonLauncherSelf += node.self;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const root of thread.children) {
    walk(root);
  }
  const total = thread.total || 0;
  const shape = total > 0 && (thread.children || []).length > 0 && nonLauncherSelf / total < 0.01;
  thread._launcherShape = shape;
  return shape;
}

const JVM_INTERNAL_EXACT = new Set([
  'finalizer',
  'reference handler',
  'signal dispatcher',
  'notification thread',
  'common-cleaner',
  'watchdog',
  'attach listener',
  'keep-alive-timer',
  'process reaper',
  'destroyjavavm',
  'jna cleaner',
  'async-profiler timer',
  'monitor deflation thread',
  'service thread',
  'sweeper thread',
  'gc thread',
]);
const JVM_INTERNAL_PREFIX_RE = /^(java: |vm |g1 |shenandoah|z |c1 |c2 |s5 |nmt )/iu;

function isJvmInternalThread(name) {
  const stripped = String(name || '')
    .toLowerCase()
    .replace(/\s*\(x\d+\)\s*$/u, '')
    .trim();
  return JVM_INTERNAL_EXACT.has(stripped) || JVM_INTERNAL_PREFIX_RE.test(stripped) || /compilerthread\d*$/iu.test(stripped);
}

function threadMergeCount(name) {
  const match = /\(x(\d+)\)\s*$/iu.exec(String(name || ''));
  return match ? Number(match[1]) : 1;
}

function topFrameOf(thread) {
  const root = (thread.children || []).slice().sort((a, b) => b.total - a.total)[0];
  return root ? methodText(root, 42) : 'n/a';
}

/**
 * Server main-thread names, most specific first. Paper/Spigot/Fabric call it
 * "Server thread"; Nukkit (and MOT) run their tick loop on the JVM startup
 * thread, literally named "main".
 */
const MAIN_THREAD_NAMES = [
  /^server thread$/iu,
  /^main$/iu,
  /^server main thread$/iu,
  /^main thread$/iu,
];

/* ---------------------------------------------------------------------------------------------- */
/* Formatting                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'n/a';
  }
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) {
    return 'n/a';
  }
  const abs = Math.abs(ms);
  if (abs === 0) {
    return '0 ms';
  }
  if (abs < 1) {
    return `${ms.toFixed(2)} ms`;
  }
  if (abs < 1000) {
    return `${ms.toFixed(1)} ms`;
  }
  if (abs < 60_000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  let minutes = Math.floor(ms / 60_000);
  let seconds = Math.round((ms % 60_000) / 1000);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  const total = Math.round(seconds);
  if (total < 60) {
    return `${total}s`;
  }
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatPercent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return '0.00%';
  }
  const pct = (value / total) * 100;
  if (pct > 0 && pct < 0.01) {
    return '<0.01%';
  }
  return `${pct.toFixed(2)}%`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return Math.round(value).toLocaleString('en-US');
}

function formatTimestamp(ms, short = false) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 'unknown';
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  const iso = date.toISOString();
  if (short) {
    return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  }
  return `${iso.replace('T', ' ').replace('Z', ' UTC')}`;
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, ' ');
}

function truncate(text, max = MAX_CELL) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function table(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

function clampLimit(value, fallback, max = MAX_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.trunc(number)));
}

function formatPercentValue(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : 'n/a';
}

const METRIC_SERIES = [
  { key: 'tps', label: 'TPS', pick: (value) => value, format: (value) => value.toFixed(2) },
  {
    key: 'tickDuration',
    label: 'MSPT median',
    pick: (value) => value?.median,
    format: (value) => formatMs(value),
  },
  {
    key: 'cpuUsageProcess',
    label: 'CPU process',
    pick: (value) => value * 100,
    format: (value) => formatPercentValue(value),
  },
  {
    key: 'cpuUsageSystem',
    label: 'CPU system',
    pick: (value) => value * 100,
    format: (value) => formatPercentValue(value),
  },
  {
    key: 'memoryUsageHeap',
    label: 'Heap used',
    pick: (value) => value?.used,
    format: (value) => formatBytes(value),
  },
  {
    key: 'memoryUsageNonHeap',
    label: 'Non-heap used',
    pick: (value) => value?.used,
    format: (value) => formatBytes(value),
  },
  {
    key: 'memoryAllocation',
    label: 'Allocation rate',
    pick: (value) => value,
    format: (value) => `${formatBytes(value)}/s`,
  },
  {
    key: 'worldInfo',
    label: 'Entities',
    pick: (value) => value?.entities,
    format: (value) => formatNumber(value),
  },
  {
    key: 'worldInfo',
    label: 'Chunks',
    pick: (value) => value?.chunks,
    format: (value) => formatNumber(value),
  },
  {
    key: 'playerPing',
    label: 'Player ping (mean)',
    pick: (value) => value?.mean,
    format: (value) => formatMs(value),
  },
];

/* ---------------------------------------------------------------------------------------------- */
/* Model helpers                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

function samplerMode(parsed) {
  const mode = parsed.metadata?.samplerMode;
  return mode === MODE_ALLOCATION || mode === MODE_LOCK ? mode : MODE_EXECUTION;
}

function modeInfo(parsed) {
  const mode = samplerMode(parsed);
  if (mode === MODE_ALLOCATION) {
    return {
      mode,
      label: 'allocation',
      noun: 'allocated',
      topTitle: 'Top allocation sites',
      value: (value) => formatBytes(value),
    };
  }
  if (mode === MODE_LOCK) {
    return {
      mode,
      label: 'lock',
      noun: 'lock wait',
      topTitle: 'Top lock contention sites',
      value: (value) => formatMs(value),
    };
  }
  return {
    mode,
    label: 'execution',
    noun: 'sampled',
    topTitle: 'Hotspots',
    value: (value) => formatMs(value),
  };
}

function engineLabel(engine) {
  if (engine === 1) {
    return 'async';
  }
  if (engine === 0) {
    return 'java';
  }
  return 'unknown engine';
}

function platformTypeLabel(type) {
  switch (type) {
    case 1:
      return 'client';
    case 2:
      return 'proxy';
    case 3:
      return 'application';
    default:
      return 'server';
  }
}

function threadGroups(parsed) {
  return parsed.threads?.length || 0;
}

function sumThreadTotals(parsed) {
  return (parsed.threads || []).reduce((total, thread) => total + (thread.total || 0), 0);
}

function chooseThread(parsed, selector) {
  const threads = parsed.threads || [];
  if (threads.length === 0) {
    throw new Error('this spark profile contains no sampled threads');
  }

  if (selector !== undefined && selector !== null && String(selector).trim() !== '') {
    const wanted = String(selector).trim().toLowerCase();
    const exact = threads.find((thread) => thread.name.toLowerCase() === wanted);
    if (exact) {
      return { thread: exact, note: undefined };
    }
    const matches = threads.filter((thread) => thread.name.toLowerCase().includes(wanted));
    if (matches.length === 0) {
      const names = threads
        .slice()
        .sort((a, b) => b.total - a.total)
        .slice(0, 8)
        .map((thread) => thread.name);
      throw new Error(
        `thread "${selector}" was not found. Available thread groups include: ${names.join(', ')}`,
      );
    }
    matches.sort((a, b) => b.total - a.total);
    return {
      thread: matches[0],
      note:
        matches.length > 1
          ? `"${selector}" matched ${matches.length} threads; using the busiest: ${matches[0].name}.`
          : undefined,
    };
  }

  const execution = samplerMode(parsed) === MODE_EXECUTION;
  for (const pattern of MAIN_THREAD_NAMES) {
    // Skip launcher-shaped matches: a "main" whose whole stack is the JVM
    // launcher skeleton is parked, not the tick loop.
    const hit = threads.find((thread) => pattern.test(thread.name) && !isLauncherThread(thread));
    if (hit) {
      return {
        thread: hit,
        note: /server thread/iu.test(hit.name)
          ? undefined
          : `Using the server main thread "${hit.name}" (matched built-in main-thread name; the tick loop runs here on this platform).`,
      };
    }
  }

  if (execution) {
    // No known main-thread name (proxies, custom servers). Rank by on-CPU
    // time: total minus kernel-wait subtrees, ignoring JVM-internal groups
    // (GC/JIT/service threads), which are never the analysis target.
    const eligible = threads.filter((thread) => !isJvmInternalThread(thread.name));
    const pool = eligible.length > 0 ? eligible : threads;
    const best = pool
      .slice()
      .sort((a, b) => threadWaitInfo(b).onCpu - threadWaitInfo(a).onCpu || b.total - a.total)[0];
    const info = threadWaitInfo(best);
    return {
      thread: best,
      note:
        threads.length > 1
          ? `No known server main-thread name matched; using the thread with the most on-CPU time (kernel waits excluded), ${best.name} (≈${formatMs(
              info.onCpu,
            )} of ${formatMs(best.total)}).`
          : undefined,
    };
  }

  const busiest = threads.slice().sort((a, b) => b.total - a.total)[0];
  return {
    thread: busiest,
    note:
      threads.length > 1
        ? `Using the busiest thread, ${busiest.name}.`
        : undefined,
  };
}

function methodText(node, max = MAX_CELL) {
  let name;
  if (node.className && node.methodName) {
    name = `${node.className}.${node.methodName}`;
  } else if (node.className) {
    name = node.className;
  } else if (node.methodName) {
    name = node.methodName;
  } else {
    name = '(unknown frame)';
  }
  if (node.lineNumber > 0) {
    name += `:${node.lineNumber}`;
  }
  return truncate(name, max);
}

function buildMethodGroups(thread) {
  if (thread._methodGroups) {
    return thread._methodGroups;
  }

  const groups = new Map();

  const visit = (node, ancestors) => {
    const key = `${node.className}#${node.methodName}#${node.methodDesc || ''}`;
    const duplicate = ancestors.has(key);
    if (!duplicate) {
      ancestors.add(key);
    }

    for (const child of node.children) {
      visit(child, ancestors);
    }

    if (!duplicate) {
      ancestors.delete(key);
    }

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        className: node.className,
        methodName: node.methodName,
        methodDesc: node.methodDesc,
        search: `${node.className}.${node.methodName}`.toLowerCase(),
        self: 0,
        total: 0,
        nodes: 0,
        recursive: 0,
      };
      groups.set(key, group);
    }

    group.self += node.self;
    if (!duplicate) {
      group.total += node.total;
      group.nodes += 1;
    } else {
      group.recursive += 1;
    }
  };

  for (const root of thread.children) {
    visit(root, new Set());
  }

  thread._methodGroups = [...groups.values()];
  return thread._methodGroups;
}

function sortedMethods(thread, sort, query, limit) {
  let groups = buildMethodGroups(thread);
  if (query) {
    const needle = String(query).toLowerCase();
    groups = groups.filter((group) => group.search.includes(needle));
  }
  const mode = sort === 'total' ? 'total' : 'self';
  groups = groups.slice().sort((a, b) => {
    const primary = mode === 'total' ? b.total - a.total : b.self - a.self;
    if (primary !== 0) {
      return primary;
    }
    return b.self - a.self || b.total - a.total || a.key.localeCompare(b.key);
  });
  return { groups: groups.slice(0, limit), sort: mode, totalMatches: groups.length };
}

function sourceOf(node, parsed) {
  if (!node.className) {
    return undefined;
  }
  if (node.className.startsWith('com.destroystokyo.paper.event.executor.asm.generated.')) {
    return undefined;
  }

  const classSources = parsed.classSources;
  const methodSources = parsed.methodSources;
  const lineSources = parsed.lineSources;

  if (methodSources && node.methodName && node.methodDesc) {
    const source = methodSources[`${node.className};${node.methodName};${node.methodDesc}`];
    if (source) {
      return source;
    }
  }
  if (lineSources && node.lineNumber > 0) {
    const source = lineSources[`${node.className};${node.lineNumber}`];
    if (source) {
      return source;
    }
  }
  if (classSources) {
    return classSources[node.className];
  }
  return undefined;
}

function hasSourceMaps(parsed) {
  return Boolean(
    (parsed.classSources && Object.keys(parsed.classSources).length > 0) ||
      (parsed.methodSources && Object.keys(parsed.methodSources).length > 0) ||
      (parsed.lineSources && Object.keys(parsed.lineSources).length > 0),
  );
}

function buildSourceStats(parsed, thread) {
  if (!hasSourceMaps(parsed)) {
    return null;
  }

  const stats = new Map();
  const add = (source, node) => {
    let row = stats.get(source);
    if (!row) {
      row = { source, self: 0, nodes: 0 };
      stats.set(source, row);
    }
    row.self += node.self;
    row.nodes += 1;
  };

  const stack = thread.children.slice();
  while (stack.length > 0) {
    const node = stack.pop();
    add(sourceOf(node, parsed) || '(unattributed)', node);
    for (const child of node.children) {
      stack.push(child);
    }
  }

  if (thread.self > 0) {
    const row = stats.get('(unattributed)') || { source: '(unattributed)', self: 0, nodes: 0 };
    row.self += thread.self;
    stats.set('(unattributed)', row);
  }

  const rows = [...stats.values()].filter((row) => row.self > 0).sort((a, b) => b.self - a.self);
  const mappedSelf = rows
    .filter((row) => !['minecraft', 'java', '(unattributed)'].includes(row.source))
    .reduce((total, row) => total + row.self, 0);

  return { rows, mappedSelf, totalSelf: thread.total };
}

/* ---------------------------------------------------------------------------------------------- */
/* Plugins, world, system, and metric series                                                       */
/* ---------------------------------------------------------------------------------------------- */

function sourceEntries(parsed) {
  const sources = parsed.metadata?.sources || {};
  return Object.entries(sources)
    .map(([key, value]) => ({
      key,
      name: value?.name || key,
      version: value?.version || '',
      author: value?.author || '',
      description: value?.description || '',
      builtin: Boolean(value?.builtin),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pluginLines(parsed) {
  const plugins = sourceEntries(parsed);
  if (plugins.length === 0) {
    return [];
  }
  const names = plugins
    .slice(0, 5)
    .map((plugin) => `${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}`);
  return [
    `- Plugins/mods: ${formatNumber(plugins.length)} known — ${names.join(', ')}${plugins.length > 5 ? ', …' : ''}`,
  ];
}

function worldEntityCount(world) {
  const total = Number(world?.totalEntities);
  if (Number.isFinite(total) && total > 0) {
    return total;
  }
  return (world?.regions || []).reduce((sum, region) => sum + (Number(region.totalEntities) || 0), 0);
}

function worldChunkCount(world) {
  const total = Number(world?.chunkCount);
  if (Number.isFinite(total) && total > 0) {
    return total;
  }
  return (world?.regions || []).reduce((sum, region) => sum + (region.chunks?.length || 0), 0);
}

function topEntityTypes(world, limit) {
  return Object.entries(world?.entityCounts || {})
    .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
    .map(([name, count]) => ({ name, count: Number(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function worldLines(parsed, limit = 5) {
  const world = parsed.metadata?.platformStatistics?.world;
  if (!world) {
    return [];
  }

  const lines = [];
  const worlds = (world.worlds || [])
    .map((entry) => ({
      name: entry.name || '<unnamed world>',
      entities: worldEntityCount(entry),
      chunks: worldChunkCount(entry),
    }))
    .sort((a, b) => b.entities - a.entities)
    .slice(0, limit);
  if (worlds.length > 0) {
    lines.push(
      `- Worlds: ${worlds
        .map((entry) => `${entry.name} ${formatNumber(entry.entities)} entities / ${formatNumber(entry.chunks)} chunks`)
        .join('; ')}`,
    );
  }

  const entities = topEntityTypes(world, limit);
  if (entities.length > 0) {
    lines.push(
      `- Top entities: ${entities.map((entry) => `${entry.name} ${formatNumber(entry.count)}`).join('; ')}`,
    );
  }

  const gameRuleCount = world.gameRules?.length || Number(world.gameRuleCount) || 0;
  const dataPackCount = world.dataPacks?.length || Number(world.dataPackCount) || 0;
  const extra = [];
  if (gameRuleCount > 0) {
    extra.push(`${formatNumber(gameRuleCount)} game rules`);
  }
  if (dataPackCount > 0) {
    extra.push(`${formatNumber(dataPackCount)} data packs`);
  }
  if (extra.length > 0) {
    lines.push(`- World metadata: ${extra.join(', ')}`);
  }

  return lines;
}

function systemLines(parsed, limit = 3) {
  const ps = parsed.metadata?.platformStatistics;
  const sys = parsed.metadata?.systemStatistics;
  const lines = [];

  const pools = (ps?.memory?.pools || [])
    .filter((pool) => pool?.usage)
    .map((pool) => ({
      name: pool.name || '<unnamed pool>',
      used: Number(pool.usage.used) || 0,
      max: Number(pool.usage.max) || 0,
    }))
    .filter((pool) => pool.used > 0)
    .sort((a, b) => b.used - a.used)
    .slice(0, limit);
  if (pools.length > 0) {
    lines.push(
      `- Memory pools: ${pools
        .map((pool) => `${pool.name} ${formatBytes(pool.used)}${pool.max > 0 ? ` / ${formatBytes(pool.max)}` : ''}`)
        .join('; ')}`,
    );
  }

  const interfaces = Object.entries(sys?.net || {})
    .map(([name, value]) => ({
      name,
      rx: Number(value?.rxBytesPerSecond?.mean) || 0,
      tx: Number(value?.txBytesPerSecond?.mean) || 0,
    }))
    .filter((entry) => entry.rx > 0 || entry.tx > 0)
    .sort((a, b) => b.rx + b.tx - (a.rx + a.tx))
    .slice(0, limit);
  if (interfaces.length > 0) {
    lines.push(
      `- Network: ${interfaces
        .map((entry) => `${entry.name} RX ${formatBytes(entry.rx)}/s / TX ${formatBytes(entry.tx)}/s`)
        .join('; ')}`,
    );
  }

  const ping = ps?.ping?.last15m;
  if (ping && Number.isFinite(ping.median) && ping.median > 0) {
    const p95 = Number.isFinite(ping.percentile95) ? `, p95 ${formatMs(ping.percentile95)}` : '';
    lines.push(`- Ping: median ${formatMs(ping.median)}${p95} (15m)`);
  }

  const onlineMode = Number(ps?.onlineMode);
  if (onlineMode === 1 || onlineMode === 2) {
    lines.push(`- Online mode: ${onlineMode === 2 ? 'online' : 'offline'}`);
  }

  return lines;
}

function metadataLines(parsed) {
  const lines = [...pluginLines(parsed), ...worldLines(parsed), ...systemLines(parsed)];
  return lines.length > 0 ? ['## Plugins and environment', ...lines, ''] : [];
}

function metricPoints(series, pick) {
  if (!series || !Array.isArray(series.values)) {
    return [];
  }
  const deltas = series.timestampDeltasMs || [];
  let time = Number(series.startTimestampMs) || 0;
  const points = [];
  for (let i = 0; i < series.values.length; i += 1) {
    time += Number(deltas[i]) || 0;
    const value = pick(series.values[i]);
    if (Number.isFinite(value)) {
      points.push({ time, value });
    }
  }
  return points;
}

function metricRows(parsed) {
  const metrics = parsed.metadata?.metrics;
  if (!metrics) {
    return [];
  }
  return METRIC_SERIES.map((definition) => ({
    ...definition,
    points: metricPoints(metrics[definition.key], definition.pick),
  })).filter((row) => row.points.length > 0);
}

function metricTable(rows) {
  return table(
    ['Series', 'Points', 'First', 'Last', 'Min', 'Mean', 'Max'],
    rows.map((row) => {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const point of row.points) {
        if (point.value < min) min = point.value;
        if (point.value > max) max = point.value;
        sum += point.value;
      }
      const mean = sum / row.points.length;
      return [
        row.label,
        formatNumber(row.points.length),
        row.format(row.points[0].value),
        row.format(row.points[row.points.length - 1].value),
        row.format(min),
        row.format(mean),
        row.format(max),
      ];
    }),
  );
}

function metricIntervalNote(rows) {
  const row = rows.find((entry) => entry.points.length > 1);
  if (!row) {
    return 'Series points are instantaneous samples; snapshot "(1m mean)" figures are spark rolling 1-minute averages at export time.';
  }
  const points = row.points;
  const interval = (points[points.length - 1].time - points[0].time) / (points.length - 1) / 1000;
  if (!Number.isFinite(interval) || interval <= 0) {
    return undefined;
  }
  return `Series points are instantaneous samples taken ~${formatNumber(interval)}s apart; snapshot "(1m mean)" figures are spark rolling 1-minute averages at export time, so a decaying tail can differ sharply from the rolling mean.`;
}

function metricsLines(parsed, limit = 20) {
  const rows = metricRows(parsed);
  if (rows.length === 0) {
    return [];
  }
  const note = metricIntervalNote(rows);
  return [
    '## Time-series metrics',
    `${rows.length} series from spark metrics.`,
    '',
    metricTable(rows.slice(0, limit)),
    ...(note ? ['', note] : []),
    '',
  ];
}

function metricsQuery(parsed, options) {
  const metrics = parsed.metadata?.metrics;
  if (!metrics) {
    return 'This export contains no spark metrics series.';
  }

  const query = options.query ? String(options.query).toLowerCase() : '';
  const rows = metricRows(parsed).filter(
    (row) => !query || row.label.toLowerCase().includes(query) || row.key.toLowerCase().includes(query),
  );
  if (rows.length === 0) {
    return `No metric series matched "${options.query}".`;
  }

  const limit = clampLimit(options.limit, 20);
  const selected = rows.slice(0, limit);
  const first = selected.reduce(
    (earliest, row) => Math.min(earliest, row.points[0]?.time ?? Infinity),
    Infinity,
  );
  const last = selected.reduce(
    (latest, row) => Math.max(latest, row.points[row.points.length - 1]?.time ?? -Infinity),
    -Infinity,
  );
  const lines = [
    '# Time-series metrics',
    `${rows.length} series${rows.length > selected.length ? `, showing ${selected.length}` : ''}${
      Number.isFinite(first) && Number.isFinite(last)
        ? `; range ${formatTimestamp(first, true)} → ${formatTimestamp(last, true)}`
        : ''
    }.`,
    '',
    metricTable(selected),
  ];
  const note = metricIntervalNote(selected);
  if (note) {
    lines.push('', note);
  }
  if (rows.length > selected.length) {
    lines.push('');
    lines.push(`Use a higher limit to see up to ${rows.length} series.`);
  }
  return lines.join('\n');
}

function pluginsQuery(parsed, options) {
  let plugins = sourceEntries(parsed);
  if (plugins.length === 0) {
    return 'This export contains no plugin/mod source metadata.';
  }

  const query = options.query ? String(options.query).toLowerCase() : '';
  if (query) {
    plugins = plugins.filter((plugin) =>
      `${plugin.name} ${plugin.version} ${plugin.author} ${plugin.description}`.toLowerCase().includes(query),
    );
  }
  if (plugins.length === 0) {
    return `No plugin/mod matched "${options.query}".`;
  }

  const limit = clampLimit(options.limit, 50);
  const selected = plugins.slice(0, limit);
  const lines = [
    '# Plugins and mods',
    `${plugins.length} known source${plugins.length === 1 ? '' : 's'}${plugins.length > selected.length ? `, showing ${selected.length}` : ''}.`,
    '',
    table(
      ['Name', 'Version', 'Author', 'Builtin'],
      selected.map((plugin) => [
        truncate(plugin.name, 80),
        plugin.version || '-',
        plugin.author || '-',
        plugin.builtin ? 'yes' : 'no',
      ]),
    ),
  ];
  return lines.join('\n');
}

function worldQuery(parsed, options) {
  const world = parsed.metadata?.platformStatistics?.world;
  if (!world) {
    return 'This export contains no world statistics.';
  }

  const limit = clampLimit(options.limit, 15);
  const query = options.query ? String(options.query).toLowerCase() : '';
  const matches = (value) => !query || String(value || '').toLowerCase().includes(query);
  const entities = topEntityTypes(world, Math.max(limit, 1)).filter((entry) => matches(entry.name));
  const worlds = (world.worlds || [])
    .map((entry) => ({
      name: entry.name || '<unnamed world>',
      entities: worldEntityCount(entry),
      chunks: worldChunkCount(entry),
    }))
    .filter((entry) => matches(entry.name))
    .sort((a, b) => b.entities - a.entities)
    .slice(0, limit);
  const gameRules = (world.gameRules || []).filter((rule) => matches(rule.name)).slice(0, limit);
  const dataPacks = (world.dataPacks || []).filter((pack) => matches(pack.name)).slice(0, limit);

  if (entities.length === 0 && worlds.length === 0 && gameRules.length === 0 && dataPacks.length === 0) {
    return query ? `No world data matched "${options.query}".` : 'This export contains no detailed world data.';
  }

  const lines = [
    '# World statistics',
    `- Total entities: ${formatNumber(world.totalEntities)}`,
    `- Entity types: ${formatNumber(Object.keys(world.entityCounts || {}).length)}`,
    `- Worlds: ${formatNumber((world.worlds || []).length)}`,
    `- Game rules: ${formatNumber((world.gameRules || []).length || Number(world.gameRuleCount) || 0)}; data packs: ${formatNumber((world.dataPacks || []).length || Number(world.dataPackCount) || 0)}`,
  ];
  if (entities.length > 0) {
    lines.push('', '## Entity types', '', table(['Type', 'Count'], entities.map((entry) => [entry.name, formatNumber(entry.count)])));
  }
  if (worlds.length > 0) {
    lines.push(
      '',
      '## Worlds',
      '',
      table(
        ['World', 'Entities', 'Chunks'],
        worlds.map((entry) => [entry.name, formatNumber(entry.entities), formatNumber(entry.chunks)]),
      ),
    );
  }
  if (gameRules.length > 0) {
    lines.push(
      '',
      '## Game rules',
      '',
      table(
        ['Rule', 'Default'],
        gameRules.map((rule) => [rule.name || '<unnamed>', rule.defaultValue || '-']),
      ),
    );
  }
  if (dataPacks.length > 0) {
    lines.push(
      '',
      '## Data packs',
      '',
      table(
        ['Name', 'Source', 'Builtin'],
        dataPacks.map((pack) => [pack.name || '<unnamed>', pack.source || '-', pack.builtin ? 'yes' : 'no']),
      ),
    );
  }
  return lines.join('\n');
}

function systemQuery(parsed, options) {
  const ps = parsed.metadata?.platformStatistics;
  const sys = parsed.metadata?.systemStatistics;
  if (!ps && !sys) {
    return 'This export contains no system statistics.';
  }

  const limit = clampLimit(options.limit, 15);
  const query = options.query ? String(options.query).toLowerCase() : '';
  const matches = (value) => !query || String(value || '').toLowerCase().includes(query);

  const pools = (ps?.memory?.pools || [])
    .filter((pool) => matches(pool.name))
    .slice(0, limit)
    .map((pool) => [
      pool.name || '<unnamed>',
      formatBytes(pool.usage?.used ?? 0),
      formatBytes(pool.usage?.committed ?? 0),
      pool.usage?.max > 0 ? formatBytes(pool.usage.max) : 'n/a',
      pool.collectionUsage?.used > 0 ? formatBytes(pool.collectionUsage.used) : '-',
    ]);

  const interfaces = Object.entries(sys?.net || {})
    .filter(([name]) => matches(name))
    .slice(0, limit)
    .map(([name, value]) => [
      name,
      `${formatBytes(value?.rxBytesPerSecond?.mean ?? 0)}/s`,
      `${formatBytes(value?.txBytesPerSecond?.mean ?? 0)}/s`,
      `${formatNumber(value?.rxPacketsPerSecond?.mean ?? 0)}/s`,
      `${formatNumber(value?.txPacketsPerSecond?.mean ?? 0)}/s`,
    ]);

  if (query && pools.length === 0 && interfaces.length === 0 && !matches(sys?.os?.name) && !matches(sys?.java?.version)) {
    return `No system data matched "${options.query}".`;
  }

  const lines = ['# System and memory'];
  const cpu = sys?.cpu;
  if (cpu) {
    const process = cpu.processUsage?.last1m;
    const system = cpu.systemUsage?.last1m;
    if (Number.isFinite(process)) {
      lines.push(
        `- CPU: process ${cpuProcessText(process, cpu.threads)}, system ${formatPercentValue((system || 0) * 100)} (1m)`,
      );
    }
    if (cpu.modelName) {
      lines.push(`- CPU model: ${truncate(cpu.modelName, 100)}`);
    }
  }
  if (ps?.memory?.heap) {
    const heap = ps.memory.heap;
    lines.push(
      `- Heap: ${formatBytes(heap.used)} used, ${formatBytes(heap.committed)} committed, ${heap.max > 0 ? `${formatBytes(heap.max)} max` : 'max n/a'}`,
    );
  }
  if (ps?.memory?.nonHeap?.used) {
    lines.push(`- Non-heap: ${formatBytes(ps.memory.nonHeap.used)} used`);
  }
  if (sys?.disk?.total > 0) {
    lines.push(`- Disk: ${formatBytes(sys.disk.used)} / ${formatBytes(sys.disk.total)}`);
  }
  if (sys?.os?.name) {
    lines.push(
      `- OS: ${sys.os.name} ${sys.os.version || ''}${sys.os.arch ? ` (${sys.os.arch})` : ''}`.trim(),
    );
  }
  if (sys?.java?.version) {
    lines.push(`- Java: ${sys.java.version}${sys.java.vendor ? ` (${sys.java.vendor})` : ''}`);
  }
  if (sys?.jvm?.name) {
    lines.push(`- JVM: ${sys.jvm.name}${sys.jvm.version ? ` ${sys.jvm.version}` : ''}`);
  }
  if (sys?.uptime > 0) {
    lines.push(`- Uptime: ${formatSeconds(sys.uptime)}`);
  }
  const ping = ps?.ping?.last15m;
  if (ping && Number.isFinite(ping.median)) {
    lines.push(`- Ping: median ${formatMs(ping.median)}, p95 ${formatMs(ping.percentile95)} (15m)`);
  }
  if (Number(ps?.onlineMode) === 1 || Number(ps?.onlineMode) === 2) {
    lines.push(`- Online mode: ${Number(ps.onlineMode) === 2 ? 'online' : 'offline'}`);
  }
  const configKeys = Object.keys(parsed.metadata?.serverConfigurations || {});
  if (configKeys.length > 0) {
    lines.push(`- Server config keys: ${truncate(configKeys.join(', '), 200)}`);
  }
  const extraKeys = Object.keys(parsed.metadata?.extraPlatformMetadata || {});
  if (extraKeys.length > 0) {
    lines.push(`- Extra platform metadata keys: ${truncate(extraKeys.join(', '), 200)}`);
  }

  if (pools.length > 0) {
    lines.push('', '## Memory pools', '', table(['Pool', 'Used', 'Committed', 'Max', 'Collection used'], pools));
  }
  if (interfaces.length > 0) {
    lines.push('', '## Network interfaces', '', table(['Interface', 'RX', 'TX', 'RX packets', 'TX packets'], interfaces));
  }
  if (pools.length === 0 && interfaces.length === 0 && lines.length === 1) {
    lines.push('- No detailed memory-pool or network data was included.');
  }
  return lines.join('\n');
}

function selectWindowThread(parsed, thread, selector) {
  const windows = parsed.timeWindows || [];
  if (windows.length === 0) {
    throw new Error('this profile does not contain per-window stack times');
  }
  if (!Array.isArray(thread.times) || thread.times.length !== windows.length) {
    throw new Error('this profile does not contain per-window stack times for the selected thread');
  }

  const index = Number(selector) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= windows.length) {
    throw new Error(`window must be between 1 and ${windows.length}`);
  }

  let nodeCount = 0;
  let maxDepth = 0;
  const cloneNode = (node, depth) => {
    nodeCount += 1;
    if (nodeCount > 4_000_000) {
      throw new Error('the selected window has too many stack nodes');
    }
    if (depth > 4096) {
      throw new Error('the selected window stack is deeper than 4096 frames');
    }
    maxDepth = Math.max(maxDepth, depth);
    const selected = Number(node.times?.[index]);
    const total = Number.isFinite(selected) ? selected : 0;
    const children = (node.children || []).map((child) => cloneNode(child, depth + 1));
    const childTotal = children.reduce((sum, child) => sum + child.total, 0);
    return {
      ...node,
      times: [total],
      total,
      self: Math.max(0, total - childTotal),
      children,
      childrenRefs: null,
    };
  };

  const roots = (thread.children || []).map((node) => cloneNode(node, 1));
  const rootTotal = roots.reduce((sum, node) => sum + node.total, 0);
  const selectedTotal = Number(thread.times[index]);
  const total = Number.isFinite(selectedTotal) ? selectedTotal : rootTotal;
  const statistics = (parsed.windowStatistics || []).find((window) => window.key === windows[index]);
  const when = statistics?.startTime
    ? formatTimestamp(statistics.startTime, true)
    : `key ${windows[index]}`;

  const selectedThread = {
    ...thread,
    times: [total],
    total,
    self: Math.max(0, total - rootTotal),
    children: roots,
    nodeCount,
    maxDepth,
    windowCount: 1,
  };
  delete selectedThread._methodGroups;
  // Drop per-thread analysis caches too: their values describe the whole
  // profile and would be wrong (and never recomputed) for the window clone.
  delete selectedThread._waitInfo;
  delete selectedThread._launcherShape;

  return {
    thread: selectedThread,
    label: `window ${index + 1}/${windows.length} · ${when}`,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Summary                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export function buildSummary(parsed, options = {}) {
  const limit = clampLimit(options.limit, 10);

  if (parsed.kind === 'heap') {
    return heapSummary(parsed, limit);
  }
  if (parsed.kind === 'health') {
    return healthSummary(parsed);
  }
  return samplerSummary(parsed, limit, options.thread);
}

function kindTitle(parsed) {
  if (parsed.kind === 'heap') {
    return 'Spark heap summary';
  }
  if (parsed.kind === 'health') {
    return 'Spark health report';
  }
  return 'Spark profile summary';
}

function headerLines(parsed) {
  const lines = [`# ${kindTitle(parsed)}`, ''];
  const file = parsed.file;
  const size = file?.size === undefined ? '' : ` (${formatBytes(file.size)}${file.compressed ? ', gzip-compressed' : ''})`;
  lines.push(`- File: ${file?.path || 'spark export'}${size}`);
  lines.push(`- Kind: ${kindLabel(parsed)}`);

  const platform = parsed.metadata?.platform;
  if (platform) {
    const bits = [];
    if (platform.name) {
      bits.push(`${platform.name}${platform.version ? ` ${platform.version}` : ''}`);
    }
    if (platform.minecraftVersion) {
      bits.push(`Minecraft ${platform.minecraftVersion}`);
    }
    if (platform.brand && platform.brand !== platform.name) {
      bits.push(platform.brand);
    }
    if (platform.dataVersion) {
      bits.push(`data version ${platform.dataVersion}`);
    }
    if (platform.sparkVersion) {
      bits.push(`spark ${platform.sparkVersion}`);
    }
    bits.push(platformTypeLabel(platform.type));
    lines.push(`- Platform: ${bits.join(' · ')}`);
  } else {
    lines.push('- Platform: metadata missing');
  }

  lines.push(...mappingsLines(parsed));

  const creator = parsed.metadata?.creator;
  if (creator?.name) {
    lines.push(`- Captured by: ${creator.name}${creator.type === 1 ? ' (player)' : ''}`);
  }

  if (parsed.kind === 'sampler') {
    const start = parsed.metadata?.startTime;
    const end = parsed.metadata?.endTime;
    if (start && end) {
      lines.push(
        `- Capture window: ${formatTimestamp(start)} → ${formatTimestamp(end)} (${formatMs(
          Math.max(0, end - start),
        )})`,
      );
    } else if (start) {
      lines.push(`- Capture started: ${formatTimestamp(start)}`);
    }

    const mode = modeInfo(parsed);
    const metadata = parsed.metadata;
    const details = [
      `${mode.label} mode`,
      `${engineLabel(metadata?.samplerEngine)} engine${metadata?.samplerEngineVersion ? ` ${metadata.samplerEngineVersion}` : ''}`,
    ];
    if (metadata?.interval > 0) {
      if (mode.mode === MODE_ALLOCATION) {
        details.push(`interval ${formatBytes(metadata.interval)}`);
      } else {
        const ms = metadata.interval / 1000;
        details.push(`interval ${formatNumber(metadata.interval)} µs (${ms.toFixed(2)} ms)`);
      }
    }
    if (metadata?.numberOfTicks > 0) {
      details.push(`${formatNumber(metadata.numberOfTicks)} ticks`);
    }
    details.push(`${threadGroups(parsed)} thread group${threadGroups(parsed) === 1 ? '' : 's'}`);
    lines.push(`- Sampler: ${details.join(' · ')}`);

    const dumper = metadata?.threadDumper;
    if (dumper) {
      const type = dumper.type === 1 ? 'specific threads' : dumper.type === 2 ? 'regex-matched threads' : 'all threads';
      const patterns = dumper.patterns?.length ? ` (${dumper.patterns.join(', ')})` : '';
      lines.push(`- Scope: ${type}${patterns}`);
    }
  } else {
    const generated = parsed.metadata?.generatedTime;
    if (generated) {
      lines.push(`- Generated: ${formatTimestamp(generated)}`);
    }
  }

  if (parsed.metadata?.comment) {
    lines.push(`- Comment: ${truncate(parsed.metadata.comment, 300)}`);
  }

  lines.push('');
  return lines;
}

function kindLabel(parsed) {
  if (parsed.kind === 'heap') {
    return 'heap summary';
  }
  if (parsed.kind === 'health') {
    return 'health report (no stack samples)';
  }
  return 'sampler profile';
}

/**
 * One header line describing the mappings that were (or were not) applied.
 * Absent when the tool never attempted remapping, e.g. health reports.
 */
function mappingsLines(parsed) {
  const mappings = parsed.mappings;
  if (!mappings) {
    return [];
  }

  if (mappings.applied) {
    // applied implies frames > 0: every counted frame had a name rewritten.
    const noun = parsed.kind === 'heap' ? 'entries' : 'frames';
    const details =
      parsed.kind === 'heap'
        ? `${formatNumber(mappings.classes)} classes`
        : `${formatNumber(mappings.classes)} classes, ${formatNumber(mappings.methods)} methods`;
    return [
      `- Mappings: ${mappings.label || 'Mojang mappings'} — ${formatNumber(mappings.frames)} ${noun} remapped (${details})`,
    ];
  }

  if (mappings.note) {
    const prefix = mappings.skipped ? 'not needed' : 'not applied';
    return [`- Mappings: ${prefix} — ${mappings.note}`];
  }
  return [];
}

/**
 * spark normalizes process/system CPU load to total capacity: 1.0 = every
 * logical core busy. State that denominator so the percentage is not read
 * as a single-core share.
 */
function cpuProcessText(process, threads) {
  const percent = `${((process || 0) * 100).toFixed(2)}%`;
  if (Number.isFinite(threads) && threads > 0) {
    return `${percent} of ${formatNumber(threads)} threads total (≈${(process * threads).toFixed(2)} cores)`;
  }
  return percent;
}

function performanceLines(parsed) {
  const lines = ['## Performance snapshot'];
  const ps = parsed.metadata?.platformStatistics;
  const sys = parsed.metadata?.systemStatistics;
  const latest = latestWindow(parsed);
  let wrote = false;
  let tickStatsReported = false;

  const tps = ps?.tps || (latest ? { last1m: latest.tps, last5m: latest.tps, last15m: latest.tps } : null);
  if (tps && (tps.last1m > 0 || tps.last5m > 0 || tps.last15m > 0)) {
    const target = tps.gameTargetTps > 0 ? `, target ${tps.gameTargetTps.toFixed(2)}` : '';
    lines.push(
      `- TPS: ${tps.last1m.toFixed(2)} / ${tps.last5m.toFixed(2)} / ${tps.last15m.toFixed(2)} (1m / 5m / 15m${target})`,
    );
    wrote = true;
    tickStatsReported = true;
  }

  const mspt = ps?.mspt?.last5m || ps?.mspt?.last1m;
  if (mspt && (mspt.median > 0 || mspt.max > 0)) {
    const window = ps.mspt.last5m ? '5m' : '1m';
    lines.push(
      `- MSPT: ${mspt.median.toFixed(2)} ms median, ${mspt.percentile95.toFixed(2)} ms p95, ${mspt.max.toFixed(2)} ms max (${window})`,
    );
    wrote = true;
    tickStatsReported = true;
  } else if (latest && latest.msptMedian > 0) {
    lines.push(
      `- MSPT: ${latest.msptMedian.toFixed(2)} ms median, ${latest.msptMax.toFixed(2)} ms max (latest tick window)`,
    );
    wrote = true;
    tickStatsReported = true;
  }

  const cpu = sys?.cpu;
  if (cpu?.processUsage && Number.isFinite(cpu.processUsage.last1m)) {
    const system = cpu.systemUsage?.last1m;
    const systemText = Number.isFinite(system) ? `, system ${(system * 100).toFixed(2)}%` : '';
    lines.push(`- CPU: process ${cpuProcessText(cpu.processUsage.last1m, cpu.threads)}${systemText} (1m)`);
    wrote = true;
  } else if (latest && latest.cpuProcess > 0) {
    lines.push(
      `- CPU: process ${cpuProcessText(latest.cpuProcess, cpu?.threads)}, system ${(
        (latest.cpuSystem || 0) * 100
      ).toFixed(2)}% (latest window)`,
    );
    wrote = true;
  }

  const memory = ps?.memory;
  if (memory?.heap) {
    const heap = memory.heap;
    const max = heap.max > 0 ? ` / ${formatBytes(heap.max)}` : '';
    const nonHeap = memory.nonHeap ? `, non-heap ${formatBytes(memory.nonHeap.used)}` : '';
    lines.push(`- Memory: heap ${formatBytes(heap.used)}${max}${nonHeap}`);
    if (memory.allocBpsLast1m?.mean > 0) {
      let reconciliation = '';
      const row = metricRows(parsed).find((entry) => entry.key === 'memoryAllocation');
      if (row && row.points.length > 0) {
        const mean = row.points.reduce((sum, point) => sum + point.value, 0) / row.points.length;
        const lastSample = row.points[row.points.length - 1].value;
        reconciliation = ` · series mean ${formatBytes(mean)}/s, last sample ${formatBytes(lastSample)}/s`;
      }
      lines.push(
        `- Allocation rate: ${formatBytes(memory.allocBpsLast1m.mean)}/s (1m mean at export)${reconciliation}`,
      );
    }
    wrote = true;
  }

  const gc = ps?.gc && Object.keys(ps.gc).length > 0 ? ps.gc : sys?.gc;
  if (gc && Object.keys(gc).length > 0) {
    const entries = Object.entries(gc)
      .filter(([, value]) => value && value.total > 0)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 3)
      .map(([name, value]) => `${name}: ${formatNumber(value.total)} collections, avg ${value.avgTime.toFixed(2)} ms`);
    if (entries.length > 0) {
      lines.push(`- GC: ${entries.join('; ')}`);
      wrote = true;
    }
  }

  if (ps?.playerCount > 0) {
    lines.push(`- Players: ${formatNumber(ps.playerCount)}`);
    wrote = true;
  }

  const uptime = ps?.uptime > 0 ? ps.uptime : sys?.uptime;
  if (uptime > 0) {
    lines.push(`- Uptime: ${formatSeconds(uptime)}`);
    wrote = true;
  }

  const world = ps?.world;
  if (world && (world.totalEntities > 0 || world.worlds?.length > 0)) {
    const metaChunks =
      world.worlds?.reduce((total, entry) => total + (entry.chunkCount || 0), 0) || 0;
    const entities = latest?.entities > 0 ? latest.entities : world.totalEntities;
    const chunks = latest?.chunks > 0 ? latest.chunks : metaChunks;
    const worlds = world.worlds?.length || 0;
    const details = [`${formatNumber(entities)} entities`];
    if (chunks > 0) {
      details.push(`${formatNumber(chunks)} chunks`);
    }
    if (worlds > 0) {
      details.push(`${formatNumber(worlds)} world${worlds === 1 ? '' : 's'}`);
    }
    lines.push(
      `- World: ${details.join(', ')}${latest ? ' (latest tick window)' : ' (capture metadata)'}`,
    );
    wrote = true;
  }

  const physical = sys?.memory?.physical;
  if (physical && physical.total > 0) {
    lines.push(`- System memory: ${formatBytes(physical.used)} / ${formatBytes(physical.total)}`);
    wrote = true;
  }

  if (sys?.disk && sys.disk.total > 0) {
    lines.push(`- System disk: ${formatBytes(sys.disk.used)} / ${formatBytes(sys.disk.total)}`);
    wrote = true;
  }

  if (sys?.os || sys?.java) {
    const bits = [];
    if (cpu?.modelName) {
      bits.push(cpu.modelName);
    }
    if (sys.os?.name) {
      bits.push(`${sys.os.name}${sys.os.version ? ` ${sys.os.version}` : ''}`);
    }
    if (sys.java?.version) {
      bits.push(`Java ${sys.java.version}${sys.java.vendor ? ` (${sys.java.vendor})` : ''}`);
    }
    if (sys.jvm?.name) {
      bits.push(sys.jvm.name);
    }
    if (bits.length > 0) {
      lines.push(`- Environment: ${bits.join(' · ')}`);
      wrote = true;
    }
  }

  if (!tickStatsReported && wrote) {
    const platformName = `${parsed.metadata?.platform?.name || ''} ${parsed.metadata?.platform?.brand || ''}`;
    lines.push(
      /nukkit/iu.test(platformName)
        ? '- TPS/MSPT: not available — the spark-nukkit build does not expose tick statistics; stack, CPU, memory, and GC data are still valid.'
        : '- TPS/MSPT: not reported by this platform or export.',
    );
  }

  if (!wrote) {
    lines.push('- No platform statistics were included in this export.');
  }

  lines.push('');
  return lines;
}

function latestWindow(parsed) {
  const windows = parsed.windowStatistics;
  if (!windows || windows.length === 0) {
    return null;
  }
  return windows[windows.length - 1];
}

const WINDOW_COLUMNS = [
  { key: 'ticks', label: 'Ticks', has: (w) => (w.ticks || 0) > 0, cell: (w) => (w.ticks > 0 ? formatNumber(w.ticks) : 'n/a') },
  { key: 'tps', label: 'TPS', has: (w) => (w.tps || 0) > 0, cell: (w) => (w.tps > 0 ? w.tps.toFixed(2) : 'n/a') },
  {
    key: 'msptMedian',
    label: 'MSPT med',
    has: (w) => (w.msptMedian || 0) > 0,
    cell: (w) => (w.msptMedian > 0 ? w.msptMedian.toFixed(2) : 'n/a'),
  },
  {
    key: 'msptMax',
    label: 'MSPT max',
    has: (w) => (w.msptMax || 0) > 0,
    cell: (w) => (w.msptMax > 0 ? w.msptMax.toFixed(2) : 'n/a'),
  },
  {
    key: 'cpu',
    label: 'CPU proc/sys %',
    has: (w) => (w.cpuProcess || 0) > 0 || (w.cpuSystem || 0) > 0,
    cell: (w) => `${((w.cpuProcess || 0) * 100).toFixed(1)} / ${((w.cpuSystem || 0) * 100).toFixed(1)}`,
  },
  { key: 'players', label: 'Players', has: (w) => (w.players || 0) > 0, cell: (w) => formatNumber(w.players) },
  { key: 'entities', label: 'Entities', has: (w) => (w.entities || 0) > 0, cell: (w) => formatNumber(w.entities) },
  {
    key: 'tiles',
    label: 'Tiles',
    has: (w) => (w.tileEntities ?? -1) >= 0,
    cell: (w) => ((w.tileEntities ?? -1) >= 0 ? formatNumber(w.tileEntities) : 'n/a'),
  },
  { key: 'chunks', label: 'Chunks', has: (w) => (w.chunks || 0) > 0, cell: (w) => formatNumber(w.chunks) },
];

function windowColumns(allWindows) {
  return WINDOW_COLUMNS.filter((column) => allWindows.some(column.has));
}

function windowTableRows(windows, allWindows = windows) {
  const indexByKey = new Map(allWindows.map((window, index) => [window.key, index + 1]));
  const columns = windowColumns(allWindows);
  return windows.map((window) => [
    formatNumber(indexByKey.get(window.key) || 0) || '?',
    formatTimestamp(window.startTime || window.key * 60_000, true),
    ...columns.map((column) => column.cell(window)),
  ]);
}

function windowHeaders(allWindows) {
  return ['#', 'Window (UTC)', ...windowColumns(allWindows).map((column) => column.label)];
}

/**
 * Pick the strongest "worst window" ordering the data supports: max MSPT,
 * then lowest TPS, then highest CPU process use. Platforms without tick
 * hooks (e.g. Nukkit) record only CPU in time-bucket windows.
 */
function worstWindowKey(windows) {
  if (windows.some((window) => (window.msptMax || 0) > 0)) {
    return 'mspt';
  }
  if (windows.some((window) => (window.tps || 0) > 0)) {
    return 'tps';
  }
  if (windows.some((window) => (window.cpuProcess || 0) > 0)) {
    return 'cpu';
  }
  return 'time';
}

function worstWindows(parsed, limit) {
  const windows = parsed.windowStatistics || [];
  const key = worstWindowKey(windows);
  const comparators = {
    mspt: (a, b) => (b.msptMax || 0) - (a.msptMax || 0) || (a.tps || Infinity) - (b.tps || Infinity) || (b.cpuProcess || 0) - (a.cpuProcess || 0),
    tps: (a, b) => (a.tps || Infinity) - (b.tps || Infinity) || (b.cpuProcess || 0) - (a.cpuProcess || 0),
    cpu: (a, b) => (b.cpuProcess || 0) - (a.cpuProcess || 0),
    time: () => 0,
  };
  return { windows: windows.slice().sort(comparators[key]).slice(0, limit), key };
}

function windowOrderDescription(key) {
  switch (key) {
    case 'mspt':
      return 'ordered by maximum MSPT';
    case 'tps':
      return 'ordered by lowest TPS';
    case 'cpu':
      return 'ordered by CPU process use (tick statistics not recorded; windows are time buckets)';
    default:
      return 'in chronological order';
  }
}

function windowsLines(parsed, limit = 5, sort = 'worst') {
  const windows = parsed.windowStatistics || [];
  if (windows.length === 0) {
    return [];
  }

  let selected;
  let key;
  if (sort === 'time') {
    selected = windows.slice(0, limit);
    key = 'time';
  } else {
    ({ windows: selected, key } = worstWindows(parsed, limit));
  }

  const lines = [
    '## Tick windows',
    `${selected.length} of ${windows.length} window${windows.length === 1 ? '' : 's'} shown, ${windowOrderDescription(key)}.`,
    '',
    table(windowHeaders(windows), windowTableRows(selected, windows)),
    '',
  ];
  return lines;
}

function captureMultipleNote(parsed) {
  const start = parsed.metadata?.startTime;
  const end = parsed.metadata?.endTime;
  if (!(end > start)) {
    return undefined;
  }
  const capture = end - start;
  const sum = sumThreadTotals(parsed);
  if (sum <= capture * 1.5) {
    return undefined;
  }
  const groups = (parsed.threads || []).length;
  return `Sampled totals sum to ${(sum / capture).toFixed(1)}× the ${formatMs(
    capture,
  )} capture: ${groups} groups were sampled concurrently and (xN) groups merge N threads, so these are not wall-clock shares.`;
}

function threadShareNotes(parsed, execution) {
  const notes = [];
  if (execution) {
    notes.push(
      'Wait is sampled time under kernel-wait frames (sleep/park/poll); ≈On-CPU = Sampled − Wait (frame heuristic). Share is of total on-CPU time across groups.',
    );
  } else {
    notes.push('Share is of the sampled total across all thread groups, not wall-clock time.');
  }
  const multiple = captureMultipleNote(parsed);
  if (multiple) {
    notes.push(multiple);
  }
  return notes;
}

function threadRowCells(parsed, entry, denominator, execution) {
  const thread = entry.thread;
  const mode = modeInfo(parsed);
  const base = [truncate(thread.name, 70), String(threadMergeCount(thread.name)), mode.value(thread.total)];
  const tail = [formatPercent(entry.onCpu, denominator), topFrameOf(thread)];
  if (!execution) {
    return [...base, ...tail];
  }
  return [...base, formatPercent(entry.wait, thread.total || 0), `≈${mode.value(entry.onCpu)}`, ...tail];
}

function threadsLines(parsed, limit = 5) {
  const threads = parsed.threads || [];
  if (threads.length === 0) {
    return [];
  }
  const mode = modeInfo(parsed);
  const execution = mode.mode === MODE_EXECUTION;
  const enriched = threads.map((thread) => {
    const info = execution ? threadWaitInfo(thread) : { wait: 0, onCpu: thread.total };
    return { thread, wait: info.wait, onCpu: info.onCpu };
  });
  const denominator = enriched.reduce((total, entry) => total + entry.onCpu, 0);

  let visible = enriched;
  let collapsed = null;
  if (execution) {
    const internals = enriched.filter((entry) => isJvmInternalThread(entry.thread.name));
    if (internals.length >= 4) {
      visible = enriched.filter((entry) => !internals.includes(entry));
      const sampled = internals.reduce((sum, entry) => sum + entry.thread.total, 0);
      collapsed = {
        label: `JVM internal — ${internals.length} groups`,
        sampled,
        wait: internals.reduce((sum, entry) => sum + entry.wait, 0),
        onCpu: internals.reduce((sum, entry) => sum + entry.onCpu, 0),
      };
    }
  }

  visible = visible.slice().sort((a, b) => b.onCpu - a.onCpu || b.thread.total - a.thread.total);
  const selected = visible.slice(0, limit);
  const rows = selected.map((entry, index) => {
    const cells = threadRowCells(parsed, entry, denominator, execution);
    cells[0] = `${index + 1}. ${cells[0]}`;
    return cells;
  });
  if (collapsed) {
    rows.push([
      collapsed.label,
      '-',
      mode.value(collapsed.sampled),
      formatPercent(collapsed.wait, collapsed.sampled || 0),
      `≈${mode.value(collapsed.onCpu)}`,
      formatPercent(collapsed.onCpu, denominator),
      '-',
    ]);
  }

  const totalHeader = execution ? 'Sampled' : mode.mode === MODE_ALLOCATION ? 'Allocated' : 'Lock wait';
  const waitHeaders = execution ? ['Wait', '≈On-CPU'] : [];
  const lines = ['## Threads', table(['Thread', 'xN', totalHeader, ...waitHeaders, 'Share', 'Top frame'], rows)];
  if (threads.length > limit) {
    lines.push(`Showing ${limit} of ${threads.length} thread groups; use spark_query view "threads" for the rest.`);
  }
  lines.push('', ...threadShareNotes(parsed, execution), '');
  return lines;
}

function hotspotLines(parsed, thread, limit) {
  const mode = modeInfo(parsed);
  const groups = buildMethodGroups(thread);
  const lines = [
    `## ${mode.topTitle} — ${truncate(thread.name, 70)}`,
    `${mode.value(thread.total)} ${mode.noun} in this thread. Percentages are of the thread total.`,
  ];
  if (mode.mode === MODE_EXECUTION) {
    const info = threadWaitInfo(thread);
    if (info.wait > 0) {
      lines.push(
        `Kernel-wait frames hold ${mode.value(info.wait)} (${formatPercent(
          info.wait,
          thread.total,
        )}); ≈On-CPU time is ${mode.value(info.onCpu)} (${formatPercent(info.onCpu, thread.total)}).`,
      );
    }
  }
  lines.push('');

  if (groups.length === 0) {
    lines.push('No stack samples were recorded for this thread.');
    if (thread.self > 0) {
      lines.push(
        `${mode.mode === MODE_ALLOCATION ? 'Unattributed allocations' : 'Thread self'}: ${mode.value(
          thread.self,
        )} (${formatPercent(thread.self, thread.total)}).`,
      );
    }
    lines.push('');
    return lines;
  }

  const selfRows = sortedMethods(thread, 'self', null, limit);
  lines.push(
    table(
      ['#', 'Method', 'Self', 'Self %', 'Inclusive'],
      selfRows.groups.map((group, index) => [
        index + 1,
        methodText(group),
        mode.value(group.self),
        formatPercent(group.self, thread.total),
        mode.value(group.total),
      ]),
    ),
  );
  lines.push('');

  const totalRows = sortedMethods(thread, 'total', null, Math.min(5, limit));
  if (totalRows.groups.length > 0) {
    lines.push('Top inclusive time:');
    lines.push('');
    lines.push(
      table(
        ['#', 'Method', 'Inclusive', 'Share'],
        totalRows.groups.map((group, index) => [
          index + 1,
          methodText(group),
          mode.value(group.total),
          formatPercent(group.total, thread.total),
        ]),
      ),
    );
    lines.push('');
  }

  if (thread.self > 0) {
    const label =
      mode.mode === MODE_ALLOCATION
        ? 'Thread self (unattributed allocations)'
        : mode.mode === MODE_LOCK
          ? 'Thread self (unattributed lock wait)'
          : 'Thread self (idle, waiting, or untracked)';
    lines.push(`${label}: ${mode.value(thread.self)} (${formatPercent(thread.self, thread.total)}).`);
    lines.push('');
  }

  return lines;
}

function sourceLines(parsed, thread, limit = 5) {
  const stats = buildSourceStats(parsed, thread);
  if (!stats) {
    return [];
  }

  const plugins = stats.rows.filter(
    (row) => row.source !== 'minecraft' && row.source !== 'java' && row.source !== '(unattributed)',
  );
  if (plugins.length === 0) {
    return [];
  }

  const mode = modeInfo(parsed);
  const rows = plugins.slice(0, limit).map((row) => [
    truncate(row.source, 70),
    mode.value(row.self),
    formatPercent(row.self, stats.totalSelf),
  ]);
  const lines = [
    '## Plugin/mod attribution',
    table(['Source', 'Self', 'Share'], rows),
    '',
  ];

  const unattributed = stats.totalSelf - stats.mappedSelf;
  if (unattributed > 0) {
    lines.push(
      `Unattributed (Minecraft, Java, or unknown): ${mode.value(unattributed)} (${formatPercent(
        unattributed,
        stats.totalSelf,
      )}).`,
    );
    lines.push('');
  }

  return lines;
}

function notesLines(parsed, note) {
  const notes = [...(parsed.warnings || [])];
  if (note) {
    notes.push(note);
  }
  if (parsed.kind === 'sampler') {
    const aggregator = parsed.metadata?.dataAggregator;
    if (aggregator?.type === 1) {
      const threshold =
        aggregator.tickLengthThreshold > 0
          ? ` over ${formatMs(aggregator.tickLengthThreshold / 1000)}`
          : '';
      const included =
        aggregator.numberOfIncludedTicks > 0
          ? `, ${formatNumber(aggregator.numberOfIncludedTicks)} ticks included`
          : '';
      notes.push(
        `This profile used the ticked aggregator: only ticks${threshold} were sampled${included}; hotspot shares describe those ticks, not every tick.`,
      );
    }
    notes.push(
      'Inclusive values count a method once per stack path; recursive frames are not double-counted.',
    );
  }
  if (notes.length === 0) {
    return [];
  }
  return ['## Notes', ...notes.map((entry) => `- ${entry}`), ''];
}

function samplerSummary(parsed, limit, threadSelector) {
  const lines = [
    ...headerLines(parsed),
    ...performanceLines(parsed),
    ...metadataLines(parsed),
    ...metricsLines(parsed),
  ];
  if (!parsed.threads || parsed.threads.length === 0) {
    lines.push(
      'This export contains no sampled threads. The profiler may have been stopped before a sample was taken, or only metadata was saved.',
    );
    lines.push('');
    lines.push(...notesLines(parsed));
    return lines.join('\n').trimEnd();
  }

  const { thread, note } = chooseThread(parsed, threadSelector);

  lines.push(...threadsLines(parsed, 5));
  lines.push(...hotspotLines(parsed, thread, limit));
  lines.push(...windowsLines(parsed, 5, 'worst'));
  lines.push(...sourceLines(parsed, thread, 5));
  lines.push(...notesLines(parsed, note));

  return lines.join('\n').trimEnd();
}

function heapSummary(parsed, limit) {
  const lines = [
    ...headerLines(parsed),
    ...performanceLines(parsed),
    ...metadataLines(parsed),
    ...metricsLines(parsed),
  ];
  const entries = parsed.entries || [];
  const totalSize = entries.reduce((total, entry) => total + (entry.size || 0), 0);
  const totalInstances = entries.reduce((total, entry) => total + (entry.instances || 0), 0);

  lines.push('## Heap');
  const heap = parsed.metadata?.platformStatistics?.memory?.heap;
  if (heap) {
    const max = heap.max > 0 ? ` / ${formatBytes(heap.max)}` : '';
    lines.push(`- Heap used at capture: ${formatBytes(heap.used)}${max}`);
  }
  if (totalSize > 0) {
    lines.push(
      `- Tracked entries: ${formatNumber(entries.length)} classes, ${formatBytes(totalSize)} across ${formatNumber(
        totalInstances,
      )} instances`,
    );
  } else {
    lines.push('- This export contains metadata only; no heap entries are present.');
  }
  lines.push('');

  if (entries.length > 0) {
    const sorted = entries.slice().sort((a, b) => b.size - a.size || b.instances - a.instances);
    const top = sorted.slice(0, Math.min(limit, 20));
    lines.push('Top classes by size:');
    lines.push('');
    lines.push(
      table(
        ['#', 'Class', 'Size', 'Share', 'Instances'],
        top.map((entry, index) => [
          index + 1,
          truncate(entry.type || '(unknown type)'),
          formatBytes(entry.size),
          formatPercent(entry.size, totalSize),
          formatNumber(entry.instances),
        ]),
      ),
    );
    lines.push('');

    const byInstances = entries
      .slice()
      .sort((a, b) => b.instances - a.instances)
      .slice(0, Math.min(5, limit));
    if (byInstances.length > 0) {
      lines.push('Top classes by instance count:');
      lines.push('');
      lines.push(
        table(
          ['#', 'Class', 'Instances', 'Size'],
          byInstances.map((entry, index) => [
            index + 1,
            truncate(entry.type || '(unknown type)'),
            formatNumber(entry.instances),
            formatBytes(entry.size),
          ]),
        ),
      );
      lines.push('');
    }
  }

  lines.push(...windowsLines(parsed, 5, 'worst'));
  lines.push(...notesLines(parsed));
  return lines.join('\n').trimEnd();
}

function healthSummary(parsed) {
  const lines = [
    ...headerLines(parsed),
    ...performanceLines(parsed),
    ...metadataLines(parsed),
    ...metricsLines(parsed),
  ];
  lines.push(
    'This spark health report contains platform statistics and tick-window history, but no sampled stack trace.',
  );
  lines.push('');
  lines.push(...windowsLines(parsed, 5, 'worst'));
  lines.push(...notesLines(parsed));
  return lines.join('\n').trimEnd();
}

/* ---------------------------------------------------------------------------------------------- */
/* Query                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export function runQuery(parsed, options = {}) {
  const view = String(options.view || '').trim();
  const windowed = hasWindow(options);

  if (windowed && parsed.kind !== 'sampler') {
    throw new Error('window is only supported for sampler profiles');
  }
  if (windowed && !['', 'methods', 'tree', 'sources'].includes(view)) {
    throw new Error('window is only supported for views "methods", "tree", and "sources"');
  }

  if (view === 'metrics') {
    return metricsQuery(parsed, options);
  }
  if (view === 'plugins') {
    return pluginsQuery(parsed, options);
  }
  if (view === 'world') {
    return worldQuery(parsed, options);
  }
  if (view === 'system') {
    return systemQuery(parsed, options);
  }

  if (parsed.kind === 'heap') {
    if (view === 'heap' || view === '') {
      return heapQuery(parsed, options);
    }
    throw new Error(
      `this file is a spark heap summary; view "heap", "metrics", "plugins", "world", or "system" is available, not "${view}". Use spark_analyze for an overview.`,
    );
  }

  if (parsed.kind === 'health') {
    if (view === 'windows' || view === '') {
      return windowsQuery(parsed, options);
    }
    throw new Error(
      `this file is a spark health report (no stack samples); view "windows", "metrics", "plugins", "world", or "system" is available, not "${view}".`,
    );
  }

  switch (view) {
    case '':
    case 'methods':
      return methodsQuery(parsed, options);
    case 'threads':
      return threadsQuery(parsed, options);
    case 'tree':
      return treeQuery(parsed, options);
    case 'windows':
      return windowsQuery(parsed, options);
    case 'sources':
      return sourcesQuery(parsed, options);
    case 'heap':
      throw new Error('this file is a spark profile; view "heap" is only available for .sparkheap exports');
    default:
      throw new Error(
        `unknown view "${view}". Use one of: methods, threads, tree, windows, sources, metrics, plugins, world, system (sampler), heap (heap export).`,
      );
  }
}

function hasWindow(options) {
  return options.window !== undefined && options.window !== null && String(options.window).trim() !== '';
}

function queryThread(parsed, options) {
  const { thread } = chooseThread(parsed, options.thread);
  if (!hasWindow(options)) {
    return { thread };
  }
  return selectWindowThread(parsed, thread, options.window);
}

function methodsQuery(parsed, options) {
  const limit = clampLimit(options.limit, 10);
  const sort = options.sort ?? 'self';
  if (sort !== 'self' && sort !== 'total') {
    throw new Error(`sort for view "methods" must be "self" or "total", not "${options.sort}"`);
  }
  const { thread, label } = queryThread(parsed, options);
  const mode = modeInfo(parsed);
  const result = sortedMethods(thread, sort, options.query, limit);

  const lines = [
    `# ${mode.topTitle} — ${truncate(thread.name, 70)}${label ? ` — ${label}` : ''}`,
    `Sorted by ${sort} time. ${result.totalMatches} matching method${result.totalMatches === 1 ? '' : 's'}${
      result.totalMatches > result.groups.length ? `, showing ${result.groups.length}` : ''
    }.`,
    '',
  ];

  if (result.groups.length === 0) {
    lines.push(
      options.query
        ? `No method matched "${options.query}".`
        : 'No methods were recorded for this thread.',
    );
    return lines.join('\n');
  }

  lines.push(
    table(
      ['#', 'Method', 'Self', 'Self %', 'Inclusive', 'Inclusive %'],
      result.groups.map((group, index) => [
        index + 1,
        methodText(group),
        mode.value(group.self),
        formatPercent(group.self, thread.total),
        mode.value(group.total),
        formatPercent(group.total, thread.total),
      ]),
    ),
  );
  lines.push('');
  lines.push(`Thread total: ${mode.value(thread.total)} ${mode.noun}.`);
  return lines.join('\n');
}

function threadsQuery(parsed, options) {
  if (hasWindow(options)) {
    throw new Error('window is only supported for views "methods", "tree", and "sources"');
  }
  const limit = clampLimit(options.limit, 50);
  const query = options.query ? String(options.query).toLowerCase() : '';
  const threads = (parsed.threads || []).filter(
    (thread) => !query || thread.name.toLowerCase().includes(query),
  );

  if (threads.length === 0) {
    return options.query
      ? `No thread name matched "${options.query}".`
      : 'This profile contains no threads.';
  }

  const mode = modeInfo(parsed);
  const execution = mode.mode === MODE_EXECUTION;
  // Share stays relative to every group in the profile, not the filtered
  // subset, so filtered queries remain comparable to the unfiltered view.
  const denominator = execution
    ? (parsed.threads || []).reduce((sum, thread) => sum + threadWaitInfo(thread).onCpu, 0)
    : sumThreadTotals(parsed);
  const enriched = threads.map((thread) => {
    const info = execution ? threadWaitInfo(thread) : { wait: 0, onCpu: thread.total };
    return { thread, wait: info.wait, onCpu: info.onCpu };
  });
  enriched.sort((a, b) => b.onCpu - a.onCpu || b.thread.total - a.thread.total);

  const totalHeader = execution ? 'Sampled' : mode.mode === MODE_ALLOCATION ? 'Allocated' : 'Lock wait';
  const waitHeaders = execution ? ['Wait', '≈On-CPU'] : [];
  const selected = enriched.slice(0, limit);
  const lines = [
    '# Thread groups',
    `${threads.length} matching thread group${threads.length === 1 ? '' : 's'}${threads.length > limit ? `, showing ${limit}` : ''}${
      execution && threads.length > 1 ? ', sorted by on-CPU time' : ''
    }.`,
    '',
    table(
      ['Thread', 'xN', totalHeader, ...waitHeaders, 'Share', 'Top frame', 'Stack nodes'],
      selected.map((entry) => [
        ...threadRowCells(parsed, entry, denominator, execution),
        formatNumber(entry.thread.nodeCount),
      ]),
    ),
    '',
    ...threadShareNotes(parsed, execution),
  ];
  return lines.join('\n');
}

function treeQuery(parsed, options) {
  const { thread, label } = queryThread(parsed, options);
  const depth = Math.min(8, Math.max(1, Math.trunc(Number(options.depth) || 4)));
  const query = options.query ? String(options.query).trim() : '';
  const lineBudget = clampLimit(options.limit, MAX_TREE_LINES, MAX_TREE_LINE_BUDGET);
  return renderTree(parsed, thread, { depth, query, windowLabel: label, lineBudget });
}

function renderTree(parsed, thread, { depth, query, windowLabel, lineBudget }) {
  const mode = modeInfo(parsed);
  const needle = query.toLowerCase();
  const total = thread.total;
  const budget = Math.max(1, Math.trunc(lineBudget || MAX_TREE_LINES));
  const matches = (node) =>
    `${node.className}.${node.methodName}`.toLowerCase().includes(needle);

  const matching = new Set();
  if (query) {
    const order = [];
    const stack = thread.children.slice();
    while (stack.length > 0) {
      const node = stack.pop();
      order.push(node);
      for (const child of node.children) {
        stack.push(child);
      }
    }
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const node = order[i];
      if (matches(node) || node.children.some((child) => matching.has(child))) {
        matching.add(node);
      }
    }
    if (matching.size === 0) {
      return `No class or method matching "${query}" in thread "${thread.name}".`;
    }
  }

  const lines = [`${thread.name}${windowLabel ? ` — ${windowLabel}` : ''} — ${mode.value(total)} ${mode.noun} total`];
  let emitted = 0;
  let truncated = false;
  // name -> sampled time of frames that existed but were cut by the line
  // budget, so the truncation notice can name the next drill-down target.
  const omitted = new Map();
  const noteOmitted = (node) => {
    const name = methodText(node, 80);
    omitted.set(name, (omitted.get(name) || 0) + node.total);
  };

  const emit = (text) => {
    if (emitted >= budget) {
      truncated = true;
      return false;
    }
    lines.push(text);
    emitted += 1;
    return true;
  };

  // `remaining` counts how many descendant levels may still be printed.
  // No query: it starts at `depth`. Query: it stays null while walking the
  // ancestor path to a match, then resets to `depth` below the matched frame.
  const walk = (node, level, inSubtree, remaining) => {
    if (emitted >= budget) {
      truncated = true;
      noteOmitted(node);
      return;
    }
    const nodeMatches = query ? matches(node) : false;
    if (query && !inSubtree && !matching.has(node)) {
      return;
    }

    const pct = formatPercent(node.total, total);
    const selfPct = formatPercent(node.self, total);
    if (!emit(`${'  '.repeat(level)}- ${methodText(node, 140)} — ${pct} inclusive (self ${selfPct})`)) {
      noteOmitted(node);
      return;
    }

    const expanded = inSubtree || nodeMatches;
    if (remaining !== null && remaining <= 0) {
      if (node.children.length > 0) {
        emit(`${'  '.repeat(level + 1)}… ${node.children.length} child frame${node.children.length === 1 ? '' : 's'}`);
        for (const child of node.children) {
          noteOmitted(child);
        }
      }
      return;
    }

    const children = node.children.slice().sort((a, b) => b.total - a.total);
    let shownChildren = 0;
    for (const child of children) {
      if (emitted >= budget) {
        truncated = true;
        noteOmitted(child);
        return;
      }
      if (query && !expanded && !matching.has(child)) {
        continue;
      }
      const share = total > 0 ? child.total / total : 0;
      if (!query && !expanded && share < 0.005) {
        continue;
      }
      if (query && expanded) {
        // Inside a matched subtree, keep only the hot calls so one match does
        // not fill the whole result with <0.01% leaves.
        const childShare = node.total > 0 ? child.total / node.total : 0;
        if (!matches(child) && childShare < 0.05) {
          continue;
        }
        if (shownChildren >= 6) {
          emit(`${'  '.repeat(level + 1)}… more child frames omitted`);
          for (const rest of children.slice(shownChildren)) {
            noteOmitted(rest);
          }
          break;
        }
        shownChildren += 1;
      }

      let childRemaining;
      if (query) {
        childRemaining = matches(child) ? depth : expanded && remaining !== null ? remaining - 1 : null;
      } else {
        childRemaining = remaining - 1;
      }
      walk(child, level + 1, expanded, childRemaining);
    }
  };

  const roots = thread.children.slice().sort((a, b) => b.total - a.total);
  for (const root of roots) {
    if (emitted >= budget) {
      truncated = true;
      noteOmitted(root);
      break;
    }
    if (query && !matching.has(root)) {
      continue;
    }
    if (!query && total > 0 && root.total / total < 0.005) {
      continue;
    }
    walk(root, 0, false, query ? null : depth);
  }

  if (emitted === 1) {
    lines.push('(no frames above the display threshold)');
  }
  if (truncated) {
    const hottest = [...omitted.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, time]) => `${name} (${formatPercent(time, total)})`);
    const hint = hottest.length > 0 ? ` hottest unshown frames: ${hottest.join(', ')} —` : '';
    lines.push(`… output truncated at ${budget} lines;${hint} narrow with query or lower depth.`);
  }
  return ['```text', ...lines, '```'].join('\n');
}

function windowsQuery(parsed, options) {
  const windows = parsed.windowStatistics || [];
  if (windows.length === 0) {
    return 'This export contains no tick-window statistics.';
  }

  const sort = options.sort === 'worst' ? 'worst' : 'time';
  const limit = clampLimit(options.limit, 20);
  let selected;
  let key;
  if (sort === 'worst') {
    ({ windows: selected, key } = worstWindows(parsed, limit));
  } else {
    selected = windows.slice(0, limit);
    key = 'time';
  }

  const lines = [
    '# Tick windows',
    `${windows.length} window${windows.length === 1 ? '' : 's'} recorded; showing ${selected.length}, ${windowOrderDescription(key)}.`,
    '',
    table(windowHeaders(windows), windowTableRows(selected, windows)),
  ];
  if (windows.length > selected.length && sort === 'time') {
    lines.push('');
    lines.push(`Use sort "worst" or a higher limit to see more of ${windows.length} windows.`);
  }
  return lines.join('\n');
}

function sourcesQuery(parsed, options) {
  const limit = clampLimit(options.limit, 15);
  const { thread, label } = queryThread(parsed, options);
  if (!hasSourceMaps(parsed)) {
    return 'This export has no source attribution maps (classSources, methodSources, or lineSources).';
  }

  const stats = buildSourceStats(parsed, thread);
  if (!stats) {
    return 'This export has no source attribution maps.';
  }

  const query = options.query ? String(options.query).toLowerCase() : '';
  const rows = stats.rows.filter((row) => !query || row.source.toLowerCase().includes(query));
  if (rows.length === 0) {
    return `No source matched "${options.query}".`;
  }

  const mode = modeInfo(parsed);
  const selected = rows.slice(0, limit);
  const lines = [
    `# Source attribution — ${truncate(thread.name, 70)}${label ? ` — ${label}` : ''}`,
    `${rows.length} source${rows.length === 1 ? '' : 's'}; self time only.`,
    '',
    table(
      ['Source', 'Self', 'Share', 'Stack nodes'],
      selected.map((row) => [
        truncate(row.source, 70),
        mode.value(row.self),
        formatPercent(row.self, stats.totalSelf),
        formatNumber(row.nodes),
      ]),
    ),
  ];
  if (rows.length > selected.length) {
    lines.push('');
    lines.push(`Showing ${selected.length} of ${rows.length} sources.`);
  }
  return lines.join('\n');
}

function heapQuery(parsed, options) {
  const entries = parsed.entries || [];
  if (entries.length === 0) {
    return 'This spark heap export contains no heap entries.';
  }

  const sort = options.sort === 'instances' ? 'instances' : 'size';
  const limit = clampLimit(options.limit, 15);
  const query = options.query ? String(options.query).toLowerCase() : '';
  let selected = entries.filter((entry) => !query || entry.type.toLowerCase().includes(query));
  selected = selected
    .slice()
    .sort((a, b) =>
      sort === 'instances' ? b.instances - a.instances || b.size - a.size : b.size - a.size || b.instances - a.instances,
    );

  if (selected.length === 0) {
    return `No heap class matched "${options.query}".`;
  }

  const totalSize = entries.reduce((total, entry) => total + (entry.size || 0), 0);
  const shown = selected.slice(0, limit);
  const lines = [
    '# Heap entries',
    `${selected.length} matching class${selected.length === 1 ? '' : 'es'}${selected.length > shown.length ? `, showing ${shown.length}` : ''}; sorted by ${sort}.`,
    '',
    table(
      ['#', 'Class', 'Size', 'Share', 'Instances'],
      shown.map((entry, index) => [
        index + 1,
        truncate(entry.type || '(unknown type)', 100),
        formatBytes(entry.size),
        formatPercent(entry.size, totalSize),
        formatNumber(entry.instances),
      ]),
    ),
  ];
  return lines.join('\n');
}
