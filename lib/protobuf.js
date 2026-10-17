/**
 * Minimal dependency-free protobuf wire-format reader.
 *
 * spark exports are plain protobuf messages (optionally gzip-wrapped). Only the
 * wire format is needed: varints, fixed64 doubles, and length-delimited fields.
 */

const textDecoder = new TextDecoder('utf-8');

export class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.length = bytes.length;
  }

  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.length) {
        throw new RangeError('unexpected end of protobuf varint');
      }
      const byte = this.bytes[this.pos++];
      if (shift < 53) {
        result += (byte & 0x7f) * 2 ** shift;
      }
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7;
      if (shift > 70) {
        throw new RangeError('protobuf varint is too long');
      }
    }
  }

  int32() {
    // Accumulate only the low 32 bits: proto3 encodes a negative int32 as a
    // ten-byte sign-extended varint, whose low 32 bits are the two's complement
    // value. Reading it as a Number first would lose that (2^64 rounds away).
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.length) {
        throw new RangeError('unexpected end of protobuf varint');
      }
      const byte = this.bytes[this.pos++];
      if (shift < 32) {
        result = (result | ((byte & 0x7f) << shift)) >>> 0;
      }
      if ((byte & 0x80) === 0) {
        return result | 0;
      }
      shift += 7;
      if (shift > 70) {
        throw new RangeError('protobuf varint is too long');
      }
    }
  }

  /** Signed int64 for fields where spark uses -1 as "unknown" (for example MemoryUsage.max). */
  int64Signed() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.length) {
        throw new RangeError('unexpected end of protobuf varint');
      }
      const byte = this.bytes[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return Number(BigInt.asIntN(64, result));
      }
      shift += 7n;
      if (shift > 70n) {
        throw new RangeError('protobuf varint is too long');
      }
    }
  }

  bytesField() {
    const length = this.varint();
    if (length < 0 || this.pos + length > this.length) {
      throw new RangeError('protobuf field extends past the end of the message');
    }
    const start = this.pos;
    this.pos += length;
    return this.bytes.subarray(start, this.pos);
  }

  string() {
    return textDecoder.decode(this.bytesField());
  }

  double() {
    if (this.pos + 8 > this.length) {
      throw new RangeError('unexpected end of protobuf double');
    }
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }

  fixed32() {
    if (this.pos + 4 > this.length) {
      throw new RangeError('unexpected end of protobuf fixed32');
    }
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  skip(wire) {
    switch (wire) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        const length = this.varint();
        this.pos += length;
        break;
      }
      case 3:
      case 4:
        // spark's proto3 schemas never use groups; treat this as malformed data.
        throw new RangeError('unsupported protobuf group encoding');
      case 5:
        this.pos += 4;
        break;
      default:
        throw new RangeError(`unsupported protobuf wire type ${wire}`);
    }
    if (this.pos > this.length) {
      throw new RangeError('protobuf field extends past the end of the message');
    }
  }
}

export function forEachField(reader, end, callback) {
  while (reader.pos < end) {
    const tag = reader.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) {
      throw new RangeError('invalid protobuf field number 0');
    }
    callback(field, wire);
  }
  if (reader.pos !== end) {
    throw new RangeError('protobuf message length mismatch');
  }
}

export function readRepeatedDouble(reader, wire, sink) {
  if (wire === 2) {
    const length = reader.varint();
    const end = reader.pos + length;
    if (end > reader.length) {
      throw new RangeError('packed double array extends past the message');
    }
    while (reader.pos < end) {
      sink(reader.double());
    }
  } else if (wire === 1) {
    sink(reader.double());
  } else {
    reader.skip(wire);
  }
}

export function readRepeatedInt32(reader, wire) {
  const values = [];
  if (wire === 2) {
    const length = reader.varint();
    const end = reader.pos + length;
    if (end > reader.length) {
      throw new RangeError('packed int32 array extends past the message');
    }
    while (reader.pos < end) {
      values.push(reader.int32());
    }
  } else if (wire === 0) {
    values.push(reader.int32());
  } else {
    reader.skip(wire);
  }
  return values;
}

/** Interns repeated strings so a large stack tree does not hold thousands of copies. */
export function makeInterner() {
  const pool = new Map();
  return (value) => {
    if (!value) {
      return '';
    }
    let interned = pool.get(value);
    if (interned === undefined) {
      pool.set(value, value);
      interned = value;
    }
    return interned;
  };
}

/** Read one protobuf `map<string, string>` entry. */
export function readStringMapEntry(bytes) {
  const reader = new Reader(bytes);
  let key = '';
  let value = '';
  forEachField(reader, bytes.length, (field, wire) => {
    if (field === 1 && wire === 2) {
      key = reader.string();
    } else if (field === 2 && wire === 2) {
      value = reader.string();
    } else {
      reader.skip(wire);
    }
  });
  return { key, value };
}
