import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoLibraryScan } from '@photolib/shared';
import { LibraryApiError } from '../../platform/libraryApi';
import { useRepos } from '../../contexts/StorageContext';
import {
  commitPreparedMigration,
  discardPreparedMigration,
  prepareServerPathMigration,
  previewServerPathMigration,
  type PreparedServerPathMigration,
  type ServerPathMigrationPreview,
} from '../../sources/serverPathMigrationAssistant';
import type { MigrationStay } from '../../sources/serverPathMigration';

/** How many of the rows that stay behind are listed by name. */
const STAY_SAMPLE = 8;

type Stage =
  | { name: 'loading' }
  | { name: 'preview'; preview: ServerPathMigrationPreview }
  | { name: 'preparing'; preview: ServerPathMigrationPreview; scan: PhotoLibraryScan | null }
  | { name: 'plan'; prepared: PreparedServerPathMigration }
  | { name: 'working'; prepared: PreparedServerPathMigration }
  | { name: 'done'; moved: number; stayed: number };

/**
 * The confirmed assistant that carries a legacy `server-path` source into an
 * integrated library (Phase 8).
 *
 * It shows the move plan before it writes anything, and the three things the
 * user needs to be sure of are on screen at that moment: how many rows move,
 * how many stay where they are, and that the old source survives untouched.
 */
