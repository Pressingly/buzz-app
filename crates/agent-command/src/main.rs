//! One initialized app-held MCP session, inherited by a command and its children.
//! No relay credentials or owner-identity fallback. A plugin may also advertise
//! one of its sessions to the user's other local agents with `--advertise`; they
//! run this helper without an inherited session and it finds the advertisement.
#[cfg(unix)]
mod lifetime;

use http_body_util::{BodyExt, Full};
use hyper::{
    body::Bytes,
    header::{HeaderMap, HeaderName, ACCEPT, CONTENT_TYPE, HOST},
    StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::{net::TcpStream, time::Instant};
use url::{Position, Url};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const CONNECTION: &str = "BUZZ_AGENT_CONNECTION";
const PROTOCOL: &str = "2025-06-18";

#[derive(Deserialize, Serialize)]
struct Connection {
    url: String,
    headers: Vec<Header>,
}
#[derive(Deserialize, Serialize)]
struct Header {
    name: String,
    value: String,
}
struct Session {
    url: Url,
    headers: HeaderMap,
    /// Read from an advertisement, so its server may have closed since and its port
    /// may now belong to another user's process.
    advertised: bool,
}
/// The server refused the request.
#[derive(Debug)]
struct Status(StatusCode);
impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "Buzz answered {}", self.0)
    }
}
impl std::error::Error for Status {}
impl Session {
    fn open(connection: Connection) -> Result<Self> {
        let url = Url::parse(&connection.url)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("An app-held loopback connection is required".into());
        }
        let mut headers = HeaderMap::new();
        for header in connection.headers {
            headers.insert(
                HeaderName::from_bytes(header.name.as_bytes())?,
                header.value.parse()?,
            );
        }
        Ok(Self {
            url,
            headers,
            advertised: false,
        })
    }
    async fn rpc(&mut self, method: &str, params: Value, notify: bool) -> Result<Value> {
        let mut body = json!({"jsonrpc":"2.0", "method":method, "params":params});
        if !notify {
            body["id"] = json!(1);
        }
        let mut request =
            hyper::Request::post(&self.url[Position::BeforePath..Position::AfterQuery])
                .header(HOST, &self.url[Position::BeforeHost..Position::AfterPort])
                .header(CONTENT_TYPE, "application/json")
                .header(ACCEPT, "application/json, text/event-stream")
                .body(Full::new(Bytes::from(serde_json::to_vec(&body)?)))?;
        request.headers_mut().extend(self.headers.clone());
        let bytes = tokio::time::timeout(Duration::from_secs(60), async {
            let stream = self.connect().await?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await?;
            tokio::spawn(connection);
            let response = sender.send_request(request).await?;
            if !response.status().is_success() {
                return Err(Status(response.status()).into());
            }
            if let Some(session) = response.headers().get("mcp-session-id") {
                self.headers.insert("mcp-session-id", session.clone());
                self.headers
                    .insert("mcp-protocol-version", PROTOCOL.parse()?);
            }
            Ok::<_, Box<dyn std::error::Error>>(response.into_body().collect().await?.to_bytes())
        })
        .await
        .map_err(|_| "Buzz did not answer within a minute")??;
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        let reply: Value = serde_json::from_slice(&bytes)?;
        if let Some(error) = reply.get("error") {
            return Err(error.to_string().into());
        }
        Ok(reply.get("result").cloned().ok_or("Missing MCP result")?)
    }
    /// Connects to the server. An advertised one gets nothing, not even a request
    /// line, until this user's process is shown to hold the server's side of this
    /// very connection; the host takes one request per connection.
    async fn connect(&self) -> Result<TcpStream> {
        let port = self.url.port_or_known_default().ok_or("No port")?;
        let stream = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).await?;
        if self.advertised {
            let client = stream.local_addr()?.port();
            // The server's side has an owning process only once the server accepts it.
            let deadline = Instant::now() + Duration::from_secs(1);
            while !serves_this_user(port, client).await? {
                if Instant::now() >= deadline {
                    return Err(
                        "Could not confirm that this user's Buzz serves an advertised port".into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        Ok(stream)
    }
    fn connection(&self) -> Result<String> {
        Ok(serde_json::to_string(&Connection {
            url: self.url.to_string(),
            headers: self
                .headers
                .iter()
                .map(|(name, value)| {
                    Ok(Header {
                        name: name.to_string(),
                        value: value.to_str()?.to_owned(),
                    })
                })
                .collect::<Result<_>>()?,
        })?)
    }
    async fn launch(&mut self, args: &[String]) -> Result<i32> {
        let (program, args) = args.split_first().ok_or("A command is required")?;
        self.rpc(
            "initialize",
            json!({"protocolVersion":PROTOCOL,"capabilities":{},
            "clientInfo":{"name":"buzz-agent-command","version":"1"}}),
            false,
        )
        .await?;
        if !self.headers.contains_key("mcp-session-id") {
            return Err("The agent connection did not provide a session".into());
        }
        self.rpc("notifications/initialized", json!({}), true)
            .await?;
        // The copy is this small CLI, never the GUI or another installed `buzz`.
        // Its directory lives until the whole command exits.
        let directory = tempfile::tempdir()?;
        let buzz = directory
            .path()
            .join(if cfg!(windows) { "buzz.exe" } else { "buzz" });
        std::fs::copy(std::env::current_exe()?, &buzz)?;
        let paths = std::iter::once(directory.path().to_path_buf()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .collect::<Vec<_>>(),
        );
        let status = Command::new(program)
            .args(args)
            .env(CONNECTION, self.connection()?)
            .env("PATH", std::env::join_paths(paths)?)
            .status()?;
        Ok(status.code().unwrap_or(1))
    }
    async fn call(mut self, args: &[String]) -> Result<i32> {
        if !self.headers.contains_key("mcp-session-id") {
            return Err("Run buzz inside an agent command".into());
        }
        let tools = self.rpc("tools/list", json!({}), false).await?;
        run(vec![(self, tools)], args).await
    }
}
/// Lists or calls the tools of `live` sessions, newest first; a name the newest
/// offers wins over the same name in another Buzz window.
async fn run(mut live: Vec<(Session, Value)>, args: &[String]) -> Result<i32> {
    let mut names = HashSet::new();
    let catalog: Vec<Value> = live
        .iter()
        .flat_map(|(_, tools)| tools["tools"].as_array().cloned().unwrap_or_default())
        .filter(|tool| names.insert(tool["name"].to_string()))
        .collect();
    if args == ["tools"] {
        println!("{}", Value::Array(catalog));
        return Ok(0);
    }
    let (name, arguments) = arguments(args, &json!({ "tools": catalog }))?;
    let (session, _) = live
        .iter_mut()
        .find(|(_, tools)| offers(tools, &name))
        .ok_or("Unknown agent tool")?;
    let result = session
        .rpc(
            "tools/call",
            json!({"name":name,"arguments":arguments}),
            false,
        )
        .await?;
    if let Some(content) = result["content"].as_array() {
        for block in content {
            if let Some(text) = block["text"].as_str() {
                println!("{text}");
            }
        }
    }
    Ok(i32::from(result["isError"] == true))
}
fn offers(tools: &Value, name: &str) -> bool {
    tools["tools"]
        .as_array()
        .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == name))
}

