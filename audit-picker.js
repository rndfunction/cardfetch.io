// Audit page box picker. Self-contained: injects its own modal markup on
// load, exposes window.AuditPicker.open(opts). Used by /audit.html to
// replace free-text prompt() box entry with a dropdown of existing boxes
// plus a "New box..." option that reveals a text field.
//
// API:
//   AuditPicker.open({
//     title:    string,
//     subtitle: string,
//     boxList:  array of box codes (existing boxes to offer),
//     excludeBox: optional string, excluded from the list,
//     onPick:   function(chosenBox) -> Promise|void
//   });
//
// The onPick callback receives the chosen box code (existing or new).
// Callers do their own fetch and status handling; this file only handles
// the picker UI.

(function () {
  'use strict';

  let els = null;
  let currentOpts = null;

  function build() {
    if (els) return els;
    const root = document.createElement('div');
    root.id = 'auditPicker';
    root.style.cssText = 'display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(15,23,42,0.35); z-index:2000; align-items:center; justify-content:center;';
    root.innerHTML = '' +
      '<div style="background:white; border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,0.2); padding:18px; width:340px; max-width:calc(100vw - 40px); font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
        '<div id="auditPickerTitle" style="font-size:14px; font-weight:600; color:#1a1a2e; margin-bottom:6px;"></div>' +
        '<div id="auditPickerSubtitle" style="font-size:12px; color:#6b7280; margin-bottom:10px;"></div>' +
        '<select id="auditPickerSelect" style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; box-sizing:border-box; background:white;">' +
          '<option value="">— pick a box —</option>' +
        '</select>' +
        '<div id="auditPickerNewWrap" style="display:none; margin-top:8px;">' +
          '<input type="text" id="auditPickerNewBox" placeholder="New box code (e.g. 110526-1)" autocomplete="off" ' +
            'style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; box-sizing:border-box;">' +
          '<div style="font-size:11px; color:#b45309; margin-top:4px;">This box doesn\'t exist yet — it will be created.</div>' +
        '</div>' +
        '<div style="display:flex; gap:8px; margin-top:14px; justify-content:flex-end;">' +
          '<button type="button" id="auditPickerCancel" style="padding:6px 12px; border:1px solid #d1d5db; background:white; border-radius:6px; font-size:12px; cursor:pointer;">Cancel</button>' +
          '<button type="button" id="auditPickerConfirm" style="padding:6px 12px; border:none; background:#6366f1; color:white; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    const select = root.querySelector('#auditPickerSelect');
    const newWrap = root.querySelector('#auditPickerNewWrap');
    const newBox = root.querySelector('#auditPickerNewBox');
    const cancelBtn = root.querySelector('#auditPickerCancel');
    const confirmBtn = root.querySelector('#auditPickerConfirm');

    function close() {
      root.style.display = 'none';
      currentOpts = null;
      select.value = '';
      newWrap.style.display = 'none';
      newBox.value = '';
    }

    function confirm() {
      const v = select.value;
      let chosen = '';
      if (v === '__new__') {
        chosen = (newBox.value || '').trim();
      } else {
        chosen = v || '';
      }
      if (!chosen) {
        // No selection: just focus the select, don't call onPick.
        select.focus();
        return;
      }
      const opts = currentOpts;
      close();
      if (opts && typeof opts.onPick === 'function') {
        try { opts.onPick(chosen); } catch (e) { console.error('AuditPicker onPick threw:', e); }
      }
    }

    select.addEventListener('change', function () {
      if (select.value === '__new__') {
        newWrap.style.display = 'block';
        setTimeout(function () { newBox.focus(); }, 10);
      } else {
        newWrap.style.display = 'none';
        newBox.value = '';
      }
    });
    newBox.addEventListener('input', function () { /* no mirror needed; confirm reads newBox directly */ });
    newBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    select.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', confirm);
    // Click outside the inner panel closes the picker.
    root.addEventListener('click', function (e) {
      if (e.target === root) close();
    });

    els = { root, select, newWrap, newBox, cancel: cancelBtn, confirm: confirmBtn, close };
    return els;
  }

  function open(opts) {
    const e = build();
    currentOpts = opts || {};
    e.root.querySelector('#auditPickerTitle').textContent = currentOpts.title || 'Pick a box';
    e.root.querySelector('#auditPickerSubtitle').textContent = currentOpts.subtitle || '';
    // Reset options to just the placeholder.
    while (e.select.options.length > 1) e.select.remove(1);
    const boxes = (currentOpts.boxList || [])
      .filter(function (b) { return b && b !== currentOpts.excludeBox; })
      .sort();
    for (const b of boxes) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      e.select.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '➕ New box…';
    e.select.appendChild(newOpt);
    e.select.value = '';
    e.newWrap.style.display = 'none';
    e.newBox.value = '';
    e.root.style.display = 'flex';
    setTimeout(function () { e.select.focus(); }, 10);
  }

  window.AuditPicker = { open: open };
})();