/**
 * Mojang ProGuard mappings: parsing and frame remapping.
 *
 * Mojang publishes official obfuscation maps per Minecraft version
 * (client.txt / server.txt) in ProGuard's retrace format. The class lines map
 * named -> obfuscated and the indented member lines map named methods to the
 * obfuscated names that appear in a spark profile's stack frames, so the
 * tables are inverted here before use.
 *
 * This module is pure: parsing and remapping only, no I/O. The source
 * resolution (local files, disk cache, download) lives in mappings-source.js.
 */

export const MAX_MAPPING_BYTES = 64 * 1024 * 1024;
const MAX_MAPPING_LINES = 8_000_000;
const MAX_OBFUSCATION_SAMPLES = 5000;
/** Frames from these packages always use readable names and are not evidence either way. */
const JVM_PACKAGE_PREFIXES = ['java.', 'javax.', 'jdk.', 'sun.', 'com.sun.'];

const PRIMITIVE_DESCRIPTORS = new Map([
  ['void', 'V'],
  ['boolean', 'Z'],
  ['byte', 'B'],
  ['char', 'C'],
  ['short', 'S'],
  ['int', 'I'],
  ['long', 'J'],
  ['float', 'F'],
  ['double', 'D'],
]);

const CLASS_LINE = /^([\w$.]+)\s*->\s*([\w$.]+):\s*$/u;
const LINE_RANGE_ONLY = /^\s*\d+:\d+(?:-\d+)?\s*->\s*\S+\s*$/u;
// ProGuard/R8 method lines optionally carry line ranges on both sides of the
// signature: "17:17:void tick():10:12 -> a". The type token must not swallow
// colons, otherwise a prefix the regex does not understand silently becomes a
// bogus return type (and therefore a descriptor that can never match).
const METHOD_LINE =
  /^\s*(?:(\d+):(?:\d+(?:-\d+)?)?:)?\s*([^\s(:]+)\s+([\w$]+)\(([^)]*)\)(?::\d+(?:-\d+)?(?::\d+(?:-\d+)?)?)?\s*->\s*(\S+)\s*$/u;
const LAMBDA_NAME = /^lambda\$([\w$]+)\$(\d+)$/u;
const VERSION_PREFIX = /^v?(\d+)\.(\d+)(?:\.(\d+))?/u;

/**
 * Parse ProGuard mapping text into inverted lookup tables.
 *
 * @param {string} text mapping file contents
 * @returns {{classes: Map<string, string>, methods: Map<string, Map<string, {name: string, desc: string}[]>>, classCount: number, methodCount: number}}
 */
export function parseProGuardMappings(text) {
  const classes = new Map();
  const methods = new Map();
  let classCount = 0;
  let methodCount = 0;
  // ProGuard files are named -> obfuscated. A file with the columns swapped
  // (left flat, right dotted) would rewrite readable names *back* to
  // obfuscated ones, so detect and reject that instead of misapplying it.
  let forwardLines = 0;
  let reversedLines = 0;

  // readFile(path, 'utf8') keeps a leading BOM (TextDecoder strips it), and
  // a BOM would break the first class line. Lines are scanned in place rather
  // than split into an array so an oversized file is rejected before millions
  // of per-line strings are allocated.
  const source = String(text);
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  let currentObfClass = null;
  let lineNumber = 0;
  let cursor = bomOffset;

  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? source.length : newline;
    lineNumber += 1;
    if (lineNumber > MAX_MAPPING_LINES) {
      throw new Error(`mapping file has too many lines (more than ${MAX_MAPPING_LINES})`);
    }

    let line = source.slice(cursor, lineEnd);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    cursor = lineEnd + 1;

    if (line !== '' && !line.startsWith('#')) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        const byName = currentObfClass === null || LINE_RANGE_ONLY.test(line)
          ? null
          : methods.get(currentObfClass);
        const match = byName ? METHOD_LINE.exec(line) : null;
        if (match) {
          const [, , returnType, name, params, obfuscated] = match;
          // Constructors keep their name through obfuscation and never help
          // read a profile; skip them instead of storing useless candidates.
          if (name !== '<init>' && name !== '<clinit>') {
            let candidates = byName.get(obfuscated);
            if (!candidates) {
              candidates = [];
              byName.set(obfuscated, candidates);
            }
            const desc = `(${paramsDesc(params)})${typeDesc(returnType)}`;
            if (!candidates.some((candidate) => candidate.name === name && candidate.desc === desc)) {
              candidates.push({ name, desc });
              methodCount += 1;
            }
          }
        }
      } else {
        currentObfClass = null;
        const match = CLASS_LINE.exec(line);
        if (match) {
          const [, named, obfuscated] = match;
          // Identity lines (java.lang.String -> java.lang.String:) carry no
          // information; skipping them keeps the class table obf-keyed only.
          if (named !== obfuscated) {
            if (named.includes('.') && !obfuscated.includes('.')) {
              forwardLines += 1;
            } else if (!named.includes('.') && obfuscated.includes('.')) {
              reversedLines += 1;
            }
            classes.set(obfuscated, named);
            // Merged or hand-patched mapping files can repeat a class; keep
            // the methods already collected for it instead of wiping them.
            if (!methods.has(obfuscated)) {
              methods.set(obfuscated, new Map());
              classCount += 1;
            }
            currentObfClass = obfuscated;
          }
        }
      }
    }

    if (newline === -1) {
      break;
    }
  }

  if (reversedLines >= 3 && reversedLines > forwardLines) {
    throw new Error('mapping file appears to map obfuscated names to named ones (reversed direction)');
  }

  return { classes, methods, classCount, methodCount };
}

