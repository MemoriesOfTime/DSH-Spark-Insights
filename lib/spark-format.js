/**
 * spark protobuf decoding.
 *
 * Wire schemas:
 *   spark-common/src/main/proto/spark/spark.proto
 *   spark-common/src/main/proto/spark/spark_sampler.proto
 *   spark-common/src/main/proto/spark/spark_heap.proto
 *
 * The sampler tree is stored flattened: every ThreadNode carries a flat array of
 * StackTraceNodes plus `childrenRefs` indexes into that array. The parser
 * unflattens it in place and replaces every per-window `times` array with its
 * total, so analysis never needs the protobuf representation again.
 */

import {
  Reader,
  forEachField,
  readRepeatedDouble,
  readRepeatedInt32,
  makeInterner,
  readStringMapEntry,
} from './protobuf.js';

export const MAX_NODES = 4_000_000;
const MAX_DEPTH = 4096;
const MAX_WARNINGS = 8;

/* ---------------------------------------------------------------------------------------------- */
/* Top-level envelope                                                                              */
/* ---------------------------------------------------------------------------------------------- */

export function decodeTopLevel(bytes) {
  const reader = new Reader(bytes);
  const top = {
    metadata: null,
    items: [],
    classSourceEntries: [],
    methodSourceEntries: [],
    lineSourceEntries: [],
    timeWindows: [],
    windowStatEntries: [],
    warning: null,
  };

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 2) {
          top.metadata = reader.bytesField();
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 2) {
          top.items.push(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 2) {
          top.classSourceEntries.push(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          top.methodSourceEntries.push(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 5:
        if (wire === 2) {
          top.lineSourceEntries.push(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 6:
        top.timeWindows.push(...readRepeatedInt32(reader, wire));
        break;
      case 7:
        if (wire === 2) {
          top.windowStatEntries.push(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      default:
        reader.skip(wire);
    }
  });

  return top;
}

export function detectKind(top, fileName) {
  const lower = String(fileName || '').toLowerCase();
  const extension = lower.endsWith('.sparkheap')
    ? 'heap'
    : lower.endsWith('.sparkprofile')
      ? 'sampler'
      : lower.endsWith('.sparkhealth')
        ? 'health'
        : null;

  if (top.items.length > 0) {
    const sniffed = sniffItem(top.items[0]);
    if (sniffed) {
      return sniffed;
    }
  }

  if (extension) {
    return extension;
  }

  if (top.metadata) {
    const sniffed = sniffMetadataShape(top.metadata);
    if (sniffed) {
      return sniffed;
    }
  }

  return top.items.length > 0 ? 'sampler' : 'health';
}

function sniffItem(bytes) {
  const reader = new Reader(bytes);
  let firstWire = -1;
  let secondWire = -1;
  let fourthWire = -1;
  let firstName = '';

  try {
    forEachField(reader, bytes.length, (field, wire) => {
      if (field === 1) {
        firstWire = wire;
        if (wire === 2) {
          firstName = reader.string();
        } else {
          reader.skip(wire);
        }
      } else if (field === 2) {
        secondWire = wire;
        reader.skip(wire);
      } else if (field === 4) {
        fourthWire = wire;
        reader.skip(wire);
      } else {
        reader.skip(wire);
      }
    });
  } catch {
    return null;
  }

  // ThreadNode.name is field 1 and a string.
  if (firstWire === 2 && firstName.length > 0) {
    return 'sampler';
  }
  // HeapEntry: order(1) and instances(2) are varints, type(4) is a string.
  if (firstWire === 0 && secondWire === 0 && fourthWire === 2) {
    return 'heap';
  }
  // Health window-statistics map entry: key(1) is a varint, value(2) a message.
  if (firstWire === 0 && secondWire === 2) {
    return 'health';
  }
  return null;
}

function sniffMetadataShape(bytes) {
  const reader = new Reader(bytes);
  let field2Wire = -1;
  try {
    forEachField(reader, bytes.length, (field, wire) => {
      if (field === 2) {
        field2Wire = wire;
      }
      reader.skip(wire);
    });
  } catch {
    return null;
  }
  if (field2Wire === 0) {
    return 'sampler';
  }
  if (field2Wire === 2) {
    return 'health';
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------- */
/* Sampler                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export function decodeSampler(top) {
  const interner = makeInterner();
  const context = { nodes: 0, warnings: [] };
  const threads = [];

  for (const item of top.items) {
    threads.push(decodeThread(item, context, interner));
  }

  const metadata = top.metadata ? decodeSamplerMetadata(top.metadata) : null;
  const classSources = decodeStringMapEntries(top.classSourceEntries);
  const methodSources = decodeStringMapEntries(top.methodSourceEntries);
  const lineSources = decodeStringMapEntries(top.lineSourceEntries);
  const windowStatistics = top.windowStatEntries
    .map(decodeWindowStatisticsEntry)
    .filter(Boolean)
    .sort((a, b) => windowStart(a) - windowStart(b));

  return {
    kind: 'sampler',
    metadata,
    threads,
    timeWindows: top.timeWindows,
    classSources,
    methodSources,
    lineSources,
    windowStatistics,
    warnings: context.warnings,
  };
}

function warn(context, message) {
  if (context.warnings.length >= MAX_WARNINGS) {
    return;
  }
  if (!context.warnings.includes(message)) {
    context.warnings.push(message);
  }
}

function decodeThread(bytes, context, interner) {
  const reader = new Reader(bytes);
  let name = '';
  let legacyTime = null;
  let windowCount = 0;
  let timesTotal = 0;
  let children = [];
  let refs = [];

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 2) {
          name = interner(reader.string());
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 1) {
          legacyTime = reader.double();
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 2) {
          children.push(decodeStackTrace(reader.bytesField(), context, interner));
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        readRepeatedDouble(reader, wire, (value) => {
          timesTotal += value;
          windowCount += 1;
        });
        break;
      case 5:
        refs.push(...readRepeatedInt32(reader, wire));
        break;
      default:
        reader.skip(wire);
    }
  });

  let roots = children;
  if (refs.length > 0 && children.length > 0) {
    roots = [];
    for (const ref of refs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= children.length) {
        warn(context, 'ignored a stack-tree reference outside the node table');
        continue;
      }
      roots.push(children[ref]);
    }
    hydrateRefs(roots, children, context);
  }

  const stats = computeTree(roots);
  let total = windowCount > 0 ? timesTotal : legacyTime !== null ? legacyTime : stats.childTotal;
  if (!Number.isFinite(total) || total < 0) {
    total = stats.childTotal;
  }
  const self = Math.max(0, total - stats.childTotal);

  return {
    name: name || '<unnamed thread>',
    total,
    self,
    children: roots,
    nodeCount: stats.nodeCount,
    maxDepth: stats.maxDepth,
    windowCount,
  };
}

function hydrateRefs(roots, flat, context) {
  const seen = new Set();
  const stack = roots.slice();

  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node)) {
      warn(context, 'ignored a cyclic or shared stack-tree reference');
      continue;
    }
    seen.add(node);

    const refs = node.childrenRefs;
    if (!refs || refs.length === 0) {
      continue;
    }

    const next = [];
    for (const ref of refs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= flat.length) {
        warn(context, 'ignored a stack-tree reference outside the node table');
        continue;
      }
      const child = flat[ref];
      if (child === undefined) {
        warn(context, 'ignored an empty stack-tree reference');
        continue;
      }
      next.push(child);
    }

    node.children = next;
    node.childrenRefs = null;
    for (const child of next) {
      stack.push(child);
    }
  }
}

export function computeTree(roots) {
  const order = [];
  const stack = roots.slice().reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    order.push(node);
    if (order.length > MAX_NODES) {
      throw new RangeError(`stack tree has more than ${MAX_NODES.toLocaleString('en-US')} nodes`);
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }

  let nodeCount = 0;
  let maxDepth = 0;
  let childTotal = 0;

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i];
    let total = 0;
    let count = 1;
    let depth = 1;

    for (const child of node.children) {
      total += child.total;
      count += child.count;
      if (child.depth + 1 > depth) {
        depth = child.depth + 1;
      }
    }

    node.self = Math.max(0, (node.total || 0) - total);
    node.childTotal = total;
    node.count = count;
    node.depth = depth;

    if (depth > MAX_DEPTH) {
      throw new RangeError(`stack tree is deeper than ${MAX_DEPTH} frames`);
    }
  }

  for (const root of roots) {
    nodeCount += root.count;
    childTotal += root.total;
    if (root.depth > maxDepth) {
      maxDepth = root.depth;
    }
  }

  return { nodeCount, maxDepth, childTotal };
}

function decodeStackTrace(bytes, context, interner, depth = 0) {
  if (depth > MAX_DEPTH) {
    throw new RangeError(`stack tree is deeper than ${MAX_DEPTH} frames`);
  }
  context.nodes += 1;
  if (context.nodes > MAX_NODES) {
    throw new RangeError(`stack tree has more than ${MAX_NODES.toLocaleString('en-US')} nodes`);
  }

  const reader = new Reader(bytes);
  let className = '';
  let methodName = '';
  let methodDesc = '';
  let lineNumber = 0;
  let parentLineNumber = 0;
  let legacyTime = null;
  let timesTotal = 0;
  let hasTimes = false;
  let children = [];
  let refs = [];

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 1) {
          legacyTime = reader.double();
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 2) {
          children.push(decodeStackTrace(reader.bytesField(), context, interner, depth + 1));
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 2) {
          className = interner(reader.string());
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          methodName = interner(reader.string());
        } else {
          reader.skip(wire);
        }
        break;
      case 5:
        if (wire === 0) {
          parentLineNumber = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 6:
        if (wire === 0) {
          lineNumber = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 7:
        if (wire === 2) {
          methodDesc = interner(reader.string());
        } else {
          reader.skip(wire);
        }
        break;
      case 8:
        hasTimes = true;
        readRepeatedDouble(reader, wire, (value) => {
          timesTotal += value;
        });
        break;
      case 9:
        refs.push(...readRepeatedInt32(reader, wire));
        break;
      default:
        reader.skip(wire);
    }
  });

  let total = hasTimes ? timesTotal : legacyTime !== null ? legacyTime : 0;
  if (!Number.isFinite(total) || total < 0) {
    total = 0;
  }

  return {
    className,
    methodName,
    methodDesc,
    lineNumber,
    parentLineNumber,
    total,
    children,
    childrenRefs: refs.length > 0 ? refs : null,
  };
}

function decodeStringMapEntries(entries) {
  const out = Object.create(null);
  for (const entry of entries) {
    const { key, value } = readStringMapEntry(entry);
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Metadata                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function decodeSamplerMetadata(bytes) {
  const reader = new Reader(bytes);
  const metadata = {
    creator: null,
    startTime: 0,
    endTime: 0,
    interval: 0,
    threadDumper: null,
    dataAggregator: null,
    comment: '',
    platform: null,
    platformStatistics: null,
    systemStatistics: null,
    serverConfigurations: Object.create(null),
    numberOfTicks: 0,
    sourceCount: 0,
    extraPlatformMetadata: Object.create(null),
    samplerMode: 0,
    samplerEngine: 0,
    samplerEngineVersion: '',
    hasMetrics: false,
  };

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 2) {
          metadata.creator = decodeCreator(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 0) {
          metadata.startTime = reader.varint();
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 0) {
          metadata.interval = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          metadata.threadDumper = decodeThreadDumper(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 5:
        if (wire === 2) {
          metadata.dataAggregator = decodeDataAggregator(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 6:
        if (wire === 2) {
          metadata.comment = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      case 7:
        if (wire === 2) {
          metadata.platform = decodePlatformMetadata(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 8:
        if (wire === 2) {
          metadata.platformStatistics = decodePlatformStatistics(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 9:
        if (wire === 2) {
          metadata.systemStatistics = decodeSystemStatistics(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 10: {
        if (wire === 2) {
          const { key, value } = readStringMapEntry(reader.bytesField());
          if (key) {
            metadata.serverConfigurations[key] = value;
          }
        } else {
          reader.skip(wire);
        }
        break;
      }
      case 11:
        if (wire === 0) {
          metadata.endTime = reader.varint();
        } else {
          reader.skip(wire);
        }
        break;
      case 12:
        if (wire === 0) {
          metadata.numberOfTicks = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 13: {
        if (wire === 2) {
          metadata.sourceCount += 1;
          reader.skip(wire);
        } else {
          reader.skip(wire);
        }
        break;
      }
      case 14: {
        if (wire === 2) {
          const { key, value } = readStringMapEntry(reader.bytesField());
          if (key) {
            metadata.extraPlatformMetadata[key] = value;
          }
        } else {
          reader.skip(wire);
        }
        break;
      }
      case 15:
        if (wire === 0) {
          metadata.samplerMode = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 16:
        if (wire === 0) {
          metadata.samplerEngine = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 17:
        if (wire === 2) {
          metadata.samplerEngineVersion = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      case 18:
        metadata.hasMetrics = true;
        reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  });

  return metadata;
}

function decodeHeapMetadata(bytes) {
  const reader = new Reader(bytes);
  const metadata = {
    creator: null,
    platform: null,
    platformStatistics: null,
    systemStatistics: null,
    generatedTime: 0,
    serverConfigurations: Object.create(null),
    sourceCount: 0,
    extraPlatformMetadata: Object.create(null),
    hasMetrics: false,
  };

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 2) {
          metadata.creator = decodeCreator(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 2) {
          metadata.platform = decodePlatformMetadata(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 2) {
          metadata.platformStatistics = decodePlatformStatistics(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          metadata.systemStatistics = decodeSystemStatistics(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 5:
        if (wire === 0) {
          metadata.generatedTime = reader.varint();
        } else {
          reader.skip(wire);
        }
        break;
      case 6: {
        if (wire === 2) {
          const { key, value } = readStringMapEntry(reader.bytesField());
          if (key) {
            metadata.serverConfigurations[key] = value;
          }
        } else {
          reader.skip(wire);
        }
        break;
      }
      case 7:
        if (wire === 2) {
          metadata.sourceCount += 1;
          reader.skip(wire);
        } else {
          reader.skip(wire);
        }
        break;
      case 8: {
        if (wire === 2) {
          const { key, value } = readStringMapEntry(reader.bytesField());
          if (key) {
            metadata.extraPlatformMetadata[key] = value;
          }
        } else {
          reader.skip(wire);
        }
        break;
      }
      case 9:
        metadata.hasMetrics = true;
        reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  });

  return metadata;
}

function decodeCreator(bytes) {
  const reader = new Reader(bytes);
  const creator = { type: 0, name: '', uniqueId: '' };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) {
      creator.type = reader.int32();
    } else if (field === 2 && wire === 2) {
      creator.name = reader.string();
    } else if (field === 3 && wire === 2) {
      creator.uniqueId = reader.string();
    } else {
      reader.skip(wire);
    }
  });
  return creator;
}

function decodePlatformMetadata(bytes) {
  const reader = new Reader(bytes);
  const platform = {
    type: 0,
    name: '',
    version: '',
    minecraftVersion: '',
    dataVersion: 0,
    brand: '',
    sparkVersion: '',
  };
  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 0) {
          platform.type = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 2) {
          platform.name = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 2) {
          platform.version = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          platform.minecraftVersion = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      case 7:
        if (wire === 0) {
          platform.dataVersion = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 8:
        if (wire === 2) {
          platform.brand = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      case 9:
        if (wire === 2) {
          platform.sparkVersion = reader.string();
        } else {
          reader.skip(wire);
        }
        break;
      default:
        reader.skip(wire);
    }
  });
  return platform;
}

function decodeThreadDumper(bytes) {
  const reader = new Reader(bytes);
  const dumper = { type: 0, ids: [], patterns: [] };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) {
      dumper.type = reader.int32();
    } else if (field === 2) {
      dumper.ids.push(...readRepeatedInt32(reader, wire));
    } else if (field === 3 && wire === 2) {
      dumper.patterns.push(reader.string());
    } else {
      reader.skip(wire);
    }
  });
  return dumper;
}

function decodeDataAggregator(bytes) {
  const reader = new Reader(bytes);
  const aggregator = { type: 0, threadGrouper: 0, tickLengthThreshold: 0, numberOfIncludedTicks: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) {
      aggregator.type = reader.int32();
    } else if (field === 2 && wire === 0) {
      aggregator.threadGrouper = reader.int32();
    } else if (field === 3 && wire === 0) {
      aggregator.tickLengthThreshold = reader.varint();
    } else if (field === 4 && wire === 0) {
      aggregator.numberOfIncludedTicks = reader.int32();
    } else {
      reader.skip(wire);
    }
  });
  return aggregator;
}

/* ---------------------------------------------------------------------------------------------- */
/* Platform statistics                                                                             */
/* ---------------------------------------------------------------------------------------------- */

function decodePlatformStatistics(bytes) {
  const reader = new Reader(bytes);
  const stats = {
    memory: null,
    gc: Object.create(null),
    uptime: 0,
    tps: null,
    mspt: null,
    ping: null,
    playerCount: 0,
    world: null,
    onlineMode: 0,
  };

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 2) {
          stats.memory = decodeMemoryStatistics(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 2) {
          const entry = decodeGcEntry(reader.bytesField());
          if (entry.key) {
            stats.gc[entry.key] = entry.value;
          }
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 0) {
          stats.uptime = reader.varint();
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          stats.tps = decodeTps(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 5:
        if (wire === 2) {
          stats.mspt = decodeMspt(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 6:
        if (wire === 2) {
          stats.ping = decodePing(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 7:
        if (wire === 0) {
          stats.playerCount = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 8:
        if (wire === 2) {
          stats.world = decodeWorldStatistics(reader.bytesField());
        } else {
          reader.skip(wire);
        }
        break;
      case 9:
        if (wire === 0) {
          stats.onlineMode = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      default:
        reader.skip(wire);
    }
  });

  return stats;
}

function decodeMemoryStatistics(bytes) {
  const reader = new Reader(bytes);
  const memory = {
    heap: null,
    nonHeap: null,
    pools: [],
    allocBpsLast1m: null,
    allocBpsLast5m: null,
    allocBpsLast15m: null,
  };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) {
      memory.heap = decodeMemoryUsage(reader.bytesField());
    } else if (field === 2 && wire === 2) {
      memory.nonHeap = decodeMemoryUsage(reader.bytesField());
    } else if (field === 3 && wire === 2) {
      memory.pools.push(decodeMemoryPool(reader.bytesField()));
    } else if (field === 4 && wire === 2) {
      memory.allocBpsLast1m = decodeRolling(reader.bytesField());
    } else if (field === 5 && wire === 2) {
      memory.allocBpsLast5m = decodeRolling(reader.bytesField());
    } else if (field === 6 && wire === 2) {
      memory.allocBpsLast15m = decodeRolling(reader.bytesField());
    } else {
      reader.skip(wire);
    }
  });
  return memory;
}

function decodeMemoryPool(bytes) {
  const reader = new Reader(bytes);
  const pool = { name: '', usage: null, collectionUsage: null };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) {
      pool.name = reader.string();
    } else if (field === 2 && wire === 2) {
      pool.usage = decodeMemoryUsage(reader.bytesField());
    } else if (field === 3 && wire === 2) {
      pool.collectionUsage = decodeMemoryUsage(reader.bytesField());
    } else {
      reader.skip(wire);
    }
  });
  return pool;
}

function decodeMemoryUsage(bytes) {
  const reader = new Reader(bytes);
  const usage = { used: 0, committed: 0, init: 0, max: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (wire !== 0) {
      reader.skip(wire);
      return;
    }
    if (field === 1) usage.used = reader.varint();
    else if (field === 2) usage.committed = reader.varint();
    else if (field === 3) usage.init = reader.varint();
    else if (field === 4) usage.max = reader.int64Signed();
    else reader.skip(wire);
  });
  return usage;
}

function decodeRolling(bytes) {
  const reader = new Reader(bytes);
  const rolling = { mean: 0, max: 0, min: 0, median: 0, percentile95: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (wire !== 1) {
      reader.skip(wire);
      return;
    }
    if (field === 1) rolling.mean = reader.double();
    else if (field === 2) rolling.max = reader.double();
    else if (field === 3) rolling.min = reader.double();
    else if (field === 4) rolling.median = reader.double();
    else if (field === 5) rolling.percentile95 = reader.double();
  });
  return rolling;
}

function decodeGcEntry(bytes) {
  const reader = new Reader(bytes);
  let key = '';
  let current = null;
  const gc = { total: 0, avgTime: 0, avgFrequency: 0 };

  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) {
      key = reader.string();
    } else if (field === 2 && wire === 2) {
      current = reader.bytesField();
    } else {
      reader.skip(wire);
    }
  });

  if (current) {
    const valueReader = new Reader(current);
    forEachField(valueReader, current.length, (field, wire) => {
      if (wire === 0 && field === 1) gc.total = valueReader.varint();
      else if (wire === 1 && field === 2) gc.avgTime = valueReader.double();
      else if (wire === 1 && field === 3) gc.avgFrequency = valueReader.double();
      else valueReader.skip(wire);
    });
    return { key, value: gc };
  }

  return { key, value: null };
}

