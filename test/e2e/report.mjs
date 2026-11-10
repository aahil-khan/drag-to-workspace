// Prints the outcome of an e2e run. Fails on any failed check, a missing results file,
// or any JS error in the shell log.
import {existsSync, readFileSync} from 'node:fs';

const [resultsPath, logPath] = process.argv.slice(2);
const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
// Any JS error counts, even with a shell-only stack: an extension can cause those too.
const lines = log.split('\n');
const jsErrors = [];
// DTW_KNOWN_ERROR names a bug shown to happen on that distro with the extension off.
const known = process.env.DTW_KNOWN_ERROR;
lines.forEach((line, i) => {
    if (line.includes('JS ERROR') && !(known && line.includes(known)))
        jsErrors.push(lines.slice(i, i + 4).join('\n'));
});

if (!existsSync(resultsPath)) {
    console.error(`no results at ${resultsPath}: the shell died or timed out. Last of the log:`);
    console.error(log.split('\n').slice(-30).join('\n'));
    process.exit(1);
}

const {scenario, crash, results} = JSON.parse(readFileSync(resultsPath, 'utf8'));
let failed = 0;
console.log(`\n== ${scenario} ==`);
for (const r of results) {
    console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}`);
    if (!r.ok) {
        failed++;
        console.log(`      ${r.message}`);
    }
}
if (crash) {
    failed++;
    console.log(`CRASH ${crash}`);
}
if (jsErrors.length) {
    failed++;
    console.log(`${jsErrors.length} JS errors in the shell log. First few:`);
    jsErrors.slice(0, 4).forEach(error => console.log(error));
}
console.log(`${results.length - results.filter(r => !r.ok).length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
