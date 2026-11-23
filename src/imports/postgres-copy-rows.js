'use strict';

function cell(value) {
  if (value === undefined || value === null) return '\\N';
  return '"' + String(value).replaceAll('"', '""') + '"';
}

async function* encode(rows) {
  // Bounded chunks and stream backpressure avoid another full JSON copy of
  // the workbook. CSV escaping preserves quotes, tabs, commas and newlines.
  for (let start = 0; start < rows.length; start += 250) {
    yield rows.slice(start, start + 250).map(row => [
      row.id, row.rowNumber, JSON.stringify(row.raw), JSON.stringify(row.parsed),
      row.status, JSON.stringify(row.problems), row.parsed.locationId || null,
      row.parsed.quantity ?? null,
    ].map(cell).join(',') + '\n').join('');
  }
}

async function insert(client, workspaceId, importId, rows, at) {
  await client.query(`CREATE TEMP TABLE stockchief_import_row_input (
    id text, row_number bigint, raw jsonb, parsed jsonb, status text,
    problems jsonb, location_id text, quantity numeric
  ) ON COMMIT DROP`);
  await client.copyFrom("COPY pg_temp.stockchief_import_row_input (id, row_number, raw, parsed, status, problems, location_id, quantity) FROM STDIN WITH (FORMAT csv, NULL '\\N')", encode(rows));
  const inserted = await client.query(`INSERT INTO import_rows
    (id,import_id,workspace_id,row_number,raw,parsed,status,problems,location_id,quantity,created_at)
    SELECT id,$2,$1,row_number,raw,parsed,status,problems,location_id,quantity,$3
    FROM pg_temp.stockchief_import_row_input`, [workspaceId, importId, at]);
  if (inserted.rowCount !== rows.length) throw new Error('The staged import row count did not reconcile.');
  await client.query('DROP TABLE pg_temp.stockchief_import_row_input');
}

module.exports = { insert, encode, cell };
