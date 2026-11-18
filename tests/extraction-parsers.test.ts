import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { AttachmentExtractor } from '../server/attachment-extraction.js';
import { ATTACHMENT_LIMITS } from '../shared/attachments.js';
import { crc32, zip, docx, pdf, png, DOCX_MIME, relatedDocx, type DocxReaderPart } from './fixtures/attachment-inputs.js';
const parse = async (bytes: Buffer, mime: Parameters<AttachmentExtractor['parse']>[1]) => { const parser = new AttachmentExtractor(); try { return await parser.parse(bytes, mime); } finally { await parser.close(); } };
test('actual TXT/PDF/DOCX parsers return bounded text and immutable parser provenance', async () => {
 const txt = await parse(Buffer.from('actual UTF-8 café'), 'text/plain'); assert.equal(txt.text, 'actual UTF-8 café');
 const document = await parse(docx(), DOCX_MIME); assert.match(document.text!, /Actual DOCX source text/); assert.equal(document.version, '1.13.0');
 const parsed = await parse(pdf(), 'application/pdf'); assert.match(parsed.text!, /Actual PDF source text/); assert.equal(parsed.pages, 1); assert.equal(parsed.version, '6.4.299');
});
test('actual raster decoder validates PNG JPEG WebP and rejects corrupt bytes/pixel bombs', async () => {
 const canvas = createCanvas(2, 3); for (const [mime, bytes] of [['image/png', canvas.toBuffer('image/png')], ['image/jpeg', canvas.toBuffer('image/jpeg')], ['image/webp', canvas.toBuffer('image/webp')]] as const) { const result = await parse(bytes, mime); assert.equal(result.width, 2); assert.equal(result.height, 3); }
 const corrupt = png(); corrupt[corrupt.length - 5] ^= 1; await assert.rejects(parse(corrupt, 'image/png'), /checksum/);
 const bomb = png(); bomb.writeUInt32BE(100_000, 16); bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29); await assert.rejects(parse(bomb, 'image/png'), /pixel limit/);
 await assert.rejects(parse(Buffer.from([255,216,255,217]), 'image/jpeg'), /Malformed|dimensions/);
});
test('PDF scanned, password, page cap and malformed errors are honest', async () => {
 await assert.rejects(parse(pdf('', {empty:true}), 'application/pdf'), /OCR/);
 await assert.rejects(parse(pdf('', {encrypted:true}), 'application/pdf'), /Password/);
 await assert.rejects(parse(pdf('text', {pages:101}), 'application/pdf'), /100 pages/);
 await assert.rejects(parse(Buffer.from('%PDF-1.4 garbage'), 'application/pdf'), /Malformed/);
});
test('DOCX validates actual expanded bytes, claimed sizes, duplicates, paths, symlinks, encryption and active content', async () => {
 for (const bytes of [zip([['../bad','x']]), zip([['x','a'], ['x','b']]), zip([['x','a']], {symlink:true}), zip([['x','a']], {encrypted:true}), zip([['x',Buffer.alloc(8*1024*1024+1)]]), zip([['x',Buffer.alloc(1024)]], {claimed:1}), docx('text', [['word/vbaProject.bin','macro']]), docx('text', [['word/_rels/document.xml.rels','<Relationships><Relationship TargetMode="External" Target="file:///private"/></Relationships>']])]) await assert.rejects(parse(bytes, DOCX_MIME));
 await assert.rejects(parse(zip([['word/document.xml','no content types']]), DOCX_MIME));
});
test('output cap, UTF8, HTML/SVG and bounded child deadline/close are enforced', async () => {
 const txt = await parse(Buffer.from('x'.repeat(100_000)), 'text/plain'); assert.equal(txt.text!.length, ATTACHMENT_LIMITS.textCharacters); assert.equal(txt.truncated, true);
 for (const text of [Buffer.from([0xff]), Buffer.from('<svg></svg>'), Buffer.from('<!DOCTYPE html>')]) await assert.rejects(parse(text, 'text/plain'));
 const deadline = new AttachmentExtractor(1); await assert.rejects(deadline.parse(docx(), DOCX_MIME), /time limit/); await deadline.close(); assert.equal(deadline.count(), 0);
 const parser = new AttachmentExtractor(); const pending = parser.parse(pdf(), 'application/pdf'); const rejected = assert.rejects(pending, /canceled/); await parser.close(); await rejected; assert.equal(parser.count(), 0); await assert.rejects(parser.parse(Buffer.from('x'), 'text/plain'), /closed/);
});

