import type { Server } from 'http';

type SignalSource = Pick<NodeJS.Process, 'once'>;

/**
 * Saves the database before the process ends on a container stop. Sync pushes
 * are written before their answer, but other writers (accounts, libraries)
 * rely on the 30 s timer, and Docker's SIGTERM used to end the process first.
 */
export function persistOnShutdown(
  server: Pick<Server, 'close'>,
  persist: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: SignalSource = process,
): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    server.close();
    try {
      persist();
    } catch (error) {
      console.error(`[shutdown] saving the database on ${signal} failed`, error);
      exit(1);
      return;
    }
    exit(0);
  };
  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
}