/**
 * Remap a parsed spark export in place: stack frames, source-attribution
 * keys, and heap class names all switch to the mapped (readable) names.
 *
 * @param {object} parsed normalized parse result from lib/parse.js
 * @param {object} mapping result of parseProGuardMappings
 * @param {{kind: string, label: string, version?: string}} source provenance recorded on the profile
 * @returns {{applied: boolean, frames: number, classes: number, methods: number, note?: string}}
 *   frames counts only the sampler stack nodes (heap: entries) whose names
 *   were actually rewritten, so "0 frames" always means "matched nothing";
 *   classes/methods count the distinct class and method identities involved.
 */
export function applyMappings(parsed, mapping, source) {
  if (parsed.mappings?.applied) {
    // Already remapped — e.g. two concurrent tool calls retried resolution
    // on the same cached profile. Applying again would match nothing (the
    // obfuscated names are gone) and falsely report "not applied".
    return parsed.mappings;
  }

  const classes = new Set();
  const methods = new Set();
  const stats = { frames: 0, classes, methods };

  if (parsed.kind === 'sampler') {
    for (const thread of parsed.threads) {
      walkNodes(thread.children, (node) => {
        if (remapNode(node, mapping, stats)) {
          stats.frames += 1;
        }
      });
      // analysis.js memoizes name-derived aggregates on the thread object
      // (_methodGroups, _waitInfo, _launcherShape). Renaming frames
      // invalidates them; they are recomputed on the next query. This
      // matters when mappings are attached after a first summary ran, e.g.
      // the sibling-file retry in index.js.
      if (stats.frames > 0) {
        delete thread._methodGroups;
        delete thread._waitInfo;
        delete thread._launcherShape;
      }
    }
    // Only rewrite the source-attribution keys when at least one frame was
    // actually remapped. A mapping that matched nothing must leave the parsed
    // profile byte-for-byte equivalent, otherwise its keys would no longer
    // line up with the untouched frame names.
    if (stats.frames > 0) {
      parsed.classSources = remapKeyedRecord(parsed.classSources, (key) =>
        mapClassName(mapping, key),
      );
      parsed.methodSources = remapKeyedRecord(parsed.methodSources, (key) => {
        // Key layout is "class;method;desc" but descriptors contain semicolons
        // themselves ("Lnet/minecraft/Foo;V"), so only the first two split.
        const { head, middle, rest } = splitThree(key);
        if (!head || !middle) {
          return key;
        }
        const namedClass = mapClassName(mapping, head);
        const namedMethod = mapMethodName(mapping, head, middle, rest);
        return `${namedClass};${namedMethod};${remapDescriptor(mapping, rest)}`;
      });
      parsed.lineSources = remapKeyedRecord(parsed.lineSources, (key) => {
        const { head, middle, rest } = splitThree(key);
        if (!head) {
          return key;
        }
        return `${mapClassName(mapping, head)};${middle}${rest}`;
      });
    }
  } else if (parsed.kind === 'heap') {
    for (const entry of parsed.entries) {
      // Normalize before comparing, exactly like remapNode: an entry whose
      // type is missing must not be counted as remapped ("" maps to "").
      const original = entry.type || '';
      const mapped = mapClassName(mapping, original);
      if (mapped !== original) {
        classes.add(original);
        entry.type = mapped;
        stats.frames += 1;
      }
    }
  }

  const applied = stats.frames > 0;
  parsed.mappings = { ...source, applied, frames: stats.frames, classes: classes.size, methods: methods.size };
  if (!applied) {
    // A resolved mapping that matched nothing is either for the wrong version
    // or the export already uses readable names; state both instead of
    // silently claiming a remap (or pinning it on one cause).
    const noun = parsed.kind === 'heap' ? 'class names' : 'frames';
    parsed.mappings.note =
      `${source.label ? `${source.label} — ` : ''}matched no ${noun}; ` +
      'the mapping may be for a different version, or the export already uses official names';
  }
  return parsed.mappings;
}

