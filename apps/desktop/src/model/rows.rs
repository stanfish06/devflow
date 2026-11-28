//! Typed views over Electric shape rows. Electric sends every column as Postgres display text
//! (`"t"`/`"f"` booleans, decimal integers, JSON as a string), so rows stay as text and parse on read.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::transcript::ApprovalStatus;

/// One materialized shape row: column name to its Electric display value.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row(Map<String, Value>);

impl Row {
    pub fn new(values: Map<String, Value>) -> Self {
        Self(values)
    }

    /// Apply an Electric update, which carries the primary key and the changed columns only.
    pub fn merge(&mut self, changes: Map<String, Value>) {
        self.0.extend(changes);
    }

    pub fn str(&self, column: &str) -> Option<&str> {
        self.0.get(column).and_then(Value::as_str)
    }

    pub fn string(&self, column: &str) -> Option<String> {
        self.str(column).map(str::to_owned)
    }

    pub fn bool(&self, column: &str) -> bool {
        match self.0.get(column) {
            Some(Value::String(text)) => text == "t" || text == "true",
            Some(Value::Bool(value)) => *value,
            _ => false,
        }
    }

    pub fn i64(&self, column: &str) -> Option<i64> {
        match self.0.get(column)? {
            Value::String(text) => text.parse().ok(),
            Value::Number(number) => number.as_i64(),
            _ => None,
        }
    }

    /// A json/jsonb column, parsed from its text form.
    pub fn json(&self, column: &str) -> Value {
        match self.0.get(column) {
            Some(Value::String(text)) => serde_json::from_str(text).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        }
    }
}

/// Rows of one shape keyed by Electric's row key.
#[derive(Clone, Debug, Default)]
pub struct Table {
    rows: HashMap<String, Row>,
    ready: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ShapeOp {
    Insert {
        key: String,
        value: Map<String, Value>,
    },
    Update {
        key: String,
        value: Map<String, Value>,
    },
    Delete {
        key: String,
    },
}

impl Table {
    pub fn apply(&mut self, op: ShapeOp) {
        match op {
            ShapeOp::Insert { key, value } => {
                self.rows.insert(key, Row::new(value));
            }
            ShapeOp::Update { key, value } => self.rows.entry(key).or_default().merge(value),
            ShapeOp::Delete { key } => {
                self.rows.remove(&key);
            }
        }
    }

    pub fn clear(&mut self) {
        self.rows.clear();
        self.ready = false;
    }

    pub fn set_ready(&mut self) {
        self.ready = true;
    }

    /// Whether the shape has caught up with the server once.
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn rows(&self) -> impl Iterator<Item = &Row> {
        self.rows.values()
    }
}

/// minimalist/lib/status.ts `isBusy`: the running statuses, plus waiting out a usage limit.
pub const BUSY_STATUSES: [&str; 7] = [
    "waiting_for_usage_limit",
    "running",
    "launching",
    "resuming",
    "waiting_for_workspace",
    "ready_for_launch",
    "interrupt_requested",
];

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub task_id: Option<String>,
    pub status: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub host_id: Option<String>,
    pub archived: bool,
    pub created_at: i64,
    pub activity_at: i64,
}

impl Session {
    pub fn from_row(row: &Row) -> Option<Self> {
        let created_at = row.i64("created_at").unwrap_or(0);
        Some(Self {
            id: row.string("id")?,
            task_id: row.string("task_id"),
            status: row.string("status").unwrap_or_default(),
            title: row.string("title"),
            summary: row.string("summary"),
            host_id: row.string("host_id"),
            archived: row.bool("archived"),
            created_at,
            activity_at: created_at
                .max(row.i64("updated_at").unwrap_or(0))
                .max(row.i64("last_activity_at").unwrap_or(0)),
        })
    }

    /// An explicit session name wins over its generated summary, which can arrive after launch.
    pub fn name(&self) -> String {
        [self.title.as_deref(), self.summary.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .find(|name| !name.is_empty())
            .unwrap_or("Untitled session")
            .to_owned()
    }

    pub fn is_busy(&self) -> bool {
        BUSY_STATUSES.contains(&self.status.as_str())
    }
}

/// An `approvals` row: a tool call the agent waits on (AskCard in the web UI).
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub id: String,
    pub session_id: String,
    pub status: Option<ApprovalStatus>,
    pub tool_name: Option<String>,
    pub tool_input: Map<String, Value>,
    /// Permission updates the agent offers with the request, such as an "always allow" rule.
    pub suggestions: Value,
    pub created_at: i64,
}

impl Approval {
    pub fn from_row(row: &Row) -> Option<Self> {
        Some(Self {
            id: row.string("id")?,
            session_id: row.string("session_id")?,
            status: row.str("status").and_then(ApprovalStatus::parse),
            tool_name: row.string("tool_name"),
            tool_input: match row.json("tool_input") {
                Value::Object(map) => map,
                _ => Map::new(),
            },
            suggestions: row.json("suggestions"),
            created_at: row.i64("created_at").unwrap_or(0),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueuedMessage {
    pub id: String,
    pub session_id: String,
    pub content: String,
    pub pending: bool,
    pub author: Option<String>,
    pub created_at: i64,
}

impl QueuedMessage {
    pub fn from_row(row: &Row) -> Option<Self> {
        Some(Self {
            id: row.string("id")?,
            session_id: row.string("session_id")?,
            content: row.string("content").unwrap_or_default(),
            pending: row.str("status") == Some("pending"),
            author: row.string("author_display_name"),
            created_at: row.i64("created_at").unwrap_or(0),
        })
    }
}
