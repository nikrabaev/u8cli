/**
 * Port allocation for instances.
 *
 * Base listens where `u8.jsonc` says. Every other instance is handed ports from
 * a configured range, once, and keeps them for as long as it exists: an init
 * step may have written one into a file, a browser tab may have it open, and a
 * port that moved between two starts would break both without a word.
 *
 * Allocation happens in the daemon and nowhere else. One process hands out every
 * port for the workspace, so two instances created at the same moment cannot be
 * given the same number — which is the whole case for instances sharing a daemon.
 */
import net from "node:net";

import type { PortRange } from "../config/types.js";
import { U8Error } from "../util/errors.js";

/** Resolves true when nothing is listening on `port` on this machine's loopback. */
export type PortProbe = (port: number) => Promise<boolean>;

/**
 * Whether a port can be bound right now.
 *
 * Both families are tried because dev servers disagree about which they bind,
 * and a listener on `::` does not always show up as a conflict on `127.0.0.1`
 * (or the reverse). A machine without IPv6 simply cannot have an IPv6 listener
 * in the way, so that half failing for any reason other than "in use" is a pass.
 */
export const isPortFree: PortProbe = async (port) =>
  (await canListen(port, "127.0.0.1")) !== "in-use" && (await canListen(port, "::")) !== "in-use";

function canListen(port: number, host: string): Promise<"free" | "in-use" | "unavailable"> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES" ? "in-use" : "unavailable");
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve("free"));
    });
  });
}

export interface AllocateOptions {
  range: PortRange;
  /** Ports that must not be handed out: base's, and every other instance's. */
  taken: ReadonlySet<number>;
  count: number;
  probe?: PortProbe;
}

/**
 * The next `count` ports that are neither spoken for nor in use, lowest first.
 *
 * Lowest-first rather than random so the ports of an instance sit together and
 * the first instance on a quiet machine gets the same ones every time, which
 * makes them easy to recognise in a log.
 */
export async function allocatePorts(opts: AllocateOptions): Promise<number[]> {
  const probe = opts.probe ?? isPortFree;
  const out: number[] = [];
  for (let port = opts.range.from; port <= opts.range.to && out.length < opts.count; port++) {
    if (opts.taken.has(port)) continue;
    if (await probe(port)) out.push(port);
  }
  if (out.length < opts.count) {
    throw new U8Error(
      "PORTS_EXHAUSTED",
      `no free port left in ${opts.range.from}–${opts.range.to} (needed ${opts.count}, found ${out.length}) — ` +
        'widen "instances.ports" in u8.jsonc or destroy an instance',
      { range: opts.range, needed: opts.count },
    );
  }
  return out;
}
