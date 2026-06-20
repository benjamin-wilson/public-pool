export type PayoutMode = 'solo' | 'pplns';

export interface PayoutModePort {
    port: number;
    payoutMode: PayoutMode;
}

export const DEFAULT_PAYOUT_MODE: PayoutMode = 'solo';

export function normalizePayoutMode(value: unknown): PayoutMode {
    return value === 'pplns' ? 'pplns' : 'solo';
}

export function parsePortList(configured?: string | null): number[] {
    if (!configured?.trim()) {
        return [];
    }

    return configured
        .split(',')
        .map(port => parseInt(port.trim(), 10))
        .filter(port => Number.isInteger(port) && port > 0 && port <= 65535);
}

export function parsePayoutModePorts(
    soloPorts?: string | null,
    pplnsPorts?: string | null,
): PayoutModePort[] {
    const byPort = new Map<number, PayoutMode>();
    const addPorts = (configured: string | null | undefined, payoutMode: PayoutMode) => {
        for (const port of parsePortList(configured)) {
            const existingMode = byPort.get(port);
            if (existingMode != null && existingMode !== payoutMode) {
                throw new Error(`Port ${port} is configured for both ${existingMode} and ${payoutMode} payout modes`);
            }
            byPort.set(port, payoutMode);
        }
    };

    addPorts(soloPorts, 'solo');
    addPorts(pplnsPorts, 'pplns');

    return Array.from(byPort.entries()).map(([port, payoutMode]) => ({ port, payoutMode }));
}
