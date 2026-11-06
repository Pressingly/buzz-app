#![cfg(unix)]
//! A fresh local agent finds a session a plugin advertised, with no inherited
//! connection, through the same helper the app ships.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

const SESSION: &str = "session-1";

/// A loopback MCP server like the app's: one bearer token, one session that
/// `initialize` claims, and 404 for anything it refuses.
fn server(label: &'static str, tools: &'static [&'static str]) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                headers.push(line.trim_end().to_ascii_lowercase());
            }
            let length = headers
                .iter()
                .find_map(|header| header.strip_prefix("content-length: "))
                .map_or(0, |length| length.parse().unwrap());
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            let has = |header: &str| headers.iter().any(|line| line == header);
            let method = request["method"].as_str().unwrap();
            let (status, reply) = if !has(&format!("authorization: bearer {label}-token")) {
                ("404 Not Found", None)
            } else if method == "initialize" {
                ("200 OK", Some(json!({})))
            } else if !has(&format!("mcp-session-id: {SESSION}")) {
                ("404 Not Found", None)
            } else if method == "tools/list" {
                let tools: Vec<_> = tools
                    .iter()
                    .map(|name| json!({"name": name, "inputSchema": {"properties": {"text": {"type": "string"}}}}))
                    .collect();
                ("200 OK", Some(json!({ "tools": tools })))
            } else if method == "tools/call" {
                let text = format!(
                    "{label} {} {}",
                    request["params"]["name"], request["params"]["arguments"]
                );
                (
                    "200 OK",
                    Some(json!({"content": [{"type": "text", "text": text}]})),
                )
            } else {
                ("202 Accepted", None)
            };
            let body = reply.map_or(String::new(), |result| {
                json!({"jsonrpc": "2.0", "id": request["id"], "result": result}).to_string()
            });
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nmcp-session-id: {SESSION}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    url
}

fn connection(url: &str, label: &str, session: bool) -> String {
    let mut headers =
        vec![json!({"name": "authorization", "value": format!("Bearer {label}-token")})];
    if session {
        headers.push(json!({"name": "mcp-session-id", "value": SESSION}));
    }
    json!({ "url": url, "headers": headers }).to_string()
}

fn helper(home: &Path, inherited: Option<&str>, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_buzz-agent-command"));
    command
        .args(args)
        .env("HOME", home)
        .env_remove("BUZZ_AGENT_CONNECTION");
    if let Some(connection) = inherited {
        command.env("BUZZ_AGENT_CONNECTION", connection);
    }
    command.output().unwrap()
}

fn stdout(output: &Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout.clone()).unwrap()
}

