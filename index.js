import { parseSparkFile } from './lib/parse.js';
import { buildSummary, runQuery } from './lib/analysis.js';
import { MAX_MAPPING_BYTES, applyMappings } from './lib/mappings.js';
import { mappingFootprint, resolveMappings } from './lib/mappings-source.js';

export const name = 'dsh-spark-insights';

// ctx.fs is the composed filesystem (and therefore respects the deployment's
// path policy); ctx.workingDirectory supplies the Session's cwd for relative
// paths. Both are required for the tools to do anything useful.
export const inject = ['tools', 'fs', 'workingDirectory'];

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const CACHE_LIMIT = 2;
/** A profile whose mapping lookup found nothing is retried after this delay. */
const MAPPING_RETRY_MS = 60_000;

/** Parsed profiles are large; keep only the two most recently used files. */
const cache = new Map();

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const FILE_PATH_PROPERTY = {
  type: 'string',
  description:
    'Path to a spark .sparkprofile or .sparkheap export. Relative paths resolve against the session working directory; gzip-wrapped protobuf is also accepted.',
};

const MAPPINGS_PATH_PROPERTY = {
  type: 'string',
  description:
    'Optional path to a Mojang ProGuard mappings file (client.txt/server.txt) applied to obfuscated class and method names. Without it, profiles whose frames look obfuscated are resolved from a sibling file (<export>.mappings, <export>.map, server.txt, client.txt), the local version cache, or an automatic Mojang download, in that order. Files that are not ProGuard mappings are ignored.',
};

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(analyzeTool(ctx)));
  ctx.effect(() => ctx.tools.register(queryTool(ctx)));
}

function analyzeTool(ctx) {
  return {
    name: 'spark_analyze',
    description:
      'Read a spark profiler, heap, or health export from a Minecraft server (.sparkprofile, .sparkheap, or raw health data) and summarize performance: platform, TPS, MSPT, CPU, memory, GC, thread totals, worst tick windows, top self/inclusive hotspots, metric trends, plugins/mods, world details, and source attribution. Obfuscated Mojang names are remapped automatically when the sampled frames look obfuscated (local mappings file, version cache, or Mojang download). Use it first; use spark_query to drill into one profile or window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: FILE_PATH_PROPERTY,
        mappings_path: MAPPINGS_PATH_PROPERTY,
        thread: {
          type: 'string',
          description:
            'Thread group to analyze, by exact name or substring. Defaults to the server main thread ("Server thread", "main", …); if no known main-thread name exists, the thread with the most on-CPU time (kernel waits excluded). Only meaningful for sampler profiles.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Rows in the hotspot tables. Default 10.',
        },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = requirePath(args.file_path);
      const mappingsPath = optionalPath(args.mappings_path);
      const parsed = await loadSpark(ctx, exec, filePath, mappingsPath);
      return buildSummary(parsed, {
        limit: args.limit,
        thread: args.thread,
      });
    },
  };
}

function queryTool(ctx) {
  return {
    name: 'spark_query',
    description:
      'Query one spark export for detail: top methods by self or inclusive time for the whole profile or one tick window, the call tree around a class or method, all thread groups, tick-window TPS/MSPT, plugin/mod source attribution, plugin/mod metadata, time-series metrics, world statistics, system/memory/network statistics, or heap classes. Call spark_analyze first for the overview.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: FILE_PATH_PROPERTY,
        mappings_path: MAPPINGS_PATH_PROPERTY,
        view: {
          type: 'string',
          enum: ['methods', 'threads', 'tree', 'windows', 'sources', 'metrics', 'plugins', 'world', 'system', 'heap'],
          description:
            'Detail to return. methods/threads/tree/sources need a sampler profile; windows works for sampler and health exports; metrics/plugins/world/system work on any export that carries the data; heap needs a .sparkheap export. Default: methods for sampler exports, heap for heap exports, windows for health reports.',
        },
        window: {
          type: 'integer',
          minimum: 1,
          description:
            '1-based tick-window index for methods, tree, or sources. Requires per-window stack times; use spark_query view "windows" first to see the window list.',
        },
        thread: {
          type: 'string',
          description:
            'Thread group for methods, tree, and sources, by exact name or substring. Defaults to the server main thread ("Server thread", "main", …); if no known main-thread name exists, the thread with the most on-CPU time (kernel waits excluded).',
        },
        sort: {
          type: 'string',
          enum: ['self', 'total', 'time', 'worst', 'size', 'instances'],
          description:
            'methods: self (default) or total; windows: time (default) or worst; heap: size (default) or instances. Ignored by threads/tree/sources/metrics/plugins/world/system.',
        },
        query: {
          type: 'string',
          description:
            'Case-insensitive filter. methods/tree: class or method text; threads: thread name; sources: source name; metrics: series label; plugins: name/version/author; world: entity/world/rule name; system: pool or interface name; heap: class name.',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description:
            'Call-tree levels below each matched frame, and levels below the root when no query is given. Default 4. Only for view tree.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 300,
          description:
            'Maximum rows. Defaults: methods 10, threads 50, windows 20, sources 15, metrics 20, plugins 50, world 15, system 15, heap 15 (capped at 50 rows). For view tree this is the output line budget (default 120, capped at 300).',
        },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = requirePath(args.file_path);
      const mappingsPath = optionalPath(args.mappings_path);
      const parsed = await loadSpark(ctx, exec, filePath, mappingsPath);
      return runQuery(parsed, {
        view: args.view,
        window: args.window,
        thread: args.thread,
        sort: args.sort,
        query: args.query,
        depth: args.depth,
        limit: args.limit,
      });
    },
  };
}

function requirePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('file_path must be a non-empty string');
  }
  return value.trim();
}

/** Normalize an optional path argument: trimmed, or undefined when absent/blank. */
function optionalPath(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

async function loadSpark(ctx, exec, requestedPath, mappingsPath) {
  const cwd = await resolveCwd(ctx, exec);

  let target;
  try {
    target = await ctx.fs.resolve(requestedPath, { cwd, signal: exec.signal });
  } catch (error) {
    throw new Error(`cannot read "${requestedPath}": ${error.message}`);
  }

  let info;
  try {
    info = await ctx.fs.stat(target, exec.signal);
  } catch (error) {
    throw new Error(`cannot read "${requestedPath}": ${error.message}`);
  }
  if (!info) {
    throw new Error(
      `cannot read "${requestedPath}": the file was not found (resolved against ${cwd}). ` +
        'Export it on the server with /spark profiler stop --save-to-file or /spark heapsummary --save-to-file.',
    );
  }
  if (info.type !== 'file') {
    throw new Error(`cannot read "${requestedPath}": not a regular file`);
  }
  if (info.size !== undefined && info.size > MAX_FILE_BYTES) {
    throw new Error(
      `cannot read "${requestedPath}": ${info.size} bytes exceeds the ${MAX_FILE_BYTES} byte limit for one spark export`,
    );
  }

  // Mapping inputs are part of the key because remapping mutates the parsed
  // tree in place: the same export opened with a different mappings_path keeps
  // its own entry (the two-entry cache bounds the extra memory).
  const mappingsKey = mappingsPath
    ? `path:${await canonicalMappingsKey(ctx, exec, cwd, mappingsPath)}`
    : 'auto';
  const cacheKey = `${String(target.targetKey)}:${String(info.version ?? info.size ?? '')}:${mappingsKey}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    // Refresh LRU position.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);

    // Mapping files can appear next to the export, change, or disappear after
    // the profile was parsed. The footprint is a few stats, so compare it
    // instead of serving names that no longer match the inputs.
    const footprint = await footprintFor(ctx, exec, cached, cwd, mappingsPath);
    if (footprint !== undefined && cached.mappingsFootprint === undefined) {
      // First observation for this entry (a previous stat attempt failed):
      // remember it and keep serving the current result.
      cached.mappingsFootprint = footprint;
    } else if (footprint !== undefined && footprint !== cached.mappingsFootprint) {
      cache.delete(cacheKey);
    } else {
      // A lookup that found nothing may succeed later (a download after a
      // transient failure, not a file change — those are handled above).
      // Retry with a backoff so repeated queries stay cheap.
      const retryDue =
        cached.mappings &&
        cached.mappings.applied === false &&
        cached.mappings.skipped !== true &&
        cached.mappings.kind === 'none' &&
        Date.now() >= (cached.mappings.retryAt || 0);
      if (retryDue) {
        await attachMappings(ctx, exec, cached, cwd, mappingsPath);
        await recordFootprint(ctx, exec, cached, cwd, mappingsPath);
      }
      return cached;
    }
  }

  let bytes;
  try {
    bytes = await ctx.fs.readBytes(target, exec.signal, MAX_FILE_BYTES);
  } catch (error) {
    if (error?.code === 'FS_TOO_LARGE' || /too large|maxBytes/iu.test(error?.message || '')) {
      throw new Error(
        `cannot read "${requestedPath}": the file exceeds the ${MAX_FILE_BYTES} byte limit for one spark export`,
      );
    }
    throw new Error(`cannot read "${requestedPath}": ${error.message}`);
  }

  let parsed;
  try {
    parsed = parseSparkFile(bytes, { fileName: target.displayPath || requestedPath });
  } catch (error) {
    throw new Error(`${error.message} (while reading ${target.displayPath || requestedPath})`);
  }

  await attachMappings(ctx, exec, parsed, cwd, mappingsPath);
  await recordFootprint(ctx, exec, parsed, cwd, mappingsPath);

  cache.set(cacheKey, parsed);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return parsed;
}

/**
 * Resolve and apply Mojang mappings to a freshly parsed export. Health
 * reports carry no class names, so resolution is skipped for them. Every
 * failure is soft: names stay obfuscated and the reason surfaces in the
 * summary. A failed lookup records a retry deadline so a cached profile is
 * not re-resolved on every query.
 */
async function attachMappings(ctx, exec, parsed, cwd, mappingsPath) {
  if (parsed.kind === 'health') {
    return;
  }

  const readExternal = (path) => readOptionalFile(ctx, path, cwd, exec.signal);
  let resolved;
  try {
    resolved = await resolveMappings({
      parsed,
      explicitPath: mappingsPath,
      readExternal,
      signal: exec.signal,
    });
  } catch (error) {
    parsed.mappings = { applied: false, kind: 'none', label: '', note: `mapping error: ${error.message}` };
    parsed.mappings.retryAt = Date.now() + MAPPING_RETRY_MS;
    return;
  }

  if (resolved.mapping) {
    try {
      applyMappings(parsed, resolved.mapping, resolved.source);
    } catch (error) {
      parsed.mappings = {
        applied: false,
        kind: 'none',
        label: resolved.source.label,
        note: `mapping error: ${error.message}`,
        retryAt: Date.now() + MAPPING_RETRY_MS,
      };
    }
    return;
  }
  parsed.mappings = {
    applied: false,
    ...resolved.source,
    note: resolved.note,
    skipped: resolved.skipped === true,
    retryAt: Date.now() + MAPPING_RETRY_MS,
  };
}

/** Record the stat signature of the mapping inputs this profile was built from. */
async function recordFootprint(ctx, exec, parsed, cwd, mappingsPath) {
  parsed.mappingsFootprint = await footprintFor(ctx, exec, parsed, cwd, mappingsPath);
}

async function footprintFor(ctx, exec, parsed, cwd, mappingsPath) {
  try {
    return await mappingFootprint({
      parsed,
      explicitPath: mappingsPath,
      statExternal: (path) => statOptionalFile(ctx, path, cwd, exec.signal),
    });
  } catch {
    return undefined;
  }
}

async function statOptionalFile(ctx, path, cwd, signal) {
  try {
    const target = await ctx.fs.resolve(String(path), { cwd, signal });
    const info = await ctx.fs.stat(target, signal);
    if (!info || info.type !== 'file') {
      return null;
    }
    return { size: info.size, version: info.version ?? info.size };
  } catch {
    return null;
  }
}

/** Use the resolved path for the cache key so equivalent spellings share an entry. */
async function canonicalMappingsKey(ctx, exec, cwd, path) {
  try {
    const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal });
    return String(target?.targetKey || path);
  } catch {
    return path;
  }
}

async function readOptionalFile(ctx, path, cwd, signal) {
  try {
    const target = await ctx.fs.resolve(String(path), { cwd, signal });
    const info = await ctx.fs.stat(target, signal);
    if (!info || info.type !== 'file') {
      return null;
    }
    if (info.size !== undefined && info.size > MAX_MAPPING_BYTES) {
      return null;
    }
    return await ctx.fs.readBytes(target, signal, MAX_MAPPING_BYTES);
  } catch {
    return null;
  }
}

async function resolveCwd(ctx, exec) {
  if (exec.agent) {
    try {
      return await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    } catch (error) {
      throw new Error(`cannot resolve the session working directory: ${error.message}`);
    }
  }
  return ctx.workingDirectory.defaultDirectory || process.cwd();
}
