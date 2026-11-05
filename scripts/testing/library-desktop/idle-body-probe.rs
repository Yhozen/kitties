//! Application-owned strict plugin gate; inject only into an isolated copy of the desktop crate.
//! See idle-body-probe.md. Stock tauri-plugin-http 2.8.3 must fail the two pending-read cases.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    sync::{
        Arc, Weak,
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};
use tauri::{
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    ipc::{CapabilityBuilder, InvokeResponse},
    test::MockRuntime,
};

const DEADLINE: Duration = Duration::from_secs(5);
const PROMPT_BOUND: Duration = Duration::from_millis(300);

fn local_origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/library.html"
    } else {
        "tauri://localhost/library.html"
    }
}

fn fixture(name: &str) -> (tauri::App<MockRuntime>, std::path::PathBuf) {
    let directory =
        std::env::temp_dir().join(format!("kitties-idle-body-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    // Real application builder and generated ACL; only the test loopback grant is added below.
    let mut context = tauri::generate_context!();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(directory.clone()),
    );
    let app = super::preferences_builder(tauri::test::mock_builder())
        .build(context)
        .unwrap();
    (app, directory)
}

fn invoke_async(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
) -> Receiver<Result<Value, Value>> {
    let (tx, rx) = mpsc::sync_channel(1);
    let view: &tauri::Webview<MockRuntime> = window.as_ref();
    view.clone().on_message(
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_origin().parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
        Box::new(move |_, _, response, _, _| {
            let value = match response {
                InvokeResponse::Ok(body) => Ok(body.deserialize::<Value>().unwrap()),
                InvokeResponse::Err(error) => Err(error.0),
            };
            tx.send(value).unwrap();
        }),
    );
    rx
}

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, body: Value) -> Result<Value, Value> {
    invoke_async(window, command, body)
        .recv_timeout(DEADLINE)
        .expect("IPC deadline")
}

fn observe_socket(socket: &mut TcpStream, deadline: Duration) -> String {
    socket.set_read_timeout(Some(deadline)).unwrap();
    let mut byte = [0; 1];
    match socket.read(&mut byte) {
        Ok(0) => "eof".into(),
        Ok(n) => format!("unexpected-request-data:{n}"),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            "open-idle-deadline".into()
        }
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {
            "connection-reset".into()
        }
        Err(error) => panic!("unexpected socket failure: {error}"),
    }
}

enum ServerStep {
    Inspect,
    Chunk,
    Eof,
    Finish,
}

