import fs from 'fs';
const file = 'src/components/ui/custom/CharacterCardRenderer.tsx';
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// 1) collect top-level declarations (col 0) with name + start line
const declRe = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const decls = [];
for (let i = 0; i < lines.length; i++) {
  const m = declRe.exec(lines[i]);
  if (m) decls.push({ name: m[1], start: i + 1 });
}
decls.sort((a, b) => a.start - b.start);
// assign end = next decl start - 1 (approx; good enough for call analysis)
for (let i = 0; i < decls.length; i++) {
  decls[i].end = (i + 1 < decls.length ? decls[i + 1].start - 1 : lines.length);
}
const byName = new Map(decls.map(d => [d.name, d]));

// 2) candidate cluster ranges (1-indexed inclusive)
const clusters = {
  'THEME/VIEWPORT (L501-836)': [501, 836],
  'HTML-DETECT (L221-336)': [221, 336],
  'HTML-EXTRACT (L836-1166)': [836, 1166],
  'STORAGE (L1176-1287)': [1176, 1287],
  'SCRIPT-NORM (L1287-1647)': [1287, 1647],
  'RESOURCE (L1647-2100)': [1647, 2100],
  'ADAPTER/CSS (L2100-2367)': [2100, 2367],
};
const inRange = (n, [s, e]) => n >= s && n <= e;

for (const [cname, [s, e]] of Object.entries(clusters)) {
  // collect external calls: identifiers used within [s,e] that are declared outside
  const seg = lines.slice(s - 1, e).join('\n');
  const ext = new Set();
  for (const [name, d] of byName) {
    if (inRange(d.start, [s, e])) continue; // local
    // find usage of name as a call or reference (word boundary)
    const re = new RegExp('\b' + name + '\b', 'g');
    let m;
    while ((m = re.exec(seg)) !== null) {
      // exclude the declaration line itself if name appears (e.g., re-decl) - skip
      ext.add(name);
    }
  }
  // also report which clusters each external belongs to
  const grouped = {};
  for (const name of ext) {
    const d = byName.get(name);
    let owner = 'IMPORTED/other';
    for (const [cn, [cs, ce]] of Object.entries(clusters)) {
      if (inRange(d.start, [cs, ce])) { owner = cn; break; }
    }
    if (owner === 'IMPORTED/other') owner = `line${d.start}`;
    (grouped[owner] = grouped[owner] || []).push(name);
  }
  console.log(`\n### ${cname}`);
  for (const [owner, names] of Object.entries(grouped)) {
    const uniq = [...new Set(names)];
    if (uniq.length === 0) continue;
    console.log(`  -> ${owner}: ${uniq.join(', ')}`);
  }
}
