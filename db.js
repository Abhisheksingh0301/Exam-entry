'use strict';

/**
 * Data layer for the Script Count app.
 *  - Local storage  : SQLite (better-sqlite3, synchronous)
 *  - Master data src : SQL Server "Exam" DB (mssql)  -> cached into SQLite
 *  - Export target   : SQL Server dbo.Script_Count
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const sql = require('mssql');

/* ------------------------------------------------------------------ *
 * SQLite setup
 * ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'scriptcount.db'));
// Use the default rollback journal (not WAL) so every write lands in the single
// scriptcount.db file immediately -- external SQLite viewers then show all rows.
db.pragma('journal_mode = DELETE');
db.pragma('synchronous = FULL');

// Migration: older DBs have a subjects_cache without the DOE (exam date) column.
// It's a rebuildable cache, so just drop it -- the CREATE below remakes it and the
// user re-syncs. (Fresh DBs have no such table yet; this is a no-op there.)
try {
  const cols = db.prepare('PRAGMA table_info(subjects_cache)').all().map(function (c) { return c.name; });
  if (cols.length && cols.indexOf('doe') === -1) db.exec('DROP TABLE subjects_cache');
  // Practical flag added later: add the column rather than dropping the cache, so
  // the app keeps working until the next sync fills it in (everything defaults to
  // "not practical", which is how it behaved before).
  else if (cols.length && cols.indexOf('practical') === -1) {
    db.exec('ALTER TABLE subjects_cache ADD COLUMN practical INTEGER NOT NULL DEFAULT 0');
  }
  // Paper title / time / duration added for the QP top sheet; blank until the next sync.
  ['subtitle', 'time_from', 'time_to', 'duration'].forEach(function (c) {
    if (cols.length && cols.indexOf(c) === -1) db.exec('ALTER TABLE subjects_cache ADD COLUMN ' + c + ' TEXT');
  });
} catch (e) { /* ignore */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Cached master data pulled from SQL Server (fills the dropdowns).
  -- One row per subject+exam-date, since a subject can have exams on several days.
  CREATE TABLE IF NOT EXISTS subjects_cache (
    subcode       TEXT NOT NULL,
    dept          TEXT NOT NULL,
    semester      TEXT,
    total_scripts INTEGER NOT NULL DEFAULT 1,
    sessn         TEXT,
    doe           TEXT,
    practical     INTEGER NOT NULL DEFAULT 0,   -- TIME_TABLE.Practical
    subtitle      TEXT,                         -- TIME_TABLE.SUBTITLE (paper title)
    time_from     TEXT,                         -- HH:MM, 24h
    time_to       TEXT,
    duration      TEXT,
    PRIMARY KEY (subcode, doe)
  );

  -- Packet entries captured by the user; exported to Script_Count later.
  CREATE TABLE IF NOT EXISTS packets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dept          TEXT NOT NULL,
    subcode       TEXT NOT NULL,
    pkt_no        INTEGER NOT NULL,
    no_of_scripts INTEGER NOT NULL,
    groups        TEXT NOT NULL,
    paper_type    TEXT NOT NULL,
    sessn         TEXT NOT NULL,
    remark        TEXT,
    exported      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- Audit log of "No. of groups" overrides. Applied to Script_per_candidate
  -- (UPDATE only) on export; kept afterwards as a history of what was changed.
  CREATE TABLE IF NOT EXISTS group_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subcode     TEXT NOT NULL,
    old_groups  INTEGER,
    new_groups  INTEGER NOT NULL,
    exported    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    exported_at TEXT
  );

  /* ---------------- Question-paper allotment ---------------- */

  -- dbo.[Count] for CAMPUS_ID, cached. Drives "Required" (Reg + Arr).
  CREATE TABLE IF NOT EXISTS count_cache (
    subcode   TEXT    NOT NULL,
    campus_id INTEGER NOT NULL,
    reg       INTEGER,
    arr       INTEGER,
    total     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (subcode, campus_id)
  );

  -- MAX(QTY) per room from dbo.room history. Seeds the Max column on a new install.
  CREATE TABLE IF NOT EXISTS room_stats (
    roomno  TEXT PRIMARY KEY,
    max_qty INTEGER NOT NULL DEFAULT 0,
    uses    INTEGER NOT NULL DEFAULT 0
  );

  -- Room-wise QP entries. qty = 0 means "room listed, QP count not typed yet".
  CREATE TABLE IF NOT EXISTS qp_rooms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sessn      TEXT NOT NULL,
    doe        TEXT,
    subcode    TEXT NOT NULL,
    dept       TEXT NOT NULL,
    sem        TEXT NOT NULL DEFAULT '',
    roomno     TEXT NOT NULL,
    qty        INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  );

  -- Per-subject state. Finalising snapshots the Required figures, because
  -- dbo.[Count] has no session column and is overwritten every session.
  CREATE TABLE IF NOT EXISTS qp_subjects (
    sessn        TEXT NOT NULL,
    subcode      TEXT NOT NULL,
    dept         TEXT NOT NULL,
    sem          TEXT NOT NULL DEFAULT '',
    doe          TEXT,
    status       TEXT NOT NULL DEFAULT 'draft',   -- draft | final | exported
    req_reg      INTEGER,
    req_arr      INTEGER,
    req_total    INTEGER,
    finalised_on TEXT,
    exported_on  TEXT,
    PRIMARY KEY (sessn, subcode, dept, sem)
  );
`);

// A packet is uniquely identified by everything EXCEPT No_of_Scripts. The
// Script_Count PK mistakenly includes No_of_Scripts, so the same subject+pkt+group
// could be stored twice with different counts -- we forbid that here.
try {
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_packets_key
       ON packets (dept, subcode, pkt_no, groups, paper_type, sessn)`
  );
} catch (e) {
  console.warn('Could not create unique packet index (existing duplicates?):', e.message);
}

