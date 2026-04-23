use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use uuid::Uuid;
use walkdir::WalkDir;

const APP_DIR_NAME: &str = "dev-design";
const MAX_TEXT_FILE_BYTES: u64 = 2_000_000;

#[derive(Default)]
struct AppState {
    snapshots: Mutex<HashMap<String, ProjectSnapshot>>,
    preview_processes: Mutex<HashMap<String, Child>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub id: String,
    pub original_path: String,
    pub snapshot_path: String,
    pub package_manager: String,
    pub framework_guess: String,
    pub dev_command: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub path: String,
    pub kind: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResponse {
    pub snapshot: ProjectSnapshot,
    pub source_files: Vec<SourceFile>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResponse {
    pub url: String,
    pub command: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub changed_files: Vec<ChangedFile>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySyncResponse {
    pub applied_files: Vec<String>,
    pub backup_root: String,
}

#[tauri::command]
fn pick_project_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Open React project")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn open_project(original_path: String, state: tauri::State<AppState>) -> Result<OpenProjectResponse, String> {
    let original = PathBuf::from(&original_path);
    if !original.is_dir() {
        return Err("Selected path is not a directory.".to_string());
    }

    let package_json = original.join("package.json");
    if !package_json.exists() {
        return Err("No package.json found. The MVP expects a React project root.".to_string());
    }

    let id = Uuid::new_v4().to_string();
    let snapshot_root = app_data_root()?.join("snapshots").join(&id);
    fs::create_dir_all(&snapshot_root).map_err(to_string)?;
    copy_project_snapshot(&original, &snapshot_root).map_err(to_string)?;

    let package_manager = detect_package_manager(&original);
    let package_text = fs::read_to_string(snapshot_root.join("package.json")).unwrap_or_default();
    let (framework_guess, dev_script) = detect_framework_and_script(&package_text);
    let dev_command = format!("{} run {}", package_manager, dev_script);

    let snapshot = ProjectSnapshot {
        id: id.clone(),
        original_path: original.to_string_lossy().to_string(),
        snapshot_path: snapshot_root.to_string_lossy().to_string(),
        package_manager,
        framework_guess,
        dev_command,
        created_at: Utc::now(),
    };

    state
        .snapshots
        .lock()
        .map_err(|_| "Snapshot state lock failed.".to_string())?
        .insert(id, snapshot.clone());

    let source_files = list_source_files(&snapshot_root)?;
    let mut warnings = Vec::new();
    if !source_files.iter().any(|file| file.path.ends_with(".tsx") || file.path.ends_with(".jsx")) {
        warnings.push("No TSX/JSX files were detected in the snapshot.".to_string());
    }

    Ok(OpenProjectResponse {
        snapshot,
        source_files,
        warnings,
    })
}

#[tauri::command]
fn list_snapshot_files(snapshot_id: String, state: tauri::State<AppState>) -> Result<Vec<SourceFile>, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    list_source_files(Path::new(&snapshot.snapshot_path))
}

#[tauri::command]
fn read_snapshot_file(
    snapshot_id: String,
    path: String,
    state: tauri::State<AppState>,
) -> Result<SourceFile, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let root = PathBuf::from(snapshot.snapshot_path);
    let full_path = safe_join(&root, &path)?;
    let metadata = fs::metadata(&full_path).map_err(to_string)?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is too large for the embedded editor.".to_string());
    }
    let content = fs::read_to_string(&full_path).map_err(to_string)?;
    Ok(SourceFile {
        path,
        kind: file_kind(&full_path),
        content,
    })
}

#[tauri::command]
fn write_snapshot_file(
    snapshot_id: String,
    path: String,
    content: String,
    state: tauri::State<AppState>,
) -> Result<SourceFile, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let root = PathBuf::from(snapshot.snapshot_path);
    let full_path = safe_join(&root, &path)?;
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    fs::write(&full_path, content.as_bytes()).map_err(to_string)?;
    Ok(SourceFile {
        path,
        kind: file_kind(&full_path),
        content,
    })
}

