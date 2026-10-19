import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities';
import { useActivityStore } from '../../../stores/activityStore';
import { renameKey } from '../../../utils/gameOverrides';

const PRIMARY_BUTTON =
  'px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const LINK_BUTTON = 'text-xs text-txt-tertiary hover:text-txt-secondary transition-colors';

/**
 * The player's say over the game shown as playing: name a game that was not
 * detected, or show a detected game under another name. Both are remembered by
 * this client (`utils/gameOverrides.ts`).
 */
export function ActivityGameSection() {
  const { t } = useTranslation('settings');
  const manualGame = useActivityStore((s) => s.manualGame);
  const detected = useActivityStore((s) => s.detectedActivities);
  const renames = useActivityStore((s) => s.gameRenames);
  const setManualGame = useActivityStore((s) => s.setManualGame);
  const setGameRename = useActivityStore((s) => s.setGameRename);

  const listId = useId();
  const [draft, setDraft] = useState(manualGame ?? '');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(manualGame ?? '');
  }, [manualGame]);

  // The desktop client knows the dictionary and the installed games; the web
  // client has no suggestions and takes any name typed.
  useEffect(() => {
    let cancelled = false;
    window.backspace?.listKnownGames?.()
      .then((names) => {
        if (!cancelled && Array.isArray(names)) setSuggestions(names);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const detectedGames = useMemo(
    () => detected.filter((activity) => activity.type === 'playing'),
    [detected],
  );
  const renamedEntries = useMemo(() => Object.entries(renames), [renames]);

  const trimmed = draft.trim();

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-4">
      <div>
        <div className="text-sm text-txt-primary">{t('privacy.activity.game.label')}</div>
        <div className="text-xs text-txt-tertiary mt-0.5">{t('privacy.activity.game.description')}</div>
        <form
          className="flex items-center gap-2 mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== '') setManualGame(trimmed);
          }}
        >
          <input
            className="input-standard flex-1 min-w-0 px-2.5 py-1.5 text-sm"
            value={draft}
            maxLength={ACTIVITY_LIMITS.MAX_NAME_LENGTH}
            list={listId}
            placeholder={t('privacy.activity.game.placeholder')}
            aria-label={t('privacy.activity.game.label')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <datalist id={listId}>
            {suggestions.map((name) => <option key={name} value={name} />)}
          </datalist>
          <button type="submit" className={PRIMARY_BUTTON} disabled={trimmed === '' || trimmed === manualGame}>
            {t('privacy.activity.game.set')}
          </button>
          {manualGame !== null && (
            <button type="button" className={LINK_BUTTON} onClick={() => setManualGame(null)}>
              {t('privacy.activity.game.clear')}
            </button>
          )}
        </form>
        {manualGame !== null && (
          <div className="text-xs text-txt-tertiary mt-1.5">
            {t('privacy.activity.game.showing', { name: manualGame })}
          </div>
        )}
      </div>

      {detectedGames.length > 0 && manualGame === null && (
        <div>
          <div className="text-sm text-txt-primary">{t('privacy.activity.game.detectedLabel')}</div>
          <div className="text-xs text-txt-tertiary mt-0.5">{t('privacy.activity.game.detectedDescription')}</div>
          <div className="space-y-2 mt-2">
            {detectedGames.map((game) => {
              const key = renameKey(game.name);
              const shownAs = renames[key];
              const value = renameDrafts[key] ?? shownAs ?? '';
              return (
                <form
                  key={key}
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (value.trim() !== '') setGameRename(game.name, value);
                  }}
                >
                  <span className="text-xs text-txt-secondary w-1/3 truncate" title={game.name}>{game.name}</span>
                  <input
                    className="input-standard flex-1 min-w-0 px-2.5 py-1.5 text-sm"
                    value={value}
                    maxLength={ACTIVITY_LIMITS.MAX_NAME_LENGTH}
                    list={listId}
                    placeholder={t('privacy.activity.game.renamePlaceholder')}
                    aria-label={t('privacy.activity.game.renameLabel', { name: game.name })}
                    onChange={(event) => setRenameDrafts((drafts) => ({ ...drafts, [key]: event.target.value }))}
                  />
                  <button type="submit" className={PRIMARY_BUTTON} disabled={value.trim() === '' || value.trim() === shownAs}>
                    {t('privacy.activity.game.set')}
                  </button>
                </form>
              );
            })}
          </div>
        </div>
      )}

      {renamedEntries.length > 0 && (
        <div>
          <div className="text-sm text-txt-primary">{t('privacy.activity.game.renamedLabel')}</div>
          <ul className="mt-1.5 space-y-1">
            {renamedEntries.map(([key, chosen]) => (
              <li key={key} className="flex items-center justify-between gap-3 text-xs text-txt-secondary">
                <span className="truncate">{t('privacy.activity.game.renamedItem', { detected: key, chosen })}</span>
                <button
                  type="button"
                  className={LINK_BUTTON}
                  onClick={() => {
                    setRenameDrafts((drafts) => {
                      const next = { ...drafts };
                      delete next[key];
                      return next;
                    });
                    setGameRename(key, null);
                  }}
                >
                  {t('privacy.activity.game.restore')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
