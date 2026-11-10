//! The ad & tracker shield: a tiny HTTP proxy on 127.0.0.1 that every tab goes through.
//!
//! Desktop web views can't filter individual requests the way Android's can, but they can all
//! use a proxy. For HTTPS the proxy only sees which site is being contacted (the CONNECT line),
//! never the content, and refuses connections to blocked domains. Nothing is logged.

use serde::Serialize;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

pub struct Shield {
    enabled: AtomicBool,
    bundled: HashSet<String>,
    downloaded: RwLock<HashSet<String>>,
    blocked: AtomicU64,
}

impl Shield {
    pub fn new(bundled_list: &str) -> Self {
        Shield {
            enabled: AtomicBool::new(true),
            bundled: parse_list(bundled_list),
            downloaded: RwLock::new(HashSet::new()),
            blocked: AtomicU64::new(0),
        }
    }

    fn is_blocked(&self, host: &str) -> bool {
        if !self.enabled.load(Ordering::Relaxed) {
            return false;
        }
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let downloaded = self.downloaded.read().unwrap();
        let mut h: &str = &host;
        loop {
            if self.bundled.contains(h) || downloaded.contains(h) {
                return true;
            }
            match h.find('.') {
                Some(i) if h[i + 1..].contains('.') => h = &h[i + 1..],
                _ => return false,
            }
        }
    }
}

/// Hosts files, plain domain lists and "||domain^" filter lines.
pub fn parse_list(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for raw in text.lines() {
        let l = raw.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with('!') || l.starts_with('[') || l.starts_with("@@") {
            continue;
        }
        let host: &str = if let Some(rest) = l.strip_prefix("||") {
            let end = rest.find(|c| c == '^' || c == '/' || c == '$').unwrap_or(rest.len());
            if rest[end..].starts_with('$') || rest[end..].len() > 1 {
                continue; // has options or a path: not a whole-domain rule
            }
            &rest[..end]
        } else {
            let mut parts = l.split_whitespace();
            match (parts.next(), parts.next()) {
                (Some(ip), Some(h)) if ip == "0.0.0.0" || ip == "127.0.0.1" || ip == "::" => h,
                (Some(h), None) => h,
                _ => continue,
            }
        };
        let host = host.to_ascii_lowercase();
        if host.contains('.') && !host.contains('*') && host != "localhost" && host != "0.0.0.0" {
            out.insert(host);
        }
    }
    out
}

fn lists_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("blocklists.txt"))
}

pub fn load_saved_lists(app: &AppHandle) {
    let shield = app.state::<Arc<Shield>>();
    if let Some(f) = lists_file(app) {
        if let Ok(text) = std::fs::read_to_string(f) {
            *shield.downloaded.write().unwrap() = parse_list(&text);
        }
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn shield_set(shield: State<'_, Arc<Shield>>, enabled: bool) {
    shield.enabled.store(enabled, Ordering::Relaxed);
}

/// The toolbar downloads the public lists (they allow cross-origin reads) and hands them here.
#[tauri::command]
pub fn shield_lists(app: AppHandle, shield: State<'_, Arc<Shield>>, text: String) -> Result<usize, String> {
    let set = parse_list(&text);
    if set.len() < 100 {
        return Err("That doesn't look like a filter list".into());
    }
    let n = set.len();
    if let Some(f) = lists_file(&app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let joined: Vec<&str> = set.iter().map(|s| s.as_str()).collect();
        std::fs::write(f, joined.join("\n")).map_err(|e| e.to_string())?;
    }
    *shield.downloaded.write().unwrap() = set;
    Ok(n)
}

#[derive(Serialize)]
pub struct Stats {
    enabled: bool,
    blocked: u64,
    domains: usize,
}

#[tauri::command]
pub fn shield_stats(shield: State<'_, Arc<Shield>>) -> Stats {
    Stats {
        enabled: shield.enabled.load(Ordering::Relaxed),
        blocked: shield.blocked.load(Ordering::Relaxed),
        domains: shield.bundled.len() + shield.downloaded.read().unwrap().len(),
    }
}

// ---------------------------------------------------------------- the proxy

pub fn start(shield: Arc<Shield>) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let shield = shield.clone();
            std::thread::spawn(move || {
                let _ = handle(conn, &shield);
            });
        }
    });
    Ok(port)
}

const FORBIDDEN: &[u8] = b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 30\r\nConnection: close\r\n\r\nBlocked by Deep Stellar shield";

fn handle(mut client: TcpStream, shield: &Shield) -> std::io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    // Read the request head (up to 64 KB).
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = client.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 65536 {
            return Ok(());
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let rest = buf[head_end..].to_vec();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let (method, target, version) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("HTTP/1.1"));
    client.set_read_timeout(None)?;

    if method.eq_ignore_ascii_case("CONNECT") {
        // HTTPS: we only learn host:port.
        let (host, port) = split_host_port(target, 443);
        if shield.is_blocked(&host) {
            shield.blocked.fetch_add(1, Ordering::Relaxed);
            client.write_all(FORBIDDEN)?;
            return Ok(());
        }
        let mut upstream = connect(&host, port)?;
        client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
        if !rest.is_empty() {
            upstream.write_all(&rest)?;
        }
        return pump(client, upstream);
    }

    // Plain HTTP: "GET http://host/path HTTP/1.1"
    let Some(after) = target.strip_prefix("http://") else {
        client.write_all(FORBIDDEN)?;
        return Ok(());
    };
    let (authority, path) = match after.find('/') {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, "/"),
    };
    let (host, port) = split_host_port(authority, 80);
    if shield.is_blocked(&host) {
        shield.blocked.fetch_add(1, Ordering::Relaxed);
        client.write_all(FORBIDDEN)?;
        return Ok(());
    }
    let mut upstream = connect(&host, port)?;
    // Origin-form request line; one request per connection keeps routing simple.
    let mut out = format!("{method} {path} {version}\r\n");
    for l in lines {
        if l.is_empty() {
            continue;
        }
        let lower = l.to_ascii_lowercase();
        if lower.starts_with("proxy-connection:") || lower.starts_with("connection:") || lower.starts_with("keep-alive:") {
            continue;
        }
        out.push_str(l);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    upstream.write_all(out.as_bytes())?;
    if !rest.is_empty() {
        upstream.write_all(&rest)?;
    }
    pump(client, upstream)
}

fn split_host_port(s: &str, default: u16) -> (String, u16) {
    if let Some(stripped) = s.strip_prefix('[') {
        // IPv6 literal: [::1]:443
        if let Some(end) = stripped.find(']') {
            let host = &stripped[..end];
            let port = stripped[end + 1..].strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(default);
            return (host.to_string(), port);
        }
    }
    match s.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h.to_string(), p.parse().unwrap_or(default)),
        _ => (s.to_string(), default),
    }
}

fn connect(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "no address");
    for addr in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(15)) {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn pump(client: TcpStream, upstream: TcpStream) -> std::io::Result<()> {
    let mut c_read = client.try_clone()?;
    let mut u_write = upstream.try_clone()?;
    let t = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c_read, &mut u_write);
        let _ = u_write.shutdown(Shutdown::Write);
    });
    let mut u_read = upstream;
    let mut c_write = client;
    let _ = std::io::copy(&mut u_read, &mut c_write);
    let _ = c_write.shutdown(Shutdown::Write);
    let _ = t.join();
    Ok(())
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}
