'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@radiot/shared';
import { SOCKET_URL } from './env';

export type RadioSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const Ctx = createContext<{ socket: RadioSocket | null; connected: boolean }>({
  socket: null,
  connected: false,
});

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<RadioSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const s: RadioSocket = io(SOCKET_URL, {
      withCredentials: true,
      // WebSocket only: Vercel Functions hold upgraded sockets, but long-polling needs sticky sessions.
      transports: ['websocket'],
    });
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    setSocket(s);
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
      s.close();
    };
  }, []);

  return <Ctx.Provider value={{ socket, connected }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);

/** Subscribe to a server event for the lifetime of the component. */
export function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
) {
  const { socket } = useRealtime();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!socket) return;
    const fn = ((...args: unknown[]) =>
      (ref.current as (...a: unknown[]) => void)(...args)) as ServerToClientEvents[E];
    // reason: socket.io's typed overloads can't express a generic event name here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.on(event, fn as any);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.off(event, fn as any);
    };
  }, [socket, event]);
}
