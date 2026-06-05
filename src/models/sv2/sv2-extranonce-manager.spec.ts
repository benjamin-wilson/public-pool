import { Sv2ExtranonceManager } from './sv2-extranonce-manager';


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

});
