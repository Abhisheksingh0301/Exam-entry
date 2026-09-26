var express = require('express');
var router = express.Router();
var data = require('../db');
var qp = require('../db').qp;

/* Resolve {subcode, doe} from the request into the full key (sessn/dept/sem).
   Everything is derived from the cached timetable -- the client never supplies
   dept or sem, so it cannot write a row against the wrong subject. */
function key(req) {
  var src = req.method === 'GET' ? req.query : req.body;
  var s = qp.resolveSubject((src.subcode || '').trim(), (src.doe || '').trim());
  if (!s) return null;
  return { sessn: s.sessn, subcode: s.subcode, dept: s.dept, sem: s.sem, doe: s.doe };
}

/* Current state of one subject: rows, totals, lock status, copy sources. */
function subjectPayload(k) {
  return {
    subject: k,
    state: qp.subjectState(k),
    rows: qp.rowsFor(k),
    totals: qp.totals(k),
    sources: qp.copySources(k),
    locked: qp.isLocked(k)
  };
}

/* Reject a write against a finalised subject. */
function guard(res, k) {
  if (qp.isLocked(k)) {
    res.status(409).json({ error: 'Subject is finalised. Unlock it to make changes.' });
    return false;
  }
  return true;
}

/* ---------------------------------------------------------------- *
 * Pages
 * ---------------------------------------------------------------- */

/* GET the allotment screen. */
router.get('/qp', function (req, res) {
  var dates = qp.dateProgress();
  var date = (req.query.date || '').trim();
  if (!date) {
    var today = new Date().toISOString().slice(0, 10);
    var next = dates.find(function (d) { return d.doe >= today; });
    date = next ? next.doe : (dates.length ? dates[dates.length - 1].doe : today);
  }
  res.render('qp', {
    title: 'Question Paper Allotment',
    session: data.currentSession(),
    lastSync: data.getMeta('last_sync'),
    campus: qp.campusId(),
    dates: dates,
    date: date,
    subjects: qp.subjectsForDate(date),
    summary: qp.dateSummary(date),
    rooms: qp.roomSuggest(400),
    flash: req.query.msg || null,
    flashType: req.query.type || 'info'
  });
});

/* Date-by-date progress: how far the entry has got across the whole session. */
router.get('/qp/progress', function (req, res) {
  res.render('qpprogress', {
    title: 'Entry Progress',
    session: data.currentSession(),
    campus: qp.campusId(),
    progress: qp.dateProgress(),
    orphans: qp.orphanEntries(),
    last: qp.lastActivity()
  });
});

/* Finalised rows: review, then export to dbo.room. */
router.get('/qp/final', function (req, res) {
  var date = (req.query.date || '').trim();
  res.render('qpfinal', {
    title: 'Finalised Allotment',
    date: date,
    dates: qp.examDates(),
    rows: qp.finalisedRows(date),
    pending: qp.pendingExport(date),
    flash: req.query.msg || null,
    flashType: req.query.type || 'info'
  });
});

/* ---------------------------------------------------------------- *
 * Printed reports (17x11 landscape), filtered by dept / sem / exam date
 * ---------------------------------------------------------------- */
var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December'];

