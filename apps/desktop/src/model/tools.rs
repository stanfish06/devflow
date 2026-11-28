//! Port of apps/web/src/minimalist/lib/tools.ts: one-line summaries of tool steps.

use serde_json::{Map, Value};

use super::format::{basename, plural};
use super::transcript::{ApprovalStatus, Step, ToolStep, normalize_tool_name};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepIcon {
    File,
    Terminal,
    Search,
    Bot,
    Globe,
    Todo,
    Plug,
    List,
    Message,
    Tool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StepSummary {
    pub icon: StepIcon,
    /// Past-tense verb when done, present when running: "Ran" / "Running".
    pub verb: String,
    /// The code-ish target shown in mono, e.g. a command or file name.
    pub target: Option<String>,
    /// Trailing muted fact, e.g. "+22 −4" or "14 results".
    pub meta: Option<String>,
}

/// A non-blank string field.
pub fn str_field<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// A tool input field as display text; anything that isn't a string reads as empty.
pub fn text_field(input: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}

fn lines(text: Option<&str>) -> Vec<&str> {
    match text {
        Some(text) => text
            .strip_suffix('\n')
            .unwrap_or(text)
            .split('\n')
            .collect(),
        None => Vec::new(),
    }
}

/// Lines added and removed by replacing `before` with `after`, not counting unchanged lines at either end.
fn changed_lines(before: Option<&str>, after: Option<&str>) -> (usize, usize) {
    let old = lines(before);
    let next = lines(after);
    let mut start = 0;
    while start < old.len() && start < next.len() && old[start] == next[start] {
        start += 1;
    }
    let mut end = 0;
    while end < old.len() - start
        && end < next.len() - start
        && old[old.len() - 1 - end] == next[next.len() - 1 - end]
    {
        end += 1;
    }
    (next.len() - start - end, old.len() - start - end)
}

pub fn is_edit_tool(name: &str) -> bool {
    ["edit", "multiedit", "write", "applypatch", "notebookedit"]
        .contains(&normalize_tool_name(name).as_str())
}

pub fn edit_counts(step: &ToolStep) -> (usize, usize) {
    let input = &step.input;
    let name = normalize_tool_name(&step.name);
    if name == "write" {
        return (lines(str_field(input, "content")).len(), 0);
    }
    // Codex's apply_patch: a patch whose body lines start with `+` or `-`, under `***` and
    // `+++`/`---` file headers.
    if name == "applypatch" {
        return lines(str_field(input, "patch_text").or_else(|| str_field(input, "input")))
            .iter()
            .filter(|line| !line.starts_with("+++") && !line.starts_with("---"))
            .fold((0, 0), |(added, removed), line| {
                match line.as_bytes().first() {
                    Some(b'+') => (added + 1, removed),
                    Some(b'-') => (added, removed + 1),
                    _ => (added, removed),
                }
            });
    }
    // NotebookEdit replaces or inserts a whole cell; the input has only the new source.
    if name == "notebookedit" {
        return (lines(str_field(input, "new_source")).len(), 0);
    }
    if name == "multiedit"
        && let Some(edits) = input.get("edits").and_then(Value::as_array)
    {
        return edits
            .iter()
            .filter_map(Value::as_object)
            .fold((0, 0), |(added, removed), edit| {
                let (a, r) =
                    changed_lines(str_field(edit, "old_string"), str_field(edit, "new_string"));
                (added + a, removed + r)
            });
    }
    changed_lines(
        str_field(input, "old_string"),
        str_field(input, "new_string"),
    )
}

/// A call that needs approval: waiting on you, denied (so it never ran), done, or running.
fn approval_verb(step: &ToolStep, [pending, denied, past, present]: [&str; 4]) -> String {
    match step.approval_status {
        Some(ApprovalStatus::Pending) => pending,
        Some(ApprovalStatus::Denied) => denied,
        _ if step.ended_at.is_some() => past,
        _ => present,
    }
    .to_owned()
}

fn host_of(url: Option<&str>) -> Option<String> {
    let url = url?;
    Some(
        url::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| url.to_owned()),
    )
}