/// Writes an advertisement as `mode`, as another writer might have.
fn plant(path: &Path, connection: String, mode: u32) {
    std::fs::write(path, connection).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn advertised(home: &Path) -> Vec<std::path::PathBuf> {
    let directory = home.join(".moneta-buzz/agent-connections");
    let mut files: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
}

#[test]
fn fresh_agents_find_advertised_sessions_and_drop_stale_ones() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    assert!(!helper(home, None, &["tools"]).status.success());

    // The app's path: `host.spawn` runs the helper with `--launch`, which claims
    // the session and hands it to the bundled helper's `--advertise`.
    let old = server("old", &["solo_list", "solo_create"]);
    let helper_path = env!("CARGO_BIN_EXE_buzz-agent-command");
    stdout(&helper(
        home,
        Some(&connection(&old, "old", false)),
        &["--launch", helper_path, "--advertise"],
    ));
    let [first] = advertised(home).try_into().unwrap();
    let saved = std::fs::read_to_string(&first).unwrap();
    assert!(saved.contains(SESSION));
    assert_eq!(
        std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let directory = first.parent().unwrap();
    assert_eq!(
        std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    std::fs::File::options()
        .write(true)
        .open(&first)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(60))
        .unwrap();

    // A second window advertises a newer session; one that stopped is stale.
    let new = server("new", &["solo_list"]);
    stdout(&helper(
        home,
        Some(&connection(&new, "new", true)),
        &["--advertise"],
    ));
    let stale = directory.join("stale.json");
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    plant(
        &stale,
        connection(&format!("http://{closed}/mcp"), "gone", true),
        0o600,
    );
    std::fs::File::options()
        .write(true)
        .open(&stale)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(60))
        .unwrap();
    // A live server that no longer admits the saved session answers 404.
    let revoked = directory.join("revoked.json");
    plant(&revoked, connection(&old, "revoked", true), 0o600);
    // A file others could have written is never trusted.
    let loose = directory.join("loose.json");
    let other = server("other", &["solo_list"]);
    plant(&loose, connection(&other, "other", true), 0o644);

    let tools: Value = serde_json::from_str(&stdout(&helper(home, None, &["tools"]))).unwrap();
    let names: Vec<_> = tools
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].clone())
        .collect();
    assert_eq!(names, [json!("solo_list"), json!("solo_create")]);
    assert!(!stale.exists() && !revoked.exists() && loose.exists());
    assert_eq!(advertised(home).len(), 3);

    // An oldest server that would accept and never answer is not asked about a
    // tool a newer server already offers.
    let stalled = TcpListener::bind("127.0.0.1:0").unwrap();
    stalled.set_nonblocking(true).unwrap();
    let silent = directory.join("stalled.json");
    plant(
        &silent,
        connection(
            &format!("http://{}/mcp", stalled.local_addr().unwrap()),
            "stalled",
            true,
        ),
        0o600,
    );
    std::fs::File::options()
        .write(true)
        .open(&silent)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(120))
        .unwrap();

    // Newest window first; a tool only the older one offers still reaches it.
    assert_eq!(
        stdout(&helper(home, None, &["solo_list", "--text", "hi"])),
        "new \"solo_list\" {\"text\":\"hi\"}\n"
    );
    assert_eq!(
        stdout(&helper(
            home,
            None,
            &["call", "solo_create", "{\"text\":\"x\"}"]
        )),
        "old \"solo_create\" {\"text\":\"x\"}\n"
    );
    assert_eq!(
        stalled.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    std::fs::remove_file(silent).unwrap();

    // An inherited session still wins over advertisements.
    let own = server("own", &["solo_list"]);
    assert_eq!(
        stdout(&helper(
            home,
            Some(&connection(&own, "own", true)),
            &["solo_list", "--text", "a"]
        )),
        "own \"solo_list\" {\"text\":\"a\"}\n"
    );
    // Advertising needs an app-held session, never a bare token.
    assert!(!helper(
        home,
        Some(&connection(&own, "own", false)),
        &["--advertise"]
    )
    .status
    .success());
    assert!(!helper(home, None, &["--advertise"]).status.success());

    // A server whose side of the connection no process of this user holds, as when
    // another user's process takes a closed server's port, never receives the saved
    // credentials, and its advertisement stays. Here nothing accepts the connection.
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    for file in advertised(home) {
        std::fs::remove_file(file).unwrap();
    }
    let advertisement = directory.join("taken.json");
    plant(
        &advertisement,
        connection(&format!("http://127.0.0.1:{port}/mcp"), "new", true),
        0o600,
    );
    let output = helper(home, None, &["tools"]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("Could not confirm"));
    assert!(advertisement.exists());
    let (mut stream, _) = taken.accept().unwrap();
    let mut received = Vec::new();
    stream.read_to_end(&mut received).unwrap();
    assert!(received.is_empty());
}

/// An agent whose own sandbox blocks loopback sees why, and leaves the
/// advertisement for agents that can reach it.
#[test]
#[cfg(target_os = "macos")]
fn a_sandbox_denied_connection_keeps_the_advertisement() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let live = server("live", &["solo_list"]);
    stdout(&helper(
        home,
        Some(&connection(&live, "live", true)),
        &["--advertise"],
    ));
    let denied = Command::new("/usr/bin/sandbox-exec")
        .args([
            "-p",
            "(version 1)(allow default)(deny network-outbound)",
            env!("CARGO_BIN_EXE_buzz-agent-command"),
            "tools",
        ])
        .env("HOME", home)
        .env_remove("BUZZ_AGENT_CONNECTION")
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(!String::from_utf8_lossy(&denied.stderr).contains("No running Buzz"));
    assert_eq!(advertised(home).len(), 1);
    assert!(stdout(&helper(home, None, &["tools"])).contains("solo_list"));
}

