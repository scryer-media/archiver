use crate::{Request, err};
use serde_json::{Value, json};
use std::{fs::File, io, path::PathBuf};
use unrar_rs::{RarArchive, RarError, RevTestStatus};

#[derive(Default)]
struct Contents {
    bytes: u64,
    files: usize,
    unchecked: usize,
    failure: Option<String>,
    missing: bool,
}

fn authentication_or_io(error: &RarError) -> bool {
    matches!(
        error,
        RarError::Io(_)
            | RarError::InvalidPassword
            | RarError::WrongPassword { .. }
            | RarError::EncryptedArchive
            | RarError::EncryptedMember { .. }
    )
}

fn contents(r: &Request, paths: &[PathBuf]) -> Result<Contents, String> {
    let first = paths.first().ok_or("Select RAR files to verify")?;
    let input = File::open(first).map_err(err)?;
    let opened = if r.password.is_empty() {
        RarArchive::open(input)
    } else {
        RarArchive::open_with_password(input, &r.password)
    };
    let mut archive = match opened {
        Ok(archive) => archive,
        Err(error) if authentication_or_io(&error) || !r.password.is_empty() => {
            return Err(err(error));
        }
        Err(error) => {
            return Ok(Contents {
                failure: Some(err(error)),
                ..Contents::default()
            });
        }
    };
    let mut limits = unrar_rs::Limits::default();
    limits.max_dict_size = r.memory_budget()? as u64;
    limits.max_ppmd_arena_size = r.memory_budget()? as u64;
    limits.max_unpacked_size = r.max_output;
    archive.set_limits(limits);
    for (index, path) in paths.iter().skip(1).enumerate() {
        archive
            .add_volume(index + 1, Box::new(File::open(path).map_err(err)?))
            .map_err(err)?;
    }
    let metadata = archive.metadata();
    let members = archive.indexed_member_infos();
    // Metadata hides orphan continuations. Check the full topology and the
    // physical end records before accepting even an empty member list.
    let mut missing = metadata
        .volume_count
        .is_some_and(|count| count > archive.present_volumes().len())
        || members.iter().any(|member| !member.extractable);
    for (index, path) in paths.iter().enumerate() {
        let facts = RarArchive::parse_volume_facts(
            File::open(path).map_err(err)?,
            (!r.password.is_empty()).then_some(r.password.as_str()),
        )
        .map_err(err)?;
        missing |= facts
            .volume_number
            .is_some_and(|number| number as usize != index)
            || (index + 1 == paths.len() && facts.more_volumes);
    }
    if missing {
        return Ok(Contents {
            missing: true,
            failure: Some("RAR volume set is incomplete or out of order".into()),
            ..Contents::default()
        });
    }
    let encrypted = metadata.is_encrypted || members.iter().any(|member| member.info.is_encrypted);
    let mut checked = Contents::default();
    for indexed in &members {
        let member = &indexed.info;
        let index = indexed.index;
        if member.is_directory {
            continue;
        }
        // The decoder checks the member's stored checksum while streaming to
        // a sink. No destination file or reconstruction is opened.
        let copied = match archive
            .by_index(index)
            .and_then(|entry| entry.copy_to(&mut io::sink()))
        {
            Ok(bytes) => bytes,
            Err(error) if encrypted || authentication_or_io(&error) => return Err(err(error)),
            Err(error) => {
                checked.missing = matches!(error, RarError::MissingVolume { .. });
                checked.failure = Some(err(error));
                return Ok(checked);
            }
        };
        checked.bytes = checked
            .bytes
            .checked_add(copied)
            .ok_or("Verified byte count overflow")?;
        checked.files += 1;
        if checked.bytes > r.max_output || member.unpacked_size.is_some_and(|size| size != copied) {
            checked.failure =
                Some("RAR verification exceeded its byte budget or member size".into());
            return Ok(checked);
        }
        if member.crc32.is_none() && member.hash.is_none() {
            checked.unchecked += 1;
        }
    }
    Ok(checked)
}

