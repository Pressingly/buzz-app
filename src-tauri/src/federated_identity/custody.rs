//! Platform key custody, a Pressingly fork addition. A build compiled with
//! `BUZZ_BUILD_KEY_CUSTODY=platform` takes the human key from its own sign-in
//! server at every browser sign-in (`GET {adapterBase}/v1/identity/key`, the
//! organization's extension to NIP-FA) and never creates, imports or restores
//! a key of the person's own. Without it the build behaves like upstream.
use super::{
    config::Config,
    protocol::{self, Failure},
};
use serde::Deserialize;
use std::{future::Future, pin::Pin, sync::Arc};
use zeroize::{Zeroize, Zeroizing};

pub(crate) fn platform() -> bool {
    option_env!("BUZZ_BUILD_KEY_CUSTODY") == Some("platform")
}

/// Refuses every way of saving a key the organization did not issue.
pub(crate) fn refuse_local_key() -> Result<(), String> {
    if platform() {
        return Err(
            "This Buzz build gets your key from your organization when you sign in.".into(),
        );
    }
    Ok(())
}

/// Saves the account's key as the human identity, or refuses with a failure
/// code (`IdentityHost::platform_key_installer`).
pub(crate) type Installer = Arc<
    dyn Fn(
            Zeroizing<[u8; 32]>,
            String,
        ) -> Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send>>
        + Send
        + Sync,
>;

// No Debug, no Serialize: the secret goes only to the installer.
#[derive(Deserialize)]
struct Issued {
    nostr_pubkey: String,
    secret_key: String,
}
impl Drop for Issued {
    fn drop(&mut self) {
        self.secret_key.zeroize();
    }
}

/// The account's key, held natively until it is installed.
pub(super) struct PlatformKey {
    secret: Zeroizing<[u8; 32]>,
    pubkey: String,
}
impl PlatformKey {
    pub(super) async fn install(self, installer: &Installer) -> Result<(), Failure> {
        installer(self.secret, self.pubkey)
            .await
            .map_err(Failure::from)
    }
}

/// Fetches the key of the session just exchanged. A refusal here fails the
/// sign-in before anything is saved.
pub(super) async fn fetch(config: &Config, session_token: &str) -> Result<PlatformKey, Failure> {
    let client = protocol::client()?;
    let issued: Issued = protocol::json(|| {
        client
            .get(config.endpoint("/v1/identity/key"))
            .bearer_auth(session_token)
    })
    .await
    .map_err(key_refusal)?;
    Ok(PlatformKey {
        secret: decode(&issued)?,
        pubkey: issued.nostr_pubkey.clone(),
    })
}

/// The adapter's refusals on this route, named for the person.
fn key_refusal(failure: Failure) -> Failure {
    match failure.code {
        "authorization-denied" => "key-revoked".into(),
        "binding-mismatch" => "key-binding-mismatch".into(),
        _ => failure,
    }
}

fn decode(issued: &Issued) -> Result<Zeroizing<[u8; 32]>, Failure> {
    let lower_hex = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    };
    if !lower_hex(&issued.nostr_pubkey) || !lower_hex(&issued.secret_key) {
        return Err("invalid-response".into());
    }
    let nibble = |digit: u8| {
        if digit <= b'9' {
            digit - b'0'
        } else {
            digit - b'a' + 10
        }
    };
    let mut secret = Zeroizing::new([0u8; 32]);
    for (byte, pair) in secret
        .iter_mut()
        .zip(issued.secret_key.as_bytes().chunks_exact(2))
    {
        *byte = nibble(pair[0]) << 4 | nibble(pair[1]);
    }
    Ok(secret)
}

#[cfg(test)]
mod tests;
