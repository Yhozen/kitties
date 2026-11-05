fn main() {
    println!("cargo:rerun-if-env-changed=KITTIES_DESKTOP_APPLICATION");
    println!("cargo:rerun-if-env-changed=KITTIES_DESKTOP_ISSUER");
    // Enumerate every application command so Tauri enforces custom-command ACLs.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "read_device_preferences",
                "write_device_preferences",
                "native_access_configuration",
                "begin_native_authentication",
                "finish_native_authentication",
                "cancel_native_authentication",
            ])),
    )
    .expect("Tauri build failed");

    // Tauri's default resource links only binaries. Tests also import the v6
    // Common Controls APIs, so link this manifest exactly once into every target.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=windows-manifest.rc");
        println!("cargo:rerun-if-changed=windows-app.manifest");
        embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("Windows application manifest failed");
    }
}