/**
 * The best Minecraft version for mappings lookup: minecraftVersion is exact on
 * modern platforms; version carries suffixes like "1.21.4-R0.1" that are
 * stripped here. Returns null when nothing version-like is present.
 */
export function detectMinecraftVersion(platform) {
  const raw = platform?.minecraftVersion || platform?.version || '';
  const match = VERSION_PREFIX.exec(String(raw).trim());
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/**
 * Why Mojang's server.txt cannot remap this platform's frames, or null when
 * remapping is plausible. Paper-family servers since 1.20.5 run Mojang-mapped
 * at runtime, Fabric reports intermediary names that need a different (tiny)
 * mapping format, and Nukkit is Bedrock with no Mojang classes at all.
 */
export function platformUnmappableReason(platform) {
  const name = `${platform?.name || ''} ${platform?.brand || ''}`.toLowerCase();
  if (name.includes('nukkit')) {
    return 'Nukkit (Bedrock) has no Mojang-mapped classes';
  }
  if (name.includes('fabric')) {
    return 'Fabric reports intermediary names, which Mojang ProGuard mappings cannot remap';
  }
  if (/paper|purpur|folia/u.test(name)) {
    const version = detectMinecraftVersion(platform);
    if (version && compareVersions(version, [1, 20, 5]) >= 0) {
      const label = platform?.name || platform?.brand || 'This platform';
      return `${label} ${version} runs with official names at runtime; no remapping is needed`;
    }
  }
  return null;
}

/**
 * Whether a parsed export still looks ProGuard-obfuscated: flat class names
 * such as `agh` or `a$b` instead of dotted names. JVM frames are ignored so a
 * deep JDK stack does not mask (or fake) the server classes. Platform names
 * are not consulted here, so Spigot/Forge/Fabric exports whose frames are
 * already readable skip the whole mapping machinery even on unknown platforms.
 *
 * Sampling stops after MAX_OBFUSCATION_SAMPLES visited nodes, not classified
 * names, so a tree of only JDK or array frames is bounded too.
 */
export function looksObfuscated(parsed) {
  if (!parsed || (parsed.kind !== 'sampler' && parsed.kind !== 'heap')) {
    return false;
  }

  let obfuscated = 0;
  let readable = 0;
  let visited = 0;
  const consider = (name) => {
    if (!name || name.startsWith('[') || JVM_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return;
    }
    if (name.includes('.')) {
      readable += 1;
    } else {
      obfuscated += 1;
    }
  };

  if (parsed.kind === 'heap') {
    // Cap the scan by rows visited, not by names classified: a heap whose top
    // entries are all arrays/JDK classes must not walk the whole table.
    for (const entry of parsed.entries || []) {
      visited += 1;
      consider(entry.type);
      if (visited >= MAX_OBFUSCATION_SAMPLES) {
        break;
      }
    }
  } else {
    const pending = [...(parsed.threads || [])];
    while (pending.length > 0 && visited < MAX_OBFUSCATION_SAMPLES) {
      const node = pending.pop();
      visited += 1;
      for (const child of node.children || []) {
        pending.push(child);
      }
      consider(node.className);
    }
  }

  const total = obfuscated + readable;
  return total > 0 && obfuscated > 0 && obfuscated * 3 >= total;
}

function compareVersions(version, [major, minor, patch]) {
  const parts = version.split('.').map(Number);
  const pad = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  const target = [major, minor, patch];
  for (let index = 0; index < 3; index += 1) {
    if (pad[index] !== target[index]) {
      return pad[index] - target[index];
    }
  }
  return 0;
}

function walkNodes(nodes, visit) {
  for (const node of nodes || []) {
    visit(node);
    walkNodes(node.children, visit);
  }
}

/** Remap one node in place; returns whether any name was rewritten. */
function remapNode(node, mapping, stats) {
  let changed = false;

  const originalClass = node.className || '';
  const namedClass = mapClassName(mapping, originalClass);
  if (namedClass !== originalClass) {
    node.className = namedClass;
    stats.classes.add(originalClass);
    changed = true;
  }

  const originalMethod = node.methodName || '';
  const namedMethod = mapMethodName(mapping, originalClass, originalMethod, node.methodDesc);
  if (namedMethod !== originalMethod) {
    node.methodName = namedMethod;
    // The descriptor distinguishes overloads sharing one obfuscated name
    // (agh.a is both tick and tickChunk); it is still the original one here.
    stats.methods.add(`${originalClass}.${originalMethod}.${node.methodDesc || ''}`);
    changed = true;
  }

  if (node.methodDesc) {
    const namedDesc = remapDescriptor(mapping, node.methodDesc);
    if (namedDesc !== node.methodDesc) {
      node.methodDesc = namedDesc;
      changed = true;
    }
  }
  return changed;
}

function mapClassName(mapping, className) {
  if (!className) {
    return className;
  }
  const named = mapping.classes.get(className);
  if (named !== undefined) {
    return named;
  }
  // Array spellings ("agh[]" from a heap type): remap the element class and
  // keep the dimensions. Split the suffix manually: a regex with a lazy inner
  // group backtracks quadratically on a crafted name such as "agh[]…[]x", and
  // the name comes straight from the untrusted export.
  const split = splitArraySuffix(className);
  if (split) {
    const inner = mapping.classes.get(split.inner);
    if (inner !== undefined) {
      return `${inner}${split.suffix}`;
    }
  }
  return className;
}

/**
 * Split a JVM type spelling such as "agh[]" into its element name and the
 * untouched "[]" suffix (whitespace between the brackets is tolerated, as the
 * profile format uses plain "[]"). Linear in the name length; returns null
 * when the name does not end in one or more array dimensions.
 */
function splitArraySuffix(className) {
  let end = className.length;
  let suffixStart = -1;
  for (;;) {
    let cursor = end - 1;
    while (cursor >= 0 && isAsciiSpace(className.charCodeAt(cursor))) {
      cursor -= 1;
    }
    if (cursor <= 0 || className.charCodeAt(cursor) !== 0x5d /* ] */) {
      break;
    }
    let open = cursor - 1;
    while (open >= 0 && isAsciiSpace(className.charCodeAt(open))) {
      open -= 1;
    }
    if (open <= 0 || className.charCodeAt(open) !== 0x5b /* [ */) {
      break;
    }
    // The whitespace before "[" belongs to the suffix, not to the element name.
    let start = open;
    while (start > 0 && isAsciiSpace(className.charCodeAt(start - 1))) {
      start -= 1;
    }
    suffixStart = start;
    end = start;
  }
  if (suffixStart < 1) {
    return null;
  }
  return { inner: className.slice(0, suffixStart), suffix: className.slice(suffixStart) };
}

function isAsciiSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d;
}

