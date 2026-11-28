//! The web UI in a native webview. It always shows the whole app (sidebar, task panel, artifact and
//! review panels); the native thread view covers only the web thread column.
//!
//! A script injected into each page reports where the minimalist UI's thread column is and which
//! session it shows, and hides the web thread's content so the native view drawn over it is the
//! only one visible and focusable.
//!
//! How the webview sits in the window is per platform: a WKWebView in a gpui-fast native view on
//! macOS (`macos`), WebKitGTK in an X11 child window of the window's composition on Linux (`linux`).

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "linux")]
use linux::Embedding;
#[cfg(target_os = "macos")]
use macos::Embedding;

use std::rc::Rc;

use gpui_kit::*;
use serde::Deserialize;

/// Where the web page lays out its thread column, in window coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadSlot {
    pub session_id: String,
    /// A page popup overlaps the column, so the page shows its own thread there for now.
    pub covered: bool,
    pub actions: WebActions,
    pub bounds: Bounds<Pixels>,
}

/// Transcript actions the page offers, which the native rows forward to it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WebActions {
    /// The edits card has Review (and file rows that open it).
    pub reviewable: bool,
    /// User turns after the first have "Fork from this message".
    pub forkable: bool,
}

pub enum WebEvent {
    /// The page handed the transcript back at this reading position, in page pixels.
    Anchor { turn: Option<usize>, offset: f32 },
    /// The thread column moved, changed session, or went away (`None`).
    Thread(Option<ThreadSlot>),
    /// The theme the user picked in the page: `None` follows the system.
    Theme(Option<component::ThemeMode>),
}

pub struct WebPane {
    webview: Rc<wry::WebView>,
    /// The webview's place in the window (see the module docs).
    embedding: Embedding,
    _bridge: Task<()>,
}

impl EventEmitter<WebEvent> for WebPane {}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BridgeMessage {
    #[serde(rename_all = "camelCase")]
    Thread {
        session_id: Option<String>,
        covered: bool,
        #[serde(default)]
        reviewable: bool,
        #[serde(default)]
        forkable: bool,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    },
    /// Where the page's transcript was scrolled when it handed back to the native one.
    Anchor {
        turn: Option<usize>,
        offset: f32,
    },
    Theme {
        dark: bool,
        system: bool,
    },
}

/// Sent by the page-load handler itself, never by a page: clears the native transcript.
const PAGE_STARTED: &str = "{\"type\":\"thread\",\"sessionId\":null,\"covered\":false,\"x\":0,\"y\":0,\"width\":0,\"height\":0}";

/// IPC payloads above this size are not ours.
const MAX_MESSAGE_BYTES: usize = 4096;

/// Class the bridge puts on the web transcript area the native view covers.
const NATIVE_CLASS: &str = "devflow-native-thread";

