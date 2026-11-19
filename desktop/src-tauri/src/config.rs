use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_schema")]
    pub schema: u32,
    #[serde(default)]
    pub last_page: usize,
    #[serde(default = "default_nav_version")]
    pub navigation_version: Option<u32>,
    #[serde(default)]
    pub quota_refresh_minutes: u32,
    #[serde(default = "default_true")]
    pub hud_enabled: bool,
    #[serde(default = "default_true")]
    pub translation_enabled: bool,
    #[serde(default)]
    pub auto_pricing_sync_enabled: bool,
    #[serde(default)]
    pub sync_antigravity_lifecycle: bool,
    #[serde(default)]
    pub auto_update_enabled: bool,
    #[serde(default)]
    pub last_cleaned_version: String,
    #[serde(default)]
    pub accounts_collapsed: bool,
    #[serde(default)]
    pub menu_selected_tab: usize,
    #[serde(default)]
    pub menu_usage_period: usize,
    #[serde(default = "default_trend_metric")]
    pub menu_trend_metric: String,
    #[serde(default = "default_channel")]
    pub application_channel: String,
    #[serde(default)]
    pub app_language: Option<String>,
}

fn default_schema() -> u32 {
    2
}
fn default_nav_version() -> Option<u32> {
    Some(5)
}
fn default_true() -> bool {
    true
}
fn default_trend_metric() -> String {
    "tokens".to_string()
}
fn default_channel() -> String {
    "stable".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema: 2,
            last_page: 0,
            navigation_version: Some(5),
            quota_refresh_minutes: 0,
            hud_enabled: true,
            translation_enabled: true,
            auto_pricing_sync_enabled: false,
            sync_antigravity_lifecycle: false,
            auto_update_enabled: false,
            last_cleaned_version: String::new(),
            accounts_collapsed: false,
            menu_selected_tab: 0,
            menu_usage_period: 0,
            menu_trend_metric: "tokens".to_string(),
            application_channel: "stable".to_string(),
            app_language: None,
        }
    }
}

pub fn load_config(state_dir: &Path) -> Result<AppConfig, String> {
    let path = state_dir.join("config.json");
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
    let mut cfg: AppConfig =
        serde_json::from_str(&raw).map_err(|e| format!("Corrupted config.json: {}", e))?;
    cfg.application_channel = "stable".to_string();
    cfg.last_page = cfg.last_page.min(4);
    cfg.menu_selected_tab = cfg.menu_selected_tab.min(2);
    cfg.menu_usage_period = cfg.menu_usage_period.min(3);
    Ok(cfg)
}

pub fn merge_config_document(existing_raw: Option<&str>, cfg: &AppConfig) -> Result<String, String> {
    let mut doc: Map<String, Value> = existing_raw
        .and_then(|s| serde_json::from_str::<Map<String, Value>>(s).ok())
        .unwrap_or_default();

    let known = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    if let Value::Object(map) = known {
        for (k, v) in map {
            doc.insert(k, v);
        }
    }
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

pub fn save_config(state_dir: &Path, mut cfg: AppConfig) -> Result<AppConfig, String> {
    fs::create_dir_all(state_dir).map_err(|e| e.to_string())?;
    cfg.schema = 2;
    cfg.application_channel = "stable".to_string();
    if cfg.menu_trend_metric != "requests" {
        cfg.menu_trend_metric = "tokens".to_string();
    }
    let path = state_dir.join("config.json");
    let existing = fs::read_to_string(&path).ok();
    let serialized = merge_config_document(existing.as_deref(), &cfg)?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = state_dir.join(format!("config-{}-{}.tmp", std::process::id(), seq));
    fs::write(&tmp, serialized.as_bytes()).map_err(|e| e.to_string())?;
    let mut last_err = None;
    for attempt in 0..3 {
        match fs::rename(&tmp, &path) {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt < 2 {
                    thread::sleep(Duration::from_millis(15));
                }
            }
        }
    }
    if let Some(err) = last_err {
        return Err(err.to_string());
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_config_preserves_unknown_fields() {
        let mut cfg = AppConfig::default();
        cfg.last_page = 2;
        cfg.quota_refresh_minutes = 15;
        let out = merge_config_document(Some(r#"{"schema":2,"customExternalFlag":true}"#), &cfg).unwrap();
        let raw: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(raw["customExternalFlag"], Value::Bool(true));
        assert_eq!(raw["lastPage"], serde_json::json!(2));
        assert_eq!(raw["quotaRefreshMinutes"], serde_json::json!(15));
    }

    #[test]
    fn translation_enabled_defaults_to_true_and_roundtrips_false() {
        let legacy: AppConfig = serde_json::from_str(r#"{"schema":2,"hudEnabled":true}"#).unwrap();
        assert!(legacy.translation_enabled);

        let mut cfg = AppConfig::default();
        cfg.translation_enabled = false;
        let out = merge_config_document(None, &cfg).unwrap();
        let parsed: AppConfig = serde_json::from_str(&out).unwrap();
        assert!(!parsed.translation_enabled);
    }
}
