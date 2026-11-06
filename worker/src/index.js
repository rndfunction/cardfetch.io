// cardfetch.io Worker. Cloudflare Workers (module syntax).
//
// Canonical format (what the app reads and writes):
//   TCGplayer Id, Product Line, Set Name, Product Name, Number, Rarity,
//   Condition, Total Quantity, Where is it?
//
// Imports accept TCGplayer (23 columns) and CardCastle-native (21 columns)
// exports. Duplicate (tcgplayer_id, box) rows are summed, not dropped.
// Rows missing a TCGplayer Id get a synthetic "local:set:number:condition" id.
//
// Routes:
//   GET   /api/inventory   -> CSV of the full inventory (canonical columns)
//   PUT   /api/inventory   -> replace inventory with posted CSV (write key)
//   POST  /api/append      -> append one scanned CSV as a new box (write key)
//   PATCH /api/quantities  -> update quantities surgically (write key)
//   GET   /api/batches     -> list of scan batches
// Write routes require X-Write-Key. Strict mode: ?strict=1 on PUT.

const HEADER_OUT = [
  'TCGplayer Id', 'Product Line', 'Set Name', 'Product Name', 'Number',
  'Rarity', 'Condition', 'Total Quantity', 'Where is it?'
];

// Quantity source order matters. In this export, "Add to Quantity" is the
// real per-scan count; "Total Quantity" is usually blank.
const CANON_NAMES = {
  tcgplayer_id: ['TCGplayer Id', 'TCGplayerId', 'Id'],
  product_line: ['Product Line', 'ProductLine', 'Line'],
  set_name: ['Set Name', 'Set', 'SetName'],
  product_name: ['Product Name', 'ProductName', 'Name', 'Card Name'],
  number: ['Number', 'Card Number', 'Card#'],
  rarity: ['Rarity'],
  condition: ['Condition', 'Cond'],
  total_quantity: ['Add to Quantity', 'Total Quantity', 'Quantity', 'Qty'],
  box: ['Where is it?', 'Location', 'Box Location']
};

const CANON_ORDER = [
  'tcgplayer_id', 'product_line', 'set_name', 'product_name', 'number',
  'rarity', 'condition', 'total_quantity', 'box'
];

const DB_COLUMNS = CANON_ORDER;

const NUMERIC_CANON = new Set(['total_quantity']);

const BATCH_CHUNK = 100;

// --- CSV helpers ---------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (ch === '\r' && text[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  const out = [HEADER_OUT.map(csvEscape).join(',')];
  for (const r of rows) out.push(r.map(csvEscape).join(','));
  return out.join('\r\n') + '\r\n';
}

// --- Format detection and mapping ----------------------------------------

function detectFormat(header) {
  const idx = {};
  header.forEach(function (h, i) { const k = String(h || '').trim(); if (!(k in idx)) idx[k] = i; });

  const hasTitle = 'Title' in idx;
  const hasUnderscores = '_1' in idx || '_2' in idx || '_3' in idx;
  const hasWhere = 'Where is it?' in idx;
  const hasProductName = 'Product Name' in idx;
  const hasSetName = 'Set Name' in idx;
  const hasNumber = 'Number' in idx;

  if (hasTitle && hasUnderscores) return { format: 'cardcastle', headerIndex: idx };
  if (hasWhere) return { format: 'tcgplayer', headerIndex: idx };
  // Scan output: TCGplayer-style columns, no location, no trailing _1/_3.
  // The box comes from the caller (append flow).
  if (hasProductName && hasSetName && hasNumber) return { format: 'scan', headerIndex: idx };
  return { format: 'unknown', headerIndex: idx };
}