fn bridge_script() -> String {
    format!(
        r#"(() => {{
  if (window.__devflowDesktop) return;
  window.__devflowDesktop = true;
  const uuid = /^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$/i;
  // The native view draws the thread; the web copy stays laid out (its box is the slot) but
  // invisible, so it neither shows through nor takes keyboard focus.
  const style = () => {{
    if (document.getElementById('{class}-style')) return;
    const element = document.createElement('style');
    element.id = '{class}-style';
    element.textContent = '.{class} > * {{ visibility: hidden !important; }}';
    document.head.appendChild(element);
  }};
  // Which session the minimalist thread column shows: the session route's id, or on a task route
  // the `?session=` link, else the one MinimalistTaskPage remembers after each render
  // (apps/web/src/minimalist/lib/task-navigation.ts).
  const sessionId = () => {{
    const [kind, id, ...rest] = location.pathname.split('/').filter(Boolean);
    if (rest.length || !id || !uuid.test(id)) return null;
    if (kind === 'sessions') return id;
    if (kind !== 'tasks') return null;
    const explicit = new URLSearchParams(location.search).get('session');
    try {{ return explicit ?? localStorage.getItem('hl-min-task-session:' + id); }} catch {{ return explicit; }}
  }};
  // Popups the minimalist UI draws over the page (components/Menu.tsx, SearchPalette.tsx, Dialog.tsx,
  // Toast.tsx, and the narrow-window drawer scrims).
  // .slash-menu is the composer's slash-command and @-mention list (minimalist Suggestions.tsx),
  // which opens upward over the transcript.
  const overlays = 'dialog[open], .toast, .slash-menu, [class$="-scrim"], [class*="-scrim "]';
  const webCards = '.next-card, .next-row, .worked.setup, .doccard';
  // Actions the native transcript can offer only if the page does: Review on the edits card
  // (the task has a reviewable workspace) and Fork on user turns (Transcript.tsx `onFork`).
  const actions = (area) => ({{
    reviewable: area.querySelector('.diffcard.edits .review-link') !== null,
    forkable: area.querySelector('.turn-user button[aria-label="Fork from this message"]') !== null,
  }});
  // Where the native transcript is scrolled: `turn` (0-based, null for the end) and pixels into it.
  let anchor = {{ turn: null, offset: 0 }};
  window.__devflowAnchor = (turn, offset) => {{ anchor = {{ turn, offset }}; }};
  const showAt = (area) => {{
    const turns = [...(area.querySelector(':scope > .col')?.children ?? [])]
      .filter((el) => !el.classList.contains('boot-mark'));
    const turn = anchor.turn === null ? null : turns[anchor.turn];
    if (!turn) {{ area.scrollTop = area.scrollHeight; return; }}
    area.scrollTop += turn.getBoundingClientRect().top - area.getBoundingClientRect().top + anchor.offset;
  }};
  // The area the page last showed its own transcript in.
  let shown = null;
  const handBack = (area) => {{
    const top = area.getBoundingClientRect().top;
    const turns = [...(area.querySelector(':scope > .col')?.children ?? [])]
      .filter((el) => !el.classList.contains('boot-mark'));
    const atEnd = area.scrollTop + area.clientHeight >= area.scrollHeight - 4;
    const turn = atEnd ? -1 : turns.findIndex((el) => el.getBoundingClientRect().bottom > top);
    const offset = turn < 0 ? 0 : top - turns[turn].getBoundingClientRect().top;
    window.ipc.postMessage(JSON.stringify({{ type: 'anchor', turn: turn < 0 ? null : turn, offset }}));
  }};
  let last = '';
  let marked = null;
  // The area shrinks when the composer grows a line, which changes only a textarea's `rows`.
  let sized = null;
  const resized = new ResizeObserver(() => schedule());
  const report = () => {{
    // ThreadView's <main> is the only one with a composer dock (minimalist/components/ThreadView.tsx).
    // The native view covers the transcript; the page keeps its titlebar and dock.
    const main = document.querySelector('.minimalist-ui') &&
      [...document.querySelectorAll('main.main:has(> .dock) > .scroll')].find((el) => !el.closest('[hidden]'));
    const id = main ? sessionId() : null;
    if (sized !== (main || null)) {{
      resized.disconnect();
      if (main) resized.observe(main);
      sized = main || null;
    }}
    const rect = main && id ? main.getBoundingClientRect() : null;
    const target = rect && rect.width > 0 && rect.height > 0 ? main : null;
    // A page popup over the column (menu, palette, dialog, toast, drawer scrim) must show: the
    // native view steps aside and the web thread shows under the popup instead.
    // Cards the web draws at the end of its transcript (NextStepCard, WorkspaceSetup) have no native
    // counterpart, so the web transcript shows while one is there.
    // A modal dialog (Menu.tsx uses showModal()) has a full-window backdrop, so it covers the area
    // wherever its own box is.
    const covered = target !== null && (target.querySelector(webCards) !== null ||
      document.querySelector('dialog:modal') !== null ||
      [...document.querySelectorAll(overlays)].some((el) => {{
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left &&
        box.top < rect.bottom && box.bottom > rect.top;
    }}));
    const hide = covered ? null : target;
    // Showing the page's transcript in place of the native one: start where the reader was.
    if (marked && !hide && marked === target) showAt(target);
    // And back: the native one continues where the reader left the page's.
    if (!marked && hide && hide === shown) handBack(hide);
    shown = target;
    if (marked !== hide) {{
      marked?.classList.remove('{class}');
      hide?.classList.add('{class}');
      marked = hide;
    }}
    const message = JSON.stringify(target
      ? {{ type: 'thread', sessionId: id, covered, ...actions(target), x: rect.x, y: rect.y, width: rect.width, height: rect.height }}
      : {{ type: 'thread', sessionId: null, covered: false, x: 0, y: 0, width: 0, height: 0 }});
    if (message === last) return;
    last = message;
    window.ipc.postMessage(message);
  }};
  let pending = false;
  const schedule = () => {{
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {{ pending = false; report(); }});
  }};
  const start = () => {{
    style();
    new MutationObserver(schedule).observe(document.body, {{
      subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open', 'rows'],
    }});
    addEventListener('resize', schedule);
    addEventListener('popstate', schedule);
    schedule();
  }};
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
  // The window draws in the page's theme: ThemeProvider sets `data-theme` (light or dark) and
  // `data-theme-preference` (light, dark or system) on <html>. Nothing is sent before both are set,
  // so the window keeps the system appearance until then.
  let theme = '';
  const reportTheme = () => {{
    const {{ theme: value, themePreference: preference }} = document.documentElement.dataset;
    if (value !== 'light' && value !== 'dark') return;
    if (preference !== 'light' && preference !== 'dark' && preference !== 'system') return;
    if (value + preference === theme) return;
    theme = value + preference;
    window.ipc.postMessage(JSON.stringify({{ type: 'theme', dark: value === 'dark', system: preference === 'system' }}));
  }};
  new MutationObserver(reportTheme).observe(document.documentElement, {{
    attributes: true, attributeFilter: ['data-theme', 'data-theme-preference'],
  }});
  reportTheme();
  // Native code asks again after a page zoom change, which moves the area without a DOM change.
  window.__devflowReport = () => {{ last = ''; schedule(); }};
  // The native transcript's attachment chips open the web transcript's own link (Transcript.tsx
  // SentFile), which carries the signed download URL.
  // Edits card `card` (0-based among the transcript's edits cards): a file's row, else Review.
  window.__devflowReview = (card, path) => {{
    const element = document.querySelectorAll('.{class} .diffcard.edits')[card];
    const row = path === null ? null :
      [...(element?.querySelectorAll('button.ef') ?? [])].find((button) => button.title === path);
    (row ?? element?.querySelector('.review-link'))?.click();
  }};
  // Fork from user turn `turn` (0-based among sent user turns).
  window.__devflowFork = (turn) => {{
    document.querySelectorAll('.{class} .turn-user:not(.outgoing)')[turn]
      ?.querySelector('button[aria-label="Fork from this message"]')?.click();
  }};
  window.__devflowOpenAttachment = (name, occurrence) => {{
    const links = document.querySelectorAll('.{class} a.sent-image, .{class} a.attachment');
    [...links].filter((link) => link.title === name)[occurrence]?.click();
  }};
}})();"#,
        class = NATIVE_CLASS
    )
}