function decodeTps(bytes) {
  const reader = new Reader(bytes);
  const tps = { last1m: 0, last5m: 0, last15m: 0, gameTargetTps: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (wire === 1 && field === 1) tps.last1m = reader.double();
    else if (wire === 1 && field === 2) tps.last5m = reader.double();
    else if (wire === 1 && field === 3) tps.last15m = reader.double();
    else if (wire === 0 && field === 4) tps.gameTargetTps = reader.int32();
    else reader.skip(wire);
  });
  return tps;
}

function decodeMspt(bytes) {
  const reader = new Reader(bytes);
  const mspt = { last1m: null, last5m: null, gameMaxIdealMspt: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (wire === 2 && field === 1) mspt.last1m = decodeRolling(reader.bytesField());
    else if (wire === 2 && field === 2) mspt.last5m = decodeRolling(reader.bytesField());
    else if (wire === 0 && field === 3) mspt.gameMaxIdealMspt = reader.int32();
    else reader.skip(wire);
  });
  return mspt;
}

function decodePing(bytes) {
  const reader = new Reader(bytes);
  const ping = { last15m: null };
  forEachField(reader, bytes.length, (field, wire) => {
    if (wire === 2 && field === 1) ping.last15m = decodeRolling(reader.bytesField());
    else reader.skip(wire);
  });
  return ping;
}

