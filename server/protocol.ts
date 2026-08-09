/**
 * The wire contract between the activity and the GameRoom Durable Object.
 *
 * Imported by both sides so the two can't drift. Types only plus a validator — nothing here may
 * reference DOM or Workers globals.
 */

export type TeamId = 'a' | 'b';

export const TEAM_IDS: readonly TeamId[] = ['a', 'b'] as const;

export const TEAM_NAMES: Record<TeamId, string> = { a: 'Red', b: 'Blue' };

export function isTeamId(value: unknown): value is TeamId {
  return value === 'a' || value === 'b';
}

export function otherTeam(team: TeamId): TeamId {
  return team === 'a' ? 'b' : 'a';
}

export interface Member {
  userId: string;
  name: string;
  /** Discord avatar hash, or null for the default avatar. */
  avatar: string | null;
  /** null means watching rather than playing. */
  team: TeamId | null;
  ready: boolean;
  connected: boolean;
}

export type RoomPhase = 'lobby' | 'in_progress' | 'endgame';

export type Answer = 'yes' | 'no';

/** One row of the public question log. Both teams see every entry. */
export interface QuestionEntry {
  id: number;
  /**
   * A turn spent asking, or handed straight over. Passing exists because everyone is in a voice
   * channel: a leader who has already got their answer out loud has nothing to type.
   */
  kind: 'question' | 'pass';
  /** The team whose turn it was; the other team's leader is the one who answers. */
  askedBy: TeamId;
  /** Empty for a pass. */
  text: string;
  /** null while the opposing leader is still deciding, and always null for a pass. */
  answer: Answer | null;
}

export const MAX_QUESTION_LENGTH = 200;

export interface GameGuess {
  team: TeamId;
  characterId: string;
  correct: boolean;
}

export interface GameOutcome {
  /** null when both teams named the wrong character. */
  winner: TeamId | null;
  /**
   * `wrong_guess` is a win by default: one team named wrong and the other never had to try.
   * It stops applying the moment the second team plays their own attempt out. `abandoned` means
   * a team emptied out mid-game and there was nobody left to play it.
   */
  reason: 'correct_guess' | 'wrong_guess' | 'draw' | 'abandoned';
  guesses: GameGuess[];
}

/**
 * Everything the running game owns. Never sent to a client as-is — `redact.ts` derives a
 * per-recipient `GameView` from it, because two of these fields decide the game if they leak.
 */
export interface GameState {
  /** Character ids of the board in play, resolved from the pack manifest when the game began. */
  characters: string[];
  /** SECRET. Each team's character, visible only to that team's leader. */
  secrets: Record<TeamId, string>;
  /** SECRET. Tiles each team has ruled out — the opponent's deductions are theirs alone. */
  flipped: Record<TeamId, string[]>;
  activeTeam: TeamId;
  /** Whose move it is within the turn: the active leader asks, then the other leader answers. */
  stage: 'asking' | 'answering';
  log: QuestionEntry[];
  nextQuestionId: number;
  /**
   * In the order they were made. A team that has guessed is out of the running — it can still
   * answer, because it holds the character the other team is hunting, but it cannot ask or guess
   * again.
   */
  guesses: GameGuess[];
  outcome: GameOutcome | null;
}

/**
 * The part of a running game one particular client is allowed to know.
 *
 * Note what is absent: the board itself. Clients render from the pack manifest they already
 * fetched, so shipping the character list again would add nothing except a copy of every secret
 * in every frame — which is also what lets the redaction tests assert on the serialized bytes.
 */
export interface GameView {
  activeTeam: TeamId;
  stage: 'asking' | 'answering';
  /** Your own team's ruled-out tiles. Spectators, who have no stake, see both. */
  flipped: Partial<Record<TeamId, string[]>>;
  /** Your team's character — leaders only. Null for everyone else while the game runs. */
  yourSecret: string | null;
  /** Both characters, once the game is over and there is nothing left to protect. */
  reveal: Record<TeamId, string> | null;
  log: QuestionEntry[];
  guesses: GameGuess[];
  /** True while one team has guessed and the other could still be sent back in to finish. */
  canPlayOn: boolean;
  outcome: GameOutcome | null;
}

export const CUSTOM_PACK_ID = 'custom';

/** Fewer than ten faces is not a game; past forty the board stops being readable. */
export const CUSTOM_PACK_MIN = 10;
export const CUSTOM_PACK_MAX = 40;

/**
 * Cap on one stored photo. The client encodes to fit well under this; the room enforces it,
 * because a client is free to lie. Sized to sit comfortably inside a Durable Object storage
 * value and to keep a whole board's worth of photos small.
 */
export const CUSTOM_PHOTO_MAX_BYTES = 128 * 1024;

/**
 * What the uploader's browser could actually encode.
 *
 * WebP is preferred and is what the build script produces, but `canvas.toBlob` silently ignores
 * a type it cannot encode, so a browser without WebP output would otherwise produce PNGs far too
 * large to store. JPEG is the universal floor; the pack records which one it holds so the files
 * can be named and served honestly.
 */
