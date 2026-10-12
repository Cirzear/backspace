import { useContextMenuStore } from '../../stores/contextMenuStore';
import { api } from '../../api/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useTransferStore, type Transfer } from '../../stores/transferStore';
import { Message } from './Message';
import { MessageInput } from './MessageInput';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const me: User = {
  id: 'me',
  username: 'alice',
  displayName: 'Alice',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: null,
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 1,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

const ownMessage: MessageWithUser = {
  id: 'message-1',
  channelId: 'dm-1',
  userId: me.id,
  replyToId: null,
  content: 'last message',
  editedAt: null,
  createdAt: 1,
  user: me,
  attachments: [],
  embeds: [],
  reactions: [],
};

beforeEach(() => {
  useTransferStore.setState({ transfers: new Map() });
  window.history.replaceState({}, '', '/channels/@me/dm-1');
  useAuthStore.setState({ user: me });
  // dm-1 is a DM because the listing says so; the URL decides nothing.
  useSpaceStore.getState().reset();
  useSpaceStore.getState().populateFromReady('', [], [], [{
    id: 'dm-1',
    federatedId: null,
    ownerId: null,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    createdAt: 1,
    members: [me],
    lastMessage: null,
    name: null,
    icon: null,
    metadataUpdatedAt: 1,
  }]);
  useComposerStore.setState({ states: new Map() });
  useChatStore.setState({
    messages: new Map([['dm-1', [ownMessage]]]),
    replyTargets: new Map(),
    editingMessageId: null,
  });
});

afterEach(() => {
  cleanup();
  useContextMenuStore.getState().close();
  useTransferStore.setState({ transfers: new Map() });
  vi.restoreAllMocks();
  useUIStore.setState({ toasts: [] });
  useChatStore.getState().clearAllMessages();
  useComposerStore.setState({ states: new Map() });
  useAuthStore.setState({ user: null });
  useSpaceStore.getState().reset();
  window.history.replaceState({}, '', '/');
});

describe('MessageInput edit shortcut', () => {
  it('opens the last own message when ArrowUp is pressed in an empty composer', async () => {
    render(
      <>
        <Message message={ownMessage} isCompact={false} isFirstInGroup previousMessageId={null} />
        <MessageInput channelId="dm-1" channelName="@Bob" />
      </>,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' });

    expect(useChatStore.getState().editingMessageId).toBe('message-1');
    const editor = screen.getByDisplayValue('last message') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe('last message'.length);
      expect(editor.selectionEnd).toBe('last message'.length);
    });
  });

  it('preserves a non-empty draft instead of starting message editing', () => {
    useComposerStore.getState().setDraft('dm-1', 'unfinished draft');
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' });

    expect(useChatStore.getState().editingMessageId).toBeNull();
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('unfinished draft');
  });

  it('preserves an active reply instead of starting message editing', () => {
    useComposerStore.getState().setReplyTo('dm-1', {
      id: 'reply-target',
      userId: 'other',
      content: 'original message',
    });
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' });

    expect(useChatStore.getState().editingMessageId).toBeNull();
    expect(useComposerStore.getState().get('dm-1').replyTo?.id).toBe('reply-target');
  });
});

describe('MessageInput slow sends', () => {
  it('consumes a draft immediately, prevents repeated Enter and preserves subsequent typing', async () => {
    let finish!: () => void;
    const sending = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockReturnValue(sending);
    useComposerStore.getState().setDraft('dm-1', 'first');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'next draft' } });
    await act(async () => { finish(); await sending; });
    expect(input).toHaveValue('next draft');
  });

  it('retains failed text without overwriting a newer draft', async () => {
    let fail!: (error: Error) => void;
    const sending = new Promise<void>((_resolve, reject) => { fail = reject; });
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockReturnValue(sending);
    useComposerStore.getState().setDraft('dm-1', 'failed text');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'new text' } });
    await act(async () => { fail(new Error('Offline')); await sending.catch(() => {}); });
    expect(input).toHaveValue('failed text\nnew text');
    expect(useUIStore.getState().toasts).toEqual([expect.objectContaining({ message: 'Offline', type: 'warning' })]);
  });
});

