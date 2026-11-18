use super::{Request, err, safe};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
};
pub(super) fn canonical(format: &str) -> Option<&'static str> {
    match format {
        "zstd" | "zst" => Some("zstd"),
        "br" | "brotli" => Some("br"),
        "xz" => Some("xz"),
        "bz2" | "bzip2" => Some("bz2"),
        "lzma" => Some("lzma"),
        "lz4" => Some("lz4"),
        "deflate" => Some("deflate"),
        "zlib" => Some("zlib"),
        "gz" | "gzip" => Some("gz"),
        _ => None,
    }
}
fn suffix(format: &str) -> &str {
    match format {
        "zstd" => "zst",
        other => other,
    }
}
pub fn detect(r: &Request) -> Result<Option<&'static str>, String> {
    if let Some(format) = canonical(&r.format) {
        return Ok(Some(format));
    }
    if r.op == "create" {
        return Ok(None);
    }
    let Some(first) = r.paths.first() else {
        return Ok(None);
    };
    let mut input = File::open(first).map_err(err)?;
    let mut magic = [0; 8];
    let n = input.read(&mut magic).map_err(err)?;
    if magic[..n].starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        return Ok(Some("zstd"));
    }
    if magic[..n].starts_with(b"\xfd7zXZ\0") {
        return Ok(Some("xz"));
    }
    if magic[..n].starts_with(b"BZh") {
        return Ok(Some("bz2"));
    }
    if magic[..n].starts_with(&[4, 0x22, 0x4d, 0x18]) {
        return Ok(Some("lz4"));
    }
    if magic[..n].starts_with(&[0x1f, 0x8b]) {
        return Ok(Some("gz"));
    }
    let lower = first.to_lowercase();
    for suffix in [
        "zst", "zstd", "br", "xz", "bz2", "bzip2", "lzma", "lz4", "deflate", "zlib", "gz", "gzip",
    ] {
        if lower.ends_with(&format!(".{suffix}")) {
            return Ok(canonical(suffix));
        }
    }
    Ok(None)
}
struct Limited<W> {
    inner: W,
    written: u64,
    limit: u64,
}
impl<W: Write> Write for Limited<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.limit.saturating_sub(self.written) {
            return Err(io::Error::other("Decoded stream exceeds the output quota"));
        }
        let n = self.inner.write(bytes)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
