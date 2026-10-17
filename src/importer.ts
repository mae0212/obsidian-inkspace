import type { App } from 'obsidian';
import { strFromU8, unzip } from 'fflate';

export const IMPORT_LIMITS = { archiveBytes: 250 * 1024 * 1024, fileBytes: 150 * 1024 * 1024, expandedBytes: 500 * 1024 * 1024, entries: 1500, ratio: 300 };
export interface ZipEntry { archivePath: string; path: string; size: number; compressedSize: number; directory: boolean; crc: number }
const supported = /\.(pdf|png|jpe?g|webp|gif)$/i;

/** ZIP names are untrusted; never let a filename escape the chosen import folder. */
export function sanitizeImportPath(input: string): string | null {
  if (!input || /[\x00-\x1f\x7f]/.test(input) || /^[\\/]|^[a-z]:/i.test(input)) return null;
  const segments = input.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  const result = segments.map(segment => segment.replace(/[<>:"|?*\[\]#^]/g, '-').replace(/[. ]+$/g, '').trim()).join('/');
  if (!result || result.split('/').some(segment => !segment || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment))) return null;
  return result;
}

/** Read the ZIP central directory before inflating, including sizes that prevent ZIP bombs. */
export function preflightZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > IMPORT_LIMITS.archiveBytes) throw new Error('ZIP exceeds the 250 MB import limit. Export smaller folders.');
  if (bytes.byteLength < 22) throw new Error('The ZIP file is incomplete.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let footer = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { footer = i; break; }
  }
  if (footer < 0) throw new Error('The file is not a supported ZIP archive.');
  const count = view.getUint16(footer + 10, true);
  const centralSize = view.getUint32(footer + 12, true);
  let offset = view.getUint32(footer + 16, true);
  if (view.getUint16(footer + 4, true) || view.getUint16(footer + 6, true) || view.getUint16(footer + 8, true) !== count) throw new Error('Split ZIP archives are unsupported.');
  if (count === 0xffff || offset === 0xffffffff || centralSize === 0xffffffff) throw new Error('ZIP64 archives are unsupported. Export smaller folders.');
  if (count > IMPORT_LIMITS.entries) throw new Error('ZIP contains more than 1,500 entries. Export smaller folders.');
  if (offset + centralSize > footer) throw new Error('ZIP directory is damaged.');
  const start = offset, end = offset + centralSize;
  let total = 0;
  const result: ZipEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP directory is damaged.');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true), compressedSize = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true), commentSize = view.getUint16(offset + 32, true);
    const attributes = view.getUint32(offset + 38, true), localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || localOffset >= offset || size === 0xffffffff || compressedSize === 0xffffffff) throw new Error('ZIP entry is damaged or uses ZIP64.');
    const archivePath = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameSize), !(flags & 0x800));
    const path = sanitizeImportPath(archivePath);
    if (!path) throw new Error(`Unsafe ZIP path rejected: ${archivePath.slice(0, 100)}`);
    if (flags & 1) throw new Error('Password-protected ZIP archives are unsupported.');
    if (localOffset + 30 > start || view.getUint32(localOffset, true) !== 0x04034b50 || view.getUint16(localOffset + 8, true) !== method || view.getUint16(localOffset + 6, true) & 1) throw new Error('ZIP local entry header is damaged.');
    const localNameSize = view.getUint16(localOffset + 26, true), localExtraSize = view.getUint16(localOffset + 28, true);
    if (localOffset + 30 + localNameSize + localExtraSize + compressedSize > start) throw new Error('ZIP entry extends beyond the file data.');
    if (strFromU8(bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize), !(flags & 0x800)) !== archivePath) throw new Error('ZIP local filename does not match its directory.');
    if (method !== 0 && method !== 8) throw new Error('ZIP uses unsupported compression. Export a standard ZIP.');
    if ((attributes >>> 16 & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are unsupported.');
    if (size > IMPORT_LIMITS.fileBytes) throw new Error(`ZIP entry exceeds 150 MB: ${path}`);
    if (size > 1024 * 1024 && size / Math.max(1, compressedSize) > IMPORT_LIMITS.ratio) throw new Error(`ZIP entry has an unsafe compression ratio: ${path}`);
    total += size;
    if (total > IMPORT_LIMITS.expandedBytes) throw new Error('ZIP expands beyond 500 MB. Export smaller folders.');
    if (seen.has(archivePath)) throw new Error(`Duplicate ZIP entry: ${path}`);
    seen.add(archivePath);
    result.push({ archivePath, path, size, compressedSize, directory: /[\\/]$/.test(archivePath), crc });
    offset = next;
  }
  if (offset !== end) throw new Error('ZIP directory has unsupported extra records.');
  return result;
}

