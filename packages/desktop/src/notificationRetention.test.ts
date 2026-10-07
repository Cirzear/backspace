import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { NotificationRetainer, type RetainableNotification } from './notificationRetention';

/** Stands in for Electron's Notification: an emitter of click, close and failed. */
class FakeNotification extends EventEmitter {}

// Compile-time check that the fake fits the interface the retainer needs.
const fits: RetainableNotification = new FakeNotification();
void fits;

describe('NotificationRetainer', () => {
  it('holds a notification until it is clicked', () => {
    const retainer = new NotificationRetainer<FakeNotification>();
    const n = new FakeNotification();
    retainer.retain(n);
    expect(retainer.has(n)).toBe(true);
    n.emit('click');
    expect(retainer.has(n)).toBe(false);
    expect(retainer.size).toBe(0);
  });

  it.each(['close', 'failed'] as const)('releases a notification on %s', (event) => {
    const retainer = new NotificationRetainer<FakeNotification>();
    const n = new FakeNotification();
    retainer.retain(n);
    n.emit(event);
    expect(retainer.has(n)).toBe(false);
  });

  it('keeps the click listener the caller added working after release', () => {
    const retainer = new NotificationRetainer<FakeNotification>();
    const n = new FakeNotification();
    let clicked = 0;
    n.on('click', () => { clicked += 1; });
    retainer.retain(n);
    n.emit('click');
    expect(clicked).toBe(1);
  });

  it('holds several notifications independently', () => {
    const retainer = new NotificationRetainer<FakeNotification>();
    const a = new FakeNotification();
    const b = new FakeNotification();
    retainer.retain(a);
    retainer.retain(b);
    a.emit('close');
    expect(retainer.has(a)).toBe(false);
    expect(retainer.has(b)).toBe(true);
  });

  it('does not register twice for the same notification', () => {
    const retainer = new NotificationRetainer<FakeNotification>();
    const n = new FakeNotification();
    retainer.retain(n);
    retainer.retain(n);
    expect(n.listenerCount('click')).toBe(1);
    expect(retainer.size).toBe(1);
  });

  it('releases the oldest notification past the limit', () => {
    const retainer = new NotificationRetainer<FakeNotification>(2);
    const [a, b, c] = [new FakeNotification(), new FakeNotification(), new FakeNotification()];
    retainer.retain(a);
    retainer.retain(b);
    retainer.retain(c);
    expect(retainer.has(a)).toBe(false);
    expect(retainer.has(b)).toBe(true);
    expect(retainer.has(c)).toBe(true);
    expect(retainer.size).toBe(2);
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new NotificationRetainer(0)).toThrow(RangeError);
    expect(() => new NotificationRetainer(1.5)).toThrow(RangeError);
  });
});