fn verify_records(r: &Request, paths: &[PathBuf]) -> Result<Value, String> {
    let mut records = 0usize;
    let (mut damaged, mut unrepairable, mut parity, mut checksums, mut unchecked_bytes) =
        (0usize, 0usize, 0usize, 0usize, 0u64);
    for path in paths {
        let mut file = File::open(path).map_err(err)?;
        if let Some(assessment) = unrar_rs::assess_recovery_record(
            &mut file,
            (!r.password.is_empty()).then_some(r.password.as_str()),
        )
        .map_err(err)?
        {
            records += 1;
            damaged += assessment.damaged_units.len();
            unrepairable += assessment.unrepairable_units.len();
            parity += assessment.damaged_parity.len();
            checksums += assessment.damaged_checksums.len();
            unchecked_bytes = unchecked_bytes.saturating_add(assessment.unchecked_bytes);
        }
    }
    // Always decode too: a valid recovery record alone does not authenticate
    // an archive password or verify members outside its protected range.
    let data = contents(r, paths)?;
    let data_complete = data.failure.is_none() && data.unchecked == 0;
    let recovery_complete =
        records == 0 || (damaged == 0 && parity == 0 && checksums == 0 && unchecked_bytes == 0);
    let complete = data_complete && recovery_complete;
    let repairable =
        records > 0 && damaged > 0 && unrepairable == 0 && unchecked_bytes == 0 && !data.missing;
    let status = if complete {
        "Verified"
    } else if unrepairable > 0 {
        "InsufficientRecovery"
    } else if data.missing {
        "MissingVolumes"
    } else if unchecked_bytes > 0 || data.unchecked > 0 {
        "Unverified"
    } else if repairable {
        "Repairable"
    } else {
        "Damaged"
    };
    Ok(
        json!({"complete":complete,"status":status,"repairable":repairable,"dataComplete":data_complete,"recoveryAvailable":records>0,"recoveryComplete":if records>0 { Some(recovery_complete) } else { None },"recoveryRecords":records,"damagedUnits":damaged,"unrepairableUnits":unrepairable,"damagedRecoveryUnits":parity,"damagedRecoveryChecksums":checksums,"uncheckedRecoveryBytes":unchecked_bytes,"uncheckedMembers":data.unchecked,"verifiedFiles":data.files,"verifiedBytes":data.bytes,"verificationError":data.failure,"message":if complete { if records>0 { "RAR contents and recovery records verified; no files changed" } else { "RAR contents verified; no recovery record is present" } } else { "RAR verification did not complete; no files changed" }}),
    )
}

fn verify_volumes(r: &Request, paths: &[PathBuf]) -> Result<Value, String> {
    let rev_paths: Vec<_> = paths
        .iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("rev"))
        })
        .cloned()
        .collect();
    let carriers = unrar_rs::test_recovery_volumes(&rev_paths).map_err(err)?;
    if carriers
        .iter()
        .any(|carrier| matches!(carrier.status, RevTestStatus::Unreadable { .. }))
    {
        return Err("A recovery volume could not be read".into());
    }
    let recovery_complete = carriers
        .iter()
        .all(|carrier| matches!(carrier.status, RevTestStatus::Ok));
    let unverified = carriers
        .iter()
        .filter(|carrier| matches!(carrier.status, RevTestStatus::Unverifiable))
        .count();
    let carrier_results: Vec<_> = carriers.iter().map(|carrier| json!({"name":carrier.path.file_name().and_then(|name| name.to_str()),"status":format!("{:?}",carrier.status)})).collect();
    let plan = match unrar_rs::plan_volume_restore(paths, &unrar_rs::RecoveryOptions::default()) {
        Ok(plan) => plan,
        Err(error) if !recovery_complete => {
            return Ok(
                json!({"complete":false,"repairable":false,"status":if unverified>0 {"UnverifiedRecovery"} else {"InvalidRecovery"},"recoveryComplete":false,"unverifiedRecoveryVolumes":unverified,"recoveryVolumes":carrier_results,"verificationError":err(error),"message":"RAR recovery volume verification failed; no files changed"}),
            );
        }
        Err(error) => return Err(err(error)),
    };
    let needed = plan.needed();
    let available = plan.usable_recovery_count();
    let repairable = needed > 0 && plan.is_sufficient();
    let data = if plan.is_complete() {
        let sources: Vec<_> = plan
            .data_volumes
            .iter()
            .filter_map(|volume| volume.path.clone())
            .collect();
        contents(r, &sources)?
    } else {
        Contents::default()
    };
    let data_complete = plan.is_complete() && data.failure.is_none() && data.unchecked == 0;
    let complete = data_complete && recovery_complete;
    let status = if complete {
        "Verified"
    } else if unverified > 0 {
        "UnverifiedRecovery"
    } else if data.unchecked > 0 {
        "Unverified"
    } else if needed > available {
        "InsufficientRecovery"
    } else if needed > 0 {
        "Repairable"
    } else {
        "Damaged"
    };
    Ok(
        json!({"complete":complete,"status":status,"repairable":repairable,"dataComplete":data_complete,"recoveryComplete":recovery_complete,"neededVolumes":needed,"usableRecoveryVolumes":available,"unverifiedRecoveryVolumes":unverified,"recoveryVolumes":carrier_results,"verifiedFiles":data.files,"verifiedBytes":data.bytes,"uncheckedMembers":data.unchecked,"verificationError":data.failure,"message":if complete {"RAR data and recovery volumes verified; no files changed"} else {"RAR volume verification did not complete; no files changed"}}),
    )
}

