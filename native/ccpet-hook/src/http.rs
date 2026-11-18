//! The one HTTP request the waiter makes: a GET to the pet on loopback, read to the end (the request asks the server to close).

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum Error {
    /** No answer within the time given: the caller asks again. */
    Timeout,
    /** No pet listening, or an answer that is not HTTP. */
    Failed,
}

pub fn get(host: &str, port: u16, path: &str, timeout: Duration) -> Result<Response, Error> {
    let addr = (host, port).to_socket_addrs().map_err(|_| Error::Failed)?.next().ok_or(Error::Failed)?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|_| Error::Failed)?;
    s.set_read_timeout(Some(timeout)).map_err(|_| Error::Failed)?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|_| Error::Failed)?;
    let mut raw = Vec::new();
    if let Err(e) = s.read_to_end(&mut raw) {
        return Err(match e.kind() {
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => Error::Timeout,
            _ => Error::Failed,
        });
    }
    parse(&raw).ok_or(Error::Failed)
}

pub fn parse(raw: &[u8]) -> Option<Response> {
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..head_end]).ok()?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked") { chunked = true; }
        if k == "content-length" { length = v.parse().ok(); }
    }
    let rest = &raw[head_end + 4..];
    let body = if chunked { dechunk(rest)? } else { rest[..length.unwrap_or(rest.len()).min(rest.len())].to_vec() };
    Some(Response { status, body })
}

fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = b.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&b[..line_end]).ok()?.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        b = &b[line_end + 2..];
        if size == 0 { return Some(out); }
        out.extend_from_slice(b.get(..size)?);
        b = b.get(size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_chunked() {
        let r = parse(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, &b"hello"[..]));
        let r = parse(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n").unwrap();
        assert_eq!(r.body, b"hello");
        assert_eq!(parse(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap().status, 204);
    }
}
