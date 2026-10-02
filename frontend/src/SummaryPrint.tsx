import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { arr, label, Row, str, val } from './api';

export type SummaryPrintProps = {
  summary: Row;
  patientId: string;
  patientName: string;
  /** Changes whenever the session or selected patient changes. */
  identityKey: string;
  /** Fetches a fresh, authorized, reviewed summary with cache: no-store. */
  loadCurrentSummary: (summaryId: string, signal: AbortSignal) => Promise<Row>;
};

const PURPOSE_LABELS: Record<string, string> = {
  doctor_visit: 'Doctor visit',
  family_handoff: 'Family handoff',
  weekly_review: 'Weekly care review',
};

function sourceSignature(summary: Row): string {
  return JSON.stringify(arr(summary.sources).map(source => [source.type, source.id, source.version]).sort());
}

function summaryFingerprint(summary: Row): string {
  return JSON.stringify([
    summary.id, summary.status, summary.reviewed_at, summary.invalidated_at,
    str(summary.purpose, 'doctor_visit'), summary.template_version ?? 1,
    sourceSignature(summary), summary.sections, summary.questions, summary.omitted_source_ids,
  ]);
}

function printable(summary: Row, expected: Row, patientId: string): boolean {
  return expected.status === 'reviewed' && Boolean(expected.reviewed_at) && !expected.invalidated_at &&
    summary.id === expected.id && summary.patient_id === patientId &&
    summary.status === 'reviewed' && Boolean(summary.reviewed_at) && !summary.invalidated_at &&
    summary.reviewed_at === expected.reviewed_at &&
    str(summary.purpose, 'doctor_visit') === str(expected.purpose, 'doctor_visit') &&
    (summary.template_version ?? 1) === (expected.template_version ?? 1) &&
    sourceSignature(summary) === sourceSignature(expected) &&
    JSON.stringify(summary.sections) === JSON.stringify(expected.sections) &&
    JSON.stringify(summary.questions) === JSON.stringify(expected.questions);
}

/** This tree exists only between the access check and the browser print dialog. */
export function SummaryPrintDocument({ summary, patientName }: { summary: Row; patientName: string }) {
  const sources = arr(summary.sources);
  const purpose = str(summary.purpose, 'doctor_visit');
  return <article className="summary-print-sheet" aria-label="Reviewed care summary for print">
    <header className="summary-print-header">
      <p className="summary-print-eyebrow">Reviewed care summary · {PURPOSE_LABELS[purpose] || PURPOSE_LABELS.doctor_visit}</p>
      <h1>{patientName}</h1>
      <dl>
        <div><dt>Selected period</dt><dd>{label(summary, 'start_date') || 'Unknown'} – {label(summary, 'end_date') || 'Unknown'}</dd></div>
        <div><dt>Generated</dt><dd>{label(summary, 'created_at') || 'Unknown'}</dd></div>
        <div><dt>Reviewed</dt><dd>{label(summary, 'reviewed_at') || 'Unknown'}</dd></div>
        <div><dt>Template version</dt><dd>{String(val(summary, 'template_version') ?? 1)}</dd></div>
      </dl>
    </header>
    <p className="summary-print-scope">Reports are limited to the selected period unless a section says current context. Unknown event dates remain unknown. Current context is a snapshot at generation time.</p>
    {arr(summary.sections).map((section, sectionIndex) => {
      const authored = section.kind === 'authored_questions';
      return <section className="summary-print-section" key={`${sectionIndex}-${label(section, 'title')}`}>
        <h2>{label(section, 'title') || (authored ? 'Authored questions' : 'Care reports')}</h2>
        {authored && <p>These questions were written by a person. They are not confirmed care reports.</p>}
        {arr(section.items).map((item, itemIndex) => {
          const sourceId = label(item, 'source_id');
          const source = sources.find(candidate => candidate.id === sourceId);
          return <div className="summary-print-item" key={`${itemIndex}-${sourceId}`}>
            <p>{label(item, 'text')}</p>
            {authored ? <small>Authored question · {label(item, 'author_display_name') || 'Author unknown'} · {label(item, 'authored_at') || 'Time unknown'}</small> :
              source ? <small>Source: {label(source, 'type') || 'Record'} · {sourceId} · version {String(val(source, 'version') ?? 'unknown')}</small> :
              <small>Source reference unavailable</small>}
          </div>;
        })}
      </section>;
    })}
    <footer>Printed or downloaded copies cannot be revoked if the source or sharing permission changes later.</footer>
  </article>;
}

export function SummaryPrint({ summary, patientId, patientName, identityKey, loadCurrentSummary }: SummaryPrintProps) {
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const [printData, setPrintData] = useState<{ identityKey: string; fingerprint: string; summary: Row } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const identityRef = useRef(identityKey);
  const fingerprint = summaryFingerprint(summary);
  const fingerprintRef = useRef(fingerprint);
  identityRef.current = identityKey;
  fingerprintRef.current = fingerprint;

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setPrintData(null);
    setPrinting(false);
    setError('');
    return () => { requestRef.current?.abort(); requestRef.current = null; };
  }, [identityKey, patientId, fingerprint]);

  useEffect(() => {
    if (!printData || printData.identityKey !== identityKey || printData.fingerprint !== fingerprint) return;
    const checkedIdentity = identityKey;
    const checkedFingerprint = fingerprint;
    let expiry: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      if (identityRef.current !== checkedIdentity || fingerprintRef.current !== checkedFingerprint) return;
      try { window.print(); }
      catch { setError('The browser could not open the print dialog. Please try again.'); setPrintData(null); }
      finally {
        setPrinting(false);
        expiry = window.setTimeout(() => setPrintData(null), 60000);
      }
    });
    const clear = () => setPrintData(null);
    window.addEventListener('afterprint', clear);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(expiry); window.removeEventListener('afterprint', clear); };
  }, [identityKey, fingerprint, printData]);

  async function preparePrint() {
    if (printing) return;
    setPrintData(null);
    setError('');
    setPrinting(true);
    const controller = new AbortController();
    requestRef.current = controller;
    const checkedIdentity = identityKey;
    const checkedFingerprint = fingerprint;
    let ready = false;
    try {
      const fresh = await loadCurrentSummary(String(summary.id), controller.signal);
      if (controller.signal.aborted || requestRef.current !== controller || identityRef.current !== checkedIdentity || fingerprintRef.current !== checkedFingerprint) return;
      if (!printable(fresh, summary, patientId)) {
        setError('This summary needs a current review before printing. Prepare and review a fresh draft.');
        return;
      }
      setPrintData({ identityKey, fingerprint, summary: fresh });
      ready = true;
    } catch {
      if (!controller.signal.aborted && requestRef.current === controller && identityRef.current === checkedIdentity && fingerprintRef.current === checkedFingerprint) {
        setError('Could not check access to this summary. Please try again.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (!ready) setPrinting(false);
      }
    }
  }

  return <div className="summary-print-control">
    <button className="button" type="button" disabled={printing} onClick={() => void preparePrint()}>
      {printing ? 'Checking summary…' : 'Print / Save as PDF'}
    </button>
    <p>Printed and downloaded copies cannot be revoked later.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {printData?.identityKey === identityKey && printData.fingerprint === fingerprint &&
      createPortal(<SummaryPrintDocument summary={printData.summary} patientName={patientName} />, document.body)}
  </div>;
}
