import type { NowPlaying, UpNext } from './radio.js';
import type { RequestPublic } from './requests.js';
import type { RoundCounts, RoundState } from './rounds.js';
import type { ChatMessage, ReactionEvent } from './social.js';
import type { StageState } from './stage.js';

export interface ServerToClientEvents {
  'radio:now': (now: NowPlaying) => void;
  'radio:next': (next: UpNext | null) => void;
  'radio:listeners': (count: number) => void;
  'queue:update': () => void;
  'round:update': (state: RoundCounts) => void;
  'round:state': (state: RoundState) => void;
  'round:locked': (payload: { roundId: string; winnerRequestId: string | null }) => void;
  'request:status': (request: RequestPublic) => void;
  reactions: (event: ReactionEvent) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:deleted': (payload: { id: string }) => void;
  'stage:state': (state: StageState) => void;
}

export interface ClientToServerEvents {
  'radio:listen': (listening: boolean) => void;
}

export const ROOMS = {
  listeners: 'listeners',
  user: (id: string) => `user:${id}`,
  admins: 'admins',
} as const;
