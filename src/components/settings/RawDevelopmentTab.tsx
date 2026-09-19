import { useTranslation } from 'react-i18next';
import type { PhotoView, DevelopProfileRow, LensProfileRow } from '../../storage/repos';
import { describeProfileScope } from '../../engine/developProfile';
import { analyseBenchSelection, benchSelectionHint } from '../bench/benchSelection';
import './RawDevelopmentTab.css';

export interface RawDevelopmentTabProps {
  /** The photos currently selected in the gallery. */
  selected: PhotoView[];
  profiles: DevelopProfileRow[];
  lensProfiles: LensProfileRow[];
  onDeleteProfile: (id: number) => void;
  onDeleteLensProfile: (id: number) => void;
  /** The bench itself, rendered inline below the header. */
  bench: React.ReactNode;
}

/**
 * The RAW development pane: the bench, not a door to it.
 *
 * It works on whatever is selected in the gallery rather than picking photos
 * of its own. A base development is judged against the frames the user
 * actually cares about, and choosing them for them means judging it against
 * whichever nine happened to sort first.
 */
export function RawDevelopmentTab({
  selected, profiles, lensProfiles, onDeleteProfile, onDeleteLensProfile, bench,
}: RawDevelopmentTabProps) {
  const { t } = useTranslation();
  const selection = analyseBenchSelection(selected);
  const hint = benchSelectionHint(selection);

  return (
    <div className="rawdev-tab" data-testid="rawdev-tab">
      <div className="rawdev-bench">{bench}</div>

      <details className="rawdev-stored">
        <summary>
          {t('settings.rawdev.stored', { n: profiles.length + lensProfiles.length })}
        </summary>
        {hint && <div className="rawdev-empty">{hint}</div>}

        <h3 className="rawdev-heading">{t('settings.rawdev.cameraProfiles')}</h3>
        {profiles.length === 0 && <div className="rawdev-empty">{t('settings.rawdev.none')}</div>}
        <ul className="rawdev-list">
          {profiles.map((profile) => (
            <li key={profile.id} className="rawdev-item">
              <span className="rawdev-item-name">{profile.name}</span>
              <span className="rawdev-item-scope">{describeProfileScope(profile)}</span>
              <span className="rawdev-item-count">{t('settings.rawdev.values', { n: Object.keys(profile.adjustments).length })}</span>
              <button className="rawdev-del" onClick={() => onDeleteProfile(profile.id)}>
                {t('settings.rawdev.reset')}
              </button>
            </li>
          ))}
        </ul>

        <h3 className="rawdev-heading">{t('settings.rawdev.lensProfiles')}</h3>
        {lensProfiles.length === 0 && <div className="rawdev-empty">{t('settings.rawdev.none')}</div>}
        <ul className="rawdev-list">
          {lensProfiles.map((profile) => (
            <li key={profile.id} className="rawdev-item">
              <span className="rawdev-item-name">{profile.name}</span>
              <span className="rawdev-item-scope">
                {profile.focalFrom !== null
                  ? `${profile.focalFrom}${profile.focalTo !== null && profile.focalTo !== profile.focalFrom ? `-${profile.focalTo}` : ''} mm`
                  : t('settings.rawdev.allFocalLengths')}
              </span>
              <button className="rawdev-del" onClick={() => onDeleteLensProfile(profile.id)}>
                {t('settings.rawdev.reset')}
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
