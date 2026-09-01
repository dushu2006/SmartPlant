'use strict';

/**
 * Backend boot: database → alert engine → HTTP server → jobs → simulator.
 */
const { bootstrap } = require('./db');
const { createApp, setAlertEngine } = require('./app');
const config = require('./config');
const logger = require('./logger');

function main() {
  bootstrap();

  const { createAlertEngine } = require('./services/alertEngine');
  const alertEngine = createAlertEngine();
  setAlertEngine(alertEngine);
  require('./services/telemetry').setAlertEngine(alertEngine);

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info('SmartPlant API listening', { host: config.host, port: config.port, mode: config.demoMode ? 'demo' : 'production' });
  });

  // graceful shutdown
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    scheduler.stop();
    require('./simulator').stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Simulator first (immediate tick refreshes telemetry), then jobs.
  require('./simulator').start();
  const scheduler = require('./scheduler').startScheduler({ alertEngine });

  return { server, scheduler };
}

// start when run directly (not when imported by tests)
if (require.main === module) {
  main();
}

module.exports = { main };