function decodeWorldStatistics(bytes) {
  const reader = new Reader(bytes);
  const world = {
    totalEntities: 0,
    entityCounts: Object.create(null),
    worlds: [],
    dataPackCount: 0,
    gameRuleCount: 0,
  };

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 0) {
          world.totalEntities = reader.int32();
        } else {
          reader.skip(wire);
        }
        break;
      case 2:
        if (wire === 2) {
          const entry = decodeStringIntEntry(reader.bytesField());
          if (entry.key) {
            world.entityCounts[entry.key] = entry.value;
          }
        } else {
          reader.skip(wire);
        }
        break;
      case 3:
        if (wire === 2) {
          world.worlds.push(decodeWorld(reader.bytesField()));
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) {
          world.gameRuleCount += 1;
          reader.skip(wire);
        } else {
          reader.skip(wire);
        }
        break;
      case 5:
        if (wire === 2) {
          world.dataPackCount += 1;
          reader.skip(wire);
        } else {
          reader.skip(wire);
        }
        break;
      default:
        reader.skip(wire);
    }
  });

  return world;
}

function decodeWorld(bytes) {
  const reader = new Reader(bytes);
  const world = { name: '', totalEntities: 0, regionCount: 0, chunkCount: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) {
      world.name = reader.string();
    } else if (field === 2 && wire === 0) {
      world.totalEntities = reader.int32();
    } else if (field === 3 && wire === 2) {
      const region = decodeRegion(reader.bytesField());
      world.regionCount += 1;
      world.chunkCount += region.chunkCount;
      if (world.totalEntities === 0) {
        world.totalEntities = region.totalEntities;
      }
    } else {
      reader.skip(wire);
    }
  });
  return world;
}