function mapMethodName(mapping, obfClass, methodName, obfDesc = '') {
  if (!obfClass || !methodName) {
    return methodName;
  }
  const byName = mapping.methods.get(obfClass);
  if (!byName) {
    return methodName;
  }
  const namedDesc = obfDesc ? remapDescriptor(mapping, obfDesc) : '';

  // An exact table entry always wins. Mojang's official files map named
  // lambdas to short obfuscated names (lambda$tick$0 -> a), so a lambda's
  // runtime frame is the short name and resolves through its exact entry by
  // descriptor; mappings that keep lambda-shaped obfuscated targets resolve
  // the same way.
  const exact = pickCandidate(byName.get(methodName), namedDesc);
  if (exact) {
    return exact;
  }

  // No exact entry: synthesize lambda$<enclosing>$<index> from the mapped
  // enclosing method for mapping files that omit lambda lines. The index is
  // the obfuscated-side counter, so this stays a best-effort guess; when the
  // enclosing name itself resolves to a lambda, synthesizing would double
  // the prefix (lambda$lambda$tick$0$0), so keep the original instead.
  const lambdaMatch = LAMBDA_NAME.exec(methodName);
  if (lambdaMatch) {
    const mapped = pickCandidate(byName.get(lambdaMatch[1]), namedDesc, { approximate: true });
    if (mapped && !mapped.startsWith('lambda$')) {
      return `lambda$${mapped}$${lambdaMatch[2]}`;
    }
  }
  return methodName;
}

