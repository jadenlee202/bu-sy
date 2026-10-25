import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";

function stylesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? stylesIn(path) : entry.name.endsWith(".css") ? [path] : [];
  });
}

const files = process.argv.slice(2);
if (!files.length) files.push(...stylesIn("web"), ...stylesIn("tools"));
for (const file of files) {
  try {
    const css = readFileSync(file, "utf8");
    const conflict = /^(?:<{7}|={7}|>{7}|\|{7})(?:.*)$/m.exec(css);
    if (conflict) {
      const line = css.slice(0, conflict.index).split("\n").length;
      throw new Error(`${file}:${line}: unresolved merge-conflict marker`);
    }
    // Use the strict parser, never the error-recovering safe parser used by editors.
    postcss.parse(css, { from: resolve(file) });
    console.log(`CSS OK: ${file}`);
  } catch (error) {
    console.error(error.toString());
    process.exitCode = 1;
  }
}
