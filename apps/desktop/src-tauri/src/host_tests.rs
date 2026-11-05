use serde_json::{Value, json};
use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder, test::MockRuntime};

fn fixture(name: &str) -> (tauri::App<MockRuntime>, std::path::PathBuf) {
    let directory =
        std::env::temp_dir().join(format!("kitties-host-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    // Use the real generated command manifest and capability, never an allow-all test ACL.
    // The official test flag omits runtime plist embedding on macOS.
    let mut context = tauri::generate_context!(test = true);
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(directory.clone()),
    );
    let app = super::preferences_builder(tauri::test::mock_builder())
        .build(context)
        .unwrap();
    (app, directory)
}

fn window(app: &tauri::App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("library.html".into()))
        .build()
        .unwrap()
}

fn local_origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/library.html"
    } else {
        "tauri://localhost/library.html"
    }
}

fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    origin: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: origin.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn generated_host_acl_allows_main_preferences_and_acknowledges_disk_before_ipc_success() {
    let (app, directory) = fixture("ipc-roundtrip");
    let main = window(&app, "main");
    let file = directory.join("device-preferences.v1.json");
    assert_eq!(
        invoke(&main, "read_device_preferences", local_origin(), json!({})).unwrap(),
        json!({"status":"absent"})
    );
    assert!(!file.exists());
    assert_eq!(
        invoke(
            &main,
            "write_device_preferences",
            local_origin(),
            json!({"preferences":{"version":1,"language":"es","theme":"dark"}}),
        )
        .unwrap(),
        json!({"status":"saved"})
    );
    let disk: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        disk,
        json!({"preferences":{"version":1,"language":"es","theme":"dark"}})
    );
    assert_eq!(
        invoke(&main, "read_device_preferences", local_origin(), json!({})).unwrap(),
        json!({"status":"found","preferences":{"version":1,"language":"es","theme":"dark"}})
    );
    assert_eq!(
        invoke(
            &main,
            "write_device_preferences",
            local_origin(),
            json!({"preferences":{"version":1,"language":"es","theme":"dark","extra":true}}),
        )
        .unwrap(),
        json!({"status":"failed","reason":"invalid-data"})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap(),
        disk
    );
    drop(main);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn generated_host_acl_denies_remote_ungranted_window_and_arbitrary_store_api() {
    let (app, directory) = fixture("ipc-denial");
    let main = window(&app, "main");
    let other = window(&app, "ungranted");
    for (webview, command, origin, body) in [
        (&other, "read_device_preferences", local_origin(), json!({})),
        (
            &main,
            "write_device_preferences",
            "https://example.invalid/library.html",
            json!({"preferences":{"version":1,"language":"en","theme":"light"}}),
        ),
        (
            &main,
            "plugin:store|load",
            local_origin(),
            json!({"path":directory.join("arbitrary.json").to_str().unwrap()}),
        ),
    ] {
        let denial = invoke(webview, command, origin, body).unwrap_err();
        assert!(denial.as_str().unwrap().contains("not allowed"), "{denial}");
    }
    assert!(!directory.join("device-preferences.v1.json").exists());
    assert!(!directory.join("arbitrary.json").exists());
    drop(other);
    drop(main);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn native_configuration_without_compiled_origins_fails_closed_and_remote_auth_is_denied() {
    let (app, directory) = fixture("native-configuration");
    let main = window(&app, "main");
    let other = window(&app, "ungranted");
    if option_env!("KITTIES_DESKTOP_APPLICATION").is_none()
        || option_env!("KITTIES_DESKTOP_ISSUER").is_none()
    {
        assert_eq!(
            invoke(
                &main,
                "native_access_configuration",
                local_origin(),
                json!({})
            )
            .unwrap_err(),
            json!({"reason":"Configuration"})
        );
        assert_eq!(
            invoke(
                &main,
                "begin_native_authentication",
                local_origin(),
                json!({})
            )
            .unwrap_err(),
            json!({"reason":"Configuration"})
        );
    }
    for (webview, command, origin, body) in [
        (
            &other,
            "begin_native_authentication",
            local_origin(),
            json!({}),
        ),
        (
            &main,
            "begin_native_authentication",
            "https://app.example/library.html",
            json!({}),
        ),
        (
            &main,
            "plugin:opener|open_url",
            local_origin(),
            json!({"url":"https://attacker.example"}),
        ),
    ] {
        assert!(
            invoke(webview, command, origin, body)
                .unwrap_err()
                .as_str()
                .unwrap()
                .contains("not allowed")
        );
    }
    drop(other);
    drop(main);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn official_http_plugin_acl_allows_exact_paths_but_denies_query_fragment_and_origin_substitution() {
    use tauri::Manager;
    let (app, directory) = fixture("native-http-acl");
    let config = super::native_access::AccessConfiguration::new(
        "https://app.example",
        "https://access.example",
    )
    .unwrap();
    app.add_capability(super::native_access::http_capability(&config))
        .unwrap();
    let main = window(&app, "main");
    let other = window(&app, "ungranted");
    let body = |url: &str| json!({"clientConfig":{"method":"POST","url":url,"headers":[],"data":null,"maxRedirections":0,"connectTimeout":1000}});
    // fetch only creates the request; fetch_send is never called, so no network leaves this test.
    for path in ["/v1/library/session", "/v1/library/rpc", "/v1/library/rpc/"] {
        let resource = invoke(
            &main,
            "plugin:http|fetch",
            local_origin(),
            body(&format!("https://app.example{path}")),
        )
        .unwrap();
        assert!(resource.is_u64());
        invoke(
            &main,
            "plugin:http|fetch_cancel",
            local_origin(),
            json!({"rid":resource}),
        )
        .unwrap();
    }
    for url in [
        "https://other.example/v1/library/rpc",
        "https://app.example/v1/library/rpc/descendant",
        "https://app.example/v1/library/rpc//",
        "https://app.example/v1/library/rpc?token=secret",
        "https://app.example/v1/library/rpc/?x",
        "https://app.example/v1/library/session?x",
        "https://app.example/v1/library/rpc#fragment",
        "http://app.example/v1/library/rpc",
    ] {
        assert!(
            invoke(&main, "plugin:http|fetch", local_origin(), body(url)).is_err(),
            "must deny {url}"
        );
    }
    for (webview, origin) in [
        (&other, local_origin()),
        (&main, "https://app.example/library.html"),
    ] {
        assert!(
            invoke(
                webview,
                "plugin:http|fetch",
                origin,
                body("https://app.example/v1/library/rpc")
            )
            .is_err()
        );
    }
    drop(other);
    drop(main);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn official_http_ipc_streams_ndjson_and_refuses_redirect_with_no_cookie_replay() {
    use std::io::{BufRead, BufReader, Write};
    use tauri::{Manager, ipc::CapabilityBuilder};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    // A loopback HTTP permission exists only in this test's mock authority, never release config.
    let (app, directory) = fixture("native-http-wire");
    app.add_capability(
        CapabilityBuilder::new("loopback-http-test")
            .window("main")
            .permission_scoped(
                "http:default",
                vec![json!({"url":format!("http://127.0.0.1:{port}/v1/library/rpc/")})],
                Vec::<Value>::new(),
            ),
    )
    .unwrap();
    let main = window(&app, "main");
    let server = std::thread::spawn(move || {
        for index in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            assert!(request.starts_with("POST /v1/library/rpc/ HTTP/1.1\r\n"));
            assert!(!request.to_ascii_lowercase().contains("cookie:"));
            let response = if index == 0 {
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: 16\r\nSet-Cookie: session=must-not-persist\r\nConnection: close\r\n\r\n{\"n\":1}\n{\"n\":2}\n".to_owned()
            } else {
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
            };
            socket.write_all(response.as_bytes()).unwrap();
        }
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    });
    for index in 0..2 {
        let resource = invoke(&main, "plugin:http|fetch", local_origin(), json!({"clientConfig":{"method":"POST","url":format!("http://127.0.0.1:{port}/v1/library/rpc/"),"headers":[],"data":null,"maxRedirections":0,"connectTimeout":1000}})).unwrap();
        let response = invoke(
            &main,
            "plugin:http|fetch_send",
            local_origin(),
            json!({"rid":resource}),
        )
        .unwrap();
        assert_eq!(response["status"], if index == 0 { 200 } else { 302 });
        if index == 0 {
            let mut bytes = Vec::new();
            loop {
                let raw = invoke(
                    &main,
                    "plugin:http|fetch_read_body",
                    local_origin(),
                    json!({"rid":response["rid"]}),
                )
                .unwrap();
                let chunk: Vec<u8> = serde_json::from_value(raw).unwrap();
                bytes.extend_from_slice(&chunk[..chunk.len() - 1]);
                if chunk.last() == Some(&1) {
                    break;
                }
            }
            assert_eq!(bytes, b"{\"n\":1}\n{\"n\":2}\n");
        } else {
            invoke(
                &main,
                "plugin:http|fetch_cancel_body",
                local_origin(),
                json!({"rid":response["rid"]}),
            )
            .unwrap();
        }
    }
    server.join().unwrap();
    drop(main);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn official_http_ipc_cancellation_refuses_late_success_and_consumes_the_request_resource() {
    use std::io::{BufRead, BufReader};
    use tauri::{Manager, ipc::CapabilityBuilder};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (app, directory) = fixture("native-http-cancel");
    app.add_capability(
        CapabilityBuilder::new("loopback-cancel-test")
            .window("main")
            .permission_scoped(
                "http:default",
                vec![json!({"url":format!("http://127.0.0.1:{port}/v1/library/rpc/")})],
                Vec::<Value>::new(),
            ),
    )
    .unwrap();
    let main = window(&app, "main");
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        entered_tx.send(()).unwrap();
        release_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
    });
    let resource = invoke(&main, "plugin:http|fetch", local_origin(), json!({"clientConfig":{"method":"POST","url":format!("http://127.0.0.1:{port}/v1/library/rpc/"),"headers":[],"data":null,"maxRedirections":0,"connectTimeout":1000}})).unwrap();
    let sending_window = main.clone();
    let sending_resource = resource.clone();
    let sender = std::thread::spawn(move || {
        invoke(
            &sending_window,
            "plugin:http|fetch_send",
            local_origin(),
            json!({"rid":sending_resource}),
        )
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    invoke(
        &main,
        "plugin:http|fetch_cancel",
        local_origin(),
        json!({"rid":resource}),
    )
    .unwrap();
    // Cancellation must settle fetch_send while the fixture still withholds all response headers.
    let failure = sender.join().unwrap().unwrap_err();
    assert!(failure.as_str().unwrap().to_lowercase().contains("cancel"));
    assert!(
        invoke(
            &main,
            "plugin:http|fetch_send",
            local_origin(),
            json!({"rid":resource})
        )
        .is_err()
    );
    release_tx.send(()).unwrap();
    server.join().unwrap();
    drop(main);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
}