#[tauri::command]
fn install_dependencies(snapshot_id: String, state: tauri::State<AppState>) -> Result<String, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let root = PathBuf::from(snapshot.snapshot_path);
    let mut command = Command::new(&snapshot.package_manager);
    command.arg("install").current_dir(root);
    let output = command.output().map_err(|error| {
        format!(
            "Failed to run {} install. Ensure the package manager is installed and on PATH. {}",
            snapshot.package_manager, error
        )
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn start_preview(snapshot_id: String, state: tauri::State<AppState>) -> Result<PreviewResponse, String> {
    stop_preview(snapshot_id.clone(), state.clone()).ok();
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let root = PathBuf::from(&snapshot.snapshot_path);
    let package_text = fs::read_to_string(root.join("package.json")).unwrap_or_default();
    let (_, script) = detect_framework_and_script(&package_text);
    let port = free_port()?;

    let mut command = Command::new(&snapshot.package_manager);
    configure_package_script_command(&mut command, &snapshot.package_manager, &script);
    configure_preview_args(&mut command, &snapshot.framework_guess, port);
    command
        .current_dir(&root)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = command.spawn().map_err(|error| {
        format!(
            "Failed to start preview with '{}'. Install dependencies first and ensure the package manager is on PATH. {}",
            snapshot.dev_command, error
        )
    })?;

    state
        .preview_processes
        .lock()
        .map_err(|_| "Preview process lock failed.".to_string())?
        .insert(snapshot_id, child);

    Ok(PreviewResponse {
        url: format!("http://127.0.0.1:{}", port),
        command: snapshot.dev_command,
        port,
    })
}

#[tauri::command]
fn stop_preview(snapshot_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut processes = state
        .preview_processes
        .lock()
        .map_err(|_| "Preview process lock failed.".to_string())?;
    if let Some(mut child) = processes.remove(&snapshot_id) {
        child.kill().ok();
        child.wait().ok();
    }
    Ok(())
}

#[tauri::command]
fn create_sync_plan(snapshot_id: String, state: tauri::State<AppState>) -> Result<SyncPlan, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let original_root = PathBuf::from(snapshot.original_path);
    let snapshot_root = PathBuf::from(snapshot.snapshot_path);
    let mut changed_files = Vec::new();
    let mut warnings = vec![
        "Review the diff carefully before applying changes to the original project.".to_string(),
        "Instrumentation attributes used for preview selection are stripped before diff and sync.".to_string(),
    ];

    for entry in WalkDir::new(&snapshot_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() || should_ignore_path(entry.path()) {
            continue;
        }
        if !is_text_like(entry.path()) {
            continue;
        }
        let rel = relative_path(&snapshot_root, entry.path())?;
        let snapshot_content = fs::read_to_string(entry.path()).map_err(to_string)?;
        let snapshot_clean = sanitize_preview_instrumentation(&snapshot_content);
        let original_path = original_root.join(&rel);
        let original_content = fs::read_to_string(&original_path).unwrap_or_default();
        if snapshot_clean != original_content {
            let status = if original_path.exists() { "modified" } else { "added" };
            let diff = unified_diff(&rel, &original_content, &snapshot_clean);
            changed_files.push(ChangedFile {
                path: rel,
                status: status.to_string(),
                diff,
            });
        }
    }

    if changed_files.is_empty() {
        warnings.push("No source changes were detected.".to_string());
    }

    Ok(SyncPlan {
        changed_files,
        warnings,
    })
}

#[tauri::command]
fn apply_sync(
    snapshot_id: String,
    files: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<ApplySyncResponse, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let original_root = PathBuf::from(snapshot.original_path);
    let snapshot_root = PathBuf::from(snapshot.snapshot_path);
    let backup_root = app_data_root()?
        .join("backups")
        .join(format!("{}-{}", snapshot_id, Utc::now().format("%Y%m%d%H%M%S")));
    fs::create_dir_all(&backup_root).map_err(to_string)?;

    let mut applied_files = Vec::new();
    for rel in files {
        let snapshot_path = safe_join(&snapshot_root, &rel)?;
        let original_path = safe_join(&original_root, &rel)?;
        if !snapshot_path.exists() {
            return Err(format!("Snapshot file does not exist: {}", rel));
        }
        let snapshot_content = fs::read_to_string(&snapshot_path).map_err(to_string)?;
        let clean_content = sanitize_preview_instrumentation(&snapshot_content);

        if original_path.exists() {
            let backup_path = safe_join(&backup_root, &rel)?;
            if let Some(parent) = backup_path.parent() {
                fs::create_dir_all(parent).map_err(to_string)?;
            }
            fs::copy(&original_path, backup_path).map_err(to_string)?;
        }
        if let Some(parent) = original_path.parent() {
            fs::create_dir_all(parent).map_err(to_string)?;
        }
        fs::write(&original_path, clean_content.as_bytes()).map_err(to_string)?;
        applied_files.push(rel);
    }

    Ok(ApplySyncResponse {
        applied_files,
        backup_root: backup_root.to_string_lossy().to_string(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            pick_project_directory,
            open_project,
            list_snapshot_files,
            read_snapshot_file,
            write_snapshot_file,
            install_dependencies,
            start_preview,
            stop_preview,
            create_sync_plan,
            apply_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dev Design");
}

fn get_snapshot(state: &tauri::State<AppState>, id: &str) -> Result<ProjectSnapshot, String> {
    state
        .snapshots
        .lock()
        .map_err(|_| "Snapshot state lock failed.".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "Snapshot was not found. Reopen the project.".to_string())
}

fn app_data_root() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let root = base.join(APP_DIR_NAME);
    fs::create_dir_all(&root).map_err(to_string)?;
    Ok(root)
}

fn copy_project_snapshot(original: &Path, snapshot: &Path) -> io::Result<()> {
    for entry in WalkDir::new(original).into_iter().filter_map(Result::ok) {
        let source = entry.path();
        if source == original || should_ignore_path(source) {
            continue;
        }
        let rel = source.strip_prefix(original).unwrap();
        let target = snapshot.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, target)?;
        }
    }
    Ok(())
}

fn should_ignore_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        matches!(
            name.as_ref(),
            ".git"
                | "node_modules"
                | "dist"
                | "build"
                | ".next"
                | ".turbo"
                | "coverage"
                | ".cache"
                | "target"
        )
    })
}

