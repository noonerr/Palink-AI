// ST 1.18.0 character-card PNG round-trip harness.
// Runs INSIDE the sillytavern container using ST's own parser code.
//
// Usage (inside container):
//   node st_card_roundtrip.mjs <base_png> <card_json> <out_dir>
//
// Produces in <out_dir>:
//   st_out.png            ST write() output for card_json over base_png
//   st_parsed.json        ST read(st_out.png)          -> JSON string, re-parsed
//   st_reads_palink.json  ST read(palink_out.png)      -> if palink_out.png exists
//   st_chunks.json        tEXt chunk keyword/order listing for st_out.png
//
// Exit non-zero on any hard failure so the orchestrator can detect it.

import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { write, read } from './src/character-card-parser.js';

function listTextChunks(buf) {
    const chunks = extract(new Uint8Array(buf));
    const order = chunks.map((c) => c.name);
    const texts = chunks
        .filter((c) => c.name === 'tEXt')
        .map((c) => {
            const d = PNGtext.decode(c.data);
            return { keyword: d.keyword, text_len: (d.text || '').length };
        });
    // index of IEND vs the chara/ccv3 chunks (must be before IEND)
    const iendIdx = order.lastIndexOf('IEND');
    const textIdxs = chunks
        .map((c, i) => ({ name: c.name, i }))
        .filter((x) => x.name === 'tEXt')
        .map((x) => x.i);
    return { chunk_order: order, text_chunks: texts, iend_index: iendIdx, text_indexes: textIdxs };
}

function main() {
    const [basePng, cardJson, outDir] = process.argv.slice(2);
    if (!basePng || !cardJson || !outDir) {
        console.error('usage: node st_card_roundtrip.mjs <base_png> <card_json> <out_dir>');
        process.exit(2);
    }
    fs.mkdirSync(outDir, { recursive: true });

    const image = fs.readFileSync(basePng);
    const cardStr = fs.readFileSync(cardJson, 'utf8');

    // ST write(): data is the JSON string exactly as the server would pass it.
    const stOut = write(image, cardStr);
    const stOutPath = path.join(outDir, 'st_out.png');
    fs.writeFileSync(stOutPath, stOut);

    // ST read() its own output
    const stParsedStr = read(stOut);
    fs.writeFileSync(path.join(outDir, 'st_parsed.json'), stParsedStr);

    // chunk layout
    fs.writeFileSync(path.join(outDir, 'st_chunks.json'), JSON.stringify(listTextChunks(stOut), null, 2));

    // If Palink produced its PNG, verify ST can read it.
    const palinkPng = path.join(outDir, 'palink_out.png');
    if (fs.existsSync(palinkPng)) {
        try {
            const buf = fs.readFileSync(palinkPng);
            const parsed = read(buf);
            fs.writeFileSync(path.join(outDir, 'st_reads_palink.json'), parsed);
            fs.writeFileSync(path.join(outDir, 'palink_chunks.json'), JSON.stringify(listTextChunks(buf), null, 2));
        } catch (e) {
            fs.writeFileSync(path.join(outDir, 'st_reads_palink.error'), String(e && e.stack || e));
            console.error('ST failed to read palink_out.png:', e);
            process.exitCode = 3;
        }
    }
    console.log('ST round-trip done ->', outDir);
}

main();