it('sends a personal sticker without discarding the current text draft', async () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  vi.spyOn(api.stickers, 'list').mockResolvedValue([{ id: 'a'.repeat(64), name: 'Happy', token }]);
  const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  useComposerStore.getState().setDraft('dm-1', 'unfinished draft');
  render(<MessageInput channelId="dm-1" channelName="general" />);
  fireEvent.click(screen.getByRole('button', { name: 'Emoji picker' }));
  fireEvent.click(screen.getByRole('button', { name: 'My stickers' }));
  const stickerButton = await screen.findByRole('button', { name: 'Happy' });
  await act(async () => { fireEvent.click(stickerButton); });
  expect(send).toHaveBeenCalledWith('dm-1', token);
  expect(screen.getByRole('textbox')).toHaveValue('unfinished draft');
});

it('offers collection only in the sticker context menu and keeps existing message actions', async () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  const collect = vi.spyOn(api.stickers, 'collect').mockResolvedValue({ id: 'a'.repeat(64), name: 'Happy', token });
  // DM wire messages carry dmChannelId, not a guild channelId.
  const stickerMessage = { ...ownMessage, channelId: '', dmChannelId: 'dm-1', content: token };
  render(<Message message={stickerMessage} isCompact={false} isFirstInGroup previousMessageId={null} />);
  expect(screen.queryByRole('button', { name: 'Add to my stickers' })).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByAltText('Sticker'));
  const items = useContextMenuStore.getState().menu!.items;
  expect(items.map(item => item.key)).toEqual(expect.arrayContaining(['collect-sticker', 'save-image', 'copy-image', 'reply', 'delete']));
  // A sticker's content is a token: it cannot be edited or copied as text.
  expect(items.map(item => item.key)).not.toContain('edit');
  expect(items.find(item => item.key === 'copy-text')).toMatchObject({ hidden: true });
  const item = items.find(item => item.key === 'collect-sticker');
  await act(async () => { if (item?.type === 'action') await item.onClick(); });
  expect(collect).toHaveBeenCalledWith({ id: 'a'.repeat(64), token, name: 'Sticker' });
});

it('draws a sticker once even when an older instance unfurled its asset URL', () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  const assetUrl = token.slice('sticker:'.length);
  const embed = {
    id: 'embed-1', messageId: ownMessage.id, dmMessageId: null, url: assetUrl, embedType: 'image' as const,
    provider: null, title: null, description: null, image: assetUrl, embedUrl: null, width: 8, height: 8, color: null, createdAt: 1,
  };
  const { container } = render(<Message message={{ ...ownMessage, content: token, embeds: [embed] }} isCompact={false} isFirstInGroup previousMessageId={null} />);
  // querySelectorAll, not getAllByRole: an embed image has an empty alt and so no img role.
  expect([...container.querySelectorAll('img')].filter(img => img.getAttribute('src') === assetUrl)).toHaveLength(1);
});

describe('MessageInput mention display', () => {
  it('renders a readable label but submits the stored wire ID', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
    useComposerStore.getState().setDraft('dm-1', 'Hi <@me>');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Hi @Alice');
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(send).toHaveBeenCalledWith('dm-1', 'Hi <@me>');
  });

  it('edits after a mention without replacing its wire ID with a label', () => {
    useComposerStore.getState().setDraft('dm-1', '<@me> hello');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@Alice hello!', selectionStart: 13 } });
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('<@me> hello!');
  });

  it('removes the complete mention when an edit touches its displayed name', () => {
    useComposerStore.getState().setDraft('dm-1', '<@me> ');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@Alic ', selectionStart: 5 } });
    expect(useComposerStore.getState().get('dm-1').draftText).toBe(' ');
    expect(screen.getByRole('textbox')).toHaveValue(' ');
  });

  it('does not send a draft when Enter confirms an IME composition', () => {
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
    useComposerStore.getState().setDraft('dm-1', '<@me> 你好');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('<@me> 你好');
  });
});

