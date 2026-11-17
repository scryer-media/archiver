//! Archive metadata is descriptive; browser delivery does not apply host permissions or times.
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
const MAX_SAFE: i128 = 9_007_199_254_740_991;
const NT_EPOCH_TICKS: i128 = 116_444_736_000_000_000;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputMetadata {
    pub name: String,
    pub modified_time: Option<i64>,
}
fn safe_number(value: i128) -> Option<Value> {
    (value.abs() <= MAX_SAFE).then(|| json!(value as i64))
}
fn system_ms(time: SystemTime) -> Option<Value> {
    let millis = match time.duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_millis() as i128,
        Err(error) => -(error.duration().as_millis() as i128),
    };
    safe_number(millis)
}
fn nt_ms(time: sevenz_turbo::NtTime) -> Option<Value> {
    safe_number((i128::from(u64::from(time)) - NT_EPOCH_TICKS) / 10_000)
}
fn insert(map: &mut Map<String, Value>, name: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(name.into(), value);
    }
}
pub fn rar(entry: &unrar_rs::MemberInfo) -> Value {
    let mut map = Map::new();
    insert(&mut map, "modifiedTime", entry.mtime.and_then(system_ms));
    insert(&mut map, "createdTime", entry.ctime.and_then(system_ms));
    insert(&mut map, "accessedTime", entry.atime.and_then(system_ms));
    match entry.host_os {
        unrar_rs::HostOs::Unix | unrar_rs::HostOs::Darwin => {
            map.insert("unixMode".into(), json!(entry.attributes.unix_mode()));
        }
        unrar_rs::HostOs::Windows => {
            insert(
                &mut map,
                "windowsAttributes",
                safe_number(i128::from(entry.attributes.0)),
            );
        }
        _ => {}
    }
    if let Some(owner) = &entry.owner {
        insert(
            &mut map,
            "uid",
            owner.uid.and_then(|id| safe_number(i128::from(id))),
        );
        insert(
            &mut map,
            "gid",
            owner.gid.and_then(|id| safe_number(i128::from(id))),
        );
        insert(
            &mut map,
            "owner",
            owner.user_name.as_ref().map(|name| json!(name)),
        );
        insert(
            &mut map,
            "group",
            owner.group_name.as_ref().map(|name| json!(name)),
        );
    }
    let kind = if entry.is_symlink {
        Some("symbolic")
    } else if entry.is_hardlink {
        Some("hard")
    } else if entry.is_file_copy {
        Some("copy")
    } else if entry.link_target.is_some() || entry.link_target_bytes.is_some() {
        Some("unknown")
    } else {
        None
    };
    if let Some(kind) = kind {
        let mut link = json!({"kind":kind});
        if let Some(target) = &entry.link_target {
            link["target"] = json!(target);
        }
        map.insert("link".into(), link);
    }
    Value::Object(map)
}
pub fn sevenz(entry: &sevenz_turbo::ArchiveEntry) -> Value {
    let mut map = Map::new();
    insert(
        &mut map,
        "modifiedTime",
        entry
            .has_last_modified_date
            .then(|| nt_ms(entry.last_modified_date))
            .flatten(),
    );
    insert(
        &mut map,
        "createdTime",
        entry
            .has_creation_date
            .then(|| nt_ms(entry.creation_date))
            .flatten(),
    );
    insert(
        &mut map,
        "accessedTime",
        entry
            .has_access_date
            .then(|| nt_ms(entry.access_date))
            .flatten(),
    );
    if entry.has_windows_attributes {
        map.insert("windowsAttributes".into(), json!(entry.windows_attributes));
    }
    insert(
        &mut map,
        "unixMode",
        entry.unix_mode().map(|mode| json!(mode)),
    );
    if entry.is_symlink() {
        map.insert("link".into(), json!({"kind":"symbolic"}));
    }
    Value::Object(map)
}
pub fn set_modified(entry: &mut sevenz_turbo::ArchiveEntry, millis: i64) -> Result<(), String> {
    if i128::from(millis).abs() > MAX_SAFE {
        return Err("Input modification time exceeds exact browser range".into());
    }
    let ticks = i128::from(millis) * 10_000 + NT_EPOCH_TICKS;
    let ticks =
        u64::try_from(ticks).map_err(|_| "Input modification time exceeds 7z timestamp range")?;
    entry.last_modified_date = sevenz_turbo::NtTime::new(ticks);
    entry.has_last_modified_date = true;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn epoch_and_pre_epoch_times_are_not_missing() {
        for millis in [0, -1, -31_536_000_000, 1_700_000_000_123] {
            let mut entry = sevenz_turbo::ArchiveEntry::new_file("item");
            set_modified(&mut entry, millis).unwrap();
            assert_eq!(sevenz(&entry)["modifiedTime"], millis);
        }
        assert_eq!(system_ms(UNIX_EPOCH), Some(json!(0)));
        assert_eq!(
            system_ms(UNIX_EPOCH - std::time::Duration::from_millis(1)),
            Some(json!(-1))
        );
    }
    #[test]
    fn rar_fixture_preserves_timestamp_mode_and_hardlink_metadata() {
        let bytes = include_bytes!(
            "../../../rarpar/crates/unrar-rs/tests/fixtures/rar5/test_read_format_rar5_hardlink.rar"
        );
        let archive = unrar_rs::RarArchive::open(std::io::Cursor::new(bytes)).unwrap();
        let members = archive.metadata().members;
        let regular = rar(&members[0]);
        assert_eq!(regular["modifiedTime"], 1_555_533_112_000_i64);
        assert_eq!(regular["unixMode"], 0o100644);
        let link = rar(&members[1]);
        assert_eq!(link["link"], json!({"kind":"hard","target":"file.txt"}));
    }
    #[test]
    fn unknown_and_out_of_range_times_are_not_invented() {
        let mut entry = sevenz_turbo::ArchiveEntry::new_file("item");
        assert!(sevenz(&entry).get("modifiedTime").is_none());
        assert!(set_modified(&mut entry, i64::MIN).is_err());
        assert!(set_modified(&mut entry, -11_644_473_600_001).is_err());
    }
}
