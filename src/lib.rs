//! 4D language server support for Zed.
//!
//! 4D ships its language server inside the `tool4d` executable. It does not
//! speak LSP over stdio; it connects to a TCP port given by `--lsp=<port>`.
//! This extension therefore launches a tiny Node.js bridge (bundled below) that
//! translates between Zed's stdio transport and tool4d's TCP transport, and
//! that also finds or downloads tool4d.
//!
//! Settings (Zed `settings.json`):
//! ```json
//! {
//!   "lsp": {
//!     "4d-analyzer": {
//!       "binary": { "path": "/path/to/tool4d" },
//!       "settings": { "version": "latest", "channel": "stable", "download": true },
//!       "initialization_options": { "diagnostics": { "enable": true } }
//!     }
//!   }
//! }
//! ```

use std::path::PathBuf;

use zed_extension_api::{self as zed, serde_json, settings::LspSettings, LanguageServerId, Result};

const SERVER_ID: &str = "4d-analyzer";
const BRIDGE_JS: &str = include_str!("../bridge/bridge.js");
const BRIDGE_FILE: &str = "bridge.js";

/// Compatibility libraries tool4d needs on Linux (see bridge.js `COMPAT_LIBS`).
const COMPAT_LIBS: &[(&str, &[u8])] = &[
    ("libc++.so.1", include_bytes!("../compat/linux-x64/libc++.so.1")),
    ("libc++abi.so.1", include_bytes!("../compat/linux-x64/libc++abi.so.1")),
    ("libunwind.so.1", include_bytes!("../compat/linux-x64/libunwind.so.1")),
    ("libfreeimage.so.3", include_bytes!("../compat/linux-x64/libfreeimage.so.3")),
];

struct FourDExtension;

impl FourDExtension {
    /// Writes the bundled bridge script into the extension's working directory
    /// (only when it changed) and returns its absolute path.
    fn bridge_path() -> Result<String> {
        let cwd = std::env::current_dir().map_err(|e| format!("cannot read working dir: {e}"))?;
        let path: PathBuf = cwd.join(BRIDGE_FILE);
        let up_to_date = std::fs::read_to_string(&path).map(|s| s == BRIDGE_JS).unwrap_or(false);
        if !up_to_date {
            std::fs::write(&path, BRIDGE_JS).map_err(|e| format!("cannot write {BRIDGE_FILE}: {e}"))?;
        }
        Ok(path.to_string_lossy().into_owned())
    }
}

impl FourDExtension {
    /// Unpacks the bundled libraries into `<workdir>/compat/linux-x64` and returns `<workdir>/compat`.
    fn install_compat_libs() -> Result<String> {
        let compat = std::env::current_dir()
            .map_err(|e| format!("cannot read working dir: {e}"))?
            .join("compat");
        let dir = compat.join("linux-x64");
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        for (name, bytes) in COMPAT_LIBS {
            let path = dir.join(name);
            let same = std::fs::metadata(&path).map(|m| m.len() == bytes.len() as u64).unwrap_or(false);
            if !same {
                std::fs::write(&path, bytes).map_err(|e| format!("cannot write {name}: {e}"))?;
            }
        }
        Ok(compat.to_string_lossy().into_owned())
    }
}

impl zed::Extension for FourDExtension {
    fn new() -> Self {
        FourDExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let settings = LspSettings::for_worktree(SERVER_ID, worktree).ok();
        let node = zed::node_binary_path()?;

        let mut args = vec![Self::bridge_path()?];

        // Explicit tool4d / 4D / 4D Server path from `lsp.4d-analyzer.binary.path`.
        if let Some(path) = settings
            .as_ref()
            .and_then(|s| s.binary.as_ref())
            .and_then(|b| b.path.clone())
            .filter(|p| !p.is_empty())
        {
            args.push("--tool4d".into());
            args.push(path);
        } else if let Some(path) = worktree.which("tool4d") {
            args.push("--tool4d".into());
            args.push(path);
        }

        let user = settings.as_ref().and_then(|s| s.settings.as_ref());
        let get_str = |key: &str| user.and_then(|v| v.get(key)).and_then(|v| v.as_str());
        if let Some(v) = get_str("version") {
            args.push("--version".into());
            args.push(v.into());
        }
        if let Some(c) = get_str("channel") {
            args.push("--channel".into());
            args.push(c.into());
        }
        if user.and_then(|v| v.get("download")).and_then(|v| v.as_bool()) == Some(false) {
            args.push("--no-download".into());
        }

        // Extra arguments the user put in `binary.arguments` go after ours.
        if let Some(extra) = settings.as_ref().and_then(|s| s.binary.as_ref()).and_then(|b| b.arguments.clone()) {
            args.extend(extra);
        }

        // Download directory inside the extension's own work dir (writable sandbox).
        let download_dir = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join("tool4d")
            .to_string_lossy()
            .into_owned();
        args.push("--download-dir".into());
        args.push(download_dir);

        let (os, _) = zed::current_platform();
        if os == zed::Os::Linux {
            args.push("--compat-dir".into());
            args.push(Self::install_compat_libs()?);
        }

        Ok(zed::Command {
            command: node,
            args,
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        // Mirrors what the official VS Code extension sends.
        let mut options = serde_json::json!({ "dependencies": { "enable": true } });
        if let Some(user) = LspSettings::for_worktree(SERVER_ID, worktree)
            .ok()
            .and_then(|s| s.initialization_options)
        {
            if let (Some(base), Some(over)) = (options.as_object_mut(), user.as_object()) {
                for (k, v) in over {
                    base.insert(k.clone(), v.clone());
                }
            }
        }
        Ok(Some(options))
    }
}

zed::register_extension!(FourDExtension);
