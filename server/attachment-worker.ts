import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { ATTACHMENT_LIMITS as L, type AttachmentMime, type AttachmentParseResult, type AttachmentErrorCode } from '../shared/attachments.js';
// Defense in depth: supplied bytes only. Parsers receive no URL/path and no external asset roots.
const deny = () => { throw new Error('External access is disabled in attachment extraction'); };
Object.assign(net, { connect: deny, createConnection: deny }); Object.assign(http, { request: deny, get: deny }); Object.assign(https, { request: deny, get: deny }); Object.assign(dns, { lookup: deny, resolve: deny }); globalThis.fetch = deny; syncBuiltinESMExports();
class ParseError extends Error { constructor(public code: AttachmentErrorCode, message: string) { super(message); } }
const fail = (code: AttachmentErrorCode, message: string): never => { throw new ParseError(code, message); };
const utf8 = (bytes: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('invalid', 'Document text is not valid UTF-8'); } };
const clipped = (text: string) => ({ text: text.slice(0, L.textCharacters), truncated: text.length > L.textCharacters });
function dimensions(bytes: Buffer, mime: AttachmentMime): { width: number; height: number } {
  let width = 0, height = 0;
  if (mime === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('invalid', 'Invalid PNG signature');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let pos = 8, ended = false, count = 0;
    while (pos < bytes.length) { if (++count > 10_000 || pos + 12 > bytes.length) fail('invalid', 'Malformed PNG chunks'); const size = bytes.readUInt32BE(pos); if (size > bytes.length - pos - 12) fail('invalid', 'Truncated PNG chunk'); const type = bytes.toString('ascii', pos + 4, pos + 8); if (crc32(bytes.subarray(pos + 4, pos + 8 + size)) !== bytes.readUInt32BE(pos + 8 + size)) fail('invalid', 'PNG checksum failed'); pos += size + 12; if (type === 'IEND') { ended = true; break; } }
    if (!ended || pos !== bytes.length) fail('invalid', 'Invalid PNG end');
  } else if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) fail('invalid', 'Invalid JPEG signature');
    let pos = 2;
    while (pos + 3 < bytes.length) { if (bytes[pos++] !== 255) fail('invalid', 'Malformed JPEG marker'); while (bytes[pos] === 255) pos++; const marker = bytes[pos++]; if (marker === 218 || marker === 217) break; if (marker === 1 || marker >= 208 && marker <= 215) continue; if (pos + 2 > bytes.length) break; const size = bytes.readUInt16BE(pos); if (size < 2 || pos + size > bytes.length) fail('invalid', 'Truncated JPEG segment'); if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { if (size < 8) fail('invalid', 'Malformed JPEG dimensions'); height = bytes.readUInt16BE(pos + 3); width = bytes.readUInt16BE(pos + 5); break; } pos += size; }
  } else {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) fail('invalid', 'Invalid WebP signature');
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { if (bytes[20] & 2) fail('unsupported', 'Animated WebP is not supported'); width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    else if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else fail('invalid', 'Malformed WebP dimensions');
  }
  if (!width || !height) fail('invalid', 'Raster dimensions are missing');
  if (width > L.dimension || height > L.dimension || width * height > L.pixels) fail('limit', 'Image exceeds dimension or decoded pixel limit');
  return { width, height };
}
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
async function raster(bytes: Buffer, mime: AttachmentMime): Promise<AttachmentParseResult> {
  const header = dimensions(bytes, mime);
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  // Buffer only: loadImage's path/URL variants are deliberately inaccessible to callers.
  const image = await loadImage(bytes);
  if (!image.width || !image.height || image.width * image.height !== header.width * header.height || image.width > L.dimension || image.height > L.dimension) fail('invalid', 'Decoded image dimensions do not match');
  const canvas = createCanvas(image.width, image.height); const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); context.getImageData(0, 0, 1, 1);
  return { parser: '@napi-rs/canvas', version: '1.0.13', width: image.width, height: image.height, truncated: false, warnings: [] };
}
/** JSZip and yauzl must see exactly the same records; ZIP64/multipart archives are unsupported. */
function exactZipDirectory(bytes: Buffer): void {
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 22 - 65535); pos--) if (bytes.readUInt32LE(pos) === 0x06054b50 && pos + 22 + bytes.readUInt16LE(pos + 20) === bytes.length) { end = pos; break; }
  if (end < 0) fail('invalid', 'DOCX ZIP end directory is missing');
  if (bytes.lastIndexOf(Buffer.from([80,75,5,6])) !== end) fail('invalid', 'DOCX ZIP contains a shadow end directory');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || size === 0xffffffff || start === 0xffffffff) fail('unsupported', 'ZIP64 and multipart DOCX are not supported');
  if (count > L.zipEntries || start + size !== end || start < 0 || start > end) fail('invalid', 'DOCX ZIP central directory extent does not match');
  let pos = start;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) fail('invalid', 'DOCX ZIP central directory count does not match');
    const names = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32), next = pos + 46 + names + extra + comment;
    if (next > end || bytes.readUInt16LE(pos + 34) || bytes.readUInt32LE(pos + 20) === 0xffffffff || bytes.readUInt32LE(pos + 24) === 0xffffffff || bytes.readUInt32LE(pos + 42) >= start) fail('invalid', 'DOCX ZIP central directory entry is invalid');
    const name = bytes.subarray(pos + 46, pos + 46 + names); if (!name.length || name.some(byte => byte > 127)) fail('unsupported', 'DOCX ZIP requires unambiguous ASCII entry paths');
    for (let field = pos + 46 + names; field < pos + 46 + names + extra;) { if (field + 4 > next) fail('invalid', 'Invalid DOCX ZIP extra field'); const type = bytes.readUInt16LE(field), length = bytes.readUInt16LE(field + 2); field += 4 + length; if (field > pos + 46 + names + extra || type === 1 || type === 0x7075) fail('unsupported', 'ZIP64 and alternate DOCX ZIP entry paths are not supported'); }
    pos = next;
  }
  if (pos !== end) fail('invalid', 'DOCX ZIP contains hidden central directory records');
}
async function docx(bytes: Buffer): Promise<AttachmentParseResult> {
  exactZipDirectory(bytes);
  if (bytes.readUInt32LE(0) !== 0x04034b50) fail('invalid', 'Invalid DOCX ZIP signature');
  const yauzl = await import('yauzl'); const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  const { DOMParser } = await import('@xmldom/xmldom');
  const seen = new Set<string>(); let claimed = 0, expanded = 0; let contentTypes = false, document = false;
  try {
    if (zip.entryCount > L.zipEntries) fail('limit', 'DOCX has too many ZIP entries');
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (seen.has(name.toLowerCase()) || /(^|\/)[.][.]?(\/|$)|[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.length > 512) fail('invalid', 'Unsafe or duplicate DOCX ZIP path');
      seen.add(name.toLowerCase());
      if (entry.isEncrypted()) fail('encrypted', 'Encrypted DOCX is not supported');
      if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000 || ![0, 8].includes(entry.compressionMethod)) fail('unsupported', 'DOCX ZIP entry type is not supported');
      if (/vba|macro|activex|(^|\/)embeddings\//i.test(name)) fail('unsupported', 'Macros and embedded executables are not supported');
      claimed += entry.uncompressedSize;
      if (claimed > L.zipExpanded || entry.uncompressedSize > L.zipEntry) fail('limit', 'DOCX expanded content exceeds limit');
      const local = await zip.readLocalFileHeaderPromise(entry);
      if (!local.fileName.equals(Buffer.from(name)) || local.compressionMethod !== entry.compressionMethod || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag) fail('invalid', 'DOCX ZIP header mismatch');
      const stream = await zip.openReadStreamPromise(entry); const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) { const part = Buffer.from(chunk); size += part.length; expanded += part.length; if (size > L.zipEntry || expanded > L.zipExpanded || size > entry.uncompressedSize) { stream.destroy(); fail('limit', 'DOCX actual expanded bytes exceed limit'); } chunks.push(part); }
      const value = Buffer.concat(chunks, size);
      if (size !== entry.uncompressedSize || crc32(value) !== entry.crc32) fail('invalid', 'DOCX ZIP integrity check failed');
      if (/\.xml$|\.rels$/i.test(name)) {
        const xml = utf8(value);
        if (/<!DOCTYPE|<!ENTITY|\x00/i.test(xml)) fail('unsupported', 'DOCX entity declarations are not supported');
        let malformed = false; const parsed = new DOMParser({ errorHandler() { malformed = true; } }).parseFromString(xml, 'application/xml');
        if (malformed || !parsed.documentElement || parsed.doctype) fail('invalid', 'Malformed DOCX XML');
        const root = parsed.documentElement;
        const elements = parsed.getElementsByTagName('*');
        for (let index = 0; index < elements.length; index++) {
          const element = elements.item(index)!;
          if (element.hasAttribute('TargetMode') && element.getAttribute('TargetMode') !== 'Internal') fail('unsupported', 'DOCX external relationships are not supported');
          for (let attribute = 0; attribute < element.attributes.length; attribute++) if (/macroEnabled|vbaProject/i.test(element.attributes.item(attribute)!.value)) fail('unsupported', 'Macro DOCX content types are not supported');
        }
        if (name === '[Content_Types].xml') {
          if (root.localName !== 'Types' || root.namespaceURI !== 'http://schemas.openxmlformats.org/package/2006/content-types') fail('invalid', 'Invalid DOCX content types root');
          const overrides = root.getElementsByTagNameNS(root.namespaceURI, 'Override'); let matches = 0;
          for (let index = 0; index < overrides.length; index++) { const item = overrides.item(index)!; if (item.getAttribute('PartName') === '/word/document.xml') { matches++; if (item.getAttribute('ContentType') !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') fail('invalid', 'DOCX main content type does not match'); } }
          contentTypes = matches === 1;
        }
        if (name === 'word/document.xml') document = root.localName === 'document' && root.namespaceURI === 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
        if (/\.rels$/i.test(name) && (root.localName !== 'Relationships' || root.namespaceURI !== 'http://schemas.openxmlformats.org/package/2006/relationships')) fail('invalid', 'Invalid DOCX relationships root');
        // Pinned Mammoth selects these XML parts by relationships, not filename extension.
        // Keep our deliberately supported canonical parts equal to the reader's selected inputs.
        const relatedRoots: Record<string,string> = { 'word/comments.xml': 'comments', 'word/endnotes.xml': 'endnotes', 'word/footnotes.xml': 'footnotes', 'word/numbering.xml': 'numbering', 'word/styles.xml': 'styles' };
        const relatedRoot = relatedRoots[name];
        if (relatedRoot && (root.localName !== relatedRoot || root.namespaceURI !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')) fail('invalid', 'Invalid DOCX related XML part root');
        if (name === '_rels/.rels' || name === 'word/_rels/document.xml.rels') {
          const relationships = root.getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/relationships','Relationship');
          const typeBase = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
          for (let index = 0; index < relationships.length; index++) {
            const relationship = relationships.item(index)!; const type = relationship.getAttribute('Type');
            let expected: string | undefined;
            if (name === '_rels/.rels' && type === typeBase + 'officeDocument') expected = 'word/document.xml';
            if (name === 'word/_rels/document.xml.rels') for (const part of ['comments','endnotes','footnotes','numbering','styles']) if (type === typeBase + part) expected = 'word/' + part + '.xml';
            if (!expected) continue;
            const target = relationship.getAttribute('Target');
            // Match Mammoth joinPath/stripPrefix exactly for this constrained target set.
            const selected = target?.startsWith('/') ? target.slice(1) : (name === '_rels/.rels' ? '' : 'word/') + (target ?? '');
            if (selected !== expected) fail('unsupported', 'DOCX alternative XML part target is not supported; use canonical document parts');
          }
        }
      }
    }
  } finally { zip.close(); }
  if (!document || !contentTypes) fail('invalid', 'ZIP is not a supported OOXML DOCX document');
  const { default: mammoth } = await import('mammoth'); const result = await mammoth.extractRawText({ buffer: bytes });
  if (!result.value.trim()) fail('scanned', 'Document has no extractable text; OCR is unavailable');
  return { ...clipped(result.value), parser: 'mammoth', version: '1.13.0', warnings: result.messages.length ? ['Document parser reported unsupported document features'] : [] };
}
async function pdf(bytes: Buffer): Promise<AttachmentParseResult> {
  if (!/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(bytes.toString('ascii', 0, 8))) fail('invalid', 'Invalid PDF signature');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useSystemFonts: false, useWasm: false, disableFontFace: true, enableXfa: false, stopAtErrors: true });
  try {
    const doc = await task.promise;
    if (doc.numPages > L.pdfPages) fail('limit', 'PDF exceeds 100 pages');
    let text = '', truncated = false;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber); const content = await page.getTextContent();
      for (const item of content.items) { if (!('str' in item)) continue; const part = item.str + (item.hasEOL ? '\n' : ' '); const remaining = L.textCharacters - text.length; text += part.slice(0, remaining); if (part.length > remaining) { truncated = true; break; } }
      page.cleanup(); if (truncated) break;
      if (text.length < L.textCharacters) text += '\n'; else if (pageNumber < doc.numPages) { truncated = true; break; }
    }
    if (!text.trim()) fail('scanned', 'PDF has no extractable text; OCR is unavailable');
    return { text, truncated, pages: doc.numPages, parser: 'pdfjs-dist', version: '6.4.299', warnings: [] };
  } catch (error) { if ((error as Error).name === 'PasswordException') fail('encrypted', 'Password-protected PDF is not supported'); throw error; }
  finally { await task.destroy(); }
}
process.once('message', async (message: { bytes: Buffer; mimeType: AttachmentMime }) => {
  try {
    const bytes = Buffer.from(message.bytes); if (!bytes.length || bytes.length > L.bytes) fail('limit', 'Attachment byte limit exceeded');
    let result: AttachmentParseResult | undefined;
    if (message.mimeType.startsWith('image/')) result = await raster(bytes, message.mimeType);
    else if (message.mimeType === 'text/plain') { const text = utf8(bytes); if (/\x00|[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /^\s*(?:<!doctype\s+html|<html[\s>]|<svg[\s>])/i.test(text)) fail('unsupported', 'Binary, HTML and SVG inputs are not supported as text'); result = { ...clipped(text), parser: 'utf8', version: '1', warnings: [] }; }
    else if (message.mimeType === 'application/pdf') result = await pdf(bytes);
    else if (message.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') result = await docx(bytes);
    else fail('unsupported', 'Attachment MIME type is not supported');
    if (!result) fail('unsupported', 'Unsupported attachment type'); process.send?.({ ok: true, result });
  } catch (error) { const known = error instanceof ParseError; process.send?.({ ok: false, code: known ? error.code : 'invalid', error: known ? error.message : 'Malformed or unsupported attachment content' }); }
});
