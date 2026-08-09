import type { PackManifest } from '../packs';
import { packAsset } from '../packs';

export type BoardMode = 'flip' | 'guess' | 'locked';

interface BoardProps {
  pack: PackManifest;
  /** Ruled-out characters. Owned by the room, so every teammate sees the same board. */
  flipped: ReadonlySet<string>;
  /** Badges keyed by character id — the leader's own secret, and both reveals at the end. */
  marks?: Readonly<Record<string, string>>;
  mode: BoardMode;
  onPick?: (characterId: string) => void;
  onReset?: () => void;
}

/**
 * The board grid.
 *
 * Deliberately knows nothing about teams, turns or secrets: it renders the flip set it is handed
 * and reports clicks. Which tiles that set contains is decided by the Durable Object and filtered
 * per recipient in redact.ts, because a board that revealed the opponent's deductions would give
 * the game away.
 */
export function Board({ pack, flipped, marks, mode, onPick, onReset }: BoardProps) {
  const standing = pack.tileCount - flipped.size;

  return (
    <section>
      <div className="board-header">
        <h2>
          {pack.name} — {standing} of {pack.tileCount} standing
        </h2>
        {mode === 'guess' && <span className="badge is-guessing">Pick who they are</span>}
        {onReset && (
          <button type="button" className="link-button" onClick={onReset} disabled={flipped.size === 0}>
            Reset
          </button>
        )}
      </div>

      <ul className={mode === 'guess' ? 'board is-guessing' : 'board'}>
        {pack.characters.map((character) => {
          const isFlipped = flipped.has(character.id);
          const mark = marks?.[character.id];

          return (
            <li key={character.id}>
              <button
                type="button"
                className={tileClass(isFlipped, mark !== undefined)}
                onClick={() => onPick?.(character.id)}
                disabled={mode === 'locked'}
                aria-pressed={mode === 'flip' ? isFlipped : undefined}
                aria-label={tileLabel(character.name, isFlipped, mode, mark)}
              >
                <img src={packAsset(pack, character.tile)} alt="" loading="lazy" width={256} height={256} />
                <span className="tile-name">{character.name}</span>
                {mark && <span className="tile-mark">{mark}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function tileClass(isFlipped: boolean, isMarked: boolean): string {
  return ['tile', isFlipped && 'is-flipped', isMarked && 'is-marked'].filter(Boolean).join(' ');
}

function tileLabel(name: string, isFlipped: boolean, mode: BoardMode, mark: string | undefined): string {
  if (mode === 'guess') return `Guess ${name}`;
  const parts = [name];
  if (mark) parts.push(mark);
  if (isFlipped) parts.push('ruled out');
  return parts.join(', ');
}
