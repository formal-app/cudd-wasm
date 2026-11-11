// The SPIKE.md measurements: artefact sizes, Node init time, and per-benchmark
// native and WebAssembly times. Run ./build.sh first, then: node test/measure.mjs
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gzip9 = (path) => execFileSync("sh", ["-c", `gzip -9 -c "${path}" | wc -c`], { encoding: "utf8" }).trim() * 1;

const sizes = {};
for (const [name, path] of [["wasm", "build/wasm/spike.wasm"], ["glue", "build/wasm/spike.mjs"]])
  sizes[name] = { raw: statSync(root + path).size, gzip9: gzip9(root + path) };

// Init time: a fresh Node process each time, from importing the glue to the
// module being ready, so every run pays the full compile and instantiate.
const initScript = `
  const t0 = performance.now();
  const { default: createModule } = await import(${JSON.stringify(root + "build/wasm/spike.mjs")});
  await createModule();
  console.log(performance.now() - t0);`;
const inits = Array.from({ length: 10 }, () =>
  Number(execFileSync(process.execPath, ["--input-type=module", "-e", initScript], { encoding: "utf8" })));

// Each harness reports the median of five repetitions per benchmark.
const native = JSON.parse(execFileSync(`${root}build/native/spike`, { encoding: "utf8" }));
const { default: createModule } = await import(`${root}build/wasm/spike.mjs`);
const m = await createModule();
const wasm = JSON.parse(m.UTF8ToString(m._spike_run()));
const benchmarks = Object.fromEntries(Object.keys(native.timesMs).map((b) => [b, {
  nativeMs: native.timesMs[b], wasmMs: wasm.timesMs[b], ratio: +(wasm.timesMs[b] / native.timesMs[b]).toFixed(2),
}]));

console.log(JSON.stringify({ sizes, nodeInitMs: { median: +median(inits).toFixed(1), runs: inits.map((x) => +x.toFixed(1)) }, benchmarks }, null, 2));
