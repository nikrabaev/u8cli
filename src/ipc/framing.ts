/**
 * Newline-delimited JSON framing.
 *
 * A socket hands us bytes, not messages: one chunk may carry half a frame, three
 * frames, or a split multi-byte character. Decoding is therefore stateful and
 * lives here, so the server and client only ever see whole values.
 *
 * Decoding never throws — a malformed frame is returned as a result so one bad
 * line from a peer (or a `socat` experiment) cannot poison the rest of the stream.
 */

const LF = 0x0a;
const CR = 0x0d;
const EMPTY = Buffer.alloc(0);

/** Hard ceiling for a single frame: a peer that never sends `\n` must not OOM us. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** How much of an undecodable frame is kept for diagnostics. */
const RAW_PREVIEW_CHARS = 256;

export type DecodedMessage =
  | { ok: true; value: unknown }
  | { ok: false; error: Error; raw: string };

/**
 * Serializes one message, including its terminating newline.
 *
 * Throws rather than emitting a frame for a value JSON drops entirely
 * (`undefined`, a function, a symbol) — `"undefined\n"` would look like a frame
 * on the wire and only fail at the far end, where nobody can fix it.
 */
export function encodeMessage(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`value of type ${typeof value} has no JSON representation`);
  return `${json}\n`;
}

export class LineDecoder {
  readonly #maxLineBytes: number;
  #buf: Buffer = EMPTY;
  /** True while dropping the tail of an oversized frame, up to its newline. */
  #discarding = false;

  constructor(maxLineBytes: number = MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  /** Bytes currently held back waiting for a newline. */
  get buffered(): number {
    return this.#buf.length;
  }

  push(chunk: Buffer): DecodedMessage[] {
    const out: DecodedMessage[] = [];
    let input = chunk;

    if (this.#discarding) {
      const nl = input.indexOf(LF);
      if (nl === -1) return out;
      this.#discarding = false;
      input = input.subarray(nl + 1);
    }

    let buf = this.#buf.length === 0 ? input : Buffer.concat([this.#buf, input]);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(LF, start);
      if (nl === -1) break;
      const decoded = this.#decodeLine(buf.subarray(start, nl));
      if (decoded) out.push(decoded);
      start = nl + 1;
    }

    const rest = buf.subarray(start);
    if (rest.length > this.#maxLineBytes) {
      out.push({
        ok: false,
        error: new Error(`frame exceeds ${this.#maxLineBytes} bytes without a newline`),
        raw: rest.subarray(0, RAW_PREVIEW_CHARS).toString("utf8"),
      });
      this.#discarding = true;
      this.#buf = EMPTY;
    } else {
      this.#buf = rest;
    }
    return out;
  }

  /** Returns null for blank lines, which are legal padding in the stream. */
  #decodeLine(line: Buffer): DecodedMessage | null {
    let end = line.length;
    if (line[end - 1] === CR) end -= 1;
    if (end === 0) return null;

    const slice = line.subarray(0, end);
    if (slice.length > this.#maxLineBytes) {
      return {
        ok: false,
        error: new Error(`frame exceeds ${this.#maxLineBytes} bytes`),
        raw: slice.subarray(0, RAW_PREVIEW_CHARS).toString("utf8"),
      };
    }

    const raw = slice.toString("utf8");
    if (raw.trim().length === 0) return null;
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e : new Error(String(e)), raw };
    }
  }
}
