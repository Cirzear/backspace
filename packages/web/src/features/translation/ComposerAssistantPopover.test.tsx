import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerAssistantPopover } from './ComposerAssistantPopover';
import * as translationStore from './translationStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn(() => ({})),
  },
}));

vi.mock('../../hooks/useFloatingPosition', () => ({
  useFloatingPosition: () => ({ style: {} }),
}));

vi.mock('./useMessageTranslation', () => ({
  useTranslationSettings: () => ({
    accountId: 'user-1',
    settings: {
      revision: 1,
      connections: [{ id: 'conn-1', name: 'OpenAI', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', hasKey: true }],
      preferences: {
        defaultConnection: 'conn-1',
        engine: null,
        targetLanguage: 'zh-CN',
        consent: true,
        automatic: false,
        showOriginal: true,
        composerEnabled: true,
      },
    },
  }),
}));

describe('ComposerAssistantPopover', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render when open is false', () => {
    const anchorRef = { current: document.createElement('button') };
    render(
      <ComposerAssistantPopover
        open={false}
        onClose={vi.fn()}
        draftText="hello"
        onApply={vi.fn()}
        anchorRef={anchorRef}
      />
    );
    expect(screen.queryByText('composerAssistant')).not.toBeInTheDocument();
  });

  it('shows prompt when trying to run action with empty draft', () => {
    const anchorRef = { current: document.createElement('button') };
    render(
      <ComposerAssistantPopover
        open={true}
        onClose={vi.fn()}
        draftText="   "
        onApply={vi.fn()}
        anchorRef={anchorRef}
      />
    );
    expect(screen.getByText('composerAssistant')).toBeInTheDocument();
    fireEvent.click(screen.getByText('polish'));
    expect(screen.getByText('emptyDraftPrompt')).toBeInTheDocument();
  });

  it('calls sendTranslationCommand and onApply when action is selected', async () => {
    const anchorRef = { current: document.createElement('button') };
    const onApply = vi.fn();
    const onClose = vi.fn();

    vi.spyOn(translationStore, 'sendTranslationCommand').mockResolvedValueOnce({
      ok: true,
      outputText: '精心润色后的文本内容',
    });

    render(
      <ComposerAssistantPopover
        open={true}
        onClose={onClose}
        draftText="明天开会"
        onApply={onApply}
        anchorRef={anchorRef}
      />
    );

    fireEvent.click(screen.getByText('polish'));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith('精心润色后的文本内容'));
    expect(onClose).toHaveBeenCalled();
  });
});
