module.exports = {
    apps: [
      // Master instance
      {
        name: 'master',
        script: './dist/main.js',
        instances: 1,
        env: {
          MASTER: 'true',
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
          NODE_CLUSTER_SCHED_POLICY: 'none',
        },
        time: true
      },
    ],
  };
