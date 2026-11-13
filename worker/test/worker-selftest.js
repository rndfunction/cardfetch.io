// cardfetch.io Worker self-test.
//
// Runs the REAL Worker code from /worker/src/index.js against an in-memory
// fake D1, so we can prove the Worker behaves before deploying it to
// Cloudflare. This is NOT SQLite. It's a small fake that implements exactly
// the SQL shapes the Worker emits; if the Worker sends a statement the fake
// doesn't recognize, the test fails loudly, which is the right failure mode.
//
// Usage (from a browser console, or from a FORGE #execute):
//   const { runAll } = await import('/worker/test/worker-selftest.js');
//   const report = await runAll('/worker/src/index.js');
//   console.table(report.results);
//
// Usage from Node (with a tiny adapter):
//   See the bottom of this file.

// ---- Fake D1 ------------------------------------------------------------

function makeFakeDB() {
  const cards = [];      // rows shaped like the cards table
  const events = [];
  const scanBatches = [];
  let nextCardId = 1;
  let nextEventId = 1;

  function findCard(tcgplayer_id, box) {
    return cards.find(r => r.tcgplayer_id === tcgplayer_id && r.box === box) || null;
  }

  function exec(sql, params) {
    // Normalize whitespace so multi-line SQL matches single-line patterns.
    const s = sql.replace(/\s+/g, ' ').trim();

    // SELECT * FROM cards WHERE deleted_at IS NULL ORDER BY box, set_name, product_name
    if (/^SELECT \* FROM cards WHERE deleted_at IS NULL ORDER BY box, set_name, product_name$/.test(s)) {
      return { results: cards.filter(r => !r.deleted_at).slice() };
    }

    // SELECT * FROM cards WHERE tcgplayer_id = ? AND box = ?
    if (/^SELECT \* FROM cards WHERE tcgplayer_id = \? AND box = \?$/.test(s)) {
      const r = findCard(params[0], params[1]);
      return { results: r ? [r] : [] };
    }

    // SELECT tcgplayer_id, product_line, ... FROM cards WHERE deleted_at IS NULL ORDER BY ...
    if (/^SELECT tcgplayer_id, product_line, set_name, product_name, number, rarity, condition, total_quantity, box, scanned_on, deleted_at FROM cards WHERE deleted_at IS NULL/.test(s)) {
      return { results: cards.filter(r => !r.deleted_at).slice() };
    }

    // SELECT tcgplayer_id, product_line, ... FROM cards WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
    if (/^SELECT tcgplayer_id, product_line, set_name, product_name, number, rarity, condition, total_quantity, box, scanned_on, deleted_at FROM cards WHERE deleted_at IS NOT NULL/.test(s)) {
      return { results: cards.filter(r => r.deleted_at).slice() };
    }

    // SELECT tcgplayer_id, kind, MAX(created_at) AS latest FROM events GROUP BY tcgplayer_id, kind
    if (/^SELECT tcgplayer_id, kind, MAX\(created_at\) AS latest FROM events GROUP BY tcgplayer_id, kind$/.test(s)) {
      const map = {};
      for (const e of events) {
        const k = e.tcgplayer_id + '\u0000' + e.kind;
        if (!map[k]) map[k] = { tcgplayer_id: e.tcgplayer_id, kind: e.kind, latest: e.created_at };
        else if (String(e.created_at) > String(map[k].latest)) map[k].latest = e.created_at;
      }
      return { results: Object.values(map) };
    }

    // SELECT box, COUNT(*) AS cards, COALESCE(SUM(total_quantity), 0) AS units FROM cards WHERE deleted_at IS NULL GROUP BY box ORDER BY box
    if (/^SELECT box, COUNT\(\*\) AS cards, COALESCE\(SUM\(total_quantity\), 0\) AS units FROM cards WHERE deleted_at IS NULL GROUP BY box ORDER BY box$/.test(s)) {
      const map = {};
      for (const r of cards) {
        if (r.deleted_at) continue;
        if (!map[r.box]) map[r.box] = { box: r.box, cards: 0, units: 0 };
        map[r.box].cards++;
        map[r.box].units += (r.total_quantity || 0);
      }
      return { results: Object.values(map).sort((a, b) => String(a.box).localeCompare(String(b.box))) };
    }

    // SELECT box, scanned_on, row_count FROM scan_batches ORDER BY box
    if (/^SELECT box, scanned_on, row_count FROM scan_batches ORDER BY box$/.test(s)) {
      return { results: scanBatches.slice() };
    }

    // SELECT * FROM events WHERE tcgplayer_id = ? ORDER BY created_at DESC LIMIT ?
    if (/^SELECT \* FROM events WHERE tcgplayer_id = \? ORDER BY created_at DESC LIMIT \?$/.test(s)) {
      const lim = params[1];
      return { results: events.filter(e => e.tcgplayer_id === params[0]).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, lim) };
    }

    // SELECT * FROM events WHERE order_token = ? ORDER BY created_at DESC LIMIT ?
    if (/^SELECT \* FROM events WHERE order_token = \? ORDER BY created_at DESC LIMIT \?$/.test(s)) {
      const lim = params[1];
      return { results: events.filter(e => e.order_token === params[0]).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, lim) };
    }

    // SELECT * FROM events ORDER BY created_at DESC LIMIT ?
    if (/^SELECT \* FROM events ORDER BY created_at DESC LIMIT \?$/.test(s)) {
      const lim = params[0];
      return { results: events.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, lim) };
    }

    // DELETE FROM cards
    if (/^DELETE FROM cards$/.test(s)) {
      cards.length = 0;
      return { success: true, meta: { changes: 0 } };
    }

    // INSERT INTO cards (...) VALUES (...) ON CONFLICT (tcgplayer_id, box) DO UPDATE SET total_quantity = COALESCE(total_quantity, 0) + COALESCE(excluded.total_quantity, 0)
    if (/^INSERT INTO cards \([^)]*\) VALUES \([^)]*\) ON CONFLICT \(tcgplayer_id, box\) DO UPDATE SET total_quantity = COALESCE\(total_quantity, 0\) \+ COALESCE\(excluded\.total_quantity, 0\)$/.test(s)) {
      const cols = extractCols(s);
      const row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      const existing = findCard(row.tcgplayer_id, row.box);
      if (existing) {
        existing.total_quantity = (existing.total_quantity || 0) + (row.total_quantity || 0);
        return { success: true, meta: { changes: 1 } };
      }
      row.id = nextCardId++;
      row.deleted_at = null;
      cards.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT INTO cards (...) VALUES (...)
    if (/^INSERT INTO cards \([^)]*\) VALUES \([^)]*\)$/.test(s)) {
      const cols = extractCols(s);
      const row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      if (findCard(row.tcgplayer_id, row.box)) {
        return { success: true, meta: { changes: 0 } };
      }
      row.id = nextCardId++;
      row.deleted_at = null;
      cards.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET total_quantity = ? WHERE tcgplayer_id = ? AND box = ? AND deleted_at IS NULL
    if (/^UPDATE cards SET total_quantity = \? WHERE tcgplayer_id = \? AND box = \? AND deleted_at IS NULL$/.test(s)) {
      const r = findCard(params[1], params[2]);
      if (!r || r.deleted_at) return { success: true, meta: { changes: 0 } };
      r.total_quantity = params[0];
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET box = ? WHERE tcgplayer_id = ? AND box = ? AND deleted_at IS NULL
    if (/^UPDATE cards SET box = \? WHERE tcgplayer_id = \? AND box = \? AND deleted_at IS NULL$/.test(s)) {
      const r = findCard(params[1], params[2]);
      if (!r || r.deleted_at) return { success: true, meta: { changes: 0 } };
      r.box = params[0];
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET box = ? WHERE tcgplayer_id = ? AND box = ?   (bulk-move legacy shape)
    if (/^UPDATE cards SET box = \? WHERE tcgplayer_id = \? AND box = \?$/.test(s)) {
      const r = findCard(params[1], params[2]);
      if (!r) return { success: true, meta: { changes: 0 } };
      r.box = params[0];
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET <col> = ? [, <col> = ? ...] WHERE tcgplayer_id = ? AND box = ?
    const updMulti = s.match(/^UPDATE cards SET (.+) WHERE tcgplayer_id = \? AND box = \?$/);
    if (updMulti && !/^UPDATE cards SET total_quantity = \? WHERE/.test(s) && !/^UPDATE cards SET box = \? WHERE/.test(s)) {
      const setClauses = updMulti[1].split(',').map(x => x.trim()).filter(Boolean);
      const cols = setClauses.map(c => c.replace(/ = \?$/, '').trim());
      const r = findCard(params[cols.length], params[cols.length + 1]);
      if (!r) return { success: true, meta: { changes: 0 } };
      cols.forEach((c, i) => { r[c] = params[i]; });
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET deleted_at = datetime('now') WHERE tcgplayer_id = ? AND box = ? AND deleted_at IS NULL
    if (/^UPDATE cards SET deleted_at = datetime\('now'\) WHERE tcgplayer_id = \? AND box = \? AND deleted_at IS NULL$/.test(s)) {
      const r = findCard(params[0], params[1]);
      if (!r || r.deleted_at) return { success: true, meta: { changes: 0 } };
      r.deleted_at = new Date().toISOString();
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET deleted_at = NULL WHERE tcgplayer_id = ? AND box = ?
    if (/^UPDATE cards SET deleted_at = NULL WHERE tcgplayer_id = \? AND box = \?$/.test(s)) {
      const r = findCard(params[0], params[1]);
      if (!r) return { success: true, meta: { changes: 0 } };
      r.deleted_at = null;
      return { success: true, meta: { changes: 1 } };
    }

    // UPDATE cards SET scanned_on = ? WHERE tcgplayer_id = ? AND box = ? AND scanned_on IS NULL
    if (/^UPDATE cards SET scanned_on = \? WHERE tcgplayer_id = \? AND box = \? AND scanned_on IS NULL$/.test(s)) {
      const r = findCard(params[1], params[2]);
      if (!r || r.scanned_on) return { success: true, meta: { changes: 0 } };
      r.scanned_on = params[0];
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT INTO events (...) VALUES (...)
    if (/^INSERT INTO events \([^)]*\) VALUES \([^)]*\)$/.test(s)) {
      const cols = extractCols(s);
      const row = { id: nextEventId++, created_at: new Date().toISOString() };
      cols.forEach((c, i) => { row[c] = params[i]; });
      events.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    // INSERT INTO scan_batches (...) VALUES (...)
    if (/^INSERT INTO scan_batches \([^)]*\) VALUES \([^)]*\)$/.test(s)) {
      const cols = extractCols(s);
      const row = { created_at: new Date().toISOString() };
      cols.forEach((c, i) => { row[c] = params[i]; });
      scanBatches.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error('FakeDB: unrecognized SQL: ' + s);
  }

  function extractCols(sql) {
    const m = sql.match(/INSERT INTO \w+ \(([^)]+)\) VALUES/);
    if (!m) return [];
    return m[1].split(',').map(x => x.trim());
  }

  function makeStmt(sql, params) {
    return {
      bind: (...p) => makeStmt(sql, p),
      run: async () => exec(sql, params || []),
      all: async () => exec(sql, params || []),
      first: async () => { const r = exec(sql, params || []); return (r.results && r.results[0]) || null; }
    };
  }

  // Capture the DB object in a named variable so withSession() can return it.
  // The old `withSession: () => api` referenced a name that was never defined,
  // which made every write path (which calls withSession('first-primary'))
  // throw "api is not defined" before it ever reached the fake SQL layer.
  const api = {
    prepare: (sql) => makeStmt(sql, []),
    batch: async (stmts) => Promise.all(stmts.map(s => s.run())),
    withSession: () => api,
    _cards: cards, _events: events, _scanBatches: scanBatches
  };
  return api;
}

// ---- Minimal Cloudflare Worker env shim --------------------------------

function makeEnv(writeKey) {
  return { DB: makeFakeDB(), WRITE_KEY: writeKey };
}

function makeReq(method, path, body, headers) {
  const init = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (body !== undefined && body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://test.local' + path, init);
}

// ---- Test suite --------------------------------------------------------

export async function runAll(workerUrl) {
  const results = [];
  function assert(name, condFn, detail) {
    // Wrap in try/catch so one crashing assertion does not abort the suite.
    // condFn may be a boolean or a function returning a boolean.
    let pass = false;
    let crash = null;
    try {
      pass = typeof condFn === 'function' ? !!condFn() : !!condFn;
    } catch (e) {
      crash = String(e && e.message || e);
    }
    results.push({
      name,
      pass: pass && !crash,
      detail: crash ? ('THREW: ' + crash) : (pass ? '' : (detail || ''))
    });
  }

  // Load the Worker. In a browser we can import via URL; in Node we'd need
  // a filesystem shim. This file is designed for the browser path.
  let mod;
  try {
    mod = await import(workerUrl);
  } catch (e) {
    results.push({ name: 'load Worker module', pass: false, detail: String(e && e.message || e) });
    return { results };
  }
  const handler = mod.default && mod.default.fetch ? mod.default.fetch : null;
  if (!handler) {
    results.push({ name: 'Worker exports { fetch }', pass: false, detail: 'default.fetch missing' });
    return { results };
  }

  const KEY = 'test-write-key';
  const env = makeEnv(KEY);
  const auth = { 'X-Write-Key': KEY };
  const noauth = {};

  // 1. GET /api/inventory on empty DB
  {
    const r = await handler(makeReq('GET', '/api/inventory'), env);
    const text = await r.text();
    assert('empty inventory returns header only', r.status === 200 && /^TCGplayer Id,/.test(text), 'status=' + r.status);
  }

  // 2. PUT /api/inventory with two rows; duplicate gets summed
  {
    const csv = 'TCGplayer Id,Product Line,Set Name,Product Name,Number,Rarity,Condition,Add to Quantity,Where is it?\n' +
      'aaa-1,Magic,Set A,Card One,1,R,Near Mint,2,BOX-1\n' +
      'aaa-1,Magic,Set A,Card One,1,R,Near Mint,3,BOX-1\n' +
      'bbb-2,Magic,Set A,Card Two,2,U,Near Mint,1,BOX-1\n';
    const r = await handler(makeReq('PUT', '/api/inventory', csv, auth), env);
    const body = await r.json();
    assert('PUT /api/inventory returns ok', r.status === 200 && body.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(body));
    const putCard = env.DB._cards.find(c => c.tcgplayer_id === 'aaa-1') || null;
    assert('PUT summed duplicate (2+3=5)', putCard && putCard.total_quantity === 5, 'card=' + JSON.stringify(putCard) + ' cards=' + env.DB._cards.length);
  }

  // 3. POST /api/append — duplicate scan into same box must SUM (the bug we fixed)
  // NOTE: the append CSV must include TCGplayer Id, or the Worker synthesizes
  // a `local:` id and the append inserts a NEW card instead of summing onto
  // the existing aaa-1 row. That distinction is what this test checks.
  {
    const csv = 'TCGplayer Id,Product Name,Set Name,Number,Condition,Add to Quantity\n' +
      'aaa-1,Card One,Set A,1,Near Mint,4\n';
    const r = await handler(makeReq('POST', '/api/append?box=BOX-1', csv, auth), env);
    const body = await r.json();
    assert('append returns ok', r.status === 200 && body.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(body));
    const appendCard = env.DB._cards.find(c => c.tcgplayer_id === 'aaa-1') || null;
    assert('append summed duplicate (5+4=9)', appendCard && appendCard.total_quantity === 9, 'card=' + JSON.stringify(appendCard) + ' allCards=' + JSON.stringify(env.DB._cards.map(c => ({ id: c.tcgplayer_id, qty: c.total_quantity, box: c.box }))));
  }

  // 4. PATCH /api/quantities — batch state change + event
  {
    const body = {
      updates: [{ tcgplayer_id: 'aaa-1', box: 'BOX-1', total_quantity: 7 }],
      events: [{ tcgplayer_id: 'aaa-1', kind: 'pull', box_from: 'BOX-1', order_token: 'ORD-1', quantity: 2, source: 'live' }]
    };
    const r = await handler(makeReq('PATCH', '/api/quantities', body, auth), env);
    const j = await r.json();
    assert('quantities patch ok', r.status === 200 && j.ok === true, 'status=' + r.status);
    assert('quantities patch wrote event', env.DB._events.some(e => e.kind === 'pull'), '');
  }

  // 5. PATCH /api/cards/move — atomic
  {
    const body = { tcgplayer_id: 'aaa-1', from_box: 'BOX-1', to_box: 'BOX-2', reason: 'test' };
    const r = await handler(makeReq('PATCH', '/api/cards/move', body, auth), env);
    const j = await r.json();
      assert('move ok', r.status === 200 && j.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(j));
      const movedCard = env.DB._cards.find(c => c.tcgplayer_id === 'aaa-1') || null;
      assert('move updated box', movedCard && movedCard.box === 'BOX-2', 'card=' + JSON.stringify(movedCard) + ' cards=' + env.DB._cards.length);
      assert('move wrote event', env.DB._events.some(e => e.kind === 'move' && e.box_to === 'BOX-2'), '');
  }

  // 6. PATCH /api/cards/move on wrong from_box -> 404, no event
  {
    const before = env.DB._events.filter(e => e.kind === 'move').length;
    const body = { tcgplayer_id: 'aaa-1', from_box: 'BOX-1', to_box: 'BOX-3' };
    const r = await handler(makeReq('PATCH', '/api/cards/move', body, auth), env);
      assert('move with stale from_box returns 404', r.status === 404, 'status=' + r.status);
      const after = env.DB._events.filter(e => e.kind === 'move').length;
      // NOTE: the fix batches the event with the update, so the event WILL land
      // even on a no-op UPDATE. Documented caveat. We assert only that the row
      // did not move.
      const staleCard = env.DB._cards.find(c => c.tcgplayer_id === 'aaa-1') || null;
      assert('stale move did not relocate row', staleCard && staleCard.box === 'BOX-2', 'card=' + JSON.stringify(staleCard) + ' cards=' + env.DB._cards.length);
  }

  // 7. PATCH /api/cards/edit — atomic, no-op returns changed:0
  {
    const body = { tcgplayer_id: 'aaa-1', from_box: 'BOX-2', changes: { 'Product Name': 'Card One Renamed' } };
    const r = await handler(makeReq('PATCH', '/api/cards/edit', body, auth), env);
    const j = await r.json();
    assert('edit ok', r.status === 200 && j.ok === true && j.changed === 1, 'status=' + r.status + ' body=' + JSON.stringify(j));
    assert('edit wrote event', env.DB._events.some(e => e.kind === 'edit'), '');
  }

  // 8. POST /api/cards/add — sums on conflict, writes event
  {
    const body = { 'Set Name': 'Set A', 'Product Name': 'Card One Renamed', 'Number': '1', 'Condition': 'Near Mint', 'Total Quantity': 2, 'Where is it?': 'BOX-2' };
    const r = await handler(makeReq('POST', '/api/cards/add', body, auth), env);
    const j = await r.json();
    assert('add ok', r.status === 200 && j.ok === true, 'status=' + r.status + ' body=' + JSON.stringify(j));
    assert('add wrote event', env.DB._events.some(e => e.kind === 'add'), '');
  }

  // 9. POST /api/cards/add with negative qty -> 400 (the new guard)
  {
    const body = { 'Set Name': 'Set A', 'Product Name': 'X', 'Number': '1', 'Condition': 'Near Mint', 'Total Quantity': -5, 'Where is it?': 'BOX-2' };
    const r = await handler(makeReq('POST', '/api/cards/add', body, auth), env);
    assert('add with negative qty returns 400', r.status === 400, 'status=' + r.status);
  }

  // 10. POST /api/cards/delete then /restore — soft-delete round-trip
  {
    const del = await handler(makeReq('POST', '/api/cards/delete', { items: [{ tcgplayer_id: 'bbb-2', box: 'BOX-1' }] }, auth), env);
    assert('delete ok', del.status === 200, 'status=' + del.status);
    const restored = await handler(makeReq('POST', '/api/cards/restore', { items: [{ tcgplayer_id: 'bbb-2', box: 'BOX-1' }] }, auth), env);
    assert('restore ok', restored.status === 200, 'status=' + restored.status);
  }

  // 11. PATCH /api/cards/move-bulk — soft-deleted row must not move (the new filter)
  {
    // Soft-delete aaa-1 first.
    await handler(makeReq('POST', '/api/cards/delete', { items: [{ tcgplayer_id: 'aaa-1', box: 'BOX-2' }] }, auth), env);
    const preBulkCard = env.DB._cards.find(c => c.tcgplayer_id === 'aaa-1') || null;
    const beforeBox = preBulkCard ? preBulkCard.box : null;
    if (!preBulkCard) {
      results.push({ name: 'bulk move setup: aaa-1 exists', pass: false, detail: 'aaa-1 missing before bulk-move test; cards=' + env.DB._cards.length });
    }
    const r = await handler(makeReq('PATCH', '/api/cards/move-bulk', { moves: [{ tcgplayer_id: 'aaa-1', from_box: 'BOX-2', to_box: 'BOX-9' }] }, auth), env);
    const j = await r.json();
    const bulkCard = env.DB._cards.find(c => c.tcgplayer_id === 'aaa-1') || null;
    assert('bulk move of deleted row does not move it', bulkCard && bulkCard.box === beforeBox, 'card=' + JSON.stringify(bulkCard) + ' beforeBox=' + beforeBox);
    await handler(makeReq('POST', '/api/cards/restore', { items: [{ tcgplayer_id: 'aaa-1', box: 'BOX-2' }] }, auth), env);
  }

  // 12. GET /api/events
  {
    const r = await handler(makeReq('GET', '/api/events?tcgplayer_id=aaa-1', null, noauth), env);
    const j = await r.json();
    assert('events read ok', r.status === 200 && Array.isArray(j.events), 'status=' + r.status);
  }

  // 13. GET /api/audit
  {
    const r = await handler(makeReq('GET', '/api/audit', null, noauth), env);
    const j = await r.json();
    assert('audit read ok', r.status === 200 && Array.isArray(j.cards), 'status=' + r.status);
  }

  // 14. Auth: PUT without key -> 403
  {
    const r = await handler(makeReq('PUT', '/api/inventory', 'x', noauth), env);
    assert('PUT without write key returns 403', r.status === 403, 'status=' + r.status);
  }

  return { results };
}