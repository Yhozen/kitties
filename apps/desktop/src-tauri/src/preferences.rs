use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::ErrorKind,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_store::{Store, StoreExt};

const STORE_FILE: &str = "device-preferences.v1.json";
const STORE_KEY: &str = "preferences";
const MAX_STORE_BYTES: usize = 512;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Es,
    Pt,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DevicePreferences {
    version: u8,
    language: Language,
    theme: Theme,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPreferences {
    preferences: DevicePreferences,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreferencesFailure {
    InvalidData,
    Unavailable,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ReadPreferencesReply {
    Absent,
    Found { preferences: DevicePreferences },
    Failed { reason: PreferencesFailure },
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum WritePreferencesReply {
    Saved,
    Failed { reason: PreferencesFailure },
}

#[derive(Clone, Default)]
pub struct PreferencesGate(Arc<Mutex<()>>);

fn validate_preferences(
    preferences: DevicePreferences,
) -> Result<DevicePreferences, PreferencesFailure> {
    if preferences.version != 1 {
        return Err(PreferencesFailure::InvalidData);
    }
    Ok(preferences)
}

// The Store file is dedicated to preferences; unknown keys and versions fail closed.
fn deserialize_preferences(
    bytes: &[u8],
) -> Result<HashMap<String, Value>, Box<dyn std::error::Error + Send + Sync>> {
    if bytes.len() > MAX_STORE_BYTES {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "invalid preferences").into());
    }
    let persisted: PersistedPreferences = serde_json::from_slice(bytes)?;
    let preferences = validate_preferences(persisted.preferences)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidData, "invalid preferences"))?;
    Ok(HashMap::from([(
        STORE_KEY.to_owned(),
        serde_json::to_value(preferences)?,
    )]))
}

// Always unregister: Store2.5.0 otherwise saves even failed/never-written stores on app exit.
struct OpenPreferences<R: Runtime>(Arc<Store<R>>);
impl<R: Runtime> Drop for OpenPreferences<R> {
    fn drop(&mut self) {
        self.0.close_resource();
    }
}

fn open_preferences<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(OpenPreferences<R>, Option<DevicePreferences>), PreferencesFailure> {
    let store = OpenPreferences(
        app.store_builder(STORE_FILE)
            .disable_auto_save()
            .deserialize(deserialize_preferences)
            .build()
            .map_err(|_| PreferencesFailure::Unavailable)?,
    );
    // Builder deliberately ignores its initial load error; this checked reload is required.
    match store.0.reload_ignore_defaults() {
        Ok(()) => {}
        Err(tauri_plugin_store::Error::Io(error)) if error.kind() == ErrorKind::NotFound => {
            return Ok((store, None));
        }
        Err(tauri_plugin_store::Error::Deserialize(_) | tauri_plugin_store::Error::Json(_)) => {
            return Err(PreferencesFailure::InvalidData);
        }
        Err(_) => return Err(PreferencesFailure::Unavailable),
    }
    let value = store
        .0
        .get(STORE_KEY)
        .ok_or(PreferencesFailure::InvalidData)?;
    let preferences = serde_json::from_value(value).map_err(|_| PreferencesFailure::InvalidData)?;
    Ok((store, Some(validate_preferences(preferences)?)))
}

fn read_preferences<R: Runtime>(
    app: &AppHandle<R>,
    gate: &PreferencesGate,
) -> ReadPreferencesReply {
    let Ok(_guard) = gate.0.lock() else {
        return ReadPreferencesReply::Failed {
            reason: PreferencesFailure::Unavailable,
        };
    };
    match open_preferences(app) {
        Ok((_store, None)) => ReadPreferencesReply::Absent,
        Ok((_store, Some(preferences))) => ReadPreferencesReply::Found { preferences },
        Err(reason) => ReadPreferencesReply::Failed { reason },
    }
}

fn write_preferences<R: Runtime>(
    app: &AppHandle<R>,
    gate: &PreferencesGate,
    value: Value,
) -> WritePreferencesReply {
    let result = (|| {
        // IPC arguments are untrusted even when called through our typed JS adapter.
        let preferences = validate_preferences(
            serde_json::from_value(value).map_err(|_| PreferencesFailure::InvalidData)?,
        )?;
        let _guard = gate.0.lock().map_err(|_| PreferencesFailure::Unavailable)?;
        // A corrupt existing record is an error, never silently replaced with defaults.
        let (store, _) = open_preferences(app)?;
        store.0.set(
            STORE_KEY,
            serde_json::to_value(preferences).map_err(|_| PreferencesFailure::InvalidData)?,
        );
        store
            .0
            .save()
            .map_err(|_| PreferencesFailure::Unavailable)?;
        Ok::<(), PreferencesFailure>(())
    })();
    match result {
        Ok(()) => WritePreferencesReply::Saved,
        Err(reason) => WritePreferencesReply::Failed { reason },
    }
}

