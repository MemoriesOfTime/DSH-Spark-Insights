/**
 * Entry point for raw spark exports.
 *
 * A local `.sparkprofile`/`.sparkheap` is plain protobuf. Uploaded bytebin
 * payloads are also plain protobuf, but gzip-wrapped copies are accepted so a
 * manually compressed export still works.
 */

import { gunzipSync } from 'node:zlib';

import {
  decodeTopLevel,
  detectKind,
  decodeSampler,
  decodeHeap,
  decodeHealth,
} from './spark-format.js';
import { decodeSchema } from './schema-format.js';

const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

export function parseSparkFile(bytes, options = {}) {
  const fileName = options.fileName || 'spark export';
  const compressed = isGzip(bytes);
  let data = bytes;

  if (compressed) {
    try {
      data = gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } catch (error) {
      throw new Error(
        `cannot decompress "${fileName}" as gzip data: ${error.message}. ` +
          'The file may be truncated or not a spark export.',
      );
    }
  }

  if (data.length === 0) {
    throw new Error(`cannot parse "${fileName}": the file is empty`);
  }

  let top;
  try {
    top = decodeTopLevel(data);
  } catch (error) {
    throw new Error(
      `cannot parse "${fileName}" as protobuf: ${error.message}. ` +
        'Expected a .sparkprofile or .sparkheap export from spark.',
    );
  }

  const kind = detectKind(top, fileName);

  let parsed = null;
  try {
    parsed = decodeSchema(data, kind);
  } catch {
    // Fall through to the legacy decoder; it also provides the historical
    // error messages for malformed data.
  }

  if (!parsed) {
    try {
      if (kind === 'heap') {
        parsed = decodeHeap(top);
      } else if (kind === 'health') {
        parsed = decodeHealth(top);
      } else {
        parsed = decodeSampler(top);
      }
    } catch (error) {
      throw new Error(
        `cannot parse "${fileName}" as spark ${kind} data: ${error.message}`,
      );
    }
  }

  if (parsed.kind === 'sampler' && !parsed.metadata && parsed.threads.length === 0) {
    throw new Error(
      `cannot parse "${fileName}" as a spark profile: no metadata or sampled threads were found`,
    );
  }
  if (parsed.kind === 'heap' && !parsed.metadata && parsed.entries.length === 0) {
    throw new Error(
      `cannot parse "${fileName}" as a spark heap summary: no metadata or heap entries were found`,
    );
  }
  if (parsed.kind === 'health' && !parsed.metadata) {
    throw new Error(
      `cannot parse "${fileName}" as a spark health report: no metadata was found`,
    );
  }

  parsed.file = {
    path: fileName,
    size: bytes.length,
    uncompressedSize: data.length,
    compressed,
  };
  parsed.dataVersion = parsed.metadata?.platform?.dataVersion || 0;

  if (parsed.dataVersion > 2) {
    parsed.warnings.push(
      `profile data version ${parsed.dataVersion} is newer than the version this plugin knows (2); some fields may be missing`,
    );
  }

  return parsed;
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
