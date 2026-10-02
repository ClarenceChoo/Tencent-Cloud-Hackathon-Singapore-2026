import type { ReceiptView } from './turnReceipt';

export default function TurnReceipt({ view, busy, onCheck, onReview }: { view: ReceiptView; busy: boolean; onCheck(): void; onReview(): void }) {
  return <section className={`companion-receipt companion-receipt-${view.phase}`} aria-label="Recording receipt">
    <p className="companion-eyebrow">Recording receipt</p>
    <h2>{view.title}</h2>
    <p role="status" aria-live="polite" aria-atomic="true">{view.detail}</p>
    {view.recipients.length > 0 && <p>Shared with: {view.recipients.join(', ')}. Sharing does not mean it was viewed.</p>}
    {view.primaryAction === 'check' && <button className="companion-button companion-secondary" disabled={busy} onClick={onCheck}>Check recording</button>}
    {view.primaryAction === 'review' && <button className="companion-button companion-secondary" disabled={busy} onClick={onReview}>Go to review</button>}
  </section>;
}
