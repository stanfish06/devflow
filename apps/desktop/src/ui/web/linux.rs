//! Linux: WebKitGTK, through wry, in an X11 child window of the window's composition.
//!
//! gpui-fast composes a window from GPUI's base surface, native surfaces (X11 child windows) and
//! GPUI's overlay surface, cutting overlay content out of the native windows with the SHAPE
//! extension. The webview is a native surface; the native thread is painted on the overlay
//! surface (`cover`) so it shows over the page and takes the clicks there.
//!
//! WebKitGTK only embeds into X11 windows, so the app runs on X11, through XWayland on a Wayland
//! session. GTK has no main loop of its own here: GPUI's event loop pumps it.
//!
//! The X server delivers the keyboard to one window. The page has it after a click on the page;
//! a click on GPUI's content takes it back (`release_keyboard`). Keys bound to reserved actions
//! (zoom, quit) reach GPUI from either.

use std::cell::{Cell, RefCell};
use std::ffi::{OsString, c_ulong};
use std::num::NonZeroU32;
use std::rc::Rc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};
use base64::Engine as _;
use gpui_kit::*;
use gtk::gdk;
use gtk::glib::Propagation;
use gtk::glib::translate::ToGlibPtr as _;
use gtk::prelude::*;
use webkit2gtk::{WebContextExt as _, WebViewExt as _};
use wry::raw_window_handle as rwh;
use wry::{WebViewBuilderExtUnix as _, WebViewExtUnix as _};
use x11_dl::xlib;

use super::WebPane;
use crate::net::Net;
use crate::store::Store;

/// How often GTK's events are handled while GPUI's loop runs: often enough for WebKitGTK to keep
/// up with a 120 Hz frame clock, cheap when nothing is pending.
const GTK_PUMP_INTERVAL: Duration = Duration::from_millis(8);

/// Caddy renews its local certificates well before they expire (12 h); the webview is handed the
/// current ones this often.
const CERTIFICATE_REFRESH: Duration = Duration::from_secs(30 * 60);

/// After a page fails with a TLS error, the next one this soon after shows WebKit's error page
/// instead of trusting the stack's certificates again.
const TLS_RETRY_INTERVAL: Duration = Duration::from_secs(10);

/// `WAYLAND_DISPLAY` as the session had it, for the browser `xdg-open` starts.
static WAYLAND_DISPLAY: OnceLock<Option<OsString>> = OnceLock::new();

/// Run GPUI and GTK on X11: WebKitGTK embeds into X11 windows only. Called first thing in `main`,
/// before any thread starts.
pub fn prepare_display() {
    let wayland = std::env::var_os("WAYLAND_DISPLAY");
    if wayland.is_some() && std::env::var_os("DISPLAY").is_none() {
        eprintln!(
            "devflow desktop: the webview needs X11, and this Wayland session has no XWayland \
             (DISPLAY is not set)"
        );
        std::process::exit(1);
    }
    // SAFETY: nothing else runs yet; `main` calls this before starting any thread.
    unsafe {
        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::set_var("GDK_BACKEND", "x11");
    }
    WAYLAND_DISPLAY.get_or_init(|| wayland);
}

/// `xdg-open` with the session's own environment, so the browser opens natively on Wayland.
pub fn browser_command() -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    if let Some(Some(wayland)) = WAYLAND_DISPLAY.get() {
        command.env("WAYLAND_DISPLAY", wayland);
        command.env_remove("GDK_BACKEND");
    }
    command
}

pub struct Embedding {
    state: Rc<State>,
    surface: WindowCompositionSurface,
    overlay: CompositionSurfaceId,
    _tasks: Vec<Task<()>>,
    _activation: Subscription,
}

struct State {
    webview: Rc<wry::WebView>,
    /// The windows the webview is in; dropped after it.
    host: Host,
    /// The size the webview was last given, in device pixels.
    size: Cell<Size<DevicePixels>>,
    /// The app zoom and the window scale the page zoom was last set for.
    zoom: Cell<f32>,
    scale: Cell<f32>,
    keyboard: Keyboard,
    /// Single keystrokes the page leaves to GPUI, with the action each is bound to.
    reserved: RefCell<Vec<(Keystroke, Box<dyn Action>)>>,
}

enum GtkEvent {
    /// The page was clicked and has the keyboard now.
    WebFocused,
    /// A reserved key was pressed in the page.
    Action(Box<dyn Action>),
    /// A page of the stack failed its TLS check: hand the webview the current certificates and
    /// load it again.
    Retrust(String),
}

