//! Port of apps/web/src/minimalist/lib/transcript.ts: folds a session's conversation events into turns.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventType {
    Message,
    ToolCall,
    ToolResult,
    Thinking,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
}

impl ApprovalStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "denied" => Some(Self::Denied),
            _ => None,
        }
    }
}

/// The subset of a conversation_events row the transcript reads.
#[derive(Clone, Debug, PartialEq)]
pub struct EventRow {
    pub id: String,
    pub event_type: EventType,
    pub role: Role,
    pub content: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Value,
    pub parent_tool_use_id: Option<String>,
    pub tool_result_for_id: Option<String>,
    pub tool_result_content: Option<String>,
    pub approval_status: Option<ApprovalStatus>,
    pub approval_id: Option<String>,
    pub user_name: Option<String>,
    pub user_id: Option<String>,
    pub created_at: i64,
}

impl EventRow {
    /// Read a `conversation_event` value from the session's durable stream (packages/streams/src/events.ts).
    /// The persisted row id is `conversation_event_id`; `id` is the stream entry's own key.
    pub fn from_stream_value(value: &Map<String, Value>) -> Option<Self> {
        Self::parse(value, "conversation_event_id")
    }

    /// Read a saved `conversation_events` row from the `sync/v2/conversationEvents` query.
    pub fn from_saved_row(value: &Map<String, Value>) -> Option<Self> {
        Self::parse(value, "id")
    }

