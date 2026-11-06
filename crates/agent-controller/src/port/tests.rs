use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// Saved keys by credential ID, and old Buzz's by source and pubkey.
#[derive(Default)]
struct Memory(Mutex<BTreeMap<String, String>>);
impl Credentials for Memory {
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        let saved = self.0.lock().unwrap();
        let hex = saved
            .get(&format!("{}:{pubkey}", source.keyring_service()))
            .ok_or("Absent")?;
        Secret::parse(hex, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        let saved = self.0.lock().unwrap();
        saved
            .get(id)
            .map(|hex| Secret::parse(hex, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        let mut saved = self.0.lock().unwrap();
        saved.insert(id.into(), key.hex().to_string());
        Ok(())
    }
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn stores(dir: &std::path::Path) -> OldStores {
    OldStores {
        harness: dir.join("app/agent-controller/agents.json"),
        data_dir: dir.join("data"),
    }
}
fn write(path: std::path::PathBuf, value: Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value.to_string()).unwrap();
}
fn legacy(dir: &std::path::Path, source: LegacySource, value: Value) {
    let path = dir
        .join("data")
        .join(source.app_directory())
        .join("agents/managed-agents.json");
    write(path, value);
}
fn key() -> Secret {
    Secret::generate().unwrap()
}

#[test]
fn lists_each_identity_once_preferring_the_harness_copy() {
    let dir = tempfile::tempdir().unwrap();
    let (shared, old, dev) = (key(), key(), key());
    write(
        stores(dir.path()).harness,
        json!({"version": 1, "agents": [{
            "pubkey": shared.pubkey(), "relayUrl": "wss://relay.example",
            "name": "Ada", "picture": "data:image/png;base64,iVBO",
            "credentialId": "ignored-by-list",
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": shared.pubkey(), "name": "Ada (old)", "relay_url": "wss://old.example"},
            {"pubkey": old.pubkey(), "name": " Bea ", "relay_url": "wss://old.example/",
             "avatar_url": "https://old.example/media/b.png"},
            // A persona with no identity, and an unnamed identity.
            {"pubkey": "", "name": "Persona"},
            {"pubkey": key().pubkey(), "name": ""},
        ]),
    );
    legacy(
        dir.path(),
        LegacySource::Development,
        json!([{"pubkey": dev.pubkey(), "name": "Cy", "relay_url": "not a relay"}]),
    );
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    assert_eq!(
        found.agents,
        [
            Portable {
                connection: SavedConnection {
                    runtime: "custom".into(),
                    ..Default::default()
                },
                source: PortSource::Harness,
                pubkey: shared.pubkey().into(),
                name: "Ada".into(),
                // Kept inline for the import to upload.
                picture: Some("data:image/png;base64,iVBO".into()),
                about: None,
                relay: "wss://relay.example".into(),
                carry: Carry::default(),
            },
            Portable {
                connection: SavedConnection {
                    runtime: "buzz-agent".into(),
                    ..Default::default()
                },
                source: PortSource::Installed,
                pubkey: old.pubkey().into(),
                name: "Bea".into(),
                picture: Some("https://old.example/media/b.png".into()),
                about: None,
                relay: "wss://old.example".into(),
                carry: Carry::default(),
            },
            Portable {
                connection: SavedConnection {
                    runtime: "buzz-agent".into(),
                    ..Default::default()
                },
                source: PortSource::Development,
                pubkey: dev.pubkey().into(),
                name: "Cy".into(),
                picture: None,
                about: None,
                relay: String::new(),
                carry: Carry::default(),
            },
        ]
    );
}

#[test]
fn carries_each_stores_own_instructions_and_the_harness_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let (harness, old, linked, blank) = (key(), key(), key(), key());
    write(
        stores(dir.path()).harness,
        json!({"agents": [{
            "pubkey": harness.pubkey(), "relayUrl": "wss://relay.example", "name": "Ada",
            "systemPrompt": " Review PRs.\n", "workspace": "~/code",
        }, {
            "pubkey": blank.pubkey(), "relayUrl": "wss://relay.example", "name": "Dee",
            "systemPrompt": "  ", "workspace": "",
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": old.pubkey(), "name": "Bea", "system_prompt": "Triage.", "workspace": "~/x"},
            // Old Buzz ran the instance's prompt; its definition's is not used.
            {"pubkey": "", "slug": "reviewer", "name": "Reviewer", "system_prompt": "Persona."},
            {"pubkey": linked.pubkey(), "name": "Cy", "persona_id": "reviewer", "system_prompt": null},
        ]),
    );
    let carried: BTreeMap<_, _> = stores(dir.path())
        .list()
        .agents
        .into_iter()
        .map(|agent| (agent.name, agent.carry))
        .collect();
    assert_eq!(
        carried,
        BTreeMap::from([
            (
                "Ada".into(),
                Carry {
                    instructions: Some("Review PRs.".into()),
                    workspace: Some("~/code".into()),
                }
            ),
            (
                "Bea".into(),
                Carry {
                    instructions: Some("Triage.".into()),
                    workspace: None,
                }
            ),
            ("Cy".into(), Carry::default()),
            ("Dee".into(), Carry::default()),
        ])
    );
    // Listing never shows them; only taking the agent over does.
    assert!(!serde_json::to_string(&stores(dir.path()).list())
        .unwrap()
        .contains("Review PRs"));
}

#[test]
fn missing_stores_list_nothing_and_a_broken_one_hides_only_itself() {
    let dir = tempfile::tempdir().unwrap();
    assert!(stores(dir.path()).list().agents.is_empty());
    assert!(stores(dir.path()).list().warnings.is_empty());
    let old = key();
    write(stores(dir.path()).harness, json!({"agents": "nope"}));
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([{"pubkey": old.pubkey(), "name": "Bea"}]),
    );
    let found = stores(dir.path()).list();
    assert_eq!(found.warnings.len(), 1);
    assert_eq!(found.agents.len(), 1);
    assert_eq!(found.agents[0].pubkey, old.pubkey());
}

#[test]
fn takes_the_key_from_the_store_it_was_listed_in() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (harness, old, inline) = (key(), key(), key());
    let id = agent_id(harness.pubkey(), "wss://relay.example");
    credentials.add(&id, &harness).unwrap();
    credentials.0.lock().unwrap().insert(
        format!("xyz.moneta.buzz.legacy-desktop:{}", old.pubkey()),
        old.hex().to_string(),
    );
    write(
        stores(dir.path()).harness,
        json!({"agents": [{
            "pubkey": harness.pubkey(), "relayUrl": "wss://relay.example",
            "name": "Ada", "credentialId": id,
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": old.pubkey(), "name": "Bea", "description": " Reviews PRs ",
             "avatar_url": "https://old.example/bea.png"},
            {"pubkey": inline.pubkey(), "name": "Cy", "private_key_nsec": inline.hex().to_string()},
        ]),
    );
    let stores = stores(dir.path());
    let (agent, key) = stores
        .take(PortSource::Harness, harness.pubkey(), &credentials)
        .unwrap();
    assert_eq!(
        (agent.name.as_str(), key.pubkey()),
        ("Ada", harness.pubkey())
    );
    let (agent, key) = stores
        .take(PortSource::Installed, old.pubkey(), &credentials)
        .unwrap();
    assert_eq!((agent.name.as_str(), key.pubkey()), ("Bea", old.pubkey()));
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(key.pubkey())).unwrap();
    let prepared = crate::AppAgents::adopt(
        "wss://relay.example",
        &auth[1],
        "p/t",
        key,
        &agent.name,
        agent.picture,
        agent.about,
    )
    .unwrap();
    let destination = crate::AppAgents::open(dir.path().join("agents/identities.json"));
    let (agent, key) = destination.commit(prepared, &auth, &credentials).unwrap();
    let reopened = destination.get(&agent.pubkey, &agent.relay).unwrap();
    let profile = reopened.profile_event(&key).unwrap();
    let content: Value = serde_json::from_str(profile["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        content,
        json!({"name": "Bea", "bot": true,
        "picture": "https://old.example/bea.png", "about": "Reviews PRs"})
    );
    let event: nostr::event::Event = serde_json::from_value(profile).unwrap();
    event.verify().unwrap();
    // A key old Buzz kept in the record is read from there, not the keychain.
    let (_, key) = stores
        .take(PortSource::Installed, inline.pubkey(), &credentials)
        .unwrap();
    assert_eq!(key.pubkey(), inline.pubkey());
    assert!(!serde_json::to_string(&stores.list())
        .unwrap()
        .contains(&*inline.hex()));
    // Each source reads only its own store.
    assert!(stores
        .take(PortSource::Development, old.pubkey(), &credentials)
        .is_err());
    assert!(stores
        .take(PortSource::Harness, old.pubkey(), &credentials)
        .is_err());
}

#[test]
fn a_harness_copy_whose_key_is_gone_falls_back_to_old_buzzs_copy() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (stale, absent) = (key(), key());
    write(
        stores(dir.path()).harness,
        json!({"agents": [
            {"pubkey": stale.pubkey(), "relayUrl": "wss://relay.example",
             "name": "Stale", "credentialId": "gone"},
            {"pubkey": absent.pubkey(), "relayUrl": "wss://relay.example",
             "name": "Nowhere", "credentialId": "gone"},
        ]}),
    );
    legacy(
        dir.path(),
        LegacySource::Development,
        json!([{"pubkey": stale.pubkey(), "name": "Working",
                "private_key_nsec": stale.hex().to_string()}]),
    );
    let stores = stores(dir.path());
    let (agent, key) = stores
        .take(PortSource::Harness, stale.pubkey(), &credentials)
        .unwrap();
    assert_eq!(
        (agent.source, agent.name.as_str(), key.pubkey()),
        (PortSource::Development, "Working", stale.pubkey())
    );
    // With no copy that has its key, the harness copy's reason stands.
    assert_eq!(
        stores
            .take(PortSource::Harness, absent.pubkey(), &credentials)
            .err()
            .as_deref(),
        Some(KEY_GONE)
    );
}

#[test]
fn reads_only_known_inline_images() {
    assert_eq!(
        inline_picture("data:image/png;base64,iVBO"),
        Some(("image/png", vec![0x89, 0x50, 0x4e]))
    );
    for refused in [
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:image/png,raw",
        "data:image/png;base64,!!",
        "https://example.test/a.png",
    ] {
        assert_eq!(inline_picture(refused), None, "{refused}");
    }
}

#[test]
fn imports_authored_descriptions_from_the_saved_profile_or_exact_definition() {
    let dir = tempfile::tempdir().unwrap();
    let keys: Vec<_> = (0..7).map(|_| key()).collect();
    write(
        stores(dir.path()).harness,
        json!({"agents": [
            {"pubkey": keys[0].pubkey(), "name": "Snapshot", "imported": {
                "record": {"profile": {"about": " Snapshot description "}}
            }},
            {"pubkey": keys[1].pubkey(), "name": "Imported legacy", "imported": {
                "record": {"persona_id": "reviewer", "description": "stale"},
                "definition": {"description": " Retained definition "}
            }}
        ]}),
    );
    let records = json!([
        {"pubkey": keys[2].pubkey(), "name": "Linked", "persona_id": "reviewer", "description": "stale"},
        {"pubkey": "", "slug": "reviewer", "description": " Reviews PRs.\nCarefully. "},
        {"pubkey": keys[3].pubkey(), "name": "Standalone", "description": " Standalone description "},
        {"pubkey": keys[4].pubkey(), "name": "Orphan", "persona_id": "missing", "description": "stale"},
        {"pubkey": keys[5].pubkey(), "name": "Blank", "persona_id": "blank", "description": "stale"},
        {"pubkey": "", "slug": "blank", "description": "  "},
        {"pubkey": keys[6].pubkey(), "name": "Unrelated", "description": "Other description"}
    ]);
    // Both legacy installation paths have the same persisted format.
    for source in [LegacySource::Installed, LegacySource::Development] {
        legacy(dir.path(), source, records.clone());
        let found = stores(dir.path()).list();
        assert!(found.warnings.is_empty());
        let descriptions: Vec<_> = found
            .agents
            .iter()
            .map(|agent| serde_json::to_value(agent).unwrap()["about"].clone())
            .collect();
        assert_eq!(
            descriptions,
            vec![
                json!("Snapshot description"),
                json!("Retained definition"),
                json!("Reviews PRs.\nCarefully."),
                json!("Standalone description"),
                Value::Null,
                Value::Null,
                json!("Other description"),
            ]
        );
        std::fs::remove_file(
            dir.path()
                .join("data")
                .join(source.app_directory())
                .join("agents/managed-agents.json"),
        )
        .unwrap();
    }
}

#[test]
fn retained_harness_artwork_survives_agents_storage_and_signed_publication() {
    let retained = json!({
        "record": {"persona_id": "reviewer", "avatar_url": "https://old.example/identity.png"},
        "definition": {"slug": "reviewer", "avatar_url": "https://old.example/definition.png"}
    });
    let mut inherited = retained.clone();
    inherited["record"]["avatar_url"] = Value::Null;
    let snapshot = json!({"record": {"profile": {
        "avatarUrl": "https://old.example/snapshot.png", "avatarDataUrl": "data:image/png;base64,AA"
    }}});
    let mut unsafe_legacy = retained.clone();
    unsafe_legacy["record"]["avatar_url"] = json!("https://user:secret@old.example/private.png");
    for (current, imported, expected) in [
        (
            Value::Null,
            retained.clone(),
            Some("https://old.example/identity.png"),
        ),
        (
            Value::Null,
            inherited,
            Some("https://old.example/definition.png"),
        ),
        (
            Value::Null,
            snapshot,
            Some("https://old.example/snapshot.png"),
        ),
        (
            json!("https://new.example/current.png"),
            retained.clone(),
            Some("https://new.example/current.png"),
        ),
        // Empty is an explicit harness removal, not a missing override.
        (json!(""), retained.clone(), None),
        (json!("data:image/png;base64,AA"), retained, None),
        (Value::Null, unsafe_legacy, None),
        (Value::Null, Value::Null, None),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Memory::default();
        let key = key();
        let id = agent_id(key.pubkey(), "wss://relay.example");
        credentials.add(&id, &key).unwrap();
        let stores = stores(dir.path());
        write(
            stores.harness.clone(),
            json!({"version": 1, "agents": [{
                "pubkey": key.pubkey(), "relayUrl": "wss://relay.example", "name": "Ada",
                "credentialId": id, "picture": current, "imported": imported
            }]}),
        );
        // The harness wins over the installed copy of this exact identity.
        legacy(
            dir.path(),
            LegacySource::Installed,
            json!([{
                "pubkey": key.pubkey(), "name": "Old Ada", "avatar_url": "https://old.example/installed.png"
            }]),
        );
        let found = stores.list();
        assert!(found.warnings.is_empty());
        assert_eq!(found.agents.len(), 1);
        assert_eq!(found.agents[0].source, PortSource::Harness);
        let (agent, key) = stores
            .take(found.agents[0].source, key.pubkey(), &credentials)
            .unwrap();
        let auth: Vec<String> =
            serde_json::from_str(&crate::secret::test_attestation(key.pubkey())).unwrap();
        let prepared = crate::AppAgents::adopt(
            "wss://relay.example",
            &auth[1],
            "p/t",
            key,
            &agent.name,
            agent.picture,
            agent.about,
        )
        .unwrap();
        let path = dir.path().join("agents/identities.json");
        let (agent, _) = crate::AppAgents::open(path.clone())
            .commit(prepared, &auth, &credentials)
            .unwrap();
        let reopened = crate::AppAgents::open(path)
            .get(&agent.pubkey, &agent.relay)
            .unwrap();
        let event = reopened
            .profile_event(&reopened.read_key(&credentials).unwrap())
            .unwrap();
        assert_eq!(event["kind"], 0);
        let content: Value = serde_json::from_str(event["content"].as_str().unwrap()).unwrap();
        assert_eq!(content.get("picture").and_then(Value::as_str), expected);
        let event: nostr::event::Event = serde_json::from_value(event).unwrap();
        event.verify().unwrap();
    }
}

/// Old Buzz's team file and agent library, scrubbed: no keys, made-up names.
fn old_buzz(dir: &std::path::Path, source: LegacySource) {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/old-buzz-teams");
    let agents = dir.join("data").join(source.app_directory()).join("agents");
    std::fs::create_dir_all(&agents).unwrap();
    for file in ["teams.json", "managed-agents.json"] {
        std::fs::copy(fixture.join(file), agents.join(file)).unwrap();
    }
}
fn team<'a>(found: &'a Portables, id: &str) -> Option<&'a OldTeam> {
    found.teams.iter().find(|team| team.id == id)
}
fn names(team: &OldTeam) -> Vec<&str> {
    team.members.iter().map(|m| m.name.as_str()).collect()
}
const NIGHT_SHIFT: &str = "6f9c2d1e-4b7a-4e8f-9a3c-2d5e8f1b7c40";

#[test]
fn lists_old_buzz_teams_with_their_members_apart_from_agents() {
    let dir = tempfile::tempdir().unwrap();
    old_buzz(dir.path(), LegacySource::Installed);
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    let night_shift = team(&found, NIGHT_SHIFT).unwrap();
    assert_eq!(night_shift.name, "Night Shift");
    assert_eq!(
        night_shift.instructions,
        "Ship small, verified changes.\nReport in the originating thread."
    );
    assert_eq!(
        night_shift.members,
        [
            OldMember {
                pubkey: "1".repeat(64),
                name: "Alder".into(),
                source: PortSource::Installed,
            },
            OldMember {
                pubkey: "2".repeat(64),
                name: "Birch".into(),
                source: PortSource::Installed,
            },
        ]
    );
    // A user's own team with the built-in one's name still comes.
    let greeters = found
        .teams
        .iter()
        .find(|t| t.name == "Welcome Team")
        .unwrap();
    assert_eq!(names(greeters), ["Greeter"]);
    let nameless = found
        .teams
        .iter()
        .find(|t| names(t) == ["Nameless"])
        .unwrap();
    assert_eq!(
        (nameless.name.as_str(), nameless.instructions.as_str()),
        ("Team from old Buzz", "")
    );
    // Built in to old Buzz, by its flag, or deleted there: no row; its members
    // are plain agents.
    assert!(team(&found, "builtin-team:welcome").is_none());
    assert_eq!(found.teams.len(), 3);
    assert!(found.agents.iter().any(|agent| agent.name == "Fizz"));
    assert_eq!(found.agents.len(), 7);
    // Agents carry no team of their own.
    let json = serde_json::to_value(&found).unwrap();
    assert!(json["agents"]
        .as_array()
        .unwrap()
        .iter()
        .all(|agent| agent.get("team").is_none()));
    assert_eq!(json["teams"][0]["members"][0]["source"], "installed");
}

#[test]
fn a_member_listed_by_its_harness_copy_stays_on_its_team() {
    let dir = tempfile::tempdir().unwrap();
    old_buzz(dir.path(), LegacySource::Installed);
    // The harness took Birch over, without old Buzz's team link.
    write(
        stores(dir.path()).harness,
        json!({"version": 1, "agents": [{"pubkey": "2".repeat(64), "name": "Birch (harness)"}]}),
    );
    let found = stores(dir.path()).list();
    let birch = &team(&found, NIGHT_SHIFT).unwrap().members[1];
    assert_eq!(
        (birch.name.as_str(), birch.source),
        ("Birch (harness)", PortSource::Harness)
    );
}

#[test]
fn installed_and_development_copies_of_a_team_merge() {
    let dir = tempfile::tempdir().unwrap();
    let teams = |name: &str| json!([{"id": "t", "name": name, "instructions": name}]);
    let path = |source: LegacySource| {
        dir.path()
            .join("data")
            .join(source.app_directory())
            .join("agents/teams.json")
    };
    let member =
        |n: &str, name: &str| json!([{"pubkey": n.repeat(64), "name": name, "team_id": "t"}]);
    legacy(dir.path(), LegacySource::Installed, member("1", "Alder"));
    legacy(dir.path(), LegacySource::Development, member("2", "Birch"));
    write(path(LegacySource::Installed), teams("Kept"));
    write(path(LegacySource::Development), teams("Dropped"));
    let found = stores(dir.path()).list();
    assert_eq!(found.teams.len(), 1);
    assert_eq!(
        (
            found.teams[0].name.as_str(),
            found.teams[0].instructions.as_str()
        ),
        ("Kept", "Kept")
    );
    assert_eq!(names(&found.teams[0]), ["Alder", "Birch"]);
    assert_eq!(found.teams[0].members[1].source, PortSource::Development);
}

#[test]
fn members_linked_only_by_team_folder_stay_on_their_team() {
    let agent = |n: &str, name: &str, link: Value| {
        let mut record = json!({"pubkey": n.repeat(64), "name": name});
        record
            .as_object_mut()
            .unwrap()
            .extend(link.as_object().unwrap().clone());
        record
    };
    let alder = agent(
        "1",
        "Alder",
        json!({"persona_team_dir": "/installed/com.example.pack"}),
    );
    let list = |records: Value| {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path(), LegacySource::Installed, records);
        write(
            dir.path()
                .join("data")
                .join(LegacySource::Installed.app_directory())
                .join("agents/teams.json"),
            json!([
                {"id": "pack", "name": "Pack", "source_dir": "/teams/com.example.pack"},
                {"id": "mixed", "name": "Mixed"},
            ]),
        );
        let found = stores(dir.path()).list();
        assert!(found.warnings.is_empty());
        found
    };
    // No agent has a team ID: a folder-backed team, linked by its folder's name.
    let found = list(json!([alder]));
    assert_eq!(names(team(&found, "pack").unwrap()), ["Alder"]);
    // A mixed team: one by ID, one by the folder named for its ID.
    let found = list(json!([
        alder,
        agent("2", "Birch", json!({"team_id": "mixed"})),
        agent("3", "Carrow", json!({"persona_team_dir": "/teams/mixed"})),
        agent("4", "Dune", json!({"persona_team_dir": "/teams/elsewhere"})),
    ]));
    assert_eq!(names(team(&found, "pack").unwrap()), ["Alder"]);
    assert_eq!(names(team(&found, "mixed").unwrap()), ["Birch", "Carrow"]);
}

