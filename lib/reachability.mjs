import { isPublicAddress } from './catalog.mjs';

export const DOWN_POLICY = 'connection-refused-v1';

export function hasHttpResponse(response) {
  return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599;
}

export function confirmedRefusal(check) {
  const refused = response => response?.http_status === null
    && response.error === 'connection_error' && response.error_code === 'ECONNREFUSED'
    && isPublicAddress(response.resolved_ip);
  return check?.policy === DOWN_POLICY
    && ['health', 'languages', 'settings', 'homepage'].every(name => refused(check.primary?.[name]))
    && refused(check.confirmation);
}

export function eligibleOffline(item) {
  return item?.availability === 'offline' && confirmedRefusal(item.down_check);
}

export function failureDetail(responses) {
  const failed = responses.filter(response => response?.error);
  const route = failed.find(response => ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(response.error_code));
  if (route) return (route.resolved_ip?.includes(':') ? 'IPv6 route' : 'Network route') + ' unavailable from this checker';
  const tls = failed.find(response => response.error === 'tls_error');
  if (tls) return 'TLS certificate or handshake failure' + (tls.error_code ? ' (' + tls.error_code + ')' : '');
  if (failed.some(response => ['unsafe_url', 'non_public_address'].includes(response.error))) return 'Address blocked by public-network checks';
  const dns = failed.find(response => response.error === 'dns_error' || response.error_stage === 'dns');
  if (dns) return 'DNS resolution failed on this checker' + (dns.error_code ? ' (' + dns.error_code + ')' : '');
  if (failed.some(response => response.error === 'timeout')) return 'No HTTP response before the request deadline';
  const connection = failed.find(response => response.error_code);
  return connection ? 'Connection failed (' + connection.error_code + ')' : 'No HTTP response from this checker';
}
