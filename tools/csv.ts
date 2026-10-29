// Streaming CSV reader for IGDB dumps (RFC 4180: quoted fields, "" escapes,
// newlines inside quotes). Yields each row as an object keyed by header name.

import { createReadStream } from "node:fs";

export type Row = Record<string, string>;

// Parser states. (Plain constants: Node's type stripping doesn't support enums.)
const State = {
  FieldStart: 0,
  Unquoted: 1,
  Quoted: 2,
  QuoteInQuoted: 3, // saw `"` inside a quoted field: either an escape (`""`) or the closing quote
} as const;

export async function* readCSV(path: string): AsyncGenerator<Row> {
  let header: string[] | undefined;
  let fields: string[] = [];
  let field = "";
  let state: number = State.FieldStart;

  const finishRow = (): Row | undefined => {
    fields.push(field);
    field = "";
    const completed = fields;
    fields = [];
    if (!header) {
      header = completed;
      return undefined;
    }
    if (completed.length === 1 && completed[0] === "") return undefined; // blank line
    const record: Row = {};
    for (let i = 0; i < header.length; i++) record[header[i]] = completed[i] ?? "";
    return record;
  };

  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    const text = chunk as string;
    let runStart = 0; // start of the pending slice of `text` not yet appended to `field`
    let i = 0;
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (state === State.Quoted) {
        if (ch === 34 /* " */) {
          field += text.slice(runStart, i);
          state = State.QuoteInQuoted;
        }
        i++;
        continue;
      }
      if (state === State.QuoteInQuoted) {
        if (ch === 34) {
          field += '"';
          state = State.Quoted;
          runStart = i + 1;
          i++;
          continue;
        }
        state = State.Unquoted; // closing quote; reprocess this char as unquoted
        runStart = i;
      }
      if (state === State.FieldStart && ch === 34) {
        state = State.Quoted;
        runStart = i + 1;
      } else if (ch === 44 /* , */) {
        fields.push(field + text.slice(runStart, i));
        field = "";
        state = State.FieldStart;
        runStart = i + 1;
      } else if (ch === 10 /* \n */) {
        field += text.slice(runStart, i);
        if (field.endsWith("\r")) field = field.slice(0, -1);
        const record = finishRow();
        state = State.FieldStart;
        runStart = i + 1;
        if (record) yield record;
      } else {
        state = State.Unquoted;
      }
      i++;
    }
    if (state !== State.QuoteInQuoted) field += text.slice(runStart);
  }
  if (field !== "" || fields.length > 0) {
    const record = finishRow();
    if (record) yield record;
  }
}

/** Parses IGDB array columns such as `{1,2,3}` into numbers. */
export function intList(value: string): number[] {
  if (!value || value.length < 3) return [];
  return value
    .slice(1, -1)
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

export function int(value: string): number | undefined {
  if (value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
