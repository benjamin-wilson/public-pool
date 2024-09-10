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
      },
      // Worker instances
      {
        name: 'workers',
        script: './dist/main.js',
        instances: 31,
        env: {
          MASTER: 'false',
        },
      },
    ],
  };