#[tauri::command]
pub async fn read_device_preferences<R: Runtime>(
    app: AppHandle<R>,
    gate: State<'_, PreferencesGate>,
) -> Result<ReadPreferencesReply, PreferencesFailure> {
    let gate = gate.inner().clone();
    tauri::async_runtime::spawn_blocking(move || read_preferences(&app, &gate))
        .await
        .map_err(|_| PreferencesFailure::Unavailable)
}

#[tauri::command]
pub async fn write_device_preferences<R: Runtime>(
    app: AppHandle<R>,
    gate: State<'_, PreferencesGate>,
    preferences: Value,
) -> Result<WritePreferencesReply, PreferencesFailure> {
    let gate = gate.inner().clone();
    tauri::async_runtime::spawn_blocking(move || write_preferences(&app, &gate, preferences))
        .await
        .map_err(|_| PreferencesFailure::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_accepts_current_language_theme_and_preserves_wire_shape() {
        let values = deserialize_preferences(
            br#"{"preferences":{"version":1,"language":"pt","theme":"light"}}"#,
        )
        .unwrap();
        assert_eq!(
            values[STORE_KEY],
            serde_json::json!({"version":1,"language":"pt","theme":"light"})
        );
        assert_eq!(
            serde_json::to_value(ReadPreferencesReply::Absent).unwrap(),
            serde_json::json!({"status":"absent"})
        );
        assert_eq!(
            serde_json::to_value(WritePreferencesReply::Saved).unwrap(),
            serde_json::json!({"status":"saved"})
        );
        assert_eq!(
            serde_json::to_value(ReadPreferencesReply::Failed {
                reason: PreferencesFailure::InvalidData
            })
            .unwrap(),
            serde_json::json!({"status":"failed","reason":"invalid-data"})
        );
    }

    #[test]
    fn codec_rejects_corruption_unknown_data_and_oversize() {
        for raw in [
            "{",
            "{}",
            r#"{"preferences":{"version":2,"language":"en","theme":"dark"}}"#,
            r#"{"preferences":{"version":1,"language":"fr","theme":"dark"}}"#,
            r#"{"preferences":{"version":1,"language":"en","theme":"night"}}"#,
            r#"{"preferences":{"version":1,"language":"en","theme":"dark","token":"forbidden"}}"#,
            r#"{"preferences":{"version":1,"language":"en","theme":"dark"},"other":true}"#,
        ] {
            assert!(
                deserialize_preferences(raw.as_bytes()).is_err(),
                "accepted {raw}"
            );
        }
        let record = r#"{"preferences":{"version":1,"language":"en","theme":"dark"}}"#;
        let boundary = format!("{}{}", " ".repeat(MAX_STORE_BYTES - record.len()), record);
        assert!(deserialize_preferences(boundary.as_bytes()).is_ok());
        assert!(deserialize_preferences(format!(" {boundary}").as_bytes()).is_err());
    }
    // Real Store/filesystem tests with Tauri's official in-process MockRuntime.
    // They do not claim packaged IPC/ACL or actual WebKit verification.
    fn fixture(name: &str) -> (tauri::App<tauri::test::MockRuntime>, std::path::PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("kitties-device-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        (app_at(&directory), directory)
    }

    fn app_at(directory: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = "test.kitties.device-preferences".into();
        context.config_mut().app.app_directories_override = Some(
            tauri::utils::config::AppDirectoriesOverride::Root(directory.to_owned()),
        );
        tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(context)
            .unwrap()
    }

    #[test]
    fn real_store_acknowledges_saved_bytes_and_fresh_app_round_trip() {
        let (app, directory) = fixture("roundtrip");
        let gate = PreferencesGate::default();
        let file = directory.join(STORE_FILE);
        assert_eq!(
            read_preferences(app.handle(), &gate),
            ReadPreferencesReply::Absent
        );
        assert!(!file.exists());
        assert!(app.get_store(STORE_FILE).is_none());
        assert_eq!(
            write_preferences(
                app.handle(),
                &gate,
                serde_json::json!({"version":1,"language":"es","theme":"system"})
            ),
            WritePreferencesReply::Saved
        );
        // Independent persisted bytes, before constructing a fresh Store or returning to the UI.
        let persisted: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            persisted,
            serde_json::json!({"preferences":{"version":1,"language":"es","theme":"system"}})
        );
        assert!(app.get_store(STORE_FILE).is_none());
        drop(app);
        let restarted = app_at(&directory);
        assert_eq!(
            read_preferences(restarted.handle(), &gate),
            ReadPreferencesReply::Found {
                preferences: DevicePreferences {
                    version: 1,
                    language: Language::Es,
                    theme: Theme::System
                }
            }
        );
        assert!(restarted.get_store(STORE_FILE).is_none());
        drop(restarted);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn real_store_corruption_and_invalid_input_never_overwrite_or_leave_exit_save_resource() {
        let (app, directory) = fixture("corruption");
        let gate = PreferencesGate::default();
        let file = directory.join(STORE_FILE);
        std::fs::write(&file, b"{broken").unwrap();
        assert_eq!(
            read_preferences(app.handle(), &gate),
            ReadPreferencesReply::Failed {
                reason: PreferencesFailure::InvalidData
            }
        );
        assert!(app.get_store(STORE_FILE).is_none());
        assert_eq!(
            write_preferences(
                app.handle(),
                &gate,
                serde_json::json!({"version":1,"language":"en","theme":"dark"})
            ),
            WritePreferencesReply::Failed {
                reason: PreferencesFailure::InvalidData
            }
        );
        assert!(app.get_store(STORE_FILE).is_none());
        assert_eq!(std::fs::read(&file).unwrap(), b"{broken");
        assert_eq!(
            write_preferences(
                app.handle(),
                &gate,
                serde_json::json!({"version":1,"language":"en","theme":"dark","token":"forbidden"})
            ),
            WritePreferencesReply::Failed {
                reason: PreferencesFailure::InvalidData
            }
        );
        drop(app);
        assert_eq!(std::fs::read(&file).unwrap(), b"{broken");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn real_store_io_failure_is_typed_and_does_not_report_saved() {
        let (app, directory) = fixture("io-error");
        let gate = PreferencesGate::default();
        let file = directory.join(STORE_FILE);
        std::fs::create_dir(&file).unwrap();
        assert_eq!(
            read_preferences(app.handle(), &gate),
            ReadPreferencesReply::Failed {
                reason: PreferencesFailure::Unavailable
            }
        );
        assert_eq!(
            write_preferences(
                app.handle(),
                &gate,
                serde_json::json!({"version":1,"language":"en","theme":"dark"})
            ),
            WritePreferencesReply::Failed {
                reason: PreferencesFailure::Unavailable
            }
        );
        assert!(app.get_store(STORE_FILE).is_none());
        assert!(file.is_dir());
        drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn real_store_failed_save_keeps_old_disk_record_and_discards_unsaved_cache() {
        use std::os::unix::fs::PermissionsExt;
        let (app, directory) = fixture("save-denied");
        let gate = PreferencesGate::default();
        let file = directory.join(STORE_FILE);
        assert_eq!(
            write_preferences(
                app.handle(),
                &gate,
                serde_json::json!({"version":1,"language":"en","theme":"dark"})
            ),
            WritePreferencesReply::Saved
        );
        let original = std::fs::read(&file).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o444)).unwrap();
        // Run as an ordinary user: the existing Store reload succeeds but explicit save is denied.
        assert_eq!(
            write_preferences(
                app.handle(),
                &gate,
                serde_json::json!({"version":1,"language":"pt","theme":"light"})
            ),
            WritePreferencesReply::Failed {
                reason: PreferencesFailure::Unavailable
            }
        );
        assert_eq!(std::fs::read(&file).unwrap(), original);
        assert!(app.get_store(STORE_FILE).is_none());
        assert_eq!(
            read_preferences(app.handle(), &gate),
            ReadPreferencesReply::Found {
                preferences: DevicePreferences {
                    version: 1,
                    language: Language::En,
                    theme: Theme::Dark
                }
            }
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        drop(app);
        assert_eq!(std::fs::read(&file).unwrap(), original);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