fn copy(reader: &mut dyn Read, output: &mut dyn Write) -> Result<u64, String> {
    io::copy(reader, output).map_err(err)
}
struct Input<'a>(&'a mut File);
impl lzma_stream::SeqInStream for Input<'_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, lzma_stream::Error> {
        self.0.read(buf).map_err(|_| lzma_stream::Error::Read)
    }
}
struct Output<'a>(&'a mut dyn Write);
impl lzma_stream::SeqOutStream for Output<'_> {
    fn write(&mut self, buf: &[u8]) -> Result<(), lzma_stream::Error> {
        self.0.write_all(buf).map_err(|_| lzma_stream::Error::Write)
    }
}
/// The requested compression level for a stream, or the format's usual one when none was asked for.
fn level(r: &Request, usual: u32, lowest: u32, highest: u32) -> Result<u32, String> {
    match r.level {
        None => Ok(usual),
        Some(level) if (lowest..=highest).contains(&level) => Ok(level),
        Some(_) => Err(format!(
            "Compression level for this stream must be {lowest} to {highest}"
        )),
    }
}
fn props(budget: usize, level: u32) -> lzma_stream::LzmaEncProps {
    lzma_stream::LzmaEncProps::new()
        .with_level(level)
        .with_num_threads(1)
        .with_dict_size((budget / 32).clamp(65536, 4 * 1024 * 1024) as u32)
}
fn encode(r: &Request, format: &str, input: &mut File, out: &mut dyn Write) -> Result<(), String> {
    match format {
        "zstd" => {
            let mut writer =
                zstd::stream::write::Encoder::new(out, level(r, 3, 1, 19)? as i32).map_err(err)?;
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        "br" => {
            let params = brotli::enc::BrotliEncoderParams {
                quality: level(r, 5, 0, 11)? as i32,
                lgwin: 22,
                ..Default::default()
            };
            let mut output = out;
            brotli::BrotliCompress(input, &mut output, &params).map_err(err)?;
        }
        "bz2" => {
            let mut writer = bzip2_turbo::Encoder::new(
                out,
                bzip2_turbo::EncoderOptions {
                    level: level(r, 5, 1, 9)?,
                    ..Default::default()
                },
            );
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        "xz" => {
            let budget = r.memory_budget()?;
            let mut writer =
                lzma_stream::XzWriter::new(out, &props(budget, level(r, 3, 0, 9)?)).map_err(err)?;
            let block = r.block_size.unwrap_or(1024 * 1024);
            if block == 0 || block > budget as u64 / 4 {
                return Err("XZ block size must be nonzero and at most one quarter of the algorithm memory budget".into());
            }
            writer.set_block_size(block);
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        "lzma" => {
            let mut encoder =
                lzma_stream::LzmaEncoder::new(&props(r.memory_budget()?, level(r, 3, 0, 9)?))
                    .map_err(err)?;
            out.write_all(&encoder.properties()).map_err(err)?;
            let len = input.metadata().map_err(err)?.len();
            out.write_all(&len.to_le_bytes()).map_err(err)?;
            encoder
                .encode_sized(&mut Input(input), &mut Output(out), len)
                .map_err(err)?;
        }
        "lz4" => {
            if r.level.is_some() {
                return Err("LZ4 frames have no compression levels".into());
            }
            let mut writer = lz4_flex::frame::FrameEncoder::new(out);
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        "deflate" => {
            let mut writer = flate2::write::DeflateEncoder::new(
                out,
                flate2::Compression::new(level(r, 6, 0, 9)?),
            );
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        "zlib" => {
            let mut writer =
                flate2::write::ZlibEncoder::new(out, flate2::Compression::new(level(r, 6, 0, 9)?));
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        "gz" => {
            let mut writer =
                flate2::write::GzEncoder::new(out, flate2::Compression::new(level(r, 6, 0, 9)?));
            copy(input, &mut writer)?;
            writer.finish().map_err(err)?;
        }
        _ => return Err("Unsupported stream format".into()),
    }
    Ok(())
}
// Validate frame termination independently: the codec reader treats an EOF while
// reading a block-size word as EOF even when the frame's end marker is missing.
fn lz4_frames(input: &mut BufReader<File>, budget: usize) -> Result<Vec<(u64, u64)>, String> {
    let total = input.get_ref().metadata().map_err(err)?.len();
    let mut frames = Vec::new();
    let mut position = 0u64;
    while position < total {
        if total - position < 4 {
            return Err("Trailing bytes after LZ4 frame".into());
        }
        input.seek(SeekFrom::Start(position)).map_err(err)?;
        let start = position;
        let mut word = [0u8; 4];
        input.read_exact(&mut word).map_err(err)?;
        position += 4;
        let magic = u32::from_le_bytes(word);
        if (0x184d2a50..=0x184d2a5f).contains(&magic) {
            input.read_exact(&mut word).map_err(err)?;
            position += 4;
            position = position
                .checked_add(u64::from(u32::from_le_bytes(word)))
                .ok_or("LZ4 skip length overflow")?;
            if position > total {
                return Err("Truncated LZ4 skippable frame".into());
            }
            continue;
        }
        if magic != 0x184d2204 {
            return Err("Invalid LZ4 frame or trailing bytes".into());
        }
        let mut flags = [0u8; 2];
        input.read_exact(&mut flags).map_err(err)?;
        position += 2;
        let flag = flags[0];
        let max_block = match (flags[1] >> 4) & 7 {
            4 => 65536u64,
            5 => 262144,
            6 => 1048576,
            7 => 4194304,
            _ => return Err("Invalid LZ4 block size".into()),
        };
        position += 1 + if flag & 8 != 0 { 8 } else { 0 } + if flag & 1 != 0 { 4 } else { 0 };
        if position > total {
            return Err("Truncated LZ4 frame header".into());
        }
        loop {
            if total - position < 4 {
                return Err("Truncated LZ4 frame: missing block end marker".into());
            }
            input.seek(SeekFrom::Start(position)).map_err(err)?;
            input.read_exact(&mut word).map_err(err)?;
            position += 4;
            let length = u32::from_le_bytes(word);
            if length == 0 {
                if flag & 4 != 0 {
                    position += 4;
                }
                if position > total {
                    return Err("Truncated LZ4 content checksum".into());
                }
                break;
            }
            let bytes = u64::from(length & 0x7fffffff);
            if bytes > max_block {
                return Err("LZ4 block exceeds the declared frame block limit".into());
            }
            position = position
                .checked_add(bytes + if flag & 16 != 0 { 4 } else { 0 })
                .ok_or("LZ4 frame length overflow")?;
            if position > total {
                return Err("Truncated LZ4 block or checksum".into());
            }
        }
        if frames.len() >= budget / 64 {
            return Err("LZ4 frame metadata exceeds the algorithm memory budget".into());
        }
        frames.push((start, position - start));
    }
    if total == 0 {
        return Err("Empty LZ4 input is not a complete frame".into());
    }
    Ok(frames)
}
fn decode(r: &Request, format: &str, input: File, out: &mut dyn Write) -> Result<u64, String> {
    let budget = r.memory_budget()?;
    let mut reader = BufReader::with_capacity(65536, input);
    let bytes = match format {
        "zstd" => {
            let mut decoder = zstd::stream::read::Decoder::with_buffer(&mut reader).map_err(err)?;
            decoder.window_log_max((budget / 2).ilog2()).map_err(err)?;
            copy(&mut decoder, out)?
        }
        "xz" => {
            let mut options = lzma_stream::XzOptions::default();
            options.memory_limit = budget as u64;
            options.max_unpack_bytes = Some(r.max_output);
            copy(
                &mut lzma_stream::XzReader::with_options(&mut reader, options),
                out,
            )?
        }
        "bz2" => copy(&mut bzip2_turbo::Decoder::new(&mut reader), out)?,
        "lz4" => {
            let frames = lz4_frames(&mut reader, budget)?;
            let mut count = 0;
            for (start, length) in frames {
                reader.seek(SeekFrom::Start(start)).map_err(err)?;
                count += copy(
                    &mut lz4_flex::frame::FrameDecoder::new(
                        std::io::Read::by_ref(&mut reader).take(length),
                    ),
                    out,
                )?;
            }
            count
        }
        "lzma" => {
            struct ExactInput<'a>(&'a mut BufReader<File>);
            impl Read for ExactInput<'_> {
                fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                    let take = out.len().min(1);
                    self.0.read(&mut out[..take])
                }
            }
            let mut decoder =
                lzma_stream::LzmaReader::with_memory_limit(ExactInput(&mut reader), budget as u64)
                    .map_err(err)?;
            let count = copy(&mut decoder, out)?;
            drop(decoder);
            if !reader.fill_buf().map_err(err)?.is_empty() {
                return Err(
                    "Trailing bytes or concatenated LZMA-Alone streams are not supported".into(),
                );
            }
            count
        }
        "gz" => copy(&mut flate2::bufread::MultiGzDecoder::new(&mut reader), out)?,
        "br" => {
            let mut decoder = brotli::Decompressor::new(&mut reader, 1);
            let count = copy(&mut decoder, out)?;
            drop(decoder);
            if !reader.fill_buf().map_err(err)?.is_empty() {
                return Err(
                    "Trailing bytes or concatenated Brotli streams are not supported".into(),
                );
            }
            count
        }
        "deflate" => {
            let mut decoder = flate2::bufread::DeflateDecoder::new(&mut reader);
            let count = copy(&mut decoder, out)?;
            drop(decoder);
            if !reader.fill_buf().map_err(err)?.is_empty() {
                return Err(
                    "Trailing bytes or concatenated raw DEFLATE streams are not supported".into(),
                );
            }
            count
        }
        "zlib" => {
            let mut decoder = flate2::bufread::ZlibDecoder::new(&mut reader);
            let count = copy(&mut decoder, out)?;
            drop(decoder);
            if !reader.fill_buf().map_err(err)?.is_empty() {
                return Err("Trailing bytes or concatenated zlib streams are not supported".into());
            }
            count
        }
        _ => return Err("Unsupported stream format".into()),
    };
    Ok(bytes)
}
fn output_name(path: &str, format: &str, compress: bool) -> Result<String, String> {
    let base = Path::new(path)
        .file_name()
        .and_then(|p| p.to_str())
        .ok_or("Invalid stream filename")?;
    if compress {
        return Ok(format!("{base}.{}", suffix(format)));
    }
    let suffixes = match format {
        "zstd" => vec![".zstd", ".zst"],
        "br" => vec![".br"],
        "bz2" => vec![".bzip2", ".bz2"],
        "gz" => vec![".gzip", ".gz"],
        other => vec![match other {
            "xz" => ".xz",
            "lzma" => ".lzma",
            "lz4" => ".lz4",
            "deflate" => ".deflate",
            "zlib" => ".zlib",
            _ => "",
        }],
    };
    for ending in suffixes {
        if base.to_lowercase().ends_with(ending) && base.len() > ending.len() {
            return Ok(base[..base.len() - ending.len()].into());
        }
    }
    Ok(format!("{base}.decoded"))
}
pub fn run(r: &Request, format: &str) -> Result<Value, String> {
    if r.paths.len() != 1 {
        return Err("A standalone stream compresses or decompresses one file; choose a TAR stream to combine files".into());
    }
    if !r.password.is_empty() {
        return Err("Standalone compression streams do not provide password encryption".into());
    }
    let path = &r.paths[0];
    let name = output_name(path, format, r.op == "create")?;
    let input = File::open(path).map_err(err)?;
    if r.op == "create" {
        let mut input = input;
        input.seek(SeekFrom::Start(0)).map_err(err)?;
        let out = File::create(safe(&name)?).map_err(err)?;
        let mut limited = Limited {
            inner: out,
            written: 0,
            limit: r.max_output,
        };
        encode(r, format, &mut input, &mut limited)?;
        limited.flush().map_err(err)?;
        return Ok(
            json!({"message":format!("Created {format} stream"),"streamFormat":format,"outputBytes":limited.written}),
        );
    }
    // A standalone stream holds exactly one entry: selecting it is the normal extraction.
    crate::Selection::new(r.only.as_deref(), [(name.as_str(), false, false)])?;
    let output: Box<dyn Write> = if r.op == "list" {
        Box::new(io::sink())
    } else {
        Box::new(File::create(safe(&name)?).map_err(err)?)
    };
    let mut limited = Limited {
        inner: output,
        written: 0,
        limit: r.max_output,
    };
    let size = decode(r, format, input, &mut limited)?;
    limited.flush().map_err(err)?;
    Ok(
        json!({"entries":[{"name":name,"size":size,"isDirectory":false}],"message":format!("Decoded {format} stream"),"streamFormat":format,"outputBytes":size}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temporary(std::path::PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "archive-stream-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn request() -> Request {
        serde_json::from_value(json!({"op":"extract", "paths":[]})).unwrap()
    }
    #[test]
    fn every_stream_rejects_each_truncated_suffix() {
        let directory = Temporary::new();
        let source = directory.0.join("source");
        let bytes: Vec<u8> = (0..4096).map(|i| ((i * 37 + i / 13) % 251) as u8).collect();
        std::fs::write(&source, &bytes).unwrap();
        for format in [
            "zstd", "br", "xz", "bz2", "lzma", "lz4", "deflate", "zlib", "gz",
        ] {
            let mut encoded = Vec::new();
            encode(
                &request(),
                format,
                &mut File::open(&source).unwrap(),
                &mut encoded,
            )
            .unwrap();
            let path = directory.0.join(format);
            std::fs::write(&path, &encoded).unwrap();
            let mut decoded = Vec::new();
            assert_eq!(
                decode(&request(), format, File::open(&path).unwrap(), &mut decoded).unwrap(),
                bytes.len() as u64
            );
            assert_eq!(decoded, bytes, "{format} roundtrip");
            let empty = directory.0.join("empty");
            std::fs::write(&empty, []).unwrap();
            assert!(
                decode(
                    &request(),
                    format,
                    File::open(&empty).unwrap(),
                    &mut io::sink()
                )
                .is_err(),
                "{format} accepted empty input"
            );
            for removed in 1..=encoded.len().min(16) {
                std::fs::write(&path, &encoded[..encoded.len() - removed]).unwrap();
                assert!(
                    decode(
                        &request(),
                        format,
                        File::open(&path).unwrap(),
                        &mut io::sink()
                    )
                    .is_err(),
                    "{format} accepted truncation of {removed} bytes"
                );
            }
        }
    }
    #[test]
    fn requested_levels_roundtrip_and_out_of_range_levels_fail() {
        let directory = Temporary::new();
        let source = directory.0.join("source");
        let bytes: Vec<u8> = (0..65536).map(|i| ((i * 7) % 61) as u8).collect();
        std::fs::write(&source, &bytes).unwrap();
        for (format, top) in [
            ("zstd", 19),
            ("br", 11),
            ("xz", 9),
            ("bz2", 9),
            ("lzma", 9),
            ("deflate", 9),
            ("zlib", 9),
            ("gz", 9),
        ] {
            let mut usual = request();
            usual.level = None;
            let mut best = request();
            best.level = Some(top);
            let mut encoded = Vec::new();
            encode(
                &best,
                format,
                &mut File::open(&source).unwrap(),
                &mut encoded,
            )
            .unwrap();
            let path = directory.0.join(format);
            std::fs::write(&path, &encoded).unwrap();
            let mut decoded = Vec::new();
            decode(&usual, format, File::open(&path).unwrap(), &mut decoded).unwrap();
            assert_eq!(decoded, bytes, "{format} at level {top}");
            let mut beyond = request();
            beyond.level = Some(top + 1);
            assert!(
                encode(
                    &beyond,
                    format,
                    &mut File::open(&source).unwrap(),
                    &mut Vec::new()
                )
                .is_err(),
                "{format} above {top}"
            );
        }
        let mut lz4 = request();
        lz4.level = Some(1);
        assert!(
            encode(
                &lz4,
                "lz4",
                &mut File::open(&source).unwrap(),
                &mut Vec::new()
            )
            .is_err()
        );
    }
}
