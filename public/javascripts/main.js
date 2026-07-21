(function () {
  'use strict';

  var subjectEl = document.getElementById('subcode');
  var deptEl = document.getElementById('dept');
  var groupsEl = document.getElementById('groups');
  var typeEl = document.getElementById('paper_type');
  var pktEl = document.getElementById('pkt_no');
  var scriptsEl = document.getElementById('no_of_scripts');
  var saveBtn = document.getElementById('saveBtn');
  var msgEl = document.getElementById('entryMsg');
  var suggestEl = document.getElementById('subSuggest');
  var dateEl = document.getElementById('doe');
  var todayLinkEl = document.getElementById('todayLink');
  var tbody = document.querySelector('#recentTable tbody');

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  var searchEl = document.getElementById('pktSearch');
  var searchClearEl = document.getElementById('pktSearchClear');
  var listTitleEl = document.getElementById('listTitle');

  if (!subjectEl) return; // page has no entry form

  // Set the "No. of groups" dropdown to a count (clamped to available options).
  function setGroups(count) {
    var n = parseInt(count, 10) || 1;
    var max = groupsEl.options.length;
    if (n > max) n = max;
    if (n < 1) n = 1;
    groupsEl.value = String(n);
  }

  // Ask the server for the next packet number for the current subject + type.
  function refreshPkt() {
    var sub = subjectEl.value, type = typeEl.value;
    if (!sub || !type) { pktEl.value = 1; return; }
    var url = '/api/nextpkt?subcode=' + encodeURIComponent(sub) +
              '&type=' + encodeURIComponent(type);
    fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.pkt_no) pktEl.value = d.pkt_no;
    }).catch(function () {});
  }

  // Apply a chosen subject: fill dept, default group count, and refresh pkt no.
  function applySubject(s) {
    subjectEl.value = s.subcode;
    subjectEl.dataset.selected = s.subcode;   // marks a valid, resolved subject
    deptEl.value = (s.dept || '').trim();
    setGroups(s.total_scripts);               // auto-select the subject's group count
    typeEl.value = 'REGULAR';                 // default type resets to REGULAR per subject
    refreshPkt();
  }

  function clearSubject() {
    subjectEl.dataset.selected = '';
    deptEl.value = '';
    pktEl.value = 1;
  }

  /* ---------------- Subject autocomplete ---------------- */
  var suggestions = [];
  var activeIdx = -1;
  var debounceTimer = null;

  function hideSuggest() { suggestEl.hidden = true; suggestEl.innerHTML = ''; suggestions = []; activeIdx = -1; }

  function renderSuggest(list) {
    suggestions = list;
    activeIdx = -1;
    if (!list.length) {
      suggestEl.innerHTML = '<li class="none">No match</li>';
      suggestEl.hidden = false;
      return;
    }
    suggestEl.innerHTML = list.map(function (s, i) {
      return '<li data-i="' + i + '"><span>' + s.subcode + '</span>' +
             '<small>' + (s.dept || '') + ' &middot; ' + s.total_scripts + ' grp</small></li>';
    }).join('');
    suggestEl.hidden = false;
  }

  function setActive(i) {
    var items = suggestEl.querySelectorAll('li[data-i]');
    if (!items.length) return;
    if (i < 0) i = items.length - 1;
    if (i >= items.length) i = 0;
    activeIdx = i;
    items.forEach(function (li, idx) { li.classList.toggle('active', idx === activeIdx); });
    items[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  function chooseActive() {
    if (activeIdx >= 0 && suggestions[activeIdx]) {
      applySubject(suggestions[activeIdx]);
      hideSuggest();
      typeEl.focus();
      return true;
    }
    return false;
  }

  // Fetch suggestions for the current subject text + selected exam date.
  function fetchSuggest() {
    var q = subjectEl.value.trim();
    var date = dateEl ? dateEl.value : '';
    // Need 3+ chars UNLESS an exam date is chosen (then list all subjects of that day).
    if (!date && q.length < 3) { hideSuggest(); return; }
    var url = '/api/subjects?q=' + encodeURIComponent(q) + '&date=' + encodeURIComponent(date);
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (list) { renderSuggest(list); })
      .catch(function () { hideSuggest(); });
  }

  subjectEl.addEventListener('input', function () {
    clearSubject(); // typing invalidates any previous selection
    clearTimeout(debounceTimer);
    var q = subjectEl.value.trim();
    var date = dateEl ? dateEl.value : '';
    if (!date && q.length < 3) { hideSuggest(); return; }
    debounceTimer = setTimeout(fetchSuggest, 180);
  });

  // With an exam date chosen, focusing the empty subject box lists that day's subjects.
  subjectEl.addEventListener('focus', function () {
    if (dateEl && dateEl.value && !subjectEl.dataset.selected) fetchSuggest();
  });

  subjectEl.addEventListener('keydown', function (e) {
    if (suggestEl.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') { if (chooseActive()) e.preventDefault(); }
    else if (e.key === 'Tab') {
      // Tab selects the highlighted suggestion, or the first one if none is highlighted.
      if (suggestions.length) {
        applySubject(suggestions[activeIdx >= 0 ? activeIdx : 0]);
        hideSuggest();
        e.preventDefault();
        groupsEl.focus();
      }
    }
    else if (e.key === 'Escape') { hideSuggest(); }
  });

  suggestEl.addEventListener('mousedown', function (e) {
    var li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    applySubject(suggestions[parseInt(li.getAttribute('data-i'), 10)]);
    hideSuggest();
    typeEl.focus();
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.autocomplete')) hideSuggest();
  });

  // Changing the exam date resets the subject and reopens the list for that day.
  if (dateEl) {
    if (!dateEl.value) dateEl.value = todayStr(); // always default to today
    dateEl.addEventListener('change', function () {
      subjectEl.value = '';
      clearSubject();
      hideSuggest();
      subjectEl.focus();
    });
  }

  // "Today" link -> set the exam date to today and refresh the subject list.
  if (todayLinkEl && dateEl) {
    todayLinkEl.addEventListener('click', function (e) {
      e.preventDefault();
      dateEl.value = todayStr();
      dateEl.dispatchEvent(new Event('change'));
    });
  }

  // Note: changing the Type (REGULAR/ARREAR) intentionally does NOT recompute the
  // Pkt No. -- it stays as-is.

  function setMsg(text, ok) {
    msgEl.textContent = text;
    msgEl.className = 'entry-msg ' + (ok ? 'ok' : 'err');
  }

  // Build the inner cells for one packet row (handles pending/exported).
  function rowCells(r) {
    var tag = r.exported
      ? '<span class="tag ok">exported</span>'
      : '<span class="tag pend">pending</span>';
    var edit = '<button class="edit" data-id="' + r.id + '" title="edit no. of scripts">&#9998;</button>';
    var del = '<button class="del" data-id="' + r.id + '" data-exported="' + (r.exported ? 1 : 0) +
              '" title="delete">&times;</button>';
    return '<td class="sno"></td>' +
      '<td>' + r.subcode + '</td>' +
      '<td>' + r.dept + '</td>' +
      '<td>' + r.groups + '</td>' +
      '<td>' + r.paper_type + '</td>' +
      '<td>' + r.pkt_no + '</td>' +
      '<td>' + r.no_of_scripts + '</td>' +
      '<td>' + tag + '</td>' +
      '<td class="actions-cell">' + edit + del + '</td>';
  }

  // Prepend a freshly saved (pending) row to the table.
  function prependRow(id, s) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-id', id);
    tr.className = 'flash-row';
    tr.innerHTML = rowCells({
      id: id, subcode: s.subcode, dept: s.dept, groups: s.groups,
      paper_type: s.paper_type, pkt_no: s.pkt_no, no_of_scripts: s.no_of_scripts, exported: 0
    });
    tbody.insertBefore(tr, tbody.firstChild);
    renumberRows();
  }

  // Renumber the visible "#" column as a 1-based serial (top row = 1).
  function renumberRows() {
    var n = 0;
    tbody.querySelectorAll('tr').forEach(function (tr) {
      var c = tr.querySelector('td.sno');
      if (c) { n++; c.textContent = n; }
    });
  }

  // Replace the whole table body with a list of packet rows.
  function renderRows(list) {
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">No packets found.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function (r) {
      return '<tr data-id="' + r.id + '">' + rowCells(r) + '</tr>';
    }).join('');
    renumberRows();
  }

  function updateStats(st) {
    if (!st) return;
    document.getElementById('stTotal').textContent = st.total;
    document.getElementById('stPending').textContent = st.pending;
    document.getElementById('stScripts').textContent = st.scripts;
    var top = document.getElementById('stTotalTop');
    if (top) top.textContent = st.total;
    var exp = document.getElementById('exportBtn');
    if (exp) {
      var chg = st.pendingChanges || 0;
      exp.textContent = 'Export to SQL Server (' + st.pending + ' pkt' + (chg ? ', ' + chg + ' chg' : '') + ')';
      exp.disabled = (st.pending + chg) === 0;
    }
  }

  // Save the current packet -> bump pkt no, keep value selected. Used by both
  // pressing Enter in the scripts field and clicking the Save button.
  function savePacket() {
    if (!subjectEl.value) { setMsg('Select a subject first.', false); subjectEl.focus(); return; }
    if (subjectEl.dataset.selected !== subjectEl.value) {
      setMsg('Pick a subject from the suggestions list.', false); subjectEl.focus(); return;
    }
    var val = parseInt(scriptsEl.value, 10);
    if (!(val > 0)) { setMsg('Enter a valid number of scripts.', false); scriptsEl.focus(); return; }

    var payload = {
      subcode: subjectEl.value,
      no_of_groups: groupsEl.value,
      paper_type: typeEl.value,
      pkt_no: pktEl.value,
      no_of_scripts: val
    };

    saveBtn.disabled = true;
    fetch('/api/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { setMsg(res.d.error || 'Save failed', false); return; }
        var d = res.d;
        // One entry may create several group rows; add them newest last so A is on top.
        d.saved.slice().reverse().forEach(function (row) { prependRow(row.id, row); });
        updateStats(d.stats);
        var first = d.saved[0];
        var grps = d.saved.map(function (r) { return r.groups; }).join(',');
        var extra = '';
        if (d.groupsChange) {
          extra = ' · groups ' + d.groupsChange.old + '→' + d.groupsChange.new +
                  ' logged (applied to Script_per_candidate on export)';
        }
        setMsg('Saved pkt ' + first.pkt_no + ' — ' + d.saved.length + ' row(s) [' + grps +
               '], ' + first.no_of_scripts + ' scripts each. Next pkt: ' + d.next_pkt + extra, true);
        pktEl.value = d.next_pkt;         // pkt no. increases by 1
        scriptsEl.focus();
        scriptsEl.select();               // keep the no-of-scripts value selected
      })
      .catch(function (err) { setMsg('Error: ' + err.message, false); })
      .then(function () { saveBtn.disabled = false; });
  }

  // Enter in the "No. of scripts" field -> save.
  scriptsEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    savePacket();
  });

  // Mouse users: click Save.
  saveBtn.addEventListener('click', savePacket);

  // Edit a packet's No. of scripts (works for exported rows too).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.edit') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var row = tbody.querySelector('tr[data-id="' + id + '"]');
    if (!row) return;
    var cells = row.querySelectorAll('td');
    var wasExported = /exported/.test(cells[7].textContent);
    var current = cells[6].textContent;
    var label = cells[1].textContent + ' pkt ' + cells[5].textContent + ' grp ' + cells[3].textContent;
    var note = wasExported ? '\n(This record is already exported — it will be marked pending and re-exported to update SQL Server.)' : '';
    var val = prompt('New No. of scripts for ' + label + ':' + note, current);
    if (val === null) return;
    var n = parseInt(val, 10);
    if (!(n > 0)) { alert('Enter a valid positive number.'); return; }

    fetch('/api/entry/' + id + '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no_of_scripts: n })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { alert(res.d.error || 'Update failed'); return; }
        row.innerHTML = rowCells(res.d.row);
        row.className = 'flash-row';
        renumberRows();
        updateStats(res.d.stats);
      })
      .catch(function (err) { alert('Error: ' + err.message); });
  });

  // Delete a pending row (after confirmation).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.del') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var exported = btn.getAttribute('data-exported') === '1';
    var row = tbody.querySelector('tr[data-id="' + id + '"]');
    var cells = row ? row.querySelectorAll('td') : null;
    var label = cells
      ? cells[1].textContent + ' pkt ' + cells[5].textContent + ' grp ' + cells[3].textContent +
        ' (' + cells[6].textContent + ' scripts)'
      : 'this packet';
    var msg = exported
      ? 'Delete ' + label + '?\n\nThis record is EXPORTED — it will also be REMOVED from SQL Server (Script_Count).\nThis cannot be undone.'
      : 'Delete ' + label + '?\nThis cannot be undone.';
    if (!confirm(msg)) return;
    fetch('/api/entry/' + id + '/delete', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { alert(d.error || 'Delete failed'); return; }
        var r2 = tbody.querySelector('tr[data-id="' + id + '"]');
        if (r2) r2.parentNode.removeChild(r2);
        renumberRows();
        updateStats(d.stats);
        refreshPkt();
      })
      .catch(function (err) { alert('Error: ' + err.message); });
  });

  /* ---------------- Search saved packets by subject code ---------------- */
  var searchTimer = null;

  function showRecent() {
    fetch('/api/recent')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        renderRows(list);
        listTitleEl.firstChild.nodeValue = 'Recent Entries ';
      })
      .catch(function () {});
  }

  function runSearch(q) {
    fetch('/api/packets?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (list) {
        renderRows(list);
        var scripts = list.reduce(function (a, r) { return a + r.no_of_scripts; }, 0);
        listTitleEl.firstChild.nodeValue = 'Search: "' + q + '" — ' + list.length +
          ' row(s), ' + scripts + ' scripts ';
      })
      .catch(function () {});
  }

  if (searchEl) {
    searchEl.addEventListener('input', function () {
      var q = searchEl.value.trim();
      searchClearEl.hidden = q.length === 0;
      clearTimeout(searchTimer);
      if (q.length === 0) { showRecent(); return; }
      searchTimer = setTimeout(function () { runSearch(q); }, 200);
    });
    searchEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); runSearch(searchEl.value.trim()); }
    });
    searchClearEl.addEventListener('click', function () {
      searchEl.value = '';
      searchClearEl.hidden = true;
      showRecent();
      searchEl.focus();
    });
  }

  // Start with a clean subject state.
  clearSubject();
  subjectEl.value = '';
})();
