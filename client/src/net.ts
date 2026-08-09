import type { ClientMessage, RoomView, ServerMessage } from '../../server/protocol';
import { apiPath } from './discord';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RoomHandlers {
  onState: (view: RoomView) => void;
  onError: (error: { code: string; message: string }) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export interface RoomClient {
  send: (message: ClientMessage) => void;
  close: () => void;
}

const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Connects to the room's Durable Object and keeps the connection alive.
 *
 * The server always sends complete state rather than deltas, so a reconnect needs no replay:
 * whatever arrives first after reopening is the truth.
 */
export function connectRoom(session: string, roomKey: string, handlers: RoomHandlers): RoomClient {
  const url = new URL(apiPath('/api/ws'), window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('session', session);
  url.searchParams.set('room', roomKey);

  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let closedByUs = false;

  // Clicks made while the socket is down are held briefly rather than silently dropped.
  let outbox: ClientMessage[] = [];

  const flush = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (const message of outbox) socket.send(JSON.stringify(message));
    outbox = [];
  };

  const open = () => {
    handlers.onStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    socket = new WebSocket(url);

    socket.onopen = () => {
      attempts = 0;
      handlers.onStatus('open');
      flush();
      // Matches the room's auto-response pair exactly, so keepalives never wake a hibernating
      // Durable Object.
      heartbeat = setInterval(() => socket?.send(JSON.stringify({ type: 'ping' })), HEARTBEAT_MS);
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'state') handlers.onState(message.state);
      else if (message.type === 'error') handlers.onError({ code: message.code, message: message.message });
    };

    socket.onclose = () => {
      clearInterval(heartbeat);
      if (closedByUs) return;

      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        handlers.onStatus('closed');
        handlers.onError({ code: 'disconnected', message: 'Lost connection to the game. Reload to retry.' });
        return;
      }
      handlers.onStatus('reconnecting');
      // Exponential backoff with jitter, so a room full of clients doesn't reconnect in lockstep.
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      retry = setTimeout(open, delay + Math.random() * 250);
    };

    socket.onerror = () => {
      // onclose always follows, which is where reconnection is handled.
    };
  };

  open();

  return {
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      else if (outbox.length < 16) outbox.push(message);
    },
    close() {
      closedByUs = true;
      clearInterval(heartbeat);
      clearTimeout(retry);
      socket?.close();
    },
  };
}
