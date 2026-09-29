import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MAX_STICKER_BYTES } from '@backspace/shared/src/stickers';
import { StickerUploadForm } from './StickerUploadForm';
import { uploadSticker } from './stickerUpload';

vi.mock('./stickerUpload', () => ({ uploadSticker: vi.fn() }));
const sticker = { id: 'a'.repeat(64), name: 'Happy', token: `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp` };
const png = () => new File(['image'], 'Happy.png', { type: 'image/png' });
const choose = (file = png()) => fireEvent.change(screen.getByLabelText('Choose image', { selector: 'input' }), { target: { files: [file] } });
const confirm = () => screen.getByRole('button', { name: 'Add to my stickers' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:local-preview');
    static revokeObjectURL = vi.fn();
  });
  vi.mocked(uploadSticker).mockResolvedValue(sticker);
});
afterEach(() => vi.unstubAllGlobals());

it('previews locally, edits the name, and only uploads after explicit confirmation', async () => {
  const added = vi.fn();
  render(<StickerUploadForm onAdded={added} onCancel={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Choose image' })).toHaveFocus();
  expect(confirm()).toBeDisabled();
  const file = png();
  choose(file);
  expect(screen.getByRole('textbox')).toHaveValue('Happy');
  expect(uploadSticker).not.toHaveBeenCalled();
  expect(confirm()).toBeDisabled();
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  My favorite  ' } });
  fireEvent.click(confirm());
  await waitFor(() => expect(added).toHaveBeenCalledWith(sticker));
  expect(uploadSticker).toHaveBeenCalledWith(file, 'My favorite');
});

it('cancels without uploading and releases its local preview', () => {
  const cancel = vi.fn();
  const { unmount } = render(<StickerUploadForm onAdded={vi.fn()} onCancel={cancel} />);
  choose();
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
  expect(cancel).toHaveBeenCalledOnce();
  expect(uploadSticker).not.toHaveBeenCalled();
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
});

it('supports dropping and pasting without forwarding files to the message composer', () => {
  const drop = vi.fn();
  const paste = vi.fn();
  render(<div onDrop={drop} onPaste={paste}><StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} /></div>);
  fireEvent.drop(screen.getByRole('button', { name: 'Choose image' }), { dataTransfer: { files: [png()] } });
  expect(screen.getByRole('textbox')).toHaveValue('Happy');
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['gif'], 'Dance.gif', { type: 'image/gif' })] } });
  expect(screen.getByRole('textbox')).toHaveValue('Dance');
  expect(drop).not.toHaveBeenCalled();
  expect(paste).not.toHaveBeenCalled();
  expect(uploadSticker).not.toHaveBeenCalled();
});

it.each([
  ['empty', new File([], 'empty.png', { type: 'image/png' }), 'Choose a non-empty image up to 5 MB.'],
  ['oversize', new File([new Uint8Array(MAX_STICKER_BYTES + 1)], 'huge.png', { type: 'image/png' }), 'Choose a non-empty image up to 5 MB.'],
  ['unsupported', new File(['svg'], 'vector.svg', { type: 'image/svg+xml' }), 'Only PNG, JPEG, WebP and GIF images are supported.'],
])('rejects %s files before upload', (_case, file, error) => {
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} />);
  choose(file);
  expect(screen.getByRole('alert')).toHaveTextContent(error);
  expect(uploadSticker).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('rejects multi-file drops explicitly', () => {
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.drop(screen.getByRole('button', { name: 'Choose image' }), { dataTransfer: { files: [png(), png()] } });
  expect(screen.getByRole('alert')).toHaveTextContent('Choose one image at a time.');
  expect(confirm()).toBeDisabled();
});

it('blocks corrupt previews and blank names', () => {
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} />);
  choose();
  fireEvent.error(screen.getByAltText('Preview sticker'));
  expect(screen.getByRole('alert')).toHaveTextContent('This image cannot be previewed.');
  expect(confirm()).toBeDisabled();
  choose(new File(['gif'], 'good.gif', { type: 'image/gif' }));
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
  expect(confirm()).toBeDisabled();
});

it('prevents duplicate submits, shows a real pending state, and retains the preview on failure', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(uploadSticker).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<StickerUploadForm onAdded={vi.fn()} onCancel={vi.fn()} />);
  choose();
  fireEvent.load(screen.getByAltText('Preview sticker'));
  fireEvent.click(confirm());
  expect(screen.getByRole('status')).toHaveTextContent('Adding sticker…');
  expect(screen.getByRole('button', { name: 'Adding sticker…' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  expect(uploadSticker).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('Storage unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
  expect(screen.getByRole('textbox')).toHaveValue('Happy');
  expect(confirm()).toBeEnabled();
});
