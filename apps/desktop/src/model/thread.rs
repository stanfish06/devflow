//! A session's durable stream, materialized: saved conversation events and the text blocks the
//! agent is still streaming (the standard UI's StreamingRowsContainer shows the same blocks).

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use super::transcript::{EventRow, Turn, build_turns};

/// Text the agent is streaming for one not-yet-saved conversation event.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LiveBlock {
    pub conversation_event_id: String,
    pub message_seq: i64,
    pub block_seq: i64,
    pub thinking: bool,
    deltas: BTreeMap<i64, String>,
}

impl LiveBlock {
    pub fn text(&self) -> String {
        self.deltas.values().map(String::as_str).collect()
    }
}

/// What one stream entry added to the materialized state.
enum StreamKey {
    Event(String),
    Block(String),
    Delta(String, i64),
}

#[derive(Default)]
pub struct SessionStream {
    events: HashMap<String, EventRow>,
    /// What each stream key added, so a key-only delete can remove it.
    keys: HashMap<String, StreamKey>,
    /// When each event id first arrived on the stream: its own order, which breaks timestamp ties.
    /// Saved-query rows get none, so they sort after stream rows of the same millisecond, by id.
    arrival: HashMap<String, u64>,
    live: HashMap<String, LiveBlock>,
    ready: bool,
    /// Bumped when saved events change, so views rebuild turns only then.
    events_revision: u64,
}

impl SessionStream {
    pub fn reset(&mut self) {
        *self = Self {
            events_revision: self.events_revision + 1,
            ..Self::default()
        };
    }

