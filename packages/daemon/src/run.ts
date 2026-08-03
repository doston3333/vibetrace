import { startDaemon } from './index.js';

const daemon = await startDaemon();
const shutdown = (): void => {
  void daemon.close().finally(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGBREAK', shutdown);
