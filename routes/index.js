var express = require('express');
var router = express.Router();
var data = require('../db');
var qp = require('../db').qp;

var PAPER_TYPES = ['REGULAR', 'ARREAR'];

/* GET home / entry page. */
router.get('/', function (req, res) {
  res.render('index', {
    title: 'Answer Script - Packet Entry',
    session: data.currentSession(),
    lastSync: data.getMeta('last_sync'),
    subjects: data.getSubjects(),
    examDates: data.examDates(),
    maxGroups: data.maxGroups(),
    paperTypes: PAPER_TYPES,
    recent: data.recentPackets(20),
    stats: data.stats(),
    flash: req.query.msg || null,
    flashType: req.query.type || 'info'
  });
});

/* Autocomplete: suggest subjects after >= 3 typed characters, or (when an exam
   date is chosen) all subjects with an exam on that day. */
router.get('/api/subjects', function (req, res) {
  var q = (req.query.q || '').trim();
  var date = (req.query.date || '').trim();
  if (!date && q.length < 3) return res.json([]);
  res.json(data.searchSubjects(q, date, date ? 50 : 12));
});

/* Lookup a single subject -> dept + no. of groups. */
router.get('/api/subject/:subcode', function (req, res) {
  var s = data.getSubject(req.params.subcode);
  if (!s) return res.status(404).json({ error: 'Subject not found' });
  res.json(s);
});

/* Next packet no. for current subject/type (resets to 1 per subject). */
router.get('/api/nextpkt', function (req, res) {
  var q = req.query;
  if (!q.subcode || !q.type) return res.status(400).json({ error: 'Missing params' });
  res.json({ pkt_no: data.nextPktNo(q.subcode, q.type) });
});

/* Save a packet (called on Enter in the "No. of scripts" field).
   One entry expands into N rows (one per group letter: NONE / A / B / C ...). */
