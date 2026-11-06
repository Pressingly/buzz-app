//! Opt-in automation for disposable macOS test instances, before identity startup.

use std::ffi::OsString;
use tauri::{plugin::TauriPlugin, Config, Wry};

pub fn plugin(
    config: &Config,
    opt_in: Option<OsString>,
    dev_viewer: Option<OsString>,
) -> Result<Option<TauriPlugin<Wry>>, String> {
    if opt_in.is_some()
        && !cfg!(all(
            debug_assertions,
            feature = "native-mcp",
            target_os = "macos"
        ))
    {
        return Err("requires a macOS debug build with the native-mcp Cargo feature".into());
    }
    let port = launch_port(config, opt_in, dev_viewer)?;
    #[cfg(all(debug_assertions, feature = "native-mcp", target_os = "macos"))]
    if let Some(port) = port {
        return Ok(Some(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .base_port(port)
                .build(),
        ));
    }
    let _ = port;
    Ok(None)
}

fn launch_port(
    config: &Config,
    opt_in: Option<OsString>,
    dev_viewer: Option<OsString>,
) -> Result<Option<u16>, String> {
    let Some(value) = opt_in else {
        return Ok(None);
    };
    if dev_viewer.is_some_and(|value| !value.is_empty()) {
        return Err("requires BUZZ_DEV_VIEWER= to disable the legacy identity broker".into());
    }
    let suffix = config
        .identifier
        .strip_prefix("xyz.moneta.buzz.foundation.nexus-test-")
        .filter(|suffix| {
            suffix.len() == 12
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    if suffix.is_none() {
        return Err(
            "requires identifier xyz.moneta.buzz.foundation.nexus-test-<12 lowercase hex digits>"
                .into(),
        );
    }
    if !config.app.with_global_tauri {
        return Err("requires the native MCP test configuration (withGlobalTauri)".into());
    }
    // The pinned bridge adds offsets 0..100 to this u16; reserve the full range.
    let port = value
        .to_str()
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| (1024..=65436).contains(port))
        .ok_or("BUZZ_NATIVE_MCP_PORT must be an integer from 1024 to 65436")?;
    Ok(Some(port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        let mut config: Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        config.identifier = "xyz.moneta.buzz.foundation.nexus-test-012345abcdef".into();
        config.app.with_global_tauri = true;
        config
    }

    #[test]
    fn ordinary_launch_does_not_enable_a_bridge() {
        assert!(
            plugin(&test_config(), None, Some("ignored-without-opt-in".into()))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn explicit_opt_in_requires_a_supported_build() {
        let result =
            plugin(&test_config(), Some("19423".into()), None).map(|plugin| plugin.is_some());
        if cfg!(all(
            debug_assertions,
            feature = "native-mcp",
            target_os = "macos"
        )) {
            assert!(result.unwrap());
        } else {
            assert!(result.unwrap_err().contains("macOS debug build"));
        }
    }

    #[test]
    fn valid_opt_in_is_accepted_without_a_broker_pin() {
        assert_eq!(
            launch_port(&test_config(), Some("19423".into()), None).unwrap(),
            Some(19423)
        );
        assert_eq!(
            launch_port(&test_config(), Some("19423".into()), Some("".into())).unwrap(),
            Some(19423)
        );
    }

    #[test]
    fn broker_identity_is_not_native_acceptance() {
        assert!(launch_port(
            &test_config(),
            Some("19423".into()),
            Some("legacy-viewer".into())
        )
        .unwrap_err()
        .contains("BUZZ_DEV_VIEWER"));
    }

    #[test]
    fn test_overlay_preserves_normal_capability_selection() {
        use std::collections::BTreeSet;
        let overlay: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.native-mcp.conf.json")).unwrap();
        let selected: BTreeSet<_> = overlay["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_owned))
            .collect();
        let normal: BTreeSet<_> =
            std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities"))
                .unwrap()
                .map(|entry| {
                    let capability: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap())
                            .unwrap();
                    capability["identifier"].as_str().unwrap().to_owned()
                })
                .collect();
        assert_eq!(selected, normal);
    }

    #[test]
    fn opt_in_rejects_normal_or_malformed_identifiers_and_missing_global_api() {
        let mut config = test_config();
        for identifier in [
            "xyz.moneta.buzz.foundation",
            "xyz.moneta.buzz.foundation.nexus-test-",
            "xyz.moneta.buzz.foundation.nexus-test-012345abcde",
            "xyz.moneta.buzz.foundation.nexus-test-012345abcdef0",
            "xyz.moneta.buzz.foundation.nexus-test-012345abcdeF",
            "xyz.moneta.buzz.foundation.nexus-test-012345abcdeg",
        ] {
            config.identifier = identifier.into();
            assert!(launch_port(&config, Some("19423".into()), None)
                .unwrap_err()
                .contains("requires identifier"));
        }
        config = test_config();
        config.app.with_global_tauri = false;
        assert!(launch_port(&config, Some("19423".into()), None)
            .unwrap_err()
            .contains("withGlobalTauri"));
    }

    #[test]
    fn base_port_leaves_room_for_the_dependency_scan() {
        let config = test_config();
        for port in ["1024", "65436"] {
            assert_eq!(
                launch_port(&config, Some(port.into()), None).unwrap(),
                Some(port.parse().unwrap())
            );
        }
        for port in [
            "", "0", "1023", "65437", "65535", "65536", "-1", "+19423", " 19423", "1.5",
        ] {
            assert!(launch_port(&config, Some(port.into()), None)
                .unwrap_err()
                .contains("integer from 1024 to 65436"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            assert!(launch_port(&config, Some(OsString::from_vec(vec![0xff])), None).is_err());
        }
    }
}