function decodeRegion(bytes) {
  const reader = new Reader(bytes);
  const region = { totalEntities: 0, chunkCount: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) {
      region.totalEntities = reader.int32();
    } else if (field === 2 && wire === 2) {
      region.chunkCount += 1;
      reader.skip(wire);
    } else {
      reader.skip(wire);
    }
  });
  return region;
}

function decodeStringIntEntry(bytes) {
  const reader = new Reader(bytes);
  let key = '';
  let value = 0;
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) {
      key = reader.string();
    } else if (field === 2 && wire === 0) {
      value = reader.int32();
    } else {
      reader.skip(wire);
    }
  });
  return { key, value };
}

/* ---------------------------------------------------------------------------------------------- */
/* System statistics                                                                               */
/* ---------------------------------------------------------------------------------------------- */

function decodeSystemStatistics(bytes) {
  const reader = new Reader(bytes);
  const stats = {
    cpu: null,
    memory: null,
    gc: Object.create(null),
    disk: null,
    os: null,
    java: null,
    jvm: null,
    uptime: 0,
    netCount: 0,
  };

  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 2) stats.cpu = decodeCpu(reader.bytesField());
        else reader.skip(wire);
        break;
      case 2:
        if (wire === 2) stats.memory = decodeSystemMemory(reader.bytesField());
        else reader.skip(wire);
        break;
      case 3:
        if (wire === 2) {
          const entry = decodeGcEntry(reader.bytesField());
          if (entry.key) stats.gc[entry.key] = entry.value;
        } else {
          reader.skip(wire);
        }
        break;
      case 4:
        if (wire === 2) stats.disk = decodeDisk(reader.bytesField());
        else reader.skip(wire);
        break;
      case 5:
        if (wire === 2) stats.os = decodeOs(reader.bytesField());
        else reader.skip(wire);
        break;
      case 6:
        if (wire === 2) stats.java = decodeJava(reader.bytesField());
        else reader.skip(wire);
        break;
      case 7:
        if (wire === 0) stats.uptime = reader.varint();
        else reader.skip(wire);
        break;
      case 8:
        if (wire === 2) {
          stats.netCount += 1;
          reader.skip(wire);
        } else {
          reader.skip(wire);
        }
        break;
      case 9:
        if (wire === 2) stats.jvm = decodeJvm(reader.bytesField());
        else reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  });

  return stats;
}