function pickCell(row, idx, names) {
  for (const n of names) {
    if (n in idx) {
      const v = row[idx[n]];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
}

function mapRow(row, fmt, idx) {
  const canon = {};
  // 'scan' uses the same column mapping as 'tcgplayer'. It just has no
  // Where is it? column, so `box` comes back empty and is filled in by the
  // caller's boxOverride before validation.
  if (fmt === 'tcgplayer' || fmt === 'scan') {
    for (const key of Object.keys(CANON_NAMES)) {
      canon[key] = pickCell(row, idx, CANON_NAMES[key]);
    }
    return canon;
  }
  if (fmt === 'cardcastle') {
    const titleVal = pickCell(row, idx, ['Title']);
    const numberVal = pickCell(row, idx, ['Number']);
    const rarityVal = pickCell(row, idx, ['Rarity']);
    const looksLikeRarity = /^(M|R|U|C|L|Special|Mythic|Rare|Uncommon|Common)$/i.test(numberVal);
    const looksLikeCondition = /near mint|lightly played|heavily played|damaged|mint|played/i.test(rarityVal);

    if (looksLikeRarity && looksLikeCondition) {
      canon.tcgplayer_id = pickCell(row, idx, ['TCGplayer Id']);
      canon.product_line = pickCell(row, idx, ['Product Line']);
      canon.set_name = pickCell(row, idx, ['Set Name']);
      canon.product_name = pickCell(row, idx, ['Product Name']);
      canon.number = titleVal;
      canon.rarity = numberVal;
      canon.condition = rarityVal;
      canon.total_quantity = pickCell(row, idx, ['Add to Quantity', 'Total Quantity']);
      canon.box = pickCell(row, idx, ['_3', 'Where is it?', 'Location']);
    } else {
      for (const key of Object.keys(CANON_NAMES)) {
        canon[key] = pickCell(row, idx, CANON_NAMES[key]);
      }
      if (!canon.box) canon.box = pickCell(row, idx, ['_3']);
    }
    return canon;
  }
  throw new Error('Unknown CSV format');
}

// Build a synthetic ID for rows that have no TCGplayer Id. These are scanner
// fail-safes: the card is real and physical, but it isn't linked to a
// TCGplayer listing yet. The ID is stable, readable, and obviously local.
function synthId(c) {
  function slug(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  return 'local:' + slug(c.set_name) + ':' + slug(c.number) + ':' + slug(c.condition);
}

function validateCanon(c, rowNum) {
  const required = ['product_name', 'set_name', 'number', 'condition', 'box'];
  const missing = required.filter(function (k) { return !c[k]; });
  if (missing.length > 0) {
    throw new Error('Row ' + rowNum + ' missing required fields: ' + missing.join(', '));
  }
  return c;
}

// --- DB helpers ----------------------------------------------------------

function canonToParams(c) {
  const params = [];
  for (const key of CANON_ORDER) {
    const v = c[key];
    if (NUMERIC_CANON.has(key)) {
      const n = Number(v);
      params.push(v === '' || v === undefined ? null : (Number.isFinite(n) ? n : null));
    } else {
      params.push(v === '' || v === undefined ? null : v);
    }
  }
  return params;
}

function rowToOut(r) {
  return CANON_ORDER.map(function (k) {
    const v = r[k];
    return v === null || v === undefined ? '' : v;
  });
}

async function runBatched(db, statements) {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}

// --- Box numbering -------------------------------------------------------


// --- Auth ---------------------------------------------------------------

async function checkWriteKey(req, env) {
  const expected = env.WRITE_KEY || '';
  const got = req.headers.get('X-Write-Key') || '';
  if (!expected) return false;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// --- Import pipeline -----------------------------------------------------

function parseImport(body, opts) {
  const options = opts || {};
  const boxOverride = options.boxOverride ? String(options.boxOverride).trim() : '';
  const parsed = parseCsv(body);
  if (parsed.length < 2) throw new Error('CSV has no data rows');
  const header = parsed[0];
  const det = detectFormat(header);
  if (det.format === 'unknown') {
    throw new Error('Unrecognized CSV format: missing Where is it? and Title/_1 columns');
  }
  const rows = [];
  let syntheticIds = 0;
  const seen = {};
  for (let i = 1; i < parsed.length; i++) {
    const r = parsed[i];
    if (r.length < 2 || r.every(function (v) { return String(v).trim() === ''; })) continue;
    const canon = mapRow(r, det.format, det.headerIndex);
    if (!canon.tcgplayer_id) { canon.tcgplayer_id = synthId(canon); syntheticIds++; }
    // A caller-provided box override takes precedence over whatever the CSV
    // says. This is how "I scanned these into box X" is expressed: the scan
    // file may have no box column at all, but the append knows the box.
    if (boxOverride) canon.box = boxOverride;
    validateCanon(canon, i + 1);
    const key = String(canon.tcgplayer_id) + '|' + String(canon.box);
    if (!seen[key]) seen[key] = [];
    seen[key].push(i + 1);
    rows.push({ canon: canon });
  }
  const duplicates = [];
  for (const key of Object.keys(seen)) {
    if (seen[key].length > 1) {
      const parts = key.split('|');
      duplicates.push({ tcgplayer_id: parts[0], box: parts[1], rows: seen[key] });
    }
  }
  return { rows: rows, format: det.format, syntheticIds: syntheticIds, duplicates: duplicates };
}

// --- Routes --------------------------------------------------------------

async function handleInventoryGet(env) {
  const res = await env.DB.prepare('SELECT * FROM cards WHERE deleted_at IS NULL ORDER BY box, set_name, product_name').all();
  const rows = (res.results || []).map(rowToOut);
  return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
}

async function handleInventoryPut(req, env) {
  const text = await req.text();
  const url = new URL(req.url);
  const strict = url.searchParams.get('strict') === '1';

  let parsed;
  try { parsed = parseImport(text); }
  catch (e) { return Response.json({ ok: false, error: 'parse failed: ' + String(e.message || e) }, { status: 400 }); }
  if (parsed.rows.length === 0) return Response.json({ ok: false, error: 'No data rows' }, { status: 400 });

  if (strict && parsed.duplicates.length > 0) {
    return Response.json({
      ok: false,
      error: 'Duplicate (tcgplayer_id, box) pairs found: ' + parsed.duplicates.length,
      duplicates: parsed.duplicates
    }, { status: 409 });
  }

  // Force primary. The D1 Sessions API can return a null dbSession on writes
  // in some environments; withSession('first-primary') bypasses replica routing.
  const db = env.DB.withSession('first-primary');

  await db.prepare('DELETE FROM cards').run();

  const statements = [];
  for (const r of parsed.rows) {
    const params = canonToParams(r.canon);
    statements.push(
      db.prepare(
        'INSERT INTO cards (' + DB_COLUMNS.join(',') + ') VALUES (' +
        DB_COLUMNS.map(function () { return '?'; }).join(',') + ') ' +
        'ON CONFLICT (tcgplayer_id, box) DO UPDATE SET ' +
        'total_quantity = COALESCE(total_quantity, 0) + COALESCE(excluded.total_quantity, 0)'
      ).bind(...params)
    );
  }
  await runBatched(db, statements);

  const response = { ok: true, rows: parsed.rows.length, format: parsed.format, syntheticIds: parsed.syntheticIds };
  if (parsed.duplicates.length > 0) response.duplicatesSummed = parsed.duplicates.length;
  return Response.json(response);
}

async function handleAppend(req, env) {
  const text = await req.text();
  const url = new URL(req.url);
  // The caller supplies the box. There is no auto-assignment: the box is a
  // human-chosen label (typically the date the batch was scanned, but any
  // string is valid). If the box is supplied via ?box=, it overrides whatever
  // the CSV says. If it isn't, the CSV must already contain a box on every row.
  const boxOverride = (url.searchParams.get('box') || '').trim();
  let parsed;
  try { parsed = parseImport(text, { boxOverride: boxOverride }); }
  catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 400 }); }
  if (parsed.rows.length === 0) return Response.json({ ok: false, error: 'No data rows' }, { status: 400 });

  // Determine the batch label for scan_batches: the override if provided,
  // otherwise the (single) box value found in the CSV. Mixed boxes without
  // an override are allowed but recorded as "(mixed)".
  let batchBox = boxOverride;
  if (!batchBox) {
    const boxes = {};
    for (const r of parsed.rows) {
      const b = String(r.canon.box || '').trim();
      if (b) boxes[b] = (boxes[b] || 0) + 1;
    }
    const keys = Object.keys(boxes);
    batchBox = keys.length === 1 ? keys[0] : (keys.length === 0 ? '' : '(mixed)');
  }

  const db = env.DB.withSession('first-primary');
  const now = new Date();
  // Append sets scanned_on to the current date. This is the closest thing
  // to "when this was scanned" that we have; the box code may also carry
  // the same information, but an explicit column survives future box
  // convention changes.
  const scannedOn = now.toISOString().slice(0, 10);
  const statements = [];
  for (const r of parsed.rows) {
    const params = canonToParams(r.canon);
    statements.push(
      db.prepare(
        'INSERT OR IGNORE INTO cards (' + DB_COLUMNS.join(',') + ', scanned_on) VALUES (' +
        DB_COLUMNS.map(function () { return '?'; }).join(',') + ', ?)'
      ).bind(...params, scannedOn)
    );
  }
  await runBatched(db, statements);
  await db.prepare('INSERT INTO scan_batches (box, scanned_on, row_count) VALUES (?, ?, ?)')
    .bind(batchBox, now.toISOString().slice(0, 10), parsed.rows.length).run();
  return Response.json({
    ok: true,
    box: batchBox,
    rows: parsed.rows.length,
    format: parsed.format,
    syntheticIds: parsed.syntheticIds,
    duplicatesSummed: parsed.duplicates.length
  });
}

async function handleQuantitiesPatch(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const updates = (body && body.updates) || [];
  if (!Array.isArray(updates) || updates.length === 0) {
    return Response.json({ ok: false, error: 'No updates provided' }, { status: 400 });
  }
  const events = Array.isArray(body && body.events) ? body.events : [];

  const db = env.DB.withSession('first-primary');
  const statements = [];
  for (const u of updates) {
    if (!u || !u.tcgplayer_id || !u.box) continue;
    const qty = Number(u.total_quantity);
    statements.push(
      db.prepare('UPDATE cards SET total_quantity = ? WHERE tcgplayer_id = ? AND box = ? AND deleted_at IS NULL')
        .bind(Number.isFinite(qty) ? qty : 0, u.tcgplayer_id, u.box)
    );
  }
  if (statements.length === 0) {
    return Response.json({ ok: false, error: 'No valid updates' }, { status: 400 });
  }

  // Append events in the same batch, so quantities and trail land together.
  for (const e of events) {
    if (!e || !e.tcgplayer_id || !e.kind) continue;
    statements.push(
      db.prepare(
        'INSERT INTO events (tcgplayer_id, kind, box_from, box_to, order_token, quantity, source, metadata) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        String(e.tcgplayer_id),
        String(e.kind),
        e.box_from || null,
        e.box_to || null,
        e.order_token || null,
        Number.isFinite(Number(e.quantity)) ? Number(e.quantity) : null,
        e.source || 'live',
        e.metadata || null
      )
    );
  }

  await db.batch(statements);
  return Response.json({ ok: true, updated: updates.length, eventsRecorded: events.length });
}

// Edit a card's fields. TCGplayer Id is immutable (it's the historical
// artifact of what the scanner thought the card was). All other canonical
// fields are editable, including the box. One 'edit' event captures every
// changed field in its metadata.
// Body: { tcgplayer_id, from_box, changes: { "Product Name": "X", ... } }
const EDITABLE_COLUMNS = {
  'Product Line': 'product_line',
  'Set Name': 'set_name',
  'Product Name': 'product_name',
  'Number': 'number',
  'Rarity': 'rarity',
  'Condition': 'condition',
  'Total Quantity': 'total_quantity',
  'Where is it?': 'box'
};
const EDITABLE_NUMERIC = new Set(['Total Quantity']);

async function handleEdit(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const { tcgplayer_id, from_box, changes } = body || {};
  if (!tcgplayer_id || !from_box || !changes || typeof changes !== 'object') {
    return Response.json({ ok: false, error: 'tcgplayer_id, from_box, and changes are required' }, { status: 400 });
  }

  const db = env.DB.withSession('first-primary');

  // Read the current row.
  const currentRes = await db.prepare(
    'SELECT * FROM cards WHERE tcgplayer_id = ? AND box = ?'
  ).bind(String(tcgplayer_id), String(from_box)).all();
  const current = (currentRes.results && currentRes.results[0]) ? currentRes.results[0] : null;
  if (!current) {
    return Response.json({ ok: false, error: 'Card not found at the given tcgplayer_id and box' }, { status: 404 });
  }

  // Build the update and collect the field-level diff.
  const setParts = [];
  const setValues = [];
  const fieldChanges = [];
  for (const label of Object.keys(changes)) {
    const col = EDITABLE_COLUMNS[label];
    if (!col) continue; // unknown or read-only field
    let next = changes[label];
    if (EDITABLE_NUMERIC.has(label)) {
      const n = Number(next);
      next = Number.isFinite(n) ? n : null;
    } else {
      next = next === null || next === undefined ? '' : String(next);
    }
    const prev = current[col];
    // Compare as strings so "3" and 3 agree.
    const prevStr = prev === null || prev === undefined ? '' : String(prev);
    const nextStr = next === null ? '' : String(next);
    if (prevStr === nextStr) continue;
    setParts.push(col + ' = ?');
    setValues.push(next);
    fieldChanges.push({ field: label, from: prevStr, to: nextStr });
  }

  if (setParts.length === 0) {
    return Response.json({ ok: true, changed: 0, fields: [] });
  }

  const sql = 'UPDATE cards SET ' + setParts.join(', ') + ' WHERE tcgplayer_id = ? AND box = ?';
  const bindArgs = setValues.concat([String(tcgplayer_id), String(from_box)]);
  await db.prepare(sql).bind(...bindArgs).run();

  await db.prepare(
    'INSERT INTO events (tcgplayer_id, kind, box_from, box_to, quantity, source, metadata) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    String(tcgplayer_id), 'edit',
    String(from_box),
    changes['Where is it?'] !== undefined ? String(changes['Where is it?']) : null,
    null, 'live',
    JSON.stringify(fieldChanges)
  ).run();

  return Response.json({ ok: true, changed: fieldChanges.length, fields: fieldChanges });
}

// Manually add a card to a box. If the card already exists in that box,
// the quantity is summed (upsert). Writes an 'add' event.
// Body: { "TCGplayer Id"?: string, "Product Line"?: string, "Set Name": string,
//         "Product Name": string, "Number": string, "Rarity"?: string,
//         "Condition": string, "Total Quantity": number, "Where is it?": string }
async function handleAdd(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const canon = {
    tcgplayer_id: body['TCGplayer Id'] ? String(body['TCGplayer Id']).trim() : '',
    product_line: body['Product Line'] || '',
    set_name: body['Set Name'] || '',
    product_name: body['Product Name'] || '',
    number: body['Number'] || '',
    rarity: body['Rarity'] || '',
    condition: body['Condition'] || '',
    total_quantity: body['Total Quantity'] || 1,
    box: body['Where is it?'] || ''
  };

  if (!canon.tcgplayer_id) {
    // Generate a synthetic ID. The `add` event should probably use the
    // same ID that the row gets, so we construct it identically.
    function slug(s) {
      return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    canon.tcgplayer_id = 'local:' + slug(canon.set_name) + ':' + slug(canon.number) + ':' + slug(canon.condition);
  }

  // Validate required fields.
  const required = ['product_name', 'set_name', 'number', 'condition', 'box'];
  const missing = required.filter(k => !canon[k]);
  if (missing.length > 0) {
    return Response.json({ ok: false, error: 'Missing required fields: ' + missing.join(', ') }, { status: 400 });
  }

  const db = env.DB.withSession('first-primary');
  const qty = parseInt(canon.total_quantity) || 1;

  try {
    const scannedOn = new Date().toISOString().slice(0, 10);
    await db.prepare(
      'INSERT INTO cards (' + DB_COLUMNS.join(',') + ', scanned_on) VALUES (' +
      DB_COLUMNS.map(function () { return '?'; }).join(',') + ', ?) ' +
      'ON CONFLICT (tcgplayer_id, box) DO UPDATE SET ' +
      'total_quantity = COALESCE(total_quantity, 0) + COALESCE(excluded.total_quantity, 0)'
    ).bind(...canonToParams(canon), scannedOn).run();

    await db.prepare(
      'INSERT INTO events (tcgplayer_id, kind, box_to, quantity, source) VALUES (?, ?, ?, ?, ?)'
    ).bind(canon.tcgplayer_id, 'add', String(canon.box), qty, 'live').run();

    return Response.json({ ok: true, tcgplayer_id: canon.tcgplayer_id, box: canon.box, quantity: qty });
  } catch (e) {
    return Response.json({ ok: false, error: String(e && e.message || e) }, { status: 500 });
  }
}

// Audit data: cards, per-card latest event, box totals. Read-only.
async function handleAudit(env) {
  const cardsRes = await env.DB.prepare(
    'SELECT tcgplayer_id, product_line, set_name, product_name, number, rarity, condition, total_quantity, box, scanned_on, deleted_at FROM cards WHERE deleted_at IS NULL ORDER BY box, set_name, product_name'
  ).all();
  const cards = cardsRes.results || [];

  // Latest event per (card, kind). Front end picks the max across kinds.
  const eventsRes = await env.DB.prepare(
    'SELECT tcgplayer_id, kind, MAX(created_at) AS latest FROM events GROUP BY tcgplayer_id, kind'
  ).all();
  const lastByKind = eventsRes.results || [];

  // Box totals.
  const boxRes = await env.DB.prepare(
    'SELECT box, COUNT(*) AS cards, COALESCE(SUM(total_quantity), 0) AS units FROM cards WHERE deleted_at IS NULL GROUP BY box ORDER BY box'
  ).all();
  const boxTotals = boxRes.results || [];

  return Response.json({ cards, lastByKind, boxTotals });
}

// Record a verify event. Body: { tcgplayer_id, box, quantity? }.
async function handleVerify(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const { tcgplayer_id, box, quantity } = body || {};
  if (!tcgplayer_id || !box) {
    return Response.json({ ok: false, error: 'tcgplayer_id and box are required' }, { status: 400 });
  }
  const db = env.DB.withSession('first-primary');
  try {
    await db.prepare(
      'INSERT INTO events (tcgplayer_id, kind, box_from, quantity, source) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      String(tcgplayer_id), 'verify', String(box),
      Number.isFinite(Number(quantity)) ? Number(quantity) : null,
      'live'
    ).run();
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: String(e && e.message || e) }, { status: 500 });
  }
}