router.post('/api/entry', function (req, res) {
  try {
    var b = req.body;
    var subject = data.getSubject(b.subcode);
    if (!subject) return res.status(400).json({ error: 'Unknown subject. Sync master data first.' });

    // Sessn = the session where this subject's TIME_TABLE row matched CURRENT_SESSION.
    var sessn = subject.sessn || data.currentSession();
    if (!sessn) return res.status(400).json({ error: 'No current session. Sync master data first.' });

    if (PAPER_TYPES.indexOf(b.paper_type) === -1) return res.status(400).json({ error: 'Invalid type' });

    var noOfScripts = parseInt(b.no_of_scripts, 10);
    if (!Number.isInteger(noOfScripts) || noOfScripts <= 0)
      return res.status(400).json({ error: 'No. of scripts must be a positive number' });

    var groupCount = parseInt(b.no_of_groups, 10);
    if (!Number.isInteger(groupCount) || groupCount < 1)
      return res.status(400).json({ error: 'No. of groups must be at least 1' });

    var pktNo = parseInt(b.pkt_no, 10) || data.nextPktNo(b.subcode, b.paper_type);

    var base = {
      dept: subject.dept,
      subcode: subject.subcode,
      pkt_no: pktNo,
      no_of_scripts: noOfScripts,
      paper_type: b.paper_type,
      sessn: sessn,
      remark: b.remark || null
    };

    // A packet no. is unique per subject+group+type+session (No_of_Scripts is NOT
    // part of the logical key, despite the Script_Count PK). Reject duplicates.
    var dups = data.existingGroups(base, groupCount);
    if (dups.length) {
      return res.status(409).json({
        error: 'Pkt ' + pktNo + ' already entered for ' + subject.subcode +
               ' (' + b.paper_type + ') group(s) ' + dups.join(', ') + '. Change the Pkt No.'
      });
    }

    var rows;
    try {
      rows = data.insertPacketGroups(base, groupCount);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return res.status(409).json({ error: 'Duplicate packet — this Pkt No. already exists for this subject/group.' });
      }
      throw e;
    }

    // If the user overrode the auto-filled group count, log the change locally.
    // It is applied to dbo.Script_per_candidate later, on export (UPDATE only).
    var groupsChange = null;
    if (groupCount !== subject.total_scripts) {
      data.recordGroupChange(subject.subcode, subject.total_scripts, groupCount);
      groupsChange = { subcode: subject.subcode, old: subject.total_scripts, new: groupCount };
    }

    res.json({
      ok: true,
      saved: rows.map(function (r) {
        return {
          id: r.id, subcode: r.subcode, dept: r.dept, groups: r.groups,
          paper_type: r.paper_type, pkt_no: r.pkt_no, no_of_scripts: r.no_of_scripts
        };
      }),
      next_pkt: data.nextPktNo(b.subcode, b.paper_type),
      stats: data.stats(),
      groupsChange: groupsChange
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Audit log of "No. of groups" overrides. */
router.get('/changes', function (req, res) {
  res.render('changes', { title: 'Group-count Changes', changes: data.groupChanges(200) });
});

/* Delete a change-log entry (removes the audit record only). */
router.post('/changes/:id/delete', function (req, res) {
  data.deleteGroupChange(parseInt(req.params.id, 10));
  res.redirect('/changes');
});

/* Search saved packets by subject code. */
router.get('/api/packets', function (req, res) {
  var q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(data.searchPackets(q, 500));
});

/* Most recent saved packets (used to reset the list after a search). */
router.get('/api/recent', function (req, res) {
  res.json(data.recentPackets(20));
});

/* Edit a packet's No. of scripts (works for exported rows too -- it re-marks the
   row pending so the next Export pushes the change to Script_Count). */
router.post('/api/entry/:id/update', function (req, res) {
  var n = parseInt(req.body.no_of_scripts, 10);
  if (!Number.isInteger(n) || n <= 0)
    return res.status(400).json({ error: 'No. of scripts must be a positive number' });
  var row = data.updatePacketScripts(parseInt(req.params.id, 10), n);
  if (!row) return res.status(404).json({ error: 'Packet not found' });
  res.json({ ok: true, row: row, stats: data.stats() });
});

/* Delete a packet. Pending rows are removed locally; exported rows are also
   removed from SQL Server Script_Count first. */
router.post('/api/entry/:id/delete', function (req, res) {
  var p = data.getPacket(parseInt(req.params.id, 10));
  if (!p) return res.json({ ok: false, error: 'Packet not found' });

  if (!p.exported) {
    data.removePacket(p.id);
    return res.json({ ok: true, removedFromServer: false, stats: data.stats() });
  }

  data.deleteExportedPacket(p)
    .then(function () {
      res.json({ ok: true, removedFromServer: true, stats: data.stats() });
    })
    .catch(function (err) {
      res.status(500).json({ ok: false, error: 'SQL Server delete failed: ' + err.message });
    });
});

/* Sync master data: SQL Server -> SQLite cache (fills the dropdowns). Also
   refreshes the QP allotment caches (Count + room history) so either page's
   Sync button leaves the whole app up to date. */
router.post('/sync', function (req, res) {
  data.syncMasterData()
    .then(function (r) {
      return qp.syncQpMaster().then(function (q) {
        var msg = 'Synced ' + r.subjects + ' subject(s) for session ' + (r.session || '(none)') +
                  ', ' + q.counts + ' count row(s), ' + q.rooms + ' room(s).';
        if (q.warnings.length) msg += ' Warning: ' + q.warnings.join(' | ');
        res.redirect('/?type=success&msg=' + encodeURIComponent(msg));
      });
    })
    .catch(function (err) {
      res.redirect('/?type=error&msg=' + encodeURIComponent('Sync failed: ' + err.message));
    });
});

/* Export pending packets: SQLite -> SQL Server dbo.Script_Count. */
router.post('/export', function (req, res) {
  data.exportToSqlServer()
    .then(function (r) {
      var msg = 'Export done: ' + r.inserted + ' inserted, ' + r.updated + ' updated, ' +
                r.failed + ' failed (of ' + r.total + ' packets). ' +
                'Group changes: ' + r.groupsUpdated + ' applied' +
                (r.groupsFailed ? ', ' + r.groupsFailed + ' failed' : '') + '.';
      if (r.errors.length) msg += ' First issue: ' + r.errors[0];
      res.redirect('/?type=' + (r.failed || r.groupsFailed ? 'error' : 'success') + '&msg=' + encodeURIComponent(msg));
    })
    .catch(function (err) {
      res.redirect('/?type=error&msg=' + encodeURIComponent('Export failed: ' + err.message));
    });
});

module.exports = router;