function decodeCpu(bytes) {
  const reader = new Reader(bytes);
  const cpu = { threads: 0, processUsage: null, systemUsage: null, modelName: '' };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) cpu.threads = reader.int32();
    else if (field === 2 && wire === 2) cpu.processUsage = decodeUsage(reader.bytesField());
    else if (field === 3 && wire === 2) cpu.systemUsage = decodeUsage(reader.bytesField());
    else if (field === 4 && wire === 2) cpu.modelName = reader.string();
    else reader.skip(wire);
  });
  return cpu;
}

function decodeUsage(bytes) {
  const reader = new Reader(bytes);
  const usage = { last1m: 0, last15m: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 1) usage.last1m = reader.double();
    else if (field === 2 && wire === 1) usage.last15m = reader.double();
    else reader.skip(wire);
  });
  return usage;
}

function decodeSystemMemory(bytes) {
  const reader = new Reader(bytes);
  const memory = { physical: null, swap: null };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) memory.physical = decodePoolUsage(reader.bytesField());
    else if (field === 2 && wire === 2) memory.swap = decodePoolUsage(reader.bytesField());
    else reader.skip(wire);
  });
  return memory;
}

function decodePoolUsage(bytes) {
  const reader = new Reader(bytes);
  const pool = { used: 0, total: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) pool.used = reader.varint();
    else if (field === 2 && wire === 0) pool.total = reader.varint();
    else reader.skip(wire);
  });
  return pool;
}
function decodeDisk(bytes) {
  const reader = new Reader(bytes);
  const disk = { used: 0, total: 0 };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) disk.used = reader.varint();
    else if (field === 2 && wire === 0) disk.total = reader.varint();
    else reader.skip(wire);
  });
  return disk;
}

