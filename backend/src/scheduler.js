'use strict';

/**
 * Background jobs (node:timers):
 *  - 30s:  telemetry simulator tick (handled by simulator.js)
 *  - 60s:  offline-machine detection, due-task notifications, insight scan
 *  - 12h:  insight expiry sweep, telemetry retention note
 */
const config = require('./config');
const logger = require('./logger');

function startScheduler({ alertEngine }) {
  const jobs = [];

  function every(ms, name, fn, { immediate = false } = {}) {
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        logger.error('scheduled job failed', { job: name, error: err.message });
      }
    };
    if (immediate) run();
    const t = setInterval(run, ms);
    t.unref?.();
    jobs.push({ name, timer: t });
    logger.debug('scheduled job registered', { name, everyMs: ms });
  }

  // Offline detection — machines that stopped reporting.
  every(60000, 'offline-detection', () => {
    alertEngine.checkOfflineMachines();
  }, { immediate: true });

  // Due task notifications (once per day per task).
  every(60000, 'due-tasks', () => {
    const { checkDueTasks } = require('./services/scheduling');
    checkDueTasks();
  }, { immediate: true });

  // AI insight scan (every 15 min).
  every(15 * 60000, 'ai-insights', () => {
    const { generateInsights } = require('./ai/orchestrator');
    generateInsights();
  }, { immediate: false });

  // Insight expiry sweep (every 12h).
  every(12 * 3600000, 'insight-expiry', () => {
    // Expired insights remain stored for auditability; the sweep only logs.
    logger.info('insight retention sweep (retention policy: 90 days)');
  });

  // Low-stock notification (every 6h).
  every(6 * 3600000, 'low-stock', () => {
    const inventoryStore = require('./store/inventory');
    const { notify } = require('./services/notifications');
    const low = inventoryStore.lowStockParts();
    for (const p of low) {
      notify({
        type: 'SYSTEM',
        title: `Low stock: ${p.name} (${p.available_qty} available)`,
        body: `Available ${p.available_qty} is at/below reorder level ${p.reorder_level}. Supplier: ${p.supplier || 'n/a'}.`,
        entityType: 'spare_part',
        entityId: p.id,
        dedupeKey: `low-stock:${p.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  });

  return {
    stop() {
      for (const j of jobs) clearInterval(j.timer);
      jobs.length = 0;
    },
  };
}

module.exports = { startScheduler };
