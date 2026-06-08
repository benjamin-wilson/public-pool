import { performance } from 'perf_hooks';

type TimingMetadata = Record<string, unknown> | (() => Record<string, unknown>);

const DEFAULT_TIMING_LOG_MS = 250;

export function timingStart(): number {
    return performance.now();
}

export async function timeAsync<T>(
    label: string,
    work: () => Promise<T>,
    metadata?: TimingMetadata,
): Promise<T> {
    const start = timingStart();
    try {
        return await work();
    } finally {
        logTiming(label, start, metadata);
    }
}

export function logTiming(label: string, start: number, metadata?: TimingMetadata): void {
    const elapsedMs = performance.now() - start;
    const thresholdMs = getTimingThresholdMs();
    if (thresholdMs < 0 || elapsedMs < thresholdMs) {
        return;
    }

    const resolvedMetadata = resolveMetadata(metadata);
    const metadataText = resolvedMetadata == null ? '' : ` ${JSON.stringify(resolvedMetadata)}`;
    console.warn(`[timing] ${label} ${elapsedMs.toFixed(1)}ms${metadataText}`);
}

function getTimingThresholdMs(): number {
    const configured = Number(process.env.API_TIMING_LOG_MS);
    return Number.isFinite(configured) ? configured : DEFAULT_TIMING_LOG_MS;
}

function resolveMetadata(metadata?: TimingMetadata): Record<string, unknown> | null {
    if (metadata == null) {
        return null;
    }

    try {
        return typeof metadata === 'function' ? metadata() : metadata;
    } catch (error) {
        return { metadataError: error instanceof Error ? error.message : String(error) };
    }
}
