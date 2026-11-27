import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/uiStore';
import { EmojiPicker } from './EmojiPicker';
import { InputPopover } from './InputPopover';
import { MobilePickerSheet } from './MobilePickerSheet';
import { ReactionPickerPopover } from './ReactionPickerPopover';

vi.mock('../../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  api: {
    stickers: { list: vi.fn(), remove: vi.fn(), collect: vi.fn(), rename: vi.fn() },
    // The upload form reads the instance's sticker size limit.
    instance: { info: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'alice' } }) }));
// emoji-mart's search input stops every key from bubbling out of the picker.
vi.mock('@emoji-mart/react', () => ({
  default: () => <input aria-label="Search emoji" onKeyDown={event => event.nativeEvent.stopImmediatePropagation()} />,
}));

const sticker = { id: 'a'.repeat(64), name: 'Happy', token: `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp` };

interface Host {
  name: string;
  /** Renders the host with its picker already on the sticker tab. */
  render: (onClose: () => void) => ReactElement;
  mobile: boolean;
}

function anchor(): HTMLElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

/**
 * The reaction pickers only choose a sticker: both render the picker with
 * `manageable={false}` (ReactionPickerPopover, and the sheet Message opens on
 * a phone), so no rename or upload form can open in them.
 */
const reactionHosts: Host[] = [
  {
    name: 'the message reaction popover',
    mobile: false,
    render: onClose => <ReactionPickerPopover anchorEl={anchor()} onEmojiSelect={vi.fn()} onClose={onClose} />,
  },
  {
    name: 'the message reaction sheet',
    mobile: true,
    render: onClose => (
      <MobilePickerSheet onClose={onClose} label="Add reaction">
        <EmojiPicker onEmojiSelect={vi.fn()} manageable={false} mobile />
      </MobilePickerSheet>
    ),
  },
];

/** The composer's hosts, the only ones where the sticker forms open: the popover and the phone's sheet. */
const formHosts: Host[] = [false, true].map(mobile => ({
  name: mobile ? 'the composer sheet' : 'the composer popover',
  mobile,
  render: onClose => (
    <InputPopover activeTab="sticker" onClose={onClose} onEmojiSelect={vi.fn()} onGifSelect={vi.fn()}
      anchorRef={{ current: anchor() }} gifEnabled={false} onTabChange={vi.fn()} />
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(api.stickers.list).mockResolvedValue([sticker]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useUIStore.setState({ isMobile: false });
});

async function openStickers(host: Host, onClose: () => void) {
  useUIStore.setState({ isMobile: host.mobile });
  render(host.render(onClose));
  const tab = screen.queryByRole('button', { name: 'My stickers', pressed: false });
  if (tab) fireEvent.click(tab);
  await screen.findByRole('button', { name: 'Happy' });
}

describe.each(reactionHosts)('Escape on the sticker tab of $name', host => {
  it('closes the picker at once, with nothing to manage or upload', async () => {
    const onClose = vi.fn();
    await openStickers(host, onClose);
    expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload image' })).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Happy' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe.each(formHosts)('Escape in $name', host => {
  it('closes the rename form first, gives focus back to its tile, and closes the picker on the next Escape', async () => {
    const onClose = vi.fn();
    await openStickers(host, onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));
    const input = screen.getByLabelText('Sticker name');
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Rename sticker' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Happy' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Rename Happy' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes the upload form first and gives focus back to the upload button', async () => {
    const onClose = vi.fn();
    await openStickers(host, onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByLabelText('Choose image', { selector: 'input' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload image' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Upload image' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

const emojiHosts: Host[] = [
  ...reactionHosts,
  {
    name: 'the composer popover',
    mobile: false,
    render: onClose => (
      <InputPopover activeTab="emoji" onClose={onClose} onEmojiSelect={vi.fn()} onGifSelect={vi.fn()}
        anchorRef={{ current: anchor() }} gifEnabled={false} onTabChange={vi.fn()} />
    ),
  },
];

describe('Escape typed in the emoji search', () => {
  it.each(emojiHosts)('closes $name at once', host => {
    const onClose = vi.fn();
    useUIStore.setState({ isMobile: host.mobile });
    render(host.render(onClose));
    act(() => screen.getByLabelText('Search emoji').focus());
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('an Escape the picker leaves alone', () => {
  it.each(formHosts)('one that ends an IME composition in the rename field of $name', async host => {
    const onClose = vi.fn();
    await openStickers(host, onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Happy' }));

    fireEvent.keyDown(screen.getByLabelText('Sticker name'), { key: 'Escape', isComposing: true });
    expect(screen.getByRole('form', { name: 'Rename sticker' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(emojiHosts)('one that ends an IME composition in the emoji search of $name', host => {
    const onClose = vi.fn();
    useUIStore.setState({ isMobile: host.mobile });
    render(host.render(onClose));
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  /** Builds emoji-mart's shadow root next to the mocked search: its skin tone menu and a category button. */
  function emojiMartShadow(): { skinRadio: HTMLInputElement; categoryButton: HTMLButtonElement } {
    const host = document.createElement('em-emoji-picker');
    screen.getByLabelText('Search emoji').after(host);
    const root = host.attachShadow({ mode: 'open' });
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'radiogroup');
    const skinRadio = document.createElement('input');
    skinRadio.type = 'radio';
    menu.append(skinRadio);
    const categoryButton = document.createElement('button');
    root.append(menu, categoryButton);
    return { skinRadio, categoryButton };
  }

  function escapeFrom(target: Element): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it.each(emojiHosts)('one typed in emoji-mart\'s skin tone menu in $name, which emoji-mart closes itself', host => {
    const onClose = vi.fn();
    useUIStore.setState({ isMobile: host.mobile });
    render(host.render(onClose));
    const { skinRadio, categoryButton } = emojiMartShadow();

    expect(escapeFrom(skinRadio).defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    expect(escapeFrom(categoryButton).defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
