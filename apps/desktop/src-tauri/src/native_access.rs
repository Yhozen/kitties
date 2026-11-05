//! Managed Access OAuth for the local main window. No credentials are persisted or logged.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{Manager, Runtime, ipc::CapabilityBuilder};
use tauri_plugin_http::reqwest::{self, redirect::Policy};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};
use url::Url;

const AUTHORIZATION_LIFETIME: Duration = Duration::from_secs(180);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DOCUMENT: usize = 32768;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(tag = "reason")]
pub(crate) enum AccessError {
    Denied,
    Unavailable,
    Cancelled,
    Configuration,
}
type Result<T> = std::result::Result<T, AccessError>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessConfiguration {
    application_url: String,
    issuer: String,
}

fn https_origin(text: &str) -> Result<Url> {
    let url = Url::parse(text).map_err(|_| AccessError::Configuration)?;
    if !url.host_str().is_some_and(|host| {
        host.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    }) || url.scheme() != "https"
        || url.origin().ascii_serialization() != text
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(AccessError::Configuration);
    }
    Ok(url)
}

impl AccessConfiguration {
    pub(crate) fn new(application_url: &str, issuer: &str) -> Result<Self> {
        https_origin(application_url)?;
        https_origin(issuer)?;
        Ok(Self {
            application_url: application_url.into(),
            issuer: issuer.into(),
        })
    }

    fn compiled() -> Result<Self> {
        Self::new(
            option_env!("KITTIES_DESKTOP_APPLICATION").ok_or(AccessError::Configuration)?,
            option_env!("KITTIES_DESKTOP_ISSUER").ok_or(AccessError::Configuration)?,
        )
    }

    fn endpoint(&self, text: &str) -> Result<Url> {
        let url = Url::parse(text).map_err(|_| AccessError::Configuration)?;
        let origin = url.origin().ascii_serialization();
        if url.scheme() != "https"
            || (origin != self.application_url && origin != self.issuer)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AccessError::Configuration);
        }
        Ok(url)
    }
}

pub(crate) fn http_capability(config: &AccessConfiguration) -> CapabilityBuilder {
    let allowed: Vec<serde_json::Value> =
        ["/v1/library/session", "/v1/library/rpc", "/v1/library/rpc/"]
            .into_iter()
            .map(|path| serde_json::json!({"url": format!("{}{path}", config.application_url)}))
            .collect();
    // Plugin2.8.3 treats an omitted search/hash as wildcard. Deny every nonempty
    // component explicitly, rather than assuming a plain URL excludes queries.
    let denied: Vec<serde_json::Value> =
        ["/v1/library/session", "/v1/library/rpc", "/v1/library/rpc/"]
            .into_iter()
            .flat_map(|path| {
                ["?(.+)", "#(.+)"].map(|suffix|
            serde_json::json!({"url": format!("{}{path}{suffix}", config.application_url)}))
            })
            .collect();
    CapabilityBuilder::new("main-native-http")
        .local(true)
        .window("main")
        .permission_scoped("http:default", allowed, denied)
}

