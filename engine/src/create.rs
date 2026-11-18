use super::Request;
use std::io::{Read, Seek, Write};

/// An input file opened on its first read and closed when it reaches end of file.
/// A solid archive holds a reader for every selected file at once; opening them all
/// up front runs out of file descriptors on folders with thousands of files.
pub struct LazyFile {
    path: String,
    file: Option<std::fs::File>,
    done: bool,
}
impl LazyFile {
    pub fn new(path: &str) -> Self {
        Self { path: path.to_owned(), file: None, done: false }
    }
}
impl Read for LazyFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        let file = match &mut self.file {
            Some(file) => file,
            None => self.file.insert(std::fs::File::open(&self.path)?),
        };
        let read = file.read(buf)?;
        if read == 0 {
            self.file = None;
            self.done = true;
        }
        Ok(read)
    }
}
pub fn write<W: Write + Seek, R: Read>(
    r: &Request,
    plans: &[super::codecs::Plan],
    header_methods: Vec<sevenz_turbo::EncoderConfiguration>,
    output: W,
    mut open: impl FnMut(&str) -> Result<(R, u64), String>,
) -> Result<W, String> {
    if plans.len() != r.paths.len() {
        return Err("Every selected file must have an encoding plan".into());
    }
    let mut input_metadata = std::collections::HashMap::new();
    for metadata in &r.input_metadata {
        if input_metadata
            .insert(metadata.name.as_str(), metadata)
            .is_some()
        {
            return Err("Duplicate input metadata path".into());
        }
    }
    let mut w = sevenz_turbo::ArchiveWriter::new(output).map_err(super::err)?;
    w.set_content_methods(header_methods.clone());
    w.set_encrypt_header(!r.password.is_empty() && r.encrypt_headers.unwrap_or(true));
    for name in &r.directories {
        let entry = sevenz_turbo::ArchiveEntry::new_directory(name);
        w.push_archive_entry::<R>(entry, None).map_err(super::err)?;
    }
    let mut solid_entries = Vec::new();
    let mut solid_readers = Vec::new();
    let mut previous_plan = None;
    for (path, plan) in r.paths.iter().zip(plans.iter()) {
        if previous_plan.as_ref() != Some(plan) {
            if !solid_entries.is_empty() {
                w.push_archive_entries(
                    std::mem::take(&mut solid_entries),
                    std::mem::take(&mut solid_readers),
                )
                .map_err(super::err)?;
            }
            w.set_content_methods(super::codecs::plan_methods(r, plan)?);
            previous_plan = Some(plan.clone());
        }
        let name = path
            .strip_prefix("/input/")
            .ok_or("Input path must be mounted under /input")?;
        super::safe(name)?;
        let mut e = sevenz_turbo::ArchiveEntry::new_file(name);
        let (file, size) = open(path)?;
        e.size = size;
        if let Some(metadata) = input_metadata.get(name)
            && let Some(millis) = metadata.modified_time
        {
            super::metadata::set_modified(&mut e, millis)?;
        }
        if r.solid {
            solid_entries.push(e);
            solid_readers.push(sevenz_turbo::SourceReader::new(file));
        } else {
            w.push_archive_entry(e, Some(file)).map_err(super::err)?;
        }
    }
    if !solid_entries.is_empty() {
        w.push_archive_entries(solid_entries, solid_readers)
            .map_err(super::err)?;
    }
    // Header encoding must follow the archive-wide password policy, not the last file's codec.
    w.set_content_methods(header_methods);
    w.finish().map_err(super::err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    fn encoded(encrypt_headers: bool) -> Vec<u8> {
        let r: Request = serde_json::from_value(json!({"op":"create","format":"7z","paths":["/input/a.txt","/input/b.txt","/input/code.bin","/input/media.bin"],"directories":["empty"],"password":"fixture-password","encryptHeaders":encrypt_headers,"solid":true,"fileOptions":[{"name":"code.bin","codec":"lzma2","filter":"x86","level":1,"dictionarySize":65536},{"name":"media.bin","codec":"copy","filter":"none"}]})).unwrap();
        let plans = super::super::codecs::file_plans(&r).unwrap();
        write(
            &r,
            &plans,
            super::super::codecs::header_methods(&r).unwrap(),
            Cursor::new(Vec::new()),
            |path| {
                let data = path.as_bytes().repeat(64);
                let size = data.len() as u64;
                Ok((Cursor::new(data), size))
            },
        )
        .unwrap()
        .into_inner()
    }
    #[test]
    fn mixed_plans_split_solid_groups_and_preserve_global_encryption() {
        let bytes = encoded(true);
        assert!(sevenz_turbo::ArchiveReader::new(Cursor::new(bytes.clone()), "".into()).is_err());
        assert!(
            sevenz_turbo::ArchiveReader::new(Cursor::new(bytes.clone()), "wrong".into()).is_err()
        );
        let mut reader =
            sevenz_turbo::ArchiveReader::new(Cursor::new(bytes), "fixture-password".into())
                .unwrap();
        assert_eq!(reader.archive().blocks.len(), 3);
        let mut names = Vec::new();
        reader
            .for_each_entries(|entry, input| {
                if !entry.is_directory {
                    let mut data = Vec::new();
                    input.read_to_end(&mut data)?;
                    assert_eq!(
                        data,
                        format!("/input/{}", entry.name()).as_bytes().repeat(64)
                    );
                    names.push(entry.name().to_string());
                }
                Ok(true)
            })
            .unwrap();
        assert_eq!(names, ["a.txt", "b.txt", "code.bin", "media.bin"]);
    }
    #[test]
    fn visible_headers_do_not_disable_file_encryption() {
        let bytes = encoded(false);
        let mut reader =
            sevenz_turbo::ArchiveReader::new(Cursor::new(bytes.clone()), "".into()).unwrap();
        assert_eq!(reader.archive().files.len(), 5);
        assert!(
            reader
                .for_each_entries(|_, input| {
                    std::io::copy(input, &mut std::io::sink())?;
                    Ok(true)
                })
                .is_err()
        );
        let mut reader =
            sevenz_turbo::ArchiveReader::new(Cursor::new(bytes), "fixture-password".into())
                .unwrap();
        reader
            .for_each_entries(|_, input| {
                std::io::copy(input, &mut std::io::sink())?;
                Ok(true)
            })
            .unwrap();
    }
    #[test]
    fn browser_modification_times_roundtrip_in_created_archive() {
        for millis in [0_i64, -1, 1_700_000_000_123] {
            let r: Request = serde_json::from_value(json!({"op":"create","format":"7z","codec":"copy","paths":["/input/item"],"inputMetadata":[{"name":"item","modifiedTime":millis}]})).unwrap();
            let bytes = write(
                &r,
                &super::super::codecs::file_plans(&r).unwrap(),
                super::super::codecs::header_methods(&r).unwrap(),
                Cursor::new(Vec::new()),
                |_| Ok((Cursor::new(vec![42]), 1)),
            )
            .unwrap()
            .into_inner();
            let reader = sevenz_turbo::ArchiveReader::new(Cursor::new(bytes), "".into()).unwrap();
            assert_eq!(
                super::super::metadata::sevenz(&reader.archive().files[0])["modifiedTime"],
                millis
            );
        }
    }
    #[test]
    fn lazy_file_opens_on_first_read_and_closes_at_end() {
        let dir = std::env::temp_dir().join(format!("lazy-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("input.bin");
        let mut lazy = LazyFile::new(path.to_str().unwrap());
        assert!(lazy.file.is_none(), "nothing is opened before the first read");
        std::fs::write(&path, b"lazy bytes").unwrap();
        let mut bytes = Vec::new();
        lazy.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"lazy bytes");
        assert!(lazy.file.is_none(), "the file is closed once it is read to the end");
        assert_eq!(lazy.read(&mut [0; 4]).unwrap(), 0, "a finished file is not reopened");
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn incomplete_plan_fails_before_output_or_source_io() {
        let r: Request =
            serde_json::from_value(json!({"op":"create","format":"7z","paths":["/input/a"]}))
                .unwrap();
        let mut output = Cursor::new(Vec::new());
        let result = write::<_, Cursor<Vec<u8>>>(&r, &[], Vec::new(), &mut output, |_| {
            panic!("unexpected source read")
        });
        assert!(result.is_err());
        assert!(output.into_inner().is_empty());
    }
}
