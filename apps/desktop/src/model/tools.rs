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
        return patch_files(input)
            .iter()
            .fold((0, 0), |(added, removed), file| {
                (added + file.added, removed + file.removed)
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

/// minimalist/lib/tools.ts `FileEdits`: one repository file a turn changed.
#[derive(Clone, Debug, PartialEq)]
pub struct FileEdits {
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

/// A task document: the daemon syncs files under `.devflow/tasks/<slug>/` as artifacts
/// (minimalist/lib/artifacts.ts `artifactPath`). They get document cards, not edit rows.
static ARTIFACT_PATH: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"/\.devflow/tasks/[^/]+/.+$").unwrap());

/// Files a Codex `apply_patch` touches, with their lines: `*** Add/Update/Delete File: <path>`
/// headers, then body lines whose first `+` or `-` marks an added or removed line (`+++x` is the
/// added line `++x`; this format has no unified-diff headers).
pub fn patch_files(input: &Map<String, Value>) -> Vec<FileEdits> {
    let mut files: Vec<FileEdits> = Vec::new();
    for line in lines(str_field(input, "patch_text").or_else(|| str_field(input, "input"))) {
        let header = ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
            .iter()
            .find_map(|prefix| line.strip_prefix(prefix));
        if let Some(path) = header {
            files.push(FileEdits {
                path: path.trim().to_owned(),
                added: 0,
                removed: 0,
            });
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if line.starts_with("*** ") {
            continue;
        }
        match line.as_bytes().first() {
            Some(b'+') => file.added += 1,
            Some(b'-') => file.removed += 1,
            _ => {}
        }
    }
    files
}

/// `turnWrites`, files part: each repository file a turn wrote, with lines added and removed,
/// in first-write order. Failed or denied edits changed nothing and don't count.
pub fn turn_file_writes(steps: &[Step]) -> Vec<FileEdits> {
    let mut files: Vec<FileEdits> = Vec::new();
    for step in steps {
        let Step::Tool(tool) = step else { continue };
        if !is_edit_tool(&tool.name) || tool.is_error {
            continue;
        }
        // A patch can touch several files, each named inside it; other edits name one.
        let edits = if normalize_tool_name(&tool.name) == "applypatch" {
            patch_files(&tool.input)
        } else {
            let (added, removed) = edit_counts(tool);
            let path = text_field(&tool.input, &["file_path", "path", "notebook_path"]);
            vec![FileEdits {
                path,
                added,
                removed,
            }]
        };
        for edit in edits {
            // A path the input doesn't give can't be listed or reviewed.
            if edit.path.is_empty() || ARTIFACT_PATH.is_match(&edit.path) {
                continue;
            }
            match files.iter_mut().find(|file| file.path == edit.path) {
                Some(file) => {
                    file.added += edit.added;
                    file.removed += edit.removed;
                }
                None => files.push(edit),
            }
        }
    }
    files
}

/// minimalist/lib/format.ts `commonDir`: the longest directory prefix (ending in `/`) of all paths.
pub fn common_dir(paths: &[&str]) -> String {
    let dirs: Vec<&str> = paths
        .iter()
        .map(|path| &path[..path.rfind('/').map_or(0, |at| at + 1)])
        .collect();
    let Some((first, rest)) = dirs.split_first() else {
        return String::new();
    };
    let mut root = first.to_string();
    for dir in rest {
        while !dir.starts_with(&root) {
            let cut = root[..root.len().saturating_sub(1)]
                .rfind('/')
                .map_or(0, |at| at + 1);
            root.truncate(cut);
        }
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patch_files_and_counts_come_from_the_patch() {
        let input = json!({ "patch_text": "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-old\n+new\n+++counter;\n*** Add File: docs/b.md\n+----\n*** End Patch" });
        let files = patch_files(input.as_object().unwrap());
        assert_eq!(
            files,
            vec![
                FileEdits {
                    path: "src/a.rs".into(),
                    added: 2,
                    removed: 1
                },
                FileEdits {
                    path: "docs/b.md".into(),
                    added: 1,
                    removed: 0
                },
            ]
        );
    }
}