describe('MessageInput staged attachment controls', () => {
  function stageTransfer(overrides: Partial<Transfer> = {}) {
    const transfer: Transfer = {
      id: 'upload-1',
      type: 'upload',
      state: 'completed',
      file: { name: 'photo.png', size: 1024, mimetype: 'image/png' },
      progress: { loaded: 1024, total: 1024 },
      channelId: 'dm-1',
      tray: true,
      ...overrides,
    };
    useTransferStore.setState({ transfers: new Map([[transfer.id, transfer]]) });
    useComposerStore.getState().attach('dm-1', transfer.id);
    return transfer;
  }

  it.each([
    { name: 'photo.png', size: 1024, mimetype: 'image/png' },
    { name: 'notes.txt', size: 1024, mimetype: 'text/plain' },
  ])('keeps the completed $name remove chip outside clipping layers', (file) => {
    const transfer = stageTransfer({ file });
    const abort = vi.spyOn(useTransferStore.getState(), 'abortUpload');
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    const removeButton = screen.getByRole('button', { name: 'Remove attachment' });

    // Negative offsets must not be clipped by the tile or a wrapper around it.
    expect(removeButton).toHaveClass('-top-2', '-right-2');
    expect(removeButton.closest('.overflow-hidden')).toBeNull();
    fireEvent.click(removeButton);

    expect(useTransferStore.getState().transfers.has(transfer.id)).toBe(false);
    expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual([]);
    expect(abort).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove attachment' })).not.toBeInTheDocument();
  });

  it.each(['queued', 'active', 'paused', 'failed'] as const)(
    'clips only the overlay for a %s upload and keeps cancellation working',
    (state) => {
      const transfer = stageTransfer({ state });
      const abort = vi.spyOn(useTransferStore.getState(), 'abortUpload').mockImplementation(() => {});
      render(<MessageInput channelId="dm-1" channelName="@Bob" />);
      const abortButton = screen.getByRole('button', { name: 'Abort' });
      const clip = abortButton.closest('.overflow-hidden');

      expect(clip).toHaveClass('absolute', 'inset-0', 'rounded-lg');
      expect(clip?.parentElement).not.toHaveClass('overflow-hidden');
      expect(screen.queryByRole('button', { name: 'Remove attachment' })).not.toBeInTheDocument();
      fireEvent.click(abortButton);
      expect(abort).toHaveBeenCalledWith(transfer.id);
      expect(useTransferStore.getState().transfers.has(transfer.id)).toBe(false);
      expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual([]);
    },
  );

  it.each([
    { state: 'active', label: 'Pause', action: 'pauseUpload' },
    { state: 'paused', label: 'Resume', action: 'resumeUpload' },
  ] as const)('preserves the $label action inside the overlay', async ({ state, label, action }) => {
    const transfer = stageTransfer({ state });
    const control = vi.spyOn(useTransferStore.getState(), action).mockResolvedValue(undefined);
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
    expect(control).toHaveBeenCalledWith(transfer.id);
  });

  it('switches from the clipped progress overlay to an unclipped remove chip on completion', () => {
    const transfer = stageTransfer({ state: 'active' });
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    act(() => { useTransferStore.getState().setState_(transfer.id, 'completed'); });

    expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove attachment' }).closest('.overflow-hidden')).toBeNull();
  });

  it('revokes the preview URL of a picked image when its tile is removed', async () => {
    const created = 'blob:preview-photo';
    const revoke = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => created });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
    try {
      vi.spyOn(useTransferStore.getState(), 'startUpload').mockImplementation(async (file, opts) => {
        const transfer: Transfer = {
          id: 'upload-picked',
          type: 'upload',
          state: 'completed',
          file: { name: 'photo.png', size: file.size, mimetype: 'image/png' },
          progress: { loaded: file.size, total: file.size },
          channelId: opts.channelId,
          tray: true,
        };
        useTransferStore.setState({ transfers: new Map([[transfer.id, transfer]]) });
        return transfer.id;
      });
      const { container } = render(<MessageInput channelId="dm-1" channelName="@Bob" />);
      const input = container.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('file input not rendered');

      fireEvent.change(input, { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } });
      expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute('src', created);

      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
      expect(revoke).toHaveBeenCalledWith(created);
      expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual([]);
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else delete (URL as { createObjectURL?: unknown }).createObjectURL;
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it('removes only this channel attachment while preserving other drafts and uploads', () => {
    const transfer = stageTransfer();
    const otherTransfer: Transfer = { ...transfer, id: 'upload-other', channelId: 'dm-2' };
    useTransferStore.setState({ transfers: new Map([[transfer.id, transfer], [otherTransfer.id, otherTransfer]]) });
    useComposerStore.getState().attach('dm-2', otherTransfer.id);
    useComposerStore.getState().setDraft('dm-1', 'keep this draft');
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));

    expect(useComposerStore.getState().get('dm-1').draftText).toBe('keep this draft');
    expect(useComposerStore.getState().get('dm-2').stagedTransferIds).toEqual([otherTransfer.id]);
    expect(useTransferStore.getState().transfers.get(otherTransfer.id)).toEqual(otherTransfer);
  });
});
