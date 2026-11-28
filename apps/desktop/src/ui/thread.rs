//! One session's thread, ported from apps/web/src/minimalist/components/ThreadView.tsx:
//! the transcript, the card for whatever the agent waits on, queued messages and the composer.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, IconName, Sizable as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use crate::model::format::{artifact_name, basename, split_attachments};
use crate::model::rows::{Approval, Session};
use crate::model::thread::SessionStream;
use crate::model::tools::{is_edit_tool, text_field, turn_file_writes};
use crate::model::transcript::{EventRow, ToolStep, Turn, normalize_tool_name};
use crate::net::stream::{self, StreamUpdate};
use crate::net::{Net, now_ms, rpc};
use crate::store::Store;
use crate::ui::turns::{RowContext, ThreadRow, column, diff_card, render_row};
use crate::ui::web::WebActions;

/// Denying an approval with feedback: the composer's next message is the reason.
struct Denial {
    approval_id: String,
    what: String,
}

/// Answers to an AskUserQuestion approval, one question at a time.
struct QuestionState {
    approval_id: String,
    index: usize,
    answers: HashMap<usize, Vec<String>>,
    other: Entity<InputState>,
}

#[derive(Clone, Debug, PartialEq)]
struct Question {
    question: String,
    header: Option<String>,
    multi_select: bool,
    options: Vec<(String, Option<String>)>,
}

