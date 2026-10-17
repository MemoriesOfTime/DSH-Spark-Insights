/**
 * Mapping source resolution for Mojang ProGuard mappings.
 *
 * Resolution order, most specific first:
 *   1. an explicit mappings_path argument (tool parameter),
 *   2. a mapping file next to the export (<export>.mappings, <export>.map,
 *      server.txt, client.txt),
 *   3. the on-disk cache directory (<version>.txt files; auto-downloaded
 *      mappings are stored here and users can pre-place their own),
 *   4. an automatic download from Mojang's piston-meta service, cached back
 *      to (3).
 *
 * Every local candidate is parsed and validated before it is accepted: a file
 * that happens to be called server.txt but is not a ProGuard mapping is
 * ignored instead of masking the cache/download behind a misleading "matched
 * no frames" note. Downloads are bounded by one overall time budget, validated
 * before they are cached, and a transient failure is retried after a short
 * backoff instead of for the lifetime of the process (definitive answers such
 * as a version without mappings are not retried).
 *
 * Downloads are best-effort: any failure keeps the original obfuscated names
 * and is reported through the summary note. Set SPARK_INSIGHTS_NO_NETWORK=1
 * to disable downloads entirely, and SPARK_INSIGHTS_MAPPINGS_DIR to move the
 * cache directory.
 *
 * Platforms whose frames never carry Mojang-obfuscated names (Paper/Purpur/
 * Folia ≥ 1.20.5, Fabric, Nukkit) are skipped before every automatic source.
 * Exports whose sampled frames already use readable class names (Spigot,
 * Forge/NeoForge SRG, proxies) still honor a co-located mapping file, but the
 * version cache and downloads are skipped. An explicit mappings_path overrides
 * both checks.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
  MAX_MAPPING_BYTES,
  detectMinecraftVersion,
  looksObfuscated,
  parseProGuardMappings,
  platformUnmappableReason,
} from './mappings.js';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
/** One budget for the manifest, the version JSON and the mapping file together. */
const DOWNLOAD_BUDGET_MS = 25_000;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const VERSION_JSON_MAX_BYTES = 1024 * 1024;
/** A failed version is retried after this delay instead of being disabled for the process. */
const FAILURE_TTL_MS = 120_000;
const PARSED_CACHE_LIMIT = 3;
/**
 * Parsed mappings are heavy: a full server.txt is ~9 MB on disk but parses to
 * ~10^5 method entries, measured at roughly 50-120 MB of retained heap. Keep
 * a small weight budget (classes + methods) instead of a plain entry count.
 */
const PARSED_CACHE_WEIGHT_BUDGET = 250_000;
/** Downloads whose cache write failed are kept in memory so they are not refetched. */
const DOWNLOAD_MEMO_LIMIT = 2;

/** Parsed mappings are expensive; keep the most recent few within the weight budget. */
const parsedCache = new Map();
/** Versions whose download failed recently: version -> {reason, at, permanent}. */
const unavailableVersions = new Map();
/** Successful downloads that could not be written to the cache: version -> {text, origin}. */
const downloadedMappings = new Map();

export function mappingsCacheDir() {
  return process.env.SPARK_INSIGHTS_MAPPINGS_DIR || join(homedir(), '.dsh', 'spark-insights-mappings');
}

/**
 * Resolve and parse the mapping to apply to one profile, if any.
 *
 * @param {object} options
 * @param {object} options.parsed normalized parse result
 * @param {string|undefined} options.explicitPath mappings_path tool argument
 * @param {Function} options.readExternal async (path) => Uint8Array|null; reads through the host filesystem service
 * @param {AbortSignal|undefined} options.signal caller cancellation
 * @param {Function|undefined} options.fetchText async (url, signal, maxBytes) => string; defaults to global fetch
 * @returns {Promise<{mapping: object|null, source: {kind: string, label: string, version?: string, identity: string}, note?: string, skipped?: boolean}>}
 */
