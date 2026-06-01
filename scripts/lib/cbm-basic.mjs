// Commodore BASIC v2 tokenizer + .prg assembler — shared by the C64 and VIC-20
// game generators. The C64 and VIC-20 use the IDENTICAL BASIC v2 token table
// and the identical line-link / .prg layout; only the BASIC load address differs
// (C64 = $0801, VIC-20 unexpanded = $1001). So one module serves both.
//
// Output is a tokenized .prg exactly as the KERNAL stores a program on entry,
// so it RUNs directly. Everything emitted here is our own content (CC0).

// C64 / VIC-20 BASIC v2 tokens (0x80..0xCB). Order matters: index = token-0x80.
export const TOKENS = [
  'END','FOR','NEXT','DATA','INPUT#','INPUT','DIM','READ','LET','GOTO','RUN',
  'IF','RESTORE','GOSUB','RETURN','REM','STOP','ON','WAIT','LOAD','SAVE',
  'VERIFY','DEF','POKE','PRINT#','PRINT','CONT','LIST','CLR','CMD','SYS',
  'OPEN','CLOSE','GET','NEW','TAB(','TO','FN','SPC(','THEN','NOT','STEP',
  '+','-','*','/','^','AND','OR','>','=','<','SGN','INT','ABS','USR','FRE',
  'POS','SQR','RND','LOG','EXP','COS','SIN','TAN','ATN','PEEK','LEN','STR$',
  'VAL','ASC','CHR$','LEFT$','RIGHT$','MID$','GO',
];
const tokenValue = (kw) => 0x80 + TOKENS.indexOf(kw);

/** Tokenize one line of BASIC source text (already upper-cased). */
export function tokenizeLine(text) {
  const out = [];
  let i = 0, inQuote = false, inRem = false;
  while (i < text.length) {
    const ch = text[i];
    if (inRem) { out.push(text.charCodeAt(i)); i++; continue; }
    if (ch === '"') { inQuote = !inQuote; out.push(0x22); i++; continue; }
    if (inQuote) { out.push(text.charCodeAt(i)); i++; continue; }
    // Longest-match against the token table (outside quotes only) — mirrors the
    // ROM tokenizer, including its quirk of tokenizing keywords inside what look
    // like variable names (so avoid var names containing keyword substrings).
    let best = null;
    for (const kw of TOKENS) {
      if (text.startsWith(kw, i) && (best === null || kw.length > best.length)) best = kw;
    }
    if (best) {
      out.push(tokenValue(best));
      i += best.length;
      if (best === 'REM') inRem = true;
      continue;
    }
    out.push(text.charCodeAt(i)); // digits, vars, ( ) ; : $ space, etc.
    i++;
  }
  return out;
}

/**
 * Assemble a BASIC listing into a .prg Buffer.
 *   listing  — array of [lineNumber, sourceText]
 *   loadAddr — BASIC start address ($0801 C64, $1001 VIC-20 unexpanded)
 * Emits: 2-byte load address, then linked tokenized lines, then $0000 terminator.
 */
export function assemblePrg(listing, loadAddr) {
  const bytes = [loadAddr & 0xff, (loadAddr >> 8) & 0xff];
  const records = listing.map(([num, text]) => {
    const toks = tokenizeLine(String(text).toUpperCase());
    return { num, body: [num & 0xff, (num >> 8) & 0xff, ...toks, 0x00] };
  });
  let addr = loadAddr;
  for (const r of records) {
    const next = addr + 2 + r.body.length;   // 2 link bytes + body
    bytes.push(next & 0xff, (next >> 8) & 0xff, ...r.body);
    addr = next;
  }
  bytes.push(0x00, 0x00);                     // end-of-program marker
  return Buffer.from(bytes);
}