fn read_questions(input: &serde_json::Map<String, Value>) -> Vec<Question> {
    let Some(questions) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    questions
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|question| {
            Some(Question {
                question: question.get("question")?.as_str()?.to_owned(),
                header: question
                    .get("header")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                multi_select: question
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                options: question
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(|option| {
                                let label = option.get("label")?.as_str()?.to_owned();
                                Some((
                                    label,
                                    option
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// A standing "always allow" rule in words, e.g. `Bash(bun test:*)`, from the approval's suggestions.
fn rule_text(suggestions: &Value) -> Option<String> {
    let rule = suggestions
        .as_array()?
        .iter()
        .find(|update| update.get("type").and_then(Value::as_str) == Some("addRules"))?;
    let first = rule.get("rules")?.as_array()?.first()?;
    first
        .get("ruleContent")
        .and_then(Value::as_str)
        .or_else(|| first.get("toolName").and_then(Value::as_str))
        .map(str::to_owned)
}

/// What the thread asks of the window around it.
pub enum ThreadEvent {
    /// Open the `occurrence`-th attachment (0-based, in transcript order) shown as `name`. Names
    /// repeat across uploads, so the position picks the exact one.
    OpenAttachment { name: String, occurrence: usize },
    /// Open Review from edits card `card` (in transcript order), at `path` when given.
    Review { card: usize, path: Option<String> },
    /// Fork from sent user turn `turn` (in transcript order).
    Fork { turn: usize },
    /// The reading position moved: turn at the top (`None` at the end) and pixels into it.
    ScrollAnchor { turn: Option<usize>, offset: f32 },
}

/// Tries per saved-rows fetch, with network backoff between them.
const SAVED_FETCH_ATTEMPTS: u32 = 5;
/// Rows per `sync/v2/conversationEvents` page; the endpoint caps a page at 10,000.
const SAVED_PAGE_SIZE: usize = 5_000;

/// Every saved row of a session, page by page in a stable order (time, then id), so a long
/// session's newest rows are never cut off by the page limit.
async fn fetch_saved_rows(net: &Net, session_id: &str) -> Result<Vec<Value>, rpc::RpcError> {
    let sort = |field: &str| json!({ "field": [field], "direction": "asc", "nulls": "last" });
    let mut rows = Vec::new();
    loop {
        let input = json!({
            "where": {
                "type": "comparison",
                "field": ["session_id"],
                "operator": "eq",
                "value": session_id,
            },
            "sorts": [sort("created_at"), sort("id")],
            "limit": SAVED_PAGE_SIZE,
            "offset": rows.len(),
        });
        let page: Value = rpc::call(net, "sync/v2/conversationEvents", &input).await?;
        let page = page
            .get("rows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let last = page.len() < SAVED_PAGE_SIZE;
        rows.extend(page);
        if last {
            return Ok(rows);
        }
    }
}

pub struct ThreadView {
    /// Draw the titlebar and dock (composer, approvals, queue). Off inside the web app, where the
    /// page draws those and this view covers only the transcript.
    chrome: bool,
    session_id: Option<String>,
    store: Entity<Store>,
    net: Arc<Net>,
    stream: SessionStream,
    turns: Vec<Rc<Turn>>,
    /// What the page lets the native rows forward to it.
    web_actions: WebActions,
    /// The last reading position reported.
    anchor: Option<(Option<usize>, f32)>,
    /// Each turn's last build and its content version, by turn id.
    turn_versions: HashMap<String, (Rc<Turn>, u64)>,
    turns_revision: u64,
    rows: Rc<Vec<ThreadRow>>,
    row_marks: Vec<(String, u64)>,
    /// The rem size of the last render, to remeasure rows after a zoom change.
    rem_key: Option<u32>,
    scroller: Entity<MessageScrollerState>,
    streaming: Entity<TextViewState>,
    streamed: String,
    toggled: Rc<HashMap<String, bool>>,
    composer: Entity<TextareaState>,
    denying: Option<Denial>,
    question: Option<QuestionState>,
    ask_focus: FocusHandle,
    /// The approval last offered to the reader, to claim focus once per new card.
    offered_approval: Option<String>,
    resolving: bool,
    sending: bool,
    _stream: Task<()>,
    /// The session's (status, activity) when saved rows were last fetched.
    saved_mark: Option<String>,
    /// A saved-rows fetch is under way.
    fetching: bool,
    /// Another fetch was asked for during it.
    refetch: bool,
    _saved: Task<()>,
    _request: Task<()>,
    _ticker: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl ThreadView {
    /// The thread of one session; the web page says which session its column shows.
    pub fn new(session_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = Store::global(cx);
        let net = store.read(cx).net();
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let streaming = cx.new(|cx| TextViewState::markdown("", cx));
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 10)
                .submit_on_enter(true)
                .placeholder("Ask for follow-up changes")
        });
        let subscriptions = vec![
            cx.observe(&scroller, |this, _, cx| {
                this.publish_anchor(cx);
                cx.notify()
            }),
            cx.observe_in(&store, window, |this, _, window, cx| {
                this.on_store_changed(window, cx)
            }),
            cx.subscribe_in(
                &composer,
                window,
                |this, _, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { shift: false, .. } = event {
                        this.submit(window, cx);
                    }
                },
            ),
        ];
        // Re-render once a second while the agent works, for "Working for 12s".
        let ticker = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let alive = this.update(cx, |this, cx| {
                    if this.session(cx).is_some_and(|session| session.is_busy()) {
                        this.rebuild_rows(cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        let mut this = Self {
            chrome: false,
            session_id: None,
            store,
            net,
            stream: SessionStream::default(),
            turns: Vec::new(),
            web_actions: WebActions::default(),
            anchor: None,
            turn_versions: HashMap::new(),
            turns_revision: u64::MAX,
            rows: Rc::new(Vec::new()),
            row_marks: Vec::new(),
            rem_key: None,
            scroller,
            streaming,
            streamed: String::new(),
            toggled: Rc::new(HashMap::new()),
            composer,
            denying: None,
            question: None,
            ask_focus: cx.focus_handle(),
            offered_approval: None,
            resolving: false,
            sending: false,
            _stream: Task::ready(()),
            saved_mark: None,
            fetching: false,
            refetch: false,
            _saved: Task::ready(()),
            _request: Task::ready(()),
            _ticker: ticker,
            _subscriptions: subscriptions,
        };
        this.start_stream(session_id, cx);
        this.on_store_changed(window, cx);
        this
    }

    fn session(&self, cx: &App) -> Option<Session> {
        self.session_id
            .as_deref()
            .and_then(|id| self.store.read(cx).session(id))
    }

    fn on_store_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // A follow-up moves the session to running and back, so a changed row means new saved rows.
        let mark = self.session_mark(cx);
        if mark.is_some() && mark != self.saved_mark {
            self.fetch_saved(cx);
        }
        // Take keyboard focus for a new card unless the reader is partway through a message.
        let first_pending = self
            .session_id
            .as_deref()
            .and_then(|id| self.store.read(cx).pending_approvals(id).into_iter().next());
        let pending_id = first_pending.as_ref().map(|approval| approval.id.clone());
        if pending_id != self.offered_approval {
            self.offered_approval = pending_id.clone();
            self.question = None;
            // Inside the web app the page draws the approval card and manages its focus.
            if self.chrome
                && pending_id.is_some()
                && self.composer.read(cx).value().trim().is_empty()
            {
                window.focus(&self.ask_focus, cx);
            }
        }
        self.sync_placeholder(window, cx);
        self.rebuild_rows(cx);
    }

    /// The composer says what sending will do: queue, deny with feedback, or send.
    fn sync_placeholder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let session = self.session(cx);
        let placeholder = if self.denying.is_some() {
            "Tell the agent what to do instead"
        } else if session
            .as_ref()
            .is_some_and(|s| s.status == "waiting_for_workspace")
        {
            "Queue a message. It sends after setup succeeds."
        } else if session.as_ref().is_some_and(Session::is_busy) {
            "Queue a follow-up. It sends when the agent finishes."
        } else {
            "Ask for follow-up changes"
        };
        self.composer.update(cx, |state, cx| {
            state.set_placeholder(placeholder, window, cx)
        });
    }

    fn start_stream(&mut self, session_id: String, cx: &mut Context<Self>) {
        self.session_id = Some(session_id.clone());
        let receiver = stream::subscribe_session(self.net.clone(), session_id);
        self._stream = cx.spawn(async move |this, cx| {
            while let Ok(first) = receiver.recv().await {
                // Coalesce a burst of deltas into one rebuild.
                let mut updates = vec![first];
                while let Ok(more) = receiver.try_recv() {
                    updates.push(more);
                }
                let applied = this.update(cx, |this, cx| {
                    for update in updates {
                        match update {
                            StreamUpdate::Reset => {
                                this.stream.reset();
                                this.fetch_saved(cx);
                            }
                            StreamUpdate::Items(items) => this.stream.apply(&items),
                            StreamUpdate::UpToDate => this.stream.set_ready(),
                        }
                    }
                    this.rebuild_rows(cx);
                });
                if applied.is_err() {
                    break;
                }
            }
        });
    }

    /// Fetch the session's saved rows and merge in the ones the stream lacks (follow-up messages).
    fn fetch_saved(&mut self, cx: &mut Context<Self>) {
        // One fetch at a time: asks during one become a single fetch after it, so a busy session
        // (its activity changes with every saved event) doesn't pile up full-history downloads.
        if self.fetching {
            self.refetch = true;
            return;
        }
        let mark = self.session_mark(cx);
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        self.fetching = true;
        let net = self.net.clone();
        self._saved = cx.spawn(async move |this, cx| {
            let mut output = None;
            for attempt in 0..SAVED_FETCH_ATTEMPTS {
                let request = net.spawn({
                    let (net, session_id) = (net.clone(), session_id.clone());
                    async move { fetch_saved_rows(&net, &session_id).await }
                });
                // Dropping this task (the view closed) cancels the download, not just the wait.
                let _cancel = crate::net::AbortOnDrop(request.abort_handle());
                match request.await {
                    Ok(Ok(rows)) => {
                        output = Some(rows);
                        break;
                    }
                    Ok(Err(error)) => log::warn!("saved events: {error}"),
                    Err(error) => log::warn!("saved events task: {error}"),
                }
                cx.background_executor()
                    .timer(crate::net::backoff(attempt))
                    .await;
            }
            let _ = this.update(cx, |this, cx| {
                this.fetching = false;
                if let Some(output) = output {
                    let rows: Vec<EventRow> = output
                        .iter()
                        .filter_map(Value::as_object)
                        .filter_map(EventRow::from_saved_row)
                        .collect();
                    this.saved_mark = mark;
                    this.stream.merge_saved(rows);
                    this.rebuild_rows(cx);
                }
                // Out of attempts, nothing is retried until the session row changes again.
                if std::mem::take(&mut this.refetch) {
                    this.fetch_saved(cx);
                }
            });
        });
    }

    /// The session's status. Saved-only rows are follow-up messages, and sending one moves the
    /// session to running and back, so a status change is when to look; agent events, which move
    /// its activity time, already arrive on the stream.
    fn session_mark(&self, cx: &App) -> Option<String> {
        self.session(cx).map(|session| session.status.clone())
    }

    /// Recompute the rows and tell the virtual list which ones moved or changed.
    fn rebuild_rows(&mut self, cx: &mut Context<Self>) {
        if self.turns_revision != self.stream.events_revision() {
            // A turn equal to its last build keeps its shared value and version; any change, even
            // one that keeps every text the same length, bumps the version so its row remeasures.
            let mut versions = HashMap::new();
            self.turns = self
                .stream
                .turns()
                .into_iter()
                .map(|turn| {
                    let key = turn.id().to_owned();
                    let (shared, version) = match self.turn_versions.get(&key) {
                        Some((previous, version)) if **previous == turn => {
                            (Rc::clone(previous), *version)
                        }
                        Some((_, version)) => (Rc::new(turn), version + 1),
                        None => (Rc::new(turn), 0),
                    };
                    versions.insert(key, (Rc::clone(&shared), version));
                    shared
                })
                .collect();
            self.turn_versions = versions;
            self.turns_revision = self.stream.events_revision();
        }
        let session = self.session(cx);
        let running = session
            .as_ref()
            .is_some_and(|s| s.is_busy() && s.status != "waiting_for_workspace");
        // A notice recorded mid-run sits after the running turn without ending it.
        let current = self
            .turns
            .iter()
            .rposition(|turn| !matches!(turn.as_ref(), Turn::Notice { .. }));
        // Positions among the page's own user turns and edits cards, which the native rows use to
        // forward Fork and Review to the matching page element.
        let (mut users, mut cards) = (0, 0);
        let mut rows: Vec<ThreadRow> = self
            .turns
            .iter()
            .enumerate()
            .map(|(index, turn)| {
                let live = running && Some(index) == current;
                let ordinal = match turn.as_ref() {
                    Turn::User { .. } => {
                        users += 1;
                        Some(users - 1)
                    }
                    // Transcript.tsx shows EditsSummary for a finished turn whose edits changed lines.
                    Turn::Agent(agent)
                        if !live
                            && turn_file_writes(&agent.steps)
                                .iter()
                                .any(|file| file.added + file.removed > 0) =>
                    {
                        cards += 1;
                        Some(cards - 1)
                    }
                    _ => None,
                };
                ThreadRow::Turn {
                    turn: Rc::clone(turn),
                    live,
                    ordinal,
                }
            })
            .collect();
        let live_text: Vec<String> = self
            .stream
            .live_text()
            .iter()
            .map(|block| block.text())
            .collect();
        let streamed = live_text.join("\n\n");
        if !streamed.is_empty() {
            rows.push(ThreadRow::Streaming);
        } else if running
            && !matches!(
                current.map(|index| self.turns[index].as_ref()),
                Some(Turn::Agent(_))
            )
        {
            rows.push(ThreadRow::Starting);
        }
        if streamed != self.streamed {
            let appended = streamed
                .strip_prefix(self.streamed.as_str())
                .map(str::to_owned);
            self.streaming.update(cx, |state, cx| match appended {
                Some(suffix) if !self.streamed.is_empty() => state.push_str(&suffix, cx),
                _ => state.set_text(&streamed, cx),
            });
            self.streamed = streamed;
        }

        // The streaming row grows as text arrives; its length makes the list remeasure it.
        let marks: Vec<(String, u64)> = rows
            .iter()
            .map(|row| match row {
                ThreadRow::Streaming => (row.key(), self.streamed.len() as u64),
                ThreadRow::Turn { turn, live, .. } => {
                    let version = self.turn_versions.get(turn.id()).map_or(0, |entry| entry.1);
                    let mut hasher = DefaultHasher::new();
                    (version, live).hash(&mut hasher);
                    (row.key(), hasher.finish())
                }
                ThreadRow::Starting => (row.key(), 0),
            })
            .collect();
        let old = std::mem::take(&mut self.row_marks);
        let common = old
            .iter()
            .zip(&marks)
            .take_while(|(a, b)| a.0 == b.0)
            .count();
        self.scroller.update(cx, |scroller, cx| {
            if common < old.len() || marks.len() > common {
                scroller.splice(common..old.len(), marks.len() - common, cx);
            }
            for index in 0..common {
                if old[index].1 != marks[index].1 {
                    scroller.remeasure_items(index..index + 1, cx);
                }
            }
        });
        self.row_marks = marks;
        self.rows = Rc::new(rows);
        cx.notify();
    }

    /// Report the reading position when it changes, for the page's transcript to match.
    fn publish_anchor(&mut self, cx: &mut Context<Self>) {
        let scroller = self.scroller.read(cx);
        let top = scroller.logical_scroll_top();
        // Rows past the turns (streaming, starting) and tail following both mean the end.
        let anchor = if scroller.is_following_tail() || top.item_ix >= self.turns.len() {
            (None, 0.)
        } else {
            (Some(top.item_ix), f32::from(top.offset_in_item))
        };
        if self.anchor != Some(anchor) {
            self.anchor = Some(anchor);
            cx.emit(ThreadEvent::ScrollAnchor {
                turn: anchor.0,
                offset: anchor.1,
            });
        }
    }

    /// The page's transcript actions changed; rows gain or lose their buttons.
    pub fn set_web_actions(&mut self, actions: WebActions, cx: &mut Context<Self>) {
        if self.web_actions != actions {
            self.web_actions = actions;
            self.scroller
                .update(cx, |scroller, cx| scroller.remeasure(cx));
            cx.notify();
        }
    }

    /// Open file `index` of user turn `turn_id`.
    pub fn open_attachment(&mut self, turn_id: &str, index: usize, cx: &mut Context<Self>) {
        let mut seen: Vec<String> = Vec::new();
        for turn in &self.turns {
            let Turn::User { id, text, .. } = turn.as_ref() else {
                continue;
            };
            let names: Vec<String> = split_attachments(text)
                .1
                .iter()
                .map(|file| artifact_name(file))
                .collect();
            if id == turn_id {
                let Some(name) = names.get(index).cloned() else {
                    return;
                };
                let occurrence = seen
                    .iter()
                    .chain(&names[..index])
                    .filter(|seen| **seen == name)
                    .count();
                cx.emit(ThreadEvent::OpenAttachment { name, occurrence });
                return;
            }
            seen.extend(names);
        }
    }

    /// Record the reader's open or closed choice for a turn or step.
    pub fn set_open(&mut self, id: &str, open: bool, cx: &mut Context<Self>) {
        Rc::make_mut(&mut self.toggled).insert(id.to_owned(), open);
        // Open state changes row heights; remeasure keeps the reading position.
        self.scroller
            .update(cx, |scroller, cx| scroller.remeasure(cx));
        cx.notify();
    }

    fn notify_error(window: &mut Window, message: &str, cx: &mut App) {
        window.push_notification(Notification::error(message.to_owned()), cx);
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session(cx) else {
            return;
        };
        let text = self.composer.read(cx).value().trim().to_owned();
        if text.is_empty() || self.sending {
            return;
        }
        self.sending = true;
        // Clear right away; the round trip takes a moment and the text comes back if it fails.
        self.composer
            .update(cx, |state, cx| state.set_value("", window, cx));
        let net = self.net.clone();
        let request = if let Some(denial) = &self.denying {
            let input =
                json!({ "approvalId": denial.approval_id, "decision": "deny", "comment": text });
            net.spawn({
                let net = net.clone();
                async move {
                    rpc::call::<_, Value>(&net, "approvals/resolve", &input)
                        .await
                        .map(|_| ())
                }
            })
        } else {
            let intent = if session.is_busy() { "queue" } else { "send" };
            let input = json!({
                "sessionId": session.id,
                "messageId": uuid::Uuid::now_v7().to_string(),
                "eventId": uuid::Uuid::now_v7().to_string(),
                "text": text,
                "intent": intent,
            });
            net.spawn({
                let net = net.clone();
                async move {
                    let result: Value = rpc::call(&net, "sessions/v2/continue", &input).await?;
                    if result.get("kind").and_then(Value::as_str) == Some("rejected") {
                        let reason = result
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("rejected");
                        return Err(rpc::RpcError {
                            status: 0,
                            code: "REJECTED".into(),
                            message: reason.into(),
                        });
                    }
                    Ok(())
                }
            })
        };
        self._request = cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.sending = false;
                match result {
                    Ok(Ok(())) => {
                        this.denying = None;
                        this.sync_placeholder(window, cx);
                        // The API saved the message before answering; show it now.
                        this.fetch_saved(cx);
                    }
                    Ok(Err(error)) => {
                        log::warn!("send failed: {error}");
                        this.restore_draft(&text, window, cx);
                        Self::notify_error(
                            window,
                            "Could not send. Your message is still in the composer.",
                            cx,
                        );
                    }
                    Err(error) => {
                        log::warn!("send task failed: {error}");
                        this.restore_draft(&text, window, cx);
                    }
                }
                cx.notify();
            });
        });
        cx.notify();
    }

    fn restore_draft(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.composer.read(cx).value().trim().is_empty() {
            self.composer
                .update(cx, |state, cx| state.set_value(text.to_owned(), window, cx));
        }
    }

    fn stop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let net = self.net.clone();
        let request = net.spawn({
            let net = net.clone();
            async move {
                rpc::call::<_, Value>(
                    &net,
                    "sessions/interrupt",
                    &json!({ "sessionId": session_id }),
                )
                .await
            }
        });
        self._request = cx.spawn_in(window, async move |this, cx| {
            if !matches!(request.await, Ok(Ok(_))) {
                let _ = this.update_in(cx, |_, window, cx| {
                    Self::notify_error(
                        window,
                        "Could not stop the agent. Check the session and try again.",
                        cx,
                    )
                });
            }
        });
    }

    fn resolve(
        &mut self,
        approval_id: String,
        decision: &'static str,
        extra: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.resolving {
            return;
        }
        self.resolving = true;
        let mut input = json!({ "approvalId": approval_id, "decision": decision });
        if let (Value::Object(target), Value::Object(fields)) = (&mut input, extra) {
            target.extend(fields);
        }
        let net = self.net.clone();
        let request = net.spawn({
            let net = net.clone();
            async move { rpc::call::<_, Value>(&net, "approvals/resolve", &input).await }
        });
        self._request = cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.resolving = false;
                if !matches!(result, Ok(Ok(_))) {
                    Self::notify_error(
                        window,
                        "Could not send your answer. The agent is still waiting.",
                        cx,
                    );
                }
                cx.notify();
            });
        });
        cx.notify();
    }

    fn deny_with_feedback(
        &mut self,
        approval_id: String,
        what: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.denying = Some(Denial { approval_id, what });
        self.sync_placeholder(window, cx);
        let composer = self.composer.read(cx).focus_handle(cx);
        window.focus(&composer, cx);
        cx.notify();
    }

    /// ThreadView's titlebar inside a task (minimalist/components/ThreadView.tsx, `taskManaged`).
    fn render_titlebar(
        &self,
        session: Option<&Session>,
        _cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let title = session.map(Session::name).unwrap_or_default();
        h_flex()
            .w_full()
            .h(px(44.))
            .px(px(14.))
            .gap(px(10.))
            .flex_none()
            .child(
                div()
                    .min_w(px(50.))
                    .text_ellipsis()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .font_weight(FontWeight::MEDIUM)
                    .child(title),
            )
            .child(div().flex_1())
    }

    fn render_ask(
        &mut self,
        approval: &Approval,
        total: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let name = normalize_tool_name(approval.tool_name.as_deref().unwrap_or(""));
        let busy = self.resolving;
        let card = v_flex()
            .id("ask")
            .track_focus(&self.ask_focus)
            .w_full()
            .p_3()
            .gap_2()
            .rounded(theme.radius)
            .border_1()
            .border_color(theme.border)
            .bg(theme.background);

        if name == "askuserquestion" {
            return self.render_question(approval, card, window, cx);
        }
        if name == "exitplanmode" {
            let id = approval.id.clone();
            let deny_id = approval.id.clone();
            return card
                .child(
                    h_flex()
                        .gap_2()
                        .child(IconName::BookOpen)
                        .child("Ready to build this plan?"),
                )
                .child(
                    div().max_h(px(320.)).overflow_y_scrollbar().child(
                        TextView::markdown(
                            SharedString::from(format!("plan-{}", approval.id)),
                            text_field(&approval.tool_input, &["plan"]),
                        )
                        .selectable(true),
                    ),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("keep-planning")
                                .label("Keep planning")
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.deny_with_feedback(
                                        deny_id.clone(),
                                        "the plan".into(),
                                        window,
                                        cx,
                                    )
                                })),
                        )
                        .child(div().flex_1())
                        .child(
                            Button::new("build-it")
                                .primary()
                                .label("Build it")
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.resolve(id.clone(), "approve", json!({}), window, cx)
                                })),
                        ),
                )
                .into_any_element();
        }

        let is_edit = is_edit_tool(approval.tool_name.as_deref().unwrap_or(""));
        let target = text_field(&approval.tool_input, &["file_path", "path"]);
        let what = if is_edit {
            format!("edit to {}", basename(&target))
        } else {
            "command".to_owned()
        };
        let question = if name == "bash" {
            "Run this command?".to_owned()
        } else if is_edit {
            format!("Edit {}?", basename(&target))
        } else {
            format!("Use {}?", approval.tool_name.clone().unwrap_or_default())
        };
        let rule = rule_text(&approval.suggestions);
        let (approve_id, deny_id, allow_id) = (
            approval.id.clone(),
            approval.id.clone(),
            approval.id.clone(),
        );
        let deny_what = what.clone();
        let suggestions = approval.suggestions.clone();
        let edit_step = ToolStep {
            id: approval.id.clone(),
            tool_call_id: approval.id.clone(),
            name: approval.tool_name.clone().unwrap_or_else(|| "Edit".into()),
            input: approval.tool_input.clone(),
            result: None,
            is_error: false,
            approval_status: None,
            approval_id: Some(approval.id.clone()),
            started_at: 0,
            ended_at: None,
            children: Vec::new(),
        };
        let command = text_field(&approval.tool_input, &["command"]);
        card.on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            let keystroke = &event.keystroke;
            if this.resolving
                || keystroke.modifiers.platform
                || keystroke.modifiers.control
                || keystroke.modifiers.alt
            {
                return;
            }
            match keystroke.key.as_str() {
                "enter" => this.resolve(approve_id.clone(), "approve", json!({}), window, cx),
                "d" => this.deny_with_feedback(deny_id.clone(), deny_what.clone(), window, cx),
                _ => return,
            }
            cx.stop_propagation();
        }))
        .child(
            h_flex()
                .gap_2()
                .child(if is_edit {
                    IconName::FileText
                } else {
                    IconName::SquareTerminal
                })
                .child(question)
                .when(total > 1, |this| {
                    this.child(
                        div()
                            .text_color(theme.muted_foreground)
                            .child(format!("· 1 of {total}")),
                    )
                }),
        )
        .when(name == "bash", |this| {
            this.child(
                div()
                    .max_h(px(200.))
                    .overflow_y_scrollbar()
                    .p_2()
                    .rounded(theme.radius)
                    .bg(theme.muted)
                    .font_family(theme.mono_font_family.clone())
                    .text_sm()
                    .child(command.clone()),
            )
        })
        .when(is_edit, |this| {
            this.child(
                div()
                    .max_h(px(240.))
                    .overflow_y_scrollbar()
                    .child(diff_card(&edit_step, cx)),
            )
        })
        .when(name != "bash" && !is_edit, |this| {
            this.child(
                div()
                    .max_h(px(200.))
                    .overflow_y_scrollbar()
                    .p_2()
                    .rounded(theme.radius)
                    .bg(theme.muted)
                    .font_family(theme.mono_font_family.clone())
                    .text_xs()
                    .child(
                        serde_json::to_string_pretty(&Value::Object(approval.tool_input.clone()))
                            .unwrap_or_default(),
                    ),
            )
        })
        .child({
            let deny = approval.id.clone();
            h_flex()
                .gap_2()
                .child(
                    Button::new("deny")
                        .label("Deny  D")
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.deny_with_feedback(deny.clone(), what.clone(), window, cx)
                        })),
                )
                .child(div().flex_1())
                .when_some(rule.filter(|_| suggestions.is_array()), |this, rule| {
                    let label = if rule == command {
                        "Always allow this command".to_owned()
                    } else {
                        format!("Always allow {rule}")
                    };
                    this.child(
                        Button::new("always-allow")
                            .ghost()
                            .label(label)
                            .disabled(busy)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.resolve(
                                    allow_id.clone(),
                                    "approve",
                                    json!({ "appliedSuggestions": suggestions.clone() }),
                                    window,
                                    cx,
                                )
                            })),
                    )
                })
                .child(
                    Button::new("approve")
                        .primary()
                        .label("Approve  ⏎")
                        .disabled(busy)
                        .on_click(cx.listener({
                            let id = approval.id.clone();
                            move |this, _, window, cx| {
                                this.resolve(id.clone(), "approve", json!({}), window, cx)
                            }
                        })),
                )
        })
        .into_any_element()
    }

    fn render_question(
        &mut self,
        approval: &Approval,
        card: Stateful<Div>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let questions = read_questions(&approval.tool_input);
        if self
            .question
            .as_ref()
            .map(|state| state.approval_id.as_str())
            != Some(approval.id.as_str())
        {
            let other = cx.new(|cx| InputState::new(window, cx).placeholder("Something else"));
            self.question = Some(QuestionState {
                approval_id: approval.id.clone(),
                index: 0,
                answers: HashMap::new(),
                other,
            });
        }
        let state = self.question.as_ref().expect("set above");
        let Some(question) = questions.get(state.index).cloned() else {
            return div().into_any_element();
        };
        let theme = cx.theme().clone();
        let selected = state.answers.get(&state.index).cloned().unwrap_or_default();
        let other_text = state.other.read(cx).value().trim().to_owned();
        let is_last = state.index + 1 == questions.len();
        let can_continue = !self.resolving && (!selected.is_empty() || !other_text.is_empty());
        let index = state.index;
        let count = questions.len();
        let approval_id = approval.id.clone();
        card.child(
            h_flex()
                .gap_2()
                .child(IconName::Inbox)
                .child(question.question.clone()),
        )
        .when_some(question.header.clone(), |this, header| {
            this.child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(header),
            )
        })
        .children(question.options.iter().enumerate().map(
            |(option_index, (label, description))| {
                let picked = selected.contains(label);
                let label_for_click = label.clone();
                let multi = question.multi_select;
                h_flex()
                    .id(SharedString::from(format!("option-{option_index}")))
                    .gap_3()
                    .p_2()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(if picked { theme.primary } else { theme.border })
                    .cursor_default()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(state) = this.question.as_mut() {
                            let answers = state.answers.entry(state.index).or_default();
                            if multi {
                                if let Some(at) = answers.iter().position(|a| a == &label_for_click)
                                {
                                    answers.remove(at);
                                } else {
                                    answers.push(label_for_click.clone());
                                }
                            } else {
                                *answers = vec![label_for_click.clone()];
                            }
                        }
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_color(theme.muted_foreground)
                            .child((option_index + 1).to_string()),
                    )
                    .child(v_flex().child(label.clone()).when_some(
                        description.clone(),
                        |this, d| {
                            this.child(div().text_sm().text_color(theme.muted_foreground).child(d))
                        },
                    ))
            },
        ))
        .child(Input::new(&state.other))
        .child(
            h_flex()
                .gap_2()
                .when(count > 1, |this| {
                    this.child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(format!("{} of {count} questions", index + 1)),
                    )
                })
                .child(div().flex_1())
                .child(
                    Button::new("answer")
                        .primary()
                        .label(if is_last { "Answer" } else { "Next" })
                        .disabled(!can_continue)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let Some(state) = this.question.as_mut() else {
                                return;
                            };
                            if !is_last {
                                state.index += 1;
                                state
                                    .other
                                    .update(cx, |input, cx| input.set_value("", window, cx));
                                cx.notify();
                                return;
                            }
                            // The daemon has no native answer path yet; answers go back as the tool's feedback.
                            let other = state.other.read(cx).value().trim().to_owned();
                            let lines: Vec<String> = questions
                                .iter()
                                .enumerate()
                                .map(|(item_index, item)| {
                                    let mut picked =
                                        state.answers.get(&item_index).cloned().unwrap_or_default();
                                    if item_index == state.index && !other.is_empty() {
                                        picked.push(other.clone());
                                    }
                                    let answer = if picked.is_empty() {
                                        "(skipped)".to_owned()
                                    } else {
                                        picked.join(", ")
                                    };
                                    format!("{}\n→ {answer}", item.question)
                                })
                                .collect();
                            let comment = format!(
                                "The user answered your questions:\n\n{}",
                                lines.join("\n\n")
                            );
                            this.resolve(
                                approval_id.clone(),
                                "deny",
                                json!({ "comment": comment }),
                                window,
                                cx,
                            );
                        })),
                ),
        )
        .into_any_element()
    }
}

