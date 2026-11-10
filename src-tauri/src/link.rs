//! Linking with Deep Stellar Browsing on Android, version 1: same network only.
//!
//! This side is only the transport: a TCP listener, mDNS so phones can find it, and length-prefixed
//! frames passed to and from the toolbar. Pairing, keys and encryption are done in the toolbar with the
//! web engine's built-in WebCrypto (see docs/LINK-PROTOCOL.md), so frames here are opaque.

use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const PREFERRED_PORT: u16 = 47321;
const MAX_FRAME: usize = 4 * 1024 * 1024;
const SERVICE: &str = "_dsstation._tcp.local.";

#[derive(Default)]
pub struct Link {
    conns: Mutex<HashMap<u64, TcpStream>>,
    next: AtomicU64,
    info: Mutex<Option<LinkInfo>>,
    mdns: Mutex<Option<ServiceDaemon>>,
}

#[derive(Clone, Serialize)]
pub struct LinkInfo {
    port: u16,
    addrs: Vec<String>,
    name: String,
    mdns: bool,
}

#[derive(Clone, Serialize)]
struct Frame {
    conn: u64,
    data: String,
}

#[derive(Clone, Serialize)]
struct Opened {
    conn: u64,
    addr: String,
}

/// The address other devices on the network see for this computer (no packet is sent).
fn primary_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?; // TEST-NET address: only used to pick the outgoing interface
    let ip = s.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() { None } else { Some(ip.to_string()) }
}

pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Desktop".into())
}

fn write_frame(s: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    s.write_all(&(data.len() as u32).to_be_bytes())?;
    s.write_all(data)?;
    s.flush()
}

fn read_frame(s: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; n];
    s.read_exact(&mut buf)?;
    Ok(buf)
}

/// Starts listening and advertising. `fp` is this computer's key fingerprint (from the toolbar).
#[tauri::command]
pub fn link_start(app: AppHandle, link: State<'_, Link>, fp: String, name: String) -> Result<LinkInfo, String> {
    if let Some(info) = link.info.lock().unwrap().clone() {
        return Ok(info);
    }
    if fp.len() < 8 || !fp.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad fingerprint".into());
    }
    let listener = TcpListener::bind(("0.0.0.0", PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| format!("Couldn't open a network port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // mDNS so the phone can find this computer even if its address changes.
    let instance = format!("Station-{}", &fp[..8]);
    let mut mdns_ok = false;
    if let Ok(daemon) = ServiceDaemon::new() {
        let mut props = HashMap::new();
        props.insert("fp".to_string(), fp.clone());
        let host = format!("{instance}.local.");
        if let Ok(svc) = ServiceInfo::new(SERVICE, &instance, &host, "", port, props) {
            mdns_ok = daemon.register(svc.enable_addr_auto()).is_ok();
        }
        *link.mdns.lock().unwrap() = Some(daemon);
    }

    let display = if name.trim().is_empty() { computer_name() } else { name };
    let info = LinkInfo {
        port,
        addrs: primary_ip().map(|ip| vec![format!("{ip}:{port}")]).unwrap_or_default(),
        name: display,
        mdns: mdns_ok,
    };
    *link.info.lock().unwrap() = Some(info.clone());

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(app, stream));
        }
    });
    Ok(info)
}

fn serve(app: AppHandle, mut stream: TcpStream) {
    let link = app.state::<Link>();
    let id = link.next.fetch_add(1, Ordering::SeqCst) + 1;
    let addr = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    let _ = stream.set_nodelay(true);
    // Idle connections are kept; a dead peer is noticed by TCP keepalive or the next send.
    match stream.try_clone() {
        Ok(w) => {
            link.conns.lock().unwrap().insert(id, w);
        }
        Err(_) => return,
    }
    let _ = app.emit("link://open", Opened { conn: id, addr });
    loop {
        match read_frame(&mut stream) {
            Ok(buf) => match String::from_utf8(buf) {
                Ok(data) => {
                    let _ = app.emit("link://frame", Frame { conn: id, data });
                }
                Err(_) => break,
            },
            Err(_) => break,
        }
    }
    link.conns.lock().unwrap().remove(&id);
    let _ = app.emit("link://closed", id);
}


#[tauri::command]
pub fn link_send(link: State<'_, Link>, conn: u64, data: String) -> Result<(), String> {
    let mut conns = link.conns.lock().unwrap();
    let s = conns.get_mut(&conn).ok_or("not connected")?;
    if let Err(e) = write_frame(s, data.as_bytes()) {
        conns.remove(&conn);
        return Err(e.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn link_close(link: State<'_, Link>, conn: u64) {
    if let Some(s) = link.conns.lock().unwrap().remove(&conn) {
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
}

#[tauri::command]
pub fn link_info(link: State<'_, Link>) -> Option<LinkInfo> {
    let mut info = link.info.lock().unwrap().clone()?;
    // The address can change (new Wi-Fi); refresh it each time it's asked for.
    if let Some(ip) = primary_ip() {
        info.addrs = vec![format!("{ip}:{}", info.port)];
    }
    Some(info)
}
