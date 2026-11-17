use super::Request;
use std::io::{Read, Seek, Write};
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
