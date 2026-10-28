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

  if (hasTitle && hasUnderscores) return { format: 'cardcastle', headerIndex: idx };
  if (hasWhere) return { format: 'tcgplayer', headerIndex: idx };
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
  if (fmt === 'tcgplayer') {
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

function mmddyy(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return mm + dd + yy;
}

async function nextBoxNumber(db, dateStr) {
  const res = await db.prepare("SELECT box FROM scan_batches WHERE box LIKE ?").bind(dateStr + '%').all();
  const results = res.results || [];
  let maxSuffix = 0;
  for (const r of results) {
    if (r.box === dateStr) { if (maxSuffix < 1) maxSuffix = 1; continue; }
    const m = r.box.match(/^(\d{6})-(\d+)$/);
    if (m && m[1] === dateStr) {
      const n = parseInt(m[2], 10);
      if (n > maxSuffix) maxSuffix = n;
    }
  }
  if (maxSuffix === 0) return dateStr;
  return dateStr + '-' + (maxSuffix + 1);
}

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

function parseImport(body) {
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
  const res = await env.DB.prepare('SELECT * FROM cards ORDER BY box, set_name, product_name').all();
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
  let parsed;
  try { parsed = parseImport(text); }
  catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 400 }); }
  if (parsed.rows.length === 0) return Response.json({ ok: false, error: 'No data rows' }, { status: 400 });

  const db = env.DB.withSession('first-primary');
  const today = new Date();
  const box = await nextBoxNumber(db, mmddyy(today));

  const statements = [];
  for (const r of parsed.rows) {
    const c = r.canon;
    c.box = box;
    const params = canonToParams(c);
    statements.push(
      db.prepare(
        'INSERT OR IGNORE INTO cards (' + DB_COLUMNS.join(',') + ') VALUES (' +
        DB_COLUMNS.map(function () { return '?'; }).join(',') + ')'
      ).bind(...params)
    );
  }
  await runBatched(db, statements);
  await db.prepare('INSERT INTO scan_batches (box, scanned_on, row_count) VALUES (?, ?, ?)')
    .bind(box, today.toISOString().slice(0, 10), parsed.rows.length).run();
  return Response.json({ ok: true, box: box, rows: parsed.rows.length, format: parsed.format });
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
  const db = env.DB.withSession('first-primary');
  const statements = [];
  for (const u of updates) {
    if (!u || !u.tcgplayer_id || !u.box) continue;
    const qty = Number(u.total_quantity);
    statements.push(
      db.prepare('UPDATE cards SET total_quantity = ? WHERE tcgplayer_id = ? AND box = ?')
        .bind(Number.isFinite(qty) ? qty : 0, u.tcgplayer_id, u.box)
    );
  }
  if (statements.length === 0) {
    return Response.json({ ok: false, error: 'No valid updates' }, { status: 400 });
  }
  await db.batch(statements);
  return Response.json({ ok: true, updated: statements.length });
}

async function handleBatches(env) {
  const res = await env.DB.prepare('SELECT box, scanned_on, row_count FROM scan_batches ORDER BY box').all();
  return Response.json({ batches: res.results || [] });
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
    if (path === '/api/batches' && req.method === 'GET') return withCors(await handleBatches(env));
    return withCors(new Response('Not found', { status: 404 }));
  } catch (err) {
    const msg = String((err && err.message) || err);
    return withCors(Response.json({ ok: false, error: msg }, { status: 500 }));
  }
}

export default { fetch: handleRequest };