fn detect_package_manager(root: &Path) -> String {
    if root.join("pnpm-lock.yaml").exists() {
        "pnpm".to_string()
    } else if root.join("yarn.lock").exists() {
        "yarn".to_string()
    } else {
        "npm".to_string()
    }
}

fn detect_framework_and_script(package_text: &str) -> (String, String) {
    let value: serde_json::Value = serde_json::from_str(package_text).unwrap_or_default();
    let deps = ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|key| value.get(key))
        .fold(String::new(), |mut acc, item| {
            acc.push_str(&item.to_string());
            acc
        });

    let framework = if deps.contains("\"next\"") {
        "Next.js".to_string()
    } else if deps.contains("\"vite\"") {
        "Vite".to_string()
    } else if deps.contains("\"react\"") {
        "React".to_string()
    } else {
        "Unknown".to_string()
    };

    let scripts = value.get("scripts").and_then(|scripts| scripts.as_object());
    let script = if scripts.and_then(|s| s.get("dev")).is_some() {
        "dev"
    } else if scripts.and_then(|s| s.get("start")).is_some() {
        "start"
    } else {
        "dev"
    };

    (framework, script.to_string())
}

fn configure_package_script_command(command: &mut Command, package_manager: &str, script: &str) {
    match package_manager {
        "yarn" => {
            command.arg("run").arg(script);
        }
        _ => {
            command.arg("run").arg(script);
        }
    };
}

fn configure_preview_args(command: &mut Command, framework: &str, port: u16) {
    command.arg("--");
    if framework == "Next.js" {
        command.arg("-H").arg("127.0.0.1").arg("-p").arg(port.to_string());
    } else {
        command
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string());
    }
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(to_string)?;
    Ok(listener.local_addr().map_err(to_string)?.port())
}

fn list_source_files(root: &Path) -> Result<Vec<SourceFile>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() || should_ignore_path(entry.path()) {
            continue;
        }
        if !is_text_like(entry.path()) {
            continue;
        }
        let metadata = fs::metadata(entry.path()).map_err(to_string)?;
        if metadata.len() > MAX_TEXT_FILE_BYTES {
            continue;
        }
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        files.push(SourceFile {
            path: relative_path(root, entry.path())?,
            kind: file_kind(entry.path()),
            content,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn is_text_like(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    matches!(
        ext,
        "ts" | "tsx"
            | "js"
            | "jsx"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "json"
            | "md"
            | "svg"
    )
}

fn file_kind(path: &Path) -> String {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
    if matches!(ext, "tsx" | "jsx") {
        "react".to_string()
    } else if file_name.ends_with(".module.css") || matches!(ext, "css" | "scss" | "sass" | "less") {
        "style".to_string()
    } else {
        "code".to_string()
    }
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Unsafe relative path.".to_string());
    }
    Ok(root.join(rel_path))
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(root).map_err(to_string)?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

fn sanitize_preview_instrumentation(content: &str) -> String {
    let data_id = Regex::new(r#"\s+data-dev-design-id=(?:"[^"]*"|'[^']*'|\{["'][^"']*["']\})"#).unwrap();
    let click_capture = Regex::new(
        r#"(?s)\s+onClickCapture=\{\(event\) =>\s*window\.parent\.postMessage\(\{\s*type: "dev-design-select",\s*id: "[^"]+"\s*\}, "\*"\)\}"#,
    )
    .unwrap();
    let without_click = click_capture.replace_all(content, "");
    data_id.replace_all(&without_click, "").to_string()
}

fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let diff = TextDiff::from_lines(old, new);
    let mut output = format!("--- a/{}\n+++ b/{}\n", path, path);
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Delete => "-",
            ChangeTag::Insert => "+",
            ChangeTag::Equal => " ",
        };
        output.push_str(sign);
        output.push_str(change.value());
        if !change.value().ends_with('\n') {
            output.push('\n');
        }
    }
    output
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
