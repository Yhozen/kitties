use super::*;
use std::{collections::BTreeMap, sync::atomic::AtomicUsize};
use tokio::net::TcpStream;

fn config() -> AccessConfiguration {
    AccessConfiguration::new("https://app.example", "https://access.example").unwrap()
}
fn metadata() -> Metadata {
    Metadata {
        issuer: "https://access.example".into(),
        authorization_endpoint: "https://access.example/authorize".into(),
        token_endpoint: "https://access.example/token".into(),
        registration_endpoint: "https://access.example/register".into(),
        code_challenge_methods_supported: vec!["S256".into()],
        token_endpoint_auth_methods_supported: vec!["none".into()],
        response_types_supported: vec!["code".into()],
    }
}

#[test]
fn configuration_and_discovery_reject_endpoint_substitution_and_secret_clients() {
    for value in [
        "http://app.example",
        "https://*.example",
        "https://app.example/",
        "https://app.example/path",
        "https://user:secret@app.example",
        "https://app.example?x",
        "https://app.example#x",
    ] {
        assert!(
            AccessConfiguration::new(value, "https://access.example").is_err(),
            "{value}"
        );
    }
    let trusted = config();
    for value in [
        "http://access.example/token",
        "https://evil.example/token",
        "https://access.example.evil/token",
        "https://user:secret@access.example/token",
        "https://access.example/token?x",
        "https://access.example/token#x",
    ] {
        assert!(trusted.endpoint(value).is_err(), "{value}");
    }
    for change in 0..5 {
        let mut document = metadata();
        match change {
            0 => document.issuer = "https://other.example".into(),
            1 => document.token_endpoint = "https://other.example/token".into(),
            2 => document.code_challenge_methods_supported = vec!["plain".into()],
            3 => {
                document.token_endpoint_auth_methods_supported = vec!["client_secret_basic".into()]
            }
            _ => document.response_types_supported = vec!["token".into()],
        }
        assert!(document.validate(&trusted).is_err());
    }
    for secret in [None, Some("embedded-secret".into())] {
        let valid = secret.is_none();
        let registered = Registration {
            client_id: "public-client".into(),
            client_secret: secret,
            token_endpoint_auth_method: "none".into(),
            redirect_uris: vec!["http://127.0.0.1:1234/callback".into()],
        };
        assert_eq!(
            registered
                .validate("http://127.0.0.1:1234/callback")
                .is_ok(),
            valid
        );
    }
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        )),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn callback_requires_exact_state_host_path_and_one_code_without_credential_echo() {
    let redirect = Url::parse("http://127.0.0.1:12345/oauth/callback/private").unwrap();
    let request = |query: &str| {
        format!("GET /oauth/callback/private?{query} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\n")
    };
    assert_eq!(
        callback_code(
            &request("state=expected&code=code-1"),
            &redirect,
            "expected",
            "https://access.example"
        )
        .unwrap(),
        "code-1"
    );
    for query in [
        "state=wrong&code=x",
        "state=expected&state=expected&code=x",
        "state=expected&code=x&code=y",
        "state=expected&error=access_denied",
        "code=x",
        "state=expected&code=x&access_token=forbidden",
        "state=expected&code=x&iss=https%3A%2F%2Fevil.example",
        "state=expected&code=",
    ] {
        assert_eq!(
            callback_code(
                &request(query),
                &redirect,
                "expected",
                "https://access.example"
            )
            .err(),
            Some(AccessError::Denied)
        );
    }
    for raw in [
        request("state=expected&code=x").replace("127.0.0.1", "localhost"),
        request("state=expected&code=x").replace("/private?", "/different?"),
        request("state=expected&code=x").replace("GET ", "POST "),
        request("state=expected&code=x").replace("\r\n\r\n", "\r\nHost: attacker\r\n\r\n"),
    ] {
        assert_eq!(
            callback_code(&raw, &redirect, "expected", "https://access.example").err(),
            Some(AccessError::Denied)
        );
    }
}

