import esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const outdir = "test-vault/.obsidian/plugins/dc-wiring";
mkdirSync(outdir, { recursive: true });
// the test vault gets a working copy; main.js in the project root is the file a release ships
const copy = { name: "copy", setup(b) { b.onEnd(() => {
  for (const f of ["manifest.json", "styles.css"]) cpSync(f, `${outdir}/${f}`);
  cpSync(`${outdir}/main.js`, "main.js");
}); } };

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2020",
  external: ["obsidian", "electron"],
  loader: { ".png": "dataurl", ".woff2": "dataurl" }, // DC fonts and logo for exported reports
  outfile: `${outdir}/main.js`,
  plugins: [copy],
  logLevel: "info",
});
if (process.argv[2] === "watch") await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