export async function resolveMappings({ parsed, explicitPath, readExternal, signal, fetchText }) {
  const platform = parsed.metadata?.platform;
  const version = detectMinecraftVersion(platform);

  if (explicitPath) {
    return resolveExplicit({ explicitPath, readExternal, version });
  }

  // Platforms that never carry Mojang-obfuscated names are skipped before
  // every automatic source: applying server.txt to official (or intermediary)
  // names matches nothing and used to be reported as a remap.
  const platformReason = platformUnmappableReason(platform);
  if (platformReason) {
    return empty(version, platformReason, true);
  }

  // A mapping file placed next to the export is explicit user intent and is
  // honored even when the frames look readable; it is local and validated.
  const sibling = parsed.file?.path ? await findSibling(readExternal, parsed.file.path) : null;
  if (sibling) {
    return {
      mapping: sibling.mapping,
      source: { kind: 'file', label: sibling.path, version, identity: sibling.identity },
    };
  }

  // The platform name alone is not enough: Spigot, Paper < 1.20.5, Forge and
  // proxies all run readable class names. Check the sampled frames before
  // spending a cache read or a download on a mapping that cannot match.
  if (!looksObfuscated(parsed)) {
    return empty(version, 'the sampled frames contain no obfuscated class names; remapping is not needed', true);
  }

  if (!version) {
    return empty(version, 'the export carries no Minecraft version to look up mappings for');
  }

  const cachedText = await readCachedMapping(version);
  if (cachedText) {
    const identity = `cache:${version}:${fingerprint(cachedText)}`;
    let mapping = null;
    try {
      mapping = parseAndCache(identity, cachedText);
    } catch {
      // A user-placed file that cannot be parsed is ignored rather than
      // blocking the download that could replace it.
    }
    if (isUsableMapping(mapping)) {
      return {
        mapping,
        source: { kind: 'cache', label: displayCachePath(version), version, identity },
      };
    }
  }

  // A previous download that could not be cached is still valid in memory.
  // It is checked before the download gates below: reusing it makes no network
  // request, so SPARK_INSIGHTS_NO_NETWORK must not hide it.
  const memo = downloadedMappings.get(version);
  if (memo) {
    const identity = `mojang:${version}:${fingerprint(memo.text)}`;
    const mapping = parseAndCache(identity, memo.text);
    if (isUsableMapping(mapping)) {
      // Retry the cache write: a directory that was read-only earlier may have
      // become writable, and then the memory copy is no longer needed.
      let stored = false;
      try {
        await storeCachedMapping(version, memo.text);
        downloadedMappings.delete(version);
        stored = true;
      } catch {
        // Keep the in-memory copy for the next call.
      }
      return {
        mapping,
        source: {
          kind: 'download',
          label: `Mojang ${memo.origin} for ${version}${stored ? ' (cached locally)' : ''}`,
          version,
          identity,
        },
      };
    }
    downloadedMappings.delete(version);
  }

  const skip = skipDownloadReason(version);
  if (skip) {
    return empty(version, skip);
  }

  const download = await downloadMojangMappings(version, signal, fetchText);
  if (!download.ok) {
    rememberUnavailable(version, download.reason, download.permanent === true);
    return empty(version, `automatic Mojang mappings download failed (${download.reason}); names are left as-is`);
  }

  const identity = `mojang:${version}:${fingerprint(download.text)}`;
  let mapping;
  try {
    mapping = parseAndCache(identity, download.text);
  } catch (error) {
    rememberUnavailable(version, `downloaded file is not usable (${error.message})`);
    return empty(version, `automatic Mojang mappings download returned an unusable file (${error.message}); names are left as-is`);
  }
  if (!isUsableMapping(mapping)) {
    rememberUnavailable(version, 'downloaded file is not a ProGuard mapping');
    return empty(version, 'automatic Mojang mappings download returned no class entries; names are left as-is');
  }

  let stored = false;
  try {
    await storeCachedMapping(version, download.text);
    stored = true;
  } catch {
    // A read-only or unwritable cache must not block the remapping itself.
    rememberDownloaded(version, download);
  }

  return {
    mapping,
    source: {
      kind: 'download',
      label: `Mojang ${download.origin} for ${version}${stored ? ' (cached locally)' : ''}`,
      version,
      identity,
    },
  };
}

/**
 * A cheap, stat-based signature of every local mapping input for one profile.
 *
 * It is stored on the parsed profile so a later call can notice that a mapping
 * file appeared, changed, or disappeared and re-parse instead of serving stale
 * (or missing) names. Only size and filesystem version are used, so this is a
 * few stats per call and never reads mapping contents.
 *
 * @param {object} options
 * @param {object} options.parsed normalized parse result
 * @param {string|undefined} options.explicitPath mappings_path tool argument
 * @param {Function} options.statExternal async (path) => {size?: number, version?: string|number}|null
 * @returns {Promise<string>}
 */
