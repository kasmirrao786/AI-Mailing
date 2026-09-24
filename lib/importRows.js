const ExcelJS = require("exceljs");

// A real CSV parser, not a naive split(',') — that would corrupt any field containing a
// comma, which is now a near-certainty once body text is a column (ordinary sentences
// have commas). Handles quoted fields, commas inside quotes, escaped "" quotes, and
// quoted fields spanning multiple lines (a multi-paragraph email body in one cell).
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(cell => cell.trim().length)) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); if (row.some(cell => cell.trim().length)) rows.push(row); }
  return rows;
}

function parseCsv(buffer) {
  const text = buffer.toString("utf8");
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(cells => {
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || "").trim(); });
    return row;
  });
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = String(cell.value || "").trim().toLowerCase();
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    row.eachCell((cell, colNumber) => {
      if (headers[colNumber]) obj[headers[colNumber]] = cell.value != null ? String(cell.value) : "";
    });
    if (Object.keys(obj).length) rows.push(obj);
  });
  return rows;
}

// Maps loosely-named columns (email/e-mail, name/full name, company/organization) into
// the shape contacts.bulkUpsert expects, keeping anything else as custom_fields.
function normalizeRow(row) {
  const lower = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().trim()] = v;
  const email = lower.email || lower["e-mail"] || lower["email address"];
  const name = lower.name || lower["full name"] || lower["contact name"];
  const company = lower.company || lower.organization || lower["company name"];
  const customFields = {};
  for (const [k, v] of Object.entries(lower)) {
    if (!["email", "e-mail", "email address", "name", "full name", "contact name", "company", "organization", "company name"].includes(k) && v) {
      customFields[k] = v;
    }
  }
  return { email, name, company, customFields };
}

// Same loose column matching, but for a pre-written-email import: each row already
// carries the subject and full body text to send, instead of asking generation to write it.
function normalizeDraftRow(row) {
  const lower = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().trim()] = v;
  const email = lower.email || lower["e-mail"] || lower["email address"];
  const name = lower.name || lower["full name"] || lower["contact name"];
  const company = lower.company || lower.organization || lower["company name"];
  const subject = lower.subject || lower["email subject"] || lower["subject line"];
  const body = lower.body || lower["email body"] || lower.message || lower.content || lower["email content"];
  return { email, name, company, subject, body };
}

async function parseUpload(buffer, filename) {
  const isXlsx = /\.xlsx$/i.test(filename);
  const rows = isXlsx ? await parseXlsx(buffer) : parseCsv(buffer);
  return rows.map(normalizeRow).filter(r => r.email);
}

async function parseDraftUpload(buffer, filename) {
  const isXlsx = /\.xlsx$/i.test(filename);
  const rows = isXlsx ? await parseXlsx(buffer) : parseCsv(buffer);
  return rows.map(normalizeDraftRow).filter(r => r.email);
}

module.exports = { parseUpload, parseDraftUpload };
