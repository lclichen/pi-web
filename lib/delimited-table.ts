/**
 * Minimal RFC-4180 CSV/TSV parser for the file viewer: quoted fields, escaped
 * quotes, CRLF, and a hard cap so a huge file cannot lock the render.
 */
export function parseDelimitedTable(
  text: string,
  delimiter: string,
  maxRows = 2_000,
  maxCols = 100,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushField = () => {
    if (row.length < maxCols) row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > 0) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n") {
      pushRow();
      if (rows.length >= maxRows) return rows;
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}