export async function mappingFootprint({ parsed, explicitPath, statExternal }) {
  if (typeof statExternal !== 'function') {
    return 'unknown';
  }

  if (explicitPath) {
    const info = await safeStat(statExternal, explicitPath);
    return `explicit:${explicitPath}:${statKey(info)}`;
  }

  // Nothing is consulted for these platforms, so changes in mapping files do
  // not need to invalidate the parsed profile.
  if (platformUnmappableReason(parsed?.metadata?.platform)) {
    return 'skip';
  }

  const paths = [];
  if (parsed?.file?.path) {
    paths.push(...siblingCandidates(parsed.file.path));
  }
  const version = detectMinecraftVersion(parsed?.metadata?.platform);
  if (version) {
    paths.push(join(mappingsCacheDir(), `${version}.txt`));
  }

  const parts = [];
  for (const path of paths) {
    const info = await safeStat(statExternal, path);
    parts.push(`${path}:${statKey(info)}`);
  }
  return parts.join('|') || 'none';
}

function empty(version, note, skipped = false) {
  return {
    mapping: null,
    source: { kind: 'none', label: '', version, identity: 'none' },
    note,
    skipped,
  };
}

async function resolveExplicit({ explicitPath, readExternal, version }) {
  let bytes = null;
  try {
    bytes = await readExternal(explicitPath);
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length === 0) {
    return empty(version, `mappings_path "${explicitPath}" could not be read or is empty; names are left as-is`);
  }

  const identity = `file:${explicitPath}:${fingerprint(bytes)}`;
  let mapping;
  try {
    mapping = parseAndCache(identity, bytes);
  } catch (error) {
    return empty(version, `mappings_path "${explicitPath}" is not usable: ${error.message}`);
  }
  if (!isUsableMapping(mapping)) {
    return empty(
      version,
      `mappings_path "${explicitPath}" is not a ProGuard mapping file (no class entries); names are left as-is`,
    );
  }

  return {
    mapping,
    source: { kind: 'file', label: explicitPath, version, identity },
  };
}

function skipDownloadReason(version) {
  const recent = unavailableVersions.get(version);
  if (recent) {
    if (recent.permanent || Date.now() - recent.at < FAILURE_TTL_MS) {
      return `mappings for ${version} are unavailable (${recent.reason})`;
    }
    unavailableVersions.delete(version);
  }
  if (process.env.SPARK_INSIGHTS_NO_NETWORK === '1') {
    return 'network lookups are disabled (SPARK_INSIGHTS_NO_NETWORK=1)';
  }
  return null;
}

function rememberUnavailable(version, reason, permanent = false) {
  unavailableVersions.set(version, { reason, at: Date.now(), permanent });
}

function rememberDownloaded(version, download) {
  downloadedMappings.delete(version);
  downloadedMappings.set(version, { text: download.text, origin: download.origin });
  while (downloadedMappings.size > DOWNLOAD_MEMO_LIMIT) {
    downloadedMappings.delete(downloadedMappings.keys().next().value);
  }
}

/** Mapping files conventionally placed next to an export, in priority order. */
function siblingCandidates(exportPath) {
  const dir = dirname(exportPath);
  const base = basename(exportPath);
  return [
    join(dir, `${base}.mappings`),
    join(dir, `${base}.map`),
    join(dir, 'server.txt'),
    join(dir, 'client.txt'),
  ];
}

/**
 * Look for a valid mapping file next to the export. Candidates mirror common
 * conventions so a co-located file "just works" without parameters; files that
 * do not parse into at least one class are skipped, not accepted.
 */
async function findSibling(readExternal, exportPath) {
  for (const candidate of siblingCandidates(exportPath)) {
    let bytes = null;
    try {
      bytes = await readExternal(candidate);
    } catch {
      bytes = null;
    }
    if (!bytes || bytes.length === 0) {
      continue;
    }

    const identity = `file:${candidate}:${fingerprint(bytes)}`;
    let mapping;
    try {
      mapping = parseAndCache(identity, bytes);
    } catch {
      continue;
    }
    if (isUsableMapping(mapping)) {
      return { path: candidate, mapping, identity };
    }
  }
  return null;
}

