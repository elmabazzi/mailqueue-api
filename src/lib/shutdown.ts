import type { Logger } from './logger.js';

/**
 * Runs cleanup steps when the platform asks the process to stop (Render sends SIGTERM on
 * every deploy), so in-flight requests and jobs can finish instead of being cut off.
 */
export function onShutdown(logger: Logger, cleanup: () => Promise<void>, forceAfterMs = 20_000) {
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, forceAfterMs).unref();

    cleanup().then(
      () => {
        logger.info('Shutdown complete');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      },
    );
  };

  process.once('SIGTERM', handle);
  process.once('SIGINT', handle);
}

/** Logs and exits on errors nobody handled, so the platform restarts a clean process. */
export function exitOnFatalErrors(logger: Logger) {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
}
