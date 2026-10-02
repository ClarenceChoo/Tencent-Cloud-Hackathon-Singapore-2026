import { useState } from 'react';
import {
  Activity, ArrowRight, CalendarDays, Check, ChevronDown, Clock3,
  FileText, ListTodo, Menu, Mic2, Pill, RotateCcw, X,
} from 'lucide-react';
import { landingCopy as copy } from './landingCopy';
import BrandLogo from './BrandLogo';

type Sample = { label: string; source: string; text: string };

const samples: Sample[] = [
  {
    label: 'Care concern',
    source: 'Voice note',
    text: 'My knee felt stiff after our walk today. I would like to mention it at my next appointment.',
  },
  {
    label: 'Medication self-report',
    source: 'Voice note',
    text: 'I took my morning tablet today.',
  },
  {
    label: 'Support request',
    source: 'Voice note',
    text: 'Could someone help me arrange a ride for Thursday afternoon?',
  },
];

const featureIcons = [FileText, Pill, Activity, ListTodo, CalendarDays];

function Brand() {
  return <a className="landing-brand" href="#top" aria-label="Parse, back to top"><BrandLogo /></a>;
}

function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState<'draft' | 'review' | 'confirmed'>('draft');
  const [editedText, setEditedText] = useState<string>(samples[0].text);
  const [shareWithAlex, setShareWithAlex] = useState(false);
  const sample = samples[selected];
  const shared = stage === 'confirmed' && shareWithAlex;

  function chooseSample(index: number) {
    setSelected(index);
    setEditedText(samples[index].text);
    setShareWithAlex(false);
    setStage('draft');
  }

  function cancelReview() {
    setEditedText(sample.text);
    setShareWithAlex(false);
    setStage('draft');
  }

  function closeMenu() { setMenuOpen(false); }

  return <div className="landing" id="top">
    <a className="landing-skip" href="#main">Skip to content</a>
    <header className="landing-header">
      <div className="landing-wrap landing-header-inner">
        <Brand />
        <button className="landing-menu-toggle" type="button" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="landing-navigation" onClick={() => setMenuOpen(value => !value)}>
          {menuOpen ? <X size={23} aria-hidden="true" /> : <Menu size={23} aria-hidden="true" />}
        </button>
        <nav className={menuOpen ? 'landing-nav is-open' : 'landing-nav'} id="landing-navigation" aria-label="Main navigation">
          <a href="#our-story" onClick={closeMenu}>{copy.nav.story}</a>
          <a href="#how-it-works" onClick={closeMenu}>{copy.nav.process}</a>
          <a href="#faq" onClick={closeMenu}>{copy.nav.faq}</a>
          <a className="landing-nav-open" href="/" onClick={closeMenu}>Open Parse</a>
        </nav>
      </div>
    </header>

    <main id="main">
      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="landing-hero-photo" aria-hidden="true" />
        <div className="landing-wrap landing-hero-inner">
          <h1 id="hero-title">{copy.hero.lines.map(line => <span key={line}>{line}</span>)}</h1>
          <p>{copy.hero.intro}</p>
          <a className="landing-button landing-button-primary" href="/">{copy.hero.primary}<ArrowRight size={18} aria-hidden="true" /></a>
        </div>
      </section>

      <section className="landing-story" id="our-story" aria-labelledby="story-title">
        <div className="landing-story-photo"><img src="/landing/at-home-window.webp" width="1536" height="1024" loading="lazy" alt="Older woman sitting by a window with a cup in her hands" /></div>
        <div className="landing-wrap landing-story-inner">
          <div className="landing-story-main"><span className="landing-kicker">{copy.story.label}</span><h2 id="story-title">{copy.story.title}</h2><div className="landing-story-prose">{copy.story.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div></div>
          <div className="landing-story-distinction"><span>{copy.story.exampleLabel}</span><div><strong>“{copy.story.exampleReport}”</strong><span>{copy.story.exampleRecord}</span></div><p>{copy.story.exampleExplanation}</p></div>
        </div>
      </section>

      <section className="landing-how" id="how-it-works" aria-labelledby="how-title">
        <div className="landing-wrap">
          <div className="landing-section-heading"><span className="landing-kicker">{copy.process.label}</span><h2 id="how-title">{copy.process.title}</h2><p>{copy.process.intro}</p></div>
          <ol className="landing-flow">{copy.process.steps.map((step, index) => <li key={step.title}><span className="landing-flow-number">{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>

          <div className="landing-demo" id="demo" aria-labelledby="demo-title">
            <div className="landing-demo-intro"><div><span className="landing-kicker">{copy.demo.label}</span><h3 id="demo-title">Try the review step.</h3></div><p>{copy.demo.description}</p></div>
            <div className="landing-demo-samples" role="group" aria-label="Choose a fictional sample note">
              {samples.map((item, index) => <button key={item.label} type="button" aria-pressed={selected === index} className={selected === index ? 'is-active' : ''} onClick={() => chooseSample(index)}>{item.label}</button>)}
            </div>
            <div className="landing-record">
              <div className="landing-record-main">
                <div className="landing-record-type"><span className="landing-record-icon"><Mic2 size={23} strokeWidth={1.6} aria-hidden="true" /></span><span className="landing-record-state"><Clock3 size={14} aria-hidden="true" />{stage === 'draft' ? 'Waiting for review' : stage === 'review' ? 'In review' : 'Confirmed'}</span></div>
                <div className="landing-record-content">
                  {stage === 'review' ? <><label htmlFor="landing-review-text">{copy.demo.reviewLabel}</label><textarea id="landing-review-text" rows={3} maxLength={400} value={editedText} onChange={event => setEditedText(event.target.value)} /><fieldset className="landing-share-choice"><legend>Who can see this sample?</legend><label><input type="radio" name="sample-share" checked={!shareWithAlex} onChange={() => setShareWithAlex(false)} />Keep private</label><label><input type="radio" name="sample-share" checked={shareWithAlex} onChange={() => setShareWithAlex(true)} />{copy.demo.shareLabel}<small>{copy.demo.recipient}</small></label></fieldset><p className="landing-review-hint">{copy.demo.hint}</p></> : <p>{stage === 'confirmed' ? editedText : sample.text}</p>}
                </div>
                <div className="landing-record-actions">
                  {stage === 'draft' && <button className="landing-button landing-button-primary" type="button" onClick={() => setStage('review')}>{copy.demo.reviewButton}<ArrowRight size={16} aria-hidden="true" /></button>}
                  {stage === 'review' && <><button className="landing-button landing-button-primary" type="button" disabled={!editedText.trim()} onClick={() => setStage('confirmed')}>{shareWithAlex ? copy.demo.shareButton : copy.demo.privateButton}<Check size={16} aria-hidden="true" /></button><button className="landing-button landing-button-outline" type="button" onClick={cancelReview}>{copy.demo.cancelButton}</button></>}
                  {stage === 'confirmed' && <button className="landing-button landing-button-outline" type="button" onClick={() => chooseSample((selected + 1) % samples.length)}>{copy.demo.resetButton}<RotateCcw size={16} aria-hidden="true" /></button>}
                </div>
              </div>
              <div className="landing-record-meta"><div><span>Source</span><strong>{sample.source}</strong></div><div><span>Permission</span><strong>{stage === 'confirmed' ? shareWithAlex ? 'Shared with Alex' : 'Private' : 'Not shared yet'}</strong></div></div>
            </div>
            <div className="landing-demo-timeline" aria-live="polite"><div><span className="landing-kicker">{copy.demo.timelineLabel}</span><strong>{shared ? sample.label : stage === 'confirmed' ? copy.demo.privateTitle : copy.demo.awaitingTitle}</strong><p>{shared ? editedText : stage === 'confirmed' ? copy.demo.privateText : copy.demo.awaitingText}</p></div><small>{copy.demo.caveat}</small></div>
          </div>
        </div>
      </section>

      <section className="landing-features" aria-labelledby="features-title">
        <div className="landing-features-photo" aria-hidden="true"><img src="/landing/at-home-detail.webp" width="1536" height="1024" loading="lazy" alt="" /></div>
        <div className="landing-wrap landing-features-inner">
          <div className="landing-features-heading"><span className="landing-kicker">{copy.coverage.label}</span><h2 id="features-title">{copy.coverage.title}</h2></div>
          <div className="landing-features-list">{copy.coverage.items.map((item, index) => { const Icon = featureIcons[index]; return <article key={item.title}><Icon size={25} strokeWidth={1.55} aria-hidden="true" /><div><h3>{item.title}</h3><p>{item.text}</p></div></article>; })}</div>
        </div>
      </section>

      <section className="landing-sharing" aria-labelledby="sharing-title">
        <div className="landing-sharing-photo"><img src="/landing/at-home-family.webp" width="1536" height="1024" loading="lazy" alt="Older woman and her adult daughter looking at a phone together at home" /></div>
        <div className="landing-sharing-copy"><div><span className="landing-kicker">{copy.sharing.label}</span><h2 id="sharing-title">{copy.sharing.title}</h2>{copy.sharing.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}<div className="landing-sharing-links"><a href="/companion">{copy.sharing.adultLink}<ArrowRight size={16} aria-hidden="true" /></a><a href="/">{copy.sharing.caregiverLink}<ArrowRight size={16} aria-hidden="true" /></a></div></div></div>
      </section>

      <section className="landing-faq" id="faq" aria-labelledby="faq-title"><div className="landing-wrap"><span className="landing-kicker">Questions</span><h2 id="faq-title">Good to know.</h2><div className="landing-faq-list">{copy.faqs.map(item => <details key={item.question}><summary><span>{item.question}</span><ChevronDown size={19} aria-hidden="true" /></summary><p>{item.answer}</p></details>)}</div></div></section>
      <section className="landing-status" aria-label={copy.status.label}><div className="landing-wrap"><span className="landing-kicker">{copy.status.label}</span><p>{copy.status.text}</p></div></section>
      <section className="landing-closing" aria-label="Open Parse"><div className="landing-wrap"><p>{copy.closing.text}</p><a className="landing-button landing-button-primary" href="/">{copy.closing.action}<ArrowRight size={18} aria-hidden="true" /></a></div></section>
    </main>

    <footer className="landing-footer"><div className="landing-wrap"><Brand /><span>Tencent Cloud Hackathon Singapore 2026 prototype</span></div></footer>
  </div>;
}

export default Landing;
