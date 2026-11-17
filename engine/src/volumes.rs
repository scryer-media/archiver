//! Seekable split 7z input without concatenating its contents in memory.
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

pub struct Volumes {
    files: Vec<(File, u64, u64)>,
    position: u64,
    length: u64,
}
impl Volumes {
    pub fn open(paths: &[String]) -> io::Result<Self> {
        let mut paths: Vec<&String> = paths.iter().collect();
        paths.sort_by_key(|path| {
            path.rsplit_once('.')
                .and_then(|(_, suffix)| suffix.parse::<u64>().ok())
                .unwrap_or(0)
        });
        if paths.len() > 1 {
            let (prefix, first) = paths[0]
                .rsplit_once('.')
                .ok_or_else(|| io::Error::other("Split 7z inputs need numbered volume suffixes"))?;
            if first != "001" {
                return Err(io::Error::other(
                    "Select every split 7z volume, starting with .001",
                ));
            }
            for (index, path) in paths.iter().enumerate() {
                if path.as_str() != format!("{prefix}.{:03}", index + 1) {
                    return Err(io::Error::other(
                        "Split 7z volumes must have consecutive matching numbered names",
                    ));
                }
            }
        }
        let mut files = Vec::new();
        let mut length = 0u64;
        for path in paths {
            let file = File::open(path)?;
            let size = file.metadata()?.len();
            files.push((file, length, size));
            length = length
                .checked_add(size)
                .ok_or_else(|| io::Error::other("Split archive length overflow"))?;
        }
        Ok(Self {
            files,
            position: 0,
            length,
        })
    }
}
impl Read for Volumes {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() || self.position >= self.length {
            return Ok(0);
        }
        let (file, start, size) = self
            .files
            .iter_mut()
            .find(|(_, start, size)| self.position >= *start && self.position - *start < *size)
            .ok_or_else(|| io::Error::other("Missing split archive volume"))?;
        let offset = self.position - *start;
        let take = bytes
            .len()
            .min(usize::try_from(size.saturating_sub(offset)).unwrap_or(usize::MAX));
        file.seek(SeekFrom::Start(offset))?;
        let read = file.read(&mut bytes[..take])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Split archive volume became truncated",
            ));
        }
        self.position += read as u64;
        Ok(read)
    }
}
impl Seek for Volumes {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.length) + i128::from(offset),
        };
        self.position = u64::try_from(position).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid split archive seek")
        })?;
        Ok(self.position)
    }
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
                "archive-volume-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().into()
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn reads_seeks_and_validates_split_archives() {
        let directory = Temporary::new();
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = sevenz_turbo::ArchiveWriter::new(cursor).unwrap();
        writer.set_content_methods(vec![sevenz_turbo::EncoderMethod::COPY.into()]);
        writer
            .push_archive_entry::<&[u8]>(sevenz_turbo::ArchiveEntry::new_directory("empty"), None)
            .unwrap();
        writer
            .push_archive_entry(
                sevenz_turbo::ArchiveEntry::new_file("payload"),
                Some(&b"split archive payload"[..]),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let paths: Vec<_> = bytes
            .chunks(bytes.len().div_ceil(3))
            .enumerate()
            .map(|(index, bytes)| {
                let path = directory.path(&format!("archive.7z.{:03}", index + 1));
                std::fs::write(&path, bytes).unwrap();
                path
            })
            .collect();
        let mut reversed = paths.clone();
        reversed.reverse();
        let mut volume = Volumes::open(&reversed).unwrap();
        let mut whole = Vec::new();
        volume.read_to_end(&mut whole).unwrap();
        assert_eq!(whole, bytes);
        for offset in [0, 1, bytes.len() / 3, bytes.len() / 2, bytes.len() - 1] {
            volume.seek(SeekFrom::Start(offset as u64)).unwrap();
            let mut byte = [0];
            volume.read_exact(&mut byte).unwrap();
            assert_eq!(byte[0], bytes[offset]);
        }
        assert!(volume.seek(SeekFrom::Current(i64::MIN)).is_err());
        let mut reader =
            sevenz_turbo::ArchiveReader::new(Volumes::open(&reversed).unwrap(), "".into()).unwrap();
        assert!(
            reader
                .archive()
                .files
                .iter()
                .any(|e| e.name() == "empty" && e.is_directory())
        );
        reader
            .for_each_entries(|entry, reader| {
                if !entry.is_directory() {
                    let mut payload = Vec::new();
                    reader.read_to_end(&mut payload)?;
                    assert_eq!(payload, b"split archive payload");
                }
                Ok(true)
            })
            .unwrap();
        assert!(Volumes::open(&[paths[0].clone(), paths[2].clone()]).is_err());
        assert!(Volumes::open(&[paths[0].clone(), paths[0].clone()]).is_err());
        assert!(Volumes::open(&paths[1..]).is_err());
    }
    #[test]
    fn seeks_across_large_sparse_volumes_without_concatenating() {
        let directory = Temporary::new();
        let paths = vec![
            directory.path("large.7z.001"),
            directory.path("large.7z.002"),
        ];
        let first = File::create(&paths[0]).unwrap();
        first.set_len((1u64 << 32) + 19).unwrap();
        std::fs::write(&paths[1], b"end").unwrap();
        let mut volume = Volumes::open(&paths).unwrap();
        assert_eq!(volume.seek(SeekFrom::End(-3)).unwrap(), (1u64 << 32) + 19);
        let mut tail = [0; 3];
        volume.read_exact(&mut tail).unwrap();
        assert_eq!(&tail, b"end");
    }
}
