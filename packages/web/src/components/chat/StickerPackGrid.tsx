import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { stickerUrl, stickerPreviewUrl, type StickerPackDetail } from '@backspace/shared/src/stickers';

interface StickerPackGridProps {
  pack: StickerPackDetail;
  onSelect: (token: string) => void;
}

/**
 * One installed store pack as tiles, with its own name search. A pack is
 * read-only here: installing, removing and editing happen in the sticker
 * store, so a tile only sends the sticker.
 */
export function StickerPackGrid({ pack, onSelect }: StickerPackGridProps) {
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