impl Embedding {
    pub fn new(
        builder: wry::WebViewBuilder,
        start: url::Url,
        window: &mut Window,
        cx: &mut Context<WebPane>,
    ) -> anyhow::Result<(Rc<wry::WebView>, Self)> {
        let composition = window
            .enable_window_composition()
            .context("compose the window (the X server needs the SHAPE extension)")?;
        let overlay = composition.overlay_surface();
        let surface = composition.create_native_surface()?;
        let parent = match *surface
            .platform_surface()?
            .platform_handle()?
            .downcast::<rwh::RawWindowHandle>()
            .map_err(|_| anyhow::anyhow!("the native surface has no window handle"))?
        {
            rwh::RawWindowHandle::Xcb(handle) => handle.window,
            rwh::RawWindowHandle::Xlib(handle) => {
                NonZeroU32::new(handle.window as u32).context("no X11 window")?
            }
            _ => bail!("the native surface is not an X11 window"),
        };
        let app_window = match rwh::HasWindowHandle::window_handle(&*window)?.as_raw() {
            rwh::RawWindowHandle::Xcb(handle) => c_ulong::from(handle.window.get()),
            rwh::RawWindowHandle::Xlib(handle) => handle.window,
            _ => bail!("the window is not an X11 window (WebKitGTK embeds only into X11)"),
        };

        let display = gdk::Display::default()
            .and_then(|display| display.downcast::<gdkx11::X11Display>().ok())
            .context("GTK is not on X11")?;
        // The webview lives in a child window of the surface's (`Host`); the surface window is
        // GPUI's to move, resize, shape and destroy.
        let (host, container) = Host::new(&display, parent)?;
        let webview = builder.build_gtk(&container).context("build the webview")?;
        host.gtk_window.show_all();
        let web = webview.webview();
        let web_window = host.x_window;

        let state = Rc::new(State {
            webview: Rc::new(webview),
            host,
            size: Cell::new(Size::default()),
            zoom: Cell::new(1.),
            scale: Cell::new(window.scale_factor()),
            keyboard: Keyboard {
                xlib: xlib::Xlib::open().context("load Xlib")?,
                display,
                web_window,
                app_window,
                web_focused: Cell::new(false),
            },
            reserved: RefCell::default(),
        });

        let (sender, receiver) = async_channel::unbounded::<GtkEvent>();
        // A click in the page gives it the keyboard.
        web.connect_button_press_event({
            let state = state.clone();
            let sender = sender.clone();
            move |_, _| {
                if !state.keyboard.web_focused.get() {
                    state.keyboard.focus_web();
                    let _ = sender.try_send(GtkEvent::WebFocused);
                }
                Propagation::Proceed
            }
        });
        // Reserved keys go to GPUI before the page sees them, as a browser's own shortcuts do.
        state.host.gtk_window.connect_key_press_event({
            let state = state.clone();
            let sender = sender.clone();
            move |_, event| match state.reserved_action(event) {
                Some(action) => {
                    let _ = sender.try_send(GtkEvent::Action(action));
                    Propagation::Stop
                }
                None => Propagation::Proceed,
            }
        });

        let net = Store::global(cx).read(cx).net();
        let trusted = net.config().ca_file.is_some();
        // Caddy's certificates rotate: a page that fails with them is loaded again with the
        // current ones, once per TLS_RETRY_INTERVAL.
        let last_retry = Cell::new(None::<Instant>);
        web.connect_load_failed_with_tls_errors(move |_, uri, _, errors| {
            let recent = last_retry
                .get()
                .is_some_and(|at| at.elapsed() < TLS_RETRY_INTERVAL);
            log::warn!("TLS error {errors:?} loading {uri}");
            if !trusted || recent || !is_stack_url(&net, uri) {
                if !trusted {
                    log::warn!(
                        "no Caddy CA to trust: run `bun run devflow up` once, or set DEVFLOW_CA_FILE"
                    );
                }
                return false;
            }
            last_retry.set(Some(Instant::now()));
            let _ = sender.try_send(GtkEvent::Retrust(uri.to_owned()));
            true
        });

        let tasks = vec![
            // GTK's main loop, run from GPUI's.
            cx.spawn(async move |_, cx| {
                loop {
                    while gtk::events_pending() {
                        gtk::main_iteration_do(false);
                    }
                    cx.background_executor().timer(GTK_PUMP_INTERVAL).await;
                }
            }),
            cx.spawn_in(window, {
                let state = state.clone();
                async move |this, cx| {
                    while let Ok(event) = receiver.recv().await {
                        let result = match event {
                            // The page has the keyboard: GPUI's own content no longer does.
                            GtkEvent::WebFocused => this.update_in(cx, |_, window, cx| {
                                window.blur(cx);
                            }),
                            GtkEvent::Action(action) => this.update_in(cx, |_, window, cx| {
                                window.dispatch_action(action, cx);
                            }),
                            GtkEvent::Retrust(uri) => {
                                trust_stack_certificates(&state.webview, cx).await;
                                if let Err(error) = state.webview.load_url(&uri) {
                                    log::warn!("load {uri}: {error}");
                                }
                                Ok(())
                            }
                        };
                        if result.is_err() {
                            break;
                        }
                    }
                }
            }),
            // The first page loads once the webview trusts the stack's certificates.
            cx.spawn({
                let webview = state.webview.clone();
                async move |_, cx| {
                    trust_stack_certificates(&webview, cx).await;
                    if let Err(error) = webview.load_url(start.as_str()) {
                        log::error!("load {start}: {error}");
                    }
                    loop {
                        cx.background_executor().timer(CERTIFICATE_REFRESH).await;
                        trust_stack_certificates(&webview, cx).await;
                    }
                }
            }),
        ];
        // WebKitGTK follows GTK's font DPI as it changes (an XSETTINGS daemon publishes the
        // desktop's text scaling as it): the page zoom follows it too.
        if let Some(settings) = gtk::Settings::default() {
            let state = state.clone();
            settings.connect_gtk_xft_dpi_notify(move |_| state.rezoom());
        }
        // The window manager focuses the window itself when it is activated again; the page gets
        // back the keyboard it had.
        let activation = cx.observe_window_activation(window, {
            let state = state.clone();
            move |_, window, _| {
                if window.is_window_active() && state.keyboard.web_focused.get() {
                    state.keyboard.focus_web();
                }
            }
        });

        let webview = state.webview.clone();
        Ok((
            webview,
            Self {
                state,
                surface,
                overlay,
                _tasks: tasks,
                _activation: activation,
            },
        ))
    }

