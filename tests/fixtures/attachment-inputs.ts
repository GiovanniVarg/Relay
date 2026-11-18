import { deflateRawSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
export function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
export function zip(entries: [string, string | Buffer][], tweaks: { claimed?: number; encrypted?: boolean; symlink?: boolean } = {}): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of entries) { const raw = Buffer.isBuffer(value) ? value : Buffer.from(value); const compressed = deflateRawSync(raw); const filename = Buffer.from(name); const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(tweaks.encrypted ? 1 : 0, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(tweaks.claimed ?? raw.length, 22); header.writeUInt16LE(filename.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(3 << 8 | 20, 4); header.copy(dir, 6, 4, 30); dir.writeUInt32LE(tweaks.symlink ? 0xa1ff0000 : 0, 38); dir.writeUInt32LE(offset, 42); central.push(dir, filename); locals.push(header, filename, compressed); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
export function docx(text = 'Actual DOCX source text', extras: [string, string | Buffer][] = []) { return zip([['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'], ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'], ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>'], ...extras]); }
export function pdf(text = 'Actual PDF source text', options: { empty?: boolean; encrypted?: boolean; pages?: number; uri?: string; width?: number } = {}): Buffer {
 const content = options.empty ? '' : 'BT /F1 12 Tf 20 40 Td (' + text + ') Tj ET';
 const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [' + Array.from({length: options.pages ?? 1}, () => '3 0 R').join(' ') + '] /Count ' + (options.pages ?? 1) + ' >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + (options.width ?? 200) + ' 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R ' + (options.uri ? '/Annots [6 0 R]' : '') + ' >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream'];
 if (options.uri) bodies.push('<< /Type /Annot /Subtype /Link /Rect [0 0 100 50] /A << /S /URI /URI (' + options.uri + ') >> >>');
 if (options.encrypted) bodies.push('<< /Filter /Standard /V 1 /R 2 /Length 40 /O <' + '01'.repeat(32) + '> /U <' + '02'.repeat(32) + '> /P -4 >>');
 let output = '%PDF-1.4\n'; const offsets = [0]; for (let index = 0; index < bodies.length; index++) { offsets.push(Buffer.byteLength(output)); output += (index + 1) + ' 0 obj\n' + bodies[index] + '\nendobj\n'; }
 const xref = Buffer.byteLength(output); output += 'xref\n0 ' + (bodies.length + 1) + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (bodies.length + 1) + ' /Root 1 0 R ' + (options.encrypted ? '/Encrypt 6 0 R /ID [<0123456789abcdef><0123456789abcdef>]' : '') + ' >>\nstartxref\n' + xref + '\n%%EOF'; return Buffer.from(output);
}
export function png(): Buffer { const canvas = createCanvas(2, 2); canvas.getContext('2d').fillRect(0, 0, 2, 2); return canvas.toBuffer('image/png'); }
export type DocxReaderPart = 'mainDocument' | 'comments' | 'endnotes' | 'footnotes' | 'numbering' | 'styles';
/** Ordinary OOXML parts exercising the pinned reader's relationship selection. */
export function relatedDocx(part: DocxReaderPart, target?: string, selectedXml?: string): Buffer {
 const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'; const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships'; const typeBase = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
 const main = '<w:document xmlns:w="'+ns+'"><w:body><w:p><w:r><w:t>Canonical document text</w:t></w:r></w:p></w:body></w:document>';
 const mainSelected = part === 'mainDocument'; const root = mainSelected ? 'document' : part;
 const selected = selectedXml ?? (mainSelected ? main.replace('Canonical document text','Selected document text') : '<w:'+root+' xmlns:w="'+ns+'"/>');
 const chosen = target ?? (mainSelected ? 'word/document.xml' : part+'.xml');
 const selectedPath = chosen.startsWith('/') ? chosen.slice(1) : mainSelected ? chosen : 'word/'+chosen;
 const entries: [string,string][] = [ ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'], ['_rels/.rels','<Relationships xmlns="'+relNs+'"><Relationship Id="rId1" Type="'+typeBase+'officeDocument" Target="'+(mainSelected ? chosen : 'word/document.xml')+'"/></Relationships>'] ];
 if (!mainSelected) entries.push(['word/_rels/document.xml.rels','<Relationships xmlns="'+relNs+'"><Relationship Id="rId2" Type="'+typeBase+part+'" Target="'+chosen+'"/></Relationships>']);
 entries.push(['word/document.xml',main]); if (selectedPath === 'word/document.xml') entries[entries.length-1][1] = selected; else entries.push([selectedPath,selected]);
 return zip(entries);
}