    fn parse(value: &Map<String, Value>, id_key: &str) -> Option<Self> {
        let string = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        let event_type = match value.get("event_type")?.as_str()? {
            "message" => EventType::Message,
            "tool_call" => EventType::ToolCall,
            "tool_result" => EventType::ToolResult,
            "thinking" => EventType::Thinking,
            "system" => EventType::System,
            _ => return None,
        };
        let role = match value.get("role")?.as_str()? {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            "system" => Role::System,
            _ => return None,
        };
        Some(Self {
            id: string(id_key)?,
            event_type,
            role,
            content: string("content"),
            tool_call_id: string("tool_call_id"),
            tool_name: string("tool_name"),
            tool_input: value.get("tool_input_json").cloned().unwrap_or(Value::Null),
            parent_tool_use_id: string("parent_tool_use_id"),
            tool_result_for_id: string("tool_result_for_id"),
            tool_result_content: string("tool_result_content"),
            approval_status: value
                .get("approval_status")
                .and_then(Value::as_str)
                .and_then(ApprovalStatus::parse),
            approval_id: string("approval_id"),
            user_name: string("user_name"),
            user_id: string("user_id"),
            // The stream sends a number; the query sends the bigint column as a string.
            created_at: value
                .get("created_at")
                .and_then(|at| at.as_i64().or_else(|| at.as_str()?.parse().ok()))
                .unwrap_or(0),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolStep {
    pub id: String,
    pub tool_call_id: String,
    pub name: String,
    pub input: Map<String, Value>,
    pub result: Option<String>,
    pub is_error: bool,
    pub approval_status: Option<ApprovalStatus>,
    pub approval_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// Events a subagent produced under this Task/Agent call.
    pub children: Vec<Step>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Tool(ToolStep),
    Thinking {
        id: String,
        text: String,
    },
    Commentary {
        id: String,
        text: String,
    },
    /// A skill's instructions the agent loaded with no Skill call to hang them on.
    Skill {
        id: String,
        name: Option<String>,
        text: String,
    },
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Tool(step) => &step.id,
            Step::Thinking { id, .. } | Step::Commentary { id, .. } | Step::Skill { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentTurn {
    pub id: String,
    pub steps: Vec<Step>,
    /// The last assistant message after the last tool call: what the user reads first.
    pub answer: Option<String>,
    pub started_at: i64,
    pub ended_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Turn {
    User {
        id: String,
        text: String,
        author: Option<String>,
        at: i64,
    },
    Agent(AgentTurn),
    Compaction {
        id: String,
        at: i64,
    },
    /// A line the session records between turns, such as a switch of its GitHub account.
    Notice {
        id: String,
        text: String,
        at: i64,
    },
}

impl Turn {
    pub fn id(&self) -> &str {
        match self {
            Turn::User { id, .. } | Turn::Compaction { id, .. } | Turn::Notice { id, .. } => id,
            Turn::Agent(turn) => &turn.id,
        }
    }
}

pub fn parse_input(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

/// A system event's JSON payload, or None when it has none.
fn system_payload(row: &EventRow) -> Option<Map<String, Value>> {
    if row.event_type != EventType::System {
        return None;
    }
    match serde_json::from_str::<Value>(row.content.as_deref()?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn is_compaction(row: &EventRow) -> bool {
    system_payload(row).and_then(|payload| payload.get("kind").cloned())
        == Some(Value::String("context_compaction".into()))
}

/// The line a system event shows in the conversation, or None for one it hides.
pub fn notice_text(row: &EventRow) -> Option<String> {
    let payload = system_payload(row)?;
    if payload.get("kind").and_then(Value::as_str) != Some("github_account_changed") {
        return None;
    }
    match payload
        .get("login")
        .and_then(Value::as_str)
        .filter(|login| !login.is_empty())
    {
        Some(login) => Some(format!("Account changed to {login}")),
        None => Some("Account changed to the host's own gh login".into()),
    }
}

static DENIAL_WITH_FEEDBACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^The user denied this tool call with feedback: ([\s\S]*)$").unwrap()
});
static ERROR_RESULT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(Error|error:)|<tool_use_error>|exit code [1-9]|Exit code [1-9]").unwrap()
});
static SKILL_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*<skill\s+name="([^"]+)""#).unwrap());
static SKILL_DIRECTORY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Base directory for this skill:\s*(\S+)").unwrap());
static CODELAYER_SKILL_PROMPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*<skill\s+name=").unwrap());

/// A call you denied, read from its result as the daemon words it. Some(feedback) when denied.
pub fn read_denial(result: Option<&str>) -> Option<Option<String>> {
    let text = result.unwrap_or("").trim();
    if text == "Request denied by user" {
        return Some(None);
    }
    DENIAL_WITH_FEEDBACK.captures(text).map(|captures| {
        let feedback = captures.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        (!feedback.is_empty()).then(|| feedback.to_owned())
    })
}

fn looks_like_error(result: Option<&str>) -> bool {
    let Some(result) = result else { return false };
    let head: String = result.chars().take(400).collect();
    ERROR_RESULT.is_match(&head)
}

/// Port of isSyntheticSkillPromptMessage (apps/web/src/utils/sidebar-transforms.ts).
pub fn is_synthetic_skill_prompt(content: Option<&str>) -> bool {
    let Some(content) = content else { return false };
    content.starts_with("Base directory for this skill:")
        || CODELAYER_SKILL_PROMPT.is_match(content)
}

/// The skill a loaded skill prompt belongs to.
pub fn skill_prompt_name(text: &str) -> Option<String> {
    if let Some(tagged) = SKILL_TAG.captures(text).and_then(|c| c.get(1)) {
        return Some(tagged.as_str().to_owned());
    }
    let directory = SKILL_DIRECTORY
        .captures(text)?
        .get(1)?
        .as_str()
        .trim_end_matches('/');
    directory.rsplit('/').next().map(str::to_owned)
}

pub fn normalize_tool_name(name: &str) -> String {
    name.to_lowercase().replace('_', "")
}

/// Fold a session's events into turns. A user message opens a turn; everything the agent does
/// until the next user message is one agent turn whose final assistant message is its answer.
pub fn build_turns(rows: &[EventRow]) -> Vec<Turn> {
    let mut sorted: Vec<&EventRow> = rows.iter().collect();
    // Stable: events saved in the same millisecond keep the order they were given in.
    sorted.sort_by_key(|row| row.created_at);

    let mut results: HashMap<&str, &EventRow> = HashMap::new();
    let mut children_by_parent: HashMap<&str, Vec<&EventRow>> = HashMap::new();
    for row in &sorted {
        if row.event_type == EventType::ToolResult
            && let Some(target) = row.tool_result_for_id.as_deref()
        {
            results.insert(target, row);
        }
        if let Some(parent) = row.parent_tool_use_id.as_deref()
            && row.event_type != EventType::ToolResult
        {
            children_by_parent.entry(parent).or_default().push(row);
        }
    }

    fn to_step(
        row: &EventRow,
        results: &HashMap<&str, &EventRow>,
        children_by_parent: &HashMap<&str, Vec<&EventRow>>,
    ) -> Option<Step> {
        let non_blank =
            |text: &Option<String>| text.as_deref().is_some_and(|t| !t.trim().is_empty());
        match row.event_type {
            EventType::Thinking if non_blank(&row.content) => Some(Step::Thinking {
                id: row.id.clone(),
                text: row.content.clone().unwrap_or_default(),
            }),
            EventType::Message if row.role == Role::Assistant && non_blank(&row.content) => {
                Some(Step::Commentary {
                    id: row.id.clone(),
                    text: row.content.clone().unwrap_or_default(),
                })
            }
            EventType::ToolCall => {
                let tool_call_id = row.tool_call_id.as_deref()?;
                let result = results.get(tool_call_id).copied();
                let result_text = result
                    .and_then(|r| r.tool_result_content.clone().or_else(|| r.content.clone()));
                let children = children_by_parent
                    .get(tool_call_id)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|child| to_step(child, results, children_by_parent))
                            .collect()
                    })
                    .unwrap_or_default();
                // The call row isn't marked when you deny it; the result says so.
                let denied = row.approval_status == Some(ApprovalStatus::Denied)
                    || read_denial(result_text.as_deref()).is_some();
                Some(Step::Tool(ToolStep {
                    id: row.id.clone(),
                    tool_call_id: tool_call_id.to_owned(),
                    name: row.tool_name.clone().unwrap_or_else(|| "tool".into()),
                    input: parse_input(&row.tool_input),
                    is_error: denied || looks_like_error(result_text.as_deref()),
                    result: result_text,
                    approval_status: if denied {
                        Some(ApprovalStatus::Denied)
                    } else {
                        row.approval_status
                    },
                    approval_id: row.approval_id.clone(),
                    started_at: row.created_at,
                    ended_at: result.map(|r| r.created_at),
                    children,
                }))
            }
            _ => None,
        }
    }

    let mut turns = Vec::new();
    let mut current: Option<AgentTurn> = None;
    let close = |current: &mut Option<AgentTurn>, turns: &mut Vec<Turn>| {
        if let Some(mut turn) = current.take() {
            // The answer is the trailing commentary, shown outside the collapsed work line.
            if let Some(Step::Commentary { text, .. }) = turn.steps.last() {
                turn.answer = Some(text.clone());
                turn.steps.pop();
            }
            turns.push(Turn::Agent(turn));
        }
    };
    let open_turn = |current: &mut Option<AgentTurn>, id: &str, at: i64| {
        current.get_or_insert_with(|| AgentTurn {
            id: id.to_owned(),
            steps: Vec::new(),
            answer: None,
            started_at: at,
            ended_at: at,
        });
    };

    for row in &sorted {
        if row.parent_tool_use_id.is_some() || row.event_type == EventType::ToolResult {
            continue;
        }
        if is_compaction(row) {
            close(&mut current, &mut turns);
            turns.push(Turn::Compaction {
                id: row.id.clone(),
                at: row.created_at,
            });
            continue;
        }
        if let Some(text) = notice_text(row) {
            close(&mut current, &mut turns);
            turns.push(Turn::Notice {
                id: row.id.clone(),
                text,
                at: row.created_at,
            });
            continue;
        }
        if row.event_type == EventType::System {
            continue;
        }
        // A skill's instructions arrive as a user message nobody typed. They belong to the agent's
        // work: as the result of the Skill call that loaded them, or as a step of their own.
        if row.event_type == EventType::Message
            && row.role == Role::User
            && is_synthetic_skill_prompt(row.content.as_deref())
        {
            let text = row.content.clone().unwrap_or_default();
            if let Some(Step::Tool(last)) = current.as_mut().and_then(|turn| turn.steps.last_mut())
                && normalize_tool_name(&last.name) == "skill"
            {
                last.result = Some(text);
                continue;
            }
            open_turn(&mut current, &row.id, row.created_at);
            let turn = current.as_mut().expect("opened above");
            turn.steps.push(Step::Skill {
                id: row.id.clone(),
                name: skill_prompt_name(&text),
                text,
            });
            turn.ended_at = turn.ended_at.max(row.created_at);
            continue;
        }
        if row.event_type == EventType::Message && row.role == Role::User {
            close(&mut current, &mut turns);
            if row
                .content
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
            {
                turns.push(Turn::User {
                    id: row.id.clone(),
                    text: row.content.clone().unwrap_or_default(),
                    author: row.user_name.clone(),
                    at: row.created_at,
                });
            }
            continue;
        }
        let Some(step) = to_step(row, &results, &children_by_parent) else {
            continue;
        };
        open_turn(&mut current, &row.id, row.created_at);
        let turn = current.as_mut().expect("opened above");
        let ended = match &step {
            Step::Tool(tool) => tool.ended_at.unwrap_or(row.created_at),
            _ => row.created_at,
        };
        turn.steps.push(step);
        turn.ended_at = turn.ended_at.max(ended);
    }
    close(&mut current, &mut turns);
    turns
}

/// Groups consecutive read-only exploration steps so "Read 4 files" shows as one line.
/// Each step in `Explore` is a `Step::Tool`.
#[derive(Clone, Debug, PartialEq)]
pub enum StepGroup<'a> {
    Explore { id: &'a str, steps: Vec<&'a Step> },
    Single(&'a Step),
}

const EXPLORE_TOOLS: [&str; 5] = ["read", "grep", "glob", "ls", "notebookread"];

fn is_explore_step(step: &Step) -> bool {
    matches!(step, Step::Tool(tool) if EXPLORE_TOOLS.contains(&normalize_tool_name(&tool.name).as_str()))
}

pub fn group_steps(steps: &[Step]) -> Vec<StepGroup<'_>> {
    let mut groups: Vec<StepGroup<'_>> = Vec::new();
    for step in steps {
        if is_explore_step(step) {
            if let Some(StepGroup::Explore { steps, .. }) = groups.last_mut() {
                steps.push(step);
            } else {
                groups.push(StepGroup::Explore {
                    id: step.id(),
                    steps: vec![step],
                });
            }
            continue;
        }
        groups.push(StepGroup::Single(step));
    }
    // A lone read reads better as its own line than as "Explored 1 file".
    groups
        .into_iter()
        .map(|group| match group {
            StepGroup::Explore { steps, .. } if steps.len() == 1 => StepGroup::Single(steps[0]),
            other => other,
        })
        .collect()
}
