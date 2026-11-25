// Minimal ZIP support for MCP diagnostic bundles: a deterministic deflate
// writer and a bounded, non-extracting reader that never touches the
// filesystem. ZIP64, encryption and multi-disk archives are not supported.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_FLAG = 0x800;
export const STORED = 0;
export const DEFLATED = 8;

export class ZipError extends Error {}

function dosDateTime(date) {
    if (date.getUTCFullYear() < 1980) return [0, (1 << 5) | 1];
    const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    return [time, day];
}

/**
 * Build a ZIP archive. entries: [{ name, data: Buffer|string, mode? }]. All
 * members are deflated and carry the same timestamp (UTC fields of `date`)
 * and, unless overridden per entry, Unix `mode`, so equal inputs produce
 * byte-identical archives.
 */
export function createZip(entries, { date = new Date(Date.UTC(1980, 0, 1)), mode = 0o100600 } = {}) {
    const [time, day] = dosDateTime(date);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data, mode: entryMode = mode } of entries) {
        const nameBytes = Buffer.from(name, "utf8");
        const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        const compressed = deflateRawSync(body);
        const checksum = crc32(body);
        const flags = /^[\x00-\x7f]*$/.test(name) ? 0 : UTF8_FLAG;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(DEFLATED, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL, 0);
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(DEFLATED, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(day, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(body.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE((entryMode << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, compressed);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + compressed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

// Python zipfile decodes names without the UTF-8 flag as cp437; non-ASCII
// names never pass bundle validation, so latin1 is an adequate stand-in.
const decodeName = (bytes, flags) => {
    const name = bytes.toString(flags & UTF8_FLAG ? "utf8" : "latin1");
    const nul = name.indexOf("\0");
    return nul >= 0 ? name.slice(0, nul) : name;
};

function findEnd(buffer) {
    const floor = Math.max(0, buffer.length - 22 - 0xffff);
    for (let index = buffer.length - 22; index >= floor; index -= 1) {
        if (buffer.readUInt32LE(index) === END && index + 22 + buffer.readUInt16LE(index + 20) <= buffer.length) return index;
    }
    throw new ZipError("File is not a zip file");
}

/**
 * Parse the central directory without decompressing anything. Returns entry
 * metadata: { name, flags, method, crc, compressedSize, size, externalAttr,
 * mode, headerOffset, isDir }. Throws ZipError beyond `maxEntries`.
 */
export function listEntries(buffer, { maxEntries = Infinity } = {}) {
    if (buffer.length < 22) throw new ZipError("File is not a zip file");
    const endAt = findEnd(buffer);
    if (buffer.readUInt16LE(endAt + 4) !== 0 || buffer.readUInt16LE(endAt + 6) !== 0) {
        throw new ZipError("zipfiles that span multiple disks are not supported");
    }
    const size = buffer.readUInt32LE(endAt + 12);
    const start = buffer.readUInt32LE(endAt + 16);
    if (buffer.readUInt16LE(endAt + 10) === 0xffff || size === 0xffffffff || start === 0xffffffff) {
        throw new ZipError("ZIP64 archives are not supported");
    }
    const concat = endAt - size - start;
    if (concat < 0) throw new ZipError("Bad offset for central directory");
    const entries = [];
    let position = start + concat;
    const limit = position + size;
    while (position < limit) {
        if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL) {
            throw new ZipError("Bad magic number for central directory");
        }
        if (entries.length >= maxEntries) throw new ZipError("Too many archive members");
        const flags = buffer.readUInt16LE(position + 8);
        const nameLength = buffer.readUInt16LE(position + 28);
        const extraLength = buffer.readUInt16LE(position + 30);
        const commentLength = buffer.readUInt16LE(position + 32);
        const compressedSize = buffer.readUInt32LE(position + 20);
        const fileSize = buffer.readUInt32LE(position + 24);
        if (compressedSize === 0xffffffff || fileSize === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
        const nameBytes = buffer.subarray(position + 46, position + 46 + nameLength);
        const externalAttr = buffer.readUInt32LE(position + 38);
        const name = decodeName(nameBytes, flags);
        entries.push({
            name,
            nameBytes,
            flags,
            method: buffer.readUInt16LE(position + 10),
            crc: buffer.readUInt32LE(position + 16),
            compressedSize,
            size: fileSize,
            externalAttr,
            mode: externalAttr >>> 16,
            headerOffset: buffer.readUInt32LE(position + 42) + concat,
            isDir: name.endsWith("/"),
        });
        position += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** Read one member into memory, verifying header, size and CRC. */
export function readEntry(buffer, entry, { maxBytes = Infinity } = {}) {
    if (entry.flags & 1) throw new ZipError("Encrypted archives are unsupported");
    const at = entry.headerOffset;
    if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL) throw new ZipError("Bad magic number for file header");
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    if (!buffer.subarray(at + 30, at + 30 + nameLength).equals(entry.nameBytes)) {
        throw new ZipError("File name in directory and header differ");
    }
    const dataStart = at + 30 + nameLength + extraLength;
    if (dataStart + entry.compressedSize > buffer.length) throw new ZipError("Truncated archive member");
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    const cap = Math.min(entry.size, maxBytes) + 1;
    let body;
    if (entry.method === STORED) body = raw;
    else if (entry.method === DEFLATED) {
        try {
            body = inflateRawSync(raw, { maxOutputLength: Math.max(cap, 1) });
        } catch {
            throw new ZipError("Archive size mismatch");
        }
    } else throw new ZipError("Unsupported archive compression");
    if (body.length !== entry.size || body.length > maxBytes) throw new ZipError("Archive size mismatch");
    if (crc32(body) !== entry.crc) throw new ZipError(`Bad CRC-32 for file ${JSON.stringify(entry.name)}`);
    return Buffer.from(body);
}

/** PurePosixPath(name).parts and is_absolute() for archive member names. */
export function posixParts(name) {
    let root = "";
    if (name.startsWith("//") && !name.startsWith("///")) root = "//";
    else if (name.startsWith("/")) root = "/";
    const parts = name.split("/").filter((part) => part && part !== ".");
    return { parts: root ? [root, ...parts] : parts, absolute: Boolean(root) };
}

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