// One-time backfill: fill scanned_on from the box code where possible.
// Box codes of the form MMDDYY (5 or 6 digits) or MMDDYY-N are parseable.
// Boxes that don't match (LOTR, NCC1701, etc.) stay null.
// Idempotent: only updates rows where scanned_on IS NULL.
async function handleBackfillScanDates(req, env) {
  function parseBoxDate(box) {
    if (!box) return null;
    const m = String(box).match(/^(\d{5,6})(?:-\d+)?$/);
    if (!m) return null;
    let s = m[1];
    if (s.length === 5) s = '0' + s;
    const mm = parseInt(s.slice(0, 2), 10);
    const dd = parseInt(s.slice(2, 4), 10);
    const yy = parseInt(s.slice(4, 6), 10);
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
    // Interpret YY as 20YY (these dates are all post-2020).
    const year = 2000 + yy;
    const iso = year + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
    // Sanity check: valid date.
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    return iso;
  }

  const db = env.DB.withSession('first-primary');
  const res = await db.prepare(
    'SELECT tcgplayer_id, box FROM cards WHERE scanned_on IS NULL'
  ).all();
  const rows = res.results || [];
  const statements = [];
  let filled = 0;
  let skipped = 0;
  for (const r of rows) {
    const iso = parseBoxDate(r.box);
    if (!iso) { skipped++; continue; }
    statements.push(
      db.prepare('UPDATE cards SET scanned_on = ? WHERE tcgplayer_id = ? AND box = ? AND scanned_on IS NULL')
        .bind(iso, r.tcgplayer_id, r.box)
    );
    filled++;
  }
  if (statements.length > 0) {
    for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
      await db.batch(statements.slice(i, i + BATCH_CHUNK));
    }
  }
  return Response.json({ ok: true, filled, skipped, total: rows.length });
}

