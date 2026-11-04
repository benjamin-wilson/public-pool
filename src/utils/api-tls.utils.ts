export type ApiTlsMinVersion = 'TLSv1.2' | 'TLSv1.3';

const DEFAULT_API_TLS_MIN_VERSION: ApiTlsMinVersion = 'TLSv1.3';

export function resolveApiTlsMinVersion(value?: string): ApiTlsMinVersion {
  const resolved = value ?? DEFAULT_API_TLS_MIN_VERSION;
  if (resolved !== 'TLSv1.2' && resolved !== 'TLSv1.3') {
    throw new Error('API_TLS_MIN_VERSION must be TLSv1.2 or TLSv1.3');
  }
  return resolved;
}