pub(crate) fn configure<R: Runtime>(app: &tauri::App<R>) -> std::result::Result<(), tauri::Error> {
    // No configuration is a supported fail-closed build, with no outbound IPC grants.
    if let Ok(config) = AccessConfiguration::compiled() {
        app.add_capability(http_capability(&config))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn native_access_configuration() -> Result<AccessConfiguration> {
    AccessConfiguration::compiled()
}

fn random_secret() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AccessError::Unavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

struct Attempt {
    id: String,
    listener: Mutex<Option<TcpListener>>,
    cancelled: watch::Sender<bool>,
    claimed: AtomicBool,
}
#[derive(Default, Clone)]
pub(crate) struct NativeAccessState(Arc<Mutex<Option<Arc<Attempt>>>>);

impl NativeAccessState {
    async fn begin(&self) -> Result<String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| AccessError::Unavailable)?;
        let id = random_secret()?;
        let (cancelled, mut receiver) = watch::channel(false);
        let attempt = Arc::new(Attempt {
            id: id.clone(),
            listener: Mutex::new(Some(listener)),
            cancelled,
            claimed: AtomicBool::new(false),
        });
        {
            let mut slot = self.0.lock().map_err(|_| AccessError::Unavailable)?;
            if slot.is_some() {
                return Err(AccessError::Unavailable);
            }
            *slot = Some(attempt);
        }
        let state = self.clone();
        let expiring_id = id.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! { _ = tokio::time::sleep(AUTHORIZATION_LIFETIME) => {}, _ = receiver.changed() => {} }
            let _ = state.cancel(&expiring_id);
        });
        Ok(id)
    }

    fn cancel(&self, id: &str) -> Result<()> {
        let mut slot = self.0.lock().map_err(|_| AccessError::Unavailable)?;
        if slot.as_ref().is_some_and(|attempt| attempt.id == id) {
            if let Some(attempt) = slot.take() {
                attempt.cancelled.send_replace(true);
            }
        }
        Ok(())
    }

    fn claim(&self, id: &str) -> Result<Arc<Attempt>> {
        let slot = self.0.lock().map_err(|_| AccessError::Unavailable)?;
        let attempt = slot
            .as_ref()
            .filter(|attempt| attempt.id == id)
            .ok_or(AccessError::Cancelled)?;
        if attempt.claimed.swap(true, Ordering::SeqCst) {
            return Err(AccessError::Denied);
        }
        Ok(attempt.clone())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedAttempt {
    attempt_id: String,
}

#[tauri::command]
pub(crate) async fn begin_native_authentication(
    state: tauri::State<'_, NativeAccessState>,
) -> Result<StartedAttempt> {
    AccessConfiguration::compiled()?;
    Ok(StartedAttempt {
        attempt_id: state.begin().await?,
    })
}

#[tauri::command]
pub(crate) fn cancel_native_authentication(
    state: tauri::State<'_, NativeAccessState>,
    attempt_id: String,
) -> Result<()> {
    state.cancel(&attempt_id)
}

#[derive(Deserialize)]
struct Metadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: String,
    code_challenge_methods_supported: Vec<String>,
    token_endpoint_auth_methods_supported: Vec<String>,
    response_types_supported: Vec<String>,
}
struct Endpoints {
    authorization: Url,
    token: Url,
    registration: Url,
}
impl Metadata {
    fn validate(self, config: &AccessConfiguration) -> Result<Endpoints> {
        if self.issuer != config.issuer
            || !self
                .code_challenge_methods_supported
                .iter()
                .any(|method| method == "S256")
            || !self
                .token_endpoint_auth_methods_supported
                .iter()
                .any(|method| method == "none")
            || !self
                .response_types_supported
                .iter()
                .any(|response| response == "code")
        {
            return Err(AccessError::Configuration);
        }
        Ok(Endpoints {
            authorization: config.endpoint(&self.authorization_endpoint)?,
            token: config.endpoint(&self.token_endpoint)?,
            registration: config.endpoint(&self.registration_endpoint)?,
        })
    }
}

