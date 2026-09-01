'use strict';

/**
 * Synthetic telemetry simulator (source='simulator'). Runs only when
 * SIMULATE_TELEMETRY=true. Every reading is tagged source=simulator and the
 * UI shows a DEMO badge — simulated data is never presented as device data
 * (PRD §9, §61–62).
 *
 * Behavior: mean-reverting random walk around each machine's profile,
 * occasional engineered episodes (rising temperature, power spike) so the
 * alert engine and AI copilot have realistic live activity.
 */
const config = require('./config');
const machinesStore = require('./store/machines');
const telemetryService = require('./services/telemetry');
const telemetryStore = require('./store/telemetry');
const logger = require('./logger');

const PROFILES = {
  mach_extruder: { temperature_c: { base: 53, amp: 2.5, noise: 0.5 }, power_kw: { base: 9.4, amp: 1.2, noise: 0.3 }, load_pct: { base: 68, noise: 2 } },
  mach_mill: { temperature_c: { base: 46, amp: 3.5, noise: 0.6 }, power_kw: { base: 7.9, amp: 2.0, noise: 0.4 }, load_pct: { base: 55, noise: 2.5 }, vibration_mm_s: { base: 1.9, noise: 0.12 } },
  mach_mixer: { temperature_c: { base: 41, amp: 4.5, noise: 0.7 }, power_kw: { base: 5.5, amp: 1.0, noise: 0.3 } },
  mach_press: { temperature_c: { base: 34, noise: 0.4 }, power_kw: { base: 0.9, amp: 0.5, noise: 0.15 } },
  mach_robot: { temperature_c: { base: 38, amp: 2.5, noise: 0.5 }, power_kw: { base: 2.7, amp: 0.8, noise: 0.2 }, load_pct: { base: 62, noise: 3 } },
  mach_molder: { temperature_c: { base: 58, amp: 5, noise: 0.8 }, power_kw: { base: 11.6, amp: 2.2, noise: 0.5 }, load_pct: { base: 72, noise: 2 } },
  mach_welding: { temperature_c: { base: 28, noise: 0.3 }, power_kw: { base: 0.2, noise: 0.05 } },
  mach_conveyor: { temperature_c: { base: 36, amp: 2, noise: 0.4 }, power_kw: { base: 3.9, amp: 0.9, noise: 0.25 }, load_pct: { base: 58, noise: 2 } },
  mach_lathe: { temperature_c: { base: 44, amp: 3.5, noise: 0.6 }, power_kw: { base: 6.3, amp: 1.6, noise: 0.3 }, vibration_mm_s: { base: 2.4, noise: 0.15 } },
  mach_hpress: { temperature_c: { base: 32, noise: 0.4 }, power_kw: { base: 1.1, amp: 0.4, noise: 0.15 } },
  mach_cooling: { temperature_c: { base: 39, amp: 2.5, noise: 0.7 }, power_kw: { base: 5.1, amp: 1.0, noise: 0.3 } },
  mach_compressor: { temperature_c: { base: 55, amp: 4, noise: 0.9 }, power_kw: { base: 13.2, amp: 2.6, noise: 0.5 }, pressure_bar: { base: 7.2, noise: 0.15 } },
  mach_packaging: { temperature_c: { base: 41, amp: 2.5, noise: 0.5 }, power_kw: { base: 9.5, amp: 1.5, noise: 0.4 } },
  mach_palletizer: { temperature_c: { base: 30, noise: 0.3 }, power_kw: { base: 0.3, noise: 0.05 } },
  mach_laser: { temperature_c: { base: 42, amp: 3.5, noise: 0.6 }, power_kw: { base: 5.9, amp: 1.4, noise: 0.3 }, load_pct: { base: 60, noise: 2.5 } },
  mach_testbench: { temperature_c: { base: 29, noise: 0.2 }, power_kw: { base: 0.4, noise: 0.05 } },
};

// In-memory walk state + episodes
const state = new Map();
const episodes = new Map(); // machine_id -> { metric, remainingTicks, deltaPerTick }

