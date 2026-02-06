import { AppConfig, ALL_ALERT_TYPES, DEFAULT_CONFIG, DEFAULT_THRESHOLDS } from './types';

const STORAGE_KEY = 'chessbased-config';

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        alertThresholds: { ...DEFAULT_THRESHOLDS, ...parsed.alertThresholds },
      };

      // Migrate old showAlertBanners boolean → enabledAlerts array
      if (!parsed.enabledAlerts && 'showAlertBanners' in parsed) {
        config.enabledAlerts = parsed.showAlertBanners ? [...ALL_ALERT_TYPES] : [];
      }

      return config;
    }
  } catch {
    // ignore corrupted data
  }
  return { ...DEFAULT_CONFIG, alertThresholds: { ...DEFAULT_THRESHOLDS } };
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
