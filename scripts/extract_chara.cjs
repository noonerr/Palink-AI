const fs = require('fs');
const pkg = require('png-chunks-extract');
const extract = pkg.extract || pkg;
const buf = fs.readFileSync(process.argv[2]);
const chunks = extract(buf);
for (const c of chunks) {
  if (c.name === 'tEXt') {
    const t = Buffer.from(c.data).toString('latin1');
    const nul = t.indexOf('\0');
    console.log('tEXt nulIndex=', nul, 'totalLen=', t.length);
    if (nul >= 0) {
      const key = t.slice(0, nul);
      console.log('  key=', JSON.stringify(key));
      if (key === 'chara') {
        const json = t.slice(nul + 1);
        fs.writeFileSync(process.argv[3], json);
        console.log('  WROTE chara', json.length);
      }
    }
  }
}
console.log('DONE');