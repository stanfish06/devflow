//! macOS: the WKWebView in a gpui-fast native view. GPUI content painted after it covers it and
//! takes the clicks there, and the page has the keyboard only while the view's focus handle is
//! focused, so keys it leaves still reach GPUI's bindings.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::rc::Rc;

use anyhow::Context as _;
use gpui_kit::*;

use super::WebPane;

pub struct Embedding {
    view: NativeView,
}

impl Embedding {
    /// Build the webview as a child of the window, then move its WKWebView into a GPUI native view.
    pub fn new(
        builder: wry::WebViewBuilder,
        start: url::Url,
        window: &mut Window,
        cx: &mut Context<WebPane>,
    ) -> anyhow::Result<(Rc<wry::WebView>, Self)> {
        use wry::WebViewExtMacOS as _;
        let webview = builder
            .with_url(start.as_str())
            .build_as_child(&*window)
            .context("build the webview")?;
        let ns_view = webview.webview();
        // NativeView::new takes a view outside any hierarchy and keeps it for the handle's life.
        ns_view.removeFromSuperview();
        let pointer = NonNull::new(objc2::rc::Retained::as_ptr(&ns_view) as *mut c_void)
            .context("webview has no NSView")?;
        // SAFETY: a live NSView just removed from its superview, on the UI thread; wry and the
        // NativeView both retain it, and nothing else moves or resizes it.
        let view = unsafe { NativeView::new(pointer, window, cx) }?;
        Ok((Rc::new(webview), Self { view }))
    }

    pub fn reserve_action<A: Action + Default>(&self, _: &App) {
        self.view.reserve_action::<A>();
    }

    /// WKWebView `pageZoom` scales CSS pixels to window points as GPUI does.
    pub fn page_zoom(&self, zoom: f32, _: &Window) -> f64 {
        f64::from(zoom)
    }

    /// Painted after the native view, an element covers it.
    pub fn cover(&self, element: impl IntoElement) -> AnyElement {
        element.into_any_element()
    }

    pub fn element(&self) -> impl IntoElement {
        self.view.clone()
    }
}
