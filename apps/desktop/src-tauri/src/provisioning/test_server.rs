//! テスト用の Hugging Face もどき (tree API と resolve の Range 取得)。
//! 1接続1リクエスト (Connection: close) の最小実装。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha1::Digest;

pub const REPO: &str = "org/model";
pub const REVISION: &str = "1111111111111111111111111111111111111111";

/// resolve への応答の仕方 (1リクエストごとに先頭から使う。空なら通常)
#[derive(Debug, Clone, Copy)]
pub enum Behavior {
    /// 指定バイト数だけ送って切断する (Content-Length は全体)
    Cut(usize),
    /// このステータスで失敗する
    Fail(u16),
    /// Range を無視して 200 で全体を返す
    IgnoreRange,
    /// 要求と違う位置から 206 で返す (Content-Range もその位置)
    WrongRange(u64),
}

#[derive(Clone)]
pub struct File {
    pub path: String,
    pub content: Vec<u8>,
    pub lfs: bool,
}

/// REPO@REVISION 以外のリポジトリ・revision (モデルの管理のテスト用)
pub struct Repo {
    pub repo: String,
    pub revision: String,
    pub files: Vec<File>,
}

#[derive(Default)]
pub struct State {
    /// REPO@REVISION のファイル
    pub files: Vec<File>,
    pub other_repos: Vec<Repo>,
    pub script: VecDeque<Behavior>,
    /// 1KiB ごとの待ち (一時停止のテスト用)
    pub throttle: Option<Duration>,
    /// 内容を壊して送る (ハッシュ不一致のテスト用)
    pub corrupt: bool,
    /// resolve へのリクエストの記録 (パス, Range の開始)
    pub requests: Vec<(String, Option<u64>)>,
}

pub struct MockHf {
    pub endpoint: String,
    pub state: Arc<Mutex<State>>,
}

impl MockHf {
    pub fn start(files: Vec<File>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            files,
            ..State::default()
        }));
        let st = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let st = st.clone();
                std::thread::spawn(move || {
                    let _ = handle(stream, &st);
                });
            }
        });
        Self { endpoint, state }
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

pub fn git_oid(content: &[u8]) -> String {
    let mut h = sha1::Sha1::new();
    h.update(format!("blob {}\0", content.len()).as_bytes());
    h.update(content);
    hex::encode(h.finalize())
}

pub fn sha256(content: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(content))
}

fn tree_json(files: &[File]) -> String {
    let mut entries: Vec<serde_json::Value> = files
        .iter()
        .map(|f| {
            if f.lfs {
                serde_json::json!({
                    "type": "file", "oid": git_oid(b"pointer"), "size": f.content.len(),
                    "path": f.path,
                    "lfs": { "oid": sha256(&f.content), "size": f.content.len(), "pointerSize": 130 }
                })
            } else {
                serde_json::json!({
                    "type": "file", "oid": git_oid(&f.content), "size": f.content.len(), "path": f.path
                })
            }
        })
        .collect();
    // 取得対象外のもの
    entries.push(
        serde_json::json!({"type": "file", "oid": git_oid(b"r"), "size": 1, "path": "README.md"}),
    );
    entries.push(
        serde_json::json!({"type": "directory", "oid": git_oid(b"d"), "size": 0, "path": "sub"}),
    );
    serde_json::Value::Array(entries).to_string()
}

fn handle(stream: TcpStream, st: &Arc<Mutex<State>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut range = None;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some(v) = h
            .to_ascii_lowercase()
            .strip_prefix("range: bytes=")
            .map(str::to_string)
        {
            range = v.trim_end_matches('-').parse::<u64>().ok();
        }
    }
    let mut out = stream;
    // (repo, revision) → 何番目か (None = REPO@REVISION)
    let repos: Vec<(String, String, Option<usize>)> = {
        let s = st.lock().unwrap();
        std::iter::once((REPO.to_string(), REVISION.to_string(), None))
            .chain(
                s.other_repos
                    .iter()
                    .enumerate()
                    .map(|(i, r)| (r.repo.clone(), r.revision.clone(), Some(i))),
            )
            .collect()
    };
    let files_of = |s: &State, i: Option<usize>| -> Vec<File> {
        let files = match i {
            None => &s.files,
            Some(i) => &s.other_repos[i].files,
        };
        files.clone()
    };
    for (repo, rev, i) in &repos {
        if path.starts_with(&format!("/api/models/{repo}/tree/{rev}")) {
            let body = tree_json(&files_of(&st.lock().unwrap(), *i));
            return respond(&mut out, 200, &[], body.as_bytes());
        }
    }
    let Some((file, index)) = repos.iter().find_map(|(repo, rev, i)| {
        path.strip_prefix(&format!("/{repo}/resolve/{rev}/"))
            .map(|f| (f.to_string(), *i))
    }) else {
        return respond(&mut out, 404, &[], b"not found");
    };
    let file = file.as_str();
    let (content, behavior, throttle) = {
        let mut s = st.lock().unwrap();
        s.requests.push((file.to_string(), range));
        let files = files_of(&s, index);
        let Some(f) = files.iter().find(|f| f.path == file) else {
            drop(s);
            return respond(&mut out, 404, &[], b"not found");
        };
        let mut content = f.content.clone();
        if s.corrupt {
            content[0] ^= 0xff;
        }
        let b = s.script.pop_front();
        (content, b, s.throttle)
    };
    if let Some(Behavior::Fail(code)) = behavior {
        return respond(&mut out, code, &[], b"error");
    }
    let total = content.len() as u64;
    let (range, start) = match behavior {
        Some(Behavior::IgnoreRange) => (None, 0),
        Some(Behavior::WrongRange(at)) => (Some(at), at),
        _ => (range, range.unwrap_or(0)),
    };
    if start >= total {
        return respond(&mut out, 416, &[], b"");
    }
    let body = &content[start as usize..];
    let (status, extra) = if range.is_some() {
        (
            206,
            vec![format!(
                "Content-Range: bytes {start}-{}/{total}",
                total - 1
            )],
        )
    } else {
        (200, vec![])
    };
    write_head(&mut out, status, &extra, body.len())?;
    let limit = match behavior {
        Some(Behavior::Cut(n)) => n.min(body.len()),
        _ => body.len(),
    };
    for chunk in body[..limit].chunks(1024) {
        out.write_all(chunk)?;
        out.flush()?;
        if let Some(t) = throttle {
            std::thread::sleep(t);
        }
    }
    Ok(())
}

fn write_head(
    out: &mut TcpStream,
    status: u16,
    extra: &[String],
    len: usize,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} X\r\nContent-Length: {len}\r\nConnection: close\r\n");
    for e in extra {
        head.push_str(e);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())
}

fn respond(out: &mut TcpStream, status: u16, extra: &[String], body: &[u8]) -> std::io::Result<()> {
    write_head(out, status, extra, body.len())?;
    out.write_all(body)
}
