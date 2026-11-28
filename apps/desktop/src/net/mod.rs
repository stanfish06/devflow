//! HTTP access to the running stack. reqwest needs tokio and GPUI's executors are not tokio, so
//! all requests run on one owned tokio runtime; GPUI tasks await the join handles and receive
//! stream updates over async channels.

pub mod rpc;
pub mod shape;
pub mod sse;
pub mod stream;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::config::StackConfig;

/// Refresh the access token this long before it expires (local-authkit.tsx does the same).
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

/// The network runtime lives for the whole process. Tasks on it hold `Arc<Net>`, so if `Net`
/// owned the runtime, the last task to finish could drop it from inside itself, which panics.
static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

pub struct Net {
    runtime: &'static tokio::runtime::Runtime,
    http: reqwest::Client,
    config: StackConfig,
    auth: Mutex<Option<AuthSession>>,
}

/// The local user's session from `POST /devflow/auth/session` (apps/api/src/devflow/local-auth.ts).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub access_token: String,
    /// Expiry in Unix milliseconds.
    pub expires_at: i64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Net {
    pub fn new(config: StackConfig) -> Result<Arc<Self>> {
        let runtime = match RUNTIME.get() {
            Some(runtime) => runtime,
            None => {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_name("devflow-net")
                    .enable_all()
                    .build()
                    .context("start the network runtime")?;
                RUNTIME.get_or_init(|| runtime)
            }
        };
        // The platform TLS stack trusts the Caddy local CA once `caddy trust` added it to the
        // keychain; on Linux nothing adds it to the system store, so it is trusted here as well.
        let mut http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .user_agent(concat!("devflow-desktop/", env!("CARGO_PKG_VERSION")))
            // Linux hands the stack's own certificates to the webview (ui/web/linux.rs).
            .tls_info(cfg!(target_os = "linux"));
        if let Some(path) = &config.ca_file {
            let pem = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
            let ca = reqwest::Certificate::from_pem(&pem)
                .with_context(|| format!("{} is not a PEM certificate", path.display()))?;
            http = http.add_root_certificate(ca);
        }
        let http = http.build().context("build the HTTP client")?;
        Ok(Arc::new(Self {
            runtime,
            http,
            config,
            auth: Mutex::new(None),
        }))
    }

    pub fn config(&self) -> &StackConfig {
        &self.config
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Run a future on the network runtime. The handle is awaitable from any executor.
    pub fn spawn<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.runtime.spawn(future)
    }

    /// The DER certificate `origin` presents, which the HTTP client has verified.
    #[cfg(target_os = "linux")]
    pub async fn peer_certificate(&self, origin: &url::Url) -> Result<Vec<u8>> {
        let response = self
            .http
            .head(origin.clone())
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .with_context(|| format!("reach {origin}"))?;
        response
            .extensions()
            .get::<reqwest::tls::TlsInfo>()
            .and_then(|info| info.peer_certificate())
            .map(<[u8]>::to_vec)
            .with_context(|| format!("{origin} presented no certificate"))
    }

    /// The current session, signing in again when the token is missing or close to expiry.
    pub async fn session(&self) -> Result<AuthSession> {
        let mut auth = self.auth.lock().await;
        if let Some(session) = auth
            .as_ref()
            .filter(|s| s.expires_at - REFRESH_MARGIN_MS > now_ms())
        {
            return Ok(session.clone());
        }
        let url = StackConfig::join(&self.config.api, "/devflow/auth/session");
        // Bounds the whole exchange, body included: a stalled sign-in would hold the auth lock
        // and block every request waiting for a token.
        let response = self
            .http
            .post(url.clone())
            .timeout(AUTH_TIMEOUT)
            .send()
            .await
            .with_context(|| format!("reach the API at {url}"))?;
        if !response.status().is_success() {
            bail!("sign-in failed: {} from {url}", response.status());
        }
        let session: AuthSession = response.json().await.context("read the sign-in response")?;
        *auth = Some(session.clone());
        Ok(session)
    }

    pub async fn token(&self) -> Result<String> {
        Ok(self.session().await?.access_token)
    }

    /// Drop the cached token after a 401 so the next request signs in again. Only `rejected` is
    /// dropped: a concurrent request may already have replaced it with a fresh one.
    pub async fn invalidate_token(&self, rejected: &str) {
        let mut auth = self.auth.lock().await;
        if auth
            .as_ref()
            .is_some_and(|session| session.access_token == rejected)
        {
            auth.take();
        }
    }
}

/// Longest a sign-in may take, connection through response body.
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);

/// Exponential backoff for reconnecting streams: 0.5 s doubling to 15 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((500u64 << attempt.min(5)).min(15_000))
}

/// Aborts a network task when dropped. Dropping a tokio `JoinHandle` only detaches the task, so a
/// GPUI task awaiting one holds this to cancel the work along with the wait.
pub struct AbortOnDrop(pub tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
