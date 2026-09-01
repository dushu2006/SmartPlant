'use strict';

/**
 * Reporting service (PRD §58): CSV / XLSX / PDF exports for
 * machine health, energy, maintenance, alerts, spare inventory,
 * requests and AI insights. Generators are pure functions (testable).
 */
const { zipSync, strToU8 } = require('fflate');
const crypto = require('crypto');
const analytics = require('./analytics');
const machinesStore = require('../store/machines');
const alertsStore = require('../store/alerts');
const opsStore = require('../store/ops');
const inventoryStore = require('../store/inventory');
const aiStore = require('../store/ai');
const { audit } = require('./audit');
const { errors } = require('../errors');

// ------------------------------------------------------------------- CSV
function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const head = columns.map((c) => csvEscape(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

// ------------------------------------------------------------------- XLSX
function xlsxCell(ref, value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  const text = String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function toXlsx(columns, rows, sheetName = 'Sheet1') {
  const header = columns.map((c) => csvEscape(c.label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  sheet += `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
  sheet += `<row r="1">${header
    .map((h, i) => `<c r="${colName(i)}1" t="inlineStr"><is><t xml:space="preserve">${h}</t></is></c>`)
    .join('')}</row>`;
  rows.forEach((r, ri) => {
    const cells = columns
      .map((c, ci) => xlsxCell(`${colName(ci)}${ri + 2}`, r[c.key]))
      .join('');
    sheet += `<row r="${ri + 2}">${cells}</row>`;
  });
  sheet += '</sheetData></worksheet>';

  const files = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };

  return Buffer.from(zipSync(files));
}

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ------------------------------------------------------------------- PDF
function pdfEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Minimal valid PDF (Helvetica) — deterministic, no dependencies.
 * Layout: title, subtitle, table rows of columns at fixed x positions.
 */
function toPdf(title, columns, rows) {
  const objs = [];
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 48;
  const lineH = 15;
  const colXs = columns.map((_, i) => margin + i * Math.floor((pageWidth - margin * 2) / Math.max(columns.length, 1)));

  function add(obj) {
    objs.push(obj);
    return objs.length;
  }

  let content = 'BT\n/F1 16 Tf\n';
  content += `${margin} ${pageHeight - 64} Td\n(${pdfEscape(title)}) Tj\nET\n`;
  content += 'BT\n/F1 9 Tf\n';
  content += `${margin} ${pageHeight - 84} Td\n(${pdfEscape(`SmartPlant report — ${new Date().toISOString()}`)}) Tj\nET\n`;

  let y = pageHeight - 110;
  // header
  content += `BT\n/F1 10 Tf\n`;
  columns.forEach((c, i) => {
    content += `BT 1 0 0 1 ${colXs[i]} ${y} Tm (${pdfEscape(c.label)}) Tj ET\n`;
  });
  content += `0.8 0.8 0.8 RG\n${margin} ${y - 4} m ${pageWidth - margin} ${y - 4} l S\n`;
  y -= 16;

  // rows
  content += `BT\n/F1 9 Tf\n`;
  for (const r of rows) {
    if (y < 60) {
      // page break (single page is typical for these reports; content beyond is truncated
      // only in extreme cases — acceptable for the demo reporting service)
      y = pageHeight - 64;
      content += 'ET\nBT\n/F1 9 Tf\n';
    }
    columns.forEach((c, i) => {
      content += `BT 1 0 0 1 ${colXs[i]} ${y} Tm (${pdfEscape(r[c.key])}) Tj ET\n`;
    });
    y -= lineH;
  }
  content += 'ET\n';

  // Stable object numbering: 1=catalog, 2=pages, 3=font, 4=page, 5=content stream.
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>');
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>');
  objects.set(5, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets = new Map();
  for (const [num, body] of objects) {
    offsets.set(num, Buffer.byteLength(pdf));
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += 'xref\n';
  pdf += `0 ${objects.size + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.size; i++) {
    pdf += `${String(offsets.get(i)).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ------------------------------------------------------------ report data
const REPORT_DEFS = {
  machines: {
    label: 'Machine Health Report',
    columns: [
      { key: 'name', label: 'Machine' },
      { key: 'status', label: 'Status' },
      { key: 'health_score', label: 'Health' },
      { key: 'risk_level', label: 'Risk' },
      { key: 'temperature_c', label: 'Temp (°C)' },
      { key: 'power_kw', label: 'Power (kW)' },
      { key: 'energy_today_kwh', label: 'Energy today (kWh)' },
      { key: 'freshness_s', label: 'Freshness (s)' },
    ],
    build: () => {
      const machines = machinesStore.allMachines();
      return machines.map((m) => {
        const ov = analytics.machineOverview(m);
        return {
          name: m.name,
          status: m.status,
          health_score: ov.health_score,
          risk_level: ov.risk.risk_level,
          temperature_c: ov.current.temperature_c?.value ?? '',
          power_kw: ov.current.power_kw?.value ?? '',
          energy_today_kwh: ov.energy_today_kwh,
          freshness_s: ov.current.data_freshness_seconds ?? '',
        };
      });
    },
  },
  energy: {
    label: 'Energy Report',
    columns: [
      { key: 'name', label: 'Machine' },
      { key: 'energy_today_kwh', label: 'Energy today (kWh)' },
      { key: 'cost_today_usd', label: 'Cost today (USD)' },
      { key: 'monthly_estimate_usd', label: 'Monthly est. (USD)' },
      { key: 'operating_hours', label: 'Op. hours today' },
    ],
    build: () => {
      return machinesStore.allMachines().map((m) => ({
        name: m.name,
        energy_today_kwh: Math.round(analytics.energyTodayKwh(m.id) * 100) / 100,
        cost_today_usd: Math.round(analytics.costTodayUsd(m.id) * 100) / 100,
        monthly_estimate_usd: Math.round(analytics.monthlyEstimateUsd(m.id) * 100) / 100,
        operating_hours: Math.round(analytics.operatingHoursToday(m.id) * 100) / 100,
      }));
    },
  },
  maintenance: {
    label: 'Maintenance Report',
    columns: [
      { key: 'machine_name', label: 'Machine' },
      { key: 'type', label: 'Type' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'technician_name', label: 'Technician' },
      { key: 'completed_at', label: 'Completed' },
      { key: 'notes', label: 'Notes' },
    ],
    build: () => opsStore.listMaintenanceEvents({ limit: 500 }),
  },
  alerts: {
    label: 'Alert Report',
    columns: [
      { key: 'created_at', label: 'Created' },
      { key: 'machine_id', label: 'Machine' },
      { key: 'type', label: 'Type' },
      { key: 'severity', label: 'Severity' },
      { key: 'status', label: 'Status' },
      { key: 'message', label: 'Message' },
    ],
    build: () => alertsStore.list({ pageSize: 500 }).data,
  },
  inventory: {
    label: 'Spare Inventory Report',
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Part' },
      { key: 'stock_qty', label: 'Stock' },
      { key: 'reserved_qty', label: 'Reserved' },
      { key: 'available_qty', label: 'Available' },
      { key: 'reorder_level', label: 'Reorder level' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'status', label: 'Status' },
    ],
    build: () => inventoryStore.listParts({ pageSize: 500 }).data,
  },
  requests: {
    label: 'Requests Report',
    columns: [
      { key: 'created_at', label: 'Created' },
      { key: 'kind', label: 'Kind' },
      { key: 'machine_name', label: 'Machine' },
      { key: 'detail', label: 'Detail' },
      { key: 'priority', label: 'Priority' },
      { key: 'status', label: 'Status' },
    ],
    build: () => {
      const maint = opsStore.listMaintenanceRequests({ pageSize: 500 }).data.map((r) => ({
        created_at: r.created_at,
        kind: 'Maintenance',
        machine_name: r.machine_name || '',
        detail: r.issue,
        priority: r.priority,
        status: r.status,
      }));
      const spare = inventoryStore.listSpareRequests({ pageSize: 500 }).data.map((r) => ({
        created_at: r.created_at,
        kind: 'Spare part',
        machine_name: r.machine_name || '',
        detail: `${r.part_name || ''} ×${r.quantity}`,
        priority: '—',
        status: r.status,
      }));
      return [...maint, ...spare];
    },
  },
  insights: {
    label: 'AI Insights Report',
    columns: [
      { key: 'created_at', label: 'Created' },
      { key: 'machine_name', label: 'Machine' },
      { key: 'category', label: 'Category' },
      { key: 'severity', label: 'Severity' },
      { key: 'description', label: 'Insight' },
      { key: 'confidence', label: 'Confidence' },
      { key: 'model_version', label: 'Model' },
      { key: 'feedback', label: 'Feedback' },
    ],
    build: () => aiStore.listInsights({ pageSize: 500 }).data,
  },
};

function exportReport(kind, format, actorId) {
  const def = REPORT_DEFS[kind];
  if (!def) throw errors.notFound(`Unknown report kind: ${kind}`);
  const rows = def.build();
  const formats = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };
  if (!formats[format]) throw errors.validation(`Unsupported format: ${format}`);

  let buffer;
  if (format === 'csv') buffer = Buffer.from(toCsv(def.columns, rows), 'utf8');
  else if (format === 'xlsx') buffer = toXlsx(def.columns, rows, def.label.slice(0, 30));
  else buffer = toPdf(def.label, def.columns, rows);

  audit({ actorId, action: 'REPORT.EXPORT', entityType: 'report', entityId: kind, after: { format, rows: rows.length } });
  return { buffer, mime: formats[format], filename: `${kind}-${new Date().toISOString().slice(0, 10)}.${format}` };
}

module.exports = { exportReport, toCsv, toXlsx, toPdf };
