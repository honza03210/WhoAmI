import { useCallback, useMemo, useState } from 'react';
import type { PackManifest } from '../packs';
import { packAsset } from '../packs';

interface BoardProps {
  pack: PackManifest;
}

/**
 * The board grid.
 *
 * Flipping is local component state for now. In phase 4 it moves to the Durable Object and
 * becomes per-team private state — the opposing team must never see which tiles you've ruled
 * out — so treat this as a preview of the mechanic rather than its final home.
 */
export function Board({ pack }: BoardProps) {
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((characterId: string) => {
    setFlipped((previous) => {
      const next = new Set(previous);
      if (!next.delete(characterId)) next.add(characterId);
      return next;
    });
  }, []);

  const reset = useCallback(() => setFlipped(new Set()), []);

  const remaining = useMemo(() => pack.tileCount - flipped.size, [pack.tileCount, flipped.size]);

  return (
    <section>
      <div className="board-header">
        <h2>
          {pack.name} — {remaining} of {pack.tileCount} standing
        </h2>
        <button type="button" className="link-button" onClick={reset} disabled={flipped.size === 0}>
          Reset
        </button>
      </div>

      <ul className="board">
        {pack.characters.map((character) => {
          const isFlipped = flipped.has(character.id);
          return (
            <li key={character.id}>
              <button
                type="button"
                className={isFlipped ? 'tile is-flipped' : 'tile'}
                onClick={() => toggle(character.id)}
                aria-pressed={isFlipped}
                aria-label={isFlipped ? `${character.name}, ruled out` : character.name}
              >
                <img
                  src={packAsset(pack.id, character.tile)}
                  alt=""
                  loading="lazy"
                  width={256}
                  height={256}
                />
                <span className="tile-name">{character.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
