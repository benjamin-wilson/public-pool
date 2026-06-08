const apiNodeArgs = (process.env.API_NODE_ARGS || '--max-old-space-size=512')
  .split(/\s+/)
  .filter(arg => arg.length > 0);
const apiMaxMemoryRestart = process.env.API_MAX_MEMORY_RESTART || '768M';
const apiKillTimeout = parseInt(process.env.API_KILL_TIMEOUT_MS || '5000', 10);
const apiRestartDelay = parseInt(process.env.API_RESTART_DELAY_MS || '2000', 10);

module.exports = {
    apps: [
      // API instance
      {
        name: 'api',
        script: './dist/main.js',
        instances: 1,
        exec_mode: 'fork',
        node_args: apiNodeArgs,
        max_memory_restart: apiMaxMemoryRestart,
        kill_timeout: apiKillTimeout,
        restart_delay: apiRestartDelay,
        min_uptime: '10s',
        max_restarts: 10,
        pmx: false,
        vizion: false,
        env: {
          MASTER: 'false',
          API_ONLY: 'true',
          API_ENABLED: 'true',
          NODE_CLUSTER_SCHED_POLICY: 'none',
        },
        time: true
      },
      // Master instance
      {
        name: 'master',
        script: './dist/main.js',
        instances: 1,
        exec_mode: 'fork',
        env: {
          MASTER: 'true',
          API_ENABLED: 'false',
          NODE_CLUSTER_SCHED_POLICY: 'none',
        },
        time: true
      },
      // Worker instances
      {
        name: 'workers',
        script: './dist/main.js',
        instances: parseInt(process.env.STRATUM_WORKERS || '2', 10),
        exec_mode: "cluster",
        env: {
          MASTER: 'false',
          API_ENABLED: 'false',
          NODE_CLUSTER_SCHED_POLICY: 'none',
        },
        time: true
      },
    ],
  };
