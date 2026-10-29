// Máquina de estados da sessão no cliente. Transições não previstas são recusadas,
// o que evita, por exemplo, "conectar" uma sessão que já foi encerrada.

export const STATES = Object.freeze([
  'idle', 'creating', 'waiting', 'joining', 'awaiting_approval',
  'connecting', 'connected', 'reconnecting', 'ended', 'failed',
]);

const TRANSITIONS = {
  idle: { host_create: 'creating', tech_join: 'joining' },
  creating: { created: 'waiting', error: 'idle' },
  waiting: { peer_joined: 'connecting', end: 'ended' },
  joining: { pending: 'awaiting_approval', error: 'idle' },
  awaiting_approval: { accepted: 'connecting', rejected: 'ended', end: 'ended' },
  connecting: { connected: 'connected', connection_lost: 'reconnecting', fail: 'failed', end: 'ended' },
  connected: { connection_lost: 'reconnecting', end: 'ended', fail: 'failed' },
  reconnecting: { connected: 'connected', fail: 'failed', end: 'ended' },
  ended: { reset: 'idle' },
  failed: { reset: 'idle' },
};

export function nextState(state, event) {
  return TRANSITIONS[state]?.[event] ?? null;
}

export function isActiveState(state) {
  return state === 'connecting' || state === 'connected' || state === 'reconnecting';
}

export function isTerminalState(state) {
  return state === 'ended' || state === 'failed';
}
