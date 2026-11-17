/**
 * Read the one file inside a single-entry ZIP (the Binance archive's daily
 * files), with node:zlib. Supports stored (0) and deflate (8) entries; sizes
 * come from the central directory, so a local header with a data descriptor
 * still works. No dependency added.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function readSingleZipEntry(zip: Buffer): { name: string; data: Buffer } {
  // End of central directory: last 22 bytes + up to a 64 KiB comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const entries = zip.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error(`zip has ${entries} entries, expected 1`);
  const cd = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cd) !== CENTRAL_SIG) throw new Error("bad zip central directory");
  const method = zip.readUInt16LE(cd + 10);
  const compressedSize = zip.readUInt32LE(cd + 20);
  const size = zip.readUInt32LE(cd + 24);
  const nameLen = zip.readUInt16LE(cd + 28);
  const localOffset = zip.readUInt32LE(cd + 42);
  const name = zip.toString("utf8", cd + 46, cd + 46 + nameLen);
  if (zip.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error("bad zip local header");
  const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  const body = zip.subarray(start, start + compressedSize);
  let data: Buffer;
  if (method === 0) data = Buffer.from(body);
  else if (method === 8) data = inflateRawSync(body);
  else throw new Error(`unsupported zip compression method ${method}`);
  if (data.length !== size) throw new Error(`zip entry size ${data.length} != ${size}`);
  return { name, data };
}
