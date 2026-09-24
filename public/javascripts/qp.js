(function () {
  'use strict';

  var boot = JSON.parse(document.getElementById('qpBootstrap').textContent || '{}');

  var dateSel = document.getElementById('dateSel');
  var railEl = document.getElementById('rail');
  var railSummaryEl = document.getElementById('railSummary');
  var unplannedWrap = document.getElementById('unplannedWrap');
  var unplannedToggle = document.getElementById('unplannedToggle');
  var unplannedEl = document.getElementById('unplanned');

  var bodyEl = document.getElementById('qpBody');
  var footEl = document.getElementById('qpFoot');
  var newRoomEl = document.getElementById('newRoom');
  var newQtyEl = document.getElementById('newQty');
  var newMaxEl = document.getElementById('newMax');
  var msgEl = document.getElementById('qpMsg');
  var problemsEl = document.getElementById('problems');

  var copySrcEl = document.getElementById('copySrc');
  var copyQtyEl = document.getElementById('copyQty');
  var loadAllBtn = document.getElementById('loadAllBtn');
  var fillMaxBtn = document.getElementById('fillMaxBtn');
  var clearBtn = document.getElementById('clearBtn');
  var unlockBtn = document.getElementById('unlockBtn');
  var finaliseBtn = document.getElementById('finaliseBtn');

  var ctxCode = document.getElementById('ctxCode');
  var ctxMeta = document.getElementById('ctxMeta');
  var ctxDept = document.getElementById('ctxDept');
  var ctxSem = document.getElementById('ctxSem');
  var ctxReg = document.getElementById('ctxReg');
  var ctxArr = document.getElementById('ctxArr');
  var ctxReq = document.getElementById('ctxReq');
  var ctxLock = document.getElementById('ctxLock');

  var fRooms = document.getElementById('fRooms');
  var fAllot = document.getElementById('fAllot');
  var fReq = document.getElementById('fReq');
  var fBal = document.getElementById('fBal');
  var fBlanks = document.getElementById('fBlanks');

  var state = {
    date: boot.date,
    subjects: boot.subjects || [],
    summary: boot.summary,
    current: null,      // { subcode, dept, sem, doe }
    payload: null,      // last /api/qp/subject response
    maxByRoom: {}
  };

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function say(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'entry-msg' + (kind ? ' ' + kind : '');
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function keyBody(extra) {
    var b = { subcode: state.current.subcode, doe: state.current.doe };
    return Object.assign(b, extra || {});
  }

  /* ---------------- subject rail ---------------- */

  // Status of a subject as the rail shows it.
  function railStatus(s) {
    if (s.status === 'exported') return 'exported';
    if (s.status === 'final') return 'final';
    if (s.req_total == null) return 'nocount';
    if (!s.rooms) return 'empty';
    if (s.blanks > 0) return 'partial';
    if (s.allotted < s.req_total) return 'partial';
    if (s.allotted > s.req_total * 1.25 && s.allotted - s.req_total > 25) return 'over';
    return 'done';
  }

  // Unfinished subjects float to the top; everything else keeps code order.
  function railRank(s) {
    var st = railStatus(s);
    if (st === 'final' || st === 'exported') return 2;
    if (st === 'done' || st === 'over') return 1;
    return 0;
  }

  function railItem(s) {
    var st = railStatus(s);
    var isCur = state.current && s.subcode === state.current.subcode &&
                s.dept === state.current.dept && s.sem === state.current.sem;
    var badge = s.req_total == null
      ? '<small class="text-slate-400">no count</small>'
      : '<small class="tabular-nums">' + s.allotted + '<span class="text-slate-400">/' + s.req_total + '</span></small>';
    return '<li><button type="button" class="rail-item' + (isCur ? ' active' : '') + '"' +
           ' data-sub="' + esc(s.subcode) + '">' +
           '<span class="dot dot-' + st + '"></span>' +
           '<span class="min-w-0 flex-1"><b class="block truncate">' + esc(s.subcode) + '</b>' +
           '<span class="block text-[.7rem] text-slate-500 truncate">' + esc(s.dept) +
           (s.sem ? ' &middot; ' + esc(s.sem) : '') + '</span></span>' +
           badge + '</button></li>';
  }

  function renderRail() {
    var planned = state.subjects.filter(function (s) { return s.req_total != null; });
    var unplanned = state.subjects.filter(function (s) { return s.req_total == null; });

    planned.sort(function (a, b) {
      return railRank(a) - railRank(b) || (a.subcode < b.subcode ? -1 : a.subcode > b.subcode ? 1 : 0);
    });

    railEl.innerHTML = planned.length
      ? planned.map(railItem).join('')
      : '<li class="text-[.8rem] text-slate-400 py-2">No subjects with a count on this date.</li>';

    if (state.summary) {
      railSummaryEl.textContent = state.summary.final + '/' + state.summary.subjects + ' done';
    }

    // Subjects with no Count row for this campus: shown, not hidden, so a missing
    // Count is visible instead of silent.
    if (unplanned.length) {
      unplannedWrap.hidden = false;
      unplannedToggle.textContent = 'Not in Count (campus) — ' + unplanned.length + ' subject' +
        (unplanned.length === 1 ? '' : 's');
      unplannedEl.innerHTML = unplanned.map(railItem).join('');
    } else {
      unplannedWrap.hidden = true;
      unplannedEl.innerHTML = '';
    }
  }

  unplannedToggle.addEventListener('click', function () {
    unplannedEl.hidden = !unplannedEl.hidden;
  });

  function onRailClick(e) {
    var btn = e.target.closest('.rail-item');
    if (!btn) return;
    selectSubject(btn.dataset.sub);
  }
  railEl.addEventListener('click', onRailClick);
  unplannedEl.addEventListener('click', onRailClick);

  /* ---------------- grid ---------------- */

  function rowHtml(r, i, running) {
    var maxTxt = r.max_qty ? r.max_qty : '—';
    var maxCls = 'qp-max' + (r.obs <= 1 ? ' weak' : '');
    var shared = r.shared > 0
      ? ' <span class="tag pend" title="also used by another subject on this date">shared</span>' : '';
    return '<tr data-id="' + r.id + '">' +
      '<td class="text-slate-400 tabular-nums">' + (i + 1) + '</td>' +
      '<td><input type="text" class="qp-room" list="roomList" value="' + esc(r.roomno) + '" />' + shared + '</td>' +
      '<td class="text-right"><span class="' + maxCls + '">' + maxTxt + '</span></td>' +
      '<td><input type="number" min="0" class="qp-qty" value="' + (r.qty > 0 ? r.qty : '') + '"' +
        (r.max_qty ? ' placeholder="' + r.max_qty + '"' : '') + ' /></td>' +
      '<td class="text-right tabular-nums' + (r.qty > 0 ? '' : ' text-slate-300') + '">' + running + '</td>' +
      '<td class="text-right"><button type="button" class="del" title="delete row">&times;</button></td>' +
      '</tr>';
  }

  function renderGrid() {
    var p = state.payload;
    if (!p) return;
    var running = 0;
    bodyEl.innerHTML = p.rows.length
      ? p.rows.map(function (r, i) { running += r.qty; return rowHtml(r, i, running); }).join('')
      : '<tr><td colspan="6" class="empty">No rooms yet — type one below, or copy the room list from another subject.</td></tr>';

    footEl.hidden = p.locked;
    bodyEl.querySelectorAll('input').forEach(function (el) { el.disabled = p.locked; });
    bodyEl.querySelectorAll('.del').forEach(function (el) { el.hidden = p.locked; });
  }

  function renderContext() {
    var p = state.payload;
    var k = state.current;
    ctxCode.textContent = k.subcode;
    ctxDept.textContent = k.dept || '—';
    ctxSem.textContent = k.sem || '—';
    ctxMeta.textContent = k.doe;
    var t = p.totals;
    ctxReg.textContent = t.reg == null ? '—' : t.reg;
    ctxArr.textContent = t.arr == null ? '—' : t.arr;
    ctxReq.textContent = t.required == null ? '—' : t.required;
    ctxLock.hidden = !p.locked;
    ctxLock.textContent = p.state.status === 'exported' ? 'exported' : 'finalised';
  }

  function renderFooter() {
    var t = state.payload.totals;
    var locked = state.payload.locked;
    fRooms.textContent = t.rooms;
    fAllot.textContent = t.allotted;
    fReq.textContent = t.required == null ? '—' : t.required;

    if (t.required == null) {
      fBal.textContent = 'No count for this subject';
      fBal.className = 'chip chip-warn text-[.82rem]';
    } else {
      var b = t.balance;
      fBal.textContent = 'Balance ' + (b > 0 ? '+' : '') + b;
      fBal.className = 'chip text-[.82rem] ' +
        (b < 0 ? 'chip-short' : b === 0 ? 'chip-ok' : b > t.required * 0.25 ? 'chip-over' : 'chip-ok');
    }

    fBlanks.hidden = !t.blanks;
    if (t.blanks) fBlanks.textContent = t.blanks + ' blank';

    finaliseBtn.disabled = locked || !t.rooms;
    finaliseBtn.textContent = locked ? 'Finalised' : 'Finalise subject';
    unlockBtn.hidden = !locked;
    [copySrcEl, copyQtyEl, loadAllBtn, fillMaxBtn, clearBtn].forEach(function (el) { el.disabled = locked; });
  }

  function renderCopySources() {
    var s = state.payload.sources || [];
    function opt(x, withDate) {
      return '<option value="' + esc(x.subcode + '|' + x.dept + '|' + x.sem + '|' + x.doe) + '">' +
             esc(x.subcode) + ' (' + x.rooms + ' rooms' + (withDate ? ', ' + esc(x.doe) : '') + ')</option>';
    }
    // Same date first, then other exam days -- a subject often reuses its rooms
    // across dates, which is when copying helps most.
    var same = s.filter(function (x) { return !x.other; });
    var other = s.filter(function (x) { return x.other; });
    var html = '<option value="">Copy rooms from…</option>';
    if (same.length) {
      html += '<optgroup label="This date">' + same.map(function (x) { return opt(x, false); }).join('') + '</optgroup>';
    }
    if (other.length) {
      html += '<optgroup label="Other dates">' + other.map(function (x) { return opt(x, true); }).join('') + '</optgroup>';
    }
    copySrcEl.innerHTML = html;
    copySrcEl.value = '';
  }

  // Keep the rail badge of the current subject in step with the grid.
  function syncRailEntry() {
    var k = state.current, t = state.payload.totals, st = state.payload.state;
    for (var i = 0; i < state.subjects.length; i++) {
      var s = state.subjects[i];
      if (s.subcode === k.subcode && s.dept === k.dept && s.sem === k.sem) {
        s.rooms = t.rooms; s.allotted = t.allotted; s.blanks = t.blanks; s.status = st.status;
        break;
      }
    }
    if (state.summary) {
      state.summary.final = state.subjects.filter(function (x) {
        return x.req_total != null && x.status !== 'draft';
      }).length;
    }
    renderRail();
  }

  function apply(payload, keepFocus) {
    state.payload = payload;
    state.current = payload.subject;
    renderContext();
    renderGrid();
    renderFooter();
    renderCopySources();
    syncRailEntry();
    if (!keepFocus) focusFirstGap();
  }

  /* ---------------- focus handling ---------------- */

  function qtyInputs() {
    return Array.prototype.slice.call(bodyEl.querySelectorAll('.qp-qty'));
  }

  /** Cursor goes to the first blank QP cell, else to the new-room box. */
  function focusFirstGap() {
    if (state.payload.locked) return;
    var blank = qtyInputs().filter(function (el) { return !el.value; })[0];
    if (blank) blank.focus();
    else newRoomEl.focus();
    if (blank) blank.select();
  }

  function moveFrom(el, delta) {
    var list = qtyInputs();
    var i = list.indexOf(el);
    if (i === -1) return;
    var next = list[i + delta];
    if (next) { next.focus(); next.select(); }
    else if (delta > 0) newRoomEl.focus();
  }

  /* ---------------- loading ---------------- */

  function loadSubjects(date) {
    return fetch('/api/qp/subjects?date=' + encodeURIComponent(date))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.date = date;
        state.subjects = d.subjects || [];
        state.summary = d.summary;
        renderRail();
        return state.subjects;
      });
  }

  function selectSubject(subcode) {
    return fetch('/api/qp/subject?subcode=' + encodeURIComponent(subcode) +
                 '&doe=' + encodeURIComponent(state.date))
      .then(function (r) { return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Could not load subject');
        return d;
      }); })
      .then(function (d) {
        say('');
        problemsEl.hidden = true;
        apply(d);
        history.replaceState(null, '', '/qp?date=' + encodeURIComponent(state.date) +
                                      '&sub=' + encodeURIComponent(subcode));
      })
      .catch(function (e) { say(e.message, 'err'); });
  }

  /** First subject still needing work, for the initial landing and after finalise. */
  function firstUnfinished() {
    var planned = state.subjects.filter(function (s) { return s.req_total != null; });
    planned.sort(function (a, b) {
      return railRank(a) - railRank(b) || (a.subcode < b.subcode ? -1 : 1);
    });
    return planned.length ? planned[0] : null;
  }

  /* ---------------- row writes ---------------- */

  function saveQty(id, value, then) {
    postJson('/api/qp/row/' + id, { qty: value === '' ? 0 : value })
      .then(function (d) { apply(d, true); say(''); if (then) then(); })
      .catch(function (e) { say(e.message, 'err'); });
  }

  function saveRoom(id, value) {
    postJson('/api/qp/row/' + id, { roomno: value })
      .then(function (d) { apply(d, true); say(''); })
      .catch(function (e) { say(e.message, 'err'); selectSubject(state.current.subcode); });
  }

  function addRow() {
    var room = newRoomEl.value.trim();
    if (!room) { newRoomEl.focus(); return; }
    var qty = newQtyEl.value;
    // Blank QP + a known Max = take the Max. The placeholder shows what will be used.
    if (qty === '' && state.maxByRoom[room.toUpperCase()]) qty = state.maxByRoom[room.toUpperCase()];
    if (qty === '') { newQtyEl.focus(); return; }

    postJson('/api/qp/row', keyBody({ roomno: room, qty: qty }))
      .then(function (d) {
        var replaced = d.replaced;
        apply(d, true);
        newRoomEl.value = '';
        newQtyEl.value = '';
        newMaxEl.textContent = '';
        newQtyEl.placeholder = 'QP';
        newRoomEl.focus();
        say(replaced ? room + ' updated' : room + ' added', 'ok');
      })
      .catch(function (e) { say(e.message, 'err'); });
  }

  /* ---------------- grid events ---------------- */

  bodyEl.addEventListener('keydown', function (e) {
    var el = e.target;
    if (el.classList.contains('qp-qty')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var id = el.closest('tr').dataset.id;
        saveQty(id, el.value, function () {
          // Re-resolve the element after the re-render, then step down.
          var fresh = bodyEl.querySelector('tr[data-id="' + id + '"] .qp-qty');
          if (fresh) moveFrom(fresh, 1);
        });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); moveFrom(el, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); moveFrom(el, -1);
      }
    }
    if (el.classList.contains('qp-room') && e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    }
  });

  bodyEl.addEventListener('change', function (e) {
    var el = e.target;
    var tr = el.closest('tr');
    if (!tr) return;
    if (el.classList.contains('qp-qty')) saveQty(tr.dataset.id, el.value);
    else if (el.classList.contains('qp-room')) saveRoom(tr.dataset.id, el.value);
  });

  bodyEl.addEventListener('click', function (e) {
    if (!e.target.classList.contains('del')) return;
    var tr = e.target.closest('tr');
    var row = state.payload.rows.filter(function (r) { return String(r.id) === tr.dataset.id; })[0];
    if (row && row.qty > 0 && !confirm('Delete ' + row.roomno + ' (' + row.qty + ' QP)?')) return;
    postJson('/api/qp/row/' + tr.dataset.id + '/delete', {})
      .then(function (d) { apply(d, true); say('Row deleted', 'ok'); })
      .catch(function (e2) { say(e2.message, 'err'); });
  });

  /* ---------------- new-row events ---------------- */

  newRoomEl.addEventListener('input', function () {
    var m = state.maxByRoom[newRoomEl.value.trim().toUpperCase()];
    newMaxEl.textContent = m || '';
    newQtyEl.placeholder = m ? String(m) : 'QP';
  });

  newRoomEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); newQtyEl.focus(); }
  });

  newQtyEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addRow(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      var list = qtyInputs();
      if (list.length) { list[list.length - 1].focus(); list[list.length - 1].select(); }
    }
  });

  /* ---------------- toolbar ---------------- */

  // "with counts" is a per-operator habit, so remember it across visits.
  try {
    copyQtyEl.checked = localStorage.getItem('qp.copyWithQty') === '1';
  } catch (e) { /* private mode / blocked storage */ }
  copyQtyEl.addEventListener('change', function () {
    try { localStorage.setItem('qp.copyWithQty', copyQtyEl.checked ? '1' : '0'); } catch (e) { /* ignore */ }
  });

  function seedFrom(source, verb) {
    var withQty = copyQtyEl.checked;
    postJson('/api/qp/seed', keyBody({ source: source, withQty: withQty }))
      .then(function (d) {
        apply(d);
        say(d.added + ' room(s) ' + verb +
            (d.withQty ? ' with their counts.' : ' — QP cells are blank.'), 'ok');
      })
      .catch(function (e) { say(e.message, 'err'); });
  }

  copySrcEl.addEventListener('change', function () {
    if (!copySrcEl.value) return;
    seedFrom(copySrcEl.value, 'copied');
  });

  loadAllBtn.addEventListener('click', function () {
    seedFrom('history', 'loaded');
  });

  fillMaxBtn.addEventListener('click', doFillMax);

  function doFillMax() {
    if (!state.current || state.payload.locked) return;
    postJson('/api/qp/fillmax', keyBody())
      .then(function (d) { apply(d); say(d.filled + ' blank cell(s) filled with Max.', 'ok'); })
      .catch(function (e) { say(e.message, 'err'); });
  }

  clearBtn.addEventListener('click', function () {
    if (!confirm('Delete every room row for ' + state.current.subcode + '?')) return;
    postJson('/api/qp/clear', keyBody())
      .then(function (d) { apply(d); say(d.removed + ' row(s) deleted.', 'ok'); })
      .catch(function (e) { say(e.message, 'err'); });
  });

  unlockBtn.addEventListener('click', function () {
    postJson('/api/qp/unlock', keyBody())
      .then(function (d) { apply(d); say('Unlocked for correction.', 'ok'); })
      .catch(function (e) { say(e.message, 'err'); });
  });

  /* ---------------- finalise ---------------- */

  function renderProblems(list) {
    if (!list || !list.length) { problemsEl.hidden = true; problemsEl.innerHTML = ''; return; }
    problemsEl.hidden = false;
    problemsEl.innerHTML = list.map(function (p) {
      return '<div class="problem ' + p.level + '">' + esc(p.msg) + '</div>';
    }).join('');
  }

  function finalise(acceptWarnings) {
    postJson('/api/qp/finalise', keyBody({ acceptWarnings: !!acceptWarnings }))
      .then(function (d) {
        apply(d, true);
        renderProblems(d.problems);
        if (d.ok) {
          say(state.current.subcode + ' finalised.', 'ok');
          var next = firstUnfinished();
          if (next && next.subcode !== state.current.subcode) {
            setTimeout(function () { selectSubject(next.subcode); }, 400);
          }
        } else if (d.needsConfirm) {
          if (confirm('Finalise anyway?\n\n' + d.problems.map(function (p) { return '• ' + p.msg; }).join('\n'))) {
            finalise(true);
          } else {
            say('Not finalised.', 'err');
          }
        } else {
          say('Cannot finalise yet — see below.', 'err');
        }
      })
      .catch(function (e) { say(e.message, 'err'); });
  }

  finaliseBtn.addEventListener('click', function () { finalise(false); });

  /* ---------------- global keys ---------------- */

  document.addEventListener('keydown', function (e) {
    if (e.key === 'F4') { e.preventDefault(); doFillMax(); }
    else if (e.key === 'Enter' && e.ctrlKey && state.current && !finaliseBtn.disabled) {
      e.preventDefault(); finalise(false);
    }
  });

  dateSel.addEventListener('change', function () {
    loadSubjects(dateSel.value).then(function (subs) {
      state.current = null;
      state.payload = null;
      bodyEl.innerHTML = '<tr><td colspan="6" class="empty">Pick a subject from the left to start entering rooms.</td></tr>';
      footEl.hidden = true;
      var first = firstUnfinished();
      if (first) selectSubject(first.subcode);
    });
  });

  /* ---------------- start ---------------- */

  fetch('/api/qp/rooms')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      list.forEach(function (r) { state.maxByRoom[r.roomno] = r.max_qty; });
    })
    .catch(function () {});

  renderRail();

  var urlSub = new URLSearchParams(location.search).get('sub');
  var start = urlSub || (firstUnfinished() && firstUnfinished().subcode);
  if (start) selectSubject(start);
})();