    pub fn set_ready(&mut self) {
        if !self.ready {
            self.ready = true;
            self.events_revision += 1;
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn events_revision(&self) -> u64 {
        self.events_revision
    }

    /// Apply state-protocol messages `{type, key, value, headers: {operation}}`.
    pub fn apply(&mut self, items: &[Value]) {
        for item in items {
            let Some(kind) = item.get("type").and_then(Value::as_str) else {
                continue;
            };
            let operation = item
                .pointer("/headers/operation")
                .and_then(Value::as_str)
                .unwrap_or("insert");
            let key = item.get("key").and_then(Value::as_str);
            // Deletes carry only the key: the producer drops interrupted or unmatched live text
            // this way (deleteUnmaterializedBlocks).
            if operation == "delete" {
                if let Some(entry) = key.and_then(|key| self.keys.remove(key)) {
                    self.forget(entry);
                }
                continue;
            }
            let Some(value) = item.get("value").and_then(Value::as_object) else {
                continue;
            };
            let conversation_event_id = value.get("conversation_event_id").and_then(Value::as_str);
            match kind {
                "conversation_event" => {
                    let Some(row) = EventRow::from_stream_value(value) else {
                        continue;
                    };
                    // A saved event replaces the text streamed for it.
                    self.live.remove(&row.id);
                    self.arrive(&row.id);
                    if let Some(key) = key {
                        self.keys
                            .insert(key.to_owned(), StreamKey::Event(row.id.clone()));
                    }
                    self.events.insert(row.id.clone(), row);
                    self.events_revision += 1;
                }
                "text_block_start" | "thinking_block_start" | "text_delta" | "thinking_delta" => {
                    let Some(id) = conversation_event_id else {
                        continue;
                    };
                    if self.events.contains_key(id) {
                        continue;
                    }
                    let block = self.live.entry(id.to_owned()).or_insert_with(|| LiveBlock {
                        conversation_event_id: id.to_owned(),
                        message_seq: value
                            .get("message_seq")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        block_seq: value.get("block_seq").and_then(Value::as_i64).unwrap_or(0),
                        thinking: kind.starts_with("thinking"),
                        deltas: BTreeMap::new(),
                    });
                    let entry = if kind.ends_with("_delta") {
                        let seq = value.get("delta_seq").and_then(Value::as_i64).unwrap_or(0);
                        let content = value.get("content").and_then(Value::as_str).unwrap_or("");
                        block.deltas.insert(seq, content.to_owned());
                        StreamKey::Delta(id.to_owned(), seq)
                    } else {
                        StreamKey::Block(id.to_owned())
                    };
                    if let Some(key) = key {
                        self.keys.insert(key.to_owned(), entry);
                    }
                }
                _ => {}
            }
        }
    }

    /// Add saved rows the stream doesn't carry. The API writes a follow-up's user message to the
    /// database only; the agent's own events reach both, under the same id.
    pub fn merge_saved(&mut self, rows: Vec<EventRow>) {
        let mut changed = false;
        for row in rows {
            if self.events.contains_key(&row.id) {
                continue;
            }
            // Not `arrive`: only the stream's own order decides ties, and its replay may still come.
            self.live.remove(&row.id);
            self.events.insert(row.id.clone(), row);
            changed = true;
        }
        if changed {
            self.events_revision += 1;
        }
    }

    /// Undo what a deleted stream key added.
    fn forget(&mut self, entry: StreamKey) {
        match entry {
            StreamKey::Event(id) => {
                if self.events.remove(&id).is_some() {
                    self.events_revision += 1;
                }
            }
            StreamKey::Block(id) => {
                self.live.remove(&id);
            }
            StreamKey::Delta(id, seq) => {
                if let Some(block) = self.live.get_mut(&id) {
                    block.deltas.remove(&seq);
                }
            }
        }
    }

    fn arrive(&mut self, id: &str) {
        let next = self.arrival.len() as u64;
        self.arrival.entry(id.to_owned()).or_insert(next);
    }

    /// Turns from the saved events, given in arrival order: build_turns sorts by time and keeps
    /// that order for events saved in the same millisecond.
    pub fn turns(&self) -> Vec<Turn> {
        // Borrowed rows: only the turns built from them own copies of the text.
        let mut rows: Vec<&EventRow> = self.events.values().collect();
        rows.sort_by_key(|row| {
            (
                self.arrival.get(&row.id).copied().unwrap_or(u64::MAX),
                &row.id,
            )
        });
        build_turns(&rows)
    }

    /// Text blocks still streaming, oldest first. Thinking blocks are left out: the thread shows
    /// saved thinking as a collapsed step, and a half-written one adds noise.
    pub fn live_text(&self) -> Vec<&LiveBlock> {
        let mut blocks: Vec<&LiveBlock> = self
            .live
            .values()
            .filter(|block| !block.thinking && !block.deltas.is_empty())
            .collect();
        blocks.sort_by_key(|block| (block.message_seq, block.block_seq));
        blocks
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(id: &str, role: &str, kind: &str, content: &str, at: i64) -> Value {
        json!({
            "type": "conversation_event",
            "key": format!("k-{id}"),
            "headers": { "operation": "insert" },
            "value": {
                "id": format!("s-{id}"), "session_id": "s", "message_seq": 1, "timestamp": at,
                "conversation_event_id": id, "event_type": kind, "role": role, "content": content,
                "created_at": at, "updated_at": at
            }
        })
    }

    fn delta(id: &str, seq: i64, content: &str) -> Value {
        json!({
            "type": "text_delta", "key": format!("d-{id}-{seq}"), "headers": { "operation": "insert" },
            "value": { "id": format!("d-{id}-{seq}"), "session_id": "s", "message_seq": 2, "timestamp": 0,
                "block_seq": 0, "delta_seq": seq, "conversation_event_id": id, "content": content }
        })
    }

    #[test]
    fn streamed_text_gives_way_to_the_saved_event() {
        let mut stream = SessionStream::default();
        stream.apply(&[event("u1", "user", "message", "fix the bug", 1)]);
        stream.apply(&[delta("a1", 1, " world"), delta("a1", 0, "hello")]);
        assert_eq!(
            stream
                .live_text()
                .iter()
                .map(|b| b.text())
                .collect::<Vec<_>>(),
            vec!["hello world"]
        );

        stream.apply(&[event("a1", "assistant", "message", "hello world", 2)]);
        assert!(stream.live_text().is_empty());
        let turns = stream.turns();
        assert_eq!(turns.len(), 2);
        assert!(
            matches!(&turns[1], Turn::Agent(agent) if agent.answer.as_deref() == Some("hello world"))
        );
    }

    #[test]
    fn repeated_event_rows_replace_each_other() {
        let mut stream = SessionStream::default();
        stream.apply(&[
            event("u1", "user", "message", "first", 1),
            event("u1", "user", "message", "edited", 1),
        ]);
        assert_eq!(stream.turns().len(), 1);
        assert!(matches!(&stream.turns()[0], Turn::User { text, .. } if text == "edited"));
    }

    #[test]
    fn a_follow_up_saved_only_in_the_database_opens_its_own_turn() {
        let mut stream = SessionStream::default();
        stream.apply(&[
            event("u1", "user", "message", "first", 1),
            event("a1", "assistant", "message", "done", 2),
            event("a2", "assistant", "message", "listed", 4),
        ]);
        // Query rows use `id` and a string `created_at`; "a1" is already known from the stream.
        let saved = |id: &str, role: &str, content: &str, at: &str| {
            let row = json!({ "id": id, "event_type": "message", "role": role,
                "content": content, "created_at": at });
            EventRow::from_saved_row(row.as_object().unwrap()).unwrap()
        };
        stream.merge_saved(vec![
            saved("a1", "assistant", "stale copy", "2"),
            saved("u2", "user", "second", "3"),
        ]);
        let turns = stream.turns();
        assert_eq!(turns.len(), 4);
        assert!(matches!(&turns[1], Turn::Agent(agent) if agent.answer.as_deref() == Some("done")));
        assert!(matches!(&turns[2], Turn::User { text, .. } if text == "second"));
        assert!(
            matches!(&turns[3], Turn::Agent(agent) if agent.answer.as_deref() == Some("listed"))
        );
    }

    #[test]
    fn events_saved_in_the_same_millisecond_keep_stream_order() {
        // Ids sort the other way, so only arrival order can pick the right answer.
        for _ in 0..20 {
            let mut stream = SessionStream::default();
            stream.apply(&[
                event("u1", "user", "message", "go", 1),
                event("z-first", "assistant", "message", "draft", 5),
                event("a-last", "assistant", "message", "final", 5),
            ]);
            let turns = stream.turns();
            assert!(
                matches!(&turns[1], Turn::Agent(agent) if agent.answer.as_deref() == Some("final"))
            );
        }
    }

    #[test]
    fn key_only_deletes_drop_discarded_live_text() {
        let mut stream = SessionStream::default();
        stream.apply(&[delta("a1", 0, "half an ans")]);
        assert_eq!(stream.live_text().len(), 1);
        // delta() keys its entries `d-<id>-<seq>`; the producer deletes by key, without a value.
        stream.apply(&[json!({
            "type": "text_delta", "key": "d-a1-0", "headers": { "operation": "delete" }
        })]);
        assert!(stream.live_text().is_empty());
    }

    #[test]
    fn saved_rows_merged_first_do_not_fix_stream_order() {
        let mut stream = SessionStream::default();
        let saved = |id: &str, content: &str| {
            let row = json!({ "id": id, "event_type": "message", "role": "assistant",
                "content": content, "created_at": "5" });
            EventRow::from_saved_row(row.as_object().unwrap()).unwrap()
        };
        // The query returns them in the wrong order before the stream replays.
        stream.merge_saved(vec![saved("a-last", "final"), saved("z-first", "draft")]);
        stream.apply(&[
            event("u1", "user", "message", "go", 1),
            event("z-first", "assistant", "message", "draft", 5),
            event("a-last", "assistant", "message", "final", 5),
        ]);
        let turns = stream.turns();
        assert!(
            matches!(&turns[1], Turn::Agent(agent) if agent.answer.as_deref() == Some("final"))
        );
    }
}
