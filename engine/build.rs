use std::{env, path::PathBuf, process::Command};

fn run(command: &mut Command) {
    let status = command.status().expect("unable to start TAR build tool");
    assert!(status.success(), "TAR build tool failed: {command:?}");
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    for path in [
        "build.rs",
        "libarchive",
        "../scripts/vendor-libarchive.py",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    for name in ["CC", "AR", "CMAKE", "EMCMAKE", "CMAKE_BUILD_PARALLEL_LEVEL"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    // Preparation is cache-only. Network acquisition is an explicit operator step.
    let prepared = Command::new("python3")
        .arg(root.join("scripts/vendor-libarchive.py"))
        .output()
        .expect("unable to verify TAR source cache");
    assert!(
        prepared.status.success(),
        "TAR source preparation failed: {}",
        String::from_utf8_lossy(&prepared.stderr)
    );
    let source = PathBuf::from(
        String::from_utf8(prepared.stdout)
            .expect("invalid source path")
            .trim(),
    );
    assert!(
        source.join("COPYING").is_file(),
        "TAR source license is missing"
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("tar-core");
    let target = env::var("TARGET").unwrap();
    let wasm = target == "wasm32-unknown-emscripten";
    assert!(
        wasm || target == env::var("HOST").unwrap(),
        "TAR cross-build target is not configured"
    );
    let cmake = env::var("CMAKE").unwrap_or_else(|_| "cmake".into());
    let mut configure = if wasm {
        let mut command = Command::new(env::var("EMCMAKE").unwrap_or_else(|_| "emcmake".into()));
        command.arg(&cmake);
        command
    } else {
        Command::new(&cmake)
    };
    configure
        .arg("-S")
        .arg(manifest.join("libarchive"))
        .arg("-B")
        .arg(&out)
        .arg("-DCMAKE_BUILD_TYPE=Release")
        .arg(format!("-DLIBARCHIVE_SOURCE={}", source.display()));
    run(&mut configure);
    run(Command::new(&cmake)
        .arg("--build")
        .arg(&out)
        .arg("--target")
        .arg("archive_static")
        .arg("--parallel")
        .arg("2"));
    println!(
        "cargo:rustc-link-search=native={}",
        out.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=archive");
}
