//! Port of the parts of apps/web/src/minimalist/lib/format.ts the native views use.

pub fn format_duration(ms: i64) -> String {
    let total = ((ms.max(0) as f64) / 1000.0).round() as i64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

/// Local wall-clock time, e.g. "3:04 PM".
pub fn format_clock(timestamp_ms: i64) -> String {
    jiff::Timestamp::from_millisecond(timestamp_ms)
        .map(|ts| {
            ts.to_zoned(jiff::tz::TimeZone::system())
                .strftime("%-I:%M %p")
                .to_string()
        })
        .unwrap_or_default()
}

pub fn plural(count: usize, one: &str) -> String {
    if count == 1 {
        format!("{count} {one}")
    } else {
        format!("{count} {one}s")
    }
}

pub fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(index) if index + 1 < trimmed.len() => trimmed[index + 1..].to_owned(),
        _ => trimmed.to_owned(),
    }
}

pub fn first_line(text: &str, max: usize) -> String {
    let line = text.trim().lines().next().unwrap_or("");
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_owned()
    }
}

pub fn truncate(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    format!(
        "{}\n… {}",
        text.chars().take(max).collect::<String>(),
        plural(count - max, "more character")
    )
}

/// apps/web/src/minimalist/lib/attachments.ts `UPLOAD_MENTION`: the composer sends each upload as
/// an `@.devflow/tasks/<slug>/uploads/...` mention.
static UPLOAD_MENTION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"@\.devflow/tasks/[^/\s]+/(uploads/\S+)").unwrap()
});

/// `splitAttachments`: the message without its upload mentions, and the uploads' file names.
pub fn split_attachments(message: &str) -> (String, Vec<String>) {
    let files = UPLOAD_MENTION
        .captures_iter(message)
        .filter_map(|captures| captures.get(1).map(|name| name.as_str().to_owned()))
        .collect();
    let text = UPLOAD_MENTION.replace_all(message, "");
    let text = regex::Regex::new(r" {2,}").unwrap().replace_all(&text, " ");
    let text = regex::Regex::new(r"(?m)[ \t]+$")
        .unwrap()
        .replace_all(&text, "");
    let text = regex::Regex::new(r"\n{3,}")
        .unwrap()
        .replace_all(&text, "\n\n");
    (text.trim().to_owned(), files)
}

/// minimalist/lib/artifacts.ts `artifactName`: uploads carry a uuid prefix to stay unique; people
/// know them by the original name.
pub fn artifact_name(file_name: &str) -> String {
    let base = file_name.rsplit('/').next().unwrap_or(file_name);
    regex::Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-")
        .unwrap()
        .replace(base, "")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_mentions_become_files() {
        let (text, files) = split_attachments(
            "look at this  @.devflow/tasks/fix-ui/uploads/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b-shot.png please",
        );
        assert_eq!(text, "look at this please");
        assert_eq!(
            files,
            vec!["uploads/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b-shot.png"]
        );
        assert_eq!(artifact_name(&files[0]), "shot.png");
    }
}