// One row per room per subject -- the guard dbo.room doesn't have.
try {
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_qp_rooms_key
       ON qp_rooms (sessn, subcode, dept, sem, roomno)`
  );
} catch (e) {
  console.warn('Could not create unique qp_rooms index (existing duplicates?):', e.message);
}

// Max = the largest QP count a room has ever held: server history plus locally
// FINALISED subjects (draft rows are excluded, so half-typed junk cannot set a
// room's ceiling). obs = how many observations back it up.
db.exec(`
  CREATE VIEW IF NOT EXISTS room_max AS
  SELECT roomno, MAX(mq) AS max_qty, SUM(n) AS obs FROM (
    SELECT roomno, max_qty AS mq, uses AS n FROM room_stats
    UNION ALL
    SELECT q.roomno, MAX(q.qty), COUNT(*)
      FROM qp_rooms q
      JOIN qp_subjects s ON s.sessn = q.sessn AND s.subcode = q.subcode
                        AND s.dept  = q.dept  AND s.sem     = q.sem
     WHERE s.status IN ('final','exported')
     GROUP BY q.roomno
  ) GROUP BY roomno
`);

/* ------------------------------------------------------------------ *
 * SQL Server config
 * ------------------------------------------------------------------ */
function mssqlConfig() {
  const cfg = {
    user: process.env.DB_USER || 'u1',
    password: process.env.DB_PASSWORD || '123',
    database: process.env.DB_NAME || 'Exam',
    server: process.env.DB_HOST || 'localhost',
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 8000,
    requestTimeout: 15000,
    options: { encrypt: false, trustServerCertificate: true }
  };
  if (process.env.DB_INSTANCE) cfg.options.instanceName = process.env.DB_INSTANCE;
  if (process.env.DB_PORT) cfg.port = parseInt(process.env.DB_PORT, 10);
  return cfg;
}

/* ------------------------------------------------------------------ *
 * Local (SQLite) read/write helpers
 * ------------------------------------------------------------------ */
function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

function currentSession() {
  return getMeta('current_session') || '';
}

function getSubjects() {
  // Distinct subjects (a subject may span several exam dates in the cache).
  return db
    .prepare('SELECT subcode, dept, MAX(total_scripts) AS total_scripts FROM subjects_cache GROUP BY subcode ORDER BY subcode')
    .all();
}

function getSubject(subcode) {
  return db
    .prepare('SELECT subcode, dept, semester, total_scripts, sessn FROM subjects_cache WHERE subcode = ? LIMIT 1')
    .get(subcode);
}

/** Distinct exam dates present in the cache (YYYY-MM-DD), earliest first. */
function examDates() {
  return db
    .prepare("SELECT DISTINCT doe FROM subjects_cache WHERE doe IS NOT NULL AND doe <> '' ORDER BY doe")
    .all()
    .map(function (r) { return r.doe; });
}

/**
 * Autocomplete: subjects whose code (or dept) contains the term. When `date`
 * (YYYY-MM-DD) is given, only subjects whose exam is on that day are returned.
 */
function searchSubjects(term, date, limit) {
  var bare = (term || '').replace(/[%_]/g, '');
  var like = '%' + bare + '%';
  if (date) {
    return db
      .prepare(
        `SELECT subcode, dept, MAX(semester) AS semester, MAX(total_scripts) AS total_scripts, doe
           FROM subjects_cache
          WHERE doe = ? AND (subcode LIKE ? OR dept LIKE ?)
          GROUP BY subcode
          ORDER BY CASE WHEN subcode LIKE ? THEN 0 ELSE 1 END, subcode
          LIMIT ?`
      )
      .all(date, like, like, bare + '%', limit || 20);
  }
  return db
    .prepare(
      `SELECT subcode, dept, MAX(semester) AS semester, MAX(total_scripts) AS total_scripts, MIN(doe) AS doe
         FROM subjects_cache
        WHERE subcode LIKE ? OR dept LIKE ?
        GROUP BY subcode
        ORDER BY CASE WHEN subcode LIKE ? THEN 0 ELSE 1 END, subcode
        LIMIT ?`
    )
    .all(like, like, bare + '%', limit || 12);
}

/** Largest group-count present (>= 4, since letters go up to D). Feeds the dropdown. */
function maxGroups() {
  const m = db.prepare('SELECT COALESCE(MAX(total_scripts),1) AS m FROM subjects_cache').get().m;
  return Math.max(4, m);
}

/** Group letters for a count: 1 -> ["NONE"]; 2 -> [A,B]; 3 -> [A,B,C]; ... */
function groupLetters(count) {
  const n = Math.max(1, parseInt(count, 10) || 1);
  if (n === 1) return ['NONE'];
  const out = [];
  for (let i = 0; i < n; i++) out.push(String.fromCharCode(65 + i)); // A, B, C, ...
  return out;
}

/** Next packet no. for a subject+type (packet numbering is shared across groups). */
function nextPktNo(subcode, paperType) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(pkt_no),0)+1 AS next
         FROM packets
        WHERE subcode = ? AND paper_type = ?`
    )
    .get(subcode, paperType);
  return row.next;
}

const insertOne = db.prepare(
  `INSERT INTO packets (dept, subcode, pkt_no, no_of_scripts, groups, paper_type, sessn, remark)
   VALUES (@dept, @subcode, @pkt_no, @no_of_scripts, @groups, @paper_type, @sessn, @remark)`
);

function insertPacket(p) {
  return insertOne.run(p).lastInsertRowid;
}

/**
 * Save one packet as N rows (one per group letter), all sharing pkt_no and
 * no_of_scripts. Returns the inserted rows (with ids) for the UI.
 */
const insertGroupRows = db.transaction((base, letters) => {
  const rows = [];
  for (const g of letters) {
    const row = Object.assign({}, base, { groups: g });
    const id = insertOne.run(row).lastInsertRowid;
    rows.push(Object.assign({ id: id }, row));
  }
  return rows;
});

function insertPacketGroups(base, count) {
  return insertGroupRows(base, groupLetters(count));
}

/**
 * Change a packet's script count (and optionally remark). Flips exported back to 0
 * so the next Export pushes the change to Script_Count. Returns the updated row.
 */
function updatePacketScripts(id, noOfScripts, remark) {
  const info = remark === undefined
    ? db.prepare('UPDATE packets SET no_of_scripts = ?, exported = 0 WHERE id = ?').run(noOfScripts, id)
    : db.prepare('UPDATE packets SET no_of_scripts = ?, remark = ?, exported = 0 WHERE id = ?').run(noOfScripts, remark, id);
  if (!info.changes) return null;
  return db.prepare('SELECT * FROM packets WHERE id = ?').get(id);
}

/** Return the group letters that already exist for this packet key (excl. No_of_Scripts). */
function existingGroups(base, count) {
  const stmt = db.prepare(
    `SELECT 1 FROM packets
      WHERE dept = ? AND subcode = ? AND pkt_no = ? AND groups = ?
        AND paper_type = ? AND sessn = ?`
  );
  const dups = [];
  for (const g of groupLetters(count)) {
    if (stmt.get(base.dept, base.subcode, base.pkt_no, g, base.paper_type, base.sessn)) dups.push(g);
  }
  return dups;
}

/** Find saved packets whose subject code contains the term. */
function searchPackets(term, limit = 500) {
  const like = '%' + term.replace(/[%_]/g, '') + '%';
  return db
    .prepare(
      `SELECT * FROM packets
        WHERE subcode LIKE ?
        ORDER BY subcode, paper_type, pkt_no, groups
        LIMIT ?`
    )
    .all(like, limit);
}

function recentPackets(limit = 20) {
  return db
    .prepare('SELECT * FROM packets ORDER BY id DESC LIMIT ?')
    .all(limit);
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM packets').get().c;
  const pending = db.prepare('SELECT COUNT(*) c FROM packets WHERE exported = 0').get().c;
  const scripts = db.prepare('SELECT COALESCE(SUM(no_of_scripts),0) s FROM packets').get().s;
  return { total, pending, exported: total - pending, scripts, pendingChanges: pendingGroupChangeCount() };
}

function getPacket(id) {
  return db.prepare('SELECT * FROM packets WHERE id = ?').get(id);
}

function removePacket(id) {
  return db.prepare('DELETE FROM packets WHERE id = ?').run(id).changes;
}

/**
 * Delete an already-exported packet: remove it from SQL Server Script_Count
 * (matched on the logical key, so it works even if the count was later edited),
 * then remove the local row.
 */
async function deleteExportedPacket(p) {
  const pool = await sql.connect(mssqlConfig());
  try {
    await pool.request()
      .input('Dept', sql.NVarChar, p.dept)
      .input('Subcode', sql.VarChar, p.subcode)
      .input('PktNo', sql.Int, p.pkt_no)
      .input('Groups', sql.NVarChar, String(p.groups))
      .input('Sessn', sql.VarChar, p.sessn)
      .input('Paper_Type', sql.VarChar, p.paper_type)
      .query(`DELETE FROM dbo.Script_Count
               WHERE Dept=@Dept AND Subcode=@Subcode AND PktNo=@PktNo
                 AND Groups=@Groups AND Sessn=@Sessn AND Paper_Type=@Paper_Type`);
  } finally {
    await pool.close();
  }
  return removePacket(p.id);
}

