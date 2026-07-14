import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 15 * 1000;

@Injectable()
export class PoolSummaryRefreshService implements OnModuleInit, OnModuleDestroy {
    private timer: NodeJS.Timeout | null = null;
    private startupTimer: NodeJS.Timeout | null = null;
    private refreshing = false;

    constructor(private readonly shareAccountingService: ShareAccountingService) { }

    public onModuleInit(): void {
        if (process.env.MASTER !== 'true' || process.env.API_ONLY === 'true') {
            return;
        }

        this.startupTimer = setTimeout(() => {
            void this.refresh();
        }, this.readPositiveInt('POOL_SUMMARY_REFRESH_STARTUP_DELAY_MS', DEFAULT_STARTUP_DELAY_MS));
        this.startupTimer.unref?.();

        this.timer = setInterval(() => {
            void this.refresh();
        }, this.readPositiveInt('POOL_SUMMARY_REFRESH_INTERVAL_MS', DEFAULT_REFRESH_INTERVAL_MS));
        this.timer.unref?.();
    }

    public async onModuleDestroy(): Promise<void> {
        if (this.startupTimer != null) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }

        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async refresh(): Promise<void> {
        if (this.refreshing) {
            return;
        }

        this.refreshing = true;
        try {
            await this.shareAccountingService.refreshPoolSummary();
            await this.shareAccountingService.refreshPoolSummary('pplns');
            await this.shareAccountingService.refreshPoolSummary('solo');
        } catch (error) {
            console.error(`Failed refreshing pool accounting summary: ${error.message}`);
        } finally {
            this.refreshing = false;
        }
    }

    private readPositiveInt(name: string, fallback: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : fallback;
    }
}
