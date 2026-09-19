import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { persistOnShutdown } from './shutdown.js';

function setup(persist: () => void = vi.fn()) {
  const signals = new EventEmitter();
  const server = { close: vi.fn() };
  const exit = vi.fn();
  persistOnShutdown(server as never, persist, exit, signals as unknown as Pick<NodeJS.Process, 'once'>);
  return { signals, server, exit, persist };
}

describe('persistOnShutdown', () => {
  it('saves the database and exits cleanly on SIGTERM', () => {
    const { signals, server, exit, persist } = setup();
    signals.emit('SIGTERM', 'SIGTERM');
    expect(server.close).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('saves once when SIGINT follows SIGTERM', () => {
    const { signals, persist, exit } = setup();
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGINT', 'SIGINT');
    expect(persist).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('exits with 1 when the save fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { signals, exit } = setup(() => { throw new Error('disk full'); });
    signals.emit('SIGTERM', 'SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
