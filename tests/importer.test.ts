import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import type { App } from 'obsidian';
import { IMPORT_LIMITS, importGoodnotesFiles, preflightZip, sanitizeImportPath } from '../src/importer';

const pdf = strToU8('%PDF-1.7\nA test PDF header');
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function file(name: string, bytes: Uint8Array): File { return new File([bytes.slice().buffer as ArrayBuffer], name); }
function vault() {
  const files = new Map<string, Uint8Array | string>();
  const folders = new Set<string>();
  const exists = async (path: string) => files.has(path) || folders.has(path);
  const app = { vault: { adapter: { exists }, createFolder: async (path: string) => { if (files.has(path)) throw new Error('A file occupies this folder.'); folders.add(path); }, createBinary: async (path: string, bytes: ArrayBuffer) => { if (await exists(path)) throw new Error('File exists.'); files.set(path, new Uint8Array(bytes)); return { path }; }, create: async (path: string, text: string) => { if (await exists(path)) throw new Error('File exists.'); files.set(path, text); return { path }; } } } as unknown as App;
  return { app, files, folders };
}

test('import paths preserve folder hierarchy while rejecting traversal and absolute paths', () => {
  assert.equal(sanitizeImportPath('Medical lectures/Biochemistry.pdf'), 'Medical lectures/Biochemistry.pdf');
  assert.equal(sanitizeImportPath('Medical lectures\\Lecture 1.pdf'), 'Medical lectures/Lecture 1.pdf');
  assert.equal(sanitizeImportPath('Notes: final?.pdf'), 'Notes- final-.pdf');
  for (const path of ['../outside.pdf', 'inside/../../outside.pdf', '/outside.pdf', '\\server\file.pdf', 'C:\\outside.pdf', 'C:outside.pdf', 'safe/./file.pdf', 'a\0b.pdf', 'safe//file.pdf', 'NUL.pdf', 'safe/CON/data.pdf']) assert.equal(sanitizeImportPath(path), null, path);
});

test('ZIP preflight accepts standard nested exports and rejects malformed, encrypted, huge, and unsafe archives', () => {
  const valid = zipSync({ 'Course/Week 1.pdf': pdf, 'Course/diagram.png': png });
  const entries = preflightZip(valid);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'Course/Week 1.pdf');
  assert.equal(entries[0].size, pdf.length);
  assert.throws(() => preflightZip(zipSync({ '../escape.pdf': pdf })), /Unsafe ZIP path/);
  assert.throws(() => preflightZip(new Uint8Array(30)), /not a supported ZIP/);
  const encrypted = valid.slice();
  const encryptedView = new DataView(encrypted.buffer);
  const footer = encrypted.length - 22;
  const central = encryptedView.getUint32(footer + 16, true);
  encryptedView.setUint16(central + 8, 1, true);
  assert.throws(() => preflightZip(encrypted), /Password-protected/);
  const tooLarge = valid.slice();
  new DataView(tooLarge.buffer).setUint32(central + 24, IMPORT_LIMITS.fileBytes + 1, true);
  assert.throws(() => preflightZip(tooLarge), /exceeds 150 MB/);
  const bomb = valid.slice();
  new DataView(bomb.buffer).setUint32(central + 24, 2 * 1024 * 1024, true);
  assert.throws(() => preflightZip(bomb), /compression ratio/);
});

test('Goodnotes ZIP import preserves nested PDFs/images, reports proprietary files, and writes an index', async () => {
  const { app, files, folders } = vault();
  const archive = zipSync({ 'Medicine/Lecture.pdf': pdf, 'Medicine/diagram.png': png, 'Medicine/Source.goodnotes': strToU8('proprietary'), '__MACOSX/metadata': strToU8('ignore') });
  const result = await importGoodnotesFiles(app, [file('Semester.zip', archive)]);
  assert.deepEqual(result.imported, ['Goodnotes Imports/Semester/Medicine/Lecture.pdf', 'Goodnotes Imports/Semester/Medicine/diagram.png', 'Goodnotes Imports/Import index.md']);
  assert.ok(folders.has('Goodnotes Imports/Semester/Medicine'));
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /Source.goodnotes.*export as PDF/);
  assert.deepEqual(files.get(result.imported[0]), pdf);
  assert.match(files.get(result.imported[2]) as string, /\[\[Goodnotes Imports\/Semester\/Medicine\/Lecture.pdf\]\]/);
});

test('repeated imports never overwrite originals and reject corrupt PDF contents with actionable reports', async () => {
  const { app, files } = vault();
  await importGoodnotesFiles(app, [file('Lecture.pdf', pdf)]);
  const result = await importGoodnotesFiles(app, [file('Lecture.pdf', pdf), file('Broken.pdf', strToU8('not a pdf')), file('Source.goodnotes', png)]);
  assert.equal(files.size, 4);
  assert.ok(files.has('Goodnotes Imports/Lecture.pdf'));
  assert.ok(files.has('Goodnotes Imports/Lecture (2).pdf'));
  assert.ok(files.has('Goodnotes Imports/Import index (2).md'));
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0], /PDF header/);
  assert.match(result.skipped[1], /proprietary/);
});

test('an unsafe archive fails before any of its content can be written outside the import folder', async () => {
  const { app, files } = vault();
  const result = await importGoodnotesFiles(app, [file('Unsafe.zip', zipSync({ 'Good.pdf': pdf, '../Elsewhere.pdf': pdf }))]);
  assert.equal(result.imported.length, 0);
  assert.equal(files.size, 0);
  assert.match(result.skipped[0], /Unsafe ZIP path/);
});

test('ZIP checksum corruption is reported and damaged files are never written', async () => {
  const { app, files } = vault();
  const archive = zipSync({ 'Lecture.pdf': pdf });
  const view = new DataView(archive.buffer);
  const central = view.getUint32(archive.length - 22 + 16, true);
  view.setUint32(central + 16, 0, true);
  const result = await importGoodnotesFiles(app, [file('Corrupted.zip', archive)]);
  assert.equal(result.imported.length, 0);
  assert.equal(files.size, 0);
  assert.match(result.skipped[0], /checksum failed/);
});
