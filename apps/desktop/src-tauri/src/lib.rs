mod native_access;
mod preferences;

fn preferences_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(native_access::NativeAccessState::default())
        .setup(|app| {
            native_access::configure(app)?;
            Ok(())
        })
        .manage(preferences::PreferencesGate::default())
        .invoke_handler(tauri::generate_handler![
            preferences::read_device_preferences,
            preferences::write_device_preferences,
            native_access::native_access_configuration,
            native_access::begin_native_authentication,
            native_access::finish_native_authentication,
            native_access::cancel_native_authentication,
        ])
}

pub fn run() {
    preferences_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("Kitties desktop runtime failed");
}

#[cfg(test)]
mod host_tests;
