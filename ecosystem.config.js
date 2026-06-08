module.exports = {
    apps: [
      // API instance
      {
        name: 'api',
        script: './dist/main.js',
        instances: parseInt(process.env.API_WORKERS || '4', 10),
        exec_mode: 'cluster',
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
