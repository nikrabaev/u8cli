/**
 * Row-template engine. Pure string in, styled string out — no I/O, no daemon
 * coupling, so the daemon, the CLI and the TUI all render identical rows.
 */
export { NO_NAMESPACE, parseTemplate, templateTokens, tokenLabel } from "./parse.js";
export type { LiteralNode, ParsedTemplate, TemplateNode, TemplateWarning, TokenNode, TokenRef } from "./parse.js";

export { renderTemplate } from "./render.js";
export type { IndicatorLookup, RenderOptions } from "./render.js";

export {
  applyModifiers,
  parseModifier,
  padToWidth,
  truncateToWidth,
  ELLIPSIS,
  MAX_MODIFIER_WIDTH,
} from "./modifiers.js";
export type { Modifier, ModifierParse, StyledText } from "./modifiers.js";

export { ANSI_COLORS, applyStyle, displayWidth, isAnsiColor, segmentText, stripAnsi, RESET } from "./ansi.js";
export type { AnsiColor, Style, TextSegment } from "./ansi.js";
