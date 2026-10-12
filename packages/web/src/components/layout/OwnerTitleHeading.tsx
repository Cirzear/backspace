import { MAX_OWNER_TITLE_LENGTH, normalizeOwnerTitle } from '@backspace/shared/src/constants.js';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeError } from '../../i18n/errors';
import { useFormatters } from '../../i18n/formatters';
import { useSelfIdentity } from '../../stores/authStore';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { hostKeepsOwnerTitle, ownerGroupTitle } from '../../utils/memberGroups';
import { Modal } from '../ui/Modal';

function OwnerTitleEditor({ space, onClose }: { space: TaggedSpace; onClose: () => void }) {
  const { t } = useTranslation(['spaces', 'common', 'errors']);
  const updateSpace = useSpaceStore((s) => s.updateSpace);
  const [title, setTitle] = useState(ownerGroupTitle(space) ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (ownerTitle: string | null) => {
    setSaving(true);
    setError('');
    try {
      // The store publishes only the server response; failed writes never change the heading.
      await updateSpace(space.id, { ownerTitle });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // The server's own rule, so both refuse the same values. Only Reset sends null.
    const normalized = normalizeOwnerTitle(title);
    if (typeof normalized !== 'string') {
      setError(t('errors:space_owner_title_invalid', { max: MAX_OWNER_TITLE_LENGTH }));
      return;
    }
    void save(normalized);
  };

  return (
    <Modal isOpen onClose={() => { if (!saving) onClose(); }} title={t('spaces:members.ownerTitle.edit')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="space-owner-title" className="block text-sm font-medium text-txt-primary mb-2">
            {t('spaces:members.ownerTitle.label')}
          </label>
          <input
            id="space-owner-title"
            autoFocus
            required
            maxLength={MAX_OWNER_TITLE_LENGTH}
            value={title}
            disabled={saving}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('spaces:members.groups.owner')}
            aria-describedby="space-owner-title-hint"
            className="input-standard w-full"
          />
          <p id="space-owner-title-hint" className="text-xs text-txt-tertiary mt-2">
            {t('spaces:members.ownerTitle.hint', { max: MAX_OWNER_TITLE_LENGTH })}
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-txt-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button type="button" disabled={saving || ownerGroupTitle(space) === null} onClick={() => void save(null)} className="mr-auto text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-50">
            {t('spaces:members.ownerTitle.reset')}
          </button>
          <button type="button" disabled={saving} onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-txt-secondary hover:bg-interactive-hover disabled:opacity-50">
            {t('common:actions.cancel')}
          </button>
          <button type="submit" disabled={saving} className="px-3 py-2 rounded-lg text-sm bg-accent-primary text-white disabled:opacity-50">
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The owner group's heading in the member list, on desktop and phone. The
 * heading is cosmetic: only the actual owner sees the editor, regardless of
 * role permissions. `touch` gives the edit control a 44px tap target for the
 * phone screen without changing the heading's height.
 */
export function OwnerTitleHeading({ space, count, touch = false }: { space: TaggedSpace; count: number; touch?: boolean }) {
  const { t } = useTranslation('spaces');
  const { formatNumber } = useFormatters();
  // The owner id is the owner's row on the space's host, so compare it with
  // the signed-in user's row there, not with the home account id.
  const self = useSelfIdentity();
  const myIdHere = self?.rowIds.get(space._instanceOrigin);
  const [editing, setEditing] = useState(false);
  const canEdit = myIdHere !== undefined && myIdHere === space.ownerId && hostKeepsOwnerTitle(space);
  const ownerTitle = ownerGroupTitle(space);
  const title = ownerTitle ?? t('members.groups.owner');

  return (
    <>
      <div className="flex items-center gap-1 px-2 mb-1">
        <h3 title={title} className={`min-w-0 truncate text-[10.5px] font-bold text-txt-tertiary tracking-[0.06em] ${ownerTitle === null ? 'uppercase' : ''}`}>
          {title} — {formatNumber(count)}
        </h3>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} aria-label={t('members.ownerTitle.edit')} title={t('members.ownerTitle.edit')} className={`shrink-0 rounded text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover ${touch ? '-my-4 flex h-11 w-11 items-center justify-center active:bg-interactive-hover' : 'p-1'}`}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m16 3 5 5M4 15 16 3l5 5L9 20l-6 1 1-6Z" />
            </svg>
          </button>
        )}
      </div>
      {canEdit && editing && <OwnerTitleEditor space={space} onClose={() => setEditing(false)} />}
    </>
  );
}