impl WebPane {
    /// `start` is the first page to load: the app's origin, or a deep link into it.
    /// `start` is the first page to load, on the app's origin; `origin` is the app origin, the
    /// only one whose pages may drive the native views.
    pub fn new(
        start: url::Url,
        origin: url::Origin,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (sender, receiver) = async_channel::unbounded::<String>();
        let ipc_sender = sender.clone();
        let load_sender = sender.clone();
        let builder = wry::WebViewBuilder::new()
            .with_initialization_script(bridge_script())
            .with_focused(true)
            // Links the page opens in a new tab (target=_blank: attachments, PRs, docs) go to the
            // default browser, as a browser would open a tab.
            .with_new_window_req_handler(|url, _| {
                if url.starts_with("https://") || url.starts_with("http://") {
                    open_in_browser(&url);
                }
                wry::NewWindowResponse::Deny
            })
            // Only the app's own pages talk to the bridge: the sending frame's URL must be on its
            // origin, so another site loaded here can't put authenticated transcripts over itself.
            .with_ipc_handler(move |request| {
                let from_app = url::Url::parse(&request.uri().to_string())
                    .is_ok_and(|url| url.origin() == origin);
                let body = request.body();
                if from_app && body.len() <= MAX_MESSAGE_BYTES {
                    let _ = ipc_sender.try_send(body.clone());
                }
            })
            // A main-frame load replaces the page, and with it any transcript area it reported;
            // the next app page reports its own. A page off the app's origin never does.
            .with_on_page_load_handler(move |event, _| {
                if matches!(event, wry::PageLoadEvent::Started) {
                    let _ = load_sender.try_send(String::from(PAGE_STARTED));
                }
            });

        #[cfg(debug_assertions)]
        let builder = builder.with_devtools(true);
        let (webview, embedding) =
            Embedding::new(builder, start, window, cx).expect("create the webview");

        let bridge = cx.spawn(async move |this, cx| {
            while let Ok(message) = receiver.recv().await {
                // Page content is untrusted: accept only the known shapes, and only uuid sessions.
                let event = match serde_json::from_str::<BridgeMessage>(&message) {
                    Ok(BridgeMessage::Thread {
                        session_id,
                        covered,
                        reviewable,
                        forkable,
                        x,
                        y,
                        width,
                        height,
                    }) => WebEvent::Thread(
                        session_id
                            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                            .map(|session_id| ThreadSlot {
                                session_id,
                                covered,
                                actions: WebActions {
                                    reviewable,
                                    forkable,
                                },
                                bounds: Bounds::new(
                                    point(px(x), px(y)),
                                    size(px(width), px(height)),
                                ),
                            }),
                    ),
                    Ok(BridgeMessage::Anchor { turn, offset }) => WebEvent::Anchor { turn, offset },
                    Ok(BridgeMessage::Theme { dark, system }) => {
                        WebEvent::Theme((!system).then_some(if dark {
                            component::ThemeMode::Dark
                        } else {
                            component::ThemeMode::Light
                        }))
                    }
                    Err(_) => continue,
                };
                if this.update(cx, |_, cx| cx.emit(event)).is_err() {
                    break;
                }
            }
        });
        Self {
            webview,
            embedding,
            _bridge: bridge,
        }
    }

