# Script Count — Answer Script Packet Entry

Small Express (express-generator + EJS) app for counting examination answer-script
packets. Dropdown data is pulled **from SQL Server** (`Exam` DB); entries are captured
**into SQLite**; captured packets are **exported back to SQL Server** (`dbo.Script_Count`).

No login required.

## Stack
- express-generator scaffold, view engine **EJS**
- **better-sqlite3** — local storage (`data/scriptcount.db`, created on first run)
- **mssql** — reads master data + writes exports to SQL Server
- Server JS kept minimal: `app.js`, `routes/index.js`, `routes/qp.js`, `db.js`, `bin/www`
- **`db.js` is the whole data layer** — the single `scriptcount.db` connection, every
  `CREATE TABLE`/`VIEW`/`INDEX`, the packet queries, and the QP allotment queries
  (exported under `require('./db').qp`)

## Configure
SQL Server connection is read from `.env` (already created with your values):

```
DB_HOST=localhost
DB_NAME=Exam
DB_USER=u1
DB_PASSWORD=123
# DB_INSTANCE=SQLEXPRESS   # optional named instance
# DB_PORT=1433             # optional
PORT=3000
```

## Daily start (Windows)
Two batch files in `scripts\`, meant to be copied to the Desktop:

- **`start-scriptcount.bat`** — starts the app under **pm2** in the background (no
  console window) and opens `/qp` in the browser. Click it again later and it
  *restarts* the app instead of starting a second copy, so a code change is picked up.
- **`stop-scriptcount.bat`** — removes it from pm2, and also stops anything else left
  holding the port (an `npm start` window, say). Entries live in
  `data\scriptcount.db`, so stopping never loses anything.

Needs pm2 once: `npm install -g pm2`.

**Nothing is registered to launch at Windows boot.** The scripts never run
`pm2 startup` or `pm2 save`, so the app runs only when you click the file.

Both read `PORT` from `.env`; the app location is the `APPDIR` line at the top of each
file. Pass `nobrowser` to start without opening a browser.

Useful pm2 commands: `pm2 logs scriptcount`, `pm2 list`, `pm2 restart scriptcount`.

## Run
```
npm install
npm run build:css   # compile Tailwind -> public/stylesheets/tailwind.css
npm start
```
Open http://localhost:3000

## Styling (Tailwind v4)
Layout/form markup uses inline Tailwind utility classes in the EJS views; the few
classes shared with client-generated HTML (table rows, tags, autocomplete list) live in
`styles/input.css` via `@apply`. It compiles to a self-contained `public/stylesheets/tailwind.css`
(no CDN, works offline). Rebuild after changing styles or class names:
```
npm run build:css     # one-off (minified)
npm run watch:css     # rebuild on change while developing
```
Uses **Tailwind v4** (`@tailwindcss/cli`): `styles/input.css` starts with the single line
`@import "tailwindcss";` (v4 auto-detects the templates — no `tailwind.config.js`, no
`@source` needed); the rest of that file is the app's own `@apply` component classes.
Note: v4 output targets modern browsers (Chrome/Edge 111+, Safari 16.4+).

## Workflow
1. **Sync Master Data** (top-right) — pulls the current session + subjects from SQL Server
   into a local cache so the dropdowns fill. Run whenever the timetable/session changes.
2. **Enter packets**:
   - **Subject** — from `TIME_TABLE.SUBJECT` (current session, joined on `SESSN`).
   - **Dept** — auto-fills from the subject (`TIME_TABLE.DEPARTMENT`).
   - **No. of groups** — `1..TOTAL_SCRIPTS` from `Script_per_candidate`.
   - **Type** — REGULAR / ARREAR.
   - **Pkt No.** — auto; resets to 1 per subject, increments after each save.
   - **No. of scripts** — type a number and press **Enter** → row is saved to SQLite,
     Pkt No. increments by 1, and the No.-of-scripts value stays selected for fast re-entry.
3. **Export to SQL Server** — inserts all *pending* packets into `dbo.Script_Count`
   (`Entd = 0`), updates any that already exist (matched on the logical key, not
   `No_of_Scripts`), then applies any queued **group-count changes** to
   `dbo.Script_per_candidate` (UPDATE only), and marks everything exported.

### No. of groups overrides
The "No. of groups" auto-fills from `Script_per_candidate.TOTAL_SCRIPTS`. If you change
it before saving, the override is logged in the local `group_changes` table (an audit
trail) and applied to `Script_per_candidate` on the next export — **UPDATE only, never
insert**. Review the history any time via the **Changes** link in the header (`/changes`).

## Data mapping (SQLite `packets` → `dbo.Script_Count`)
| packets        | Script_Count   |
|----------------|----------------|
| dept           | Dept           |
| subcode        | Subcode        |
| pkt_no         | PktNo          |
| no_of_scripts  | No_of_Scripts  |
| groups         | Groups         |
| paper_type     | Paper_Type     |
| sessn          | Sessn          |
| remark         | Remark         |
| (constant 0)   | Entd           |

## Question Paper Allotment (`/qp`)

Room-wise QP entry for a date + subject. **Everything is captured in SQLite**
(`data/scriptcount.db`, the same file the packet entry uses) — add, edit and delete
freely. Nothing is written to SQL Server by this module; finalised subjects wait for
an export step you run later.

### Screen
- **Context bar** — exam date, the selected subject with its Dept/Sem, and
  **Required = Reg + Arr** from `dbo.[Count]` for `CAMPUS_ID`.
- **Subject rail** — every subject on that date with an `entered/required` badge and a
  status dot (grey = nothing, amber = partial, green = balanced, blue = over,
  dark green = finalised). Unfinished subjects sort to the top. Subjects with no
  Count row for the campus collapse into a *Not in Count* group — shown, not hidden,
  so a missing count is visible rather than silent.
- **Room grid** — `Room | Max | QP | Running`. Dept/Sem/Subject are in the header, not
  repeated on every row. **Max** is the largest QP that room has ever held.
- **Sticky footer** — rooms, allotted, required, live balance, and Finalise.

### Keyboard
| Key | Action |
|---|---|
| `Enter` in QP | save and move down to the next room |
| `↑` / `↓` | walk the QP column |
| `Enter` in the new-room box | jump to its QP box (blank QP + a known Max saves the Max) |
| `F4` | fill every blank QP cell with that room's Max |
| `Ctrl+Enter` | finalise the subject |

### Speed helpers
- **Copy rooms from…** another subject on the same date (its row order is preserved —
  that order is the walking order of the block).
- **All rooms** — load every room ever seen.
- **Fill blanks with Max** — then edit only the exceptions.

### Finalise
Runs pre-flight checks first: no rooms, blank QP cells, no Count row, short against
Required, field widths of `dbo.room`, timetable drift, rooms shared with another
subject that day. Errors block; warnings ask for confirmation. Finalising **snapshots
Reg/Arr/Total** (the Count table has no session column and is overwritten each
session) and locks the subject — `Unlock` re-opens it for correction.

Only finalised subjects feed the **Max** column, so half-typed drafts can never set a
room's ceiling.

### Exporting to `dbo.room`
`/qp/final` lists the finalised rows column-for-column with `dbo.room` and says how
many subjects are waiting. **Export to SQL Server** pushes them; `/qp/final.csv`
downloads the same rows if you would rather import them yourself.

The push is **delete-then-insert per subject**, one transaction each:
`DELETE FROM room WHERE SESSN=? AND SUBCODE=? AND DEPT=? AND SEM=?`, then one INSERT
per room. That needs no key on `dbo.room` (it has none), is safe to re-run, and drops
rooms deleted locally after a correction. A subject that fails rolls back alone and
stays `final`, so the next run retries only that one. Exported subjects flip to
`exported`; unlocking and re-finalising one puts it back in the queue.

### How far have I got? (`/qp/progress`)
The **Progress** link in the header opens a date-by-date view of the whole session:
per exam date, how many subjects need a seat plan, how many are started, finalised
and exported, required vs allotted, a progress bar, and when that date was last
worked on. Four cards at the top answer the usual question directly — **Entered up
to**, **Next date to do**, **Dates complete**, **Subjects finalised**. Each row links
straight into that date.

Two banners sit at the top when they apply:
- **Entered but not finalised** -- dates where rooms were typed but the subject was
  never locked, as clickable date chips. Nothing else nags you about this, because
  the entry screen moves straight on to the next subject after a save.
- **Entries the lists no longer show** -- rooms entered against a subject that has
  since dropped out of the lists, with the reason on each row: *no Count row for the
  campus*, *practical paper*, or *not in the timetable*. These can never be finalised
  and never export, and they are counted nowhere else on the page. Either re-sync once
  the master data is right, or open the subject and delete the rows.

Each date row also carries a plain status: *needs finalising*, *part done*,
*finalised*, *exported* or *not started*.

The date dropdown on the entry screen carries the same figure (`2026-05-13 · 2/7
done`), so you can see where you stopped without leaving the page.

### One allotment per subject
`qp_rooms` and `qp_subjects` are keyed on **SESSN + SUBCODE + DEPT + SEM, without the
exam date** -- deliberately, because `dbo.room` has no date column either. If a subject
code is scheduled on two dates in one session, both dates share one room list. Opening
it on either date shows and edits the same rows.

### Master data
`Sync Master Data` (either page) caches, read-only:
- `TIME_TABLE` → subjects + exam dates (existing behaviour)
- `dbo.[Count]` where `Campus_ID = CAMPUS_ID` → Required figures
- `MAX(QTY)` per `ROOMNO` from `dbo.room` → seeds the Max column on a new install

Set the campus in `.env`:
```
CAMPUS_ID=1
```
