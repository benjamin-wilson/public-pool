import { spawn } from 'child_process';
import * as net from 'net';

async function main() {
    await waitForTcp(process.env.DB_HOST, parseInt(process.env.DB_PORT ?? '5432', 10), 'TimescaleDB');
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
    await waitForTcp(redisUrl.hostname, parseInt(redisUrl.port || '6379', 10), 'Redis');
    await run('node', ['dist/scripts/run-migrations.js']);

    if (process.env.PM2_ENABLED === 'false') {
        await run('node', ['dist/main.js'], true);
        return;
    }

    await run('./node_modules/.bin/pm2-runtime', ['ecosystem.config.js'], true);
}

function waitForTcp(host: string, port: number, label: string): Promise<void> {
    const deadline = Date.now() + parseInt(process.env.STARTUP_WAIT_TIMEOUT_MS ?? '60000', 10);

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.createConnection({ host, port });
            socket.once('connect', () => {
                socket.destroy();
                console.log(`${label} is reachable at ${host}:${port}`);
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    reject(new Error(`${label} was not reachable at ${host}:${port}`));
                    return;
                }
                setTimeout(attempt, 1000);
            });
        };

        attempt();
    });
}

function run(command: string, args: string[], inherit = false): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: inherit ? 'inherit' : 'pipe',
            env: process.env,
        });

        if (!inherit) {
            child.stdout?.on('data', data => process.stdout.write(data));
            child.stderr?.on('data', data => process.stderr.write(data));
        }

        child.once('exit', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
        });
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
