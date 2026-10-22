import zlib from 'node:zlib';

/**
 * Minimal .xlsx reader/writer (Office Open XML), enough for the "Resposta Rápida" spreadsheet:
 * cell values only (cached results of formulas), no styles. No third-party dependency.
 */

export type CellValue = string | number | boolean | null;
export interface Sheet {
  name: string;
  /** rows[rowNumber][columnIndex0] */
  rows: Map<number, Map<number, CellValue>>;
}
export interface Workbook {
  sheets: Sheet[];
  date1904: boolean;
}

const MAX_ENTRY = 60 * 1024 * 1024;
const MAX_TOTAL = 120 * 1024 * 1024;

export class XlsxError extends Error {}

function readZip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('O arquivo não é um Excel (.xlsx) válido.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, () => Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new XlsxError('Arquivo Excel corrompido.');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('Arquivo Excel corrompido.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      let out: Buffer;
      if (method === 0) out = Buffer.from(data);
      else if (method === 8) {
        try {
          out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
        } catch {
          throw new XlsxError('Arquivo Excel corrompido ou grande demais.');
        }
      } else throw new XlsxError('Compactação do arquivo Excel não suportada.');
      total += out.length;
      if (total > MAX_TOTAL) throw new XlsxError('Arquivo Excel grande demais.');
      return out;
    });
  }
  return entries;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e]);
}
export const escapeXml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    // characters not allowed in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/** Text of a shared/inline string (rich text runs concatenated, phonetic hints dropped). */
function richText(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
}

export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function readXlsx(buf: Buffer): Workbook {
  try {
    return parseWorkbook(buf);
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError('Não foi possível ler o arquivo Excel (arquivo corrompido ou protegido por senha).');
  }
}

function parseWorkbook(buf: Buffer): Workbook {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('O arquivo não é um Excel (.xlsx). Salve a planilha no formato .xlsx e tente de novo.');
  const zip = readZip(buf);
  const text = (name: string) => zip.get(name)?.().toString('utf8');
  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new XlsxError('O arquivo não é uma planilha do Excel.');
  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
  }
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1]));
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wbXml);

  const sheets: Sheet[] = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const path = rels.get(a['r:id']);
    const xml = path ? text(path) : undefined;
    if (!xml) continue;
    const rows = new Map<number, Map<number, CellValue>>();
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!rm[2]) continue;
      const r = Number(attrs(rm[1]).r);
      const cells = new Map<number, CellValue>();
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (!cm[2]) continue;
        const ca = attrs(cm[1]);
        const v = /<v>([\s\S]*?)<\/v>/.exec(cm[2])?.[1];
        let value: CellValue = null;
        switch (ca.t) {
          case 's': value = v == null ? null : (shared[Number(v)] ?? null); break;
          case 'inlineStr': value = richText(cm[2]); break;
          case 'str': value = v == null ? null : unescapeXml(v); break;
          case 'b': value = v === '1'; break;
          case 'e': value = null; break;
          default: value = v == null || v === '' ? null : Number(v);
        }
        if (value !== null && value !== '') cells.set(colIndex(ca.r), value);
      }
      if (cells.size) rows.set(r, cells);
    }
    sheets.push({ name: a.name, rows });
  }
  return { sheets, date1904 };
}

/** Excel serial date → YYYY-MM-DD. */
export function serialToDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.floor(serial) * 86_400_000);
  const y = d.getUTCFullYear();
  return y < 1990 || y > 2100 ? null : d.toISOString().slice(0, 10);
}
export function dateToSerial(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// ---------------------------------------------------------------------------- writer

export interface OutCell {
  v: string | number | null;
  /** 0 normal, 1 date, 2 header, 3 title, 4 wrapped text */
  s?: number;
}
export interface OutSheet {
  name: string;
  rows: (OutCell | null)[][];
  widths?: number[];
  freezeRow?: number;
  autoFilterRow?: number;
  merges?: string[];
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="3"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEA6A1F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(s: OutSheet): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  if (s.freezeRow) out.push(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="${s.freezeRow}" topLeftCell="A${s.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`);
  if (s.widths?.length) out.push(`<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`);
  out.push('<sheetData>');
  s.rows.forEach((row, ri) => {
    const r = ri + 1;
    const cells = row.map((c, ci) => {
      if (!c || c.v === null || c.v === '') return c?.s ? `<c r="${colName(ci)}${r}" s="${c.s}"/>` : '';
      const ref = `${colName(ci)}${r}`;
      const style = c.s ? ` s="${c.s}"` : '';
      return typeof c.v === 'number'
        ? `<c r="${ref}"${style}><v>${c.v}</v></c>`
        : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.v)}</t></is></c>`;
    }).join('');
    out.push(`<row r="${r}">${cells}</row>`);
  });
  out.push('</sheetData>');
  if (s.autoFilterRow && s.rows[s.autoFilterRow - 1]) out.push(`<autoFilter ref="A${s.autoFilterRow}:${colName(s.rows[s.autoFilterRow - 1].length - 1)}${Math.max(s.autoFilterRow, s.rows.length)}"/>`);
  if (s.merges?.length) out.push(`<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
  out.push('</worksheet>');
  return out.join('');
}

export function writeXlsx(sheets: OutSheet[]): Buffer {
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.some((s) => s.autoFilterRow) ? `<definedNames>${sheets.map((s, i) => s.autoFilterRow && s.rows[s.autoFilterRow - 1] ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(s.name.slice(0, 31))}'!$A$${s.autoFilterRow}:$${colName(s.rows[s.autoFilterRow - 1].length - 1)}$${Math.max(s.autoFilterRow, s.rows.length)}</definedName>` : '').join('')}</definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zip(files.map(([n, c]) => [n, Buffer.from(c, 'utf8')]));
}

function zip(files: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(0, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, nameBuf, comp);
    central.push(c, nameBuf);
    offset += h.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
