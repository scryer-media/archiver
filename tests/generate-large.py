from pathlib import Path
import hashlib,shutil,subprocess,sys
root=Path(sys.argv[1] if len(sys.argv)>1 else "/tmp/archive-repair-verification")
root.mkdir(parents=True,exist_ok=False)
(root/"original").mkdir();(root/"damaged").mkdir()
original=root/"original/large.bin"
with original.open("wb") as output:
    for index in range(300):output.write(hashlib.shake_256(("archive-verification-block-"+str(index)).encode()).digest(1048576))
damaged=root/"damaged/large.bin";shutil.copyfile(original,damaged)
with damaged.open("r+b") as output:
    output.seek(173*1048576+12345);output.write(b"damaged-repair-verification"*4)
subprocess.run(["par2","create","-q","-s1048576","-c4","large.par2","large.bin"],cwd=root/"original",check=True)
print("Prepared 300 MiB nontrivial original, damaged copy and independent PAR2 under",root)
