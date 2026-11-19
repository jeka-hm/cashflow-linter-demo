/* =====================================================================
   Мінімальний запис .xlsx (без бібліотек і CDN) та .csv.
   xlsx = zip (без стиснення) з XML аркушів; рядки — inline strings.
   sheets: [{ name, rows: [[…], …], widths: [12, 40, …], money: [3] }]
   Перший рядок кожного аркуша — заголовок (жирний, закріплений, з фільтром).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFXlsx = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const utf8 = s => new TextEncoder().encode(s);
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = utf8(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, x) => s + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
    let p = 0;
    for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }

  const xmlEsc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  const safeSheetName = (n, used) => {
    let s = String(n).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || 'Аркуш';
    let k = 2, base = s;
    while (used.has(s)) s = (base.slice(0, 28) + ' ' + k++);
    used.add(s);
    return s;
  };

  function sheetXml(sh) {
    const rows = sh.rows || [], money = new Set(sh.money || []);
    const nCols = Math.max(1, ...rows.map(r => r.length));
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    if (sh.widths && sh.widths.length) x += '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    x += '<sheetData>';
    rows.forEach((row, ri) => {
      x += `<row r="${ri + 1}">`;
      row.forEach((v, ci) => {
        if (v === null || v === undefined || v === '') return;
        const ref = colName(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) {
          const s = ri === 0 ? 1 : money.has(ci) ? 2 : 0;
          x += `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
        } else {
          let t = String(v);
          if (t.length > 32000) t = t.slice(0, 32000) + '…';
          x += `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(t)}</t></is></c>`;
        }
      });
      x += '</row>';
    });
    x += '</sheetData>';
    if (rows.length > 1) x += `<autoFilter ref="A1:${colName(nCols - 1)}${rows.length}"/>`;
    return x + '</worksheet>';
  }

  function buildXlsx(sheets) {
    const used = new Set();
    const names = sheets.map(s => safeSheetName(s.name, used));
    const files = [];
    files.push({ name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      // фільтр аркуша — через визначене ім'я _xlnm._FilterDatabase (інакше Excel інколи «лагодить» файл)
      '<definedNames>' + sheets.map((s, i) => (s.rows && s.rows.length > 1) ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(names[i]).replace(/'/g, "''")}'!$A$1:$${colName(Math.max(1, ...s.rows.map(r => r.length)) - 1)}$${s.rows.length}</definedName>` : '').join('') + '</definedNames>' +
      '</workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) });
    files.push({ name: 'xl/styles.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>') });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) }));
    return zip(files);
  }

  // CSV для Excel з українською локаллю: роздільник «;», UTF-8 з BOM
  function toCsv(rows, sep) {
    sep = sep || ';';
    const cell = v => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return sep === ';' ? String(v).replace('.', ',') : String(v);
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // текст, схожий на формулу («-30+65=95»), Excel не має виконувати
      return s.includes(sep) || /["\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map(r => r.map(cell).join(sep)).join('\r\n') + '\r\n';
  }

  return { buildXlsx, toCsv, crc32, zip };
}));
