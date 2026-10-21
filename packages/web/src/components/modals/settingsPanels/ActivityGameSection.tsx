import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities';
import { useActivityStore } from '../../../stores/activityStore';
import { moveKey, orderedKeys, renameKey } from '../../../utils/gameOverrides';

const PRIMARY_BUTTON =
  'px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const LINK_BUTTON = 'text-xs text-txt-tertiary hover:text-txt-secondary transition-colors';
const ICON_BUTTON =
  'w-6 h-6 flex items-center justify-center rounded text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] transition-colors disabled:opacity-30 disabled:pointer-events-none';

/**
 * The player's say over the games shown as playing: add a game the detector
 * missed ("created manually"), hide single games, put them in priority order
 * and show a detected game under another name. All of it is remembered by this
 * client (`utils/gameOverrides.ts`).
 */
export function ActivityGameSection() {
  const { t } = useTranslation('settings');
  const manualGames = useActivityStore((s) => s.manualGames);
  const hidden = useActivityStore((s) => s.hiddenGames);
  const order = useActivityStore((s) => s.gameOrder);
  const detected = useActivityStore((s) => s.detectedActivities);
  const renames = useActivityStore((s) => s.gameRenames);
  const addManualGame = useActivityStore((s) => s.addManualGame);
  const removeManualGame = useActivityStore((s) => s.removeManualGame);
  const setGameHidden = useActivityStore((s) => s.setGameHidden);
  const setGameOrder = useActivityStore((s) => s.setGameOrder);
  const setGameRename = useActivityStore((s) => s.setGameRename);

  const [draft, setDraft] = useState('');
  // The desktop can tie a game to a running program; a browser cannot see processes
  const canBind = typeof window.backspace?.listRunningPrograms === 'function';
  const [programs, setPrograms] = useState<Array<{ label: string; process: string }>>([]);
  const [program, setProgram] = useState('');
  const [unknown, setUnknown] = useState<Array<{ label: string; process: string }>>([]);
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  const refreshPrograms = useCallback(() => {
    window.backspace?.listRunningPrograms?.()
      .then((list) => { if (Array.isArray(list)) setPrograms(list); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (canBind) refreshPrograms();
  }, [canBind, refreshPrograms]);

  // Wine programs the detector could not name: offered with one click while this section is open
  useEffect(() => {
    if (typeof window.backspace?.getUnknownWinePrograms !== 'function') return;
    let cancelled = false;
    const load = () => {
      window.backspace?.getUnknownWinePrograms?.()
        .then((list) => { if (!cancelled && Array.isArray(list)) setUnknown(list); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const detectedGames = useMemo(
    () => detected.filter((activity) => activity.type === 'playing'),
    [detected],
  );
  const runningKeys = useMemo(() => new Set(detectedGames.map((game) => renameKey(game.name))), [detectedGames]);

  // Every game the player has a say over: running now, added by hand, or hidden earlier
  const rows = useMemo(() => {
    const names = new Map<string, string>();
    for (const game of detectedGames) names.set(renameKey(game.name), game.name);
    for (const game of manualGames) names.set(renameKey(game.name), game.name);
    for (const key of hidden) if (!names.has(key)) names.set(key, key);
    return { names, keys: orderedKeys([...names.keys()], order) };
  }, [detectedGames, manualGames, hidden, order]);

  const trimmed = draft.trim();
  const canAdd = trimmed !== '' && (!canBind || program !== '') && manualGames.length < 30;
  const programOptions = programs;
  const detectedToRename = detectedGames.filter(
    (game) => !manualGames.some((manual) => renameKey(manual.name) === renameKey(game.name)),
  );
  const renamedEntries = useMemo(() => Object.entries(renames), [renames]);
  const unknownFresh = unknown.filter(
    (p) => !manualGames.some((game) => game.process !== null && game.process.toLowerCase() === p.process.toLowerCase()),
  );

  const move = (key: string, direction: -1 | 1) => setGameOrder(moveKey(rows.keys, key, direction));

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-4">
      {rows.keys.length > 0 && (
        <div>
          <div className="text-sm text-txt-primary">{t('privacy.activity.game.gamesLabel')}</div>
          <div className="text-xs text-txt-tertiary mt-0.5">{t('privacy.activity.game.gamesDescription')}</div>
          <ul className="mt-2 space-y-1">
            {rows.keys.map((key, index) => {
              const name = rows.names.get(key) ?? key;
              const isHidden = hidden.includes(key);
              return (
                <li key={key} className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${runningKeys.has(key) ? 'bg-accent-mint' : 'bg-white/[0.15]'}`}
                    aria-hidden="true"
                  />
                  <span className={`flex-1 min-w-0 truncate text-sm ${isHidden ? 'text-txt-tertiary line-through' : 'text-txt-primary'}`} title={name}>
                    {name}
                  </span>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    disabled={index === 0}
                    aria-label={t('privacy.activity.game.moveUp', { name })}
                    onClick={() => move(key, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    disabled={index === rows.keys.length - 1}
                    aria-label={t('privacy.activity.game.moveDown', { name })}
                    onClick={() => move(key, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={`${LINK_BUTTON} w-16 text-right`}
                    aria-label={t(isHidden ? 'privacy.activity.game.showGame' : 'privacy.activity.game.hideGame', { name })}
                    onClick={() => setGameHidden(name, !isHidden)}
                  >
                    {t(isHidden ? 'privacy.activity.game.show' : 'privacy.activity.game.hide')}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <div className="text-sm text-txt-primary">{t('privacy.activity.game.label')}</div>
        <div className="text-xs text-txt-tertiary mt-0.5">{t(canBind ? 'privacy.activity.game.descriptionBound' : 'privacy.activity.game.description')}</div>
        <form
          className="flex items-center gap-2 mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canAdd) return;
            addManualGame(trimmed, canBind ? program : null);
            setDraft('');
            setProgram('');
          }}
        >
          {canBind && (
            <select
              className="input-standard w-1/3 min-w-0 px-2 py-1.5 text-sm"
              value={program}
              aria-label={t('privacy.activity.game.programLabel')}
              onFocus={refreshPrograms}
              onChange={(event) => {
                const next = event.target.value;
                setProgram(next);
                // The name defaults to the program, unless the player already typed one
                const chosen = programOptions.find((p) => p.process === next);
                const previous = programOptions.find((p) => p.process === program);
                if (chosen && (draft.trim() === '' || draft === previous?.label)) setDraft(chosen.label);
              }}
            >
              <option value="">{t('privacy.activity.game.programPlaceholder')}</option>
              {programOptions.map((p) => <option key={p.process} value={p.process}>{p.label}</option>)}
            </select>
          )}
          <input
            className="input-standard flex-1 min-w-0 px-2.5 py-1.5 text-sm"
            value={draft}
            maxLength={ACTIVITY_LIMITS.MAX_NAME_LENGTH}
            placeholder={t('privacy.activity.game.placeholder')}
            aria-label={t('privacy.activity.game.label')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className={PRIMARY_BUTTON} disabled={!canAdd}>
            {t('privacy.activity.game.add')}
          </button>
        </form>
        {canBind && (
          <div className="text-xs text-txt-tertiary mt-1.5">{t('privacy.activity.game.programHint')}</div>
        )}
        {manualGames.length > 0 && (
          <ul className="mt-2 space-y-1">
            {manualGames.map((game) => (
              <li key={renameKey(game.name)} className="flex items-center justify-between gap-3 text-xs text-txt-secondary">
                <span className="truncate" title={game.name}>
                  {game.name}
                  <span className="text-txt-tertiary">
                    {' · '}
                    {game.process === null
                      ? t('privacy.activity.game.statusName')
                      : runningKeys.has(renameKey(game.name))
                        ? t('privacy.activity.game.statusRunning')
                        : t('privacy.activity.game.statusWaiting', { program: game.process })}
                  </span>
                </span>
                <button type="button" className={LINK_BUTTON} onClick={() => removeManualGame(game.name)}>
                  {t('privacy.activity.game.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canBind && unknownFresh.length > 0 && (
        <div>
          <div className="text-sm text-txt-primary">{t('privacy.activity.game.unknownLabel')}</div>
          <div className="text-xs text-txt-tertiary mt-0.5">{t('privacy.activity.game.unknownDescription')}</div>
          <ul className="mt-2 space-y-1.5">
            {unknownFresh.map((p) => (
              <li key={p.process} className="flex items-center justify-between gap-3">
                <span className="text-xs text-txt-secondary truncate" title={p.process}>{p.label}</span>
                <button type="button" className={PRIMARY_BUTTON} onClick={() => addManualGame(p.label, p.process)}>
                  {t('privacy.activity.game.unknownUse')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {detectedToRename.length > 0 && (
        <div>
          <div className="text-sm text-txt-primary">{t('privacy.activity.game.detectedLabel')}</div>
          <div className="text-xs text-txt-tertiary mt-0.5">{t('privacy.activity.game.detectedDescription')}</div>
          <div className="space-y-2 mt-2">
            {detectedToRename.map((game) => {
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
                    placeholder={t('privacy.activity.game.renamePlaceholder')}
                    aria-label={t('privacy.activity.game.renameLabel', { name: game.name })}
                    onChange={(event) => setRenameDrafts((drafts) => ({ ...drafts, [key]: event.target.value }))}
                  />
                  <button type="submit" className={PRIMARY_BUTTON} disabled={value.trim() === '' || value.trim() === shownAs}>
                    {t('privacy.activity.game.set')}
                  </button>
                  {(shownAs !== undefined || value !== '') && (
                    <button
                      type="button"
                      className={LINK_BUTTON}
                      onClick={() => {
                        setRenameDrafts((drafts) => {
                          const next = { ...drafts };
                          delete next[key];
                          return next;
                        });
                        setGameRename(game.name, null);
                      }}
                    >
                      {t('privacy.activity.game.clearRename')}
                    </button>
                  )}
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