/**
 * Resolve the readable method name for one frame. The profile does not always
 * carry a descriptor, and one obfuscated name can serve several overloads, so
 * the descriptor (when present and remapped into named space) picks the exact
 * overload. Without a descriptor the first candidate wins deterministically;
 * with a descriptor that matches none of several overloads, guessing would
 * silently attach the wrong name, so the obfuscated name is kept unless the
 * caller explicitly allows an approximate match (the lambda heuristic).
 */
function pickCandidate(candidates, namedDesc, { approximate = false } = {}) {
  if (!candidates || candidates.length === 0) {
    return null;
  }
  if (namedDesc) {
    const exact = candidates.find((candidate) => candidate.desc === namedDesc);
    if (exact) {
      return exact.name;
    }
    if (!approximate && candidates.length > 1) {
      return null;
    }
  }
  return candidates[0].name;
}

/**
 * Rewrite the class references inside a JVM method descriptor.
 *
 * Scanned manually instead of with /L([\w$/]+);/: the descriptor comes from
 * the untrusted export, and the regex backtracks quadratically on a crafted
 * value such as "LLLL…" with no terminating semicolon. A single left-to-right
 * pass is linear and finds every class reference, including one that follows a
 * malformed one.
 */
export function remapDescriptor(mapping, desc) {
  if (!desc || !desc.includes('L')) {
    return desc;
  }
  const text = String(desc);
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('L', cursor);
    if (start === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, start);
    let end = start + 1;
    while (end < text.length && isDescriptorNameCode(text.charCodeAt(end))) {
      end += 1;
    }
    if (end > start + 1 && text.charCodeAt(end) === 0x3b /* ; */) {
      const inner = text.slice(start + 1, end);
      const named = mapping.classes.get(inner);
      if (named !== undefined) {
        out += `L${named.replace(/\./gu, '/')};`;
      } else {
        out += text.slice(start, end + 1);
      }
      cursor = end + 1;
      continue;
    }
    // Not a class reference: this whole run of name characters has the same
    // non-";" terminator, so no "L" inside it can match either. Skip it rather
    // than rescanning from the next character (which would be quadratic).
    out += text.slice(start, end);
    cursor = end;
  }
  return out;
}

/** [A-Za-z0-9_$/] — the characters a JVM internal class name may contain. */
function isDescriptorNameCode(code) {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f /* _ */ ||
    code === 0x24 /* $ */ ||
    code === 0x2f /* / */
  );
}

function splitThree(key) {
  const first = key.indexOf(';');
  if (first === -1) {
    return { head: key, middle: '', rest: '' };
  }
  const second = key.indexOf(';', first + 1);
  if (second === -1) {
    return { head: key.slice(0, first), middle: key.slice(first + 1), rest: '' };
  }
  return {
    head: key.slice(0, first),
    middle: key.slice(first + 1, second),
    rest: key.slice(second + 1),
  };
}

function remapKeyedRecord(record, remapKey) {
  if (!record) {
    return record;
  }
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[remapKey(key)] = value;
  }
  return out;
}

function paramsDesc(params) {
  const text = String(params || '').trim();
  if (text === '') {
    return '';
  }
  let desc = '';
  for (const rawParam of text.split(',')) {
    desc += typeDesc(rawParam.trim());
  }
  return desc;
}

function typeDesc(type) {
  let dims = 0;
  let name = String(type || '').trim();
  // Count and strip the trailing "[]" pairs from the right instead of
  // re-slicing the whole string once per dimension: a mapping line with a
  // pathological suffix would otherwise be quadratic to parse.
  let end = name.length;
  for (;;) {
    if (end < 2 || name.charCodeAt(end - 1) !== 0x5d /* ] */ || name.charCodeAt(end - 2) !== 0x5b /* [ */) {
      break;
    }
    dims += 1;
    end -= 2;
    while (end > 0 && isAsciiSpace(name.charCodeAt(end - 1))) {
      end -= 1;
    }
  }
  name = name.slice(0, end);
  const primitive = PRIMITIVE_DESCRIPTORS.get(name);
  const base = primitive !== undefined ? primitive : `L${name.replace(/\./gu, '/')};`;
  return '['.repeat(dims) + base;
}
