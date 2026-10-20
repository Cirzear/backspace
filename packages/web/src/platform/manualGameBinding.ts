/**
 * Tell the desktop which program the player's own game is tied to, so its
 * detector shows the game while that program runs. A browser, or a desktop
 * build that predates the binding, has no such channel and ignores this.
 */
export function syncManualBinding(name: string | null, process: string | null): void {
  const bridge = window.backspace;
  if (!bridge?.setManualGameBinding) return;
  const binding = name !== null && process !== null ? { name, process } : null;
  bridge.setManualGameBinding(binding).catch(() => {});
}