function decodeOs(bytes) {
  const reader = new Reader(bytes);
  const os = { arch: '', name: '', version: '' };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) os.arch = reader.string();
    else if (field === 2 && wire === 2) os.name = reader.string();
    else if (field === 3 && wire === 2) os.version = reader.string();
    else reader.skip(wire);
  });
  return os;
}

function decodeJava(bytes) {
  const reader = new Reader(bytes);
  const java = { vendor: '', version: '', vendorVersion: '', vmArgs: '' };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) java.vendor = reader.string();
    else if (field === 2 && wire === 2) java.version = reader.string();
    else if (field === 3 && wire === 2) java.vendorVersion = reader.string();
    else if (field === 4 && wire === 2) java.vmArgs = reader.string();
    else reader.skip(wire);
  });
  return java;
}

function decodeJvm(bytes) {
  const reader = new Reader(bytes);
  const jvm = { name: '', vendor: '', version: '' };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) jvm.name = reader.string();
    else if (field === 2 && wire === 2) jvm.vendor = reader.string();
    else if (field === 3 && wire === 2) jvm.version = reader.string();
    else reader.skip(wire);
  });
  return jvm;
}

/* ---------------------------------------------------------------------------------------------- */
/* Windows, heap, health                                                                           */
/* ---------------------------------------------------------------------------------------------- */