/// Same-user-private advertisements: the user's own agents may use them, other
/// users may not, and nothing here is an account key.
fn advertisements() -> Result<PathBuf> {
    private_directory("agent-connections")
}
fn private_directory(name: &str) -> Result<PathBuf> {
    let home = std::env::home_dir().ok_or("No home directory")?;
    let directory = home.join(".moneta-buzz").join(name);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        builder.mode(0o700);
        builder.create(&directory)?;
        let metadata = std::fs::symlink_metadata(&directory)?;
        if !metadata.is_dir() || metadata.uid() != std::fs::metadata(&home)?.uid() {
            return Err("The agent connection directory is not private".into());
        }
        if metadata.mode() & 0o077 != 0 {
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    #[cfg(not(unix))]
    builder.create(&directory)?;
    Ok(directory)
}
/// Publishes this inherited, already-initialized session; it lasts as long as the
/// plugin's server, and callers drop it once that stops answering.
fn advertise(connection: &str) -> Result<i32> {
    let session = Session::open(serde_json::from_str(connection)?)?;
    if !session.headers.contains_key("mcp-session-id") {
        return Err("Advertise an app-held session from inside an agent command".into());
    }
    let directory = advertisements()?;
    // Written whole under a dot name, then renamed, so readers never see part of it.
    let mut file = tempfile::Builder::new()
        .prefix(".")
        .rand_bytes(16)
        .tempfile_in(&directory)?;
    file.write_all(session.connection()?.as_bytes())?;
    let name = file
        .path()
        .file_name()
        .ok_or("No file name")?
        .to_string_lossy()[1..]
        .to_owned();
    file.persist(directory.join(format!("{name}.json")))?;
    Ok(0)
}
/// Sessions plugins advertised that still answer, newest first, up to the first
/// that offers `wanted`. One whose server is gone is removed: a later server
/// never accepts its token.
async fn discovered(wanted: Option<&str>) -> Result<Vec<(Session, Value)>> {
    let directory = advertisements()?;
    #[cfg(unix)]
    let owner = std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(&directory)?);
    // Another caller may prune a file while this one lists them.
    let mut files: Vec<_> = std::fs::read_dir(directory)?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                // A directory once open to others may still hold their files.
                if metadata.uid() != owner || metadata.mode() & 0o077 != 0 {
                    return None;
                }
            }
            let name = path.file_name()?.to_str()?;
            (metadata.is_file() && name.ends_with(".json") && !name.starts_with('.'))
                .then_some((metadata.modified().ok()?, path))
        })
        .collect();
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let (mut live, mut unreachable) = (Vec::new(), None);
    for (_, path) in files {
        let Some(mut session) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .and_then(|connection| Session::open(connection).ok())
            .filter(|session| session.headers.contains_key("mcp-session-id"))
        else {
            continue;
        };
        session.advertised = true;
        match session.rpc("tools/list", json!({}), false).await {
            Ok(tools) => {
                // Older servers cannot win the call, so a stalled one need not delay it.
                let found = wanted.is_some_and(|name| offers(&tools, name));
                live.push((session, tools));
                if found {
                    break;
                }
            }
            Err(error) if gone(error.as_ref()) => {
                let _ = std::fs::remove_file(&path);
            }
            Err(error) => {
                let cause = std::iter::successors(Some(error.as_ref()), |error| error.source());
                unreachable = Some(format!(
                    "Could not reach Buzz: {}",
                    cause.last().unwrap_or(&*error)
                ));
            }
        }
    }
    if live.is_empty() {
        return Err(unreachable
            .unwrap_or_else(|| "No running Buzz offers agent tools to this user's agents".into())
            .into());
    }
    Ok(live)
}
/// Whether a process of this account holds the server's side of the loopback
/// connection from `client` to `server`. Missing, partial, or failed evidence is no.
#[cfg(target_os = "macos")]
async fn serves_this_user(server: u16, client: u16) -> Result<bool> {
    // lsof may list every user's files, so the selection names this account's UID and
    // the answer is checked against it too.
    let uid = unsafe { libc::geteuid() };
    let mut lsof = tokio::process::Command::new("/usr/sbin/lsof")
        .args([
            "-a",
            "-u",
            &uid.to_string(),
            "-nP",
            "-w",
            "-sTCP:ESTABLISHED",
            "-Fpun",
        ])
        .arg(format!("-iTCP@127.0.0.1:{client}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not check the advertised server: {error}"))?;
    let mut stdout = lsof.stdout.take().ok_or("No lsof output")?;
    let mut output = Vec::new();
    let finished = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut output).await?;
        lsof.wait().await
    })
    .await;
    let Ok(status) = finished else {
        let _ = lsof.kill().await;
        return Ok(false);
    };
    Ok(status?.success() && lsof_shows(&String::from_utf8_lossy(&output), uid, server, client))
}
#[cfg(target_os = "linux")]
async fn serves_this_user(server: u16, client: u16) -> Result<bool> {
    let table = std::fs::read_to_string("/proc/net/tcp")
        .map_err(|error| format!("Could not check the advertised server: {error}"))?;
    Ok(proc_shows(
        &table,
        unsafe { libc::geteuid() },
        server,
        client,
    ))
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn serves_this_user(_: u16, _: u16) -> Result<bool> {
    Err("Advertised sessions are not supported on this platform".into())
}
/// lsof `-F pun` output in which every process is `uid`'s and one holds the server's
/// side: local `server`, remote `client`.
#[cfg(any(target_os = "macos", test))]
fn lsof_shows(output: &str, uid: u32, server: u16, client: u16) -> bool {
    let side = format!("n127.0.0.1:{server}->127.0.0.1:{client}");
    let (mut owner, mut found) = (false, false);
    for line in output.lines() {
        if line.starts_with('p') {
            owner = false;
        } else if let Some(id) = line.strip_prefix('u') {
            if id.parse() != Ok(uid) {
                return false;
            }
            owner = true;
        } else if line == side {
            if !owner {
                return false;
            }
            found = true;
        }
    }
    found
}
/// A `/proc/net/tcp` row for the server's side, established and owned by `uid`.
/// Until accepted it has no inode and an unrelated UID, such as the overflow UID.
#[cfg(any(target_os = "linux", test))]
fn proc_shows(table: &str, uid: u32, server: u16, client: u16) -> bool {
    let loopback = format!("{:08X}", u32::from_ne_bytes([127, 0, 0, 1]));
    let (local, remote) = (
        format!("{loopback}:{server:04X}"),
        format!("{loopback}:{client:04X}"),
    );
    table.lines().skip(1).any(|row| {
        let fields: Vec<_> = row.split_whitespace().collect();
        fields.get(1) == Some(&local.as_str())
            && fields.get(2) == Some(&remote.as_str())
            && fields.get(3) == Some(&"01")
            && fields.get(7).and_then(|id| id.parse().ok()) == Some(uid)
            && fields.get(9).is_some_and(|inode| *inode != "0")
    })
}
/// Nothing listens on the server's port, or it no longer admits the session. A
/// connection the caller's own sandbox denied proves neither, so its file stays.
fn gone(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<Status>()
        .is_some_and(|status| status.0 == StatusCode::NOT_FOUND)
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::ConnectionRefused)
}
fn arguments(args: &[String], catalog: &Value) -> Result<(String, Value)> {
    let explicit = args.first().is_some_and(|arg| arg == "call");
    let (name, rest) = args[usize::from(explicit)..]
        .split_first()
        .ok_or("Name a tool; --help shows the usage")?;
    let tool = catalog["tools"]
        .as_array()
        .and_then(|tools| tools.iter().find(|tool| tool["name"] == name.as_str()))
        .ok_or(
            "Unknown agent tool. This is the agent MCP helper; run buzz tools to list commands",
        )?;
    let arguments = if explicit {
        if rest.len() != 1 {
            return Err("Expected one JSON object".into());
        }
        let value: Value = serde_json::from_str(&rest[0])?;
        if !value.is_object() {
            return Err("Tool arguments must be a JSON object".into());
        }
        value
    } else {
        if rest.len() % 2 != 0 {
            return Err("Expected --field value pairs".into());
        }
        let mut values = HashMap::new();
        for pair in rest.as_chunks::<2>().0 {
            let key = pair[0]
                .strip_prefix("--")
                .ok_or("Expected --field value")?
                .replace('-', "_");
            let field = tool["inputSchema"]["properties"]
                .get(&key)
                .ok_or("Unknown tool field")?;
            let value = if field["type"] == "string" {
                json!(pair[1])
            } else {
                serde_json::from_str(&pair[1])?
            };
            values.insert(key, value);
        }
        serde_json::to_value(values)?
    };
    Ok((name.clone(), arguments))
}
fn main() {
    let result = (|| -> Result<i32> {
        let args: Vec<_> = std::env::args().collect();
        #[cfg(unix)]
        let _lifetime = if args.get(1).is_some_and(|arg| arg == "--launch") {
            lifetime::watch()?
        } else {
            None
        };
        // App-bundled bootstrap for contained harnesses. Privileged Bash ignores
        // startup files and imported functions; its path never comes from PATH.
        #[cfg(unix)]
        if args.get(1).is_some_and(|arg| arg == "--shell") {
            use std::os::unix::process::CommandExt;
            return Err(Command::new("/bin/bash")
                .args(["-p", "-c"])
                .args(&args[2..])
                .exec()
                .into());
        }

        let inherited = std::env::var(CONNECTION).ok();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let required = || {
            inherited
                .as_deref()
                .ok_or("An app-held agent connection is required")
        };
        let buzz = Path::new(&args[0]).file_stem().and_then(|s| s.to_str()) == Some("buzz");
        match args.get(1).map(String::as_str) {
            Some("--launch") if !buzz => runtime
                .block_on(Session::open(serde_json::from_str(required()?)?)?.launch(&args[2..])),
            Some("--advertise") if !buzz => advertise(required()?),
            Some("--help" | "-h") | None => {
                // An agent outside a command has no `buzz` alias; it keeps using this path.
                let program = if buzz {
                    "buzz".to_owned()
                } else if args[0].contains(char::is_whitespace) {
                    format!("'{}'", args[0])
                } else {
                    args[0].clone()
                };
                println!(
                    "Usage: {program} tools | {program} <tool> --field value | {program} call <tool> '<JSON object>'"
                );
                Ok(0)
            }
            _ => match &inherited {
                Some(connection) => runtime
                    .block_on(Session::open(serde_json::from_str(connection)?)?.call(&args[1..])),
                None => {
                    let args = &args[1..];
                    let wanted = if args == ["tools"] {
                        None
                    } else {
                        args.get(usize::from(args[0] == "call"))
                    };
                    runtime.block_on(async {
                        run(discovered(wanted.map(String::as_str)).await?, args).await
                    })
                }
            },
        }
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Buzz agent command: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_non_app_endpoints() {
        for url in [
            "https://example.com/mcp",
            "http://localhost:1234/mcp",
            "http://user@127.0.0.1:1234/mcp",
        ] {
            assert!(Session::open(Connection {
                url: url.into(),
                headers: vec![]
            })
            .is_err());
        }
    }
    #[test]
    fn parses_live_tool_fields_and_refuses_unknown_tools() {
        let tools = json!({"tools":[{"name":"mem_set","inputSchema":{"properties":{"text":{"type":"string"},"count":{"type":"number"}}}}]});
        let args = ["mem_set", "--text", "hello", "--count", "3"].map(str::to_owned);
        assert_eq!(
            arguments(&args, &tools).unwrap(),
            ("mem_set".into(), json!({"text":"hello","count":3}))
        );
        assert!(arguments(&["owner-secret".into()], &tools).is_err());
        assert!(arguments(&["call".into(), "mem_set".into(), "[]".into()], &tools).is_err());
    }
    #[test]
    fn trusts_only_this_users_side_of_the_server() {
        let ours = "n127.0.0.1:2001->127.0.0.1:2000";
        let theirs = "n127.0.0.1:2000->127.0.0.1:2001";
        let shows = |output: &str| lsof_shows(output, 501, 2000, 2001);
        assert!(shows(&format!(
            "p9\nu501\nf4\n{ours}\np10\nu501\nf5\n{theirs}\n"
        )));
        // Before the server accepts, only the caller's own side is listed.
        assert!(!shows(&format!("p9\nu501\nf4\n{ours}\n")));
        assert!(!shows(&format!("p10\nu502\nf5\n{theirs}\n")));
        assert!(!shows(&format!(
            "p9\nu501\nf4\n{ours}\np10\nu0\nf5\n{theirs}\n"
        )));
        assert!(!shows(&format!("p10\nf5\n{theirs}\n")));
        assert!(!shows(&format!("{theirs}\n")));
        assert!(!shows(""));

        let loopback = format!("{:08X}", u32::from_ne_bytes([127, 0, 0, 1]));
        let row = |local: u16, remote: u16, state: &str, uid: u32| {
            format!("   0: {loopback}:{local:04X} {loopback}:{remote:04X} {state} 0:0 0:0 0 {uid} 0 7\n")
        };
        let shows = |rows: &[String]| {
            proc_shows(
                &format!("  sl  local_address\n{}", rows.concat()),
                501,
                2000,
                2001,
            )
        };
        assert!(shows(&[
            row(2001, 2000, "01", 501),
            row(2000, 2001, "01", 501)
        ]));
        assert!(!shows(&[row(2001, 2000, "01", 501)]));
        assert!(!shows(&[row(2000, 2001, "01", 502)]));
        assert!(!shows(&[row(2000, 2001, "08", 501)]));
        assert!(!shows(&[row(2000, 0, "0A", 501)]));
        let unaccepted = row(2000, 2001, "01", 501).replace(" 7\n", " 0\n");
        assert!(!shows(&[row(2001, 2000, "01", 501), unaccepted]));
    }
}
