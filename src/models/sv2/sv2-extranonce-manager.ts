import { SV2_EXTENDED_TOTAL_EXTRANONCE_SIZE_BYTES } from '../stratum.constants';

// -- SV2 Extranonce Manager ------------------------------------------
// Manages extranonce prefix allocation for extended mining channels.
// Ensures no two channels share the same prefix to prevent hash collisions.

export class Sv2ExtranonceManager {
  private nextPrefix: number;
  private readonly maxPrefix: number;
  private allocatedPrefixes = new Map<number, number>(); // channelId → prefix
  private usedPrefixes = new Set<number>();
  private readonly prefixSize: number;
  private readonly totalExtranonceSize: number;
  private readonly processNamespace: number;

  /**
   * @param prefixSize Bytes used for pool-assigned prefix (default 4)
   * @param totalExtranonceSize Total extranonce bytes (default 14: 4 prefix + 10 miner/JDC-controlled).
   *        SV2 extended jobs patch the coinbase script length when the
   *        negotiated total differs from the SV1-compatible template slot.
   */
  constructor(
    prefixSize = 4,
    totalExtranonceSize = SV2_EXTENDED_TOTAL_EXTRANONCE_SIZE_BYTES,
    processNamespace = 0,
  ) {
    if (!Number.isInteger(prefixSize) || prefixSize < 2 || prefixSize > 4) {
      throw new Error('SV2 extranonce prefix size must be between 2 and 4 bytes');
    }
    if (!Number.isInteger(totalExtranonceSize) || totalExtranonceSize < prefixSize) {
      throw new Error('SV2 total extranonce size must include the pool prefix');
    }
    if (!Number.isInteger(processNamespace) || processNamespace < 0 || processNamespace > 0xff) {
      throw new Error('SV2 process namespace must fit in one byte');
    }
    this.prefixSize = prefixSize;
    this.totalExtranonceSize = totalExtranonceSize;
    this.processNamespace = processNamespace;

    const bitsPerWorker = (prefixSize - 1) * 8;
    this.maxPrefix = Math.pow(2, bitsPerWorker) - 1; // max within this worker's slice
    this.nextPrefix = 1;
  }

  get minerExtranonceSize(): number {
    return this.totalExtranonceSize - this.prefixSize;
  }

  get totalSize(): number {
    return this.totalExtranonceSize;
  }

  /**
   * Allocate a unique extranonce prefix for a channel.
   * Returns a Buffer of `prefixSize` bytes.
   */
  allocate(channelId: number): Buffer {
    if (!Number.isInteger(channelId) || channelId < 1 || channelId > 0xffffffff) {
      throw new Error('SV2 channel ID must be an unsigned non-zero 32-bit integer');
    }
    // Check if already allocated
    if (this.allocatedPrefixes.has(channelId)) {
      const existing = this.allocatedPrefixes.get(channelId)!;
      return this.prefixToBuffer(existing);
    }

    // Find next available prefix within this worker's partition
    let localPrefix = this.nextPrefix;
    let attempts = 0;
    while (this.usedPrefixes.has(localPrefix) && attempts <= this.maxPrefix) {
      localPrefix = localPrefix + 1;
      if (localPrefix > this.maxPrefix) localPrefix = 1; // Wrap within partition, skip 0
      attempts++;
    }

    if (this.usedPrefixes.has(localPrefix)) {
      throw new Error('Extranonce prefix space exhausted');
    }

    const prefix = localPrefix;
    this.allocatedPrefixes.set(channelId, prefix);
    this.usedPrefixes.add(prefix);
    this.nextPrefix = localPrefix + 1;
    if (this.nextPrefix > this.maxPrefix) this.nextPrefix = 1;

    return this.prefixToBuffer(prefix);
  }

  /**
   * Release the prefix allocated to a channel.
   */
  release(channelId: number): void {
    const prefix = this.allocatedPrefixes.get(channelId);
    if (prefix !== undefined) {
      this.allocatedPrefixes.delete(channelId);
      this.usedPrefixes.delete(prefix);
    }
  }

  /**
   * Get the prefix for a channel, or undefined if not allocated.
   */
  getPrefix(channelId: number): Buffer | undefined {
    const prefix = this.allocatedPrefixes.get(channelId);
    if (prefix === undefined) return undefined;
    return this.prefixToBuffer(prefix);
  }

  get allocatedCount(): number {
    return this.allocatedPrefixes.size;
  }

  private prefixToBuffer(prefix: number): Buffer {
    const buf = Buffer.alloc(this.prefixSize);
    buf[0] = this.processNamespace;
    // The remaining bytes are a process-local, big-endian allocation. Prefix
    // zero stays reserved so an all-zero pool prefix is never issued.
    let val = prefix;
    for (let i = this.prefixSize - 1; i >= 1; i--) {
      buf[i] = val % 0x100;
      val = Math.floor(val / 0x100);
    }
    return buf;
  }
}

export const SV2_MAX_PROCESS_NAMESPACE = 0xff;

/**
 * Resolve the byte that namespaces every pool-assigned SV2 extranonce prefix.
 * PM2 can overlap old and new workers during reload, so each worker receives
 * two lanes selected by restart-generation parity.
 */
export function resolveSv2ProcessNamespace(
  env: NodeJS.ProcessEnv = process.env,
  clusterWorkerIndex?: number,
): number {
  const base = parseNamespaceInteger(
    'SV2_EXTRANONCE_NAMESPACE_BASE',
    env.SV2_EXTRANONCE_NAMESPACE_BASE,
    true,
  ) ?? 0;
  const nodeAppInstance = parseNamespaceInteger(
    'NODE_APP_INSTANCE',
    env.NODE_APP_INSTANCE,
    true,
  );
  const pmId = parseNamespaceInteger('pm_id', env.pm_id, true);
  const workerIndex = nodeAppInstance ?? pmId ?? clusterWorkerIndex;

  if (workerIndex == null) {
    if (env.PM2_ENABLED?.toLowerCase() === 'true') {
      throw new Error(
        'PM2 SV2 worker has no NODE_APP_INSTANCE or pm_id; cannot allocate collision-free extranonces',
      );
    }
    assertNamespaceFits(base);
    return base;
  }
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error('SV2 worker index must be a non-negative integer');
  }

  const restartGeneration = parseNamespaceInteger(
    'restart_time',
    env.restart_time,
    true,
  ) ?? 0;
  const namespace = base + (workerIndex * 2) + (restartGeneration % 2);
  assertNamespaceFits(namespace);
  return namespace;
}

function parseNamespaceInteger(
  name: string,
  value: string | undefined,
  optional: boolean,
): number | null {
  if (value == null || value.trim().length === 0) {
    if (optional) {
      return null;
    }
    throw new Error(`${name} is required`);
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}

function assertNamespaceFits(namespace: number): void {
  if (!Number.isInteger(namespace) || namespace < 0 || namespace > SV2_MAX_PROCESS_NAMESPACE) {
    throw new Error(
      `SV2 extranonce namespace ${namespace} does not fit in one byte; reduce worker count or namespace base`,
    );
  }
}