// Delete one or more cards. Body: { items: [{ tcgplayer_id, box, quantity? }] }
// Each delete writes a 'delete' event first (so the trail shows the removal),
// then removes the row. Best-effort: one bad item doesn't abort the others.
async function handleDelete(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const items = (body && body.items) || (body && body.tcgplayer_id ? [{ tcgplayer_id: body.tcgplayer_id, box: body.box, quantity: body.quantity }] : []);
  if (!Array.isArray(items) || items.length === 0) {
    return Response.json({ ok: false, error: 'No items to delete' }, { status: 400 });
  }
  const db = env.DB.withSession('first-primary');
  const statements = [];
  let valid = 0;
  for (const it of items) {
    if (!it || !it.tcgplayer_id || !it.box) continue;
    valid++;
    statements.push(
      db.prepare(
        'INSERT INTO events (tcgplayer_id, kind, box_from, quantity, source) VALUES (?, ?, ?, ?, ?)'
      ).bind(String(it.tcgplayer_id), 'delete', String(it.box), Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : null, 'live')
    );
    statements.push(
      db.prepare("UPDATE cards SET deleted_at = datetime('now') WHERE tcgplayer_id = ? AND box = ? AND deleted_at IS NULL")
        .bind(String(it.tcgplayer_id), String(it.box))
    );
  }
  if (statements.length === 0) {
    return Response.json({ ok: false, error: 'No valid items' }, { status: 400 });
  }
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
  return Response.json({ ok: true, deleted: valid });
}

