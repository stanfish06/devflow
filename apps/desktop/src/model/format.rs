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
