import assert from "node:assert/strict";
import test from "node:test";
import { parseDelimitedTable } from "./delimited-table.ts";

test("parses CSV with quotes, escaped quotes, CRLF and blank lines", () => {
  assert.deepEqual(parseDelimitedTable('a,b\r\n"x,1","he said ""hi"""\r\n', ","), [
    ["a", "b"],
    ["x,1", 'he said "hi"'],
  ]);
});

test("parses TSV and keeps empty trailing fields", () => {
  assert.deepEqual(parseDelimitedTable("a\tb\t\n1\t\t3\n", "\t"), [
    ["a", "b", ""],
    ["1", "", "3"],
  ]);
});

test("caps rows and columns so a large file cannot lock the viewer", () => {
  const text = Array.from({ length: 10 }, (_, row) => Array.from({ length: 5 }, (_, col) => `${row}-${col}`).join(",")).join("\n");
  const rows = parseDelimitedTable(text, ",", 3, 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ["0-0", "0-1"]);
});
