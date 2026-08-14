/**
 * The profile switcher (`P`). Pure selection — SPEC §2.4 profiles carry no
 * overrides, so the only things to show are which one is active and how much of
 * the workspace each one selects.
 */
import { Box, Text } from "ink";

import { windowTopFor } from "../scroll.js";
import type { DashboardState, ProfileOption } from "../types.js";
import { el, type ReactElement } from "./element.js";

/** The title line above the list. */
const CHROME_LINES = 1;

export function ProfileMenu({ state }: { readonly state: DashboardState }): ReactElement {
  const menu = state.profileMenu;
  if (menu === undefined) {
    return el(Box, { flexDirection: "column", flexShrink: 0 }, el(Text, { dimColor: true }, "no profiles"));
  }

  const height = Math.max(1, state.viewport - CHROME_LINES);
  const top = windowTopFor(menu.index, state.profiles.length, height, 0);
  const visible = state.profiles.slice(top, top + height);
  const width = Math.max(...state.profiles.map((profile) => profile.name.length), 0);

  return el(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    el(Text, { bold: true, wrap: "truncate-end" }, "profiles"),
    ...(visible.length === 0
      ? [el(Text, { key: "empty", dimColor: true }, "  this workspace defines no profiles")]
      : visible.map((profile, offset) => profileRow(profile, width, top + offset === menu.index))),
  );
}

function profileRow(profile: ProfileOption, width: number, selected: boolean): ReactElement {
  const tags = [
    `${profile.targets} target${profile.targets === 1 ? "" : "s"}`,
    ...(profile.isDefault ? ["default"] : []),
  ].join(" · ");
  return el(
    Text,
    { key: profile.name, wrap: "truncate-end", bold: selected },
    el(Text, { color: "cyan" }, selected ? "❯ " : "  "),
    profile.name.padEnd(width),
    el(Text, { dimColor: true }, `  ${tags}`),
    profile.active ? el(Text, { color: "green" }, "  active") : null,
  );
}