// Restore soft-deleted cards. Body: { items: [{ tcgplayer_id, box }] }
// Clears deleted_at and writes a 'restore' event.
async function handleRestore(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const items = (body && body.items) || [];
  if (!Array.isArray(items) || items.length === 0) {
    return Response.json({ ok: false, error: 'No items to restore' }, { status: 400 });
  }
  const db = env.DB.withSession('first-primary');
  const statements = [];
  let valid = 0;
  for (const it of items) {
    if (!it || !it.tcgplayer_id || !it.box) continue;
    valid++;
    statements.push(
      db.prepare('UPDATE cards SET deleted_at = NULL WHERE tcgplayer_id = ? AND box = ?')
        .bind(String(it.tcgplayer_id), String(it.box))
    );
    statements.push(
      db.prepare(
        'INSERT INTO events (tcgplayer_id, kind, box_from, quantity, source) VALUES (?, ?, ?, ?, ?)'
      ).bind(String(it.tcgplayer_id), 'restore', String(it.box), Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : null, 'live')
    );
  }
  if (statements.length === 0) {
    return Response.json({ ok: false, error: 'No valid items' }, { status: 400 });
  }
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
  return Response.json({ ok: true, restored: valid });
}

// List soft-deleted cards. Read-only.
async function handleDeletedList(env) {
  const res = await env.DB.prepare(
    'SELECT tcgplayer_id, product_line, set_name, product_name, number, rarity, condition, total_quantity, box, scanned_on, deleted_at FROM cards WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all();
  const cards = res.results || [];
  return Response.json({ cards: cards });
}

async function handleBatches(env) {
  const res = await env.DB.prepare('SELECT box, scanned_on, row_count FROM scan_batches ORDER BY box').all();
  return Response.json({ batches: res.results || [] });
}

// Bulk move: same semantics as handleMove, but accepts an array and
// reports per-entry results. Best-effort: one bad move doesn't abort the
// others. Used by the checkbox selection UI.
// Body: { moves: [{ tcgplayer_id, from_box, to_box }], reason? }
async function handleMoveBulk(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const moves = (body && body.moves) || [];
  if (!Array.isArray(moves) || moves.length === 0) {
    return Response.json({ ok: false, error: 'No moves provided' }, { status: 400 });
  }
  const reason = body.reason || 'bulk';
  const db = env.DB.withSession('first-primary');
  const skipped = [];
  const statements = [];
  for (const m of moves) {
    if (!m || !m.tcgplayer_id || !m.from_box || !m.to_box) {
      skipped.push({ tcgplayer_id: m && m.tcgplayer_id, reason: 'missing fields' });
      continue;
    }
    if (m.from_box === m.to_box) {
      skipped.push({ tcgplayer_id: m.tcgplayer_id, reason: 'same box' });
      continue;
    }
    statements.push(
      db.prepare('UPDATE cards SET box = ? WHERE tcgplayer_id = ? AND box = ?')
        .bind(String(m.to_box), String(m.tcgplayer_id), String(m.from_box))
    );
    statements.push(
      db.prepare(
        'INSERT INTO events (tcgplayer_id, kind, box_from, box_to, quantity, source, metadata) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        String(m.tcgplayer_id), 'move', String(m.from_box), String(m.to_box), 1, 'live',
        JSON.stringify({ reason: String(reason) })
      )
    );
  }
  if (statements.length === 0) {
    return Response.json({ ok: false, error: 'No valid moves', skipped: skipped }, { status: 400 });
  }
  try {
    for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
      await db.batch(statements.slice(i, i + BATCH_CHUNK));
    }
  } catch (e) {
    return Response.json({ ok: false, error: String(e && e.message || e), skipped: skipped }, { status: 500 });
  }
  return Response.json({ ok: true, moved: statements.length / 2, skipped: skipped });
}