pub(super) fn verify(r: &Request) -> Result<Value, String> {
    let paths: Vec<_> = r.paths.iter().map(PathBuf::from).collect();
    if paths.iter().any(|path| {
        path.extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("rev"))
    }) {
        verify_volumes(r, &paths)
    } else {
        verify_records(r, &paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "archive-readonly-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self { root }
        }
        fn put(&self, name: &str, bytes: &[u8]) -> String {
            let path = self.root.join(name);
            fs::write(&path, bytes).unwrap();
            path.to_str().unwrap().to_owned()
        }
        fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
            fs::read_dir(&self.root)
                .unwrap()
                .map(|entry| {
                    let path = entry.unwrap().path();
                    (
                        path.file_name().unwrap().to_str().unwrap().to_owned(),
                        fs::read(path).unwrap(),
                    )
                })
                .collect()
        }
        fn check(&self, paths: Vec<String>, password: &str) -> Result<Value, String> {
            let before = self.snapshot();
            let request: Request =
                serde_json::from_value(json!({"op":"verify","paths":paths,"password":password}))
                    .unwrap();
            let result = verify(&request);
            assert_eq!(
                self.snapshot(),
                before,
                "verification changed files or created output"
            );
            result
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    fn volumes(
        fixture: &Fixture,
        missing: usize,
        corrupt_data: bool,
        corrupt_carrier: bool,
    ) -> Vec<String> {
        let rar: [&[u8]; 10] = [
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part01.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part02.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part03.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part04.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part05.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part06.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part07.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part08.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part09.rar"),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part10.rar"),
        ];
        let mut paths = Vec::new();
        for (index, bytes) in rar.iter().enumerate().skip(missing) {
            let mut bytes = bytes.to_vec();
            if corrupt_data && index == 0 {
                bytes[1000] ^= 165;
            }
            paths.push(fixture.put(
                &format!("rar5_recovery_volumes.part{:02}.rar", index + 1),
                &bytes,
            ));
        }
        for (index, bytes) in [
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part01.rev").as_slice(),
            include_bytes!("../../tests/fixtures/rar5_recovery_volumes.part02.rev").as_slice(),
        ]
        .iter()
        .enumerate()
        {
            let mut bytes = bytes.to_vec();
            if corrupt_carrier && index == 0 {
                bytes[1000] ^= 165;
            }
            paths.push(fixture.put(
                &format!("rar5_recovery_volumes.part{:02}.rev", index + 1),
                &bytes,
            ));
        }
        paths
    }
    #[test]
    fn plain_archive_checks_payload_without_requiring_recovery_data() {
        let fixture = Fixture::new();
        let path = fixture.put(
            "input.rar",
            include_bytes!("../../tests/fixtures/compatibility/rar5_multifile_lz.rar"),
        );
        let result = fixture.check(vec![path], "").unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["recoveryAvailable"], false);
        assert_eq!(result["verifiedFiles"], 3);
    }
    #[test]
    fn split_sets_without_recovery_require_first_and_last_volumes() {
        for (missing_first, missing_last) in [(false, false), (true, false), (false, true)] {
            let fixture = Fixture::new();
            let mut paths = volumes(&fixture, usize::from(missing_first), false, false);
            paths.retain(|path| path.ends_with(".rar"));
            if missing_last {
                paths.pop();
            }
            let result = fixture.check(paths, "").unwrap();
            assert_eq!(result["complete"], !missing_first && !missing_last);
            if missing_first || missing_last {
                assert_eq!(result["status"], "MissingVolumes");
                assert_eq!(result["repairable"], false);
            }
        }
    }
    #[test]
    fn intact_empty_archive_does_not_require_a_member() {
        // Independently checksummed RAR5 main and end headers, with no members.
        let bytes = [
            0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, 0xca, 0x0b, 0x0c, 0x8d, 0x0c, 0x01,
            0x05, 0x08, 0x00, 0x07, 0x01, 0x01, 0x80, 0x80, 0x80, 0x80, 0x00, 0x1d, 0x77, 0x56,
            0x51, 0x03, 0x05, 0x04, 0x00,
        ];
        let fixture = Fixture::new();
        let path = fixture.put("empty.rar", &bytes);
        let result = fixture.check(vec![path], "").unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["verifiedFiles"], 0);
        // No unfinished member points at the missing volume: only the end
        // record's NEXT_VOLUME bit establishes that the set is incomplete.
        let mut unfinished = bytes;
        unfinished[25..29].copy_from_slice(&[0x8b, 0x47, 0x51, 0x26]);
        unfinished[32] = 1;
        let path = fixture.put("unfinished.part1.rar", &unfinished);
        let result = fixture.check(vec![path], "").unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["status"], "MissingVolumes");
    }
    #[test]
    fn recovery_records_are_assessed_without_repairing_corruption() {
        let fixture = Fixture::new();
        let bytes = include_bytes!("../../tests/fixtures/rar5_recovery.rar");
        let path = fixture.put("input.rar", bytes);
        let result = fixture.check(vec![path.clone()], "").unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["recoveryComplete"], true);
        let mut damaged = bytes.to_vec();
        damaged[100] ^= 255;
        fs::write(path.clone(), damaged).unwrap();
        let result = fixture.check(vec![path], "").unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["repairable"], true);
        assert!(result["damagedUnits"].as_u64().unwrap() > 0);
    }
    #[test]
    fn encrypted_password_is_validated_not_inferred_from_recovery() {
        let fixture = Fixture::new();
        let path = fixture.put(
            "encrypted.rar",
            include_bytes!("../../tests/fixtures/compatibility/rar5_enc_store.rar"),
        );
        assert_eq!(
            fixture.check(vec![path.clone()], "testpass123").unwrap()["complete"],
            true
        );
        assert!(fixture.check(vec![path], "incorrect-password").is_err());
        let path = fixture.put(
            "headers.rar",
            include_bytes!("../../tests/fixtures/compatibility/rar4_hp_store.rar"),
        );
        assert_eq!(
            fixture.check(vec![path.clone()], "secretpass").unwrap()["complete"],
            true
        );
        assert!(fixture.check(vec![path], "incorrect-password").is_err());
    }
    #[test]
    fn complete_recovery_set_checks_carriers_and_member_data() {
        let fixture = Fixture::new();
        let paths = volumes(&fixture, 0, false, false);
        let result = fixture.check(paths, "").unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["recoveryComplete"], true);
        assert_eq!(result["dataComplete"], true);
        assert_eq!(result["neededVolumes"], 0);
    }
    #[test]
    fn missing_or_corrupt_volumes_report_repairability_without_writing() {
        for (missing, corrupt) in [(1, false), (0, true)] {
            let fixture = Fixture::new();
            let paths = volumes(&fixture, missing, corrupt, false);
            let result = fixture.check(paths, "").unwrap();
            assert_eq!(result["complete"], false);
            assert_eq!(result["repairable"], true);
            assert_eq!(result["neededVolumes"], 1);
        }
    }
    #[test]
    fn insufficient_recovery_is_not_success_or_a_parse_error() {
        let fixture = Fixture::new();
        let paths = volumes(&fixture, 3, false, false);
        let result = fixture.check(paths, "").unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["repairable"], false);
        assert_eq!(result["status"], "InsufficientRecovery");
        assert_eq!(result["neededVolumes"], 3);
    }
    #[test]
    fn corrupt_recovery_carrier_prevents_complete_even_with_healthy_data() {
        let fixture = Fixture::new();
        let paths = volumes(&fixture, 0, false, true);
        let result = fixture.check(paths, "").unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["dataComplete"], true);
        assert_eq!(result["recoveryComplete"], false);
    }
    #[test]
    fn unchecksummed_legacy_recovery_is_explicitly_unverified() {
        let fixture = Fixture::new();
        let path = fixture.put("legacy1_1_1.rev", &[0; 128]);
        let result = fixture.check(vec![path], "").unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["status"], "UnverifiedRecovery");
        assert_eq!(result["unverifiedRecoveryVolumes"], 1);
    }
    #[test]
    fn record_shortage_reports_insufficient_without_reconstructing() {
        let fixture = Fixture::new();
        let paths = vec![fixture.put(
            "input.part1.rar",
            include_bytes!("../../tests/fixtures/rar5_multislice_recovery.part1.rar"),
        )];
        let first = &paths[0];
        let mut data = fs::read(first).unwrap();
        let assessment = unrar_rs::assess_recovery_record(&mut io::Cursor::new(&data), None)
            .unwrap()
            .unwrap();
        assert!(assessment.layout.data_units >= 3 && assessment.layout.parity_units == 1);
        for unit in [1, 2] {
            data[(unit * assessment.layout.unit_size + assessment.layout.unit_size / 2)
                as usize] ^= 165;
        }
        fs::write(first, data).unwrap();
        let result = fixture.check(paths, "").unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["repairable"], false);
        assert_eq!(result["status"], "InsufficientRecovery");
        assert!(result["unrepairableUnits"].as_u64().unwrap() > 0);
    }
}