#[test]
fn help_names_the_path_an_outside_agent_runs() {
    let home = tempfile::tempdir().unwrap();
    let usage = stdout(&helper(home.path(), None, &["--help"]));
    let path = env!("CARGO_BIN_EXE_buzz-agent-command");
    assert!(usage.contains(&format!("{path} tools")), "{usage}");
}

// The shell stands in for Buzz's process owner. The helper is a group leader,
// exactly as the native host starts it, while the loop creates a descendant.
struct RunningCommand {
    host: std::process::Child,
    group: i32,
    child: i32,
}
impl Drop for RunningCommand {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
        let _ = self.host.kill();
        let _ = self.host.wait();
    }
}
fn running_command(home: &Path, connection: &str, label: &str) -> RunningCommand {
    running_script(home, connection, label, "sleep 600 & echo \"$$ $!\"; wait")
}
fn running_script(home: &Path, connection: &str, label: &str, script: &str) -> RunningCommand {
    use std::process::Stdio;
    let mut host = Command::new("/bin/bash")
        .args([
            "-c",
            "set -m; \"$@\" & wait",
            "buzz-host",
            env!("CARGO_BIN_EXE_buzz-agent-command"),
            "--launch",
            "/bin/sh",
            "-c",
            script,
        ])
        .env("HOME", home)
        .env("BUZZ_AGENT_CONNECTION", connection)
        .env("BUZZ_ATTENTION_COMMAND", label)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(host.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let ids: Vec<i32> = line
        .split_whitespace()
        .map(|id| id.parse().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "command never started: {line}");
    // Its direct child is the helper; get it without assuming a scheduling delay.
    let output = Command::new("pgrep")
        .args(["-P", &host.id().to_string()])
        .output()
        .unwrap();
    let group = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    RunningCommand {
        host,
        group,
        child: ids[1],
    }
}
fn alive(pid: i32) -> bool {
    // A zombie has stopped executing but awaits its new parent's reap.
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .any(|state| !state.starts_with('Z'))
}
fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !condition() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}
#[test]
fn command_tree_exits_when_its_host_dies() {
    let home = tempfile::tempdir().unwrap();
    let connection = connection(&server("lifetime", &[]), "lifetime", false);
    let mut running = running_command(home.path(), &connection, "agent/watch");
    running.host.kill().unwrap();
    running.host.wait().unwrap();
    assert!(
        wait_until(|| !alive(running.group) && !alive(running.child)),
        "orphaned helper {} or descendant {} survived its host",
        running.group,
        running.child
    );
}
#[test]
fn a_second_build_waits_then_takes_over_the_attention_source() {
    use std::process::Stdio;
    let home = tempfile::tempdir().unwrap();
    let connection = connection(&server("singleton", &[]), "singleton", false);
    let mut first = running_command(home.path(), &connection, "agent/watch");
    let second_binary = home.path().join("other-build");
    // A parallel test's fork can retain fs::copy's writable descriptor until exec,
    // causing ETXTBSY here. Keep the writer in a separate process and wait for exit.
    assert!(Command::new("cp")
        .arg(env!("CARGO_BIN_EXE_buzz-agent-command"))
        .arg(&second_binary)
        .status()
        .unwrap()
        .success());
    let marker = home.path().join("duplicate-executed");
    let mut second = Command::new(&second_binary)
        .args(["--launch", "/usr/bin/touch", marker.to_str().unwrap()])
        .env("HOME", home.path())
        .env("BUZZ_AGENT_CONNECTION", &connection)
        .env("BUZZ_ATTENTION_COMMAND", "agent/watch")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut waiting = String::new();
    BufReader::new(second.stderr.take().unwrap())
        .read_line(&mut waiting)
        .unwrap();
    assert!(
        waiting.contains("Waiting for another Buzz copy"),
        "{waiting}"
    );
    assert!(
        second.try_wait().unwrap().is_none(),
        "takeover exited instead of waiting"
    );
    assert!(!marker.exists(), "both builds executed the source");
    // A different saved source is independent while the takeover waits.
    assert!(Command::new(&second_binary)
        .args(["--launch", "/usr/bin/true"])
        .env("HOME", home.path())
        .env("BUZZ_AGENT_CONNECTION", &connection)
        .env("BUZZ_ATTENTION_COMMAND", "agent/other-watch")
        .process_group(0)
        .status()
        .unwrap()
        .success());
    first.host.kill().unwrap();
    first.host.wait().unwrap();
    assert!(wait_until(|| !alive(first.group) && !alive(first.child)));
    assert!(wait_until(|| second.try_wait().unwrap().is_some()));
    assert!(second.wait().unwrap().success());
    assert!(marker.exists(), "waiting build did not take over");
    // Dead owners leave a reusable lock file, never a permanently stale lease.
    assert!(Command::new(&second_binary)
        .args(["--launch", "/usr/bin/true"])
        .env("HOME", home.path())
        .env("BUZZ_AGENT_CONNECTION", &connection)
        .env("BUZZ_ATTENTION_COMMAND", "agent/watch")
        .process_group(0)
        .status()
        .unwrap()
        .success());
}

