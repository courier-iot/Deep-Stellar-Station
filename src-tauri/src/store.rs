//! Small JSON files the toolbar keeps (settings, bookmarks, shortcuts, linked devices, the share inbox).
//! The toolbar web view is private (incognito) like the tabs, so it can't keep its own storage;
//! these files in the app's data folder are the only things Station saves.

use tauri::{AppHandle, Manager};

const NAMES: &[&str] = &["settings", "bookmarks", "shortcuts", "link", "inbox"];

fn path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if !NAMES.contains(&name) {
        return Err("unknown store".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
pub fn store_get(app: AppHandle, name: String) -> Result<String, String> {
    match std::fs::read_to_string(path(&app, &name)?) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn store_set(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let p = path(&app, &name)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    restrict(&tmp);
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Linked-device keys live in link.json: make it readable by this user only (Linux).
fn restrict(_p: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(0o600));
    }
}
