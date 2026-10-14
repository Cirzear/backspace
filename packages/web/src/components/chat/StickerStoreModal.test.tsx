import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StickerStoreModal } from './StickerStoreModal';
import { api } from '../../api/client';
import type { StickerPackDetail, StickerPackSummary } from '@backspace/shared/src/stickers';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      stickerStore: {
        listPacks: vi.fn(),
        getPack: vi.fn(),
        install: vi.fn(),
        uninstall: vi.fn(),
        listCreated: vi.fn(),
        createPack: vi.fn(),
        submitReview: vi.fn(),
        newVersion: vi.fn(),
        deletePack: vi.fn(),
      },
    },
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice', name: 'Alice' } }),
}));

const mockSummary: StickerPackSummary = {
  id: 'pack-1',
  name: 'Pepe The Frog',
  description: 'Classic Pepe stickers',
  creatorId: 'alice',
  creatorName: 'Alice',
  coverAssetId: 'a'.repeat(64),
  coverUrl: `http://localhost:3000/api/stickers/assets/${'a'.repeat(64)}.webp`,
  originType: 'source',
  sourceInstance: null,
  sourcePackId: null,
  currentVersion: 1,
  status: 'approved',
  itemCount: 2,
  isInstalled: false,
  createdAt: 1000,
  updatedAt: 1000,
};

const mockDetail: StickerPackDetail = {
  ...mockSummary,
  reviewNotes: null,
  reviewedBy: 'admin',
  reviewedAt: 1000,
  items: [
    {
      id: 'item-1',
      packId: 'pack-1',
      versionId: 'ver-1',
      assetId: 'a'.repeat(64),
      name: 'Happy Pepe',
      token: `sticker:http://localhost:3000/api/stickers/assets/${'a'.repeat(64)}.webp`,
      sortOrder: 0,
      status: 'active',
      createdAt: 1000,
    },
  ],
};

describe('StickerStoreModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.stickerStore.listPacks).mockResolvedValue([mockSummary]);
    vi.mocked(api.stickerStore.getPack).mockResolvedValue(mockDetail);
    vi.mocked(api.stickerStore.install).mockResolvedValue({ success: true });
    vi.mocked(api.stickerStore.uninstall).mockResolvedValue({ success: true });
    vi.mocked(api.stickerStore.listCreated).mockResolvedValue([mockDetail]);
  });

  it('renders store packs and installs a pack', async () => {
    const onPacksChanged = vi.fn();
    render(<StickerStoreModal onClose={vi.fn()} onPacksChanged={onPacksChanged} />);

    expect(await screen.findByText('Pepe The Frog')).toBeInTheDocument();
    expect(screen.getByText('Classic Pepe stickers')).toBeInTheDocument();

    const installButton = screen.getByRole('button', { name: /\+ Add/i });
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(api.stickerStore.install).toHaveBeenCalledWith('pack-1');
      expect(onPacksChanged).toHaveBeenCalled();
    });
  });

  it('opens preview dialog when clicking pack preview', async () => {
    render(<StickerStoreModal onClose={vi.fn()} />);

    const packTitle = await screen.findByText('Pepe The Frog');
    fireEvent.click(packTitle);

    await waitFor(() => {
      expect(api.stickerStore.getPack).toHaveBeenCalledWith('pack-1');
      expect(screen.getByAltText('Happy Pepe')).toBeInTheDocument();
    });
  });

  it('switches to My Packs tab and displays created packs', async () => {
    render(<StickerStoreModal onClose={vi.fn()} />);

    expect(await screen.findByText('Pepe The Frog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Created by Me/i }));

    await waitFor(() => {
      expect(api.stickerStore.listCreated).toHaveBeenCalled();
      expect(screen.getAllByRole('button', { name: /\+ Create Pack|Create Pack/i }).length).toBeGreaterThan(0);
    });
  });
});
