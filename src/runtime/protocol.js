export const RUNTIME_PROTOCOL_VERSION = 1;

export const WorkerMessage = Object.freeze({
  REQUEST: 'request',
  RESPONSE: 'response',
  EVENT: 'event',
  FRAME: 'frame',
  FRAME_ACK: 'frame-ack',
});

export function requestMessage(id, method, payload = null) {
  return { protocol: RUNTIME_PROTOCOL_VERSION, type: WorkerMessage.REQUEST, id, method, payload };
}

export function responseMessage(id, result = null, error = null) {
  return { protocol: RUNTIME_PROTOCOL_VERSION, type: WorkerMessage.RESPONSE, id, result, error };
}

export function eventMessage(event, detail = null) {
  return { protocol: RUNTIME_PROTOCOL_VERSION, type: WorkerMessage.EVENT, event, detail };
}

// Returns the message if it's ours, null if it's foreign traffic on the same
// channel that we should silently ignore, and throws only for a message that
// actually claims our protocol but doesn't match it (real corruption/version
// skew, worth surfacing as fatal).
//
// "Foreign" is real, not hypothetical: pthread-enabled cores (e.g. DOSBox
// Pure) run their compiled Emscripten glue in the SAME worker global scope
// as this runtime, and that glue's own internal plumbing (its setImmediate-
// via-postMessage scheduling trick, pthread bootstrap handshakes, etc.) uses
// bare `postMessage`/`self.onmessage` on the very channel we also use for
// our REQUEST/RESPONSE/EVENT/FRAME protocol. Those messages have no
// `protocol` field at all — they were never intended for us and are not an
// error, just noise from sharing the channel with the runtime we're hosting.
export function assertProtocolMessage(message) {
  if (!message || message.protocol === undefined) return null;
  if (message.protocol !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`worker protocol mismatch (expected ${RUNTIME_PROTOCOL_VERSION}, got ${message.protocol})`);
  }
  return message;
}

export function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
  };
}

export function deserializeError(value) {
  const error = new Error(value?.message || 'worker request failed');
  error.name = value?.name || 'Error';
  if (value?.stack) error.stack = value.stack;
  return error;
}

