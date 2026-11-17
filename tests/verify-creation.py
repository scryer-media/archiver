"""Independent CLI verification of retained application-created small fixtures."""
import re, zipfile, struct
import argparse, hashlib, json, pathlib, shutil, subprocess, unicodedata, zlib, gzip, bz2, lzma, tarfile, io

class UnsupportedExternalDecoder(Exception): pass

def sha(path):
 h=hashlib.sha256()
 with path.open("rb") as f:
  for block in iter(lambda:f.read(1024*1024),b""): h.update(block)
 return h.hexdigest()
def safe(name):
 p=pathlib.PurePosixPath(name)
 if p.is_absolute() or not p.parts or any(x in ("..", ".") for x in p.parts) or "\\" in name: raise ValueError("Unsafe relative path: "+name)
 return p

def command(args,cwd):
 r=subprocess.run([*map(str,args)],cwd=cwd,capture_output=True,timeout=180)
 return {"argv":list(map(str,args)),"exitCode":r.returncode,"stdout":r.stdout.decode(errors="replace"),"stderr":r.stderr.decode(errors="replace")}
def identity(name): return unicodedata.normalize("NFC",name)
def tree(root):
 result={}
 for p in root.rglob("*"):
  name=identity(p.relative_to(root).as_posix())
  if name in result: raise AssertionError("Duplicate canonical output identity")
  if p.is_symlink(): raise AssertionError("Unexpected output link")
  result[name]={"directory":True} if p.is_dir() else {"bytes":p.stat().st_size,"sha256":sha(p)}
 return result
def compare(root,expected):
 actual=tree(root);want={};explicit=set()
 for x in expected:
  name=identity(x["name"]);safe(name)
  if name in explicit: raise AssertionError("Duplicate canonical oracle identity")
  explicit.add(name)
  value={"directory":True} if x.get("directory") else {k:x[k] for k in ("bytes","sha256")}
  if name in want and want[name]!=value: raise AssertionError("Oracle file/directory collision")
  want[name]=value
  for parent in pathlib.PurePosixPath(name).parents:
   if str(parent)==".": continue
   key=str(parent)
   if key in want and want[key]!={"directory":True}: raise AssertionError("Oracle ancestor collision")
   want[key]={"directory":True}
 if actual!=want: raise AssertionError({"actual":actual,"expected":want})
 return actual

