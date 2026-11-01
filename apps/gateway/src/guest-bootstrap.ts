// This program is delivered as a file to one exact remote ID. Neither the guest
// credential nor the signed download URL appears in a command or its output.
export const bootstrapPython = String.raw`import hashlib,json,os,pathlib,shutil,subprocess,tarfile,tempfile,urllib.request
bootstrap=pathlib.Path('/home/user/.config/kittyd-bootstrap')
manifest=json.loads((bootstrap/'artifact.json').read_text())
work=pathlib.Path(tempfile.mkdtemp(prefix='kittyd-'))
try:
    archive=work/'bundle.tgz'
    with urllib.request.urlopen(urllib.request.Request(manifest['url'],headers={'User-Agent':'Kitties bootstrap'}),timeout=120) as source,archive.open('wb') as target:
        shutil.copyfileobj(source,target)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=manifest['sha256']:raise RuntimeError('Release checksum mismatch')
    with tarfile.open(archive) as bundle:bundle.extractall(work,filter='data')
    env=dict(os.environ,KITTYD_BUNDLE=str(work))
    subprocess.run(['/bin/sh',str(work/'install.sh')],env=env,check=True)
finally:
    shutil.rmtree(work)
`;
export const prepareBootstrap =
  "sudo install -d -o user -g user -m 0700 /home/user/.config/kittyd-bootstrap && sudo touch /home/user/.config/kittyd-bootstrap/config.json /home/user/.config/kittyd-bootstrap/artifact.json /home/user/.config/kittyd-bootstrap/bootstrap.py && sudo chown user:user /home/user/.config/kittyd-bootstrap/config.json /home/user/.config/kittyd-bootstrap/artifact.json /home/user/.config/kittyd-bootstrap/bootstrap.py && sudo chmod 0600 /home/user/.config/kittyd-bootstrap/config.json /home/user/.config/kittyd-bootstrap/artifact.json /home/user/.config/kittyd-bootstrap/bootstrap.py";
export const executeBootstrap = "sudo python3 /home/user/.config/kittyd-bootstrap/bootstrap.py";