#[test]
fn a_waiting_command_exits_when_its_host_dies() {
    use std::process::Stdio;
    let home = tempfile::tempdir().unwrap();
    let connection = connection(&server("waiting", &[]), "waiting", false);
    let first = running_command(home.path(), &connection, "agent/watch");
    let marker = home.path().join("waiting-command-executed");
    let mut host = Command::new("/bin/bash")
        .args([
            "-c",
            "set -m; \"$@\" & wait",
            "buzz-host",
            env!("CARGO_BIN_EXE_buzz-agent-command"),
            "--launch",
            "/usr/bin/touch",
            marker.to_str().unwrap(),
        ])
        .env("HOME", home.path())
        .env("BUZZ_AGENT_CONNECTION", &connection)
        .env("BUZZ_ATTENTION_COMMAND", "agent/watch")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut waiting = String::new();
    BufReader::new(host.stderr.take().unwrap())
        .read_line(&mut waiting)
        .unwrap();
    assert!(
        waiting.contains("Waiting for another Buzz copy"),
        "{waiting}"
    );
    let output = Command::new("pgrep")
        .args(["-P", &host.id().to_string()])
        .output()
        .unwrap();
    let group: i32 = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    host.kill().unwrap();
    host.wait().unwrap();
    let stopped = wait_until(|| !alive(group));
    if !stopped {
        unsafe { libc::kill(-group, libc::SIGKILL) };
    }
    assert!(stopped, "waiting helper survived its host");
    assert!(
        alive(first.group),
        "waiting copy stopped the existing owner"
    );
    assert!(!marker.exists(), "waiting command executed");
}

#[test]
fn a_command_retains_the_lease_after_its_helper_is_terminated() {
    use std::process::Stdio;
    let home = tempfile::tempdir().unwrap();
    let connection = connection(&server("terminating", &[]), "terminating", false);
    let first = running_script(
        home.path(),
        &connection,
        "agent/watch",
        "trap '' TERM; sleep 600 & echo \"$$ $!\"; wait",
    );
    unsafe { libc::kill(-first.group, libc::SIGTERM) };
    assert!(wait_until(|| !alive(first.group)));
    assert!(alive(first.child), "command did not resist termination");
    let marker = home.path().join("replacement-executed");
    let mut second = Command::new(env!("CARGO_BIN_EXE_buzz-agent-command"))
        .args(["--launch", "/usr/bin/touch", marker.to_str().unwrap()])
        .env("HOME", home.path())
        .env("BUZZ_AGENT_CONNECTION", &connection)
        .env("BUZZ_ATTENTION_COMMAND", "agent/watch")
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut waiting = String::new();
    BufReader::new(second.stderr.take().unwrap())
        .read_line(&mut waiting)
        .unwrap();
    assert!(
        waiting.contains("Waiting for another Buzz copy"),
        "replacement started while the previous command was alive: {waiting}"
    );
    assert!(!marker.exists());
    unsafe { libc::kill(-first.group, libc::SIGKILL) };
    assert!(wait_until(|| second.try_wait().unwrap().is_some()));
    assert!(second.wait().unwrap().success());
    assert!(marker.exists());
}