export function ServerPathMigrationPanel({ sourceId, scanning, onRescanSource, onClose }: {
  /**
   * The source row is looked up here rather than passed in: the settings list
   * hands out a fresh row object whenever any catalog write bumps the source
   * revision - creating the library does exactly that - and an object in the
   * dependency list would restart the assistant mid-run.
   */
  sourceId: string;
  scanning: boolean;
  onRescanSource: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const repos = useRepos();
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  const [error, setError] = useState('');

  const describeError = useCallback((cause: unknown): string => {
    const code = cause instanceof LibraryApiError ? cause.code : null;
    if (code === 'ROOT_NOT_ALLOWED') return t('sources.migrate.errorRootNotAllowed');
    if (code === 'ROOT_UNAVAILABLE' || code === 'ROOT_NOT_DIRECTORY') return t('sources.migrate.errorRootUnavailable');
    if (code === 'ROOT_ALREADY_REGISTERED') return t('sources.migrate.errorRootRegistered');
    if (code === 'ROOT_OVERLAPS_PHOTOLIB_DATA') return t('sources.migrate.errorRootOverlaps');
    return t('sources.migrate.errorGeneric', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    setStage({ name: 'loading' });
    setError('');
    const source = repos.sources.get(sourceId);
    if (!source) {
      setError(t('sources.migrate.errorGeneric', { error: sourceId }));
      return;
    }
    previewServerPathMigration(source, repos)
      .then((preview) => { if (!cancelled) setStage({ name: 'preview', preview }); })
      .catch((cause) => { if (!cancelled) setError(describeError(cause)); });
    return () => { cancelled = true; };
  }, [describeError, repos, sourceId, t]);

  const prepare = async (preview: ServerPathMigrationPreview) => {
    setError('');
    setStage({ name: 'preparing', preview, scan: null });
    try {
      const prepared = await prepareServerPathMigration(preview, repos, (scan) => {
        setStage((current) => current.name === 'preparing' ? { ...current, scan } : current);
      });
      setStage({ name: 'plan', prepared });
    } catch (cause) {
      setError(describeError(cause));
      setStage({ name: 'preview', preview });
    }
  };

  const commit = (prepared: PreparedServerPathMigration) => {
    setError('');
    setStage({ name: 'working', prepared });
    try {
      const moved = commitPreparedMigration(prepared, repos);
      setStage({ name: 'done', moved, stayed: prepared.plan.totals.stays });
      // Everything the plan left unclaimed enters the catalog as a new row,
      // and the moved rows pick up the library's own metadata.
      onRescanSource(prepared.targetSourceId);
    } catch (cause) {
      setError(describeError(cause));
      setStage({ name: 'plan', prepared });
    }
  };

  const discard = async (prepared: PreparedServerPathMigration) => {
    setError('');
    setStage({ name: 'working', prepared });
    try {
      await discardPreparedMigration(prepared);
      onClose();
    } catch (cause) {
      setError(describeError(cause));
      setStage({ name: 'plan', prepared });
    }
  };

  return (
    <div className="settings-source-migration">
      <strong>{t('sources.migrate.title')}</strong>

      {stage.name === 'loading' && !error && (
        <span className="settings-source-migration-note">{t('common.loading')}</span>
      )}

      {stage.name === 'preview' && (
        <>
          <span className="settings-source-migration-note">
            {t('sources.migrate.targetRoot', { root: rootDisplay(stage.preview) })}
          </span>
          <span className="settings-source-migration-note">
            {t('sources.migrate.rowCount', { count: stage.preview.rowCount })}
          </span>
          <span className="settings-source-migration-note">{t('sources.migrate.previewNote')}</span>
          <div className="settings-source-migration-actions">
            <button
              className="settings-btn-sm"
              disabled={scanning}
              onClick={() => void prepare(stage.preview)}
            >
              {t('sources.migrate.start')}
            </button>
            <button className="settings-btn-sm" onClick={onClose}>{t('common.cancel')}</button>
          </div>
        </>
      )}

      {stage.name === 'preparing' && (
        <span className="settings-source-migration-note" role="status">
          {stage.scan
            ? t('sources.migrate.scanProgress', { count: stage.scan.discovered })
            : t('sources.migrate.scanning')}
        </span>
      )}

      {(stage.name === 'plan' || stage.name === 'working') && (
        <MigrationPlanView
          prepared={stage.prepared}
          busy={stage.name === 'working'}
          onConfirm={() => commit(stage.prepared)}
          onDiscard={() => void discard(stage.prepared)}
        />
      )}

      {stage.name === 'done' && (
        <>
          <span className="settings-source-migration-note">
            {t('sources.migrate.done', { moved: stage.moved, stayed: stage.stayed })}
          </span>
          <span className="settings-source-migration-note">{t('sources.migrate.doneHint')}</span>
          <div className="settings-source-migration-actions">
            <button className="settings-btn-sm" onClick={onClose}>{t('common.close')}</button>
          </div>
        </>
      )}

      {error && (
        <>
          <div className="form-error">{error}</div>
          {stage.name === 'loading' && (
            <div className="settings-source-migration-actions">
              <button className="settings-btn-sm" onClick={onClose}>{t('common.close')}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MigrationPlanView({ prepared, busy, onConfirm, onDiscard }: {
  prepared: PreparedServerPathMigration;
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const { totals, stays } = prepared.plan;

  return (
    <>
      <span className="settings-source-migration-note">{t('sources.migrate.planTitle')}</span>
      <ul className="settings-source-migration-plan">
        <li>{t('sources.migrate.planMoves', { count: totals.moves })}</li>
        {totals.matchedBy['content-hash'] > 0 && (
          <li>{t('sources.migrate.planMatchContent', { count: totals.matchedBy['content-hash'] })}</li>
        )}
        {totals.matchedBy['relative-path'] > 0 && (
          <li>{t('sources.migrate.planMatchPath', { count: totals.matchedBy['relative-path'] })}</li>
        )}
        {totals.matchedBy['name-and-size'] > 0 && (
          <li>{t('sources.migrate.planMatchName', { count: totals.matchedBy['name-and-size'] })}</li>
        )}
        <li>{t('sources.migrate.planStays', { count: totals.stays })}</li>
        {totals.stayedBecause['no-match'] > 0 && (
          <li>{t('sources.migrate.stayNoMatch', { count: totals.stayedBecause['no-match'] })}</li>
        )}
        {totals.stayedBecause['ambiguous'] > 0 && (
          <li>{t('sources.migrate.stayAmbiguous', { count: totals.stayedBecause['ambiguous'] })}</li>
        )}
        {totals.stayedBecause['asset-already-claimed'] > 0 && (
          <li>{t('sources.migrate.stayClaimed', { count: totals.stayedBecause['asset-already-claimed'] })}</li>
        )}
        <li>{t('sources.migrate.planNewAssets', { count: totals.unclaimedAssets })}</li>
      </ul>
      {stays.length > 0 && <StaySample stays={stays} />}
      <span className="settings-source-migration-note">{t('sources.migrate.planKeepsData')}</span>
      <div className="settings-source-migration-actions">
        <button className="settings-btn-sm" disabled={busy || totals.moves === 0} onClick={onConfirm}>
          {busy ? t('common.processing') : t('sources.migrate.confirm')}
        </button>
        <button className="settings-btn-sm danger" disabled={busy} onClick={onDiscard}>
          {t('sources.migrate.discard')}
        </button>
      </div>
    </>
  );
}

function StaySample({ stays }: { stays: readonly MigrationStay[] }) {
  const { t } = useTranslation();
  const sample = stays.slice(0, STAY_SAMPLE);
  return (
    <ul className="settings-source-migration-stays">
      {sample.map((stay) => (
        <li key={stay.photoId} title={stay.sourcePhotoId}>
          {stay.name} — {t(`sources.migrate.reason.${stay.reason}`)}
        </li>
      ))}
      {stays.length > sample.length && (
        <li>{t('sources.migrate.staysMore', { count: stays.length - sample.length })}</li>
      )}
    </ul>
  );
}

function rootDisplay(preview: ServerPathMigrationPreview): string {
  return [preview.rootLabel, preview.relativePath].filter(Boolean).join('/');
}
