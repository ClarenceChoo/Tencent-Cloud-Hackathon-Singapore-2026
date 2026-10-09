import { Clock3, Link2, Wifi, WifiOff } from 'lucide-react';
import { Dashboard, label } from './api';

export function ConnectionButton({ data, stale, preview, active, onOpen }: {
  data: Dashboard | null; stale: boolean; preview: boolean; active: boolean; onOpen: () => void;
}) {
  const device = data?.devices.find(row => row.id === data.active_companion?.device_id);
  const state = !data ? 'loading' : preview ? 'preview' : stale ? 'unavailable' : !device || device.revoked_at || device.status === 'revoked'
    ? 'setup' : device.status === 'connected' ? 'connected' : device.status === 'awaiting_connection' ? 'waiting'
      : device.status === 'stale' ? 'offline' : 'unavailable';
  const text = { loading: 'Checking connection', preview: 'Connection demo', unavailable: 'Status unavailable',
    setup: 'Connect', connected: 'Connected', waiting: 'Waiting for connection', offline: 'Offline' }[state];
  const Icon = state === 'connected' ? Wifi : state === 'offline' ? WifiOff : state === 'waiting' || state === 'loading' ? Clock3 : Link2;
  const name = device ? `${device.device_type === 'phone' ? device.platform === 'web' ? 'Browser' : 'Phone' : 'Cardholder'}${label(device, 'display_name') ? ` · ${label(device, 'display_name')}` : ''}` : 'Patient companion';
  const detail = preview ? 'Fictional connection preview; no live companion is connected.' : stale
    ? 'Connection status could not be refreshed. Open companion setup to check again.'
    : `${name}: ${text}. Open companion connection.`;
  return <div className="header-connection"><span className="connection-caption">Companion</span>
    <button className={`connection-button connection-${state} ${active ? 'connection-active' : ''}`} disabled={!data}
      aria-label={`Companion connection: ${text}`} aria-current={active ? 'page' : undefined} title={detail} onClick={onOpen}>
      <Icon size={16} aria-hidden="true"/><span aria-live="polite">{text}</span>
    </button>
  </div>;
}
