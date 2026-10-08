/** IPC layer: the wire contract plus the unix-socket transport that carries it. */
export * from "./protocol.js";
export { LineDecoder, encodeMessage, MAX_LINE_BYTES, type DecodedMessage } from "./framing.js";
export {
  createRpcServer,
  startRpcServer,
  reclaimSocketPath,
  toErrorBody,
  type RpcConnection,
  type RpcHandler,
  type RpcHandlerMap,
  type RpcServer,
  type RpcServerOptions,
} from "./server.js";
export {
  createRpcClient,
  RpcRemoteError,
  type RpcClient,
  type RpcClientOptions,
  type RpcRequestOptions,
} from "./client.js";
