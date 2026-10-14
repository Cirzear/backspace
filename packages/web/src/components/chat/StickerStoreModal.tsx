import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { stickerUrl, type StickerPackDetail, type StickerPackSummary } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { describeError } from '../../i18n/errors';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { registerNativeDismiss } from '../../mobile/nativeBack';
import { StickerPackManageModal } from './StickerPackManageModal';
import './stickers.css';

interface StickerStoreModalProps {
  onClose: () => void;
  onPacksChanged?: () => void;
}

export function StickerStoreModal({ onClose, onPacksChanged }: StickerStoreModalProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [activeTab, setActiveTab] = useState<'explore' | 'myPacks'>('explore');
  const [search, setSearch] = useState('');

  const [packs, setPacks] = useState<StickerPackSummary[]>([]);
  const [myPacks, setMyPacks] = useState<StickerPackSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Selected pack for preview modal
  const [previewPack, setPreviewPack] = useState<StickerPackDetail | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Authoring modal state
  const [editingPackId, setEditingPackId] = useState<string | null | undefined>(undefined);

  const fetchExplorePacks = async (query = '') => {
    setLoading(true);
    setError('');
    try {
      const data = await api.stickerStore.listPacks({ q: query || undefined });
      setPacks(data);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchMyCreatedPacks = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.stickerStore.listCreated();
      setMyPacks(data);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'explore') {
      fetchExplorePacks(search);
    } else {
      fetchMyCreatedPacks();
    }
  }, [activeTab]);

  const handleToggleInstall = async (e: React.MouseEvent, pack: StickerPackSummary) => {
    e.stopPropagation();
    try {
      if (pack.isInstalled) {
        await api.stickerStore.uninstall(pack.id);
        setPacks(prev => prev.map(p => p.id === pack.id ? { ...p, isInstalled: false } : p));
        if (previewPack && previewPack.id === pack.id) {
          setPreviewPack(prev => prev ? { ...prev, isInstalled: false } : null);
        }
      } else {
        await api.stickerStore.install(pack.id);
        setPacks(prev => prev.map(p => p.id === pack.id ? { ...p, isInstalled: true } : p));
        if (previewPack && previewPack.id === pack.id) {
          setPreviewPack(prev => prev ? { ...prev, isInstalled: true } : null);
        }
      }
      onPacksChanged?.();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleOpenPreview = async (packId: string) => {
    setLoadingPreview(true);
    try {
      const detail = await api.stickerStore.getPack(packId);
      setPreviewPack(detail);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleNewVersion = async (packId: string) => {
    try {
      await api.stickerStore.newVersion(packId);
      setEditingPackId(packId);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleDeletePack = async (packId: string) => {
    try {
      await api.stickerStore.deletePack(packId);
      fetchMyCreatedPacks();
      onPacksChanged?.();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const portalContainer = usePortalContainer();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (previewPack) {
        setPreviewPack(null);
      } else {
        onClose();
      }
    }
  }, [onClose, previewPack]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => registerNativeDismiss(() => {
    if (previewPack) setPreviewPack(null);
    else onClose();
  }), [onClose, previewPack]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-[620px] max-h-[calc(calc(100*var(--app-vh))-2rem)] mx-4 glass-modal rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-up">
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b border-border-soft">
          <div className="flex items-center gap-4">
            <h3 className="text-lg font-bold text-txt-primary flex items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-primary">
                <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
                <path d="M2 7h20" />
              </svg>
              {t('stickers.store')}
            </h3>

            {/* Navigation Tabs */}
            <div className="flex rounded-lg bg-surface-base/80 p-0.5 border border-border-soft">
              <button
                type="button"
                onClick={() => setActiveTab('explore')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${activeTab === 'explore' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'text-txt-tertiary hover:text-txt-primary'}`}
              >
                {t('stickers.explore')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('myPacks')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${activeTab === 'myPacks' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'text-txt-tertiary hover:text-txt-primary'}`}
              >
                {t('stickers.myPacks')}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-colors"
            aria-label={t('common:actions.close')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          {error && (
            <div role="alert" className="mb-4 p-3 rounded-xl bg-accent-rose/10 border border-accent-rose/20 text-xs text-txt-danger">
              {error}
            </div>
          )}

          {activeTab === 'explore' ? (
            <div>
              {/* Search Bar */}
              <div className="relative mb-5">
                <svg
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-tertiary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="search"
                  value={search}
                  onChange={e => {
                    setSearch(e.target.value);
                    fetchExplorePacks(e.target.value);
                  }}
                  placeholder={t('stickers.search')}
                  className="input-search w-full pl-9 pr-4 py-2 text-xs"
                />
              </div>

              {/* Packs Grid */}
              {loading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-44 rounded-2xl bg-surface-base animate-pulse border border-border-soft" />
                  ))}
                </div>
              ) : packs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-txt-tertiary">
                  <p className="text-sm">{t('stickers.noPacks')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {packs.map(pack => (
                    <div
                      key={pack.id}
                      onClick={() => handleOpenPreview(pack.id)}
                      className="group cursor-pointer rounded-2xl border border-border-soft bg-surface-base/60 hover:bg-surface-base/90 p-3.5 transition-all flex flex-col justify-between hover:shadow-lg hover:border-border-hard"
                    >
                      <div>
                        {/* Cover image or placeholder */}
                        <div className="aspect-video w-full rounded-xl bg-surface-elevated/70 flex items-center justify-center mb-3 overflow-hidden border border-border-soft">
                          {pack.coverUrl ? (
                            <img src={pack.coverUrl} alt={pack.name} className="h-full w-full object-contain p-2" loading="lazy" />
                          ) : (
                            <span className="text-2xl text-txt-tertiary">🎨</span>
                          )}
                        </div>

                        <div className="flex items-start justify-between gap-1 mb-1">
                          <h4 className="text-sm font-semibold text-txt-primary truncate">{pack.name}</h4>
                          {pack.originType === 'replica' && (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-accent-lavender/10 text-accent-lavender border border-accent-lavender/20">
                              {t('stickers.replicaBadge')}
                            </span>
                          )}
                        </div>

                        {pack.description && (
                          <p className="text-xs text-txt-tertiary line-clamp-2 mb-2">{pack.description}</p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-border-soft/60 mt-2">
                        <span className="text-[11px] text-txt-tertiary">
                          {t('stickers.stickersCount', { count: pack.itemCount })}
                        </span>

                        <button
                          type="button"
                          onClick={e => handleToggleInstall(e, pack)}
                          className={pack.isInstalled ? 'sticker-secondary-button text-xs py-1 px-2.5' : 'sticker-primary-button text-xs py-1 px-2.5'}
                        >
                          {pack.isInstalled ? `✓ ${t('stickers.installed')}` : `+ ${t('stickers.install')}`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* Creator Packs Tab */}
              <div className="flex items-center justify-between mb-5">
                <p className="text-xs text-txt-tertiary">{t('stickers.collectionHint')}</p>
                <button
                  type="button"
                  onClick={() => setEditingPackId(null)}
                  className="sticker-primary-button text-xs"
                >
                  + {t('stickers.createPack')}
                </button>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-20 rounded-xl bg-surface-base animate-pulse border border-border-soft" />
                  ))}
                </div>
              ) : myPacks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-txt-tertiary">
                  <p className="text-sm">{t('stickers.noPacks')}</p>
                  <button
                    type="button"
                    onClick={() => setEditingPackId(null)}
                    className="sticker-secondary-button mt-3 text-xs"
                  >
                    {t('stickers.createPack')}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {myPacks.map(pack => (
                    <div
                      key={pack.id}
                      className="p-4 rounded-xl border border-border-soft bg-surface-base/60 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-12 w-12 shrink-0 rounded-lg bg-surface-elevated flex items-center justify-center overflow-hidden border border-border-soft">
                          {pack.coverUrl ? (
                            <img src={pack.coverUrl} alt={pack.name} className="h-full w-full object-contain p-1" />
                          ) : (
                            <span className="text-lg">🎨</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-txt-primary truncate">{pack.name}</h4>
                            <span className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${
                              pack.status === 'approved' || pack.status === 'active' ? 'bg-accent-mint/10 text-accent-mint border border-accent-mint/20' :
                              pack.status === 'pending_review' ? 'bg-accent-amber/10 text-accent-amber border border-accent-amber/20' :
                              pack.status === 'rejected' ? 'bg-accent-rose/10 text-accent-rose border border-accent-rose/20' :
                              'bg-surface-input text-txt-tertiary'
                            }`}>
                              {pack.status === 'approved' || pack.status === 'active' ? t('stickers.approved') :
                               pack.status === 'pending_review' ? t('stickers.pendingReview') :
                               pack.status === 'rejected' ? t('stickers.rejected') :
                               t('stickers.draft')}
                            </span>
                          </div>
                          <p className="text-xs text-txt-tertiary truncate">
                            {/* i18n-check: allow-literal */}
                            v{pack.currentVersion} · {t('stickers.stickersCount', { count: pack.itemCount })}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {pack.status === 'approved' ? (
                          <button
                            type="button"
                            onClick={() => handleNewVersion(pack.id)}
                            className="sticker-secondary-button text-xs"
                          >
                            {t('stickers.newVersion')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingPackId(pack.id)}
                            className="sticker-secondary-button text-xs"
                          >
                            {t('stickers.editPack')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeletePack(pack.id)}
                          className="sticker-icon-button text-txt-danger hover:bg-accent-rose/10"
                          aria-label={t('stickers.deletePack')}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Pack Preview Modal */}
      {previewPack && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in"
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setPreviewPack(null)} />
          <div className="relative w-full max-w-md mx-4 glass-modal rounded-xl shadow-2xl p-6 flex flex-col max-h-[80vh] animate-slide-up">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h4 className="text-base font-bold text-txt-primary">{previewPack.name}</h4>
                <p className="text-xs text-txt-tertiary mt-0.5">
                  {previewPack.creatorName || ''}
                  {previewPack.sourceInstance ? ` · ${previewPack.sourceInstance}` : ''}
                </p>
                {previewPack.description && (
                  <p className="text-xs text-txt-secondary mt-1.5">{previewPack.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewPack(null)}
                className="p-1.5 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-colors"
                aria-label={t('common:actions.close')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Sticker Grid Preview */}
            <div className="flex-1 overflow-y-auto grid grid-cols-4 gap-2 p-1 scrollbar-thin">
              {previewPack.items.map(item => (
                <div key={item.id} className="aspect-square rounded-xl bg-surface-base/60 p-2 flex items-center justify-center border border-border-soft">
                  <img src={stickerUrl(item.token) || item.token.replace(/^sticker:/, '')} alt={item.name} className="max-h-full max-w-full object-contain" />
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-border-soft mt-4">
              <span className="text-xs text-txt-tertiary">
                {t('stickers.stickersCount', { count: previewPack.items.length })}
              </span>
              <button
                type="button"
                onClick={e => handleToggleInstall(e, previewPack)}
                className={previewPack.isInstalled ? 'sticker-secondary-button' : 'sticker-primary-button'}
              >
                {previewPack.isInstalled ? `✓ ${t('stickers.installed')}` : `+ ${t('stickers.install')}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Authoring / Edit Modal */}
      {editingPackId !== undefined && (
        <StickerPackManageModal
          packId={editingPackId}
          onClose={() => setEditingPackId(undefined)}
          onSaved={() => {
            fetchMyCreatedPacks();
            onPacksChanged?.();
          }}
        />
      )}
    </div>,
    portalContainer,
  );
}
