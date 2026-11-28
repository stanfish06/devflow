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

pub struct Net {
    runtime: tokio::runtime::Runtime,
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
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("devflow-net")
            .enable_all()
            .build()
            .context("start the network runtime")?;
        // The platform TLS stack trusts the Caddy local CA that `caddy trust` added to the keychain.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .user_agent(concat!("devflow-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("build the HTTP client")?;
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
        let response = self
            .http
            .post(url.clone())
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

    /// Drop the cached token after a 401 so the next request signs in again.
    pub async fn invalidate_token(&self) {
        self.auth.lock().await.take();
    }
}

/// Exponential backoff for reconnecting streams: 0.5 s doubling to 15 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((500u64 << attempt.min(5)).min(15_000))
}
