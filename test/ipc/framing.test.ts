import { describe, expect, it } from "vitest";

import { LineDecoder, encodeMessage } from "../../src/ipc/framing.js";

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

function values(results: ReturnType<LineDecoder["push"]>): unknown[] {
  return results.filter((r) => r.ok).map((r) => (r.ok ? r.value : undefined));
}

/** Seeded so a chunk split that breaks the decoder reproduces on the next run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("encodeMessage", () => {
  it("terminates every message with exactly one newline", () => {
    expect(encodeMessage({ a: 1 })).toBe('{"a":1}\n');
  });

  it("escapes newlines inside strings so they never split a frame", () => {
    const text = encodeMessage({ text: "line1\nline2" });
    expect(text.split("\n")).toHaveLength(2);
    const decoded = new LineDecoder().push(buf(text));
    expect(values(decoded)).toEqual([{ text: "line1\nline2" }]);
  });

  it("refuses values JSON drops instead of writing an `undefined` frame", () => {
    expect(() => encodeMessage(undefined)).toThrow(TypeError);
    expect(() => encodeMessage(() => {})).toThrow(TypeError);
    expect(() => encodeMessage({ a: undefined })).not.toThrow();
  });
});

describe("LineDecoder", () => {
  it("reassembles a message split across arbitrary chunk boundaries", () => {
    const wire = encodeMessage({ jsonrpc: "2.0", id: 7, method: "daemon.ping" });
    for (const size of [1, 2, 3, 5, 11]) {
      const decoder = new LineDecoder();
      const out: unknown[] = [];
      for (let i = 0; i < wire.length; i += size) {
        out.push(...values(decoder.push(buf(wire.slice(i, i + size)))));
      }
      expect(out).toEqual([{ jsonrpc: "2.0", id: 7, method: "daemon.ping" }]);
      expect(decoder.buffered).toBe(0);
    }
  });

  it("splits multiple messages arriving in one chunk", () => {
    const decoder = new LineDecoder();
    const chunk = encodeMessage({ id: 1 }) + encodeMessage({ id: 2 }) + encodeMessage({ id: 3 });
    expect(values(decoder.push(buf(chunk)))).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("holds a trailing partial message until its newline arrives", () => {
    const decoder = new LineDecoder();
    expect(values(decoder.push(buf('{"id":1}\n{"id"')))).toEqual([{ id: 1 }]);
    expect(decoder.buffered).toBeGreaterThan(0);
    expect(values(decoder.push(buf(":2}\n")))).toEqual([{ id: 2 }]);
  });

  it("tolerates CRLF and blank lines", () => {
    const decoder = new LineDecoder();
    const results = decoder.push(buf('{"id":1}\r\n\n   \n{"id":2}\r\n'));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(values(results)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reports a malformed line without poisoning the ones around it", () => {
    const decoder = new LineDecoder();
    const results = decoder.push(buf('{"id":1}\nnot json{\n{"id":2}\n'));
    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    const bad = results[1];
    expect(bad?.ok).toBe(false);
    if (bad && !bad.ok) expect(bad.raw).toBe("not json{");
    expect(values(results)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("splits multi-byte characters across chunks without corrupting them", () => {
    const decoder = new LineDecoder();
    const wire = buf(encodeMessage({ s: "héllo — ok" }));
    const cut = 12;
    expect(values(decoder.push(wire.subarray(0, cut)))).toEqual([]);
    expect(values(decoder.push(wire.subarray(cut)))).toEqual([{ s: "héllo — ok" }]);
  });

  it("errors on an oversized frame and resynchronizes at the next newline", () => {
    const decoder = new LineDecoder(64);
    const results = decoder.push(buf(`${"x".repeat(200)}`));
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(decoder.buffered).toBe(0);

    // The tail of the oversized frame is dropped, not parsed...
    expect(values(decoder.push(buf(`${"x".repeat(50)}\n`)))).toEqual([]);
    // ...and the stream keeps working afterwards.
    expect(values(decoder.push(buf(encodeMessage({ id: 9 }))))).toEqual([{ id: 9 }]);
  });

  it("errors on an oversized frame that arrives complete in one chunk", () => {
    const decoder = new LineDecoder(64);
    const results = decoder.push(buf(`${"y".repeat(200)}\n${encodeMessage({ id: 1 })}`));
    expect(results[0]?.ok).toBe(false);
    expect(values(results)).toEqual([{ id: 1 }]);
  });

  it("accepts a frame of exactly the limit and rejects one byte more", () => {
    const wire = encodeMessage({ s: "x".repeat(50) });
    const lineBytes = Buffer.byteLength(wire, "utf8") - 1;

    expect(values(new LineDecoder(lineBytes).push(buf(wire)))).toEqual([{ s: "x".repeat(50) }]);
    expect(new LineDecoder(lineBytes - 1).push(buf(wire))[0]?.ok).toBe(false);
  });

  it("preserves every message under randomized chunk boundaries", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      s: `héllo—${i}`.repeat((i % 5) + 1),
    }));
    const wire = buf(messages.map((m) => encodeMessage(m)).join(""));
    const next = seeded(0x5eed);

    for (let trial = 0; trial < 25; trial += 1) {
      const decoder = new LineDecoder();
      const out: unknown[] = [];
      for (let i = 0; i < wire.length; ) {
        const size = 1 + Math.floor(next() * 64);
        out.push(...values(decoder.push(wire.subarray(i, i + size))));
        i += size;
      }
      expect(out).toEqual(messages);
      expect(decoder.buffered).toBe(0);
    }
  });

  it("does not accumulate unbounded memory while discarding", () => {
    const decoder = new LineDecoder(64);
    decoder.push(buf("z".repeat(100)));
    for (let i = 0; i < 20; i += 1) decoder.push(buf("z".repeat(100)));
    expect(decoder.buffered).toBe(0);
  });
});
