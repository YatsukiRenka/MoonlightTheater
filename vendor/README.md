# Vendored SHA-256

`noble-sha256.mjs` contains the SHA-256 export from `@noble/hashes@2.0.1`. The bundle header carries the upstream MIT license. It is a local browser ES module, so deployment uses no CDN or npm install step. [Pinned upstream source](https://github.com/paulmillr/noble-hashes/tree/d30e0707258f4cf0d4fb5dd6062436f8c1e997eb)

The source archives are from the official npm registry. Their published SHA-512 integrity values are recorded here for verification before bundling.

| npm archive | Integrity |
| --- | --- |
| `noble-hashes-2.0.1.tgz` | `sha512-XlOlEbQcE9fmuXxrVTXCTlG2nlRXa9Rj3rr5Ue/+tX+nmkgbX720YHh0VR3hBF9xDvwnb8D2shVGOwNx+ulArw==` |
| `esbuild-linux-x64-0.25.12.tgz` | `sha512-uqZMTLr/zR/ed4jIGnwSLkaHmPjOjJvnm6TVVitAa08SLS9Z0VM8wIRx7gWbJB5/J54YuIMInDquWyYvQLZkgw==` |

To reproduce the file on Linux x64, run the following in an empty temporary directory. Use `openssl dgst -sha512 -binary <archive> | openssl base64 -A` for the integrity comparison.

```sh
npm --registry https://registry.npmjs.org pack @noble/hashes@2.0.1 @esbuild/linux-x64@0.25.12
mkdir -p noble esbuild
tar -xzf noble-hashes-2.0.1.tgz -C noble
tar -xzf esbuild-linux-x64-0.25.12.tgz -C esbuild
printf "%s\n" "export { sha256 } from './noble/package/sha2.js';" > entry.mjs
esbuild/package/bin/esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2022 --tree-shaking=true --legal-comments=inline --charset=utf8 --outfile=noble-sha256.body.mjs
node --input-type=module - <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
const copyright = readFileSync('noble/package/LICENSE', 'utf8').trimEnd();
const banner = '/*! @noble/hashes@2.0.1 SHA-256 (MIT), generated with esbuild@0.25.12.\n' +
  ' * Source: https://github.com/paulmillr/noble-hashes/tree/d30e0707258f4cf0d4fb5dd6062436f8c1e997eb\n *\n' +
  copyright.split('\n').map(line => line ? ' * ' + line : ' *').join('\n') + '\n */\n';
writeFileSync('noble-sha256.mjs', banner + readFileSync('noble-sha256.body.mjs', 'utf8'));
NODE
```

Compare the resulting `noble-sha256.mjs` with the checked-in file before replacing it.
