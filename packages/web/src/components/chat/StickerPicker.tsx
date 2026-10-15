import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_PERSONAL_STICKERS, stickerUrl, stickerPreviewUrl, type PersonalSticker, type StickerPackDetail } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { StickerUploadForm } from './StickerUploadForm';
import { StickerStoreModal } from './StickerStoreModal';
import { describeError } from '../../i18n/errors';
import './stickers.css';


interface StickerRenameDialogProps {
  sticker: PersonalSticker;
  onClose: () => void;
  onRenamed: (updated: PersonalSticker) => void;
}

function StickerRenameDialog({ sticker, onClose, onRenamed }: StickerRenameDialogProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [name, setName] = useState(sticker.name);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === sticker.name) {
      onClose();
      return;
    }
    setRenaming(true);
    setError('');
    try {
      const updated = await api.stickers.rename(sticker.id, trimmed);
      onRenamed(updated);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t('stickers.renameTitle')}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-base/80 backdrop-blur-sm p-4 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget && !renaming) onClose(); }}
    >
      <div className="w-full max-w-[280px] rounded-2xl border border-border-soft bg-surface-elevated p-4 shadow-xl flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-txt-primary">{t('stickers.renameTitle')}</h4>
          <button
            type="button"
            disabled={renaming}
            onClick={onClose}
            className="text-txt-tertiary hover:text-txt-primary p-1 rounded-lg"
            aria-label={t('common:actions.close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </button>
        </div>

        <div className="flex items-center justify-center p-3 rounded-xl bg-surface-base/60">
          <img src={stickerPreviewUrl(sticker.token) ?? stickerUrl(sticker.token)!} alt={sticker.name} className="h-16 w-16 object-contain" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('stickers.name')}
              maxLength={100}
              autoFocus
              disabled={renaming}
              className="input-standard w-full text-xs"
            />
            {error && <p role="alert" className="mt-1.5 text-[11px] text-txt-danger">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={renaming}
              onClick={onClose}
              className="sticker-secondary-button"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="submit"
              disabled={renaming || !name.trim() || name.trim() === sticker.name}
              className="sticker-primary-button"
            >
              {renaming ? <span className="sticker-spinner" /> : t('stickers.rename')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface StickerGridProps {
  items: PersonalSticker[];
  filteredItems: PersonalSticker[];
  loading: boolean;
  error: string;
  managing: boolean;
  removing: string | null;
  manageable?: boolean;
  onSelect: (token: string) => void;
  onStartRename: (item: PersonalSticker) => void;
  onRemove: (id: string) => void;
  onStartUpload: () => void;
}

function StickerGrid({
  items,
  filteredItems,
  loading,
  error,
  managing,
  removing,
  manageable = true,
  onSelect,
  onStartRename,
  onRemove,
  onStartUpload,
}: StickerGridProps) {
  const { t } = useTranslation('chat');

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
        <div role="status" aria-label={t('stickers.loading')} className="grid grid-cols-4 gap-2">
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="aspect-square rounded-xl bg-interactive-hover animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!error && items.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
        <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center px-5">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M20 13V7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h6Zm-7 7v-3a4 4 0 0 1 4-4h3" />
              <path d="M7.5 12a4 4 0 0 0 5 2M8 8h.01M15 8h.01" strokeLinecap="round" />
            </svg>
          </span>
          <p className="text-sm font-medium">{t('stickers.empty')}</p>
          <p className="text-xs leading-5 text-txt-tertiary">{t('stickers.emptyHint')}</p>
          {manageable && (
            <button type="button" onClick={onStartUpload} className="sticker-secondary-button">
              {t('stickers.chooseImage')}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (items.length > 0 && filteredItems.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
        <div className="flex h-40 flex-col items-center justify-center text-center px-4">
          <p className="text-xs text-txt-tertiary">{t('stickers.noResults')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
      <div className="grid grid-cols-4 gap-1.5">
        {filteredItems.map(item => (
          <div
            key={item.id}
            className="group relative min-w-0 rounded-xl hover:bg-interactive-hover transition-colors"
            onContextMenu={e => {
              if (!manageable) return;
              e.preventDefault();
              e.stopPropagation();
              useContextMenuStore.getState().open({ x: e.clientX, y: e.clientY }, [
                {
                  type: 'action',
                  key: 'rename',
                  label: t('stickers.rename'),
                  onClick: () => onStartRename(item),
                },
                {
                  type: 'action',
                  key: 'remove',
                  label: t('stickers.remove'),
                  danger: true,
                  onClick: () => onRemove(item.id),
                },
              ]);
            }}
          >
            <button
              type="button"
              disabled={managing || !!removing}
              onClick={() => onSelect(item.token)}
              title={item.name}
              aria-label={item.name}
              className="sticker-tile w-full p-2"
            >
              <img
                src={stickerPreviewUrl(item.token) ?? stickerUrl(item.token)!}
                alt={item.name}
                className="aspect-square w-full object-contain transition-transform group-hover:scale-105"
                loading="lazy"
              />
              <span className="mt-1 block truncate text-[10px] text-txt-tertiary">{item.name}</span>
            </button>
            {managing && (
              <>
                <button
                  type="button"
                  disabled={!!removing}
                  aria-label={`${t('stickers.rename')} ${item.name}`}
                  className="sticker-edit-button"
                  onClick={() => onStartRename(item)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>
                <button
                  type="button"
                  disabled={!!removing}
                  aria-label={t('stickers.removeNamed', { name: item.name })}
                  className="sticker-remove-button"
                  onClick={() => onRemove(item.id)}
                >
                  {removing === item.id ? (
                    <span className="sticker-spinner" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="m6 6 12 12M6 18 18 6" />
                    </svg>
                  )}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface PackStickerGridProps {
  pack: StickerPackDetail;
  onSelect: (token: string) => void;
}

function PackStickerGrid({ pack, onSelect }: PackStickerGridProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const items = pack.items || [];
  const filtered = query ? items.filter(it => it.name.toLowerCase().includes(query)) : items;

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{pack.name}</h3>
          <p className="text-[11px] text-txt-tertiary truncate">
            {pack.creatorName || (pack.originType === 'replica' ? pack.sourceInstance : '')}
          </p>
        </div>
        <span className="text-xs font-normal text-txt-tertiary shrink-0">
          {items.length}
        </span>
      </div>

      {items.length > 0 && (
        <div className="px-4 pb-2.5 shrink-0">
          <div className="relative flex items-center">
            <svg
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-txt-tertiary"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('stickers.search')}
              aria-label={t('stickers.search')}
              className="input-search w-full pl-8 pr-7 py-1.5 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 text-txt-tertiary hover:text-txt-primary"
                aria-label={t('common:actions.clear')}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
          <div className="flex h-40 flex-col items-center justify-center text-center px-4">
            <p className="text-xs text-txt-tertiary">{t('stickers.empty')}</p>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
          <div className="flex h-40 flex-col items-center justify-center text-center px-4">
            <p className="text-xs text-txt-tertiary">{t('stickers.noResults')}</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
          <div className="grid grid-cols-4 gap-1.5">
            {filtered.map(item => {
              const url = stickerPreviewUrl(item.token) ?? stickerUrl(item.token);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.token)}
                  title={item.name}
                  aria-label={item.name}
                  className="sticker-tile group w-full p-2"
                >
                  {url ? (
                    <img
                      src={url}
                      alt={item.name}
                      className="aspect-square w-full object-contain transition-transform group-hover:scale-105"
                      loading="lazy"
                    />
                  ) : (
                    <div className="aspect-square w-full rounded bg-interactive-hover" />
                  )}
                  <span className="mt-1 block truncate text-[10px] text-txt-tertiary">{item.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export interface StickerPickerProps {
  onSelect: (token: string) => void;
  mobile?: boolean;
  manageable?: boolean;
}

export function StickerPicker({
  onSelect,
  mobile = false,
  manageable = true,
}: StickerPickerProps) {
  const { t } = useTranslation(['chat', 'common']);
  const userId = useAuthStore(s => s.user?.id);
  const [items, setItems] = useState<PersonalSticker[]>([]);
  const [installedPacks, setInstalledPacks] = useState<StickerPackDetail[]>([]);
  const [activeTab, setActiveTab] = useState<'personal' | string>('personal');
  const [showStore, setShowStore] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [editingSticker, setEditingSticker] = useState<PersonalSticker | null>(null);

  const loadInstalledPacks = () => {
    if (!api.stickerStore?.myPacks) return;
    api.stickerStore.myPacks()
      .then(packs => {
        setInstalledPacks(packs);
        setActiveTab(prev => (prev === 'personal' || packs.some(p => p.id === prev) ? prev : 'personal'));
      })
      .catch(() => {});
  };

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    setError('');
    setNotice('');
    setUploading(false);
    setManaging(false);
    setSearch('');
    setEditingSticker(null);
    api.stickers.list().then(rows => { if (active) setItems(rows); })
      .catch((err: unknown) => { if (active) setError(describeError(err)); })
      .finally(() => { if (active) setLoading(false); });
    loadInstalledPacks();
    return () => { active = false; };
  }, [userId]);


  const remove = async (id: string) => {
    setRemoving(id);
    setError('');
    setNotice('');
    try {
      await api.stickers.remove(id);
      setItems(rows => rows.filter(row => row.id !== id));
      if (editingSticker?.id === id) setEditingSticker(null);
    } catch (err) { setError(describeError(err)); }
    finally { setRemoving(null); }
  };

  const full = items.length >= MAX_PERSONAL_STICKERS;

  const startUpload = () => {
    setError('');
    setNotice('');
    setUploading(true);
  };

  const query = search.trim().toLowerCase();
  const filteredItems = query
    ? items.filter(item => item.name.toLowerCase().includes(query))
    : items;

  const currentPack = activeTab !== 'personal' ? installedPacks.find(p => p.id === activeTab) : null;

  return (
    <div
      className={`relative flex flex-col min-h-0 text-txt-primary ${mobile ? 'w-full flex-1' : 'w-[352px] max-w-[calc(100*var(--app-vw)-24px)] h-[456px]'}`}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          if (editingSticker) {
            event.stopPropagation();
            setEditingSticker(null);
          }
        } else {
          event.stopPropagation();
        }
      }}
    >
      {uploading ? (
        <StickerUploadForm
          key={userId}
          capacity={Math.max(0, MAX_PERSONAL_STICKERS - items.length)}
          onCancel={() => setUploading(false)}
          onAdded={(added, complete) => {
            setItems(rows => {
              const ids = new Set(added.map(item => item.id));
              return [...[...added].reverse(), ...rows.filter(row => !ids.has(row.id))];
            });
            if (!complete) return;
            setUploading(false);
            setManaging(false);
            setNotice(t('stickers.saved'));
          }}
        />
      ) : (
        <>
          {activeTab === 'personal' ? (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
                <h3 className="text-sm font-semibold">
                  {t('stickers.title')}{' '}
                  <span className="ml-1 text-xs font-normal text-txt-tertiary">{!loading && items.length}</span>
                </h3>
                {manageable && (
                  <div className="flex items-center gap-1">
                    {items.length > 0 && (
                      <button
                        type="button"
                        disabled={!!removing}
                        aria-pressed={managing}
                        className="sticker-secondary-button"
                        onClick={() => setManaging(!managing)}
                      >
                        {t(managing ? 'stickers.done' : 'stickers.manage')}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={loading || !!removing || full}
                      onClick={startUpload}
                      className="sticker-primary-button"
                    >
                      <span aria-hidden="true" className="text-lg leading-none">+</span>
                      {t('stickers.upload')}
                    </button>
                  </div>
                )}
              </div>
              {manageable && (
                <p className="px-4 pb-2 text-xs text-txt-tertiary">
                  {t(managing ? 'stickers.removeHint' : full ? 'stickers.full' : 'stickers.collectionHint')}
                </p>
              )}

              {items.length > 0 && (
                <div className="px-4 pb-2.5 shrink-0">
                  <div className="relative flex items-center">
                    <svg
                      className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-txt-tertiary"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                    <input
                      type="search"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder={t('stickers.search')}
                      aria-label={t('stickers.search')}
                      className="input-search w-full pl-8 pr-7 py-1.5 text-xs"
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => setSearch('')}
                        className="absolute right-2 text-txt-tertiary hover:text-txt-primary"
                        aria-label={t('common:actions.clear')}
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {error && <p role="alert" className="mx-4 mb-3 rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">{error}</p>}
              {notice && <p role="status" className="mx-4 mb-2 text-xs text-txt-positive">{notice}</p>}

              <StickerGrid
                items={items}
                filteredItems={filteredItems}
                loading={loading}
                error={error}
                managing={managing}
                removing={removing}
                manageable={manageable}
                onSelect={onSelect}
                onStartRename={setEditingSticker}
                onRemove={id => void remove(id)}
                onStartUpload={startUpload}
              />

              {manageable && (
                <div className="shrink-0 border-t border-border-soft px-4 py-1.5 text-[11px] text-txt-tertiary">
                  {t('stickers.limits')}
                </div>
              )}
            </>
          ) : currentPack ? (
            <PackStickerGrid pack={currentPack} onSelect={onSelect} />
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-xs text-txt-tertiary">{t('stickers.empty')}</p>
            </div>
          )}

          {/* Bottom Tabs & Store Button */}
          <div className="shrink-0 flex items-center justify-between border-t border-border-soft px-3 py-1.5 bg-surface-base/50">
            <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5 px-1">
              {/* Personal Stickers tab */}
              <button
                type="button"
                onClick={() => setActiveTab('personal')}
                title={t('stickers.title')}
                aria-label={t('stickers.title')}
                className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                  activeTab === 'personal'
                    ? 'bg-interactive-active text-accent-primary shadow-sm'
                    : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary'
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
              </button>

              {/* Installed packs tabs */}
              {installedPacks.map(pack => {
                const cover = stickerPreviewUrl(pack.coverUrl) || pack.coverUrl || (pack.items?.[0] ? (stickerPreviewUrl(pack.items[0].token) || stickerUrl(pack.items[0].token)) : null);
                const isActive = activeTab === pack.id;
                return (
                  <button
                    key={pack.id}
                    type="button"
                    onClick={() => setActiveTab(pack.id)}
                    title={pack.name}
                    aria-label={pack.name}
                    className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-lg overflow-hidden transition-colors ${
                      isActive
                        ? 'bg-interactive-active ring-1 ring-inset ring-accent-primary text-txt-primary'
                        : 'opacity-70 hover:opacity-100 hover:bg-interactive-hover'
                    }`}
                  >
                    {cover ? (
                      <img src={cover} alt={pack.name} className="h-5 w-5 object-contain" />
                    ) : (
                      <span className="text-[11px] font-bold">{pack.name[0]}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Sticker Store modal button */}
            {manageable && (
              <button
                type="button"
                onClick={() => setShowStore(true)}
                title={t('stickers.store')}
                aria-label={t('stickers.store')}
                className="flex h-7 px-2 items-center gap-1.5 rounded-lg text-xs font-medium text-accent-primary hover:bg-accent-primary/10 transition-colors shrink-0 ml-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <path d="M16 10a4 4 0 0 1-8 0" />
                </svg>
                <span className="hidden sm:inline">{t('stickers.store')}</span>
              </button>
            )}
          </div>

          {editingSticker && (
            <StickerRenameDialog
              sticker={editingSticker}
              onClose={() => setEditingSticker(null)}
              onRenamed={updated => {
                setItems(rows => rows.map(r => r.id === updated.id ? { ...r, name: updated.name } : r));
              }}
            />
          )}

          {showStore && (
            <StickerStoreModal
              onClose={() => setShowStore(false)}
              onPacksChanged={loadInstalledPacks}
            />
          )}
        </>
      )}
    </div>
  );
}