#[derive(Clone, Copy)]
enum Mode {
    Success,
    WrongState,
    Denied,
    Substitute,
    SecretClient,
}
struct LocalProvider {
    mode: Mode,
    authorization: Mutex<Option<BTreeMap<String, String>>>,
    exchanges: AtomicUsize,
}
impl LocalProvider {
    fn new(mode: Mode) -> Self {
        Self {
            mode,
            authorization: Mutex::new(None),
            exchanges: AtomicUsize::new(0),
        }
    }
}
impl Provider for LocalProvider {
    async fn metadata(&self, url: Url) -> Result<Metadata> {
        assert_eq!(
            url.as_str(),
            "https://app.example/.well-known/oauth-authorization-server"
        );
        let mut document = metadata();
        if matches!(self.mode, Mode::Substitute) {
            document.token_endpoint = "https://attacker.example/token".into();
        }
        Ok(document)
    }
    async fn register(&self, url: Url, request: RegistrationRequest<'_>) -> Result<Registration> {
        assert_eq!(url.as_str(), "https://access.example/register");
        assert_eq!(request.token_endpoint_auth_method, "none");
        assert_eq!(request.grant_types, ["authorization_code"]);
        Ok(Registration {
            client_id: "public-client".into(),
            client_secret: matches!(self.mode, Mode::SecretClient)
                .then(|| "not-a-public-client".into()),
            token_endpoint_auth_method: "none".into(),
            redirect_uris: request
                .redirect_uris
                .iter()
                .map(|uri| (*uri).to_owned())
                .collect(),
        })
    }
    async fn open(&self, url: Url) -> Result<()> {
        assert_eq!(url.origin().ascii_serialization(), "https://access.example");
        let query: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(query.get("resource").unwrap(), "https://app.example");
        assert_eq!(query.get("state").unwrap().len(), 43);
        assert_eq!(query.get("code_challenge").unwrap().len(), 43);
        assert!(!query.contains_key("code_verifier") && !query.contains_key("access_token"));
        let mut redirect = Url::parse(query.get("redirect_uri").unwrap()).unwrap();
        assert_eq!(redirect.host_str(), Some("127.0.0.1"));
        assert_eq!(redirect.scheme(), "http");
        redirect.query_pairs_mut().append_pair(
            "state",
            if matches!(self.mode, Mode::WrongState) {
                "substituted"
            } else {
                query.get("state").unwrap()
            },
        );
        if matches!(self.mode, Mode::Denied) {
            redirect
                .query_pairs_mut()
                .append_pair("error", "access_denied");
        } else {
            redirect
                .query_pairs_mut()
                .append_pair("code", "single-use-code");
        }
        let host = format!("127.0.0.1:{}", redirect.port().unwrap());
        let mut stream = TcpStream::connect(&host).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET {}?{} HTTP/1.1\r\nHost: {host}\r\n\r\n",
                    redirect.path(),
                    redirect.query().unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        *self.authorization.lock().unwrap() = Some(query);
        Ok(())
    }
    async fn exchange(&self, url: Url, form: &[(&str, &str)]) -> Result<TokenResponse> {
        self.exchanges.fetch_add(1, Ordering::SeqCst);
        assert_eq!(url.as_str(), "https://access.example/token");
        let form: BTreeMap<_, _> = form.iter().copied().collect();
        let guard = self.authorization.lock().unwrap();
        let authorization = guard.as_ref().unwrap();
        assert_eq!(form["code"], "single-use-code");
        assert_eq!(form["client_id"], "public-client");
        assert_eq!(form["resource"], "https://app.example");
        assert_eq!(form["redirect_uri"], authorization["redirect_uri"]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes())),
            authorization["code_challenge"]
        );
        Ok(TokenResponse {
            access_token: "oauth:synthetic-token".into(),
            token_type: "Bearer".into(),
            expires_in: 60,
        })
    }
}

