module.exports = {
    apps: [
      // Master instance
      {
        name: 'master',
        script: './dist/main.js',
        instances: 1,
        env: {
          MASTER: 'true',
        },
        time: true
      },
      // Worker instances
      {
        name: 'workers',
        script: './dist/main.js',
        instances: 2,
        exec_mode: "cluster",
        env: {
          MASTER: 'false',
        },
        time: true
      },
    ],
  };