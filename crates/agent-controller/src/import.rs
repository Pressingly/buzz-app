//! Read-only access to earlier Buzz identity stores.
use crate::{config::MAX_BYTES, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LegacySource {
    Installed,
    Development,
}
impl LegacySource {
    pub fn keyring_service(self) -> &'static str {
        match self {
            Self::Installed => "xyz.moneta.buzz.legacy-desktop",
            Self::Development => "xyz.moneta.buzz.legacy-desktop-dev",
        }
    }
    pub fn app_directory(self) -> &'static str {
        match self {
            Self::Installed => "xyz.moneta.buzz.app",
            Self::Development => "xyz.moneta.buzz.app.dev",
        }
    }
}
pub(crate) fn read_json(path: &Path, optional: bool) -> Result<Value> {
    let meta = match fs::symlink_metadata(path) {
        Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("Could not read chosen Buzz source".into()),
        Ok(meta) => meta,
    };
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err("Import files must be bounded regular files".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "Could not open import source")?;
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read import source")?;
    if bytes.len() > MAX_BYTES {
        return Err("Import source exceeds size limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Import source is malformed; left unchanged".into())
}