function tickEpisode(machineId) {
  // Randomly start an episode on a RUNNING machine (~1% per minute per machine)
  if (Math.random() < 0.03) {
    const machines = machinesStore.listRunning().filter((m) => m.status === 'RUNNING');
    const target = machines[Math.floor(Math.random() * machines.length)];
    if (target && !episodes.has(target.id)) {
      const metric = Math.random() < 0.6 ? 'temperature_c' : 'power_kw';
      const prof = PROFILES[target.id]?.[metric];
      if (prof) {
        const deltaPerTick = metric === 'temperature_c' ? 0.25 + Math.random() * 0.4 : 0.5 + Math.random() * 0.8;
        const ticks = Math.floor(18 + Math.random() * 30); // 9–24 minutes
        episodes.set(target.id, { metric, remainingTicks: ticks, deltaPerTick });
        logger.info('simulator episode started', { machine: target.id, metric, ticks });
      }
    }
  }
}

function tick() {
  const machines = machinesStore.listRunning();
  const now = new Date().toISOString();
  const readings = [];
  // Monotonic sequence: time-based so it never collides with warm-up
  // sequences (0..575) and every simulator reading is unique.
  const tickSeq = Math.floor(Date.now() / 1000);
  let sequenceMap = new Map();

  for (const machine of machines) {
    const profile = PROFILES[machine.id];
    if (!profile) continue;
    const running = machine.status === 'RUNNING' || machine.status === 'FAULT';
    let s = state.get(machine.id);
    if (!s) {
      s = {};
      const latest = telemetryStore.latestForMachine(machine.id);
      for (const metric of Object.keys(profile)) {
        s[metric] = latest[metric]?.value ?? profile[metric].base;
      }
      state.set(machine.id, s);
    }

    const ep = episodes.get(machine.id);
    for (const metric of Object.keys(profile)) {
      const p = profile[metric];
      const day = (2 * Math.PI * (Date.now() % 86400000)) / 86400000;
      // mean-reverting random walk toward base + diurnal + episode drift
      let target = p.base + (p.amp || 0) * Math.sin(day / 24);
      let value = s[metric] + (target - s[metric]) * 0.15 + (Math.random() - 0.5) * (p.noise * 2);
      if (ep && ep.metric === metric) {
        value += ep.deltaPerTick;
      }
      if (!running && metric === 'power_kw') value = Math.min(value, 1.2);
      value = Math.max(0, Math.round(value * 100) / 100);
      s[metric] = value;

      readings.push({
        machine_id: machine.id,
        ts: now,
        metric,
        value,
        unit: metric === 'temperature_c' ? 'C' : metric === 'power_kw' ? 'kW' : metric === 'load_pct' ? '%' : metric === 'pressure_bar' ? 'bar' : 'mm/s',
        quality: 'good',
        source: 'simulator',
        sequence: tickSeq + (sequenceMap.get(machine.id) ?? 0),
      });
      sequenceMap.set(machine.id, (sequenceMap.get(machine.id) ?? 0) + 1);
    }

    // advance episode
    if (ep) {
      ep.remainingTicks--;
      if (ep.remainingTicks <= 0) {
        episodes.delete(machine.id);
        logger.info('simulator episode ended', { machine: machine.id });
      }
    }
  }

  tickEpisode();
  if (readings.length) {
    const result = telemetryService.ingestSimulated(readings);
    logger.debug('simulator tick', { readings: readings.length, inserted: result.inserted, duplicates: result.duplicates, alerts: result.alertsCreated.length });
  }
}

let timer = null;

function start() {
  if (!config.simulateTelemetry) {
    logger.info('telemetry simulator disabled (SIMULATE_TELEMETRY=false)');
    return;
  }
  stop();
  logger.info('telemetry simulator started', { intervalSec: config.simIntervalSec });
  tick(); // immediate tick so data is fresh at boot
  timer = setInterval(tick, config.simIntervalSec * 1000);
  timer.unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