    pub fn reserve_action<A: Action + Default>(&self, cx: &App) {
        let action = A::default();
        let keymap = cx.key_bindings();
        let keymap = keymap.borrow();
        let mut reserved = self.state.reserved.borrow_mut();
        for binding in keymap.bindings_for_action(&action) {
            if let [keystroke] = binding.keystrokes() {
                reserved.push((keystroke.inner().clone(), action.boxed_clone()));
            }
        }
    }

    /// WebKitGTK's zoom applies on top of GTK's integer scale and GTK's font DPI; GPUI's scale may
    /// be fractional. Zooming by their ratio as well keeps one CSS pixel at `zoom` GPUI pixels, as
    /// on macOS.
    pub fn page_zoom(&self, zoom: f32, window: &Window) -> f64 {
        self.state.zoom.set(zoom);
        self.state.scale.set(window.scale_factor());
        self.state.page_zoom()
    }

    /// Paint `element` on the overlay surface, above the webview.
    pub fn cover(&self, element: impl IntoElement) -> AnyElement {
        OnSurface {
            surface: self.overlay,
            child: element.into_any_element(),
        }
        .into_any_element()
    }

    /// Give the keyboard back to GPUI's window if the page has it.
    pub fn release_keyboard(&self) {
        if self.state.keyboard.web_focused.replace(false) {
            self.state.keyboard.focus(self.state.keyboard.app_window);
        }
    }

    /// Where the webview shows: the surface follows this element's bounds as it is prepainted,
    /// and the webview fills the surface.
    pub fn element(&self) -> impl IntoElement {
        let state = self.state.clone();
        let surface = self.surface.clone();
        canvas(
            move |bounds, window, _| {
                let device = bounds.to_device_pixels(window.scale_factor());
                if let Ok(surface) = surface.platform_surface()
                    && let Err(error) = surface.set_bounds(device)
                {
                    log::warn!("place the webview: {error:#}");
                }
                if state.size.replace(device.size) != device.size {
                    state.host.set_size(device.size);
                }
                // Moved to a display with another scale.
                if state.scale.replace(window.scale_factor()) != window.scale_factor() {
                    state.rezoom();
                }
            },
            |_, _, _, _| {},
        )
        .size_full()
    }
}

