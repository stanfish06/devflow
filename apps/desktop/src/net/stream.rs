//! A session's durable stream (apps/web/src/hooks/useStreamDB.ts): conversation events plus the
//! live text deltas the agent streams before each event is saved.
//! Protocol: https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md
//! (5.6 catch-up reads, 5.8 SSE, 9.1 JSON mode).

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use serde_json::{Value, json};

use super::sse::SseParser;
use super::{Net, backoff, rpc};
use crate::config::StackConfig;

#[derive(Clone, Debug, PartialEq)]
pub enum StreamUpdate {
    /// Drop what was read: the stream restarted from its beginning.
    Reset,
    /// State-protocol messages: `{type, key, value, headers: {operation}}`.
    Items(Vec<Value>),
    /// Everything written so far has been read.
    UpToDate,
}

/// The API writes a session's saved events onto its stream before the stream can be read.
/// Like useStreamDB, retry NOT_FOUND while the session row is still arriving.
async fn hydrate(net: &Net, session_id: &str) -> Result<(), rpc::RpcError> {
    let mut delay = Duration::from_millis(150);
    let mut attempt = 0;
    loop {
        let result: Result<Value, _> = rpc::call(
            net,
            "durableStreams/sessions/getOrHydrate",
            &json!({ "sessionIds": [session_id] }),
        )
        .await;
        match result {
            Ok(_) => return Ok(()),
            Err(error) if error.code == "NOT_FOUND" && attempt < 10 => {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_millis(500));
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

enum Read {
    /// Continue from the new offset.
    Next,
    /// The stream is gone or was trimmed past our offset; hydrate and start over.
    Restart,
    /// The receiver was dropped or the stream closed for good.
    Stop,
    Failed(String),
}

pub fn subscribe_session(
    net: Arc<Net>,
    session_id: String,
) -> async_channel::Receiver<StreamUpdate> {
    let (sender, receiver) = async_channel::unbounded();
    let runner = net.clone();
    runner.spawn(async move {
        let url = StackConfig::join(
            &net.config().sync,
            &format!("/streams/sessions/{session_id}"),
        );
        let mut failures = 0u32;
        'session: loop {
            if sender.is_closed() {
                return;
            }
            if let Err(error) = hydrate(&net, &session_id).await {
                log::warn!("stream {session_id}: hydrate failed: {error}");
                tokio::time::sleep(backoff(failures)).await;
                failures += 1;
                continue;
            }
            let mut offset = String::from("-1");
            let mut caught_up = false;
            loop {
                let outcome = if caught_up {
                    read_sse(&net, &url, &mut offset, &sender).await
                } else {
                    read_catch_up(&net, &url, &mut offset, &mut caught_up, &sender).await
                };
                match outcome {
                    Read::Next => failures = 0,
                    Read::Stop => return,
                    Read::Restart => {
                        if sender.send(StreamUpdate::Reset).await.is_err() {
                            return;
                        }
                        continue 'session;
                    }
                    Read::Failed(error) => {
                        log::warn!("stream {session_id}: {error}");
                        tokio::time::sleep(backoff(failures)).await;
                        failures += 1;
                    }
                }
            }
        }
    });
    receiver
}

async fn authorized_get(
    net: &Net,
    url: &url::Url,
    query: &[(&str, &str)],
) -> Result<reqwest::Response, String> {
    let token = net.token().await.map_err(|e| format!("{e:#}"))?;
    let response = net
        .http()
        .get(url.clone())
        .query(query)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        net.invalidate_token().await;
        return Err("token rejected".into());
    }
    Ok(response)
}

/// One catch-up read (section 5.6): a JSON array of everything after `offset`, in chunks.
async fn read_catch_up(
    net: &Net,
    url: &url::Url,
    offset: &mut String,
    caught_up: &mut bool,
    sender: &async_channel::Sender<StreamUpdate>,
) -> Read {
    let response = match authorized_get(net, url, &[("offset", offset.as_str())]).await {
        Ok(response) => response,
        Err(error) => return Read::Failed(error),
    };
    match response.status().as_u16() {
        200 | 204 => {}
        404 | 410 => return Read::Restart,
        status => return Read::Failed(format!("catch-up HTTP {status}")),
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let next = header("stream-next-offset");
    let up_to_date = response.headers().contains_key("stream-up-to-date");
    let closed = header("stream-closed").as_deref() == Some("true");
    let body = match response.bytes().await {
        Ok(body) => body,
        Err(error) => return Read::Failed(error.to_string()),
    };
    let items: Vec<Value> = if body.is_empty() {
        Vec::new()
    } else {
        serde_json::from_slice(&body).unwrap_or_default()
    };
    if !items.is_empty() && sender.send(StreamUpdate::Items(items)).await.is_err() {
        return Read::Stop;
    }
    if let Some(next) = next {
        *offset = next;
    }
    if up_to_date || closed {
        *caught_up = true;
        if sender.send(StreamUpdate::UpToDate).await.is_err() || closed {
            return Read::Stop;
        }
    }
    Read::Next
}

/// Follow the stream over SSE (section 5.8) until the server ends the connection, about every minute.
async fn read_sse(
    net: &Net,
    url: &url::Url,
    offset: &mut String,
    sender: &async_channel::Sender<StreamUpdate>,
) -> Read {
    let response =
        match authorized_get(net, url, &[("offset", offset.as_str()), ("live", "sse")]).await {
            Ok(response) => response,
            Err(error) => return Read::Failed(error),
        };
    match response.status().as_u16() {
        200 => {}
        404 | 410 => return Read::Restart,
        status => return Read::Failed(format!("SSE HTTP {status}")),
    }
    let mut parser = SseParser::default();
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => return Read::Failed(error.to_string()),
        };
        for event in parser.push(&chunk) {
            match event.event.as_str() {
                "data" => {
                    let items: Vec<Value> = serde_json::from_str(&event.data).unwrap_or_default();
                    if !items.is_empty() && sender.send(StreamUpdate::Items(items)).await.is_err() {
                        return Read::Stop;
                    }
                }
                "control" => {
                    let control: Value = serde_json::from_str(&event.data).unwrap_or_default();
                    if let Some(next) = control.get("streamNextOffset").and_then(Value::as_str) {
                        *offset = next.to_owned();
                    }
                    if control.get("upToDate") == Some(&Value::Bool(true))
                        && sender.send(StreamUpdate::UpToDate).await.is_err()
                    {
                        return Read::Stop;
                    }
                    if control.get("streamClosed") == Some(&Value::Bool(true)) {
                        return Read::Stop;
                    }
                }
                _ => {}
            }
        }
    }
    Read::Next
}
