//! devflow desktop: a native client for a running devflow stack. Thread views render natively
//! with gpui-kit; every other route of the web UI shows in an embedded webview.

mod config;
mod model;
mod net;
mod store;
mod ui;

use gpui_kit::*;

use crate::config::StackConfig;
use crate::net::Net;
use crate::store::{GlobalStore, Store};
use crate::ui::app::AppView;

fn main() {
    #[cfg(target_os = "linux")]
    ui::web::linux::prepare_display();
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("devflow_desktop=info"),
    )
    .init();
    let config = match StackConfig::load() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("devflow desktop: {error:#}");
            std::process::exit(1);
        }
    };
    log::info!(
        "stack: api {} · sync {} · app {}",
        config.api,
        config.sync,
        config.app
    );
    #[cfg(target_os = "linux")]
    if let Err(error) = gtk::init() {
        eprintln!("devflow desktop: start GTK for the webview: {error}");
        std::process::exit(1);
    }
    let net = Net::new(config.clone()).expect("start the network runtime");
    // `devflow-desktop /sessions/<id>` opens that page first, like a deep link.
    let initial = std::env::args().nth(1).filter(|arg| arg.starts_with('/'));

    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            ui::app::init(cx);
            let store = cx.new(|cx| Store::new(net.clone(), cx));
            cx.set_global(GlobalStore(store));
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::centered(None, size(px(1280.), px(860.)), cx)),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| AppView::new(&config, initial.clone(), window, cx))
            })
            .expect("open the window");
            cx.activate(true);
        });
}