function longDate(doe) {                       // 2026-04-25 -> Saturday, April 25, 2026
  var p = String(doe || '').split('-').map(Number);
  if (p.length !== 3) return doe || '';
  var d = new Date(p[0], p[1] - 1, p[2]);
  return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function clock(hhmm) {                         // 09:00 -> 9:00AM
  var m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return '';
  var h = parseInt(m[1], 10);
  return ((h % 12) || 12) + ':' + m[2] + (h < 12 ? 'AM' : 'PM');
}

function shortDate(doe) {                      // 2026-05-08 -> 08-May-2026
  var p = String(doe || '').split('-');
  if (p.length !== 3) return doe || '';
  return p[2] + '-' + MONTHS[parseInt(p[1], 10) - 1].slice(0, 3) + '-' + p[0];
}

function timeText(r) {
  return r.time_from ? clock(r.time_from) + ' To ' + clock(r.time_to) : '';
}

/* dept may repeat (multi-select); blank filters match all. */
function reportFilter(req) {
  return {
    depts: [].concat(req.query.dept || []).map(function (d) { return String(d).trim(); }).filter(Boolean),
    sem: (req.query.sem || '').trim(),
    doe: (req.query.date || '').trim()
  };
}

/* B.Com/BMS: one page per room of each subject (QP top sheet). */
router.get('/qp/topsheet', function (req, res) {
  var f = reportFilter(req);
  var any = f.depts.length || f.sem || f.doe;
  var sheets = any ? qp.topSheets(f) : [];
  sheets.forEach(function (s) {
    var y = /(\d{4})\s*$/.exec(s.sessn || '');  // "April - June, 2026" -> 2026
    s.year = y ? y[1] : '';
    s.dateText = longDate(s.doe);
    s.timeText = timeText(s);
  });
  res.render('qptopsheet', {
    title: 'B.Com/BMS Report',
    session: data.currentSession(),
    filters: qp.topSheetFilters(),
    f: f,
    any: any,
    sheets: sheets,
    extra: qp.qpExtra()
  });
});

/* Arts/Science: one page per room per exam date, every subject in that room. */
router.get('/qp/artsreport', function (req, res) {
  var f = reportFilter(req);
  var any = f.depts.length || f.sem || f.doe;
  var sheets = any ? qp.artsSheets(f) : [];
  sheets.forEach(function (p) {
    p.dateText = shortDate(p.doe);
    p.rows.forEach(function (r) { r.timeText = timeText(r); });
  });
  res.render('qparts', {
    title: 'Arts/Science Report',
    session: data.currentSession(),
    filters: qp.artsFilters(),
    f: f,
    any: any,
    sheets: sheets
  });
});

/* Push finalised subjects to dbo.room (delete-then-insert per subject). */
router.post('/qp/export', function (req, res) {
  var date = (req.body.date || '').trim();
  var back = '/qp/final?date=' + encodeURIComponent(date);
  qp.exportToSqlServer(date || null)
    .then(function (r) {
      var msg = r.total === 0
        ? 'Nothing to export — no finalised subject is waiting.'
        : 'Exported ' + r.subjects + ' of ' + r.total + ' subject(s), ' + r.rows + ' room row(s)' +
          (r.failed ? '. ' + r.failed + ' failed: ' + r.errors[0] : '.');
      res.redirect(back + '&type=' + (r.failed ? 'error' : 'success') + '&msg=' + encodeURIComponent(msg));
    })
    .catch(function (err) {
      res.redirect(back + '&type=error&msg=' + encodeURIComponent('Export failed: ' + err.message));
    });
});

/* Same data as CSV. */
router.get('/qp/final.csv', function (req, res) {
  var date = (req.query.date || '').trim();
  var rows = qp.finalisedRows(date);
  var out = ['SESSN,SUBCODE,DEPT,SEM,ROOMNO,QTY'];
  rows.forEach(function (r) {
    out.push([r.SESSN, r.SUBCODE, r.DEPT, r.SEM, r.ROOMNO, r.QTY].map(function (v) {
      var s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  });
  res.type('text/csv');
  res.setHeader('Content-Disposition',
    'attachment; filename="qp_allotment' + (date ? '_' + date : '') + '.csv"');
  res.send(out.join('\r\n'));
});

/* ---------------------------------------------------------------- *
 * Subject rail + one subject
 * ---------------------------------------------------------------- */

router.get('/api/qp/subjects', function (req, res) {
  var date = (req.query.date || '').trim();
  if (!date) return res.json({ subjects: [], summary: null });
  res.json({ subjects: qp.subjectsForDate(date), summary: qp.dateSummary(date) });
});

router.get('/api/qp/subject', function (req, res) {
  var k = key(req);
  if (!k) return res.status(404).json({ error: 'Subject not in the cached timetable. Sync master data.' });
  res.json(subjectPayload(k));
});

router.get('/api/qp/rooms', function (req, res) {
  res.json(qp.roomSuggest(parseInt(req.query.limit, 10) || 400));
});

/* ---------------------------------------------------------------- *
 * Row writes
 * ---------------------------------------------------------------- */

/* Add a room (or overwrite the count of a room already listed). */
router.post('/api/qp/row', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  if (!guard(res, k)) return;
  try {
    var r = qp.upsertRow(k, req.body.roomno, req.body.qty);
    res.json(Object.assign({ ok: true, id: r.id, replaced: r.replaced }, subjectPayload(k)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* Edit a row in place: qty, room no., or both. */
router.post('/api/qp/row/:id', function (req, res) {
  var row = qp.getRow(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Row not found.' });
  var k = { sessn: row.sessn, subcode: row.subcode, dept: row.dept, sem: row.sem, doe: row.doe };
  if (!guard(res, k)) return;
  try {
    if (req.body.roomno !== undefined) qp.updateRoom(row.id, req.body.roomno);
    if (req.body.qty !== undefined) qp.updateQty(row.id, req.body.qty);
    res.json(Object.assign({ ok: true }, subjectPayload(k)));
  } catch (e) {
    // The unique index fires when a room is renamed onto one already in the grid.
    if (/UNIQUE/i.test(e.message)) {
      return res.status(409).json({ error: 'That room is already in this subject\'s grid.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/qp/row/:id/delete', function (req, res) {
  var row = qp.getRow(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Row not found.' });
  var k = { sessn: row.sessn, subcode: row.subcode, dept: row.dept, sem: row.sem, doe: row.doe };
  if (!guard(res, k)) return;
  qp.deleteRow(row.id);
  res.json(Object.assign({ ok: true }, subjectPayload(k)));
});

/* ---------------------------------------------------------------- *
 * Seeding / prefill / clear
 * ---------------------------------------------------------------- */

router.post('/api/qp/seed', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  if (!guard(res, k)) return;
  var added = qp.seed(k, req.body.source, !!req.body.withQty);
  res.json(Object.assign({ ok: true, added: added, withQty: !!req.body.withQty }, subjectPayload(k)));
});

router.post('/api/qp/fillmax', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  if (!guard(res, k)) return;
  var filled = qp.fillFromMax(k);
  res.json(Object.assign({ ok: true, filled: filled }, subjectPayload(k)));
});

router.post('/api/qp/clear', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  if (!guard(res, k)) return;
  var removed = qp.clearSubject(k);
  res.json(Object.assign({ ok: true, removed: removed }, subjectPayload(k)));
});

/* ---------------------------------------------------------------- *
 * Checks / finalise / unlock
 * ---------------------------------------------------------------- */

router.post('/api/qp/checks', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  res.json({ ok: true, problems: qp.checks(k) });
});

router.post('/api/qp/finalise', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  var r = qp.finalise(k, { acceptWarnings: !!req.body.acceptWarnings });
  res.json(Object.assign({
    ok: r.ok, needsConfirm: !!r.needsConfirm, problems: r.problems
  }, subjectPayload(k)));
});

router.post('/api/qp/unlock', function (req, res) {
  var k = key(req);
  if (!k) return res.status(400).json({ error: 'Unknown subject/date.' });
  qp.unlock(k);
  res.json(Object.assign({ ok: true }, subjectPayload(k)));
});

/* Pull Count + room history into the local cache (subjects come from /sync). */
router.post('/qp/sync', function (req, res) {
  data.syncMasterData()
    .then(function (m) {
      return qp.syncQpMaster().then(function (r) {
        var msg = 'Synced ' + m.subjects + ' subject(s), ' + r.counts +
                  ' count row(s) for campus ' + qp.campusId() + ', ' + r.rooms + ' room(s).';
        if (r.warnings.length) msg += ' Warning: ' + r.warnings.join(' | ');
        res.redirect('/qp?type=' + (r.warnings.length ? 'error' : 'success') +
                     '&msg=' + encodeURIComponent(msg));
      });
    })
    .catch(function (err) {
      res.redirect('/qp?type=error&msg=' + encodeURIComponent('Sync failed: ' + err.message));
    });
});

module.exports = router;
