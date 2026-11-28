//! Electric shape subscription through the sync proxy (packages/sync, apps/sync-proxy/src/routes/v2.ts).
//! The proxy sets the table and the organization filter; the client sends only Electric's
//! protocol parameters: `offset`, `handle`, `live` and `cursor`.
//! Protocol: https://electric-sql.com/docs/api/http

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::{Net, backoff};
use crate::config::StackConfig;
use crate::model::rows::ShapeOp;

#[derive(Clone, Debug, PartialEq)]
pub enum ShapeUpdate {
    /// Drop local rows: the server asked for a resync (`must-refetch` or 409).
    Reset,
    Ops(Vec<ShapeOp>),
    /// The client holds everything the server had when it answered.
    UpToDate,
}

/// Follow a shape until the receiver is dropped. `route` is a sync-proxy path such as `/v2/sessions`.
pub fn subscribe(net: Arc<Net>, route: &'static str) -> async_channel::Receiver<Vec<ShapeUpdate>> {
    let (sender, receiver) = async_channel::unbounded();
    let runner = net.clone();
    runner.spawn(async move {
        let url = StackConfig::join(&net.config().sync, route);
        let mut offset = String::from("-1");
        let mut handle: Option<String> = None;
        let mut cursor: Option<String> = None;
        let mut live = false;
        let mut failures = 0u32;
        loop {
            if sender.is_closed() {
                return;
            }
            let mut request = net
                .http()
                .get(url.clone())
                .query(&[("offset", offset.as_str())]);
            if let Some(handle) = &handle {
                request = request.query(&[("handle", handle.as_str())]);
            }
            if live {
                request = request
                    .query(&[("live", "true")])
                    .timeout(Duration::from_secs(90));
                if let Some(cursor) = &cursor {
                    request = request.query(&[("cursor", cursor.as_str())]);
                }
            } else {
                request = request.timeout(Duration::from_secs(60));
            }
            let token = match net.token().await {
                Ok(token) => token,
                Err(error) => {
                    log::warn!("shape {route}: {error:#}");
                    tokio::time::sleep(backoff(failures)).await;
                    failures += 1;
                    continue;
                }
            };
            let response = match request.bearer_auth(token).send().await {
                Ok(response) => response,
                Err(error) => {
                    log::warn!("shape {route}: {error}");
                    tokio::time::sleep(backoff(failures)).await;
                    failures += 1;
                    continue;
                }
            };
            let status = response.status();
            if status == reqwest::StatusCode::CONFLICT {
                (offset, handle, cursor, live) = (String::from("-1"), None, None, false);
                if sender.send(vec![ShapeUpdate::Reset]).await.is_err() {
                    return;
                }
                continue;
            }
            if status == reqwest::StatusCode::UNAUTHORIZED {
                net.invalidate_token().await;
                tokio::time::sleep(backoff(failures)).await;
                failures += 1;
                continue;
            }
            if !status.is_success() {
                log::warn!("shape {route}: HTTP {status}");
                tokio::time::sleep(backoff(failures)).await;
                failures += 1;
                continue;
            }
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned)
            };
            // The new position is committed only once its rows are decoded, so a body that fails
            // to arrive or parse is fetched again from the old offset.
            let (next_offset, next_handle, next_cursor) = (
                header("electric-offset"),
                header("electric-handle"),
                header("electric-cursor"),
            );
            let header_up_to_date = response.headers().contains_key("electric-up-to-date");
            let messages: Vec<Value> = match response.bytes().await {
                Ok(body) if body.is_empty() => Vec::new(),
                Ok(body) => match serde_json::from_slice(&body) {
                    Ok(messages) => messages,
                    Err(error) => {
                        log::warn!("shape {route}: undecodable body: {error}");
                        tokio::time::sleep(backoff(failures)).await;
                        failures += 1;
                        continue;
                    }
                },
                Err(error) => {
                    log::warn!("shape {route}: {error}");
                    tokio::time::sleep(backoff(failures)).await;
                    failures += 1;
                    continue;
                }
            };
            failures = 0;
            if let Some(next) = next_offset {
                offset = next;
            }
            if let Some(next) = next_handle {
                handle = Some(next);
            }
            if let Some(next) = next_cursor {
                cursor = Some(next);
            }
            let (updates, must_refetch, up_to_date) = translate(messages);
            if must_refetch {
                (offset, handle, cursor, live) = (String::from("-1"), None, None, false);
                if sender.send(vec![ShapeUpdate::Reset]).await.is_err() {
                    return;
                }
                continue;
            }
            let mut batch = updates;
            if up_to_date || header_up_to_date {
                live = true;
                batch.push(ShapeUpdate::UpToDate);
            }
            if !batch.is_empty() && sender.send(batch).await.is_err() {
                return;
            }
        }
    });
    receiver
}

/// Turn one response body into updates, and report `must-refetch` and `up-to-date` controls.
pub fn translate(messages: Vec<Value>) -> (Vec<ShapeUpdate>, bool, bool) {
    let mut ops = Vec::new();
    let mut must_refetch = false;
    let mut up_to_date = false;
    for message in messages {
        let headers = message.get("headers");
        match headers
            .and_then(|h| h.get("control"))
            .and_then(Value::as_str)
        {
            Some("must-refetch") => must_refetch = true,
            Some("up-to-date") => up_to_date = true,
            Some(_) => {}
            None => {
                let Some(key) = message
                    .get("key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let value = message
                    .get("value")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                match headers
                    .and_then(|h| h.get("operation"))
                    .and_then(Value::as_str)
                {
                    Some("insert") => ops.push(ShapeOp::Insert { key, value }),
                    Some("update") => ops.push(ShapeOp::Update { key, value }),
                    Some("delete") => ops.push(ShapeOp::Delete { key }),
                    _ => {}
                }
            }
        }
    }
    let updates = if ops.is_empty() {
        Vec::new()
    } else {
        vec![ShapeUpdate::Ops(ops)]
    };
    (updates, must_refetch, up_to_date)
}
