/**
 * Plugin layer: the host the daemon owns, and the loader behind it.
 *
 * The public API plugin *authors* import lives in `src/plugin/` (`u8cli/plugin`);
 * this directory is the daemon-side half that finds those modules, validates
 * them, and turns what they declared into registrations the indicator registry
 * and the engine understand.
 */
export {
  createPluginHost,
  LOAD_TIMEOUT_MS,
  READINESS_TIMEOUT_MS,
  type BuiltinDaemonState,
  type LoadablePluginHost,
  type PluginHostDeps,
} from "./host.js";

export {
  BUILTIN_NAMES,
  BUILTIN_SPEC_PREFIX,
  builtinAvailable,
  builtinPath,
  importPluginModule,
  isLocalSpec,
  pluginSources,
  resolveSourceFile,
  type BuiltinName,
  type PluginSource,
  type PluginSourceKind,
} from "./load.js";

export { pluginBaseContext, withStore, type BaseContextInput } from "./context.js";

export {
  declaredNameOf,
  instantiatePlugin,
  PLUGIN_FACTORY_EXPORT,
  pluginFactoryOf,
  RESERVED_NAMESPACES,
  validatePluginDefinition,
  type PluginFactory,
} from "./validate.js";