impl EventEmitter<ThreadEvent> for ThreadView {}

impl Render for ThreadView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let session = self.session(cx);
        let theme = cx.theme().clone();
        let running = session.as_ref().is_some_and(Session::is_busy);
        let approvals = self
            .session_id
            .as_deref()
            .map(|id| self.store.read(cx).pending_approvals(id))
            .unwrap_or_default();
        let queued = self
            .session_id
            .as_deref()
            .map(|id| self.store.read(cx).queued_messages(id))
            .unwrap_or_default();
        let ready = self.stream.is_ready();

        // App zoom changes the rem size; rows then change height.
        let rem_key = (f32::from(window.rem_size()) * 100.).round() as u32;
        if self
            .rem_key
            .replace(rem_key)
            .is_some_and(|previous| previous != rem_key)
        {
            self.scroller
                .update(cx, |scroller, cx| scroller.remeasure(cx));
        }
        let context = RowContext {
            thread: cx.weak_entity(),
            toggled: self.toggled.clone(),
            streaming: self.streaming.clone(),
            now_ms: now_ms(),
            rem: rem_key,
            actions: self.web_actions,
        };
        let rows = self.rows.clone();
        let transcript = MessageScroller::new(
            "transcript",
            self.scroller.clone(),
            move |index, _, cx| match rows.get(index) {
                Some(row) => render_row(row, &context, cx),
                None => div().into_any_element(),
            },
        )
        .flex_1()
        .w_full();

        let ask = match approvals.first() {
            Some(approval) if self.denying.is_none() => {
                Some(self.render_ask(approval, approvals.len(), window, cx))
            }
            _ => None,
        };

        let body = v_flex()
            .flex_1()
            .min_h_0()
            .when(!ready, |this| {
                let store = self.store.read(cx);
                let message = if self.session_id.is_some() {
                    "Loading the conversation…"
                } else if store.sessions_ready() {
                    "This task has no sessions yet"
                } else {
                    "Finding the session…"
                };
                this.child(column(
                    div()
                        .py_4()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(message),
                ))
            })
            .child(transcript);
        // Inside the web app the page keeps its titlebar and dock (composer, approvals, queue);
        // this view covers only its transcript area.
        if !self.chrome {
            return v_flex()
                .size_full()
                .bg(theme.background)
                .text_color(theme.foreground)
                .child(body)
                .into_any_element();
        }
        v_flex()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(self.render_titlebar(session.as_ref(), cx))
            .child(body)
            .child(column(
                v_flex()
                    .w_full()
                    .gap_2()
                    .pb_4()
                    .pt_2()
                    .children(ask)
                    .when(!queued.is_empty(), |this| {
                        this.child(div().text_xs().text_color(theme.muted_foreground).child(
                            format!(
                                "{} waiting to send",
                                crate::model::format::plural(queued.len(), "message")
                            ),
                        ))
                        .children(queued.iter().map(|message| {
                            div()
                                .px_3()
                                .py_2()
                                .rounded(theme.radius)
                                .border_1()
                                .border_color(theme.border)
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child(crate::model::format::first_line(&message.content, 200))
                        }))
                    })
                    .when_some(self.denying.as_ref(), |this, denial| {
                        this.child(
                            h_flex()
                                .gap_2()
                                .text_sm()
                                .child(
                                    div()
                                        .text_color(theme.muted_foreground)
                                        .child(format!("Denying {}", denial.what)),
                                )
                                .child(
                                    Button::new("clear-denial")
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::Close)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.denying = None;
                                            this.sync_placeholder(window, cx);
                                            cx.notify();
                                        })),
                                ),
                        )
                    })
                    .child(
                        v_flex()
                            .w_full()
                            .gap_2()
                            .p_2()
                            .rounded(theme.radius)
                            .border_1()
                            .border_color(theme.border)
                            .child(
                                Textarea::new(&self.composer)
                                    .bordered(false)
                                    .appearance(false),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(div().flex_1())
                                    .when(running && self.denying.is_none(), |this| {
                                        this.child(
                                            Button::new("stop")
                                                .ghost()
                                                .small()
                                                .label("Stop")
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.stop(window, cx)
                                                })),
                                        )
                                    })
                                    .child(
                                        Button::new("send")
                                            .primary()
                                            .small()
                                            .label(if self.denying.is_some() {
                                                "Deny and send"
                                            } else if running {
                                                "Queue"
                                            } else {
                                                "Send"
                                            })
                                            .disabled(self.sending || session.is_none())
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.submit(window, cx)
                                            })),
                                    ),
                            ),
                    ),
            ))
            .into_any_element()
    }
}
