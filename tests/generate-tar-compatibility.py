from pathlib import Path
import tarfile,io,subprocess,json
base=Path(__file__).resolve().parent
out=base/"fixtures"/"tar-compatibility"
out.mkdir(parents=True,exist_ok=True)
long_name="nested/"+"long-directory/"*10+"unicode-資料-payload.txt"
expected=[]
for label,format in [("pax",tarfile.PAX_FORMAT),("gnu",tarfile.GNU_FORMAT)]:
    archive=out/(label+".tar")
    with tarfile.open(archive,"w",format=format,pax_headers={"comment":"archive interoperability fixture"} if label=="pax" else None) as writer:
        directory=tarfile.TarInfo("empty-directory/");directory.type=tarfile.DIRTYPE;writer.addfile(directory)
        for name,data in [(long_name,b"long path payload\n"),("after-metadata.txt",b"next regular member\n")]:
            entry=tarfile.TarInfo(name);entry.size=len(data);entry.mtime=1700000000.125;writer.addfile(entry,io.BytesIO(data))
    subprocess.run(["zstd","-q","-f",str(archive),"-o",str(out/(label+"-zst.bin"))],check=True)
    expected.append({"label":label,"longName":long_name,"files":[{"name":long_name,"text":"long path payload\n"},{"name":"after-metadata.txt","text":"next regular member\n"}]})
for label,format in [("pax",tarfile.PAX_FORMAT),("gnu",tarfile.GNU_FORMAT)]:
    with tarfile.open(out/(label+"-traversal.tar"),"w",format=format) as writer:
        entry=tarfile.TarInfo("../"+"long-directory/"*10+"escape.txt");entry.size=6;writer.addfile(entry,io.BytesIO(b"escape"))
raw=(out/"gnu.tar").read_bytes()
(out/"truncated.tar").write_bytes(raw[:1200])
corrupt=bytearray(raw);corrupt[0]^=255;(out/"bad-checksum.tar").write_bytes(corrupt)
pax=bytearray((out/"pax.tar").read_bytes());pax[512]=ord("9");(out/"bad-pax-record.tar").write_bytes(pax)
with tarfile.open(out/"link.tar","w",format=tarfile.GNU_FORMAT) as writer:
    entry=tarfile.TarInfo("link");entry.type=tarfile.SYMTYPE;entry.linkname="../"+"long-directory/"*12+"escape";writer.addfile(entry)
(out/"manifest.json").write_text(json.dumps(expected,indent=2)+"\n")
print("Generated GNU/PAX compatibility and adversarial fixtures")
