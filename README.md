# Script Count — Answer Script Packet Entry

Small Express (express-generator + EJS) app for counting examination answer-script
packets. Dropdown data is pulled **from SQL Server** (`Exam` DB); entries are captured
**into SQLite**; captured packets are **exported back to SQL Server** (`dbo.Script_Count`).

No login required.

## Stack
- express-generator scaffold, view engine **EJS**
- **better-sqlite3** — local storage (`data/scriptcount.db`, created on first run)
- **mssql** — reads master data + writes exports to SQL Server
- Server JS kept minimal: `app.js`, `routes/index.js`, `db.js`, `bin/www`

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