#[tokio::test]
async fn managed_flow_uses_real_single_use_loopback_pkce_resource_and_public_registration() {
    let state = NativeAccessState::default();
    let id = state.begin().await.unwrap();
    let port = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .listener
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let provider = LocalProvider::new(Mode::Success);
    let credential = finish(&state, &id, &config(), &provider).await.unwrap();
    assert_eq!(credential.access_token, "oauth:synthetic-token");
    assert_eq!(credential.expires_in, 60);
    assert_eq!(provider.exchanges.load(Ordering::SeqCst), 1);
    assert_eq!(
        finish(&state, &id, &config(), &provider).await.err(),
        Some(AccessError::Cancelled)
    );
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
    assert!(state.0.lock().unwrap().is_none());
}

#[tokio::test]
async fn denied_state_substitution_and_secret_client_never_exchange_or_leave_listener() {
    for mode in [
        Mode::WrongState,
        Mode::Denied,
        Mode::Substitute,
        Mode::SecretClient,
    ] {
        let state = NativeAccessState::default();
        let id = state.begin().await.unwrap();
        let provider = LocalProvider::new(mode);
        assert_eq!(
            finish(&state, &id, &config(), &provider).await.err(),
            Some(if matches!(mode, Mode::Substitute | Mode::SecretClient) {
                AccessError::Configuration
            } else {
                AccessError::Denied
            })
        );
        assert_eq!(provider.exchanges.load(Ordering::SeqCst), 0);
        assert!(state.0.lock().unwrap().is_none());
    }
}

struct StalledProvider {
    entered: tokio::sync::Notify,
}
impl Provider for StalledProvider {
    async fn metadata(&self, _: Url) -> Result<Metadata> {
        self.entered.notify_one();
        std::future::pending().await
    }
    async fn register(&self, _: Url, _: RegistrationRequest<'_>) -> Result<Registration> {
        panic!("must not register")
    }
    async fn open(&self, _: Url) -> Result<()> {
        panic!("must not open")
    }
    async fn exchange(&self, _: Url, _: &[(&str, &str)]) -> Result<TokenResponse> {
        panic!("must not exchange")
    }
}

#[tokio::test]
async fn cancellation_drops_listener_and_pending_network_and_fences_duplicate_and_old_attempts() {
    let state = NativeAccessState::default();
    let id = state.begin().await.unwrap();
    assert_eq!(state.begin().await.err(), Some(AccessError::Unavailable));
    state.cancel("different-attempt").unwrap();
    let port = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .listener
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let provider = StalledProvider {
        entered: tokio::sync::Notify::new(),
    };
    let configuration = config();
    let (result, ()) = tokio::join!(finish(&state, &id, &configuration, &provider), async {
        provider.entered.notified().await;
        assert_eq!(state.claim(&id).err(), Some(AccessError::Denied));
        state.cancel(&id).unwrap();
    });
    assert_eq!(result.err(), Some(AccessError::Cancelled));
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
    let next = state.begin().await.unwrap();
    assert_ne!(id, next);
    state.cancel(&id).unwrap();
    assert!(state.0.lock().unwrap().is_some());
    state.cancel(&next).unwrap();
    assert!(state.0.lock().unwrap().is_none());
}

#[test]
fn token_response_requires_bounded_bearer_expiry_and_never_accepts_header_injection() {
    for (token, lifetime, kind) in [
        ("oauth:ok", 0, "Bearer"),
        ("oauth:ok", 86401, "Bearer"),
        ("bad\r\nheader", 60, "Bearer"),
        ("oauth:ok", 60, "Basic"),
    ] {
        assert_eq!(
            TokenResponse {
                access_token: token.into(),
                token_type: kind.into(),
                expires_in: lifetime
            }
            .validate()
            .err(),
            Some(AccessError::Denied)
        );
    }
}

#[tokio::test(start_paused = true)]
async fn authorization_deadline_drops_a_stalled_provider_and_releases_listener() {
    let state = NativeAccessState::default();
    let id = state.begin().await.unwrap();
    let provider = StalledProvider {
        entered: tokio::sync::Notify::new(),
    };
    assert_eq!(
        finish(&state, &id, &config(), &provider).await.err(),
        Some(AccessError::Cancelled)
    );
    assert!(state.0.lock().unwrap().is_none());
}
