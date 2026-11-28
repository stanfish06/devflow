//! oRPC over its OpenAPI handler (apps/api/src/orpc/index.ts): `POST /rpc/api/v1/<router path>`
//! with the procedure input as the JSON body and its output as the JSON response.

use std::fmt;

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::Net;
use crate::config::StackConfig;

/// A failed call: oRPC's error code (`NOT_FOUND`, `UNAUTHORIZED`, ...) or a transport failure.
#[derive(Clone, Debug)]
pub struct RpcError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status, self.message)
    }
}

impl std::error::Error for RpcError {}

impl RpcError {
    fn transport(error: impl fmt::Display) -> Self {
        Self {
            status: 0,
            code: "TRANSPORT".into(),
            message: error.to_string(),
        }
    }
}

/// Longest an RPC may take, connection through response body.
const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub async fn call<I, O>(net: &Net, path: &str, input: &I) -> Result<O, RpcError>
where
    I: Serialize + ?Sized,
    O: DeserializeOwned,
{
    let url = StackConfig::join(&net.config().api, &format!("/rpc/api/v1/{path}"));
    // Retry once with a fresh token when the cached one was rejected.
    for attempt in 0..2 {
        let token = net.token().await.map_err(RpcError::transport)?;
        let response = net
            .http()
            .post(url.clone())
            .bearer_auth(&token)
            .json(input)
            // Connection through response body: a stalled API must not leave a send pending.
            .timeout(RPC_TIMEOUT)
            .send()
            .await
            .map_err(RpcError::transport)?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            net.invalidate_token(&token).await;
            continue;
        }
        let body = response.bytes().await.map_err(RpcError::transport)?;
        if status.is_success() {
            return serde_json::from_slice(&body).map_err(|error| RpcError {
                status: status.as_u16(),
                code: "DECODE".into(),
                message: format!("{path}: {error}"),
            });
        }
        // oRPC errors are `{ defined, code, status, message, data }`.
        let detail: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        return Err(RpcError {
            status: status.as_u16(),
            code: detail
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("HTTP_ERROR")
                .to_owned(),
            message: detail
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned()),
        });
    }
    Err(RpcError {
        status: 401,
        code: "UNAUTHORIZED".into(),
        message: format!("{path}: token rejected twice"),
    })
}