def decode(case,artifacts,dest,root,logs):
 options=case.get("options",{});fmt=options.get("format",case.get("family","")); password=options.get("password","")
 archive=next((p for p in artifacts if not p.name.endswith((".par2",".par3"))),None)
 if archive is None: raise ValueError("No created archive")
 raw=fmt.removeprefix("tar."); is_tar=fmt=="tar" or fmt.startswith("tar.")
 if raw in ("gz","gzip","bz2","bzip2","xz","lzma","zlib","deflate","zstd","zst","lz4","br","brotli"):
  data=archive.read_bytes()
  if raw in ("gz","gzip"): data=gzip.decompress(data)
  elif raw in ("bz2","bzip2"): data=bz2.decompress(data)
  elif raw in ("xz","lzma"): data=lzma.decompress(data)
  elif raw in ("zlib","deflate"): data=zlib.decompress(data,15 if raw=="zlib" else -15)
  else:
   tool={"zst":"zstd","brotli":"brotli","br":"brotli"}.get(raw,raw)
   proc=subprocess.run([tool,"-d","-c",str(archive)],capture_output=True,timeout=180)
   logs.append({"argv":[tool,"-d","-c",str(archive)],"exitCode":proc.returncode,"stderr":proc.stderr.decode(errors="replace")})
   if proc.returncode: raise AssertionError("Independent decoder failed")
   data=proc.stdout
  if is_tar:
   unpack_tar(data,dest)
  else:
   expected=[x for x in case["expected"] if not x.get("directory")]
   if len(expected)!=1: raise AssertionError("Raw stream oracle requires one file")
   path=dest/str(safe(expected[0]["name"]));path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
 elif fmt=="tar": unpack_tar(archive.read_bytes(),dest)
 else:
  args=["7zz","x","-y","-bd","-o"+str(dest),"-p"+(password or "__no_password__"),str(archive)]
  if password:
   wrong=command(["7zz","t","-bd","-p__wrong_password__",str(archive)],root);logs.append({"check":"wrong-password",**wrong})
   if wrong["exitCode"]==0 or not re.search("password|encrypted|data error",wrong["stdout"]+wrong["stderr"],re.I): raise AssertionError("Encryption not independently enforced")
   if fmt=="7z" or options.get("headerEncryption") or options.get("encryptHeaders"):
    hidden=command(["7zz","l","-slt","-p__wrong_password__",str(archive)],root);logs.append({"check":"header-privacy",**hidden})
    if hidden["exitCode"]==0: raise AssertionError("Encrypted header exposed without correct password")
   metadata=command(["7zz","l","-slt","-p"+password,str(archive)],root);logs.append({"check":"encryption-metadata",**metadata})
   if fmt=="zip" and not re.search(r"AES-256|AES : 256|AES256",metadata["stdout"],re.I): raise AssertionError("ZIP AES-256 metadata missing")
  if fmt=="7z":
   details=command(["7zz","l","-slt","-p"+(password or "__no_password__"),str(archive)],root);logs.append({"check":"codec-filter-solid-metadata",**details})
   text="\n".join(re.findall(r"^Method = (.*)$",details["stdout"],re.M))
   codec=options.get("codec","lzma2");label={"lzma2":"LZMA2","lzma":"LZMA","copy":"Copy","ppmd":"PPMD","bzip2":"BZip2","deflate":"Deflate","zstd":"(?:ZSTD|04F71101)","lz4":"(?:LZ4|04F71104)","brotli":"(?:Brotli|04F71102)"}.get(codec)
   if label and not re.search(r"(?<![A-Za-z0-9])"+label+r"(?![A-Za-z0-9])",text,re.I): raise AssertionError("Requested codec missing from independent metadata: "+codec)
   filter=options.get("filter","none");label={"x86":"BCJ","arm":"ARM","arm64":"ARM64","thumb":"ARMT","ia64":"IA64","sparc":"SPARC","ppc":"PPC","riscv":"RISCV","bcj2":"BCJ2","delta":"Delta"}.get(filter)
   if label and not re.search(r"(?<![A-Za-z0-9])"+re.escape(label)+r"(?![A-Za-z0-9])",text,re.I): raise AssertionError("Requested filter missing from independent metadata: "+filter)
   if filter=="delta" and not re.search(r"(?<![A-Za-z0-9])Delta:"+str(options.get("deltaDistance",1))+r"(?![0-9])",text,re.I): raise AssertionError("Requested Delta distance missing from independent metadata")
   if options.get("solid") and not re.search(r"^Solid = \+$",details["stdout"],re.M): raise AssertionError("Requested solid layout missing")
  result=command(args,root);logs.append(result)
  if result["exitCode"]:
   errors=[line for line in result["stderr"].splitlines() if line.strip()]
   unsupported=result["exitCode"]==2 and errors and all(line.startswith("ERROR: Unsupported Method : ") for line in errors)
   if not unsupported: raise AssertionError("Independent 7zz extraction failed")
   fallback=shutil.which("7z") if fmt=="7z" and options.get("codec") in ("zstd","lz4","brotli") else None
   if not fallback or pathlib.Path(fallback).resolve()==pathlib.Path(shutil.which("7zz") or "7zz").resolve():
    raise UnsupportedExternalDecoder("Installed 7zz does not decode this 7z method; no distinct supported fallback is available")
   # Keep failed primary-decoder artifacts separate from the independent retry.
   fallback_dest=dest.with_name(dest.name+"-fallback");fallback_dest.mkdir()
   executable=pathlib.Path(fallback).resolve()
   retry=command([str(executable),"x","-y","-bd","-o"+str(fallback_dest),"-p"+(password or "__no_password__"),str(archive)],root)
   logs.append({"check":"unsupported-method-fallback","primary":"7zz","decoderPath":str(executable),"decoderSHA256":sha(executable),**retry})
   if retry["exitCode"]: raise AssertionError("Independent fallback extraction failed")
   dest=fallback_dest
 return compare(dest,case["expected"])
def unpack_tar(data,dest):
 with tarfile.open(fileobj=io.BytesIO(data),mode="r:") as tar:
  for entry in tar:
   target=dest/str(safe(entry.name));target.parent.mkdir(parents=True,exist_ok=True)
   if entry.isdir(): target.mkdir(exist_ok=True)
   elif entry.isfile(): target.write_bytes(tar.extractfile(entry).read())
   else: raise AssertionError("Unexpected nonregular TAR member")

