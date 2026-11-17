from pathlib import Path
import subprocess,shutil,json,zlib
base=Path(__file__).resolve().parent
out=base/"fixtures"/"streams"
out.mkdir(parents=True,exist_ok=True)
manifest=[]
for dataset,source in [("payload",base/"fixtures/compatibility/payload.bin"),("tar",base/"fixtures/plain.tar")]:
    name="input.bin" if dataset=="payload" else "input.tar"
    shutil.copyfile(source,out/name)
    commands=[("gzip","gz",["gzip","-k","-f",name]),("bzip2","bz2",["bzip2","-k","-f",name]),("xz","xz",["xz","-k","-f",name]),("lzma","lzma",["xz","--format=lzma","-k","-f",name]),("zstd","zst",["zstd","-q","-f",name,"-o",name+".zst"]),("brotli","br",["brotli","-f","-q","6",name,"-o",name+".br"]),("lz4","lz4",["lz4","-q","-f",name,name+".lz4"])]
    for format,suffix,command in commands:
        subprocess.run([*command],cwd=out,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        path=out/(name+"."+suffix)
        target=dataset+"-"+suffix+".bin"
        path.rename(out/target)
        manifest.append({"format":format,"suffix":suffix,"file":target,"name":name+"."+suffix,"dataset":dataset,"concatenated":format in ["gzip","bzip2","xz","zstd","lz4"]})
    for format,wbits,suffix in [("deflate",-15,"deflate"),("zlib",15,"zlib")]:
        encoder=zlib.compressobj(wbits=wbits)
        target=dataset+"-"+suffix+".bin"
        (out/target).write_bytes(encoder.compress(source.read_bytes())+encoder.flush())
        manifest.append({"format":format,"suffix":suffix,"file":target,"name":name+"."+suffix,"dataset":dataset,"concatenated":False})
    (out/name).unlink()
(out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
print("Prepared",len(manifest),"independent stream fixtures")