/**
 * Record a "No. of groups" override locally (audit log). Also updates the local
 * subjects_cache so the dropdown auto-fills the new value from now on. The actual
 * SQL Server update happens later, on export.
 */
function recordGroupChange(subcode, oldGroups, newGroups) {
  const id = db
    .prepare('INSERT INTO group_changes (subcode, old_groups, new_groups) VALUES (?, ?, ?)')
    .run(subcode, oldGroups, newGroups).lastInsertRowid;
  db.prepare('UPDATE subjects_cache SET total_scripts = ? WHERE subcode = ?').run(newGroups, subcode);
  return id;
}

function pendingGroupChangeCount() {
  return db.prepare('SELECT COUNT(*) c FROM group_changes WHERE exported = 0').get().c;
}

/** Full change history, newest first (for review). */
function groupChanges(limit = 100) {
  return db.prepare('SELECT * FROM group_changes ORDER BY id DESC LIMIT ?').all(limit);
}

/** Remove a change-log entry (local audit record only). */
function deleteGroupChange(id) {
  return db.prepare('DELETE FROM group_changes WHERE id = ?').run(id).changes;
}

/* ------------------------------------------------------------------ *
 * SQL Server: pull master data -> SQLite cache
 * ------------------------------------------------------------------ */
async function syncMasterData() {
  const pool = await sql.connect(mssqlConfig());
  try {
    const sessRs = await pool.request().query(
      'SELECT TOP 1 Current_Session FROM dbo.CURRENT_SESSION'
    );
    const sessn = sessRs.recordset.length ? sessRs.recordset[0].Current_Session : '';

    const subjRs = await pool.request().input('sessn', sql.VarChar, sessn).query(`
      SELECT DISTINCT
             t.SUBJECT                       AS subcode,
             t.DEPARTMENT                     AS dept,
             t.SEMESTER                       AS semester,
             ISNULL(s.TOTAL_SCRIPTS, 1)       AS total_scripts,
             t.SESSN                          AS sessn,
             CONVERT(char(10), t.DOE, 23)     AS doe,
             CASE WHEN t.Practical = 1 THEN 1 ELSE 0 END AS practical,
             t.SUBTITLE                       AS subtitle,
             CONVERT(char(5), t.TIME_FROM, 108) AS time_from,
             CONVERT(char(5), t.TIME_TO, 108)   AS time_to,
             t.DURATION                       AS duration
        FROM dbo.TIME_TABLE t
        LEFT JOIN dbo.Script_per_candidate s ON s.SUBJECT = t.SUBJECT
       WHERE t.SESSN = @sessn
       ORDER BY t.SUBJECT
    `);

    const replace = db.transaction((rows, session) => {
      db.prepare('DELETE FROM subjects_cache').run();
      const ins = db.prepare(
        `INSERT INTO subjects_cache (subcode, dept, semester, total_scripts, sessn, doe, practical,
                                     subtitle, time_from, time_to, duration)
         VALUES (@subcode, @dept, @semester, @total_scripts, @sessn, @doe, @practical,
                 @subtitle, @time_from, @time_to, @duration)
         ON CONFLICT(subcode, doe) DO UPDATE SET
           dept=excluded.dept, semester=excluded.semester,
           total_scripts=excluded.total_scripts, sessn=excluded.sessn,
           practical=excluded.practical, subtitle=excluded.subtitle,
           time_from=excluded.time_from, time_to=excluded.time_to,
           duration=excluded.duration`
      );
      for (const r of rows) {
        ins.run({
          subcode: r.subcode,
          dept: (r.dept || '').trim(),
          semester: (r.semester || '').trim(),
          total_scripts: r.total_scripts || 1,
          sessn: r.sessn || session,
          doe: r.doe || null,
          practical: r.practical ? 1 : 0,
          subtitle: (r.subtitle || '').trim(),
          time_from: r.time_from || null,
          time_to: r.time_to || null,
          duration: (r.duration || '').trim()
        });
      }
      setMeta('current_session', session);
      setMeta('last_sync', new Date().toISOString());
    });
    replace(subjRs.recordset, sessn);

    return { session: sessn, subjects: subjRs.recordset.length };
  } finally {
    await pool.close();
  }
}

/* ------------------------------------------------------------------ *
 * SQL Server: push pending packets -> dbo.Script_Count
 * ------------------------------------------------------------------ */
async function exportToSqlServer() {
  const pending = db.prepare('SELECT * FROM packets WHERE exported = 0 ORDER BY id').all();
  const pendingChanges = db.prepare('SELECT * FROM group_changes WHERE exported = 0 ORDER BY id').all();
  if (pending.length === 0 && pendingChanges.length === 0) {
    return { inserted: 0, updated: 0, failed: 0, total: 0, groupsUpdated: 0, groupsFailed: 0, errors: [] };
  }

  // Current date (no time) stamped into the Remark column, e.g. 2026-07-21.
  const now = new Date();
  const exportDate = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');

  const pool = await sql.connect(mssqlConfig());
  const markExported = db.prepare('UPDATE packets SET exported = 1 WHERE id = ?');
  let inserted = 0, updated = 0, failed = 0, groupsUpdated = 0, groupsFailed = 0;
  const errors = [];

  try {
    for (const p of pending) {
      try {
        // Match on the LOGICAL key (excluding No_of_Scripts): a packet is the same
        // packet regardless of its script count.
        const exists = await pool.request()
          .input('Dept', sql.NVarChar, p.dept)
          .input('Subcode', sql.VarChar, p.subcode)
          .input('PktNo', sql.Int, p.pkt_no)
          .input('Groups', sql.NVarChar, String(p.groups))
          .input('Sessn', sql.VarChar, p.sessn)
          .input('Paper_Type', sql.VarChar, p.paper_type)
          .query(`SELECT 1 FROM dbo.Script_Count
                   WHERE Dept=@Dept AND Subcode=@Subcode AND PktNo=@PktNo
                     AND Groups=@Groups AND Sessn=@Sessn AND Paper_Type=@Paper_Type`);

        if (exists.recordset.length) {
          // Already there -> UPDATE the count/remark in place (handles edits to
          // previously-exported records; No_of_Scripts is a PK col but SQL Server
          // allows updating it since the logical key still identifies one row).
          await pool.request()
            .input('Dept', sql.NVarChar, p.dept)
            .input('Subcode', sql.VarChar, p.subcode)
            .input('PktNo', sql.Int, p.pkt_no)
            .input('No_of_Scripts', sql.Int, p.no_of_scripts)
            .input('Remark', sql.NVarChar, exportDate)
            .input('Groups', sql.NVarChar, String(p.groups))
            .input('Sessn', sql.VarChar, p.sessn)
            .input('Paper_Type', sql.VarChar, p.paper_type)
            .query(`UPDATE dbo.Script_Count
                       SET No_of_Scripts=@No_of_Scripts, Remark=@Remark
                     WHERE Dept=@Dept AND Subcode=@Subcode AND PktNo=@PktNo
                       AND Groups=@Groups AND Sessn=@Sessn AND Paper_Type=@Paper_Type`);
          markExported.run(p.id);
          updated++;
          continue;
        }

        await pool.request()
          .input('Dept', sql.NVarChar, p.dept)
          .input('Subcode', sql.VarChar, p.subcode)
          .input('PktNo', sql.Int, p.pkt_no)
          .input('No_of_Scripts', sql.Int, p.no_of_scripts)
          .input('Remark', sql.NVarChar, exportDate)
          .input('Groups', sql.NVarChar, String(p.groups))
          .input('Entd', sql.Bit, 0)
          .input('Sessn', sql.VarChar, p.sessn)
          .input('Paper_Type', sql.VarChar, p.paper_type)
          .query(`INSERT INTO dbo.Script_Count
                    (Dept, Subcode, PktNo, No_of_Scripts, Remark, Groups, Entd, Sessn, Paper_Type)
                  VALUES
                    (@Dept, @Subcode, @PktNo, @No_of_Scripts, @Remark, @Groups, @Entd, @Sessn, @Paper_Type)`);

        markExported.run(p.id);
        inserted++;
      } catch (rowErr) {
        failed++;
        errors.push(`Pkt ${p.subcode}/${p.pkt_no}: ${rowErr.message}`);
      }
    }

    // Apply queued "No. of groups" changes to Script_per_candidate (UPDATE only).
    const markChange = db.prepare(
      "UPDATE group_changes SET exported = 1, exported_at = datetime('now','localtime') WHERE id = ?"
    );
    for (const c of pendingChanges) {
      try {
        const r = await pool.request()
          .input('Subject', sql.VarChar, c.subcode)
          .input('Total', sql.Int, c.new_groups)
          .query('UPDATE dbo.Script_per_candidate SET TOTAL_SCRIPTS = @Total WHERE SUBJECT = @Subject');
        markChange.run(c.id);          // mark done even if 0 rows (we never insert)
        if (r.rowsAffected[0] > 0) groupsUpdated++;
        else errors.push(`Groups ${c.subcode}: no matching row in Script_per_candidate (not updated)`);
      } catch (chgErr) {
        groupsFailed++;
        errors.push(`Groups ${c.subcode}: ${chgErr.message}`);
      }
    }
  } finally {
    await pool.close();
  }

  return { inserted, updated, failed, total: pending.length, groupsUpdated, groupsFailed, errors };
}