#[derive(Serialize)]
struct RegistrationRequest<'a> {
    client_name: &'static str,
    redirect_uris: [&'a str; 1],
    token_endpoint_auth_method: &'static str,
    grant_types: [&'static str; 1],
    response_types: [&'static str; 1],
}
#[derive(Deserialize)]
struct Registration {
    client_id: String,
    client_secret: Option<String>,
    token_endpoint_auth_method: String,
    redirect_uris: Vec<String>,
}
impl Registration {
    fn validate(self, redirect: &str) -> Result<String> {
        if self.client_secret.is_some()
            || self.token_endpoint_auth_method != "none"
            || self.redirect_uris != [redirect]
            || self.client_id.is_empty()
            || self.client_id.len() > 1024
            || !self
                .client_id
                .bytes()
                .all(|byte| (33..=126).contains(&byte))
        {
            return Err(AccessError::Configuration);
        }
        Ok(self.client_id)
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Credential {
    access_token: String,
    expires_in: u32,
}
impl TokenResponse {
    fn validate(self) -> Result<Credential> {
        if !self.token_type.eq_ignore_ascii_case("bearer")
            || self.access_token.is_empty()
            || self.access_token.len() > 8192
            || !self
                .access_token
                .bytes()
                .all(|byte| (33..=126).contains(&byte))
            || self.expires_in == 0
            || self.expires_in > 86400
        {
            return Err(AccessError::Denied);
        }
        // Refresh tokens/registration management credentials are deliberately not retained.
        Ok(Credential {
            access_token: self.access_token,
            expires_in: self.expires_in,
        })
    }
}

trait Provider {
    async fn metadata(&self, url: Url) -> Result<Metadata>;
    async fn register(&self, url: Url, request: RegistrationRequest<'_>) -> Result<Registration>;
    async fn open(&self, url: Url) -> Result<()>;
    async fn exchange(&self, url: Url, form: &[(&str, &str)]) -> Result<TokenResponse>;
}

struct ManagedProvider<R: Runtime> {
    client: reqwest::Client,
    app: tauri::AppHandle<R>,
}
impl<R: Runtime> ManagedProvider<R> {
    fn new(app: tauri::AppHandle<R>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(NETWORK_TIMEOUT)
            .timeout(NETWORK_TIMEOUT)
            .build()
            .map_err(|_| AccessError::Unavailable)?;
        Ok(Self { client, app })
    }
}

async fn document<T: serde::de::DeserializeOwned>(mut response: reqwest::Response) -> Result<T> {
    if response.status().is_redirection() {
        return Err(AccessError::Configuration);
    }
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
        return Err(AccessError::Denied);
    }
    if !response.status().is_success() {
        return Err(AccessError::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOCUMENT as u64)
    {
        return Err(AccessError::Configuration);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AccessError::Unavailable)?
    {
        if body.len() + chunk.len() > MAX_DOCUMENT {
            return Err(AccessError::Configuration);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| AccessError::Configuration)
}

impl<R: Runtime> Provider for ManagedProvider<R> {
    async fn metadata(&self, url: Url) -> Result<Metadata> {
        document(
            self.client
                .get(url)
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|_| AccessError::Unavailable)?,
        )
        .await
    }
    async fn register(&self, url: Url, request: RegistrationRequest<'_>) -> Result<Registration> {
        document(
            self.client
                .post(url)
                .json(&request)
                .send()
                .await
                .map_err(|_| AccessError::Unavailable)?,
        )
        .await
    }
    async fn open(&self, url: Url) -> Result<()> {
        let app = self.app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.opener().open_url(url.as_str(), None::<&str>)
        })
        .await
        .map_err(|_| AccessError::Unavailable)?
        .map_err(|_| AccessError::Unavailable)
    }
    async fn exchange(&self, url: Url, form: &[(&str, &str)]) -> Result<TokenResponse> {
        document(
            self.client
                .post(url)
                .form(form)
                .send()
                .await
                .map_err(|_| AccessError::Unavailable)?,
        )
        .await
    }
}

fn callback_code(request: &str, redirect: &Url, state: &str, issuer: &str) -> Result<String> {
    if !request.is_ascii() || !request.ends_with("\r\n\r\n") {
        return Err(AccessError::Denied);
    }
    let mut lines = request.split("\r\n");
    let mut first = lines.next().ok_or(AccessError::Denied)?.split(' ');
    if first.next() != Some("GET") {
        return Err(AccessError::Denied);
    }
    let target = first.next().ok_or(AccessError::Denied)?;
    if !target.starts_with('/')
        || target.starts_with("//")
        || first.next() != Some("HTTP/1.1")
        || first.next().is_some()
    {
        return Err(AccessError::Denied);
    }
    let host = format!(
        "127.0.0.1:{}",
        redirect.port().ok_or(AccessError::Configuration)?
    );
    let mut hosts = 0;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(AccessError::Denied)?;
        if name.eq_ignore_ascii_case("host") {
            hosts += 1;
            if value.trim() != host {
                return Err(AccessError::Denied);
            }
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-length")
        {
            return Err(AccessError::Denied);
        }
    }
    if hosts != 1 {
        return Err(AccessError::Denied);
    }
    let url = redirect.join(target).map_err(|_| AccessError::Denied)?;
    if url.path() != redirect.path()
        || url.fragment().is_some()
        || url.origin() != redirect.origin()
    {
        return Err(AccessError::Denied);
    }
    let mut found_state = None;
    let mut code = None;
    let mut error = false;
    let mut found_issuer = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" if found_state.is_none() => found_state = Some(value.into_owned()),
            "code" if code.is_none() => code = Some(value.into_owned()),
            "error" if !error => error = true,
            "error_description" => {}
            "iss" if !found_issuer && value == issuer => found_issuer = true,
            _ => return Err(AccessError::Denied),
        }
    }
    if found_state.as_deref() != Some(state) || error {
        return Err(AccessError::Denied);
    }
    code.filter(|value| {
        !value.is_empty()
            && value.len() <= 4096
            && value.bytes().all(|byte| (33..=126).contains(&byte))
    })
    .ok_or(AccessError::Denied)
}

async fn receive_code(
    listener: TcpListener,
    redirect: &Url,
    state: &str,
    issuer: &str,
) -> Result<String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|_| AccessError::Unavailable)?;
    // A connection consumes this one-use listener even when malformed or denied.
    drop(listener);
    let read = async {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0_u8; 1024];
            let count = stream
                .read(&mut chunk)
                .await
                .map_err(|_| AccessError::Unavailable)?;
            if count == 0 || request.len() + count > 8192 {
                return Err(AccessError::Denied);
            }
            request.extend_from_slice(&chunk[..count]);
            if request.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let request = std::str::from_utf8(&request).map_err(|_| AccessError::Denied)?;
        let result = callback_code(request, redirect, state, issuer);
        // Never echo callback query, code, state, or provider error content.
        let body = if result.is_ok() {
            "Sign-in received. You can close this window."
        } else {
            "Sign-in refused. Return to Kitties."
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        result
    };
    tokio::time::timeout(Duration::from_secs(3), read)
        .await
        .map_err(|_| AccessError::Denied)?
}

