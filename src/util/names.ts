/**
 * What things may be called.
 *
 * Defined once, beneath every layer, because a name has two readers that must
 * agree: the validator that accepts it where it is declared, and the
 * row-template grammar that has to spell it (`{plugin@indicator}`). While each
 * kept a rule of its own they drifted, and an indicator could be declared that
 * no template was able to show — so the grammar is built from these sources
 * instead of from a pattern it owns.
 */

/**
 * Repo, app, profile and plugin names. Repo and app names become segments of a
 * target id (`repo.app`), so a name containing `.` would make `"a.b"`
 * ambiguous. `:` and `@` are namespace separators for commands and indicators.
 */
export const NAME_SOURCE = "[A-Za-z0-9][A-Za-z0-9_-]*";

/** Command and indicator names: bare, but dots are allowed (`db.migrate`, `db.version`). */
export const BARE_NAME_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]*";

export const NAME_PATTERN = new RegExp(`^${NAME_SOURCE}$`);

export const BARE_NAME_PATTERN = new RegExp(`^${BARE_NAME_SOURCE}$`);