    /// Open Review from edits card `card`, at `path` when given.
    pub fn review(&self, card: usize, path: Option<&str>) {
        let path = serde_json::to_string(&path).expect("a path serializes");
        self.run(&format!(
            "window.__devflowReview && window.__devflowReview({card}, {path})"
        ));
    }

    /// Where the native transcript is scrolled, in page pixels: the page's own transcript starts
    /// there when it shows under a popup. `None` is the end.
    pub fn set_anchor(&self, turn: Option<usize>, offset: f32) {
        let turn = turn.map_or_else(|| "null".to_owned(), |turn| turn.to_string());
        self.run(&format!(
            "window.__devflowAnchor && window.__devflowAnchor({turn}, {offset})"
        ));
    }

    /// Fork from sent user turn `turn`.
    pub fn fork(&self, turn: usize) {
        self.run(&format!(
            "window.__devflowFork && window.__devflowFork({turn})"
        ));
    }

    fn run(&self, script: &str) {
        if let Err(error) = self.webview.evaluate_script(script) {
            log::warn!("webview script: {error}");
        }
    }

    /// Open the `occurrence`-th attachment named `name` in the covered transcript, through the
    /// page's own link.
    pub fn open_attachment(&self, name: &str, occurrence: usize) {
        let script = format!(
            "window.__devflowOpenAttachment && window.__devflowOpenAttachment({}, {occurrence})",
            serde_json::to_string(name).expect("a string serializes")
        );
        if let Err(error) = self.webview.evaluate_script(&script) {
            log::warn!("open attachment {name}: {error}");
        }
    }

    /// Let a GPUI binding for `A` run before the page sees its keys, as a browser's own shortcuts
    /// (zoom) take precedence over the page's.
    pub fn reserve_action<A: Action + Default>(&self, cx: &App) {
        self.embedding.reserve_action::<A>(cx);
    }

    /// Set the page zoom (as a browser's ⌘+/⌘−: WKWebView `pageZoom`, WebKitGTK `zoom-level`) and
    /// report the transcript area again, since it moves in window coordinates.
    pub fn set_zoom(&self, zoom: f32, window: &Window) {
        if let Err(error) = self.webview.zoom(self.embedding.page_zoom(zoom, window)) {
            log::warn!("webview zoom: {error}");
        }
        self.run("window.__devflowReport && window.__devflowReport()");
    }

    /// Show `element` over the page: GPUI content in the window's root view is painted under the
    /// webview on Linux, where only the composition's overlay surface covers it.
    pub fn cover(&self, element: impl IntoElement) -> AnyElement {
        self.embedding.cover(element)
    }

    /// The window's own content was clicked: give it back the keyboard if the page had it. On
    /// macOS the native view's focus handle already does this.
    pub fn release_keyboard(&self) {
        #[cfg(target_os = "linux")]
        self.embedding.release_keyboard();
    }
}

impl Render for WebPane {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.embedding.element())
    }
}

/// Open `url` in the default browser.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = linux::browser_command();
    if let Err(error) = command.arg(url).spawn() {
        log::warn!("open {url}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::BridgeMessage;

    #[test]
    fn parses_the_theme_message_the_bridge_sends() {
        let message =
            serde_json::from_str::<BridgeMessage>(r#"{"type":"theme","dark":true,"system":false}"#);
        assert!(matches!(
            message,
            Ok(BridgeMessage::Theme {
                dark: true,
                system: false
            })
        ));
        let message = serde_json::from_str::<BridgeMessage>(
            r#"{"type":"theme","dark":"yes","system":false}"#,
        );
        assert!(message.is_err());
    }
}
