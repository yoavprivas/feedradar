"""Run only on an authenticated, ephemeral GitHub Linux runner. Never log secrets."""
import os, pathlib, subprocess, tempfile, urllib.parse, datetime, re

PROJECT = 'project-43592e87-a1ec-43b7-bb4'
POSTGRES = 'postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'

def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        error = result.stderr.decode(errors='replace')
        error = re.sub(r'postgres(?:ql)?://\S+|ya29\.[\w.-]+|eyJ[\w.-]+', '[redacted]', error)
        raise RuntimeError('Backup operation failed: ' + args[0] + ': ' + error[:2500])
    return result.stdout

if os.environ.get('GCP_PROJECT_ID') != PROJECT:
    raise RuntimeError('Wrong project')
bucket = os.environ['BACKUP_BUCKET']
if bucket != 'feedradar-backups-' + PROJECT:
    raise RuntimeError('Unexpected backup destination')
with tempfile.TemporaryDirectory() as temp:
    folder = pathlib.Path(temp)
    url = urllib.parse.urlsplit(run(['gcloud','secrets','versions','access','latest','--secret=feedradar-database-url','--project='+PROJECT]).decode().strip())
    env = dict(os.environ, PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGDATABASE=url.path.lstrip('/'), PGUSER=urllib.parse.unquote(url.username), PGPASSWORD=urllib.parse.unquote(url.password), PGSSLMODE='verify-full', PGSSLROOTCERT='/certs/supabase-ca.crt')
    args = ['docker','run','--rm']
    for name in ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT']:
        args += ['--env',name]
    args += ['--mount','type=bind,source='+str(pathlib.Path('backend/certs').resolve())+',target=/certs,readonly', POSTGRES, 'pg_dump','--format=custom','--schema=feedradar','--no-owner','--no-privileges']
    dump = run(args,env=env,timeout=300)
    raw = folder/'database.dump'; raw.write_bytes(dump)
    public = folder/'public.pem'; public.write_text(os.environ['BACKUP_PUBLIC_KEY'])
    encrypted = folder/'database.enc'
    run(['node','scripts/backup-crypto.mjs','encrypt',str(raw),str(public),str(encrypted)])
    raw.unlink()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
    destination = 'gs://'+bucket+'/'+stamp+'-'+os.environ.get('GITHUB_RUN_ID','manual')+'.enc'
    run(['gcloud','storage','cp',str(encrypted),destination,'--project='+PROJECT],timeout=120)
    print('Encrypted backup uploaded:',destination,'bytes:',encrypted.stat().st_size)
