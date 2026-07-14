const { availableParallelism, cpus } = require('os');

const dockerLogConfig = {
  out_file: '/dev/stdout',
  error_file: '/dev/stderr',
  merge_logs: true,
};

const cpuCount =
  typeof availableParallelism === 'function'
    ? availableParallelism()
    : cpus().length;

const positiveInteger = (name, value, fallback) => {
  const candidate = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return candidate;
};

const apiWorkers = positiveInteger('API_WORKERS', process.env.API_WORKERS, 4);
const automaticStratumWorkers = Math.max(1, cpuCount - apiWorkers - 1);
const stratumWorkers =
  process.env.STRATUM_WORKERS == null ||
  process.env.STRATUM_WORKERS === '' ||
  process.env.STRATUM_WORKERS.toLowerCase() === 'auto'
    ? automaticStratumWorkers
    : positiveInteger('STRATUM_WORKERS', process.env.STRATUM_WORKERS);

module.exports = {
  apps: [
    // API instance
    {
      ...dockerLogConfig,
      name: 'api',
      script: './dist/main.js',
      instances: apiWorkers,
      exec_mode: 'cluster',
      env: {
        MASTER: 'false',
        API_ONLY: 'true',
        API_ENABLED: 'true',
        NODE_CLUSTER_SCHED_POLICY: 'none',
      },
      time: true,
    },
    // Minimal authoritative template/notifier instance. This entrypoint avoids
    // initializing API, Stratum, reporting, and notification integrations.
    {
      ...dockerLogConfig,
      name: 'master',
      script: './dist/notifier-main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        MASTER: 'true',
        API_ENABLED: 'false',
        NODE_CLUSTER_SCHED_POLICY: 'none',
      },
      time: true,
    },
    // Non-hot-path master duties: notifications, reporting, and cleanup.
    {
      ...dockerLogConfig,
      name: 'maintenance',
      script: './dist/maintenance-main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        MASTER: 'true',
        API_ENABLED: 'false',
        NODE_CLUSTER_SCHED_POLICY: 'none',
      },
      time: true,
    },
    // Worker instances
    {
      ...dockerLogConfig,
      name: 'workers',
      script: './dist/main.js',
      instances: stratumWorkers,
      exec_mode: 'cluster',
      max_memory_restart:
        process.env.STRATUM_WORKER_MAX_MEMORY_RESTART || '4096M',
      env: {
        MASTER: 'false',
        API_ENABLED: 'false',
        NODE_CLUSTER_SCHED_POLICY: 'none',
      },
      time: true,
    },
  ],
};