#[test]
fn unreadable_teams_warn_and_leave_every_agent_importable() {
    let teams_path = |dir: &std::path::Path| {
        dir.join("data")
            .join(LegacySource::Installed.app_directory())
            .join("agents/teams.json")
    };
    let member = json!([{"pubkey": "1".repeat(64), "name": "Alder", "team_id": "t"}]);
    // A missing file: no teams and nothing to report.
    let dir = tempfile::tempdir().unwrap();
    legacy(dir.path(), LegacySource::Installed, member.clone());
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    assert!(found.teams.is_empty());
    for broken in [
        json!({"teams": []}),
        json!([{"id": "t", "name": "A"}, {"id": "t", "name": "B"}]),
        json!([{"id": "", "name": "A"}]),
        json!([{"id": "t", "name": "A", "instructions": 7}]),
        json!([{"id": "t", "name": "A", "instructions": "a\0b"}]),
        json!([{"id": "t", "name": "A", "instructions": "x".repeat(128 * 1024 + 1)}]),
    ] {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path(), LegacySource::Installed, member.clone());
        write(teams_path(dir.path()), broken.clone());
        let found = stores(dir.path()).list();
        assert_eq!(found.warnings.len(), 1, "{broken}");
        assert_eq!(found.agents.len(), 1);
        assert!(found.teams.is_empty());
    }
    // Not JSON at all.
    let dir = tempfile::tempdir().unwrap();
    legacy(dir.path(), LegacySource::Installed, member);
    std::fs::write(teams_path(dir.path()), "{").unwrap();
    assert_eq!(stores(dir.path()).list().warnings.len(), 1);
}