export type PackImageFormat = 'webp' | 'jpeg';

export const PACK_IMAGE_EXTENSION: Record<PackImageFormat, string> = { webp: 'webp', jpeg: 'jpg' };
export const PACK_IMAGE_MIME: Record<PackImageFormat, string> = { webp: 'image/webp', jpeg: 'image/jpeg' };

export function isPackImageFormat(value: unknown): value is PackImageFormat {
  return value === 'webp' || value === 'jpeg';
}

/**
 * A board of photos uploaded by the host, living in the room rather than on the asset layer.
 *
 * Public to everyone in the room — these are the faces on the board. The `token` is random so
 * the photos are not reachable from the room id alone, which matters because they are pictures
 * of real people rather than shipped assets.
 */
export interface CustomPack {
  token: string;
  name: string;
  format: PackImageFormat;
  characters: { id: string; name: string }[];
}

export interface RoomState {
  phase: RoomPhase;
  /** Whoever arrived first, and can pick the pack and start. Moves on if they leave. */
  hostId: string | null;
  packId: string | null;
  /** Set once the host has uploaded photos; survives switching packs so they can switch back. */
  customPack: CustomPack | null;
  leaders: Record<TeamId, string | null>;
  members: Member[];
  /** Null in the lobby; set from `startGame` until a rematch clears it. */
  game: GameState | null;
}

/**
 * What a specific client is told about the room.
 *
 * Deliberately `Omit`s `game` rather than inheriting it: `GameState` carries both secrets, so if
 * this extended `RoomState` wholesale, spreading state into a view would ship them to everyone.
 * Adding a field to `RoomState` now forces a decision here about who may see it.
 */
export interface RoomView extends Omit<RoomState, 'game'> {
  game: GameView | null;
  you: {
    userId: string;
    team: TeamId | null;
    isHost: boolean;
    isLeader: boolean;
  };
  /** Empty when the host can start; otherwise the reasons they can't. */
  startBlockers: string[];
}

export type ClientMessage =
  | { type: 'setTeam'; team: TeamId | null }
  | { type: 'claimLeader' }
  | { type: 'assignLeader'; userId: string }
  | { type: 'setReady'; ready: boolean }
  | { type: 'selectPack'; packId: string }
  | { type: 'startGame' }
  | { type: 'askQuestion'; text: string }
  | { type: 'passTurn' }
  | { type: 'answerQuestion'; answer: Answer }
  | { type: 'flipTile'; characterId: string; down: boolean }
  | { type: 'resetFlips' }
  | { type: 'submitGuess'; characterId: string }
  | { type: 'playOn' }
  | { type: 'playAgain' }
  | { type: 'rematch' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'state'; state: RoomView }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

/**
 * Parses an untrusted frame. Anything unrecognised returns null rather than throwing, so a
 * malformed or hostile client can't take the room down.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 4096) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const message = parsed as Record<string, unknown>;
  switch (message['type']) {
    case 'setTeam':
      return message['team'] === null || isTeamId(message['team'])
        ? { type: 'setTeam', team: message['team'] as TeamId | null }
        : null;
    case 'claimLeader':
      return { type: 'claimLeader' };
    case 'assignLeader':
      return typeof message['userId'] === 'string' && message['userId'].length <= 32
        ? { type: 'assignLeader', userId: message['userId'] }
        : null;
    case 'setReady':
      return typeof message['ready'] === 'boolean' ? { type: 'setReady', ready: message['ready'] } : null;
    case 'selectPack':
      // Pack ids are slugs from the build script; anything else can't name a real pack.
      return typeof message['packId'] === 'string' && /^[a-z0-9-]{1,64}$/.test(message['packId'])
        ? { type: 'selectPack', packId: message['packId'] }
        : null;
    case 'startGame':
      return { type: 'startGame' };
    case 'askQuestion': {
      if (typeof message['text'] !== 'string') return null;
      // Collapse whitespace so the log can't be padded out into a wall of blank lines.
      const text = message['text'].replace(/\s+/g, ' ').trim();
      return text.length > 0 && text.length <= MAX_QUESTION_LENGTH ? { type: 'askQuestion', text } : null;
    }
    case 'passTurn':
      return { type: 'passTurn' };
    case 'answerQuestion':
      return message['answer'] === 'yes' || message['answer'] === 'no'
        ? { type: 'answerQuestion', answer: message['answer'] }
        : null;
    case 'flipTile':
      return isCharacterId(message['characterId']) && typeof message['down'] === 'boolean'
        ? { type: 'flipTile', characterId: message['characterId'], down: message['down'] }
        : null;
    case 'resetFlips':
      return { type: 'resetFlips' };
    case 'submitGuess':
      return isCharacterId(message['characterId'])
        ? { type: 'submitGuess', characterId: message['characterId'] }
        : null;
    case 'playOn':
      return { type: 'playOn' };
    case 'playAgain':
      return { type: 'playAgain' };
    case 'rematch':
      return { type: 'rematch' };
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

/** Character ids are slugs, whether built or uploaded; see shared/naming.ts for the rules. */
function isCharacterId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
}