async function readCachedMapping(version) {
  const path = join(mappingsCacheDir(), `${version}.txt`);
  try {
    // Stat first so a user-placed or corrupted multi-gigabyte file is never
    // read into memory; parseAndCache re-checks the byte length afterwards.
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_MAPPING_BYTES) {
      return null;
    }
    const text = await readFile(path, 'utf8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function storeCachedMapping(version, text) {
  const dir = mappingsCacheDir();
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, `${version}.txt`);
  // Write the temporary file next to the destination: a rename across
  // filesystems fails, and leaving the temporary file behind on failure is
  // worse than the write itself failing.
  const tempPath = join(dir, `.${version}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tempPath, text, 'utf8');
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

async function downloadMojangMappings(version, signal, fetchTextImpl) {
  const fetcher = fetchTextImpl || globalFetchText;
  const budget = downloadSignal(signal);
  try {
    const manifestText = await fetcher(MANIFEST_URL, budget, MANIFEST_MAX_BYTES);
    const manifest = JSON.parse(manifestText);
    const entry = (manifest.versions || []).find((item) => item.id === version);
    if (!entry?.url) {
      return { ok: false, reason: `Minecraft ${version} is not in the Mojang version manifest`, permanent: true };
    }

    const versionJsonText = await fetcher(entry.url, budget, VERSION_JSON_MAX_BYTES);
    const versionJson = JSON.parse(versionJsonText);
    const serverUrl = versionJson.downloads?.server_mappings?.url;
    const clientUrl = versionJson.downloads?.client_mappings?.url;
    const origin = serverUrl ? 'server_mappings' : clientUrl ? 'client_mappings' : null;
    const url = serverUrl || clientUrl;
    if (!origin || !url) {
      return { ok: false, reason: `Minecraft ${version} publishes no mappings`, permanent: true };
    }

    const text = await fetcher(url, budget, MAX_MAPPING_BYTES);
    return { ok: true, text, origin };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timed out or cancelled' : String(error?.message || error),
    };
  }
}

/** One deadline for the whole three-request download, not one per request. */
function downloadSignal(signal) {
  const budget = AbortSignal.timeout(DOWNLOAD_BUDGET_MS);
  if (signal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, budget]);
  }
  return budget;
}

async function globalFetchText(url, signal, maxBytes) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this runtime');
  }
  const response = await fetch(url, {
    signal,
    headers: { 'user-agent': 'dsh-spark-insights (Minecraft spark profile reader)' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new Error(`response of ${declared} bytes exceeds the ${maxBytes} byte limit`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`response of ${buffer.byteLength} bytes exceeds the ${maxBytes} byte limit`);
  }
  return new TextDecoder().decode(buffer);
}

function fingerprint(bytesOrText) {
  const buffer =
    typeof bytesOrText === 'string' ? Buffer.from(bytesOrText, 'utf8') : Buffer.from(bytesOrText);
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function isUsableMapping(mapping) {
  return Boolean(mapping && mapping.classCount > 0);
}

function parseAndCache(identity, bytesOrText) {
  const hit = parsedCache.get(identity);
  if (hit) {
    parsedCache.delete(identity);
    parsedCache.set(identity, hit);
    return hit.mapping;
  }
  // Compare bytes, not UTF-16 code units, so the cap matches the byte limits
  // enforced by the readers upstream.
  const byteLength =
    typeof bytesOrText === 'string' ? Buffer.byteLength(bytesOrText, 'utf8') : bytesOrText.byteLength;
  if (byteLength > MAX_MAPPING_BYTES) {
    throw new Error(`mapping file exceeds the ${MAX_MAPPING_BYTES} byte limit`);
  }
  const text =
    typeof bytesOrText === 'string' ? bytesOrText : new TextDecoder().decode(bytesOrText);
  const mapping = parseProGuardMappings(text);
  const weight = mapping.classCount + mapping.methodCount;
  parsedCache.set(identity, { mapping, weight });
  evictParsedCache();
  return mapping;
}

function evictParsedCache() {
  let total = 0;
  for (const entry of parsedCache.values()) {
    total += entry.weight;
  }
  while (parsedCache.size > 1 && (parsedCache.size > PARSED_CACHE_LIMIT || total > PARSED_CACHE_WEIGHT_BUDGET)) {
    const oldestKey = parsedCache.keys().next().value;
    total -= parsedCache.get(oldestKey).weight;
    parsedCache.delete(oldestKey);
  }
}

function displayCachePath(version) {
  const dir = mappingsCacheDir();
  const home = homedir();
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  const where = dir === home ? '~' : dir.startsWith(prefix) ? `~${dir.slice(home.length)}` : dir;
  return join(where, `${version}.txt`);
}

async function safeStat(statExternal, path) {
  try {
    return await statExternal(path);
  } catch {
    return null;
  }
}

function statKey(info) {
  return info ? `${info.size ?? ''}:${info.version ?? ''}` : 'missing';
}