/* ================================================================== *
 * Question-paper allotment (room-wise QP entry)
 *
 * Local-only: add / edit / delete all happen in SQLite. Nothing here is
 * written back to SQL Server -- finalised subjects are marked "final" and
 * wait for a later export step. Only syncQpMaster() touches SQL Server, and
 * only to read. Exported below under the `qp` namespace.
 * ================================================================== */
// Seat planning is done for one campus only (dbo.[Count] is keyed by Campus_ID).
const CAMPUS_ID = parseInt(process.env.CAMPUS_ID || '1', 10);

// Column widths of dbo.room — checked before a subject is finalised so a later
// export cannot truncate or fail.
const LIMITS = { roomno: 50, subcode: 12, dept: 50, sem: 5 };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Rooms are matched case-insensitively — 'mcv-1' and 'MCV-1' are one room. */
function normRoom(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toUpperCase();
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * Resolve subcode + exam date to the full key (sessn, dept, sem) from the cached
 * timetable. Every other function here takes that key.
 */
function resolveSubject(subcode, doe) {
  const byDate = db.prepare(
    `SELECT subcode, TRIM(dept) AS dept, COALESCE(semester,'') AS sem, sessn, doe
       FROM subjects_cache WHERE subcode = ? AND doe = ?`
  );
  const anyDate = db.prepare(
    `SELECT subcode, TRIM(dept) AS dept, COALESCE(semester,'') AS sem, sessn, doe
       FROM subjects_cache WHERE subcode = ? ORDER BY doe LIMIT 1`
  );
  return (doe ? byDate.get(subcode, doe) : null) || anyDate.get(subcode) || null;
}

/** Required (Reg / Arr / Total) for a subject, campus-filtered. */
function required(subcode) {
  return db
    .prepare('SELECT reg, arr, total FROM count_cache WHERE subcode = ? AND campus_id = ?')
    .get(String(subcode).trim(), CAMPUS_ID) || null;
}

function campusId() { return CAMPUS_ID; }

/* ------------------------------------------------------------------ *
 * Subject rail
 * ------------------------------------------------------------------ */

/** Exam dates present in the cached timetable. */
function qpExamDates() {
  return db
    .prepare(`SELECT doe, COUNT(*) AS subjects FROM subjects_cache
               WHERE doe IS NOT NULL AND doe <> '' AND practical = 0
               GROUP BY doe ORDER BY doe`)
    .all();
}

/**
 * Every subject scheduled on `doe`, with its Required figure, what has been
 * entered so far, and its state. Subjects with no campus Count row come back with
 * req_total = null — the UI groups them separately rather than hiding them, so a
 * missing Count is visible instead of silent.
 */
function subjectsForDate(doe) {
  return db.prepare(`
    SELECT s.subcode,
           TRIM(s.dept)                  AS dept,
           COALESCE(s.semester,'')       AS sem,
           s.sessn,
           s.doe,
           c.reg, c.arr,
           c.total                       AS req_total,
           COALESCE(e.rooms, 0)          AS rooms,
           COALESCE(e.allotted, 0)       AS allotted,
           COALESCE(e.blanks, 0)         AS blanks,
           COALESCE(q.status, 'draft')   AS status
      FROM subjects_cache s
      LEFT JOIN count_cache c
             ON c.subcode = TRIM(s.subcode) AND c.campus_id = @campus
      LEFT JOIN (
            SELECT sessn, subcode, dept, sem,
                   COUNT(*) AS rooms,
                   SUM(qty) AS allotted,
                   SUM(CASE WHEN qty <= 0 THEN 1 ELSE 0 END) AS blanks
              FROM qp_rooms GROUP BY sessn, subcode, dept, sem
           ) e ON e.sessn = s.sessn AND e.subcode = s.subcode
              AND e.dept = TRIM(s.dept) AND e.sem = COALESCE(s.semester,'')
      LEFT JOIN qp_subjects q
             ON q.sessn = s.sessn AND q.subcode = s.subcode
            AND q.dept = TRIM(s.dept) AND q.sem = COALESCE(s.semester,'')
     WHERE s.doe = @doe AND s.practical = 0
     ORDER BY s.subcode
  `).all({ doe: doe, campus: CAMPUS_ID });
}

/* ------------------------------------------------------------------ *
 * Rows for one subject
 * ------------------------------------------------------------------ */

/**
 * The room grid. Entry order is preserved — that order is the walking order of
 * the block, captured the first time it was typed. `shared` counts other subjects
 * using the same room on the same day: legitimate, but worth showing.
 */
function rowsFor(k) {
  return db.prepare(`
    SELECT q.id, q.roomno, q.qty,
           COALESCE(m.max_qty, 0) AS max_qty,
           COALESCE(m.obs, 0)     AS obs,
           (SELECT COUNT(*) FROM qp_rooms o
             WHERE o.roomno = q.roomno AND o.doe = q.doe
               AND NOT (o.subcode = q.subcode AND o.dept = q.dept AND o.sem = q.sem)
           ) AS shared
      FROM qp_rooms q
      LEFT JOIN room_max m ON m.roomno = q.roomno
     WHERE q.sessn = @sessn AND q.subcode = @subcode
       AND q.dept = @dept AND q.sem = @sem
     ORDER BY q.id
  `).all(k);
}

function subjectState(k) {
  const row = db.prepare(
    `SELECT * FROM qp_subjects
      WHERE sessn=@sessn AND subcode=@subcode AND dept=@dept AND sem=@sem`
  ).get(k);
  return row || {
    sessn: k.sessn, subcode: k.subcode, dept: k.dept, sem: k.sem, doe: k.doe,
    status: 'draft', req_reg: null, req_arr: null, req_total: null,
    finalised_on: null, exported_on: null
  };
}

function isLocked(k) {
  return subjectState(k).status !== 'draft';
}

/** Totals for the sticky footer. */
function totals(k) {
  const t = db.prepare(
    `SELECT COUNT(*) AS rooms, COALESCE(SUM(qty),0) AS allotted,
            COALESCE(SUM(CASE WHEN qty <= 0 THEN 1 ELSE 0 END),0) AS blanks
       FROM qp_rooms
      WHERE sessn=@sessn AND subcode=@subcode AND dept=@dept AND sem=@sem`
  ).get(k);
  const req = required(k.subcode);
  return {
    rooms: t.rooms,
    allotted: t.allotted,
    blanks: t.blanks,
    reg: req ? req.reg : null,
    arr: req ? req.arr : null,
    required: req ? req.total : null,
    balance: req ? t.allotted - req.total : null
  };
}

/* ------------------------------------------------------------------ *
 * Writes (draft subjects only — callers check isLocked first)
 * ------------------------------------------------------------------ */

const upsertStmt = db.prepare(`
  INSERT INTO qp_rooms (sessn, doe, subcode, dept, sem, roomno, qty)
  VALUES (@sessn, @doe, @subcode, @dept, @sem, @roomno, @qty)
  ON CONFLICT (sessn, subcode, dept, sem, roomno)
  DO UPDATE SET qty = excluded.qty, updated_at = datetime('now','localtime')
`);

const findRow = db.prepare(
  `SELECT id FROM qp_rooms
    WHERE sessn=@sessn AND subcode=@subcode AND dept=@dept AND sem=@sem AND roomno=@roomno`
);

/** Add a room, or overwrite its count if the room is already listed. */
function upsertRow(k, roomno, qty) {
  const room = normRoom(roomno);
  if (!room) throw new Error('Room no. is required');
  const n = parseInt(qty, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error('No. of QPs must be 0 or more');
  const params = Object.assign({}, k, { roomno: room, qty: n });
  const existed = findRow.get(params);
  upsertStmt.run(params);
  return { id: findRow.get(params).id, replaced: !!existed };
}

function updateQty(id, qty) {
  const n = parseInt(qty, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error('No. of QPs must be 0 or more');
  return db.prepare(
    "UPDATE qp_rooms SET qty = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(n, id).changes > 0;
}

function updateRoom(id, roomno) {
  const room = normRoom(roomno);
  if (!room) throw new Error('Room no. is required');
  return db.prepare(
    "UPDATE qp_rooms SET roomno = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(room, id).changes > 0;
}

function getRow(id) {
  return db.prepare('SELECT * FROM qp_rooms WHERE id = ?').get(id);
}

function deleteRow(id) {
  return db.prepare('DELETE FROM qp_rooms WHERE id = ?').run(id).changes;
}

function clearSubject(k) {
  return db.prepare(
    `DELETE FROM qp_rooms WHERE sessn=@sessn AND subcode=@subcode AND dept=@dept AND sem=@sem`
  ).run(k).changes;
}

/* ------------------------------------------------------------------ *
 * Seeding / prefill
 * ------------------------------------------------------------------ */

/**
 * Sources for "Copy rooms": any subject in this session that already has rooms.
 * Same-date subjects come first (`other` = 0) since a day usually reuses one block
 * of rooms, then the most recently worked subjects from other dates -- a subject
 * often repeats its room list across exam days.
 */
function copySources(k) {
  return db.prepare(`
    SELECT subcode, dept, sem, doe,
           COUNT(*)                              AS rooms,
           COALESCE(SUM(qty),0)                  AS allotted,
           CASE WHEN doe = @doe THEN 0 ELSE 1 END AS other,
           MAX(COALESCE(updated_at, created_at)) AS last_entry
      FROM qp_rooms
     WHERE sessn = @sessn
       AND NOT (subcode = @subcode AND dept = @dept AND sem = @sem AND doe = @doe)
     GROUP BY subcode, dept, sem, doe
     ORDER BY other, CASE WHEN doe = @doe THEN subcode END, last_entry DESC
     LIMIT 40
  `).all(k);
}

const seedRows = db.transaction(function (k, rooms, withQty) {
  const ins = db.prepare(`
    INSERT INTO qp_rooms (sessn, doe, subcode, dept, sem, roomno, qty)
    VALUES (@sessn, @doe, @subcode, @dept, @sem, @roomno, @qty)
    ON CONFLICT (sessn, subcode, dept, sem, roomno) DO NOTHING
  `);
  let added = 0;
  for (const r of rooms) {
    added += ins.run(Object.assign({}, k, {
      roomno: normRoom(r.roomno),
      qty: withQty ? (parseInt(r.qty, 10) || 0) : 0
    })).changes;
  }
  return added;
});

/**
 * Seed the grid with rooms. source = 'SUBCODE|DEPT|SEM|DOE' copies that subject's
 * room list in its own order (the DOE may be another exam date, and defaults to
 * this subject's own); 'history' loads every room seen before, most-used first.
 *
 * withQty decides what lands in the QP column: false (the default) leaves every
 * copied room blank, true brings the counts over — the source subject's own counts,
 * or each room's Max when seeding from history. Rooms already in the grid are never
 * touched either way.
 */
function seed(k, source, withQty) {
  let rooms;
  if (source === 'history') {
    rooms = db.prepare(
      'SELECT roomno, max_qty AS qty FROM room_max ORDER BY obs DESC, roomno'
    ).all();
  } else {
    const parts = String(source || '').split('|');
    rooms = db.prepare(
      `SELECT roomno, qty FROM qp_rooms
        WHERE doe = ? AND subcode = ? AND dept = ? AND sem = ? ORDER BY id`
    ).all(parts[3] || k.doe, parts[0], parts[1], parts[2] || '');
  }
  return seedRows(k, rooms, !!withQty);
}

/** Fill every blank (qty 0) cell with that room's Max. Returns rows changed. */
function fillFromMax(k) {
  return db.prepare(`
    UPDATE qp_rooms
       SET qty = COALESCE((SELECT m.max_qty FROM room_max m WHERE m.roomno = qp_rooms.roomno), 0),
           updated_at = datetime('now','localtime')
     WHERE sessn=@sessn AND subcode=@subcode AND dept=@dept AND sem=@sem AND qty <= 0
  `).run(k).changes;
}

/** Room autocomplete — every room known, locally or from history. */
function roomSuggest(limit) {
  return db.prepare(
    'SELECT roomno, max_qty FROM room_max ORDER BY obs DESC, roomno LIMIT ?'
  ).all(limit || 400);
}

/* ------------------------------------------------------------------ *
 * Pre-flight checks + finalise
 * ------------------------------------------------------------------ */

/**
 * Everything that must be true before a subject is finalised. Errors block;
 * warnings can be accepted. Runs locally, so SQL Server only ever sees a
 * validated set whenever the export is wired up.
 */
function checks(k) {
  const out = [];
  const err = function (msg) { out.push({ level: 'error', msg: msg }); };
  const warn = function (msg) { out.push({ level: 'warn', msg: msg }); };

  const rows = rowsFor(k);
  const req = required(k.subcode);

  if (!rows.length) err('No rooms entered for this subject.');

  const blanks = rows.filter(function (r) { return r.qty <= 0; })
                     .map(function (r) { return r.roomno; });
  if (blanks.length) {
    err('No. of QPs is blank for ' + blanks.length + ' room(s): ' +
        blanks.slice(0, 6).join(', ') + (blanks.length > 6 ? ' …' : ''));
  }

  if (!req) {
    err('No record in Count for campus ' + CAMPUS_ID + ' — the required figure is unknown.');
  } else {
    const allotted = rows.reduce(function (s, r) { return s + r.qty; }, 0);
    if (allotted < req.total) {
      err('Short by ' + (req.total - allotted) + ' QP — allotted ' + allotted +
          ' against ' + req.total + ' required.');
    } else if (req.total > 0 && allotted - req.total > 25 && allotted > req.total * 1.25) {
      warn('Over-allotted by ' + (allotted - req.total) + ' QP (' +
           Math.round(((allotted - req.total) / req.total) * 100) + '% above required).');
    }
  }

  // Field widths of dbo.room — caught now rather than at export time.
  if (String(k.subcode).length > LIMITS.subcode) {
    err('Subject code is ' + String(k.subcode).length + ' characters; room.SUBCODE holds ' +
        LIMITS.subcode + '.');
  }
  if (String(k.dept).length > LIMITS.dept) err('Dept is longer than ' + LIMITS.dept + ' characters.');
  if (String(k.sem).length > LIMITS.sem) err('Semester is longer than ' + LIMITS.sem + ' characters.');
  const longRooms = rows.filter(function (r) { return r.roomno.length > LIMITS.roomno; })
                        .map(function (r) { return r.roomno; });
  if (longRooms.length) err('Room no. too long (max ' + LIMITS.roomno + '): ' + longRooms.join(', '));

  // The timetable may have moved since typing started.
  const tt = db.prepare(
    `SELECT 1 FROM subjects_cache
      WHERE subcode=@subcode AND TRIM(dept)=@dept
        AND COALESCE(semester,'')=@sem AND doe=@doe`
  ).get(k);
  if (!tt) warn('This subject/date is no longer in the cached timetable — re-sync master data.');

  const shared = rows.filter(function (r) { return r.shared > 0; })
                     .map(function (r) { return r.roomno; });
  if (shared.length) warn('Also used by another subject on this date: ' + shared.join(', ') + '.');

  return out;
}

/**
 * Lock a subject. Snapshots Reg/Arr/Total as they stand now, because dbo.[Count]
 * carries no session and is overwritten next session.
 */
function finalise(k, opts) {
  const problems = checks(k);
  if (problems.some(function (p) { return p.level === 'error'; })) {
    return { ok: false, problems: problems };
  }
  if (problems.length && !(opts && opts.acceptWarnings)) {
    return { ok: false, needsConfirm: true, problems: problems };
  }

  const req = required(k.subcode) || {};
  db.prepare(`
    INSERT INTO qp_subjects (sessn, subcode, dept, sem, doe, status, req_reg, req_arr, req_total, finalised_on)
    VALUES (@sessn, @subcode, @dept, @sem, @doe, 'final', @reg, @arr, @total, @at)
    ON CONFLICT (sessn, subcode, dept, sem) DO UPDATE SET
      status='final', doe=excluded.doe, req_reg=excluded.req_reg,
      req_arr=excluded.req_arr, req_total=excluded.req_total,
      finalised_on=excluded.finalised_on
  `).run(Object.assign({}, k, {
    reg: req.reg == null ? null : req.reg,
    arr: req.arr == null ? null : req.arr,
    total: req.total == null ? null : req.total,
    at: nowStr()
  }));
  return { ok: true, problems: problems };
}

/** Re-open a finalised subject for correction. */
function unlock(k) {
  return db.prepare(`
    UPDATE qp_subjects SET status='draft', finalised_on=NULL
     WHERE sessn=@sessn AND subcode=@subcode AND dept=@dept AND sem=@sem
  `).run(k).changes;
}

/* ------------------------------------------------------------------ *
 * Finalised data, ready for a later export to SQL Server
 * ------------------------------------------------------------------ */

/** Column-for-column with dbo.room. Nothing here is pushed automatically. */
function finalisedRows(doe) {
  return db.prepare(`
    SELECT q.sessn AS SESSN, q.subcode AS SUBCODE, q.dept AS DEPT,
           q.sem   AS SEM,   q.roomno  AS ROOMNO,  q.qty AS QTY,
           s.status, s.doe, s.finalised_on
      FROM qp_rooms q
      JOIN qp_subjects s ON s.sessn=q.sessn AND s.subcode=q.subcode
                        AND s.dept=q.dept  AND s.sem=q.sem
     WHERE s.status IN ('final','exported')
       AND (@doe IS NULL OR s.doe = @doe)
     ORDER BY s.doe, q.subcode, q.id
  `).all({ doe: doe || null });
}

/** Header counters for a date. */
function dateSummary(doe) {
  const subs = subjectsForDate(doe);
  const planned = subs.filter(function (s) { return s.req_total != null; });
  return {
    subjects: planned.length,
    unplanned: subs.length - planned.length,
    required: planned.reduce(function (s, r) { return s + (r.req_total || 0); }, 0),
    allotted: planned.reduce(function (s, r) { return s + r.allotted; }, 0),
    final: planned.filter(function (s) { return s.status !== 'draft'; }).length
  };
}

/**
 * One row per exam date: how much of that day's work is done. This is the
 * "how far have I got?" view -- the subject rail only ever shows one date.
 * `planned` counts subjects with a campus Count row (the ones needing a seat
 * plan); `subjects` counts everything in the timetable that day.
 */
function dateProgress() {
  return db.prepare(`
    SELECT s.doe,
           COUNT(*)                                                          AS subjects,
           SUM(CASE WHEN c.total IS NOT NULL THEN 1 ELSE 0 END)              AS planned,
           SUM(CASE WHEN c.total IS NOT NULL AND e.rooms > 0 THEN 1 ELSE 0 END) AS started,
           SUM(CASE WHEN q.status IN ('final','exported') THEN 1 ELSE 0 END) AS finalised,
           SUM(CASE WHEN q.status = 'exported' THEN 1 ELSE 0 END)            AS exported,
           COALESCE(SUM(c.total), 0)                                         AS required,
           COALESCE(SUM(e.allotted), 0)                                      AS allotted,
           MAX(e.last_entry)                                                 AS last_entry
      FROM subjects_cache s
      LEFT JOIN count_cache c
             ON c.subcode = TRIM(s.subcode) AND c.campus_id = @campus
      LEFT JOIN (
            SELECT sessn, subcode, dept, sem,
                   COUNT(*) AS rooms, SUM(qty) AS allotted,
                   MAX(COALESCE(updated_at, created_at)) AS last_entry
              FROM qp_rooms GROUP BY sessn, subcode, dept, sem
           ) e ON e.sessn = s.sessn AND e.subcode = s.subcode
              AND e.dept = TRIM(s.dept) AND e.sem = COALESCE(s.semester,'')
      LEFT JOIN qp_subjects q
             ON q.sessn = s.sessn AND q.subcode = s.subcode
            AND q.dept = TRIM(s.dept) AND q.sem = COALESCE(s.semester,'')
     WHERE s.doe IS NOT NULL AND s.doe <> '' AND s.practical = 0
     GROUP BY s.doe
     ORDER BY s.doe
  `).all({ campus: CAMPUS_ID });
}

/**
 * Rooms entered against a subject the app no longer shows, for any of three
 * reasons: no Count row for this campus (nothing to check the balance against),
 * the paper is a practical (excluded from the QP lists), or it has dropped out of
 * the timetable. None of them appear in the subject rail or in dateProgress, so
 * without this they would sit in the database forever, unnoticed.
 */
function orphanEntries() {
  return db.prepare(`
    SELECT q.doe, q.subcode, q.dept, q.sem,
           COUNT(*)                    AS rooms,
           COALESCE(SUM(q.qty),0)      AS qty,
           COALESCE(s.status, 'draft') AS status,
           CASE WHEN sc.subcode IS NULL  THEN 'not in the timetable'
                WHEN sc.practical = 1    THEN 'practical paper'
                ELSE 'no Count row for campus ' || @campus
           END                         AS reason
      FROM qp_rooms q
      LEFT JOIN subjects_cache sc
             ON sc.subcode = q.subcode AND sc.doe = q.doe
      LEFT JOIN count_cache c
             ON c.subcode = TRIM(q.subcode) AND c.campus_id = @campus
      LEFT JOIN qp_subjects s
             ON s.sessn = q.sessn AND s.subcode = q.subcode
            AND s.dept = q.dept AND s.sem = q.sem
     WHERE sc.subcode IS NULL OR sc.practical = 1 OR c.subcode IS NULL
     GROUP BY q.doe, q.subcode, q.dept, q.sem, s.status, reason
     ORDER BY q.doe, q.subcode
  `).all({ campus: CAMPUS_ID });
}

/** When any QP row was last added or changed, across every date. */
function lastActivity() {
  const r = db.prepare(
    'SELECT MAX(COALESCE(updated_at, created_at)) AS at FROM qp_rooms'
  ).get();
  return r ? r.at : null;
}

/**
 * Finalised subjects not yet pushed to SQL Server. Unlocking + re-finalising a
 * subject puts it back in this list, so a correction is exported again.
 */
function pendingExport(doe) {
  return db.prepare(`
    SELECT s.sessn, s.subcode, s.dept, s.sem, s.doe,
           COUNT(q.id)            AS rooms,
           COALESCE(SUM(q.qty),0) AS qty
      FROM qp_subjects s
      LEFT JOIN qp_rooms q ON q.sessn=s.sessn AND q.subcode=s.subcode
                          AND q.dept=s.dept  AND q.sem=s.sem
     WHERE s.status = 'final'
       AND (@doe IS NULL OR s.doe = @doe)
     GROUP BY s.sessn, s.subcode, s.dept, s.sem, s.doe
     ORDER BY s.doe, s.subcode
  `).all({ doe: doe || null });
}

/**
 * Push finalised subjects to dbo.room.
 *
 * One transaction PER SUBJECT, delete-then-insert:
 *   DELETE FROM room WHERE SESSN/SUBCODE/DEPT/SEM   -- clears the old set
 *   INSERT one row per room
 * That needs no key on dbo.room (it has none), is safe to re-run, and drops rooms
 * that were deleted locally after a correction. A subject that fails rolls back on
 * its own and stays 'final', so the next run retries just that one.
 */
async function exportQpToSqlServer(doe) {
  const subjects = pendingExport(doe);
  if (!subjects.length) {
    return { total: 0, subjects: 0, rows: 0, failed: 0, errors: [] };
  }

  const roomsOf = db.prepare(
    `SELECT roomno, qty FROM qp_rooms
      WHERE sessn=? AND subcode=? AND dept=? AND sem=? ORDER BY id`
  );
  const markExported = db.prepare(
    `UPDATE qp_subjects SET status='exported', exported_on=?
      WHERE sessn=? AND subcode=? AND dept=? AND sem=?`
  );

  const pool = await sql.connect(mssqlConfig());
  let done = 0, pushed = 0, failed = 0;
  const errors = [];

  try {
    for (const s of subjects) {
      const rows = roomsOf.all(s.sessn, s.subcode, s.dept, s.sem);
      const tx = new sql.Transaction(pool);
      let began = false;
      try {
        await tx.begin();
        began = true;

        await new sql.Request(tx)
          .input('sessn', sql.VarChar(50), s.sessn)
          .input('subcode', sql.NVarChar(12), s.subcode)
          .input('dept', sql.NVarChar(50), s.dept)
          .input('sem', sql.NVarChar(5), s.sem)
          .query(`DELETE FROM dbo.room
                   WHERE SESSN=@sessn AND SUBCODE=@subcode AND DEPT=@dept AND SEM=@sem`);

        for (const r of rows) {
          await new sql.Request(tx)
            .input('roomno', sql.NVarChar(50), r.roomno)
            .input('dept', sql.NVarChar(50), s.dept)
            .input('sem', sql.NVarChar(5), s.sem)
            .input('qty', sql.Int, r.qty)
            .input('subcode', sql.NVarChar(12), s.subcode)
            .input('sessn', sql.VarChar(50), s.sessn)
            .query(`INSERT INTO dbo.room (ROOMNO, DEPT, SEM, QTY, SUBCODE, SESSN)
                    VALUES (@roomno, @dept, @sem, @qty, @subcode, @sessn)`);
        }

        await tx.commit();
        markExported.run(nowStr(), s.sessn, s.subcode, s.dept, s.sem);
        done++;
        pushed += rows.length;
      } catch (e) {
        if (began) { try { await tx.rollback(); } catch (ignore) { /* already rolled back */ } }
        failed++;
        errors.push(s.subcode + ' (' + s.doe + '): ' + e.message);
      }
    }
  } finally {
    await pool.close();
  }

  return { total: subjects.length, subjects: done, rows: pushed, failed: failed, errors: errors };
}

/* ------------------------------------------------------------------ *
 * B.Com/BMS report: QP top sheet, one printed page per room (replaces the Crystal report)
 * ------------------------------------------------------------------ */

// Spare QPs added to every room's packet ("40 + 4 = 44").
const QP_EXTRA = parseInt(process.env.QP_EXTRA || '4', 10) || 0;

// Departments each report covers (as spelt in TIME_TABLE.DEPARTMENT).
const TOPSHEET_DEPTS = ['B.Com', 'B.M.S.'];
const ARTS_DEPTS = ['BA/BSc', 'BMBT', 'M.A.', 'M.Sc', 'MMFI', 'PG-DIPLOMA'];

function qpExtra() { return QP_EXTRA; }

/** Filter choices for a report: its departments, plus sem / date values with rooms entered. */
function reportFilters(depts) {
  const rows = db.prepare(`
    SELECT DISTINCT q.dept, q.sem, sc.doe
      FROM qp_rooms q
      JOIN subjects_cache sc ON sc.subcode = q.subcode AND TRIM(sc.dept) = q.dept
                            AND COALESCE(sc.semester,'') = q.sem
     WHERE q.qty > 0 AND sc.practical = 0
       AND q.dept IN (SELECT value FROM json_each(@depts))
  `).all({ depts: JSON.stringify(depts) });
  const uniq = function (f) {
    return rows.map(f).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).sort();
  };
  return {
    depts: depts.slice(),
    sems: uniq(function (r) { return r.sem; }),
    dates: uniq(function (r) { return r.doe; })
  };
}

/**
 * One entry per (subject, exam date) matching the filter, each with its rooms in
 * entry order -- that order gives the packet number. Blank filters match all;
 * f.depts is a list (multi-select), empty meaning every report department.
 */
function topSheets(f) {
  const subs = db.prepare(`
    SELECT DISTINCT q.sessn, q.subcode, q.dept, q.sem, sc.doe,
           sc.subtitle, sc.time_from, sc.time_to, sc.duration,
           COALESCE(s.status, 'draft') AS status
      FROM qp_rooms q
      JOIN subjects_cache sc ON sc.subcode = q.subcode AND TRIM(sc.dept) = q.dept
                            AND COALESCE(sc.semester,'') = q.sem
      LEFT JOIN qp_subjects s ON s.sessn = q.sessn AND s.subcode = q.subcode
                             AND s.dept = q.dept AND s.sem = q.sem
     WHERE q.qty > 0 AND sc.practical = 0
       AND q.dept IN (SELECT value FROM json_each(@depts))
       AND q.dept IN (SELECT value FROM json_each(@picked))
       AND (@sem  = '' OR q.sem  = @sem)
       AND (@doe  = '' OR sc.doe = @doe)
     ORDER BY sc.doe, q.dept, q.sem, q.subcode
  `).all({
    picked: JSON.stringify(f.depts && f.depts.length ? f.depts : TOPSHEET_DEPTS),
    sem: f.sem || '', doe: f.doe || '', depts: JSON.stringify(TOPSHEET_DEPTS)
  });

  const roomsOf = db.prepare(
    `SELECT roomno, qty FROM qp_rooms
      WHERE sessn=? AND subcode=? AND dept=? AND sem=? AND qty > 0 ORDER BY id`
  );
  return subs.map(function (s) {
    s.rooms = roomsOf.all(s.sessn, s.subcode, s.dept, s.sem);
    return s;
  });
}

function topSheetFilters() { return reportFilters(TOPSHEET_DEPTS); }
function artsFilters() { return reportFilters(ARTS_DEPTS); }

/**
 * Arts/Science report: one page per room per exam date, listing every subject
 * sitting in that room that day. scripts = answer scripts per candidate
 * (Script_per_candidate.TOTAL_SCRIPTS, cached as subjects_cache.total_scripts).
 */
function artsSheets(f) {
  const rows = db.prepare(`
    SELECT sc.doe, q.roomno, q.dept, q.sem, q.subcode, q.qty,
           sc.subtitle, sc.time_from, sc.time_to, sc.duration,
           sc.total_scripts AS scripts,
           COALESCE(s.status, 'draft') AS status
      FROM qp_rooms q
      JOIN subjects_cache sc ON sc.subcode = q.subcode AND TRIM(sc.dept) = q.dept
                            AND COALESCE(sc.semester,'') = q.sem
      LEFT JOIN qp_subjects s ON s.sessn = q.sessn AND s.subcode = q.subcode
                             AND s.dept = q.dept AND s.sem = q.sem
     WHERE q.qty > 0 AND sc.practical = 0
       AND q.dept IN (SELECT value FROM json_each(@depts))
       AND q.dept IN (SELECT value FROM json_each(@picked))
       AND (@sem = '' OR q.sem = @sem)
       AND (@doe = '' OR sc.doe = @doe)
     ORDER BY sc.doe, sc.time_from, q.dept, q.sem, q.subcode
  `).all({
    picked: JSON.stringify(f.depts && f.depts.length ? f.depts : ARTS_DEPTS),
    sem: f.sem || '', doe: f.doe || '', depts: JSON.stringify(ARTS_DEPTS)
  });

  const byKey = new Map();
  rows.forEach(function (r) {
    const k = r.doe + '|' + r.roomno;
    if (!byKey.has(k)) byKey.set(k, { doe: r.doe, roomno: r.roomno, rows: [], total: 0 });
    const p = byKey.get(k);
    p.rows.push(r);
    p.total += r.qty;
  });
  return Array.from(byKey.values()).sort(function (a, b) {
    return a.doe < b.doe ? -1 : a.doe > b.doe ? 1
      : a.roomno.localeCompare(b.roomno, undefined, { numeric: true });
  });
}

/* ------------------------------------------------------------------ *
 * SQL Server -> SQLite cache (read-only; runs from Sync Master Data)
 * ------------------------------------------------------------------ */
async function syncQpMaster() {
  const pool = await sql.connect(mssqlConfig());
  const result = { counts: 0, rooms: 0, warnings: [] };
  try {
    try {
      const rs = await pool.request().input('campus', sql.Int, CAMPUS_ID).query(`
        SELECT LTRIM(RTRIM(Sub_PCode)) AS subcode, Reg, Arr, Total
          FROM dbo.[Count]
         WHERE Campus_ID = @campus
      `);
      const replace = db.transaction(function (rows) {
        db.prepare('DELETE FROM count_cache WHERE campus_id = ?').run(CAMPUS_ID);
        const ins = db.prepare(
          `INSERT INTO count_cache (subcode, campus_id, reg, arr, total)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (subcode, campus_id) DO UPDATE SET
             reg=excluded.reg, arr=excluded.arr, total=excluded.total`
        );
        for (const r of rows) ins.run(r.subcode, CAMPUS_ID, r.Reg, r.Arr, r.Total || 0);
      });
      replace(rs.recordset);
      result.counts = rs.recordset.length;
    } catch (e) {
      result.warnings.push('Count: ' + e.message);
    }

    try {
      const rs = await pool.request().query(`
        SELECT LTRIM(RTRIM(ROOMNO)) AS roomno, MAX(QTY) AS max_qty, COUNT(*) AS uses
          FROM dbo.room
         WHERE ROOMNO IS NOT NULL AND LTRIM(RTRIM(ROOMNO)) <> ''
         GROUP BY LTRIM(RTRIM(ROOMNO))
      `);
      const replace = db.transaction(function (rows) {
        db.prepare('DELETE FROM room_stats').run();
        const ins = db.prepare(
          `INSERT INTO room_stats (roomno, max_qty, uses) VALUES (?, ?, ?)
           ON CONFLICT(roomno) DO UPDATE SET max_qty=excluded.max_qty, uses=excluded.uses`
        );
        for (const r of rows) ins.run(normRoom(r.roomno), r.max_qty || 0, r.uses || 0);
      });
      replace(rs.recordset);
      result.rooms = rs.recordset.length;
    } catch (e) {
      result.warnings.push('room: ' + e.message);
    }
  } finally {
    await pool.close();
  }
  return result;
}

module.exports = {
  db,
  mssqlConfig,
  currentSession,
  getSubjects,
  getSubject,
  examDates,
  searchSubjects,
  maxGroups,
  groupLetters,
  nextPktNo,
  insertPacket,
  insertPacketGroups,
  updatePacketScripts,
  existingGroups,
  searchPackets,
  recentPackets,
  stats,
  getPacket,
  removePacket,
  deleteExportedPacket,
  recordGroupChange,
  pendingGroupChangeCount,
  groupChanges,
  deleteGroupChange,
  getMeta,
  syncMasterData,
  exportToSqlServer,

  // Question-paper allotment (room-wise QP entry).
  qp: {
    campusId,
    normRoom,
    resolveSubject,
    required,
    examDates: qpExamDates,
    subjectsForDate,
    rowsFor,
    subjectState,
    isLocked,
    totals,
    upsertRow,
    updateQty,
    updateRoom,
    getRow,
    deleteRow,
    clearSubject,
    copySources,
    seed,
    fillFromMax,
    roomSuggest,
    checks,
    finalise,
    unlock,
    finalisedRows,
    dateSummary,
    dateProgress,
    orphanEntries,
    lastActivity,
    pendingExport,
    exportToSqlServer: exportQpToSqlServer,
    qpExtra,
    topSheetFilters,
    topSheets,
    artsFilters,
    artsSheets,
    syncQpMaster
  }
};