fn run_case(name: &str, pending_read: bool, release_eof: bool) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (app, directory) = fixture(name);
    app.add_capability(
        CapabilityBuilder::new(format!("loopback-cancel-probe-{name}"))
            .window("main")
            .permission_scoped(
                "http:default",
                vec![json!({"url":format!("http://127.0.0.1:{port}/v1/library/rpc/")})],
                Vec::<Value>::new(),
            ),
    )
    .unwrap();
    let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("library.html".into()))
        .build()
        .unwrap();
    let (step_tx, step_rx) = mpsc::sync_channel(1);
    let (event_tx, event_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(DEADLINE)).unwrap();
        let mut request = BufReader::new(socket.try_clone().unwrap());
        let mut first = String::new();
        request.read_line(&mut first).unwrap();
        assert_eq!(first, "POST /v1/library/rpc/ HTTP/1.1\r\n");
        loop {
            let mut line = String::new();
            request.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            assert!(!line.to_ascii_lowercase().starts_with("cookie:"));
        }
        drop(request);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
        socket.flush().unwrap();
        event_tx.send("headers-flushed".to_owned()).unwrap();
        match step_rx.recv_timeout(DEADLINE).unwrap() {
            ServerStep::Inspect => event_tx
                .send(observe_socket(&mut socket, PROMPT_BOUND))
                .unwrap(),
            _ => panic!("inspect first"),
        }
        if !pending_read {
            return;
        }
        match step_rx.recv_timeout(DEADLINE).unwrap() {
            ServerStep::Chunk => {
                socket.write_all(b"8\r\n{\"n\":1}\n\r\n").unwrap();
                socket.flush().unwrap();
                event_tx.send("late-chunk-written".into()).unwrap();
                event_tx
                    .send(observe_socket(&mut socket, DEADLINE))
                    .unwrap();
            }
            ServerStep::Eof => {
                socket.write_all(b"0\r\n\r\n").unwrap();
                socket.flush().unwrap();
                socket.shutdown(std::net::Shutdown::Write).unwrap();
                event_tx.send("server-write-half-closed".into()).unwrap();
                event_tx
                    .send(observe_socket(&mut socket, DEADLINE))
                    .unwrap();
            }
            ServerStep::Finish => {}
            _ => panic!("release chunk or EOF"),
        }
    });
    let request_rid = invoke(
        &window,
        "plugin:http|fetch",
        json!({"clientConfig":{
            "method":"POST", "url":format!("http://127.0.0.1:{port}/v1/library/rpc/"),
            "headers":[], "data":null, "maxRedirections":0, "connectTimeout":1000
        }}),
    )
    .unwrap();
    let response = invoke(
        &window,
        "plugin:http|fetch_send",
        json!({"rid":request_rid}),
    )
    .unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(event_rx.recv_timeout(DEADLINE).unwrap(), "headers-flushed");
    let rid = tauri::ResourceId::try_from(response["rid"].as_u64().unwrap())
        .expect("plugin response must carry a valid ResourceId");
    let view: &tauri::Webview<MockRuntime> = window.as_ref();
    // Observe only a Weak pointer: it cannot keep the response or socket alive.
    let weak: Weak<dyn tauri::Resource> = {
        let response = view.resources_table().get_any(rid).unwrap();
        Arc::downgrade(&response)
    };
    assert_eq!(
        weak.strong_count(),
        1,
        "only table owns response before body read"
    );
    let reading = pending_read
        .then(|| invoke_async(&window, "plugin:http|fetch_read_body", json!({"rid":rid})));
    if pending_read {
        // A bounded structural milestone, not retrying a failed assertion. The exact count
        // proves fetch_read_body has cloned its Arc; no instrumentation in provider source.
        let deadline = Instant::now() + DEADLINE;
        while weak.strong_count() != 2 {
            assert!(
                Instant::now() < deadline,
                "body read never acquired its response Arc"
            );
            std::thread::yield_now();
        }
    }
    let count_before = weak.strong_count();
    let cancelled = invoke(&window, "plugin:http|fetch_cancel_body", json!({"rid":rid}));
    assert_eq!(cancelled, Ok(Value::Null));
    let table_has_after_cancel = view.resources_table().has(rid);
    let count_after = weak.strong_count();
    let second_cancel = invoke(&window, "plugin:http|fetch_cancel_body", json!({"rid":rid}));
    assert!(second_cancel.is_err(), "the resource really was removed");
    let read_at_bound = reading.as_ref().map(|rx| rx.recv_timeout(PROMPT_BOUND));
    step_tx.send(ServerStep::Inspect).unwrap();
    let socket_after_cancel = event_rx.recv_timeout(DEADLINE).unwrap();
    let read_pending_after_cancel = matches!(read_at_bound, Some(Err(RecvTimeoutError::Timeout)));
    let mut read_after_release = None;
    let mut release_milestone = None;
    let mut socket_after_release = None;
    if pending_read && read_pending_after_cancel {
        step_tx
            .send(if release_eof {
                ServerStep::Eof
            } else {
                ServerStep::Chunk
            })
            .unwrap();
        release_milestone = Some(event_rx.recv_timeout(DEADLINE).unwrap());
        read_after_release = Some(match &read_at_bound {
            Some(Ok(result)) => result.clone(),
            _ => reading
                .as_ref()
                .unwrap()
                .recv_timeout(DEADLINE)
                .expect("body read still pending after server release"),
        });
        socket_after_release = Some(event_rx.recv_timeout(DEADLINE).unwrap());
    }
    if pending_read && !read_pending_after_cancel {
        step_tx.send(ServerStep::Finish).unwrap();
        let result = read_at_bound.as_ref().unwrap().as_ref().unwrap();
        assert_eq!(
            result,
            &Err(json!("Request canceled")),
            "cancel must settle with safe cancellation, not late success"
        );
        read_after_release = Some(result.clone());
    }
    server.join().unwrap();
    let count_after_release = weak.strong_count();
    let report = json!({
        "case":name, "dependencies":"desktop application Cargo.lock; see cargo build receipt",
        "transport":"actual plugin commands via MockRuntime IPC + actual reqwest loopback TCP",
        "bodyReadStarted":pending_read, "promptBoundMs":PROMPT_BOUND.as_millis(),
        "strongBeforeCancel":count_before, "cancelResult":cancelled,
        "tableContainsResponseAfterCancel":table_has_after_cancel,
        "strongAfterCancel":count_after, "secondCancel":second_cancel,
        "readPendingAfterCancelBound":read_pending_after_cancel,
        "socketAfterCancel":socket_after_cancel,
        "releaseMilestone":release_milestone, "readCompletion":read_after_release,
        "readCompletionPhase":if read_pending_after_cancel { "after-server-release" } else { "before-server-release" },
        "socketAfterServerRelease":socket_after_release,
        "strongAfterServerRelease":count_after_release,
    });
    println!("CANCEL_PROBE_RESULT {report}");
    let report_directory = std::env::var("KITTIES_IDLE_BODY_PROBE_OUTPUT")
        .expect("set KITTIES_IDLE_BODY_PROBE_OUTPUT to an isolated evidence directory");
    std::fs::create_dir_all(&report_directory).unwrap();
    std::fs::write(
        format!("{report_directory}/{name}.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    drop(window);
    drop(app);
    std::fs::remove_dir_all(directory).unwrap();
    assert!(!table_has_after_cancel);
    assert_eq!(
        count_after_release, 0,
        "all response ownership must end during cleanup"
    );
    if pending_read {
        assert!(
            matches!(socket_after_cancel.as_str(), "eof" | "connection-reset"),
            "cancel must close idle server socket before it sends any body bytes"
        );
        assert!(
            !read_pending_after_cancel,
            "BUG: successful cancel left the real plugin body IPC pending beyond the 300ms bound; see persisted resource/socket/chunk evidence"
        );
    } else {
        assert!(matches!(
            socket_after_cancel.as_str(),
            "eof" | "connection-reset"
        ));
    }
}

#[test]
fn idle_body_cancel_with_pending_read_must_close_before_server_chunk() {
    run_case("pending-read-then-chunk", true, false);
}

#[test]
fn idle_body_cancel_with_pending_read_must_close_before_server_eof() {
    run_case("pending-read-then-eof", true, true);
}

#[test]
fn idle_body_cancel_without_pending_read_closes_socket_control() {
    run_case("no-pending-read-control", false, false);
}
