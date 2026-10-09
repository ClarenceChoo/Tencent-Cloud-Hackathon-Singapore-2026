import { Clock3, Link2, Smartphone } from 'lucide-react';
import type { Dashboard } from './api';

export function ConnectionButton({ data, stale, active, onOpen }: {
  data: Dashboard | null; stale: boolean; preview?: boolean; active: boolean; onOpen: () => void;
}) {
  const devices = data?.devices.filter(row => !row.revoked_at && row.status !== 'revoked') || [];
  const paired = devices.some(row => row.status === 'connected');
  const pending = devices.some(row => row.status === 'awaiting_connection');
  const state = !data ? 'loading' : stale ? 'unavailable' : paired ? 'paired' : pending ? 'waiting' : 'setup';
  const text = { loading: 'Checking pairing', unavailable: 'Status unavailable', paired: 'Companion paired', waiting: 'Approve connection', setup: 'Connect' }[state];
  const Icon = state === 'paired' ? Smartphone : state === 'waiting' || state === 'loading' ? Clock3 : Link2;
  return <div className="header-connection"><span className="connection-caption">Phone &amp; voice</span>
    <button className={`connection-button connection-${state} ${active ? 'connection-active' : ''}`} disabled={!data}
      aria-label={`Companion connection: ${text}`} aria-current={active ? 'page' : undefined}
      title={paired ? 'An approved companion is paired. Open Phone & voice to manage the phone or ESP32 connection; pairing does not indicate live microphone activity.' : 'Open Phone & voice to connect a phone or ESP32 and review recordings.'} onClick={onOpen}>
      <Icon size={16} aria-hidden="true"/><span aria-live="polite">{text}</span>
    </button>
  </div>;
}