pub fn summarize_step(step: &ToolStep) -> StepSummary {
    let input = &step.input;
    let done = step.ended_at.is_some();
    let name = normalize_tool_name(&step.name);
    let path = str_field(input, "file_path")
        .or_else(|| str_field(input, "path"))
        .or_else(|| str_field(input, "notebook_path"));
    let summary = |icon, verb: &str, target: Option<String>, meta: Option<String>| StepSummary {
        icon,
        verb: verb.to_owned(),
        target,
        meta,
    };
    match name.as_str() {
        "bash" => StepSummary {
            icon: StepIcon::Terminal,
            verb: approval_verb(step, ["Wants to run", "Wanted to run", "Ran", "Running"]),
            target: str_field(input, "command")
                .and_then(|c| c.split('\n').next())
                .map(str::to_owned),
            meta: None,
        },
        "bashoutput" => summary(
            StepIcon::Terminal,
            "Read output of",
            Some("a background command".into()),
            None,
        ),
        "read" => summary(
            StepIcon::File,
            if done { "Read" } else { "Reading" },
            path.map(basename),
            None,
        ),
        "edit" | "multiedit" | "write" | "applypatch" | "notebookedit" => {
            let (added, removed) = edit_counts(step);
            let verb = if name == "write" {
                approval_verb(
                    step,
                    ["Wants to write", "Wanted to write", "Wrote", "Writing"],
                )
            } else {
                approval_verb(
                    step,
                    ["Wants to edit", "Wanted to edit", "Edited", "Editing"],
                )
            };
            StepSummary {
                icon: StepIcon::File,
                verb,
                target: path.map(basename),
                meta: Some(format!("+{added} −{removed}")),
            }
        }
        "grep" => {
            let count = step
                .result
                .as_deref()
                .map(|r| r.split('\n').filter(|l| !l.is_empty()).count());
            summary(
                StepIcon::Search,
                if done {
                    "Searched for"
                } else {
                    "Searching for"
                },
                str_field(input, "pattern").map(str::to_owned),
                count.map(|c| plural(c, "result")),
            )
        }
        "glob" => summary(
            StepIcon::Search,
            if done { "Listed" } else { "Listing" },
            str_field(input, "pattern").map(str::to_owned),
            None,
        ),
        "ls" => summary(
            StepIcon::Search,
            if done { "Listed" } else { "Listing" },
            path.map(basename),
            None,
        ),
        "task" | "agent" => {
            let kind = str_field(input, "subagent_type").unwrap_or("subagent");
            let calls = step
                .children
                .iter()
                .filter(|c| matches!(c, Step::Tool(_)))
                .count();
            let meta = [
                str_field(input, "description").map(str::to_owned),
                Some(plural(calls, "tool call")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
            summary(StepIcon::Bot, kind, None, Some(meta))
        }
        "todowrite" => summary(StepIcon::Todo, "Updated the plan", None, None),
        "webfetch" => summary(
            StepIcon::Globe,
            if done { "Fetched" } else { "Fetching" },
            host_of(str_field(input, "url")),
            None,
        ),
        "websearch" => summary(
            StepIcon::Globe,
            if done {
                "Searched the web for"
            } else {
                "Searching the web for"
            },
            str_field(input, "query").map(str::to_owned),
            None,
        ),
        "skill" => summary(
            StepIcon::List,
            "Used skill",
            str_field(input, "skill")
                .or_else(|| str_field(input, "command"))
                .map(str::to_owned),
            None,
        ),
        "askuserquestion" => summary(StepIcon::Message, "Asked you", None, None),
        "exitplanmode" => summary(StepIcon::List, "Proposed a plan", None, None),
        _ => {
            if let Some(rest) = step.name.strip_prefix("mcp__") {
                let mut parts = rest.split("__");
                let server = parts.next().unwrap_or("");
                let tool = parts.next().unwrap_or("");
                return summary(
                    StepIcon::Plug,
                    "Called",
                    Some(format!("{server}.{tool}")),
                    None,
                );
            }
            summary(StepIcon::Tool, "Used", Some(step.name.clone()), None)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

/// The agent's plan as its last todo update left it.
pub fn latest_todos(steps: &[Step]) -> Vec<TodoItem> {
    let Some(step) = steps.iter().rev().find_map(|step| match step {
        Step::Tool(tool) if normalize_tool_name(&tool.name) == "todowrite" => Some(tool),
        _ => None,
    }) else {
        return Vec::new();
    };
    let Some(todos) = step.input.get("todos").and_then(Value::as_array) else {
        return Vec::new();
    };
    todos
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|record| {
            let content =
                str_field(record, "content").or_else(|| str_field(record, "activeForm"))?;
            let status = match record.get("status").and_then(Value::as_str) {
                Some("completed") => TodoStatus::Completed,
                Some("in_progress") => TodoStatus::InProgress,
                _ => TodoStatus::Pending,
            };
            Some(TodoItem {
                content: content.to_owned(),
                status,
            })
        })
        .collect()
}