impl State {
    fn page_zoom(&self) -> f64 {
        let gtk_scale = self.webview.webview().scale_factor().max(1) as f32;
        f64::from(self.zoom.get() * self.scale.get() / (gtk_scale * font_dpi_scale()))
    }

    /// Zoom the page again for the current scales and have it report the thread column anew.
    fn rezoom(&self) {
        if let Err(error) = self.webview.zoom(self.page_zoom()) {
            log::warn!("webview zoom: {error}");
        }
        if let Err(error) = self
            .webview
            .evaluate_script("window.__devflowReport && window.__devflowReport()")
        {
            log::warn!("webview report: {error}");
        }
    }

    /// The reserved action a key press in the page is bound to.
    fn reserved_action(&self, event: &gdk::EventKey) -> Option<Box<dyn Action>> {
        let key = event.keyval().to_unicode()?.to_lowercase().to_string();
        let state = event.state();
        let control = state.contains(gdk::ModifierType::CONTROL_MASK);
        let alt = state.contains(gdk::ModifierType::MOD1_MASK);
        let platform =
            state.intersects(gdk::ModifierType::SUPER_MASK | gdk::ModifierType::MOD4_MASK);
        let shift = state.contains(gdk::ModifierType::SHIFT_MASK);
        self.reserved
            .borrow()
            .iter()
            .find(|(keystroke, _)| {
                let modifiers = &keystroke.modifiers;
                keystroke.key == key
                    && modifiers.control == control
                    && modifiers.alt == alt
                    && modifiers.platform == platform
                    // Shifted symbols (`+`) arrive with Shift held; a binding without Shift
                    // still matches them.
                    && (!modifiers.shift || shift)
            })
            .map(|(_, action)| action.boxed_clone())
    }
}

/// Which X11 window has the keyboard: the page's or GPUI's.
struct Keyboard {
    xlib: xlib::Xlib,
    /// GTK's connection, which the page's window belongs to.
    display: gdkx11::X11Display,
    web_window: c_ulong,
    app_window: c_ulong,
    web_focused: Cell<bool>,
}

impl Keyboard {
    fn focus_web(&self) {
        self.web_focused.set(true);
        self.focus(self.web_window);
    }

    fn focus(&self, window: c_ulong) {
        // A window that is not viewable (unmapped, or its top level minimized) can't take the
        // keyboard; the X error is expected then, and GDK would abort on it untrapped.
        self.display.error_trap_push();
        // SAFETY: GTK's live display connection, used on the thread GTK runs on.
        unsafe {
            let display = xdisplay(&self.display);
            (self.xlib.XSetInputFocus)(display, window, xlib::RevertToParent, xlib::CurrentTime);
            (self.xlib.XFlush)(display);
        }
        self.display.error_trap_pop_ignored();
    }
}

/// The scale WebKitGTK gives pages on top of their zoom level: GTK's font DPI (`gtk-xft-dpi`, from
/// XSETTINGS or `Xft.dpi`, else the screen's physical DPI) over 96. GPUI scales by `Xft.dpi` too,
/// so a page zoomed by GPUI's scale alone came out at its square (4x on a 192 DPI screen), and by
/// the physical DPI where GPUI has no `Xft.dpi`.
fn font_dpi_scale() -> f32 {
    gtk::Settings::default()
        .map(|settings| settings.gtk_xft_dpi())
        .filter(|dpi| *dpi > 0)
        .map_or(1., |dpi| dpi as f32 / (1024. * 96.))
}

/// GTK's Xlib connection.
fn xdisplay(display: &gdkx11::X11Display) -> *mut xlib::Display {
    // SAFETY: only reads the connection pointer of a live GDK display.
    unsafe {
        gdkx11::ffi::gdk_x11_display_get_xdisplay(display.to_glib_none().0) as *mut xlib::Display
    }
}

/// The webview's windows: an X11 child window of the native surface's, wrapped in a GTK window,
/// as wry's `build_as_child` makes them, except that GTK draws with the X window's visual.
///
/// GPUI's window, and so the native surface and this child window, has an ARGB visual. GTK would
/// give WebKit's widget window the screen's default visual, and the X server's Composite extension
/// implicitly redirects a child window whose visual differs from its parent's when either is ARGB.
/// A redirected window is painted into its parent past the parent's SHAPE cutouts, so without a
/// compositing manager (where GPUI cuts its content out of the native surface instead of drawing
/// it in an overlay window) the page showed through the native view over it.
struct Host {
    xlib: xlib::Xlib,
    display: gdkx11::X11Display,
    x_window: c_ulong,
    gtk_window: gtk::Window,
}

