//! The window: the web UI, with the native thread drawn over the web thread column.

use gpui_kit::component::Theme;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::config::{StackConfig, devflow_home};
use crate::ui::thread::ThreadView;
use crate::ui::web::{ThreadSlot, WebEvent, WebPane};

actions!(devflow, [Quit, ZoomIn, ZoomOut, ZoomReset]);

/// Chrome's zoom levels, so ⌘+/⌘− step the way they do in the browser.
const ZOOM_LEVELS: [f32; 15] = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];
/// gpui-kit's theme sizes at 100%: Root sets the window rem size from `font_size` each frame.
const BASE_FONT_SIZE: f32 = 16.;
const BASE_MONO_FONT_SIZE: f32 = 13.;

/// Where the zoom level is kept between launches.
fn zoom_file() -> Option<std::path::PathBuf> {
    devflow_home().map(|home| home.join("desktop-zoom"))
}

const CONTEXT: &str = "DevflowApp";

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        // `=` is the key under `+`; both spellings, as browsers accept.
        KeyBinding::new("cmd-=", ZoomIn, None),
        KeyBinding::new("cmd-+", ZoomIn, None),
        KeyBinding::new("cmd--", ZoomOut, None),
        KeyBinding::new("cmd-0", ZoomReset, None),
        KeyBinding::new("ctrl-=", ZoomIn, None),
        KeyBinding::new("ctrl-+", ZoomIn, None),
        KeyBinding::new("ctrl--", ZoomOut, None),
        KeyBinding::new("ctrl-0", ZoomReset, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
    // Edit items map to AppKit's cut:/copy:/paste:/selectAll:, which the first responder handles:
    // the webview's own editing, or GPUI's input actions through the app delegate. Without this
    // menu, editing shortcuts never reach the webview.
    use gpui_kit::component::input;
    cx.set_menus(vec![
        Menu::new("Devflow").items([MenuItem::action("Quit Devflow", Quit)]),
        Menu::new("View").items([
            MenuItem::action("Actual Size", ZoomReset),
            MenuItem::action("Zoom In", ZoomIn),
            MenuItem::action("Zoom Out", ZoomOut),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", input::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", input::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", input::Paste, OsAction::Paste),
            MenuItem::os_action("Select All", input::SelectAll, OsAction::SelectAll),
        ]),
    ]);
}

pub struct AppView {
    web: Entity<WebPane>,
    /// The native thread and the web column it covers.
    thread: Option<(Entity<ThreadView>, ThreadSlot)>,
    /// Page and native zoom; the page reports the transcript area in its own (zoomed) CSS pixels.
    zoom: f32,
    _subscriptions: Vec<Subscription>,
}

impl AppView {
    /// `initial` is a web path to open first, like a deep link.
    pub fn new(
        config: &StackConfig,
        initial: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let web = cx.new(|cx| WebPane::new(config.app.clone(), window, cx));
        // The page binds ⌘ plus a digit (⌘0 included) to recent tasks; zoom keys win, as in a browser.
        web.read(cx).reserve_action::<ZoomIn>();
        web.read(cx).reserve_action::<ZoomOut>();
        web.read(cx).reserve_action::<ZoomReset>();
        let subscriptions = vec![
            cx.subscribe_in(
                &web,
                window,
                |this, _, event: &WebEvent, window, cx| match event {
                    WebEvent::Thread(slot) => this.place_thread(slot.clone(), window, cx),
                },
            ),
            // Native views follow the system's light or dark mode, as the web UI does.
            cx.observe_window_appearance(window, |this, window, cx| {
                Theme::sync_system_appearance(Some(window), cx);
                this.apply_zoom(window, cx);
            }),
        ];
        Theme::sync_system_appearance(Some(window), cx);
        if let Some(path) = initial {
            web.update(cx, |web, _| web.navigate(&path));
        }
        let zoom = zoom_file()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| text.trim().parse::<f32>().ok())
            .filter(|zoom| ZOOM_LEVELS.contains(zoom))
            .unwrap_or(1.0);
        let mut this = Self {
            web,
            thread: None,
            zoom,
            _subscriptions: subscriptions,
        };
        this.apply_zoom(window, cx);
        this
    }

    /// Step to the next zoom level in `direction` (+1, -1), or back to 100% with 0.
    fn zoom_by(&mut self, direction: i32, window: &mut Window, cx: &mut Context<Self>) {
        let current = ZOOM_LEVELS
            .iter()
            .position(|level| *level == self.zoom)
            .unwrap_or(7);
        self.zoom = match direction {
            0 => 1.0,
            d if d > 0 => ZOOM_LEVELS[(current + 1).min(ZOOM_LEVELS.len() - 1)],
            _ => ZOOM_LEVELS[current.saturating_sub(1)],
        };
        if let Some(path) = zoom_file()
            && let Err(error) = std::fs::write(&path, self.zoom.to_string())
        {
            log::warn!("save zoom to {}: {error}", path.display());
        }
        self.apply_zoom(window, cx);
    }

    /// Scale the page and the native views together.
    fn apply_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.web.read(cx).set_zoom(self.zoom);
        let theme = Theme::global_mut(cx);
        theme.font_size = px(BASE_FONT_SIZE * self.zoom);
        theme.mono_font_size = px(BASE_MONO_FONT_SIZE * self.zoom);
        window.refresh();
    }

    /// Cover the web thread column with the native thread for its session, or remove it.
    fn place_thread(
        &mut self,
        slot: Option<ThreadSlot>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match slot {
            None => self.thread = None,
            Some(slot) => match &mut self.thread {
                Some((_, current)) if current.session_id == slot.session_id => *current = slot,
                _ => {
                    let session_id = slot.session_id.clone();
                    let thread = cx.new(|cx| ThreadView::new(session_id, window, cx));
                    self.thread = Some((thread, slot));
                }
            },
        }
        cx.notify();
    }
}

impl Render for AppView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .relative()
            .key_context(CONTEXT)
            .on_action(cx.listener(|this, _: &ZoomIn, window, cx| this.zoom_by(1, window, cx)))
            .on_action(cx.listener(|this, _: &ZoomOut, window, cx| this.zoom_by(-1, window, cx)))
            .on_action(cx.listener(|this, _: &ZoomReset, window, cx| this.zoom_by(0, window, cx)))
            .child(self.web.clone())
            .when_some(
                self.thread.as_ref().filter(|(_, slot)| !slot.covered),
                |this, (thread, slot)| {
                    // Page CSS pixels to window pixels.
                    let (origin, size) = (slot.bounds.origin, slot.bounds.size);
                    let bounds = Bounds::new(
                        point(origin.x * self.zoom, origin.y * self.zoom),
                        gpui_kit::size(size.width * self.zoom, size.height * self.zoom),
                    );
                    // Painted after the page's native view, so it covers the page and takes the
                    // clicks within its bounds (gpui-fast NativeView).
                    this.child(
                        div()
                            .id("native-thread")
                            .absolute()
                            .left(bounds.origin.x)
                            .top(bounds.origin.y)
                            .w(bounds.size.width)
                            .h(bounds.size.height)
                            .occlude()
                            .child(thread.clone()),
                    )
                },
            )
    }
}
