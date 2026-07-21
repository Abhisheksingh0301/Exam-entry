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
             CONVERT(char(10), t.DOE, 23)     AS doe
        FROM dbo.TIME_TABLE t
        LEFT JOIN dbo.Script_per_candidate s ON s.SUBJECT = t.SUBJECT
       WHERE t.SESSN = @sessn
       ORDER BY t.SUBJECT
    `);

    const replace = db.transaction((rows, session) => {
      db.prepare('DELETE FROM subjects_cache').run();
      const ins = db.prepare(
        `INSERT INTO subjects_cache (subcode, dept, semester, total_scripts, sessn, doe)
         VALUES (@subcode, @dept, @semester, @total_scripts, @sessn, @doe)
         ON CONFLICT(subcode, doe) DO UPDATE SET
           dept=excluded.dept, semester=excluded.semester,
           total_scripts=excluded.total_scripts, sessn=excluded.sessn`
      );
      for (const r of rows) {
        ins.run({
          subcode: r.subcode,
          dept: (r.dept || '').trim(),
          semester: (r.semester || '').trim(),
          total_scripts: r.total_scripts || 1,
          sessn: r.sessn || session,
          doe: r.doe || null
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

module.exports = {
  db,
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
  exportToSqlServer
};
