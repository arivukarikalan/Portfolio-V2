/* Google Apps Script Web App
   - doPost(e): appends a row to the configured spreadsheet (unchanged)
   - doGet(e): robustly finds latest JSON payload by scanning ALL sheets.
     Supports ?mode=latest (default), ?mode=all (returns recent rows across sheets), and ?mode=diag (diagnostics).
*/
const SPREADSHEET_ID = '1SDWxuEIfgLON-pu4WcKF-wQX6AoKt4YcNCAtARw_JMg';
const PREFERRED_SHEET = 'Transactions'; // friendly name used for diag; scanning uses all sheets

function _openSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'no_payload' })).setMimeType(ContentService.MimeType.JSON);
    }
    const body = JSON.parse(e.postData.contents);
    const exportedAt = body.exportedAt || new Date().toISOString();
    const deviceId = body.deviceId || '';
    const appVersion = body.version || '';
    const jsonPayload = JSON.stringify(body);

    // Write to preferred sheet (create if missing)
    const ss = _openSpreadsheet();
    let sheet = ss.getSheetByName(PREFERRED_SHEET);
    if (!sheet) sheet = ss.insertSheet(PREFERRED_SHEET);
    sheet.appendRow([exportedAt, deviceId, appVersion, jsonPayload]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true, exportedAt })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err.message || err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    const mode = (e && e.parameter && e.parameter.mode) || 'latest';
    const ss = _openSpreadsheet();

    // mode=diag: return diagnostic info about spreadsheet and sheets
    if (mode === 'diag') {
      const sheets = ss.getSheets();
      const sheetNames = sheets.map(s => s.getName());
      const preferred = ss.getSheetByName(PREFERRED_SHEET);
      const activeSheetName = preferred ? preferred.getName() : null;
      let lastRow = 0;
      let lastCol = 0;
      let lastRowSample = null;
      if (preferred) {
        lastRow = preferred.getLastRow();
        lastCol = preferred.getLastColumn();
        if (lastRow >= 1 && lastCol >= 1) {
          lastRowSample = preferred.getRange(lastRow, 1, 1, Math.min(lastCol, 20)).getValues()[0];
        }
      }
      const info = {
        ok: true,
        spreadsheetId: SPREADSHEET_ID,
        sheetNames,
        expectedSheet: PREFERRED_SHEET,
        activeSheetName,
        lastRow,
        lastCol,
        lastRowSample
      };
      return ContentService.createTextOutput(JSON.stringify(info)).setMimeType(ContentService.MimeType.JSON);
    }

    // Helper: attempt to parse a candidate string as JSON
    function tryParseCandidate(candidate) {
      if (!candidate || typeof candidate !== 'string') return null;
      const trimmed = candidate.trim();
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        return null;
      }
    }

    // mode=all: return recent rows across all sheets with metadata
    if (mode === 'all') {
      const sheets = ss.getSheets();
      const rows = [];
      const MAX_ROWS_PER_SHEET = 200;
      for (let si = 0; si < sheets.length; si++) {
        const sheet = sheets[si];
        const sheetName = sheet.getName();
        const lastRow = sheet.getLastRow();
        const lastCol = Math.max(1, sheet.getLastColumn());
        if (lastRow < 1) continue;
        const startRow = Math.max(1, lastRow - MAX_ROWS_PER_SHEET + 1);
        const numRows = lastRow - startRow + 1;
        const values = sheet.getRange(startRow, 1, numRows, lastCol).getValues();
        for (let i = 0; i < values.length; i++) {
          const r = values[i];
          rows.push({
            sheetName,
            exportedAt: r[0],
            deviceId: r[1],
            appVersion: r[2],
            jsonPayload: (r.length >= 4 && r[3]) ? r[3] : null,
            rawRow: r
          });
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ ok: true, rows })).setMimeType(ContentService.MimeType.JSON);
    }

    // default mode=latest: scan all sheets, bottom-up, return the first parseable payload found
    const sheets = ss.getSheets();
    // scan sheets in natural order but for each sheet scan bottom-up
    for (let si = 0; si < sheets.length; si++) {
      const sheet = sheets[si];
      const sheetName = sheet.getName();
      const lastRow = sheet.getLastRow();
      if (lastRow < 1) continue;
      const lastCol = Math.max(1, sheet.getLastColumn());
      for (let r = lastRow; r >= 1; r--) {
        const row = sheet.getRange(r, 1, 1, lastCol).getValues()[0];
        const candidates = [];
        // prefer column 4 if present
        if (row.length >= 4) candidates.push(row[3]);
        // also scan all string cells in the row
        for (let i = 0; i < row.length; i++) {
          if (row[i] && typeof row[i] === 'string') candidates.push(row[i]);
        }
        for (let ci = 0; ci < candidates.length; ci++) {
          const candidate = candidates[ci];
          const parsed = tryParseCandidate(candidate);
          if (parsed) {
            // attach metadata if missing
            if (!parsed.exportedAt && row[0]) parsed.exportedAt = row[0];
            if (!parsed.deviceId && row[1]) parsed.deviceId = row[1];
            if (!parsed.version && row[2]) parsed.version = row[2];
            // include sheet name so client knows which sheet had the payload
            parsed._sheetName = sheetName;
            return ContentService.createTextOutput(JSON.stringify(parsed)).setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ error: 'no_valid_backups' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err.message || err) })).setMimeType(ContentService.MimeType.JSON);
  }
}
