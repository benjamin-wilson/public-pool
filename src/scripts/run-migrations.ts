import { AppDataSource } from '../data-source';

async function main() {
    await AppDataSource.initialize();
    try {
        const migrations = await AppDataSource.runMigrations();
        console.log(`Ran ${migrations.length} database migrations`);
    } finally {
        await AppDataSource.destroy();
    }
}

main().catch(error => {
    console.error('Database migration failed:', error);
    process.exit(1);
});
