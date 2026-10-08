/**
 * `u8 profile list|use <name>`.
 *
 * The active profile is daemon-side state persisted in the state dir (SPEC
 * §2.4), never in the shared config, so both subcommands go through the daemon
 * rather than touching a file — the TUI attached in another terminal sees the
 * switch immediately.
 */
import { withClient, type CliContext } from "./context.js";
import { renderTable } from "./format.js";
import { writeLine, writeLines } from "./io.js";

export async function profileListCommand(ctx: CliContext): Promise<number> {
  return withClient(ctx, {}, async (client) => {
    const snapshot = await client.request("workspace.snapshot", {});
    const rows = snapshot.profiles.map((profile) => [
      profile.name === snapshot.activeProfile ? ctx.style.green("*") : " ",
      profile.name,
      profile.isDefault ? ctx.style.dim("(default)") : "",
      ctx.style.dim(`${profile.appIds.length} target${profile.appIds.length === 1 ? "" : "s"}`),
      ctx.style.dim(profile.appIds.join(", ")),
    ]);
    writeLines(ctx.io.stdout, renderTable(rows));
    return 0;
  });
}

export async function profileUseCommand(ctx: CliContext, name: string): Promise<number> {
  return withClient(ctx, {}, async (client) => {
    const { activeProfile } = await client.request("profile.use", { name });
    const snapshot = await client.request("workspace.snapshot", {});
    const profile = snapshot.profiles.find((p) => p.name === activeProfile);
    const targets = profile?.appIds ?? [];
    writeLine(
      ctx.io.stdout,
      `active profile: ${ctx.style.bold(activeProfile)} ${ctx.style.dim(`(${targets.length} target${targets.length === 1 ? "" : "s"}: ${targets.join(", ")})`)}`.trimEnd(),
    );
    return 0;
  });
}
