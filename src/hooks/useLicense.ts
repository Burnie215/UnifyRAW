import { useState, useEffect, useCallback } from 'react';
import {
  validateLicense,
  loadStoredLicense,
  storeLicense,
  clearLicense,
  getFeatureGate,
  isSelfHosted,
  type LicenseStatus,
  type FeatureGate,
} from '../engine/License';

/**
 * Manages license state — validation, activation, feature gating.
 */
export function useLicense() {
  const [status, setStatus] = useState<LicenseStatus>({
    valid: false, info: null, error: null, updatesActive: false, updatesDaysLeft: -1,
  });
  const [loading, setLoading] = useState(true);
  const selfHosted = isSelfHosted();

  // Validate stored license on mount
  useEffect(() => {
    (async () => {
      const stored = loadStoredLicense();
      if (stored) {
        const result = await validateLicense(stored);
        setStatus(result);
      }
      setLoading(false);
    })();
  }, []);

  /** Activate a new license key */
  const activate = useCallback(async (key: string): Promise<LicenseStatus> => {
    const result = await validateLicense(key);
    if (result.valid) {
      storeLicense(key);
    }
    setStatus(result);
    return result;
  }, []);

  /** Deactivate current license */
  const deactivate = useCallback(() => {
    clearLicense();
    setStatus({ valid: false, info: null, error: null, updatesActive: false, updatesDaysLeft: -1 });
  }, []);

  const features: FeatureGate = getFeatureGate(status);

  return {
    status,
    features,
    loading,
    selfHosted,
    activate,
    deactivate,
  };
}
