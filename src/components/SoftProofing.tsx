import { useTranslation } from 'react-i18next';
import type { PaperSimulation, ProofProfile } from '../image/proofFilter';
import './SoftProofing.css';

interface SoftProofingProps {
  enabled: boolean;
  profile: ProofProfile;
  gamutWarning: boolean;
  onToggle: () => void;
  onProfileChange: (p: ProofProfile) => void;
  onGamutWarningToggle: () => void;
  paper?: PaperSimulation;
  onPaperChange?: (p: PaperSimulation) => void;
  simulatePaperWhite?: boolean;
  onSimulatePaperWhiteToggle?: () => void;
}

const PROFILE_LABELS: Record<ProofProfile, string> = {
  'srgb': 'sRGB (Monitor)',
  'adobe-rgb': 'Adobe RGB',
  'prophoto': 'ProPhoto RGB',
  'cmyk-fogra39': 'CMYK (Fogra39)',
  'cmyk-us-web-coated': 'CMYK (US Web Coated)',
  'cmyk-japan-color': 'CMYK (Japan Color)',
};

const PAPER_KEY: Record<PaperSimulation, string> = {
  'none': 'none',
  'matte': 'matte',
  'glossy': 'glossy',
  'fine-art': 'fineArt',
  'canvas': 'canvas',
};

export function SoftProofing({
  enabled, profile, gamutWarning,
  onToggle, onProfileChange, onGamutWarningToggle,
  paper, onPaperChange, simulatePaperWhite, onSimulatePaperWhiteToggle,
}: SoftProofingProps) {
  const { t } = useTranslation();
  return (
    <div className="soft-proofing">
      <div className="sp-header">
        <button className={`sp-toggle ${enabled ? 'active' : ''}`} onClick={onToggle}>
          {enabled ? t('adjustments.softProof.active') : t('adjustments.softProof.title')}
        </button>
        {enabled && (
          <button
            className={`sp-gamut-btn ${gamutWarning ? 'active' : ''}`}
            onClick={onGamutWarningToggle}
            title={t('adjustments.softProof.gamutWarning')}
          >
            ⚠
          </button>
        )}
      </div>
      {enabled && (
        <>
          <div className="sp-row">
            <span className="sp-label">{t('adjustments.softProof.profile')}</span>
            <select
              className="sp-select"
              value={profile}
              onChange={(e) => onProfileChange(e.target.value as ProofProfile)}
            >
              {Object.entries(PROFILE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          {onPaperChange && (
            <div className="sp-row">
              <span className="sp-label">{t('adjustments.softProof.paper')}</span>
              <select
                className="sp-select"
                value={paper ?? 'none'}
                onChange={(e) => onPaperChange(e.target.value as PaperSimulation)}
              >
                {(Object.keys(PAPER_KEY) as PaperSimulation[]).map((value) => (
                  <option key={value} value={value}>{t(`adjustments.softProof.paperOptions.${PAPER_KEY[value]}`)}</option>
                ))}
              </select>
            </div>
          )}
          {onSimulatePaperWhiteToggle && (
            <label className="sp-checkbox">
              <input type="checkbox" checked={simulatePaperWhite ?? false} onChange={onSimulatePaperWhiteToggle} />
              {t('adjustments.softProof.simulatePaperWhite')}
            </label>
          )}
        </>
      )}
    </div>
  );
}
