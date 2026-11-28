//! Server-sent events parser for byte chunks that may split events or UTF-8 sequences anywhere.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    /// Where the next search for an event end starts: bytes before it hold no `\n\n`. Keeps
    /// a large event that arrives in small chunks linear to scan.
    scanned: usize,
}

impl SseParser {
    /// Feed a chunk; returns the events it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        // Line endings may be CRLF; JSON payloads never carry a raw CR.
        self.buffer
            .extend(chunk.iter().copied().filter(|byte| *byte != b'\r'));
        let mut events = Vec::new();
        // Complete blocks are read through a cursor and dropped once, after the loop.
        let mut start = 0;
        let mut from = self.scanned.max(start);
        while let Some(found) = self.buffer[from..]
            .windows(2)
            .position(|pair| pair == b"\n\n")
        {
            let end = from + found;
            if let Some(event) = parse_block(&String::from_utf8_lossy(&self.buffer[start..end])) {
                events.push(event);
            }
            start = end + 2;
            from = start;
        }
        self.buffer.drain(..start);
        // The last byte may be the first `\n` of a pair the next chunk completes.
        self.scanned = self.buffer.len().saturating_sub(1);
        events
    }
}

fn parse_block(block: &str) -> Option<SseEvent> {
    let mut event = String::from("message");
    let mut data: Vec<&str> = Vec::new();
    for line in block.split('\n') {
        // A line starting with ':' is a comment, e.g. a keep-alive.
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event = value.to_owned(),
            "data" => data.push(value),
            _ => {}
        }
    }
    (!data.is_empty()).then(|| SseEvent {
        event,
        data: data.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_data_lines_and_survives_split_chunks() {
        let mut parser = SseParser::default();
        let input = "event: data\r\ndata: [\r\ndata: {\"k\":\"v\"}\r\ndata: ]\r\n\r\n: keep-alive\n\nevent: control\ndata: {\"streamNextOffset\":\"1_2\"}\n\n";
        let mut events = Vec::new();
        for chunk in input.as_bytes().chunks(7) {
            events.extend(parser.push(chunk));
        }
        assert_eq!(
            events,
            vec![
                SseEvent {
                    event: "data".into(),
                    data: "[\n{\"k\":\"v\"}\n]".into()
                },
                SseEvent {
                    event: "control".into(),
                    data: "{\"streamNextOffset\":\"1_2\"}".into()
                },
            ]
        );
    }
}
