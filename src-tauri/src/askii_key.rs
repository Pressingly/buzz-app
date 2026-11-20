//! The Askii key for the bundled goose, a Pressingly fork addition. A build
//! compiled with `BUZZ_BUILD_ASKII_URL` reads the AI Productivity Toolkit's
//! `~/.askii/credentials.json` and keeps a pasted key in the keychain; the
//! frontend (`src/bundled/goose/askii.ts`) picks between them. Without it every
//! command is inert, as upstream has none.
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.moneta.buzz.desktop.askii-key.debug"
} else {
    "xyz.moneta.buzz.desktop.askii-key"
};
const ACCOUNT: &str = "goose";
const MAX_CREDENTIALS: u64 = 64 * 1024;
const MAX_KEY: usize = 512;

fn enabled() -> bool {
    option_env!("BUZZ_BUILD_ASKII_URL").is_some_and(|url| !url.trim().is_empty())
}

fn credentials_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".askii").join("credentials.json"))
}

/// The file's text, or `None` when it is absent. A file too large to be the
/// toolkit's is refused rather than read.
fn read_bounded(path: &Path) -> Result<Option<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the Askii credentials file".into()),
    };
    let mut text = String::new();
    file.take(MAX_CREDENTIALS + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Cannot read the Askii credentials file")?;
    if text.len() as u64 > MAX_CREDENTIALS {
        return Err("The Askii credentials file is too large".into());
    }
    Ok(Some(text))
}

pub(crate) fn valid_key(key: &str) -> bool {
    (8..=MAX_KEY).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}

/// The toolkit's credentials file as written, for the frontend to check.
#[tauri::command]
pub(crate) fn askii_toolkit_credentials() -> Result<Option<String>, String> {
    if !enabled() {
        return Ok(None);
    }
    credentials_path().map_or(Ok(None), |path| read_bounded(&path))
}

/// The pasted key, if one is saved.
#[tauri::command]
pub(crate) fn askii_key_read() -> Result<Option<String>, String> {
    if !enabled() {
        return Ok(None);
    }
    match buzz_credential_store::read(SERVICE, ACCOUNT) {
        Ok(bytes) => Ok(String::from_utf8(bytes.to_vec()).ok()),
        Err(buzz_credential_store::Error::Absent) => Ok(None),
        Err(_) => Err("Cannot read the saved Askii key".into()),
    }
}

/// Saves or replaces the pasted key.
#[tauri::command]
pub(crate) fn askii_key_save(key: String) -> Result<(), String> {
    if !enabled() {
        return Err("This Buzz build has no Askii preset".into());
    }
    let key = key.trim();
    if !valid_key(key) {
        return Err("That doesn't look like an Askii API key".into());
    }
    buzz_credential_store::replace(SERVICE, ACCOUNT, key.as_bytes())
        .map_err(|_| "Cannot save the Askii key".into())
}

/// Removes the pasted key; one already gone is not an error.
#[tauri::command]
pub(crate) fn askii_key_clear() -> Result<(), String> {
    remove_saved_key()
}

/// Also run by Sign out of Buzz, which erases what the person saved here.
pub(crate) fn remove_saved_key() -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    match buzz_credential_store::delete(SERVICE, ACCOUNT) {
        Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
        Err(_) => Err("Cannot remove the saved Askii key".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_toolkit_file_or_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("credentials.json");
        assert_eq!(read_bounded(&path), Ok(None));
        fs::write(&path, r#"{"api_key":"sk-test"}"#).unwrap();
        assert_eq!(
            read_bounded(&path),
            Ok(Some(r#"{"api_key":"sk-test"}"#.into()))
        );
    }

    #[test]
    fn refuses_a_file_too_large_to_be_the_toolkits() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("credentials.json");
        fs::write(&path, vec![b' '; MAX_CREDENTIALS as usize + 1]).unwrap();
        assert!(read_bounded(&path).is_err());
    }

    #[test]
    fn accepts_only_printable_keys_of_a_plausible_length() {
        assert!(valid_key("sk-0123456789"));
        assert!(!valid_key("sk-1"));
        assert!(!valid_key("sk-0123 456789"));
        assert!(!valid_key("sk-0123456789\n"));
        assert!(!valid_key(&"k".repeat(MAX_KEY + 1)));
    }

    #[test]
    fn keeps_the_key_in_the_moneta_namespace() {
        assert!(SERVICE.starts_with("xyz.moneta.buzz.desktop."));
    }
}
