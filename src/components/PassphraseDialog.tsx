import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './PassphraseDialog.css';

export interface PassphraseRequest {
  title: string;
  /** Optional explanatory text. */
  description?: string;
  /** True = ask for the passphrase twice (used when setting/changing it). */
  confirm?: boolean;
  /** Minimum length the user has to enter. Defaults to 1. */
  minLength?: number;
  /** Resolve with the passphrase the user typed, or null on cancel. */
  resolve: (value: string | null) => void;
}

interface Props {
  request: PassphraseRequest | null;
}

export function PassphraseDialog({ request }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (request) {
      setValue('');
      setConfirmValue('');
      setError(null);
    }
  }, [request]);

  if (!request) return null;

  const minLength = request.minLength ?? 1;

  const submit = () => {
    if (value.length < minLength) {
      setError(t('dialogs.passphrase.minLength', { minLength }));
      return;
    }
    if (request.confirm && value !== confirmValue) {
      setError(t('dialogs.passphrase.noMatch'));
      return;
    }
    request.resolve(value);
  };

  const cancel = () => request.resolve(null);

  return (
    <div className="passphrase-overlay" onClick={cancel}>
      <div className="passphrase-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{request.title}</h2>
        {request.description && <p className="passphrase-desc">{request.description}</p>}

        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          autoComplete="off"
        >
          <input
            type="password"
            className="passphrase-input"
            placeholder={t('dialogs.passphrase.placeholder')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          {request.confirm && (
            <input
              type="password"
              className="passphrase-input"
              placeholder={t('dialogs.passphrase.placeholderRepeat')}
              value={confirmValue}
              onChange={(e) => setConfirmValue(e.target.value)}
            />
          )}

          {error && <div className="passphrase-error">{error}</div>}

          <div className="passphrase-actions">
            <button type="button" className="passphrase-btn" onClick={cancel}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="passphrase-btn primary" disabled={value.length < minLength}>
              {request.confirm ? t('dialogs.passphrase.set') : t('dialogs.passphrase.unlock')}
            </button>
          </div>
        </form>

        {request.confirm && (
          <p className="passphrase-warn">
            {t('dialogs.passphrase.forgottenWarn')}
          </p>
        )}
      </div>
    </div>
  );
}
