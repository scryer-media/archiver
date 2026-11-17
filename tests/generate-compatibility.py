from pathlib import Path
import hashlib,json,shutil,subprocess,tempfile
base=Path(__file__).resolve().parent
workspace=base.parent.parent
out=base/"fixtures"/"compatibility"
out.mkdir(parents=True,exist_ok=True)
state=0x13579BDF
payload=bytearray()
for i in range(65536):
    state^=(state<<13)&0xFFFFFFFF;state^=state>>17;state^=(state<<5)&0xFFFFFFFF
    payload.append((state if i%64<32 else i%251)&255)
(out/"payload.bin").write_bytes(payload)
def run(args,cwd):
    return subprocess.run([*args],cwd=cwd,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
manifest=[]
for method in ["Copy","LZMA","LZMA2","PPMd","BZip2","Deflate"]:
    name="oracle-"+method.lower()+".7z"
    try:run(["7zz","a","-t7z","-m0="+method,"-y",name,"payload.bin"],out)
    except subprocess.CalledProcessError as error:
        print(method,"oracle unavailable",error.stdout.decode()[-300:]);continue
    manifest.append({"file":name,"feature":"7z "+method,"outputs":[{"name":"payload.bin","size":len(payload),"sha256":hashlib.sha256(payload).hexdigest()}]})
rar=workspace/"rarpar/crates/unrar-rs/tests/fixtures"
for folder,name,password in [("rar4","rar15_lz.rar",""),("rar4","rar20_audio_text.rar",""),("rar4","rar4_lz.rar",""),("rar4","rar20_lz.rar",""),("rar4","test_read_format_rar_filter.rar",""),("rar5","test_read_format_rar5_arm.rar",""),("rar4","rar4_lz_solid_mv.rar",""),("rar4","rar4_ppm_solid_mv.rar",""),("rar4","rar4_hp_store.rar","secretpass"),("rar4","rar4_enc_store.rar","testpass123"),("rar4","test_read_format_rar_sfx.exe",""),("rar5","rar5_enc_store.rar","testpass123"),("rar5","rar5_multifile_lz.rar",""),("rar5","rar5_unicode.rar","")]:
    shutil.copyfile(rar/folder/name,out/name)
    if name.startswith(("rar15_","rar20_")):
        data=(rar/"originals/boat_modern_english.wav").read_bytes()
        member="BOATMO~1.WAV" if name.startswith("rar15") else "BoatModernEnglish.wav"
        manifest.append({"file":name,"feature":name,"allowExtraOutputs":True,"outputs":[{"name":member,"size":len(data),"sha256":hashlib.sha256(data).hexdigest()}]})
        continue
    listing=run(["7zz","l","-slt","-p"+password,str(out/name)],out).stdout.decode()
    files=[]
    for block in listing.split("\n\n"):
        fields=dict(line.split(" = ",1) for line in block.splitlines() if " = " in line)
        if "Path" in fields and "Size" in fields and fields.get("Attributes","")[:1]!="D":
            item={"name":fields["Path"],"size":int(fields["Size"]),"crc32":fields.get("CRC","").lower()}
            original=rar/"originals"/fields["Path"]
            if original.is_file() and original.stat().st_size==item["size"]:item["sha256"]=hashlib.sha256(original.read_bytes()).hexdigest()
            files.append(item)
    if name=="rar5_unicode.rar":
        files=[]
        for member in ["日本語ファイル.txt","café-résumé.txt"]:
            data=(rar/"originals"/member).read_bytes()
            files.append({"name":member,"size":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    if not files:raise RuntimeError("No oracle entries: "+name)
    manifest.append({"file":name,"feature":folder+" "+name,"password":password,"outputs":files})
volume_names=[f"rar5_recovery_volumes.part{i:02d}.rar" for i in range(1,11)]
for name in volume_names:shutil.copyfile(rar/"rar5"/name,out/name)
listing=run(["7zz","l","-slt",str(out/volume_names[0])],out).stdout.decode()
files=[]
for block in listing.split("\n\n"):
    fields=dict(line.split(" = ",1) for line in block.splitlines() if " = " in line)
    if "Path" in fields and "Size" in fields and fields.get("Attributes","")[:1]!="D":files.append({"name":fields["Path"],"size":int(fields["Size"]),"crc32":fields.get("CRC","").lower()})
manifest.append({"file":volume_names[0],"files":volume_names,"feature":"RAR5 multipart ten volumes","outputs":files})
for name in ["delta.7z","delta_bcj2.7z","7za433_7zip_lzma2_bcj2.7z","decompress_example_bcj_arm64.7z"]:
    shutil.copyfile(workspace/"sevenz-turbo/tests/resources"/name,out/name)
    with tempfile.TemporaryDirectory(prefix="archive-oracle-") as temporary:
        run(["7zz","x","-y","-o"+temporary,str(out/name)],out)
        files=[]
        for path in sorted(Path(temporary).rglob("*")):
            if path.is_file():
                data=path.read_bytes();files.append({"name":path.relative_to(temporary).as_posix(),"size":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    manifest.append({"file":name,"feature":"7z filters "+name,"outputs":files})
for name in ["zstdmt-brotli.7z","zstdmt-lz4.7z"]:
    shutil.copyfile(workspace/"sevenz-turbo/tests/resources"/name,out/name)
    manifest.append({"file":name,"feature":name,"contains":"Apache License","expectedName":"LICENSE"})
advanced=workspace/"rarpar/crates/par3-rs/tests/fixtures/advanced"
reference=[]
for stem,suffixes in [("fft",[".par3",".vol0+1.par3",".vol1+2.par3",".vol3+4.par3",".vol7+1.par3"]),("fft16",[".par3",".vol00+1.par3",".vol01+2.par3",".vol03+4.par3",".vol07+8.par3",".vol15+1.par3"]),("interleaved",[".par3",".vol0+1.par3",".vol1+2.par3"])]:
    names=[stem+suffix for suffix in suffixes]
    for name in names:shutil.copyfile(advanced/name,out/name)
    reference.append({"feature":stem,"files":names})
(out/"reference-input.bin").write_bytes(bytes((i*73+i//29)%256 for i in range(14000)))
(out/"par3-manifest.json").write_text(json.dumps(reference,indent=2)+"\n")
(out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
print("Prepared",len(manifest),"compatibility cases")
