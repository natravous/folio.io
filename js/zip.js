// Minimal read-only ZIP reader. Uses the browser's native DecompressionStream
// for deflate, so there are no third-party dependencies.

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipArchive {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.entries = new Map();
    this.lowerIndex = new Map();
    this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const { view, buffer } = this;
    // The End Of Central Directory record sits in the last 22 + 65535 bytes.
    const min = Math.max(0, buffer.byteLength - 22 - 0xffff);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP/EPUB file.');

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (offset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');

    const utf8 = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== SIG_CDIR) throw new Error('Corrupt ZIP central directory.');
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = utf8.decode(new Uint8Array(buffer, offset + 46, nameLen));
      if (!name.endsWith('/')) {
        const entry = { name, method, compressedSize, size, localOffset };
        this.entries.set(name, entry);
        this.lowerIndex.set(name.toLowerCase(), entry);
      }
      offset += 46 + nameLen + extraLen + commentLen;
    }
  }

  getEntry(path) {
    return this.entries.get(path) || this.lowerIndex.get(path.toLowerCase()) || null;
  }

  has(path) {
    return !!this.getEntry(path);
  }

  async bytes(path) {
    const entry = this.getEntry(path);
    if (!entry) throw new Error(`File not found in archive: ${path}`);
    const { view, buffer } = this;
    const lo = entry.localOffset;
    if (view.getUint32(lo, true) !== SIG_LOCAL) throw new Error(`Corrupt local header: ${path}`);
    const nameLen = view.getUint16(lo + 26, true);
    const extraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    const raw = new Uint8Array(buffer, start, entry.compressedSize);

    if (entry.method === 0) return raw.slice();
    if (entry.method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`Unsupported compression method ${entry.method} for ${path}`);
  }

  async text(path) {
    return decodeText(await this.bytes(path));
  }
}

// Decode bytes honouring a BOM or an XML encoding declaration, defaulting to UTF-8.
export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const m = head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i) || head.match(/<meta[^>]*charset=["']?([\w-]+)/i);
  if (m) {
    try { return new TextDecoder(m[1]).decode(bytes); } catch { /* unknown label: fall through */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