async fn authorize(
    provider: &impl Provider,
    config: &AccessConfiguration,
    listener: TcpListener,
) -> Result<Credential> {
    let port = listener
        .local_addr()
        .map_err(|_| AccessError::Unavailable)?
        .port();
    let redirect = Url::parse(&format!(
        "http://127.0.0.1:{port}/oauth/callback/{}",
        random_secret()?
    ))
    .map_err(|_| AccessError::Unavailable)?;
    let metadata_url = Url::parse(&format!(
        "{}/.well-known/oauth-authorization-server",
        config.application_url
    ))
    .map_err(|_| AccessError::Configuration)?;
    let endpoints = provider.metadata(metadata_url).await?.validate(config)?;
    let client = provider
        .register(
            endpoints.registration,
            RegistrationRequest {
                client_name: "Kitties Desktop",
                redirect_uris: [redirect.as_str()],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code"],
                response_types: ["code"],
            },
        )
        .await?
        .validate(redirect.as_str())?;
    let verifier = random_secret()?;
    let state = random_secret()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorization = endpoints.authorization;
    authorization.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", client.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge.as_str()),
        ("state", state.as_str()),
        ("resource", config.application_url.as_str()),
    ]);
    provider.open(authorization).await?;
    let code = receive_code(listener, &redirect, &state, &config.issuer).await?;
    provider
        .exchange(
            endpoints.token,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &client),
                ("redirect_uri", redirect.as_str()),
                ("code", &code),
                ("code_verifier", &verifier),
                ("resource", &config.application_url),
            ],
        )
        .await?
        .validate()
}

struct AttemptGuard {
    state: NativeAccessState,
    id: String,
}
impl Drop for AttemptGuard {
    fn drop(&mut self) {
        let _ = self.state.cancel(&self.id);
    }
}

async fn finish(
    state: &NativeAccessState,
    id: &str,
    config: &AccessConfiguration,
    provider: &impl Provider,
) -> Result<Credential> {
    let attempt = state.claim(id)?;
    let _guard = AttemptGuard {
        state: state.clone(),
        id: id.into(),
    };
    let mut cancelled = attempt.cancelled.subscribe();
    if *cancelled.borrow() {
        return Err(AccessError::Cancelled);
    }
    let listener = attempt
        .listener
        .lock()
        .map_err(|_| AccessError::Unavailable)?
        .take()
        .ok_or(AccessError::Cancelled)?;
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err(AccessError::Cancelled),
        result = tokio::time::timeout(AUTHORIZATION_LIFETIME, authorize(provider, config, listener)) => result.map_err(|_| AccessError::Cancelled)?,
    }
}

#[tauri::command]
pub(crate) async fn finish_native_authentication<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, NativeAccessState>,
    attempt_id: String,
) -> Result<Credential> {
    let config = AccessConfiguration::compiled()?;
    finish(&state, &attempt_id, &config, &ManagedProvider::new(app)?).await
}

#[cfg(test)]
mod tests;
