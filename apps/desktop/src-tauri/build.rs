fn main() {
    println!("cargo:rerun-if-env-changed=KITTIES_DESKTOP_APPLICATION");
    println!("cargo:rerun-if-env-changed=KITTIES_DESKTOP_ISSUER");
    // Enumerate every application command so Tauri enforces custom-command ACLs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_device_preferences",
            "write_device_preferences",
            "native_access_configuration",
            "begin_native_authentication",
            "finish_native_authentication",
            "cancel_native_authentication",
        ]),
    ))
    .expect("Tauri build failed");
}