test('DOCX rejects forged smaller counts hiding duplicate main XML, relationships or inflated entries before Mammoth', async () => {
 for (const extra of [['word/document.xml','<w:document>hidden duplicate</w:document>'], ['word/_rels/document.xml.rels','<Relationships><Relationship TargetMode="External" Target="http://127.0.0.1:1/secret"/></Relationships>'], ['word/hidden.xml',Buffer.alloc(9 * 1024 * 1024)]] as [string, string | Buffer][]) { const bytes = docx('normal', [extra]); const end = bytes.length - 22; bytes.writeUInt16LE(3, end + 8); bytes.writeUInt16LE(3, end + 10); await assert.rejects(parse(bytes, DOCX_MIME), /hidden central directory/); }
});
test('DOCX rejects shadow EOCD signatures inside comments that JSZip otherwise selects differently', async () => {
 const original = docx(); const shadow = Buffer.alloc(22); shadow.writeUInt32LE(0x06054b50); shadow.writeUInt16LE(1,20); original.writeUInt16LE(shadow.length,original.length-2); const bytes = Buffer.concat([original,shadow]); await assert.rejects(parse(bytes,DOCX_MIME), /shadow end directory/);
});
test('supplied PDF actions and rejected DOCX external references cause no network fetch', async () => {
 const { createServer } = await import('node:http'); let requests = 0; const server = createServer((_request,response) => { requests++; response.end('should never be requested'); }); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
 try { const port = (server.address() as {port:number}).port; const uri = 'http://127.0.0.1:' + port + '/external'; const parsed = await parse(pdf('safe local text',{uri}), 'application/pdf'); assert.match(parsed.text!,/safe local text/); await assert.rejects(parse(docx('text',[['word/_rels/document.xml.rels','<Relationships><Relationship TargetMode="External" Target="'+uri+'"/></Relationships>']]), DOCX_MIME), /external relationships/); assert.equal(requests,0); }
 finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('strict OOXML validation rejects comments masquerading as content types, namespace spoofing, malformed XML and encoded external targets', async () => {
 const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
 const main = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>real text</w:t></w:r></w:p></w:body></w:document>';
 for (const entries of [ [['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><!--'+types+'--></Types>'],['word/document.xml',main]], [['[Content_Types].xml',types],['word/document.xml',main.replace('http://schemas.openxmlformats.org/wordprocessingml/2006/main','urn:spoof')]], [['[Content_Types].xml',types],['word/document.xml',main.replace('</w:body>','')]] ] as [string,string][][]) await assert.rejects(parse(zip(entries),DOCX_MIME));
 await assert.rejects(parse(docx('text',[['word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship TargetMode="Exter&#110;al" Target="file:///private"/></Relationships>']]),DOCX_MIME),/external relationships/);
 const clippedDocx = await parse(docx('x'.repeat(100_000)),DOCX_MIME); assert.equal(clippedDocx.text!.length,80_000); assert.equal(clippedDocx.truncated,true);
 const clippedPdf = await parse(pdf('x'.repeat(100_000),{width:1_000_000}),'application/pdf'); assert.equal(clippedPdf.text!.length,80_000); assert.equal(clippedPdf.truncated,true);
});

for (const part of ['mainDocument','comments','endnotes','footnotes','numbering','styles'] as DocxReaderPart[]) {
 test('DOCX rejects unsupported relationship-selected '+part+' XML targets regardless of extension or XML validity', async () => {
   const alternative = part === 'mainDocument' ? 'word/selected-part.bin' : 'selected-part.bin';
   await assert.rejects(parse(relatedDocx(part,alternative),DOCX_MIME), /alternative XML part target/);
   await assert.rejects(parse(relatedDocx(part,alternative,'<unexpected xmlns="urn:wrong-root"/>'),DOCX_MIME), /alternative XML part target/);
 });
}
test('DOCX accepts the canonical main and all reader-selected related XML parts, including absolute canonical targets', async () => {
 for (const part of ['mainDocument','comments','endnotes','footnotes','numbering','styles'] as DocxReaderPart[]) {
   const relative = await parse(relatedDocx(part),DOCX_MIME); assert.match(relative.text!, /document text/);
   const absolute = await parse(relatedDocx(part,part === 'mainDocument' ? '/word/document.xml' : '/word/'+part+'.xml'),DOCX_MIME); assert.match(absolute.text!, /document text/);
 }
});
test('DOCX rejects wrong roots or namespaces in canonical reader-selected related XML parts', async () => {
 for (const part of ['comments','endnotes','footnotes','numbering','styles'] as DocxReaderPart[]) await assert.rejects(parse(relatedDocx(part,undefined,'<unexpected xmlns="urn:wrong-root"/>'),DOCX_MIME), /Invalid DOCX related XML part root/);
});
