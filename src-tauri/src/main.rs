// Deep Stellar Station: the window, its tabs, and the commands the toolbar uses.
//
// Layout: one window. A full-size "ui" web view draws the toolbar, tab strip, share panel and
// dialogs (ui/index.html). Each browser tab is its own private (incognito) web view placed over
// the content area. Tab pages get no access to the app; only the "ui" view can call commands.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod link;
mod proxy;
mod store;

use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{DownloadEvent, PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WindowEvent};

/// Script run in every tab before the page's own scripts.
const TAB_SCRIPT: &str = include_str!("tab-init.js");

#[derive(Default)]
struct Layout {
    top: f64,
    right: f64,
    hidden: bool,
}

struct Browser {
    tabs: Mutex<Vec<String>>,
    active: Mutex<Option<String>>,
    layout: Mutex<Layout>,
    next: AtomicU32,
    proxy_url: Url,
    https_only: std::sync::atomic::AtomicBool,
}

#[derive(Clone, Serialize)]
struct TabState {
    label: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
struct TabLink {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadState {
    url: String,
    path: String,
    done: bool,
    success: bool,
}

fn browser(app: &AppHandle) -> tauri::State<'_, Browser> {
    app.state::<Browser>()
}

/// Puts the active tab over the content area and parks the others off-screen.
fn relayout(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    let b = browser(app);
    let layout = b.layout.lock().unwrap();
    let active = b.active.lock().unwrap().clone();
    let w = (size.width - layout.right).max(1.0);
    let h = (size.height - layout.top).max(1.0);
    for label in b.tabs.lock().unwrap().iter() {
        if let Some(view) = app.get_webview(label) {
            if Some(label) == active.as_ref() && !layout.hidden {
                let _ = view.set_position(LogicalPosition::new(0.0, layout.top));
                let _ = view.set_size(LogicalSize::new(w, h));
            } else {
                let _ = view.set_size(LogicalSize::new(1.0, 1.0));
                let _ = view.set_position(LogicalPosition::new(-(size.width + 200.0), layout.top));
            }
        }
    }
}

fn parse_url(s: &str) -> Result<Url, String> {
    Url::parse(s).map_err(|e| format!("Bad address: {e}"))
}

// ---------------------------------------------------------------- tabs

#[tauri::command]
async fn tab_new(app: AppHandle, url: String) -> Result<String, String> {
    let window = app.get_window("main").ok_or("no window")?;
    let b = browser(&app);
    let label = format!("tab-{}", b.next.fetch_add(1, Ordering::SeqCst));
    let target = if url.is_empty() { WebviewUrl::App("start.html".into()) } else if url.starts_with("start.html") {
        WebviewUrl::App(url.clone().into())
    } else {
        WebviewUrl::External(parse_url(&url)?)
    };

    let nav_app = app.clone();
    let nav_label = label.clone();
    let load_app = app.clone();
    let dl_app = app.clone();
    let builder = WebviewBuilder::new(&label, target)
        .incognito(true) // no history, cookies or cache kept after the tab closes
        .proxy_url(b.proxy_url.clone()) // the ad & tracker shield
        .initialization_script(TAB_SCRIPT)
        .on_navigation(move |u| on_navigation(&nav_app, &nav_label, u))
        .on_page_load(move |view, payload| {
            let state = TabState {
                label: view.label().to_string(),
                url: payload.url().to_string(),
                loading: matches!(payload.event(), PageLoadEvent::Started),
            };
            let _ = load_app.emit("tab://state", state);
        })
        .on_download(move |_view, event| on_download(&dl_app, event));

    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = size.to_logical::<f64>(scale);
    let top = b.layout.lock().unwrap().top;
    window
        .add_child(builder, LogicalPosition::new(0.0, top), LogicalSize::new(size.width, (size.height - top).max(1.0)))
        .map_err(|e| e.to_string())?;

    b.tabs.lock().unwrap().push(label.clone());
    *b.active.lock().unwrap() = Some(label.clone());
    relayout(&app);
    Ok(label)
}

fn on_navigation(app: &AppHandle, label: &str, url: &Url) -> bool {
    // The app's own pages (the start page): tauri://localhost on Linux, http://tauri.localhost on Windows.
    if url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri" {
        return true;
    }
    match url.scheme() {
        "http" => {
            let b = browser(app);
            if b.https_only.load(Ordering::Relaxed) && url.host_str().map_or(false, |h| h != "localhost" && h != "127.0.0.1") {
                let mut up = url.clone();
                if up.set_scheme("https").is_ok() {
                    let app = app.clone();
                    let label = label.to_string();
                    std::thread::spawn(move || {
                        if let Some(v) = app.get_webview(&label) {
                            let _ = v.navigate(up);
                        }
                    });
                    return false;
                }
            }
            true
        }
        "https" | "about" | "data" | "blob" => true,
        "dsb" | "magnet" | "mailto" | "tel" => {
            let _ = app.emit("tab://special", TabLink { label: label.to_string(), url: url.to_string() });
            false
        }
        _ => false,
    }
}

fn on_download(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let dir = app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir());
            let name = destination
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .or_else(|| url.path_segments().and_then(|s| s.last().map(|x| x.to_string())).filter(|n| !n.is_empty()))
                .unwrap_or_else(|| "download".into());
            *destination = unique_path(&dir.join("DeepStellar"), &name);
            let _ = std::fs::create_dir_all(dir.join("DeepStellar"));
            let _ = app.emit(
                "dl://state",
                DownloadState { url: url.to_string(), path: destination.to_string_lossy().into(), done: false, success: false },
            );
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let _ = app.emit(
                "dl://state",
                DownloadState {
                    url: url.to_string(),
                    path: path.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                    done: true,
                    success,
                },
            );
            true
        }
        _ => true,
    }
}

fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let clean: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let mut p = dir.join(&clean);
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (clean.clone(), String::new()),
    };
    let mut n = 1;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    p
}

#[tauri::command]
async fn tab_close(app: AppHandle, label: String) -> Result<(), String> {
    let b = browser(&app);
    b.tabs.lock().unwrap().retain(|l| l != &label);
    {
        let mut active = b.active.lock().unwrap();
        if active.as_deref() == Some(&label) {
            *active = b.tabs.lock().unwrap().last().cloned();
        }
    }
    if let Some(v) = app.get_webview(&label) {
        v.close().map_err(|e| e.to_string())?;
    }
    relayout(&app);
    Ok(())
}

#[tauri::command]
async fn tab_activate(app: AppHandle, label: String) -> Result<(), String> {
    let b = browser(&app);
    if b.tabs.lock().unwrap().contains(&label) {
        *b.active.lock().unwrap() = Some(label.clone());
    }
    relayout(&app);
    if let Some(v) = app.get_webview(&label) {
        let _ = v.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn tab_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let v = app.get_webview(&label).ok_or("no such tab")?;
    v.navigate(parse_url(&url)?).map_err(|e| e.to_string())
}

/// back / forward / reload / stop / zoom-in / zoom-out / zoom-reset
#[tauri::command]
async fn tab_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let v = app.get_webview(&label).ok_or("no such tab")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        "zoom-in" => "document.documentElement.style.zoom=(parseFloat(document.documentElement.style.zoom||1)+0.1).toFixed(2)",
        "zoom-out" => "document.documentElement.style.zoom=Math.max(0.3,parseFloat(document.documentElement.style.zoom||1)-0.1).toFixed(2)",
        "zoom-reset" => "document.documentElement.style.zoom=1",
        "print" => "window.print()",
        _ => return Err("unknown action".into()),
    };
    v.eval(js).map_err(|e| e.to_string())
}

/// Space the toolbar takes at the top, the share panel at the right, and whether a dialog covers the page.
#[tauri::command]
async fn set_layout(app: AppHandle, top: f64, right: f64, hidden: bool) -> Result<(), String> {
    {
        let b = browser(&app);
        let mut l = b.layout.lock().unwrap();
        l.top = top;
        l.right = right;
        l.hidden = hidden;
    }
    relayout(&app);
    Ok(())
}

#[tauri::command]
fn set_https_only(app: AppHandle, on: bool) {
    browser(&app).https_only.store(on, Ordering::Relaxed);
}

// ---------------------------------------------------------------- misc

#[tauri::command]
fn open_downloads(app: AppHandle) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join("DeepStellar");
    let _ = std::fs::create_dir_all(&dir);
    open_path(&dir)
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    open_path(std::path::Path::new(&path))
}

fn open_path(p: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(p).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(p).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Saves text (e.g. exported bookmarks) to Downloads/DeepStellar and returns the path.
#[tauri::command]
fn save_text(app: AppHandle, name: String, content: String) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join("DeepStellar");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = unique_path(&dir, &name);
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn computer_name() -> String {
    link::computer_name()
}

#[tauri::command]
fn qr_svg(text: String) -> Result<String, String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(280, 280)
        .quiet_zone(true)
        .dark_color(svg::Color("#05060F"))
        .light_color(svg::Color("#FFFFFF"))
        .build())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn main() {
    let shield = Arc::new(proxy::Shield::new(include_str!("../../ui/blocklist.txt")));
    let port = proxy::start(shield.clone()).expect("couldn't start the shield proxy");
    let proxy_url = Url::parse(&format!("http://127.0.0.1:{port}")).expect("proxy url");

    tauri::Builder::default()
        .manage(Browser {
            tabs: Mutex::new(Vec::new()),
            active: Mutex::new(None),
            layout: Mutex::new(Layout { top: 96.0, right: 0.0, hidden: false }),
            next: AtomicU32::new(1),
            proxy_url: proxy_url.clone(),
            https_only: std::sync::atomic::AtomicBool::new(true),
        })
        .manage(shield)
        .manage(link::Link::default())
        .invoke_handler(tauri::generate_handler![
            tab_new,
            tab_close,
            tab_activate,
            tab_navigate,
            tab_action,
            set_layout,
            set_https_only,
            open_downloads,
            open_file,
            qr_svg,
            save_text,
            computer_name,
            app_version,
            proxy::shield_set,
            proxy::shield_lists,
            proxy::shield_stats,
            store::store_get,
            store::store_set,
            link::link_start,
            link::link_send,
            link::link_close,
            link::link_info,
        ])
        .setup(move |app| {
            proxy::load_saved_lists(app.handle());
            let window = WindowBuilder::new(app, "main")
                .title("Deep Stellar Station")
                .inner_size(1280.0, 820.0)
                .min_inner_size(640.0, 420.0)
                .build()?;
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            // The toolbar view. Same privacy settings as the tabs (Windows needs all views in one
            // window to share browser settings), so its own saved data lives in Rust-side files.
            let ui = WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                .incognito(true)
                .proxy_url(proxy_url.clone())
                .auto_resize();
            window.add_child(ui, LogicalPosition::new(0.0, 0.0), size)?;

            let handle = app.handle().clone();
            window.on_window_event(move |e| {
                if let WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } = e {
                    relayout(&handle);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Deep Stellar Station");
}