export async function importGoodnotesFiles(app: App, files: File[], destination = 'Goodnotes Imports'): Promise<{ imported: string[]; skipped: string[] }> {
  const safeDestination = sanitizeImportPath(destination);
  if (!safeDestination) throw new Error('Choose a relative vault folder for imports.');
  const imported: string[] = [], skipped: string[] = [];
  await ensureFolder(app, safeDestination);
  for (const file of files) {
    try {
      if (/\.goodnotes$/i.test(file.name)) { skipped.push(`${file.name}: export this document as a PDF from Goodnotes first; proprietary .goodnotes editing is unsupported.`); continue; }
      if (file.size > IMPORT_LIMITS.archiveBytes) throw new Error('File exceeds 250 MB. Export a smaller document or folder.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.zip$/i.test(file.name)) {
        const entries = preflightZip(bytes);
        const allowed = new Map(entries.filter(entry => !entry.directory && supported.test(entry.path) && !entry.path.startsWith('__MACOSX/')).map(entry => [entry.archivePath, entry]));
        const expanded = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(bytes, { filter: entry => allowed.has(entry.name) }, (error, data) => error ? reject(error) : resolve(data)));
        const archiveName = sanitizeImportPath(file.name.replace(/\.zip$/i, '')) || 'Imported folder';
        const archiveFolder = await uniqueFolder(app, `${safeDestination}/${archiveName}`);
        for (const entry of entries) {
          if (entry.directory || entry.path.startsWith('__MACOSX/')) continue;
          if (!allowed.has(entry.archivePath)) {
            skipped.push(`${file.name}/${entry.path}: ${/\.goodnotes$/i.test(entry.path) ? 'export as PDF in Goodnotes first' : 'unsupported file type'}.`);
            continue;
          }
          try {
            const content = expanded[entry.archivePath];
            if (!content || content.byteLength !== entry.size) throw new Error('ZIP entry size does not match its directory.');
            if (crc32(content) !== entry.crc) throw new Error('ZIP entry checksum failed. Export this folder again.');
            await importOne(app, `${archiveFolder}/${entry.path}`, content, imported);
          } catch (error) { skipped.push(`${entry.path}: ${message(error)}`); }
        }
      } else {
        if (!supported.test(file.name)) { skipped.push(`${file.name}: choose exported PDF, image, or ZIP files.`); continue; }
        if (bytes.byteLength > IMPORT_LIMITS.fileBytes) throw new Error('Document exceeds the 150 MB import limit.');
        const name = sanitizeImportPath(file.name);
        if (!name) throw new Error('Unsafe filename.');
        await importOne(app, `${safeDestination}/${name}`, bytes, imported);
      }
    } catch (error) { skipped.push(`${file.name}: ${message(error)}`); }
  }
  if (imported.length) {
    const index = await uniquePath(app, `${safeDestination}/Import index.md`);
    const text = '# Goodnotes import\n\nImported PDFs retain their exported Goodnotes appearance. Existing Goodnotes handwriting is part of the PDF; new Inkspace annotations remain editable in Inkspace.\n\n' + imported.map(path => `- [[${path}]]`).join('\n') + (skipped.length ? '\n\n## Items requiring attention\n\n' + skipped.map(item => `- ${item.replace(/[\r\n]/g, ' ')}`).join('\n') : '') + '\n';
    await app.vault.create(index, text);
    imported.push(index);
  }
  return { imported, skipped };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function ensureFolder(app: App, path: string): Promise<void> {
  let current = '';
  for (const segment of path.split('/')) {
    current = current ? `${current}/${segment}` : segment;
    if (!await app.vault.adapter.exists(current)) await app.vault.createFolder(current);
  }
}
async function uniqueFolder(app: App, path: string): Promise<string> {
  let chosen = path;
  for (let index = 2; await app.vault.adapter.exists(chosen); index++) chosen = `${path} (${index})`;
  await ensureFolder(app, chosen);
  return chosen;
}
async function uniquePath(app: App, path: string): Promise<string> {
  const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
  const base = dot > slash ? path.slice(0, dot) : path, extension = dot > slash ? path.slice(dot) : '';
  let chosen = path;
  for (let index = 2; await app.vault.adapter.exists(chosen); index++) chosen = `${base} (${index})${extension}`;
  return chosen;
}
async function importOne(app: App, path: string, bytes: Uint8Array, imported: string[]): Promise<void> {
  if (/\.pdf$/i.test(path) && !new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('The file does not contain a PDF header.');
  if (/\.png$/i.test(path) && ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error('The file does not contain a PNG image.');
  if (/\.jpe?g$/i.test(path) && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw new Error('The file does not contain a JPEG image.');
  if (/\.gif$/i.test(path) && !/^GIF8[79]a$/.test(strFromU8(bytes.subarray(0, 6)))) throw new Error('The file does not contain a GIF image.');
  if (/\.webp$/i.test(path) && !(strFromU8(bytes.subarray(0, 4)) === 'RIFF' && strFromU8(bytes.subarray(8, 12)) === 'WEBP')) throw new Error('The file does not contain a WebP image.');
  const parent = path.slice(0, path.lastIndexOf('/'));
  await ensureFolder(app, parent);
  const target = await uniquePath(app, path);
  // Slice avoids sharing ZIP buffers with vault adapters on mobile.
  await app.vault.createBinary(target, bytes.slice().buffer as ArrayBuffer);
  imported.push(target);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