// Move a card from one box to another. Updates the canonical `cards.box`
// AND writes a 'move' event. Both happen in the same batch, so they always
// agree.
// Body: { tcgplayer_id, from_box, to_box, reason? }
async function handleMove(req, env) {
  let body;
  try { body = await req.json(); } catch (e) {
    return Response.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }
  const { tcgplayer_id, from_box, to_box, reason } = body || {};
  if (!tcgplayer_id || !from_box || !to_box) {
    return Response.json({ ok: false, error: 'tcgplayer_id, from_box, and to_box are required' }, { status: 400 });
  }
  if (from_box === to_box) {
    return Response.json({ ok: false, error: 'from_box and to_box are the same' }, { status: 400 });
  }
  const db = env.DB.withSession('first-primary');
  try {
    // Update the row.
    const upd = await db.prepare(
      'UPDATE cards SET box = ? WHERE tcgplayer_id = ? AND box = ? AND deleted_at IS NULL'
    ).bind(to_box, tcgplayer_id, from_box).run();
    const changes = upd.meta ? upd.meta.changes : null;
    if (changes === 0) {
      // The row wasn't where we expected. Possibly already moved, or the
      // from_box is stale. Return a clear error; the caller can re-fetch.
      return Response.json({
        ok: false,
        error: 'No card found with that tcgplayer_id in the given box',
        tcgplayer_id: tcgplayer_id,
        from_box: from_box
      }, { status: 404 });
    }
    // Write the event.
    await db.prepare(
      'INSERT INTO events (tcgplayer_id, kind, box_from, box_to, quantity, source, metadata) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      String(tcgplayer_id), 'move', String(from_box), String(to_box), 1, 'live',
      reason ? JSON.stringify({ reason: String(reason) }) : null
    ).run();
    return Response.json({ ok: true, from: from_box, to: to_box });
  } catch (e) {
    return Response.json({ ok: false, error: String(e && e.message || e) }, { status: 500 });
  }
}

