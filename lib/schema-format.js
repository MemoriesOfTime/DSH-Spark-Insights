/**
 * Schema-driven decoder for current spark exports.
 *
 * The generated module in spark-pb.js comes from the official schemas under
 * proto/spark. It covers every field in spark data version 2; the legacy
 * hand-written decoder in spark-format.js remains the fallback for old nested
 * profiles (and for the rare exporter that does not match the current schema).
 */

import { spark } from './spark-pb.js';
import { computeTree } from './spark-format.js';

const MAX_WARNINGS = 8;

export function decodeSchema(bytes, kind) {
  let raw;
  try {
    if (kind === 'heap') {
      raw = spark.HeapData.decode(bytes);
    } else if (kind === 'health') {
      raw = spark.HealthData.decode(bytes);
    } else {
      raw = spark.SamplerData.decode(bytes);
    }
  } catch {
    // Old exports can have wire layouts that the current schema cannot skip.
    return null;
  }

  if (!raw || !raw.metadata) {
    return null;
  }

  if (kind === 'sampler' && looksLikeLegacySampler(raw)) {
    return null;
  }

  if (kind === 'heap') {
    return normalizeHeap(raw);
  }
  if (kind === 'health') {
    return normalizeHealth(raw);
  }
  return normalizeSampler(raw);
}

function looksLikeLegacySampler(raw) {
  const version = Number(raw.metadata?.platformMetadata?.sparkDataVersion || 0);
  if (version > 0 && version < 2) {
    return true;
  }

  const threads = raw.threads || [];
  return threads.some((thread) => {
    const times = thread.times || [];
    const refs = thread.childrenRefs || [];
    const children = thread.children || [];
    // New data always has a flat node table and root refs. A nested tree with
    // no refs is the legacy shape; an empty thread is not enough evidence.
    return !refs.length && children.length > 0 && !times.length;
  });
}

function normalizeSampler(raw) {
  const warnings = [];
  const threads = (raw.threads || []).map((thread) => normalizeThread(thread, warnings));
  const metadata = normalizeMetadata(raw.metadata);

  return {
    kind: 'sampler',
    metadata,
    threads,
    timeWindows: Array.from(raw.timeWindows || []),
    classSources: raw.classSources || {},
    methodSources: raw.methodSources || {},
    lineSources: raw.lineSources || {},
    windowStatistics: normalizeWindowStatistics(raw.timeWindowStatistics),
    channelInfo: raw.channelInfo || null,
    warnings,
  };
}

function normalizeThread(thread, warnings) {
  const flat = Array.from(thread.children || []);
  const nodes = flat.map((node) => {
    const times = Array.from(node.times || []);
    return {
      className: node.className || '',
      methodName: node.methodName || '',
      methodDesc: node.methodDesc || '',
      lineNumber: node.lineNumber || 0,
      parentLineNumber: node.parentLineNumber || 0,
      times,
      total: sum(times),
      children: [],
      childrenRefs: Array.from(node.childrenRefs || []),
    };
  });

  const roots = [];
  for (const ref of thread.childrenRefs || []) {
    if (!Number.isInteger(ref) || ref < 0 || ref >= nodes.length) {
      warn(warnings, 'ignored a stack-tree reference outside the node table');
      continue;
    }
    roots.push(nodes[ref]);
  }

  const seen = new Set();
  const stack = roots.slice();
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) {
      warn(warnings, 'ignored a cyclic or shared stack-tree reference');
      continue;
    }
    seen.add(node);

    const children = [];
    for (const ref of node.childrenRefs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= nodes.length) {
        warn(warnings, 'ignored a stack-tree reference outside the node table');
        continue;
      }
      const child = nodes[ref];
      if (child) {
        children.push(child);
      }
    }
    node.children = children;
    node.childrenRefs = null;
    for (const child of children) {
      stack.push(child);
    }
  }

  const stats = computeTree(roots);
  const threadTimes = Array.from(thread.times || []);
  const total = threadTimes.length > 0 ? sum(threadTimes) : stats.childTotal;

  return {
    name: thread.name || '<unnamed thread>',
    total,
    self: Math.max(0, total - stats.childTotal),
    children: roots,
    nodeCount: stats.nodeCount,
    maxDepth: stats.maxDepth,
    windowCount: threadTimes.length,
    times: threadTimes,
  };
}

function normalizeHeap(raw) {
  const entries = (raw.entries || []).map((entry) => ({
    order: Number(entry.order || 0),
    instances: Number(entry.instances || 0),
    size: Number(entry.size || 0),
    type: entry.type || '',
  }));

  return {
    kind: 'heap',
    metadata: normalizeMetadata(raw.metadata),
    entries,
    warnings: [],
  };
}

function normalizeHealth(raw) {
  return {
    kind: 'health',
    metadata: normalizeMetadata(raw.metadata),
    windowStatistics: normalizeWindowStatistics(raw.timeWindowStatistics),
    channelInfo: raw.channelInfo || null,
    warnings: [],
  };
}

function normalizeMetadata(raw) {
  if (!raw) {
    return null;
  }

  const metadata = convertNumbers(raw);
  const platform = metadata.platformMetadata || null;
  if (platform) {
    platform.dataVersion = Number(platform.sparkDataVersion || 0);
    delete platform.sparkDataVersion;
  }
  metadata.platform = platform;
  delete metadata.platformMetadata;

  metadata.sourceCount = Object.keys(metadata.sources || {}).length;
  metadata.hasMetrics = Boolean(metadata.metrics);

  if (metadata.platformStatistics) {
    metadata.platformStatistics.tps ??= null;
    metadata.platformStatistics.mspt ??= null;
    metadata.platformStatistics.ping ??= null;
    metadata.platformStatistics.world ??= null;
  }
  return metadata;
}

function normalizeWindowStatistics(raw) {
  if (!raw) {
    return [];
  }

  const windows = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value) {
      continue;
    }
    const numberKey = Number(key);
    if (!Number.isFinite(numberKey)) {
      continue;
    }
    windows.push({ key: numberKey, ...convertNumbers(value) });
  }

  windows.sort((a, b) => windowStart(a) - windowStart(b));
  return windows;
}

function windowStart(window) {
  return window.startTime > 0 ? window.startTime : window.key * 60_000;
}

function sum(values) {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

function warn(warnings, message) {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) {
    warnings.push(message);
  }
}

/**
 * protobufjs decodes int64 as Long objects. The analysis layer expects numbers,
 * and all spark values fit safely in a JavaScript number.
 */
function convertNumbers(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'object' && typeof value.toNumber === 'function' && 'low' in value) {
    return value.toNumber();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => convertNumbers(entry, seen));
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = convertNumbers(entry, seen);
  }
  return out;
}