def recovery(case,artifacts,work,battery,logs):
 protected=case.get("protected",[])
 if not protected: raise ValueError("Parity oracle requires explicit protected sources")
 if any(p.suffix==".par3" for p in artifacts): raise ValueError("PAR3 creation is outside this creation battery scope")
 fmt="par2";tool="par2"
 for variant in ("healthy","corrupt","insufficient"):
  stage=work/variant;stage.mkdir()
  for item in protected:
   source=battery/str(safe(item["sourcePath"]));target=stage/str(safe(item["name"]));target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
   if source.stat().st_size!=item["bytes"] or sha(source)!=item["sha256"]: raise AssertionError("Protected source oracle mismatch")
  sidecars=[p for p in artifacts if p.suffix=="."+fmt]
  index=next(p for p in sidecars if ".vol" not in p.name)
  for p in sidecars:
   if variant!="insufficient" or p==index: shutil.copyfile(p,stage/p.name)
  if variant!="healthy":
   target=stage/str(safe(protected[0]["name"]))
   with target.open("r+b") as f:
    offset=min(1048576,target.stat().st_size//2);f.seek(offset);data=f.read(16);f.seek(offset);f.write(bytes(x^0x5a for x in data))
  verb="v" if variant=="healthy" else "r"
  result=command([tool,verb,index.name],stage);logs.append({"variant":variant,**result})
  matched=all((stage/str(safe(x["name"]))).stat().st_size==x["bytes"] and sha(stage/str(safe(x["name"])))==x["sha256"] for x in protected)
  if variant=="insufficient":
   if matched: raise AssertionError("Insufficient recovery unexpectedly restored data")
   text=result["stdout"]+result["stderr"]
   if not re.search(r"not enough|insufficient|need.+(?:recovery|blocks)|repair (?:is )?not possible|cannot repair|more recovery",text,re.I) or re.search(r"segmentation|abort|not found|invalid option|usage:|permission denied",text,re.I): raise AssertionError("Insufficient result lacks valid semantic diagnosis")
  elif not matched or result["exitCode"]: raise AssertionError("Independent recovery failed: "+variant)
 return {"healthy":True,"corruptRepairExact":True,"insufficientNotRestored":True}

def generated_zip(case,artifacts):
 spec=case["expectedGenerated"]
 if spec["kind"]!="indexed-byte-files": raise AssertionError("Unknown generated ZIP oracle")
 with zipfile.ZipFile(artifacts[0]) as archive:
  infos=archive.infolist()
  if len(infos)!=spec["count"]: raise AssertionError("ZIP64 entry count mismatch")
  seen=set()
  for index in range(spec["count"]):
   name=spec["prefix"]+str(index).zfill(spec["digits"])
   item=infos[index]
   if item.filename!=name or item.filename in seen: raise AssertionError("Generated ZIP path/order mismatch")
   seen.add(item.filename);data=archive.read(item)
   if data!=bytes([index%spec["modulus"]]): raise AssertionError("Generated ZIP byte/hash mismatch")
  with artifacts[0].open("rb") as f:
   f.seek(max(0,artifacts[0].stat().st_size-65557));tail=f.read()
  end=tail.rfind(b"PK\x05\x06")
  if end<0 or struct.unpack_from("<H",tail,end+10)[0]!=65535 or b"PK\x06\x07" not in tail[:end]: raise AssertionError("Automatic ZIP64 end records missing")
 return {"entries":len(infos),"allBytesCRCAndPathsVerified":True,"hostExtraction":False}

def main():
 parser=argparse.ArgumentParser();parser.add_argument("--battery-root",required=True,type=pathlib.Path);parser.add_argument("--evidence",required=True,type=pathlib.Path);parser.add_argument("--output-dir",required=True,type=pathlib.Path);a=parser.parse_args()
 a.output_dir.mkdir(parents=True,exist_ok=False);evidence=json.loads(a.evidence.read_text());results=[]
 for case in evidence["cases"]:
  if not case.get("artifacts") and case.get("kind")=="negative":
   results.append({"id":case["id"],"status":"NOT_APPLICABLE","reason":"No artifact expected; actual application rejection is checked in browser evidence"});continue
  result={"id":case["id"],"status":"FAIL","logs":[]};results.append(result)
  try:
   work=a.output_dir/str(safe(case["id"]));work.mkdir(parents=True)
   artifacts=[]
   for item in case["artifacts"]:
    p=a.battery_root/str(safe(item["path"]))
    if p.stat().st_size!=item["bytes"] or sha(p)!=item["sha256"]: raise AssertionError("Created artifact digest mismatch")
    artifacts.append(p)
   if case.get("expectedGenerated"): result["generatedZip"]=generated_zip(case,artifacts)
   if case.get("protected"): result["recovery"]=recovery(case,artifacts,work,a.battery_root,result["logs"])
   if not case.get("expectedGenerated") and (not case.get("protected") or case.get("nestedExpected")):
    dest=work/"decoded";dest.mkdir();decode_case={**case,"expected":case.get("nestedExpected",case["expected"])};result["files"]=decode(decode_case,artifacts,dest,work,result["logs"])
   result["status"]="PASS"
  except UnsupportedExternalDecoder as error: result["status"]="UNSUPPORTED_EXTERNAL_DECODER";result["error"]=str(error)
  except Exception as error: result["error"]=str(error)
  (a.output_dir/"evidence.json").write_text(json.dumps({"scope":"Independent retained app-creation verification","cases":results},indent=2))
 print(json.dumps({"pass":sum(x["status"]=="PASS" for x in results),"fail":sum(x["status"]=="FAIL" for x in results),"unsupportedExternalDecoder":sum(x["status"]=="UNSUPPORTED_EXTERNAL_DECODER" for x in results),"notApplicable":sum(x["status"]=="NOT_APPLICABLE" for x in results)}))
 return int(any(x["status"] in ("FAIL","UNSUPPORTED_EXTERNAL_DECODER") for x in results))
if __name__=="__main__": raise SystemExit(main())
