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

export function assertProtocolMessage(message) {
  if (!message || message.protocol !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`worker protocol mismatch (expected ${RUNTIME_PROTOCOL_VERSION})`);
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

