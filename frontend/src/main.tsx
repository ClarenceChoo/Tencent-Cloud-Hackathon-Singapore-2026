import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { uiPreview } from './uiPreview';
import './styles.css';
import './dashboardNavigation.css';
import BrandLogo from './BrandLogo';

const Companion = React.lazy(() => import('./Companion'));

function PreviewCompanion() {
  return <main className="preview-companion"><a className="brand" href="/landing/" aria-label="Parse, about"><BrandLogo /></a><div className="card"><span className="eyebrow">UI demo · fictional sample data</span><h1>Companion preview</h1><p>The voice companion needs a paired device. This public UI demo does not use the microphone, enroll a device, or contact a voice provider.</p><a className="button button-primary" href="/">Explore the care dashboard →</a></div></main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.pathname.replace(/\/$/, '') === '/companion' ? (uiPreview ? <PreviewCompanion /> : <Suspense fallback={<p>Loading companion…</p>}><Companion /></Suspense>) : <App />}</React.StrictMode>);