#[test]
fn team_names_are_trimmed_bounded_and_never_blank() {
    assert_eq!(team_name("  Night  "), "Night");
    assert_eq!(team_name(" \n "), "Team from old Buzz");
    assert_eq!(team_name(&"a".repeat(130)), "a".repeat(120));
    // 119 units, then a two-unit character that would cross 120: dropped whole.
    assert_eq!(
        team_name(&format!("{}😀b", "a".repeat(119))),
        "a".repeat(119)
    );
}

/// Importing a team lists afresh, so what it saves is the stores as they are
/// then, not as they were previewed.
#[test]
fn each_listing_rereads_both_stores_teams() {
    let dir = tempfile::tempdir().unwrap();
    old_buzz(dir.path(), LegacySource::Installed);
    let stores = stores(dir.path());
    assert_eq!(
        names(team(&stores.list(), NIGHT_SHIFT).unwrap()),
        ["Alder", "Birch"]
    );
    let teams = dir
        .path()
        .join("data")
        .join(LegacySource::Installed.app_directory())
        .join("agents/teams.json");
    write(
        teams,
        json!([{"id": NIGHT_SHIFT, "name": "Day Shift", "instructions": "New text."}]),
    );
    legacy(
        dir.path(),
        LegacySource::Development,
        json!([{"pubkey": "8".repeat(64), "name": "Carrow", "team_id": NIGHT_SHIFT}]),
    );
    write(
        dir.path()
            .join("data")
            .join(LegacySource::Development.app_directory())
            .join("agents/teams.json"),
        json!([{"id": NIGHT_SHIFT, "name": "Ignored"}]),
    );
    let json = serde_json::to_value(stores.list()).unwrap();
    let row = json["teams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|team| team["id"] == NIGHT_SHIFT)
        .unwrap();
    assert_eq!(row["name"], "Day Shift");
    assert_eq!(row["instructions"], "New text.");
    let members: Vec<&Value> = row["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| &m["name"])
        .collect();
    assert_eq!(members, ["Alder", "Birch", "Carrow"]);
}