impl Host {
    /// The host in `parent`, and the GTK container to build the webview in.
    fn new(display: &gdkx11::X11Display, parent: NonZeroU32) -> anyhow::Result<(Self, gtk::Box)> {
        let xlib = xlib::Xlib::open().context("load Xlib")?;
        // SAFETY: GTK's live display connection, used on the thread GTK runs on; the window
        // copies its parent's visual.
        let x_window = unsafe {
            let xdisplay = xdisplay(display);
            let window = (xlib.XCreateSimpleWindow)(
                xdisplay,
                c_ulong::from(parent.get()),
                0,
                0,
                1,
                1,
                0,
                0,
                0,
            );
            (xlib.XMapWindow)(xdisplay, window);
            window
        };
        let gdk_window =
            gdkx11::X11Window::foreign_new_for_display(display, x_window).upcast::<gdk::Window>();
        let gtk_window = gtk::Window::new(gtk::WindowType::Toplevel);
        // Before anything is realized: the webview's windows take their top level's visual.
        gtk_window.set_visual(Some(&gdk_window.visual()));
        gtk_window.connect_realize(move |window| window.set_window(gdk_window.clone()));
        gtk_window.set_has_window(true);
        gtk_window.realize();
        let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
        gtk_window.add(&container);
        Ok((
            Self {
                xlib,
                display: display.clone(),
                x_window,
                gtk_window,
            },
            container,
        ))
    }

    fn set_size(&self, size: Size<DevicePixels>) {
        // GTK sizes in its own integer scale's pixels.
        let scale = self.gtk_window.scale_factor().max(1);
        let width = (size.width.0.max(1) + scale - 1) / scale;
        let height = (size.height.0.max(1) + scale - 1) / scale;
        if let Some(window) = self.gtk_window.window() {
            window.resize(width, height);
        }
        self.gtk_window
            .size_allocate(&gtk::Allocation::new(0, 0, width, height));
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // SAFETY: as in `new`; the window is ours.
        unsafe { (self.xlib.XDestroyWindow)(xdisplay(&self.display), self.x_window) };
        self.gtk_window.close();
    }
}

/// Paints its child on a composition surface of its own.
struct OnSurface {
    surface: CompositionSurfaceId,
    child: AnyElement,
}

impl Element for OnSurface {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let child = &mut self.child;
        if window
            .with_composition_surface(self.surface, |window| {
                child.prepaint(window, cx);
            })
            .is_err()
        {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let child = &mut self.child;
        if window
            .with_composition_surface(self.surface, |window| child.paint(window, cx))
            .is_err()
        {
            child.paint(window, cx);
        }
    }
}

/// Whether `uri` is on one of the stack's origins.
fn is_stack_url(net: &Net, uri: &str) -> bool {
    let config = net.config();
    url::Url::parse(uri).is_ok_and(|url| {
        [&config.app, &config.api, &config.sync]
            .iter()
            .any(|origin| origin.origin() == url.origin())
    })
}

/// WebKitGTK trusts only the system's CAs, and nothing adds Caddy's local CA there on Linux.
/// The HTTP client trusts it (net/mod.rs), so the certificates it verifies for the stack's
/// origins are handed to the webview, each for its host.
async fn trust_stack_certificates(webview: &wry::WebView, cx: &mut AsyncApp) {
    let net = cx.update(|cx| Store::global(cx).read(cx).net());
    if net.config().ca_file.is_none() {
        return;
    }
    let origins = {
        let config = net.config();
        [config.app.clone(), config.api.clone(), config.sync.clone()]
    };
    let fetch = net.spawn({
        let net = net.clone();
        async move {
            let mut certificates = Vec::new();
            for origin in origins {
                match net.peer_certificate(&origin).await {
                    Ok(der) => certificates.push((origin, der)),
                    Err(error) => log::warn!("certificate of {origin}: {error:#}"),
                }
            }
            certificates
        }
    });
    let Ok(certificates) = fetch.await else {
        return;
    };
    let Some(context) = webview.webview().context() else {
        return;
    };
    for (origin, der) in certificates {
        let Some(host) = origin.host_str() else {
            continue;
        };
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            base64::engine::general_purpose::STANDARD.encode(der)
        );
        match gtk::gio::TlsCertificate::from_pem(&pem) {
            Ok(certificate) => context.allow_tls_certificate_for_host(&certificate, host),
            Err(error) => log::warn!("certificate of {origin}: {error}"),
        }
    }
}
