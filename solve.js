// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// {text, header}: {columns, rows, errors}. The reading policy is the
// brief's own: BOM dropped, records end at LF or CRLF, empty lines are no
// records, a lone CR outside quotes is dropped (stray_cr), a field that
// opens with a quote runs to the next non-doubled quote ("" inside is one
// quote, CRLF or lone CR inside reads as LF), junk after the closing
// quote is appended as it stands (quote_junk), a quote that never closes
// is a literal and the rest is re-read unquoted (unterminated_quote),
// fields stay strings, rows are padded (short_row) or cut (long_row) to
// the first record's width, and every error is {code, line, row} in the
// order met.
//
// Speed design (the metric here is CPU time alone):
//   - An unquoted field is scanned for its terminator and taken with one
//     slice: one allocation per field, not one per character.
//   - A quoted field finds its closing quote with indexOf (memchr);
//     content without CR, LF or "" is one slice, and only the rare field
//     with an escape or an embedded line break falls back to a slow
//     character walk.
//   - Errors are built only for broken records (a few percent), and the
//     line number is kept incrementally instead of being recomputed.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // General path: read the record field by field. (A clean-line shortcut
    // with indexOf plus split was measured slower: the quote and CR scans
    // run past the line, so the plain scan below wins.)
    const fields = [];
    let quoted = false;
    let ended = COMMA;
    let field;
    do {
      // Read one field into `field`, and set `ended` and `quoted`.
      let init = null; // when set, scan the field as unquoted from `pos` starting with this value
      let countAdded = false; // when true, count kept characters and report quote_junk if any
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let close = -1;
        let hasEscape = false;
        let q = text.indexOf('"', pos + 1);
        while (q !== -1) {
          if (text.charCodeAt(q + 1) === 34) {
            hasEscape = true;
            q = text.indexOf('"', q + 2);
          } else {
            close = q;
            break;
          }
        }
        if (close === -1) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          init = '"';
        } else {
          // The quoted content spans [open + 1, close). Look for a CR
          // and count LFs in it; an escape was already seen above.
          let hasCR = false;
          let nlCount = 0;
          for (let j = open + 1; j < close; j++) {
            const c = text.charCodeAt(j);
            if (c === 13) {
              hasCR = true;
              break;
            }
            if (c === 10) nlCount += 1;
          }
          let value;
          if (!hasEscape && !hasCR && nlCount === 0) {
            value = text.slice(open + 1, close);
          } else if (!hasEscape && !hasCR) {
            value = text.slice(open + 1, close);
            line += nlCount;
          } else {
            // Slow path: escapes and embedded line breaks, rare.
            let v = '';
            let j = open + 1;
            while (j < close) {
              const c = text.charCodeAt(j);
              if (c === 34) {
                v += '"';
                j += 2;
                continue;
              }
              if (c === 13) {
                v += '\n';
                line += 1;
                j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
                continue;
              }
              if (c === 10) line += 1;
              v += text[j];
              j += 1;
            }
            value = v;
          }
          pos = close + 1;
          if (pos >= len) {
            field = value;
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              field = value;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              field = value;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              field = value;
              ended = LINE_BREAK;
            } else {
              // Junk follows the closing quote: read it as unquoted,
              // appended to the quoted value.
              init = value;
              countAdded = true;
            }
          }
        }
      } else {
        quoted = false;
        init = '';
      }

      if (init !== null) {
        // Scan an unquoted field from pos: keep the text up to the next
        // comma or line break, dropping lone CRs (stray_cr). `added`
        // counts the characters kept, which the junk path needs.
        let kept = init;
        let added = 0;
        let fStart = pos;
        let i = pos;
        for (;;) {
          while (i < len) {
            const c = text.charCodeAt(i);
            if (c === 44 || c === 10 || c === 13) break;
            i += 1;
          }
          if (i >= len) {
            kept += text.slice(fStart, len);
            added += len - fStart;
            pos = len;
            ended = END;
            break;
          }
          const c = text.charCodeAt(i);
          if (c === 44) {
            kept += text.slice(fStart, i);
            added += i - fStart;
            pos = i + 1;
            ended = COMMA;
            break;
          }
          if (c === 10) {
            kept += text.slice(fStart, i);
            added += i - fStart;
            pos = i + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          if (text.charCodeAt(i + 1) === 10) {
            kept += text.slice(fStart, i);
            added += i - fStart;
            pos = i + 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          // A lone CR: dropped, and the error stays in order.
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          kept += text.slice(fStart, i);
          added += i - fStart;
          i += 1;
          fStart = i;
        }
        field = kept;
        if (countAdded && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }
      fields.push(field);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
