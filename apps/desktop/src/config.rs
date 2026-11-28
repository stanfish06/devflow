//! Where the running devflow stack is. `bun run devflow desktop` passes the origins it serves;
//! without them the defaults match `devflow up` (stack id `devflow`, Caddy on port 47443).

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use url::Url;

const DEFAULT_HTTPS_PORT: u16 = 47443;

#[derive(Clone, Debug)]
pub struct StackConfig {
    /// The API: `/devflow/auth/session` and oRPC under `/rpc/api/v1`.
    pub api: Url,
    /// The sync proxy: Electric shapes and durable streams.
    pub sync: Url,
    /// The web UI the webview pane loads.
    pub app: Url,
}

impl StackConfig {
    pub fn load() -> Result<Self> {
        let port = saved_https_port().unwrap_or(DEFAULT_HTTPS_PORT);
        let origin = |var: &str, host: &str| -> Result<Url> {
            let value = std::env::var(var)
                .unwrap_or_else(|_| format!("https://{host}.devflow.localhost:{port}"));
            Url::parse(&value).with_context(|| format!("{var} is not a URL: {value}"))
        };
        Ok(Self {
            api: origin("DEVFLOW_API_ORIGIN", "api")?,
            sync: origin("DEVFLOW_SYNC_ORIGIN", "sync")?,
            app: origin("DEVFLOW_APP_ORIGIN", "app")?,
        })
    }

    /// Join a path onto an origin; `path` starts with `/`.
    pub fn join(origin: &Url, path: &str) -> Url {
        let mut url = origin.clone();
        url.set_path(path);
        url
    }
}

/// $DEVFLOW_HOME, default ~/.devflow.
pub fn devflow_home() -> Option<PathBuf> {
    std::env::var_os("DEVFLOW_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".devflow")))
}

/// `devflow up --port N` saves its port as `httpsPort` in $DEVFLOW_HOME/config.json.
fn saved_https_port() -> Option<u16> {
    let home = devflow_home()?;
    let text = std::fs::read_to_string(home.join("config.json")).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    config
        .get("httpsPort")?
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
}
