/**
 * Minimal YAML reader covering exactly the config shape claudex documents:
 * nested block mappings, block sequences, flow sequences (`[a, b]`), quoted and
 * bare scalars, and `#` comments.
 *
 * Rationale: a full YAML implementation is a runtime dependency on a hot path
 * that runs before every `claude` invocation. The config schema here is small
 * and fully specified, so parsing it directly keeps claudex dependency-free and
 * its startup cost near zero. Anything outside the documented subset (anchors,
 * multi-line scalars, flow maps, multiple documents) raises a clear error
 * rather than being silently mis-parsed.
 *
 * JSON is also accepted: a document starting with `{` is handed to JSON.parse,
 * since every JSON file is valid YAML anyway.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  indent: number;
  text: string;
  /** 1-based source line, for error messages. */
  no: number;
}

/** Strip a trailing `# comment`, respecting quoted regions. */
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // Only a comment when at line start or preceded by whitespace, so that
      // values such as `color: #fff` survive.
      if (i === 0 || /\s/.test(raw[i - 1] ?? '')) return raw.slice(0, i);
    }
  }
  return raw;
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? '';
    if (raw.includes('\t')) {
      const before = raw.slice(0, raw.indexOf('\t'));
      if (!before.trim()) throw new YamlError('tabs cannot be used for indentation', i + 1);
    }
    const stripped = stripComment(raw);
    const trimmed = stripped.trim();
    if (!trimmed) continue;
    if (trimmed === '---') continue;
    if (trimmed === '...') break;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: trimmed, no: i + 1 });
  }
  return lines;
}

function unquote(value: string, lineNo: number): string {
  const quote = value[0];
  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw new YamlError('unterminated quoted string', lineNo);
  }
  const body = value.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(["\\ntr])/g, (_, esc: string) => {
    switch (esc) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return esc;
    }
  });
}

function parseScalar(value: string, lineNo: number): YamlValue {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return unquote(trimmed, lineNo);

  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw new YamlError('unterminated flow sequence', lineNo);
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner, lineNo).map((item) => parseScalar(item, lineNo));
  }

  if (trimmed.startsWith('{')) {
    throw new YamlError('flow mappings ({...}) are not supported by the claudex config parser', lineNo);
  }

  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true' || trimmed === 'yes' || trimmed === 'on') return true;
  if (trimmed === 'false' || trimmed === 'no' || trimmed === 'off') return false;

  // Bare numbers only; anything with a stray character stays a string so that
  // values like `${CLAUDE_TOKEN_1}` or `2024-01-01` are preserved verbatim.
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);

  return trimmed;
}

/** Split `a, "b, c", d` on top-level commas only. */
function splitFlow(inner: string, lineNo: number): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (inSingle || inDouble) throw new YamlError('unterminated quoted string in flow sequence', lineNo);
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Split `key: value` at the first structural colon. */
function splitKey(text: string, lineNo: number): { key: string; rest: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = text[i + 1];
      if (next === undefined || next === ' ') {
        const rawKey = text.slice(0, i).trim();
        const key =
          rawKey.startsWith('"') || rawKey.startsWith("'") ? unquote(rawKey, lineNo) : rawKey;
        return { key, rest: text.slice(i + 1).trim() };
      }
    }
  }
  throw new YamlError(`expected "key: value", got ${JSON.stringify(text)}`, lineNo);
}

class Parser {
  #lines: Line[];
  #pos = 0;

  constructor(lines: Line[]) {
    this.#lines = lines;
  }

  #peek(): Line | undefined {
    return this.#lines[this.#pos];
  }

  parseDocument(): YamlValue {
    const first = this.#peek();
    if (!first) return null;
    const value = this.parseNode(first.indent);
    const trailing = this.#peek();
    if (trailing) throw new YamlError('unexpected indentation', trailing.no);
    return value;
  }

  parseNode(indent: number): YamlValue {
    const line = this.#peek();
    if (!line) return null;
    return line.text === '-' || line.text.startsWith('- ')
      ? this.parseSequence(indent)
      : this.parseMapping(indent);
  }

  parseSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (;;) {
      const line = this.#peek();
      if (!line || line.indent !== indent) break;
      if (line.text !== '-' && !line.text.startsWith('- ')) break;

      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      if (rest === '') {
        this.#pos++;
        const next = this.#peek();
        items.push(next && next.indent > indent ? this.parseNode(next.indent) : null);
        continue;
      }

      // `- key: value` starts a mapping whose keys live at indent + 2.
      let isMapping = false;
      try {
        splitKey(rest, line.no);
        isMapping = true;
      } catch {
        isMapping = false;
      }

      if (isMapping) {
        // Rewrite the item head as a normal mapping line so parseMapping can
        // consume it together with its continuation lines.
        this.#lines[this.#pos] = { indent: indent + 2, text: rest, no: line.no };
        items.push(this.parseMapping(indent + 2));
      } else {
        items.push(parseScalar(rest, line.no));
        this.#pos++;
      }
    }
    return items;
  }

  parseMapping(indent: number): Record<string, YamlValue> {
    const map: Record<string, YamlValue> = {};
    for (;;) {
      const line = this.#peek();
      if (!line || line.indent !== indent) break;
      if (line.text === '-' || line.text.startsWith('- ')) break;

      const { key, rest } = splitKey(line.text, line.no);
      if (key in map) throw new YamlError(`duplicate key ${JSON.stringify(key)}`, line.no);
      this.#pos++;

      if (rest !== '') {
        map[key] = parseScalar(rest, line.no);
        continue;
      }

      const next = this.#peek();
      if (!next) {
        map[key] = null;
        continue;
      }
      // A block sequence may sit at the parent's indentation.
      if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
        map[key] = this.parseSequence(indent);
      } else if (next.indent > indent) {
        map[key] = this.parseNode(next.indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  }
}

export function parseYaml(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as YamlValue;
  }
  return new Parser(tokenize(text)).parseDocument();
}