// Read events. Query with ?tcgplayer_id=X for card history, or ?order=TOKEN
// for order history, or neither for the most recent N events.
async function handleEvents(env, url) {
  const card = url.searchParams.get('tcgplayer_id');
  const order = url.searchParams.get('order');
  const limitParam = parseInt(url.searchParams.get('limit') || '200', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 200;

  let sql;
  let bind = [];
  if (card) {
    sql = 'SELECT * FROM events WHERE tcgplayer_id = ? ORDER BY created_at DESC LIMIT ?';
    bind = [card, limit];
  } else if (order) {
    sql = 'SELECT * FROM events WHERE order_token = ? ORDER BY created_at DESC LIMIT ?';
    bind = [order, limit];
  } else {
    sql = 'SELECT * FROM events ORDER BY created_at DESC LIMIT ?';
    bind = [limit];
  }
  const res = await env.DB.prepare(sql).bind(...bind).all();
  return Response.json({ events: res.results || [], count: (res.results || []).length });
}

// --- Entry --------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Write-Key'
};

function withCors(resp) {
  const h = new Headers(resp.headers);
  for (const k of Object.keys(CORS)) h.set(k, CORS[k]);
  return new Response(resp.body, { status: resp.status, headers: h });
}

async function handleRequest(req, env) {
  if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path === '/api/inventory' && req.method === 'GET') return withCors(await handleInventoryGet(env));
    if (path === '/api/inventory' && req.method === 'PUT') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleInventoryPut(req, env));
    }
    if (path === '/api/append' && req.method === 'POST') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleAppend(req, env));
    }
    if (path === '/api/quantities' && req.method === 'PATCH') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleQuantitiesPatch(req, env));
    }
    if (path === '/api/cards/move' && req.method === 'PATCH') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleMove(req, env));
    }
    if (path === '/api/cards/move-bulk' && req.method === 'PATCH') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleMoveBulk(req, env));
    }
    if (path === '/api/cards/edit' && req.method === 'PATCH') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleEdit(req, env));
    }
    if (path === '/api/cards/add' && req.method === 'POST') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleAdd(req, env));
    }
    if (path === '/api/cards/verify' && req.method === 'POST') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleVerify(req, env));
    }
    if (path === '/api/cards/backfill-scan-dates' && req.method === 'POST') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleBackfillScanDates(req, env));
    }
    if (path === '/api/cards/delete' && req.method === 'POST') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleDelete(req, env));
    }
    if (path === '/api/cards/restore' && req.method === 'POST') {
      if (!(await checkWriteKey(req, env))) return withCors(new Response('Forbidden', { status: 403 }));
      return withCors(await handleRestore(req, env));
    }
    if (path === '/api/cards/deleted' && req.method === 'GET') {
      return withCors(await handleDeletedList(env));
    }
    if (path === '/api/audit' && req.method === 'GET') {
      return withCors(await handleAudit(env));
    }

    if (path === '/api/batches' && req.method === 'GET') return withCors(await handleBatches(env));
    if (path === '/api/events' && req.method === 'GET') return withCors(await handleEvents(env, url));
    return withCors(new Response('Not found', { status: 404 }));
  } catch (err) {
    const msg = String((err && err.message) || err);
    return withCors(Response.json({ ok: false, error: msg }, { status: 500 }));
  }
}

export default { fetch: handleRequest };