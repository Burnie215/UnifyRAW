import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The shipped containers are the product's default deployment: the README tells
 * a stranger to copy .env.example and run `docker compose up -d --build`. Two
 * properties of that deployment are asserted here because nothing else sees
 * them — no test imports a Dockerfile, and a missing line is silent until
 * someone reads the file:
 *   - the decoders (libraw, exiftool, libvips) do not run as root, and the
 *     container cannot write outside its volumes,
 *   - the compose files carry no infrastructure of whoever wrote them.
 *
 * There are two compose files. docker-compose.proxy.yml defines the app service
 * in full, for running behind a reverse proxy the user already has.
 * docker-compose.yml puts Caddy in front for the home network and inherits the
 * app service from the other file through `extends` - so the hardening lives in
 * one place, and the Caddy file is checked for not weakening it.
 *
 * Paths are relative to the repository root, which is vitest's working
 * directory (same as src/licenses/thirdParty.test.ts).
 */
const dockerfile = readFileSync('Dockerfile', 'utf8');
const proxyCompose = readFileSync('docker-compose.proxy.yml', 'utf8');
const caddyCompose = readFileSync('docker-compose.yml', 'utf8');
const caddyfile = readFileSync('docker/selfhost/Caddyfile', 'utf8');
const gitignore = readFileSync('.gitignore', 'utf8');
const readme = readFileSync('README.md', 'utf8');

/** The text of one top-level service block, up to the next one or the volumes. */
function serviceBlock(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no service ${name}`);
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('the shipped backend container', () => {
  it('drops to uid 1000 before the entrypoint and owns its data volume', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/chown node:node \/data/);
    expect(dockerfile.indexOf('USER node')).toBeLessThan(dockerfile.indexOf('CMD ['));
  });

  it('runs without capabilities, without new privileges and on a read-only root', () => {
    expect(proxyCompose).toMatch(/^\s*read_only: true$/m);
    expect(proxyCompose).toMatch(/^\s*cap_drop:\n\s*- ALL$/m);
    expect(proxyCompose).toMatch(/no-new-privileges:true/);
  });

  it('keeps the two writable scratch paths the RAW decode needs', () => {
    // RAW_TMPDIR prefers /dev/shm (shm_size) and falls back to os.tmpdir().
    expect(proxyCompose).toMatch(/^\s*tmpfs:\n\s*- \/tmp:size=/m);
    expect(proxyCompose).toMatch(/^\s*shm_size:/m);
  });

  // One definition of the app service. A second copy in the Caddy file would
  // drift - and the drift that matters is a hardening line going missing.
  it('is inherited by the Caddy variant, not restated and not weakened', () => {
    const app = serviceBlock(caddyCompose, 'photolib');
    expect(app).toMatch(/extends:\n\s*file: docker-compose\.proxy\.yml\n\s*service: photolib/);
    expect(app).not.toMatch(/read_only|cap_drop|cap_add|security_opt|privileged|user:/);
  });

  // With Caddy in front, the only way in from the network is HTTPS. The app port
  // stays on loopback for the host itself, where the browser counts it as secure.
  it('publishes the app only on loopback when Caddy is in front', () => {
    const app = serviceBlock(caddyCompose, 'photolib');
    expect(app).toMatch(/ports: !override\n\s*- "127\.0\.0\.1:3000:3000"/);
    expect(app).toMatch(/TRUST_PROXY: "1"/);
  });
});

describe('the Caddy in front', () => {
  const https = serviceBlock(caddyCompose, 'https');

  it('runs without capabilities beyond binding ports 80 and 443, read-only, without new privileges', () => {
    expect(https).toMatch(/cap_drop:\n\s*- ALL\n/);
    expect(https).toMatch(/cap_add:\n\s*- NET_BIND_SERVICE\n(?!\s*- )/);
    expect(https).toMatch(/no-new-privileges:true/);
    expect(https).toMatch(/read_only: true/);
  });

  // The certificate authority lives in Caddy's data directory. In a container
  // path it would be gone with the container, and every device would have to
  // trust a new root.
  it('keeps its certificate authority in a named volume', () => {
    expect(https).toMatch(/- caddy-data:\/data\n/);
    expect(caddyCompose).toMatch(/^volumes:\n(?:\s+[\w-]+:\n)*\s+caddy-data:/m);
  });

  it('pins its image to an exact version', () => {
    expect(https).toMatch(/image: caddy:\d+\.\d+\.\d+-alpine\n/);
  });

  // Browsers send no server name (SNI) when the address is an IP. Without a
  // default, Caddy finds no certificate for exactly the case this file is for.
  it('serves IP clients that send no server name', () => {
    expect(caddyfile).toMatch(/^\s*default_sni \{\$UNIFYRAW_HOST\}$/m);
    expect(caddyfile).toMatch(/^\s*local_certs$/m);
    expect(caddyfile).toMatch(/^\{\$UNIFYRAW_HOST\} \{\n\s*reverse_proxy photolib:3000\n\}/m);
  });

  it('refuses to start without the address it is meant to serve', () => {
    expect(https).toMatch(/UNIFYRAW_HOST: "\$\{UNIFYRAW_HOST:\?/);
  });
});

describe('the product compose files', () => {
  const files: Array<[string, string]> = [
    ['docker-compose.proxy.yml', proxyCompose],
    ['docker-compose.yml', caddyCompose],
    ['docker/selfhost/Caddyfile', caddyfile],
  ];

  it.each(files)('%s names no resolver, search domain or address of the author', (_name, text) => {
    expect(text).not.toMatch(/^\s*dns:/m);
    expect(text).not.toMatch(/dns_search/);
    expect(text).not.toMatch(/beseb/);
    const addresses = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
    expect(addresses.filter((address) => address !== '127.0.0.1')).toEqual([]);
  });

  it('probes the backend health endpoint over explicit IPv4 loopback', () => {
    expect(proxyCompose).toContain('http://127.0.0.1:3000/api/health');
    expect(proxyCompose).not.toContain('http://localhost:3000/api/health');
  });

  it('has a documented, gitignored place for exactly that', () => {
    expect(gitignore).toMatch(/^docker-compose\.override\.yml$/m);
    expect(readme).toMatch(/docker-compose\.override\.yml/);
    expect(readme).toMatch(/chown -R node:node \/data/);
  });
});