function decodeWindowStatisticsEntry(bytes) {
  const reader = new Reader(bytes);
  let key = 0;
  let stats = null;
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) {
      key = reader.int32();
    } else if (field === 2 && wire === 2) {
      stats = decodeWindowStatistics(reader.bytesField());
    } else {
      reader.skip(wire);
    }
  });
  return stats ? { key, ...stats } : null;
}

function decodeWindowStatistics(bytes) {
  const reader = new Reader(bytes);
  const stats = {
    ticks: 0,
    cpuProcess: 0,
    cpuSystem: 0,
    tps: 0,
    msptMedian: 0,
    msptMax: 0,
    players: 0,
    entities: 0,
    tileEntities: 0,
    chunks: 0,
    startTime: 0,
    endTime: 0,
    duration: 0,
  };
  forEachField(reader, bytes.length, (field, wire) => {
    switch (field) {
      case 1:
        if (wire === 0) stats.ticks = reader.int32();
        else reader.skip(wire);
        break;
      case 2:
        if (wire === 1) stats.cpuProcess = reader.double();
        else reader.skip(wire);
        break;
      case 3:
        if (wire === 1) stats.cpuSystem = reader.double();
        else reader.skip(wire);
        break;
      case 4:
        if (wire === 1) stats.tps = reader.double();
        else reader.skip(wire);
        break;
      case 5:
        if (wire === 1) stats.msptMedian = reader.double();
        else reader.skip(wire);
        break;
      case 6:
        if (wire === 1) stats.msptMax = reader.double();
        else reader.skip(wire);
        break;
      case 7:
        if (wire === 0) stats.players = reader.int32();
        else reader.skip(wire);
        break;
      case 8:
        if (wire === 0) stats.entities = reader.int32();
        else reader.skip(wire);
        break;
      case 9:
        if (wire === 0) stats.tileEntities = reader.int32();
        else reader.skip(wire);
        break;
      case 10:
        if (wire === 0) stats.chunks = reader.int32();
        else reader.skip(wire);
        break;
      case 11:
        if (wire === 0) stats.startTime = reader.varint();
        else reader.skip(wire);
        break;
      case 12:
        if (wire === 0) stats.endTime = reader.varint();
        else reader.skip(wire);
        break;
      case 13:
        if (wire === 0) stats.duration = reader.int32();
        else reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  });
  return stats;
}

export function decodeHeap(top) {
  const metadata = top.metadata ? decodeHeapMetadata(top.metadata) : null;
  const interner = makeInterner();
  const entries = [];
  for (const item of top.items) {
    const entry = decodeHeapEntry(item, interner);
    if (entry) {
      entries.push(entry);
    }
  }
  return { kind: 'heap', metadata, entries, warnings: [] };
}

function decodeHeapEntry(bytes, interner) {
  const reader = new Reader(bytes);
  const entry = { order: 0, instances: 0, size: 0, type: '' };
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 0) entry.order = reader.int32();
    else if (field === 2 && wire === 0) entry.instances = reader.int32();
    else if (field === 3 && wire === 0) entry.size = reader.varint();
    else if (field === 4 && wire === 2) entry.type = interner(reader.string());
    else reader.skip(wire);
  });
  return entry;
}

export function decodeHealth(top) {
  const metadata = top.metadata ? decodeHeapMetadata(top.metadata) : null;
  const windowStatistics = top.items
    .map(decodeWindowStatisticsEntry)
    .filter(Boolean)
    .sort((a, b) => windowStart(a) - windowStart(b));
  return { kind: 'health', metadata, windowStatistics, warnings: [] };
}

function windowStart(window) {
  return window.startTime > 0 ? window.startTime : window.key * 60_000;
}
