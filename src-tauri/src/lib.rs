use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;
use walkdir::WalkDir;

const APP_DIR_NAME: &str = "dev-design";
const MAX_TEXT_FILE_BYTES: u64 = 2_000_000;
const SNAPSHOT_META_DIR: &str = ".dev-design";
const BASELINE_MANIFEST_FILE: &str = "baseline-manifest.json";

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
    pub app_root_path: String,
    pub app_root_relative_path: String,
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
    pub original_changed_since_open: bool,
    pub snapshot_changed_since_open: bool,
    pub can_apply: bool,
    pub warning: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaselineManifest {
    pub files: HashMap<String, BaselineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineEntry {
    pub path: String,
    pub original_hash: Option<String>,
    pub snapshot_hash: Option<String>,
    pub original_exists: bool,
    pub snapshot_exists: bool,
}

#[tauri::command]
fn pick_project_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Open React project")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn open_project(
    original_path: String,
    state: tauri::State<AppState>,
) -> Result<OpenProjectResponse, String> {
    let original = PathBuf::from(&original_path);
    if !original.is_dir() {
        return Err("Selected path is not a directory.".to_string());
    }

    let app_root_relative = find_react_app_root(&original)
        .ok_or_else(|| "No React package.json was found. Select a React/Vite/Next project or monorepo containing one.".to_string())?;

    let id = Uuid::new_v4().to_string();
    let snapshot_root = app_data_root()?.join("snapshots").join(&id);
    fs::create_dir_all(&snapshot_root).map_err(to_string)?;
    copy_project_snapshot(&original, &snapshot_root).map_err(to_string)?;
    create_baseline_manifest(&original, &snapshot_root)?;

    let original_app_root = original.join(&app_root_relative);
    let snapshot_app_root = snapshot_root.join(&app_root_relative);
    let package_manager = detect_package_manager(&original_app_root);
    let package_text =
        fs::read_to_string(snapshot_app_root.join("package.json")).unwrap_or_default();
    let (framework_guess, dev_script) = detect_framework_and_script(&package_text);
    let dev_command = format!("{} run {}", package_manager, dev_script);

    let snapshot = ProjectSnapshot {
        id: id.clone(),
        original_path: original.to_string_lossy().to_string(),
        snapshot_path: snapshot_root.to_string_lossy().to_string(),
        app_root_path: snapshot_app_root.to_string_lossy().to_string(),
        app_root_relative_path: app_root_relative.to_string_lossy().replace('\\', "/"),
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

    let source_files = list_source_files(&snapshot_root, &snapshot_app_root)?;
    let mut warnings = Vec::new();
    if !source_files
        .iter()
        .any(|file| file.path.ends_with(".tsx") || file.path.ends_with(".jsx"))
    {
        warnings.push("No TSX/JSX files were detected in the snapshot.".to_string());
    }

    Ok(OpenProjectResponse {
        snapshot,
        source_files,
        warnings,
    })
}

#[tauri::command]
fn list_snapshot_files(
    snapshot_id: String,
    state: tauri::State<AppState>,
) -> Result<Vec<SourceFile>, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    list_source_files(
        Path::new(&snapshot.snapshot_path),
        Path::new(&snapshot.app_root_path),
    )
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
fn install_dependencies(
    snapshot_id: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let root = PathBuf::from(snapshot.app_root_path);
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
fn start_preview(
    snapshot_id: String,
    state: tauri::State<AppState>,
) -> Result<PreviewResponse, String> {
    stop_preview(snapshot_id.clone(), state.clone()).ok();
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let root = PathBuf::from(&snapshot.app_root_path);
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to start preview with '{}'. Install dependencies first and ensure the package manager is on PATH. {}",
            snapshot.dev_command, error
        )
    })?;
    let (url_sender, url_receiver) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        collect_preview_output(stdout, url_sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        collect_preview_output(stderr, url_sender);
    }
    let fallback_url = format!("http://127.0.0.1:{}", port);
    let detected_url = wait_for_preview_url(&url_receiver, &fallback_url);

    state
        .preview_processes
        .lock()
        .map_err(|_| "Preview process lock failed.".to_string())?
        .insert(snapshot_id, child);

    Ok(PreviewResponse {
        url: detected_url,
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
fn create_sync_plan(
    snapshot_id: String,
    state: tauri::State<AppState>,
) -> Result<SyncPlan, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let original_root = PathBuf::from(snapshot.original_path);
    let snapshot_root = PathBuf::from(snapshot.snapshot_path);
    let mut warnings = vec![
        "Review the diff carefully before applying changes to the original project.".to_string(),
        "Instrumentation attributes used for preview selection are stripped before diff and sync."
            .to_string(),
    ];
    let changed_files = build_sync_plan_files(&original_root, &snapshot_root)?;

    if changed_files.is_empty() {
        warnings.push("No source changes were detected.".to_string());
    } else if changed_files.iter().any(|file| file.status == "conflict") {
        warnings.push("Some files changed in both the original project and the snapshot. Resolve or refresh before applying.".to_string());
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
    let sync_plan = build_sync_plan_files(&original_root, &snapshot_root)?;
    let plan_by_path: HashMap<String, ChangedFile> = sync_plan
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    for rel in &files {
        let planned = plan_by_path.get(rel).ok_or_else(|| {
            format!(
                "No safe snapshot change was found for {}. Refresh the sync plan.",
                rel
            )
        })?;
        if !planned.can_apply {
            return Err(format!(
                "{} cannot be applied safely: {}",
                rel,
                planned.warning.clone().unwrap_or_else(|| {
                    "the original file changed since the project was opened".to_string()
                })
            ));
        }
    }

    let backup_root = app_data_root()?.join("backups").join(format!(
        "{}-{}",
        snapshot_id,
        Utc::now().format("%Y%m%d%H%M%S")
    ));
    fs::create_dir_all(&backup_root).map_err(to_string)?;

    let mut applied_files = Vec::new();
    let mut manifest = read_baseline_manifest(&snapshot_root)?;
    for rel in files {
        let snapshot_path = safe_join(&snapshot_root, &rel)?;
        let original_path = safe_join(&original_root, &rel)?;
        let snapshot_exists = snapshot_path.exists();
        let clean_content = if snapshot_exists {
            let snapshot_content = fs::read_to_string(&snapshot_path).map_err(to_string)?;
            sanitize_preview_instrumentation(&snapshot_content)
        } else {
            String::new()
        };

        if original_path.exists() {
            let backup_path = safe_join(&backup_root, &rel)?;
            if let Some(parent) = backup_path.parent() {
                fs::create_dir_all(parent).map_err(to_string)?;
            }
            fs::copy(&original_path, backup_path).map_err(to_string)?;
        }
        if snapshot_exists {
            if let Some(parent) = original_path.parent() {
                fs::create_dir_all(parent).map_err(to_string)?;
            }
            fs::write(&original_path, clean_content.as_bytes()).map_err(to_string)?;
        } else if original_path.exists() {
            fs::remove_file(&original_path).map_err(to_string)?;
        }
        update_manifest_entry(&mut manifest, &rel, &original_root, &snapshot_root)?;
        applied_files.push(rel);
    }
    write_baseline_manifest(&snapshot_root, &manifest)?;

    Ok(ApplySyncResponse {
        applied_files,
        backup_root: backup_root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn refresh_from_original(
    snapshot_id: String,
    files: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<SourceFile>, String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    let original_root = PathBuf::from(snapshot.original_path);
    let snapshot_root = PathBuf::from(&snapshot.snapshot_path);
    let app_root = PathBuf::from(&snapshot.app_root_path);
    let plan_by_path: HashMap<String, ChangedFile> =
        build_sync_plan_files(&original_root, &snapshot_root)?
            .into_iter()
            .map(|file| (file.path.clone(), file))
            .collect();
    let mut manifest = read_baseline_manifest(&snapshot_root)?;

    for rel in files {
        let planned = plan_by_path
            .get(&rel)
            .ok_or_else(|| format!("No original change was found for {}.", rel))?;
        if planned.snapshot_changed_since_open {
            return Err(format!(
                "{} cannot be refreshed because the snapshot also changed. Resolve the conflict manually.",
                rel
            ));
        }
        let original_path = safe_join(&original_root, &rel)?;
        let snapshot_path = safe_join(&snapshot_root, &rel)?;
        if original_path.exists() {
            if !is_text_like(&original_path) {
                return Err(format!("{} is not a supported text file.", rel));
            }
            if let Some(parent) = snapshot_path.parent() {
                fs::create_dir_all(parent).map_err(to_string)?;
            }
            fs::copy(&original_path, &snapshot_path).map_err(to_string)?;
        } else if snapshot_path.exists() {
            fs::remove_file(&snapshot_path).map_err(to_string)?;
        }
        update_manifest_entry(&mut manifest, &rel, &original_root, &snapshot_root)?;
    }
    write_baseline_manifest(&snapshot_root, &manifest)?;
    list_source_files(&snapshot_root, &app_root)
}

#[tauri::command]
fn record_baseline(snapshot_id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let snapshot = get_snapshot(&state, &snapshot_id)?;
    create_baseline_manifest(
        Path::new(&snapshot.original_path),
        Path::new(&snapshot.snapshot_path),
    )
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
            apply_sync,
            refresh_from_original,
            record_baseline
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
                | SNAPSHOT_META_DIR
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".pytest_cache"
                | ".ruff_cache"
                | "dist"
                | "build"
                | ".next"
                | ".turbo"
                | "coverage"
                | ".cache"
                | "artifacts"
                | "out"
                | "tmp"
                | "target"
        )
    })
}

fn find_react_app_root(root: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<(usize, PathBuf)> = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_entry(|entry| !should_ignore_path(entry.path()))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() || entry.file_name() != "package.json" {
            continue;
        }
        let package_path = entry.path();
        let package_text = fs::read_to_string(package_path).unwrap_or_default();
        if !package_looks_like_react_app(&package_text) {
            continue;
        }
        let parent = package_path.parent().unwrap_or(root);
        let rel = parent.strip_prefix(root).unwrap_or(parent).to_path_buf();
        let depth = rel.components().count();
        let score = react_app_score(parent, &package_text, depth);
        candidates.push((score, rel));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    candidates.into_iter().map(|(_, rel)| rel).next()
}

fn package_looks_like_react_app(package_text: &str) -> bool {
    let value: serde_json::Value = serde_json::from_str(package_text).unwrap_or_default();
    let deps = ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|key| value.get(key))
        .fold(String::new(), |mut acc, item| {
            acc.push_str(&item.to_string());
            acc
        });
    deps.contains("\"react\"")
        && (deps.contains("\"vite\"")
            || deps.contains("\"next\"")
            || deps.contains("\"react-dom\""))
}

fn react_app_score(root: &Path, package_text: &str, depth: usize) -> usize {
    let value: serde_json::Value = serde_json::from_str(package_text).unwrap_or_default();
    let has_dev = value
        .get("scripts")
        .and_then(|scripts| scripts.get("dev").or_else(|| scripts.get("start")))
        .is_some();
    let has_vite = root.join("vite.config.ts").exists()
        || root.join("vite.config.js").exists()
        || root.join("vite.config.mjs").exists();
    let has_next = root.join("next.config.js").exists()
        || root.join("next.config.mjs").exists()
        || root.join("next.config.ts").exists();
    let has_index = root.join("index.html").exists();
    let depth_bonus = 8usize.saturating_sub(depth);
    (has_dev as usize * 40)
        + (has_vite as usize * 30)
        + (has_next as usize * 30)
        + (has_index as usize * 10)
        + depth_bonus
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
        command
            .arg("-H")
            .arg("127.0.0.1")
            .arg("-p")
            .arg(port.to_string());
    } else {
        command
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string());
    }
}

