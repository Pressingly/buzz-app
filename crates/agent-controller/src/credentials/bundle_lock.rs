use super::{bundle::BundleLock, Failure};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

pub(super) struct Lock(File);
#[cfg(all(target_os = "macos", not(test)))]
pub(super) fn acquire() -> Result<Lock, Failure> {
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .map_err(|_| Failure::Unavailable)?
        .ok_or(Failure::Unavailable)?
        .dir;
    acquire_at_home(&home)
}
fn acquire_at_home(home: &Path) -> Result<Lock, Failure> {
    acquire_at(&home.join(".moneta-buzz-credential-locks"))
}
pub(super) fn acquire_at(root: &Path) -> Result<Lock, Failure> {
    if !root.is_absolute() {
        return Err(Failure::Unavailable);
    }
    crate::connection::private_directory(root).map_err(|_| Failure::Unavailable)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(root.join("agent-bundle-v1.lock"))
        .map_err(|_| Failure::Unavailable)?;
    if !file.metadata().map_err(|_| Failure::Unavailable)?.is_file() {
        return Err(Failure::Unavailable);
    }
    file.try_lock().map_err(|_| Failure::Busy)?;
    Ok(Lock(file))
}
impl BundleLock for Lock {
    fn epoch(&mut self) -> Result<[u8; 16], Failure> {
        let len = self.0.metadata().map_err(|_| Failure::Unavailable)?.len();
        if len == 0 {
            return Ok([0; 16]);
        }
        if len != 16 {
            return Err(Failure::Corrupt);
        }
        let mut value = [0; 16];
        self.0
            .rewind()
            .and_then(|_| self.0.read_exact(&mut value))
            .map_err(|_| Failure::Unavailable)?;
        Ok(value)
    }
    fn invalidate(&mut self) -> Result<[u8; 16], Failure> {
        let mut value = [0; 16];
        getrandom::fill(&mut value).map_err(|_| Failure::Unavailable)?;
        self.0
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.0.write_all(&value))
            .and_then(|_| self.0.sync_all())
            .map_err(|_| Failure::Unavailable)?;
        Ok(value)
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[test]
fn first_run_creates_private_lock_directory_below_home() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".moneta-buzz-credential-locks");
    assert!(!root.exists());
    let mut lock = acquire_at_home(home.path()).unwrap();
    assert_eq!(lock.epoch().unwrap(), [0; 16]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(root.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }
    let epoch = lock.invalidate().unwrap();
    drop(lock);
    assert_eq!(
        acquire_at_home(home.path()).unwrap().epoch().unwrap(),
        epoch
    );
}

#[test]
fn shared_epoch_and_nonblocking_lock_survive_reopen() {
    let root = tempfile::tempdir().unwrap();
    let mut first = acquire_at(root.path()).unwrap();
    assert_eq!(first.epoch().unwrap(), [0; 16]);
    assert!(matches!(acquire_at(root.path()), Err(Failure::Busy)));
    let epoch = first.invalidate().unwrap();
    drop(first);
    assert_eq!(acquire_at(root.path()).unwrap().epoch().unwrap(), epoch);
}
