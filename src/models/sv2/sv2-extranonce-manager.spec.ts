import {
  resolveSv2ProcessNamespace,
  Sv2ExtranonceManager,
} from './sv2-extranonce-manager';


describe('Sv2ExtranonceManager', () => {
  it('allocates unique prefixes for different channels', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1 = mgr.allocate(1);
    const p2 = mgr.allocate(2);
    const p3 = mgr.allocate(3);

    expect(p1).not.toEqual(p2);
    expect(p2).not.toEqual(p3);
    expect(p1).not.toEqual(p3);
  });

  it('returns same prefix for same channel on re-allocation', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1a = mgr.allocate(1);
    const p1b = mgr.allocate(1);
    expect(p1a).toEqual(p1b);
  });

  it('prefix is 4 bytes by default', () => {
    const mgr = new Sv2ExtranonceManager();
    const p = mgr.allocate(1);
    expect(p.length).toBe(4);
  });

  it('minerExtranonceSize is total minus prefix', () => {
    const defaultMgr = new Sv2ExtranonceManager();
    expect(defaultMgr.minerExtranonceSize).toBe(10);

    const mgr = new Sv2ExtranonceManager(4, 8);
    expect(mgr.minerExtranonceSize).toBe(4);

    const mgr2 = new Sv2ExtranonceManager(2, 6);
    expect(mgr2.minerExtranonceSize).toBe(4);
  });

  it('releases prefix and allows reuse', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1 = mgr.allocate(1);
    expect(mgr.allocatedCount).toBe(1);

    mgr.release(1);
    expect(mgr.allocatedCount).toBe(0);
    expect(mgr.getPrefix(1)).toBeUndefined();

    // Should be able to allocate again (may get same or different prefix)
    const p2 = mgr.allocate(10);
    expect(p2.length).toBe(4);
    expect(mgr.allocatedCount).toBe(1);
  });

  it('release is idempotent for unknown channels', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(() => mgr.release(999)).not.toThrow();
  });

  it('getPrefix returns undefined for unallocated channel', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(mgr.getPrefix(42)).toBeUndefined();
  });

  it('getPrefix returns the allocated prefix', () => {
    const mgr = new Sv2ExtranonceManager();
    const p = mgr.allocate(1);
    expect(mgr.getPrefix(1)).toEqual(p);
  });

  it('handles many allocations without collision', () => {
    const mgr = new Sv2ExtranonceManager();
    const prefixes = new Set<string>();

    for (let i = 1; i <= 1000; i++) {
      const p = mgr.allocate(i);
      const hex = p.toString('hex');
      expect(prefixes.has(hex)).toBe(false);
      prefixes.add(hex);
    }

    expect(mgr.allocatedCount).toBe(1000);
  });

  it('works with 2-byte prefix size', () => {
    const mgr = new Sv2ExtranonceManager(2, 4);
    const p = mgr.allocate(1);
    expect(p.length).toBe(2);
    expect(mgr.minerExtranonceSize).toBe(2);
  });

  it('reuses released prefix slot', () => {
    const mgr = new Sv2ExtranonceManager();
    const p1 = mgr.allocate(1);
    mgr.allocate(2);
    mgr.release(1);

    // Allocate a new channel - p1's prefix should be available
    const p3 = mgr.allocate(3);
    expect(p3.length).toBe(4);
    expect(mgr.allocatedCount).toBe(2);
  });

  it('tracks allocatedCount correctly', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(mgr.allocatedCount).toBe(0);
    mgr.allocate(1);
    expect(mgr.allocatedCount).toBe(1);
    mgr.allocate(2);
    expect(mgr.allocatedCount).toBe(2);
    mgr.release(1);
    expect(mgr.allocatedCount).toBe(1);
    mgr.release(2);
    expect(mgr.allocatedCount).toBe(0);
  });

  it('partitions prefixes deterministically across PM2 workers and reload generations', () => {
    const worker0 = resolveSv2ProcessNamespace({
      NODE_APP_INSTANCE: '0',
      restart_time: '0',
    });
    const worker1 = resolveSv2ProcessNamespace({
      NODE_APP_INSTANCE: '1',
      restart_time: '0',
    });
    const worker0Reload = resolveSv2ProcessNamespace({
      NODE_APP_INSTANCE: '0',
      restart_time: '1',
    });
    const prefixes = [worker0, worker1, worker0Reload].map(namespace => (
      new Sv2ExtranonceManager(4, 14, namespace).allocate(1).toString('hex')
    ));

    expect([worker0, worker1, worker0Reload]).toEqual([0, 2, 1]);
    expect(new Set(prefixes).size).toBe(3);
    expect(prefixes).toEqual(['00000001', '02000001', '01000001']);
  });

  it('offsets PM2 worker lanes with an explicit deployment namespace base', () => {
    expect(resolveSv2ProcessNamespace({
      SV2_EXTRANONCE_NAMESPACE_BASE: '32',
      NODE_APP_INSTANCE: '3',
      restart_time: '5',
    })).toBe(39);
  });

  it('falls back to pm_id when NODE_APP_INSTANCE is unavailable', () => {
    expect(resolveSv2ProcessNamespace({
      pm_id: '7',
      restart_time: '2',
    })).toBe(14);
  });

  it('fails closed for managed workers without a unique process identifier', () => {
    expect(() => resolveSv2ProcessNamespace({ PM2_ENABLED: 'true' }))
      .toThrow('cannot allocate collision-free extranonces');
  });

  it('fails when the worker namespace cannot fit in the four-byte prefix', () => {
    expect(() => resolveSv2ProcessNamespace({
      NODE_APP_INSTANCE: '128',
      restart_time: '0',
    })).toThrow('does not fit in one byte');
    expect(() => new Sv2ExtranonceManager(4, 14, 256))
      .toThrow('must fit in one byte');
  });

  it('rejects prefix and total sizes that cannot preserve the namespace', () => {
    expect(() => new Sv2ExtranonceManager(1, 14, 0))
      .toThrow('between 2 and 4 bytes');
    expect(() => new Sv2ExtranonceManager(4, 3, 0))
      .toThrow('must include the pool prefix');
  });

  it('rejects channel identifiers that cannot be represented by SV2', () => {
    const mgr = new Sv2ExtranonceManager();
    expect(() => mgr.allocate(0)).toThrow('unsigned non-zero 32-bit integer');
    expect(() => mgr.allocate(0x1_0000_0000)).toThrow('unsigned non-zero 32-bit integer');
  });

});