fn collect_preview_output<R>(reader: R, sender: mpsc::Sender<String>)
where
    R: io::Read + Send + 'static,
{
    thread::spawn(move || {
        let url_regex = Regex::new(r#"http://127\.0\.0\.1:\d+(/[^\s]*)?"#).unwrap();
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(found) = url_regex.find(&line) {
                sender.send(found.as_str().to_string()).ok();
            }
        }
    });
}

fn wait_for_preview_url(receiver: &mpsc::Receiver<String>, fallback_url: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(url) => return url,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    fallback_url.to_string()
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(to_string)?;
    Ok(listener.local_addr().map_err(to_string)?.port())
}

fn list_source_files(root: &Path, scan_root: &Path) -> Result<Vec<SourceFile>, String> {
    let mut files = Vec::new();
    for entry in WalkDir::new(scan_root)
        .into_iter()
        .filter_entry(|entry| !should_ignore_path(entry.path()))
        .filter_map(Result::ok)
    {
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
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    if matches!(ext, "tsx" | "jsx") {
        "react".to_string()
    } else if file_name.ends_with(".module.css") || matches!(ext, "css" | "scss" | "sass" | "less")
    {
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

fn manifest_path(snapshot_root: &Path) -> PathBuf {
    snapshot_root
        .join(SNAPSHOT_META_DIR)
        .join(BASELINE_MANIFEST_FILE)
}

fn create_baseline_manifest(original_root: &Path, snapshot_root: &Path) -> Result<(), String> {
    let mut manifest = BaselineManifest::default();
    let paths = collect_sync_paths(original_root, snapshot_root, &BaselineManifest::default())?;
    for rel in paths {
        update_manifest_entry(&mut manifest, &rel, original_root, snapshot_root)?;
    }
    write_baseline_manifest(snapshot_root, &manifest)
}

fn read_baseline_manifest(snapshot_root: &Path) -> Result<BaselineManifest, String> {
    let path = manifest_path(snapshot_root);
    if !path.exists() {
        return Ok(BaselineManifest::default());
    }
    let content = fs::read_to_string(path).map_err(to_string)?;
    serde_json::from_str(&content).map_err(to_string)
}

fn write_baseline_manifest(
    snapshot_root: &Path,
    manifest: &BaselineManifest,
) -> Result<(), String> {
    let path = manifest_path(snapshot_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    let content = serde_json::to_string_pretty(manifest).map_err(to_string)?;
    fs::write(path, content.as_bytes()).map_err(to_string)
}

fn update_manifest_entry(
    manifest: &mut BaselineManifest,
    rel: &str,
    original_root: &Path,
    snapshot_root: &Path,
) -> Result<(), String> {
    let original_path = safe_join(original_root, rel)?;
    let snapshot_path = safe_join(snapshot_root, rel)?;
    let original_hash = file_hash(&original_path)?;
    let snapshot_hash = file_hash(&snapshot_path)?;
    let original_exists = original_hash.is_some();
    let snapshot_exists = snapshot_hash.is_some();
    if original_exists || snapshot_exists {
        manifest.files.insert(
            rel.to_string(),
            BaselineEntry {
                path: rel.to_string(),
                original_hash,
                snapshot_hash,
                original_exists,
                snapshot_exists,
            },
        );
    } else {
        manifest.files.remove(rel);
    }
    Ok(())
}

fn build_sync_plan_files(
    original_root: &Path,
    snapshot_root: &Path,
) -> Result<Vec<ChangedFile>, String> {
    let manifest = read_baseline_manifest(snapshot_root)?;
    let paths = collect_sync_paths(original_root, snapshot_root, &manifest)?;
    let mut changed_files = Vec::new();

    for rel in paths {
        let baseline = manifest
            .files
            .get(&rel)
            .cloned()
            .unwrap_or_else(|| BaselineEntry {
                path: rel.clone(),
                original_hash: None,
                snapshot_hash: None,
                original_exists: false,
                snapshot_exists: false,
            });
        let original_path = safe_join(original_root, &rel)?;
        let snapshot_path = safe_join(snapshot_root, &rel)?;
        let original_hash = file_hash(&original_path)?;
        let snapshot_hash = file_hash(&snapshot_path)?;
        let original_exists = original_hash.is_some();
        let snapshot_exists = snapshot_hash.is_some();
        let original_changed =
            original_hash != baseline.original_hash || original_exists != baseline.original_exists;
        let snapshot_changed =
            snapshot_hash != baseline.snapshot_hash || snapshot_exists != baseline.snapshot_exists;
        let current_differs = original_hash != snapshot_hash || original_exists != snapshot_exists;
        if !current_differs {
            continue;
        }
        if !original_changed && !snapshot_changed {
            continue;
        }

        let (status, can_apply, warning) = if original_changed && snapshot_changed {
            (
                "conflict",
                false,
                Some(
                    "Original and snapshot both changed since this project was opened.".to_string(),
                ),
            )
        } else if original_changed {
            (
                "originalChanged",
                false,
                Some("Original changed since this project was opened. Refresh the snapshot before syncing.".to_string()),
            )
        } else if snapshot_changed {
            let status = if !snapshot_exists {
                "deleted"
            } else if !baseline.original_exists {
                "added"
            } else {
                "modified"
            };
            (status, true, None)
        } else {
            (
                "modified",
                false,
                Some(
                    "File differs but no baseline change classification was available.".to_string(),
                ),
            )
        };

        let original_content = read_clean_text(&original_path)?.unwrap_or_default();
        let snapshot_content = read_clean_text(&snapshot_path)?.unwrap_or_default();
        let diff = if status == "originalChanged" {
            unified_diff(&rel, &snapshot_content, &original_content)
        } else {
            unified_diff(&rel, &original_content, &snapshot_content)
        };

        changed_files.push(ChangedFile {
            path: rel,
            status: status.to_string(),
            diff,
            original_changed_since_open: original_changed,
            snapshot_changed_since_open: snapshot_changed,
            can_apply,
            warning,
        });
    }

    changed_files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changed_files)
}

fn collect_sync_paths(
    original_root: &Path,
    snapshot_root: &Path,
    manifest: &BaselineManifest,
) -> Result<Vec<String>, String> {
    let mut paths: HashSet<String> = manifest.files.keys().cloned().collect();
    collect_current_text_paths(original_root, original_root, &mut paths)?;
    collect_current_text_paths(snapshot_root, snapshot_root, &mut paths)?;
    let mut sorted: Vec<String> = paths.into_iter().collect();
    sorted.sort();
    Ok(sorted)
}

fn collect_current_text_paths(
    root: &Path,
    scan_root: &Path,
    paths: &mut HashSet<String>,
) -> Result<(), String> {
    for entry in WalkDir::new(scan_root)
        .into_iter()
        .filter_entry(|entry| !should_ignore_path(entry.path()))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file()
            || should_ignore_path(entry.path())
            || !is_text_like(entry.path())
        {
            continue;
        }
        let metadata = fs::metadata(entry.path()).map_err(to_string)?;
        if metadata.len() > MAX_TEXT_FILE_BYTES {
            continue;
        }
        paths.insert(relative_path(root, entry.path())?);
    }
    Ok(())
}

fn file_hash(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() || !path.is_file() || !is_text_like(path) {
        return Ok(None);
    }
    let content = read_clean_text(path)?.unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn read_clean_text(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() || !path.is_file() || !is_text_like(path) {
        return Ok(None);
    }
    let metadata = fs::metadata(path).map_err(to_string)?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(to_string)?;
    Ok(Some(sanitize_preview_instrumentation(&content)))
}

fn sanitize_preview_instrumentation(content: &str) -> String {
    let data_id =
        Regex::new(r#"\s+data-dev-design-id=(?:"[^"]*"|'[^']*'|\{["'][^"']*["']\})"#).unwrap();
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
