/* eslint-disable @typescript-eslint/no-var-requires */
describe('PM2 worker sizing', () => {
  const originalApiWorkers = process.env.API_WORKERS;
  const originalStratumWorkers = process.env.STRATUM_WORKERS;

  afterEach(() => {
    restoreEnv('API_WORKERS', originalApiWorkers);
    restoreEnv('STRATUM_WORKERS', originalStratumWorkers);
    jest.resetModules();
    jest.unmock('os');
  });

  it('assigns remaining CPUs to Stratum workers in auto mode', () => {
    process.env.API_WORKERS = '4';
    process.env.STRATUM_WORKERS = 'auto';
    jest.doMock('os', () => ({
      availableParallelism: () => 14,
      cpus: () => Array.from({ length: 14 }),
    }));

    const config = require('../ecosystem.config.js');

    expect(config.apps.find((app) => app.name === 'api').instances).toBe(4);
    expect(config.apps.find((app) => app.name === 'workers').instances).toBe(9);
  });

  it('preserves an explicit Stratum worker count', () => {
    process.env.API_WORKERS = '2';
    process.env.STRATUM_WORKERS = '7';

    const config = require('../ecosystem.config.js');

    expect(config.apps.find((app) => app.name === 'workers').instances).toBe(7);
  });

  it('runs the master through the isolated notifier entrypoint', () => {
    const config = require('../ecosystem.config.js');

    expect(config.apps.find((app) => app.name === 'master')).toEqual(
      expect.objectContaining({
        script: './dist/notifier-main.js',
        instances: 1,
        exec_mode: 'fork',
        env: expect.objectContaining({ MASTER: 'true', API_ENABLED: 'false' }),
      }),
    );
  });

  it('runs maintenance duties outside the isolated notifier process', () => {
    const config = require('../ecosystem.config.js');

    expect(config.apps.find((app) => app.name === 'maintenance')).toEqual(
      expect.objectContaining({
        script: './dist/maintenance-main.js',
        instances: 1,
        exec_mode: 'fork',
        env: expect.objectContaining({ MASTER: 'true', API_ENABLED: 'false' }),
      }),
    );
  });

  it('rejects invalid fixed worker counts instead of silently starting no workers', () => {
    process.env.STRATUM_WORKERS = 'many';

    expect(() => require('../ecosystem.config.js')).toThrow(
      'STRATUM_WORKERS must be a positive integer',
    );
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value == null) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
