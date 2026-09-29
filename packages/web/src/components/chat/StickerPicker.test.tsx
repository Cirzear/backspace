import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StickerPicker } from './StickerPicker';
import { SaveStickerButton } from './SaveStickerButton';
import { StickerMessage } from './StickerMessage';
import { api } from '../../api/client';
import { uploadSticker } from './stickerUpload';

vi.mock('../../api/client', () => ({ api: { stickers: { list: vi.fn(), remove: vi.fn(), collect: vi.fn() } } }));
vi.mock('./stickerUpload', () => ({ uploadSticker: vi.fn() }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice' } }) }));
const preview = vi.hoisted(() => vi.fn());
vi.mock('../../stores/uiStore', () => ({ useUIStore: (selector: (s: unknown) => unknown) => selector({ openImagePreview: preview }) }));
const sticker = { id: 'a'.repeat(64), name: 'Happy', token: `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp` };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.stickers.list).mockResolvedValue([sticker]);
  vi.mocked(api.stickers.remove).mockResolvedValue({ success: true });
  vi.mocked(api.stickers.collect).mockResolvedValue(sticker);
  vi.mocked(uploadSticker).mockResolvedValue(sticker);
});

describe('sticker controls', () => {
  it('selects a sticker and removes only after successful API confirmation', async () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Happy' }));
    expect(onSelect).toHaveBeenCalledWith(sticker.token);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Happy' })).not.toBeInTheDocument());
    expect(api.stickers.remove).toHaveBeenCalledWith(sticker.id);
  });

  it('shows upload errors rather than adding an unsuccessful item', async () => {
    vi.mocked(api.stickers.list).mockResolvedValue([]);
    vi.mocked(uploadSticker).mockRejectedValueOnce(new Error('Invalid image'));
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByText('No stickers yet. Upload an image to get started.');
    fireEvent.change(screen.getByLabelText('Upload image'), { target: { files: [new File(['bad'], 'x.png')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid image');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('deduplicates successful uploads in the current list', async () => {
    render(<StickerPicker onSelect={vi.fn()} />);
    await screen.findByRole('button', { name: 'Happy' });
    fireEvent.change(screen.getByLabelText('Upload image'), { target: { files: [new File(['png'], 'x.png')] } });
    await waitFor(() => expect(uploadSticker).toHaveBeenCalledOnce());
    expect(screen.getAllByRole('button', { name: 'Happy' })).toHaveLength(1);
  });

  it('collects the original token and previews the full image', async () => {
    render(<StickerMessage token={sticker.token} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview sticker' }));
    expect(preview).toHaveBeenCalledWith(sticker.token.slice('sticker:'.length));
    fireEvent.click(screen.getByRole('button', { name: 'Add to my stickers' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Added to my stickers');
    expect(api.stickers.collect).toHaveBeenCalledWith({ id: sticker.id, token: sticker.token });
    // Collection may have been removed in the picker; the message must remain collectible.
    fireEvent.click(screen.getByRole('button', { name: 'Add to my stickers' }));
    await waitFor(() => expect(api.stickers.collect).toHaveBeenCalledTimes(2));
  });

  it('does not fetch remote message images for collection', () => {
    render(<SaveStickerButton source="https://remote.test/api/uploads/private.png" name="Image" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
