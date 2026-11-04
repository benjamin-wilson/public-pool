import { resolveApiTlsMinVersion } from './api-tls.utils';

describe('resolveApiTlsMinVersion', () => {
  it('requires TLS 1.3 by default', () => {
    expect(resolveApiTlsMinVersion()).toBe('TLSv1.3');
  });

  it.each(['TLSv1.2', 'TLSv1.3'] as const)('accepts %s', (version) => {
    expect(resolveApiTlsMinVersion(version)).toBe(version);
  });

  it('rejects unsupported TLS versions', () => {
    expect(() => resolveApiTlsMinVersion('TLSv1.1'))
      .toThrow('API_TLS_MIN_VERSION must be TLSv1.2 or TLSv1.3');
  });
});
