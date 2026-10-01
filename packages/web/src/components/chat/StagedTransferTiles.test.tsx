import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Transfer, TransferState } from '../../stores/transferStore';
import { StagedTransferTiles } from './StagedTransferTiles';

function makeTransfer(state: TransferState, mimetype = 'application/vnd.android.package-archive'): Transfer {
  return {
    id: 'upload-1',
    type: 'upload',
    state,
    file: { name: mimetype.startsWith('image/') ? 'photo.png' : 'app-debug.apk', size: 1024, mimetype },
    progress: { loaded: state === 'completed' ? 1024 : 512, total: 1024 },
    tray: false,
  };
}

function renderTile(transfer: Transfer) {
  const callbacks = { onPause: vi.fn(), onResume: vi.fn(), onRemove: vi.fn() };
  const view = render(
    <StagedTransferTiles
      stagedTransfers={[transfer]}
      previewUrls={new Map([[transfer.id, 'blob:preview']])}
      {...callbacks}
    />,
  );
  return { ...view, ...callbacks };
}

describe('StagedTransferTiles', () => {
  it.each(['application/vnd.android.package-archive', 'image/png'])(
    'keeps the completed %s remove chip outside clipping containers',
    (mimetype) => {
      const transfer = makeTransfer('completed', mimetype);
      const { onRemove } = renderTile(transfer);
      const remove = screen.getByRole('button', { name: 'Remove attachment' });

      // The chip intentionally overlaps the corner; only the thumbnail and
      // progress overlay may clip, never an ancestor of this control.
      expect(remove).toHaveClass('absolute', '-top-2', '-right-2');
      expect(remove.closest('.overflow-hidden')).toBeNull();
      if (mimetype.startsWith('image/')) {
        expect(screen.getByRole('img', { name: transfer.file.name }).parentElement).toHaveClass('overflow-hidden');
      }
      fireEvent.click(remove);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(transfer.id);
    },
  );

  it.each(['active', 'paused', 'failed'] as const)(
    'clips only the %s progress overlay and preserves its controls',
    (state) => {
      const transfer = makeTransfer(state);
      const { onPause, onResume, onRemove } = renderTile(transfer);
      const abort = screen.getByRole('button', { name: 'Abort' });
      const clip = abort.closest('.overflow-hidden');

      expect(clip).toHaveClass('absolute', 'inset-0', 'rounded-inherit');
      expect(clip?.parentElement).not.toHaveClass('overflow-hidden');
      expect(screen.queryByRole('button', { name: 'Remove attachment' })).not.toBeInTheDocument();
      if (state === 'active') {
        fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
        expect(onPause).toHaveBeenCalledExactlyOnceWith(transfer.id);
      }
      if (state === 'paused') {
        fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
        expect(onResume).toHaveBeenCalledExactlyOnceWith(transfer.id);
      }
      fireEvent.click(abort);
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(transfer.id);
    },
  );

  it('removes the progress clipping layer when an upload completes', () => {
    const transfer = makeTransfer('active');
    const view = renderTile(transfer);
    view.rerender(
      <StagedTransferTiles
        stagedTransfers={[{ ...transfer, state: 'completed' }]}
        previewUrls={new Map()}
        onPause={view.onPause}
        onResume={view.onResume}
        onRemove={view.onRemove}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove attachment' }).closest('.overflow-hidden')).toBeNull();
  });

  it('renders nothing without staged transfers', () => {
    const { container } = render(
      <StagedTransferTiles
        stagedTransfers={[]}
        previewUrls={new Map()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
