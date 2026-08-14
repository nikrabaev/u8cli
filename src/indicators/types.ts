/**
 * Wiring types for the indicator layer.
 *
 * The registry needs supervisor state to answer `app@status` and friends, but
 * importing the supervisor would close a cycle (the daemon builds the supervisor
 * *with* the registry). It takes this narrow read-only accessor instead — which
 * the real `Supervisor` satisfies structurally, so the daemon passes it directly.
 */
import type { TargetId } from "../config/types.js";
import type { WorkspaceHolder } from "../daemon/contracts.js";
import type { ServiceState } from "../ipc/protocol.js";
import type { Logger } from "../util/logger.js";

export interface ServiceStateAccess {
  state(id: TargetId): ServiceState;
  states(): ServiceState[];
}

/** What the core `app@` providers need to compute a value. */
export interface CoreIndicatorDeps {
  workspace: WorkspaceHolder;
  services: ServiceStateAccess;
}

export interface IndicatorRegistryDeps extends CoreIndicatorDeps {
  logger: Logger;
}
