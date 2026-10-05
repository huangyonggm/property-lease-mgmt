'use strict';
// 导出：CSV（UTF-8 BOM，Excel 可直接打开）与 Excel 2003 XML（.xls，支持大批量）
const fs = require('fs');
const path = require('path');

function esc(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCSV(headers, rows) {
  const lines = [headers.map(h => esc(h.title || h.key)).join(',')];
  rows.forEach(r => {
    lines.push(headers.map(h => {
      const v = typeof h.value === 'function' ? h.value(r) : r[h.key];
      return esc(v);
    }).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

function xmlEsc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 生成 Excel 2003 SpreadsheetML，行数多的场景比 CSV 更稳（单元格类型明确）
function toXls(sheets) {
  // sheets: [{name, headers:[{title,key,type,width,value}], rows:[]}]
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
  xml += '<Styles>\n' +
    '<Style ss:ID="head"><Font ss:Bold="1" ss:Size="10"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/>' +
    '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>\n' +
    '<Style ss:ID="txt"><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style>\n' +
    '<Style ss:ID="num"><NumberFormat ss:Format="#,##0.00"/></Style>\n' +
    '<Style ss:ID="int"><NumberFormat ss:Format="#,##0"/></Style>\n' +
    '</Styles>\n';
  sheets.forEach(sh => {
    xml += '<Worksheet ss:Name="' + xmlEsc(sh.name || 'Sheet1').slice(0, 30) + '">\n<Table>\n';
    (sh.headers || []).forEach(h => {
      xml += '<Column ss:Width="' + (h.width || 100) + '"/>\n';
    });
    xml += '<Row>\n';
    (sh.headers || []).forEach(h => {
      xml += '<Cell ss:StyleID="head"><Data ss:Type="String">' + xmlEsc(h.title || h.key) + '</Data></Cell>\n';
    });
    xml += '</Row>\n';
    (sh.rows || []).forEach(r => {
      xml += '<Row>\n';
      (sh.headers || []).forEach(h => {
        const v = typeof h.value === 'function' ? h.value(r) : r[h.key];
        const t = h.type === 'number' ? 'Number' : 'String';
        const style = h.type === 'number' ? 'num' : 'txt';
        xml += '<Cell ss:StyleID="' + style + '"><Data ss:Type="' + t + '">' + xmlEsc(t === 'Number' ? (Number(v) || 0) : v) + '</Data></Cell>\n';
      });
      xml += '</Row>\n';
    });
    xml += '</Table>\n</Worksheet>\n';
  });
  xml += '</Workbook>';
  return xml;
}

/**
 * 落盘导出文件，返回文件路径。
 *
 * 云端（Lambda）注意：运行环境只有 /tmp 可写，且实例随时回收，落盘文件没有持久意义
 * —— 真正的返回靠 sendFile 把内容直接写进 HTTP 响应。
 * 所以这里写盘失败只警告不抛错，避免整个导出接口因为「存不下临时文件」而 500。
 */
function writeExport(dir, filename, content) {
  const fp = path.join(dir, filename);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
  } catch (e) {
    console.warn('[export] 写盘失败（云端正常，文件仅在响应流中返回）:', e.message);
  }
  return fp;
}

module.exports = { toCSV, toXls, writeExport };
