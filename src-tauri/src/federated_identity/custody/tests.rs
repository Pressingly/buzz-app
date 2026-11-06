use super::super::tests::{adapter_with_status, at_adapter, Memory};
use super::*;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// The installer checks the pair; these fakes only need the wire format.
const PUBKEY: &str = "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
const SECRET: &str = "0101010101010101010101010101010101010101010101010101010101010101";

/// Each key installed, and whether a session was saved by then.
type Installed = Arc<Mutex<Vec<(Vec<u8>, String, bool)>>>;

/// Records each key it is given and answers `answer`.
fn installer(store: Arc<Memory>, answer: Result<(), &'static str>) -> (Installer, Installed) {
    let installed = Installed::default();
    let seen = installed.clone();
    let installer: Installer = Arc::new(move |secret, pubkey| {
        let saved = store.raw.lock().unwrap().is_some();
        seen.lock().unwrap().push((secret.to_vec(), pubkey, saved));
        Box::pin(async move { answer })
    });
    (installer, installed)
}

/// Exchange and session check replies, then the key route's replies.
fn replies(key: &[(u16, serde_json::Value)]) -> Vec<(u16, serde_json::Value)> {
    let session = [
        (
            200,
            serde_json::json!({"session_token":"fixture-session-token","expires_at":"2099-01-01T00:00:00Z"}),
        ),
        (
            200,
            serde_json::json!({"expires_at":"2099-01-01T00:00:00Z"}),
        ),
    ];
    session.into_iter().chain(key.iter().cloned()).collect()
}

async fn sign_in(
    key: &[(u16, serde_json::Value)],
    answer: Result<(), &'static str>,
) -> (Result<(), &'static str>, Arc<Memory>, Installed) {
    let store = Arc::new(Memory::default());
    let (base, server) = adapter_with_status(replies(key)).await;
    let owner = at_adapter(store.clone(), base);
    let (installer, installed) = installer(store.clone(), answer);
    owner.on_platform_key(installer);
    let result = owner
        .finish_login(
            "code",
            "secret",
            &owner.snapshot().revision,
            &CancellationToken::new(),
        )
        .await
        .map_err(|failure| failure.code);
    let seen = server.await.unwrap();
    assert_eq!(seen[2].target, "GET /mount/v1/identity/key HTTP/1.1");
    assert!(seen[2].headers.contains(&(
        "authorization".into(),
        "Bearer fixture-session-token".into()
    )));
    (result, store, installed)
}

#[test]
fn decodes_the_secret_from_lowercase_hex() {
    let issued = Issued {
        nostr_pubkey: PUBKEY.into(),
        secret_key: SECRET.into(),
    };
    assert_eq!(*decode(&issued).unwrap(), [1; 32]);
}

#[tokio::test]
async fn sign_in_installs_the_account_key_before_saving_the_session() {
    let key = serde_json::json!({"nostr_pubkey": PUBKEY, "secret_key": SECRET});
    let (result, store, installed) = sign_in(&[(200, key)], Ok(())).await;
    result.unwrap();
    assert_eq!(
        *installed.lock().unwrap(),
        vec![(vec![1; 32], PUBKEY.into(), false)]
    );
    assert!(store.raw.lock().unwrap().is_some());
}

#[tokio::test]
async fn a_refused_or_unusable_key_fails_sign_in_and_saves_no_session() {
    for (key, answer, code) in [
        (
            (403, serde_json::json!({"error":"authorization_denied"})),
            Ok(()),
            "key-revoked",
        ),
        (
            (403, serde_json::json!({"error":"binding_mismatch"})),
            Ok(()),
            "key-binding-mismatch",
        ),
        (
            (401, serde_json::json!({"error":"session_expired"})),
            Ok(()),
            "reauthentication-required",
        ),
        (
            (
                200,
                serde_json::json!({"nostr_pubkey": PUBKEY.to_uppercase(), "secret_key": SECRET}),
            ),
            Ok(()),
            "invalid-response",
        ),
        (
            (
                200,
                serde_json::json!({"nostr_pubkey": PUBKEY, "secret_key": &SECRET[2..]}),
            ),
            Ok(()),
            "invalid-response",
        ),
        (
            (
                200,
                serde_json::json!({"nostr_pubkey": PUBKEY, "secret_key": SECRET}),
            ),
            Err("local-key-differs"),
            "local-key-differs",
        ),
    ] {
        let installs = answer.is_err();
        let (result, store, installed) = sign_in(&[key], answer).await;
        assert_eq!(result, Err(code));
        assert!(store.raw.lock().unwrap().is_none(), "{code}");
        assert_eq!(
            installed.lock().unwrap().len(),
            usize::from(installs),
            "{code}"
        );
    }
}

#[tokio::test]
async fn an_unavailable_issuer_fails_sign_in_after_its_retries() {
    let unavailable = (503, serde_json::json!({"error":"issuance_unavailable"}));
    let (result, store, installed) = sign_in(
        &[unavailable.clone(), unavailable.clone(), unavailable],
        Ok(()),
    )
    .await;
    assert_eq!(result, Err("network-unavailable"));
    assert!(store.raw.lock().unwrap().is_none());
    assert!(installed.lock().unwrap().is_empty());
}

#[test]
fn only_platform_custody_names_an_unverified_email() {
    let refused = [
        ("error".to_owned(), "access_denied".to_owned()),
        (
            "error_description".to_owned(),
            "email_verification_required".to_owned(),
        ),
    ];
    let owner = at_adapter(Arc::new(Memory::default()), "http://127.0.0.1:0".into());
    assert_eq!(owner.login_refusal(&refused), "login-refused");
    owner.on_platform_key(installer(Arc::new(Memory::default()), Ok(())).0);
    assert_eq!(owner.login_refusal(&refused), "email-verification-required");
    assert_eq!(owner.login_refusal(&refused[..1]), "login-refused");
}

#[test]
fn a_custody_build_keeps_its_sessions_apart_from_other_builds() {
    use sha2::{Digest, Sha256};
    let config = Config::parse(r#"{"version":1,"id":"test","identityOrigin":"https://identity.example","adapterBase":"https://identity.example","apiBasePath":"/api/","communityHosts":["relay.example"]}"#).unwrap();
    let upstream = super::super::fingerprint(Some(&config), false).unwrap();
    let custody = super::super::fingerprint(Some(&config), true).unwrap();
    assert_ne!(upstream, custody);
    assert_eq!(
        upstream,
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&Some(config.identity())).unwrap())
        )
    );
}
