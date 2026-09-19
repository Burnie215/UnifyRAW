import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrand } from '../brand';
import { hasBackend } from '../platform/config';
import {
  BUNDLED_COMPONENTS, LICENCE_TEXT_URLS, bundledLicences,
} from '../licenses/thirdParty';
import './AboutDialog.css';

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

type Tab = 'about' | 'github' | 'impressum' | 'privacy' | 'licenses';

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('about');

  if (!open) return null;

  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="about-tabs">
          <button className={`about-tab ${tab === 'about' ? 'active' : ''}`} onClick={() => setTab('about')}>{t('about.tabInfo')}</button>
          <button className={`about-tab ${tab === 'github' ? 'active' : ''}`} onClick={() => setTab('github')}>{t('about.tabGithub')}</button>
          <button className={`about-tab ${tab === 'impressum' ? 'active' : ''}`} onClick={() => setTab('impressum')}>{t('about.tabImpressum')}</button>
          <button className={`about-tab ${tab === 'privacy' ? 'active' : ''}`} onClick={() => setTab('privacy')}>{t('about.tabPrivacy')}</button>
          <button className={`about-tab ${tab === 'licenses' ? 'active' : ''}`} onClick={() => setTab('licenses')}>{t('about.tabLicenses')}</button>
          <div style={{ flex: 1 }} />
          <button className="about-close" onClick={onClose}>×</button>
        </div>

        <div className="about-content">
          {tab === 'about' && <AboutTab />}
          {tab === 'github' && <GithubTab />}
          {tab === 'impressum' && <ImpressumTab />}
          {tab === 'privacy' && <PrivacyTab />}
          {tab === 'licenses' && <LicensesTab />}
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  const { t } = useTranslation();
  const brand = useBrand();
  return (
    <div className="about-section">
      <h2>{brand.name}</h2>
      <p className="about-version">{t('about.version')} 0.1.0</p>
      <p>{t('about.appDescription')}</p>
      <p className="about-muted">{t('about.appSubDescription')}</p>
      <p className="about-muted">
        {t('about.copyright', { year: new Date().getFullYear() })}
      </p>
    </div>
  );
}

const GITHUB_URL = 'https://github.com/Burnie215/UnifyRAW';

function GithubTab() {
  const { t } = useTranslation();
  return (
    <div className="about-section">
      <h2>{t('about.githubHeading')}</h2>
      <p>{t('about.githubIntro')}</p>
      <p className="about-muted">{t('about.githubSource')}</p>

      <h3>{t('about.githubUseHeading')}</h3>
      <ul>
        <li>{t('about.githubUseBug')}</li>
        <li>{t('about.githubUseFeature')}</li>
        <li>{t('about.githubUseDuplicate')}</li>
      </ul>
      <p className="about-muted">{t('about.githubLanguage')}</p>

      <div className="about-links">
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">{GITHUB_URL.replace('https://', '')}</a>
        <a href={`${GITHUB_URL}/issues/new?template=bug_report.yml`} target="_blank" rel="noopener noreferrer">
          {t('about.githubUseBugLink')}
        </a>
        <a href={`${GITHUB_URL}/issues/new?template=feature_request.yml`} target="_blank" rel="noopener noreferrer">
          {t('about.githubUseFeatureLink')}
        </a>
      </div>
    </div>
  );
}

function ImpressumTab() {
  const { t } = useTranslation();
  return (
    <div className="about-section">
      <h2>{t('about.impressumHeading')}</h2>
      <h3>{t('about.impressumLegal')}</h3>
      <p>
        Sebastian Bernhard<br />
        Otto-Hahn-Str. 4<br />
        74321 Bietigheim-Bissingen<br />
        Deutschland
      </p>
      <h3>{t('about.contactHeading')}</h3>
      <p>
        {t('about.contactEmail')}: <a href="mailto:info@d-l-b.de">info@d-l-b.de</a>
      </p>
      <h3>{t('about.responsibleHeading')}</h3>
      <p>
        Sebastian Bernhard<br />
        Otto-Hahn-Str. 4<br />
        74321 Bietigheim-Bissingen
      </p>
    </div>
  );
}

const PRIVACY_URL = { de: 'https://unifyraw.com/datenschutz.html', en: 'https://unifyraw.com/en-privacy.html' };

function PrivacyTab() {
  const { t, i18n } = useTranslation();
  const brand = useBrand();
  const fullPolicy = i18n.language?.startsWith('de') ? PRIVACY_URL.de : PRIVACY_URL.en;
  const section = (key: string) => (
    <>
      <h3>{t(`about.privacy${key}Title`)}</h3>
      <p>{t(`about.privacy${key}Body`, { brand: brand.name })}</p>
    </>
  );
  return (
    <div className="about-section">
      <h2>{t('about.privacyHeading')}</h2>
      <p className="about-muted">{t('about.privacyIntro', { brand: brand.name })}</p>
      {section('Where')}
      {section('Delivery')}
      {section('Local')}
      {section('Sources')}
      {/* Only true where a server exists: the online build has no proxy and
          no server-side preview cache, so it must not claim either. */}
      {hasBackend() && <p>{t('about.privacySourcesSelfhost', { brand: brand.name })}</p>}
      {section('Sync')}
      {section('NoTracking')}
      {section('Rights')}
      <p>
        <a href={fullPolicy} target="_blank" rel="noopener noreferrer">{t('about.privacyFullLink')}</a>
      </p>
      <p>
        {t('about.privacyContact')}: <a href="mailto:info@d-l-b.de">info@d-l-b.de</a>
      </p>
    </div>
  );
}

function LicensesTab() {
  const { t } = useTranslation();
  const brand = useBrand();
  return (
    <div className="about-section">
      <h2>{t('about.licensesHeading')}</h2>
      <p className="about-muted">{t('about.licensesIntro', { brand: brand.name })}</p>

      <div className="license-list">
        {BUNDLED_COMPONENTS.map((c) => (
          <div className="license-item" key={`${c.name}-${c.version}`}>
            <div className="license-name">
              <a href={c.url} target="_blank" rel="noopener noreferrer">{c.name}</a>
              <span className="license-version">{c.version}</span>
            </div>
            <div className="license-meta">
              <span className="license-badge">{c.licence}</span>
              <span className="license-purpose">{t(`about.licPurpose_${c.id}`)}</span>
            </div>
            {c.copyright && <div className="license-copyright">{c.copyright}</div>}
            {c.hasNote && <div className="license-note">{t(`about.licNote_${c.id}`)}</div>}
          </div>
        ))}
      </div>

      <h3>{t('about.licensesFullHeading')}</h3>
      <p className="about-muted">{t('about.licensesFullBody')}</p>
      <div className="about-links">
        {bundledLicences().map((id) => (
          <a key={id} href={LICENCE_TEXT_URLS[id]} target="_blank" rel="noopener noreferrer">{id}</a>
        ))}
      </div>
    </div>
  );
}

