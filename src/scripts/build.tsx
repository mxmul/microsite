require = require("esm")(module);

import { join, resolve, sep, extname, dirname } from "path";
import { OutputOptions, rollup } from "rollup";
import glob from "globby";

import { default as postcss } from "rollup-plugin-postcss";
import { default as typescript } from "@rollup/plugin-typescript";
import { default as nodeResolve } from "@rollup/plugin-node-resolve";
import { default as alias } from "@rollup/plugin-alias";

import { Document } from "../document";
import React from "preact/compat";
import render from "preact-render-to-string";
import { promises as fsp } from "fs";
const { readdir, readFile, rmdir, writeFile, mkdir, copyFile, stat } = fsp;

const ROOT_DIR = join(process.cwd(), "src");

// const _vnode = options.vnode;
// options.vnode = vnode => {
//   if (vnode.type && (vnode.type as any).hydrate) {
//   }

//   if (_vnode) {
//     _vnode(vnode);
//   }
// }

const requiredPlugins = [
  alias({
    entries: [
      { find: /^@\/(.*)/, replacement: join(ROOT_DIR, "$1.js") },
      { find: "react/jsx-runtime", replacement: "preact/jsx-runtime" },
      { find: "react", replacement: "preact/compat" },
      { find: "react-dom", replacement: "preact/compat" },
    ],
  }),
  nodeResolve({
    mainFields: ["module", "main"],
    dedupe: ["preact/compat"],
  }),
];

const globalPlugins = [
  postcss({
    config: true,
    inject: false,
    extract: true,
    minimize: true,
    sourceMap: false,
  }),
];

const createPagePlugins = () => [
  postcss({
    config: true,
    inject: false,
    extract: true,
    minimize: true,
    modules: {
      generateScopedName: "[hash:base64:5]",
    },
    sourceMap: false,
  }),
];

const OUTPUT_DIR = "./.tmp/microsite";

const outputOptions: OutputOptions = {
  format: "esm",
  sourcemap: false,
};

const internalRollupConfig = {
  external: [
    "microsite/head",
    "microsite/document",
    "microsite",
    "preact/compat",
    "preact/jsx-runtime",
    "preact-render-to-string",
  ],
  treeshake: true,
  onwarn(message) {
    if (/empty chunk/.test(message)) return;
    console.error(message);
  },
};

async function writeGlobal() {
  const global = await rollup({
    ...internalRollupConfig,
    plugins: [
      ...requiredPlugins,
      typescript({ target: "ES2018" }),
      ...globalPlugins,
    ],
    input: "src/global.ts",
  });
  const legacy = await rollup({
    ...internalRollupConfig,
    plugins: [
      ...requiredPlugins,
      typescript({ target: "ES5" }),
      ...globalPlugins,
    ],
    input: "src/global.ts",
  });

  try {
    return Promise.all([
      global.write({
        format: "esm",
        sourcemap: false,
        dir: OUTPUT_DIR,
        name: "global",
      }),
      legacy.write({
        format: "system",
        sourcemap: false,
        file: join(OUTPUT_DIR, "global.legacy.js"),
      }),
    ]);
  } catch (e) {
    console.log(e);
  }
}

async function writePages() {
  try {
    const pages = await glob(["src/pages/**/*.tsx"]);
    const bundles = await Promise.all(
      pages.map((input) =>
        rollup({
          ...internalRollupConfig,
          plugins: [
            ...requiredPlugins,
            typescript({ target: "ES2018" }),
            ...createPagePlugins(),
          ],
          input,
        })
      )
    );

    const result = Promise.all(
      bundles.map((bundle, i) =>
        bundle.write({
          ...outputOptions,
          dir: pages[i]
            .replace(/^src/, OUTPUT_DIR)
            .split(sep)
            .slice(0, -1)
            .join(sep),
        })
      )
    );
    return result;
  } catch (e) {
    console.log(e);
  }
}

async function readDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? readDir(join(dir, entry.name))
        : join(dir, entry.name)
    )
  ).then((arr) => arr.flat(Infinity));
}

async function prepare() {
  const paths = ["./dist", "./.tmp/microsite"];
  await Promise.all(paths.map((p) => rmdir(p, { recursive: true })));
  await Promise.all(paths.map((p) => mkdir(p, { recursive: true })));

  if ((await stat("./src/public")).isDirectory()) {
    const files = await readDir("./src/public");
    await Promise.all(
      files.map((file) =>
        copyFile(
          resolve(process.cwd(), file),
          resolve(process.cwd(), "./dist/" + file.slice("src/public/".length))
        )
      )
    );
  }
}

async function cleanup() {
  const paths = ["./.tmp/microsite"];
  await Promise.all(paths.map((p) => rmdir(p, { recursive: true })));
  if ((await readDir("./.tmp")).length === 0) {
    await rmdir("./.tmp");
  }
}

export async function build() {
  await prepare();
  await Promise.all([writeGlobal(), writePages()]);

  const globalStyle = await readFile("./.tmp/microsite/global.css").then((v) =>
    v.toString()
  );
  const hasGlobalScript = await readFile("./.tmp/microsite/global.js").then(
    (v) => !!v.toString().trim()
  );

  if (hasGlobalScript) {
    await Promise.all([
      copyFile(resolve("./.tmp/microsite/global.js"), "dist/index.js"),
      copyFile(
        resolve("./.tmp/microsite/global.legacy.js"),
        "dist/index.legacy.js"
      ),
    ]);
  }

  const files = await readDir("./.tmp/microsite/pages");
  const getName = (f) =>
    f.slice(f.indexOf("pages/") + "pages/".length - 1, extname(f).length * -1);
  const styles: any[] = await Promise.all(
    files
      .filter((f) => f.endsWith(".css"))
      .map((f) =>
        readFile(f).then((buff) => ({
          __name: getName(f),
          content: buff.toString(),
        }))
      )
  );
  const pages: any[] = await Promise.all(
    files
      .filter((f) => f.endsWith(".js"))
      .map((f) =>
        import(join(process.cwd(), f)).then((mod) => ({
          ...mod,
          __name: getName(f),
        }))
      )
  );

  const output = [];
  for (const page of pages) {
    const { Page, __name } = page;
    const { content: style = null } =
      styles.find((style) => style.__name === __name) || {};

    try {
      output.push({
        name: __name,
        content:
          "<!DOCTYPE html>\n" +
          render(
            <Document
              render={render}
              hasScripts={hasGlobalScript}
              styles={[globalStyle, style].filter((v) => v)}
            >
              <Page />
            </Document>,
            {},
            { pretty: true }
          ),
      });
    } catch (e) {
      console.log(`Error building ${__name}`);
      console.error(e);
      return;
    }
  }

  await Promise.all(
    output.map(({ name, content }) =>
      mkdir(resolve(`./dist/${dirname(name)}`), { recursive: true }).then(() =>
        writeFile(resolve(`./dist/${name}.html`), content)
      )
    )
  );
  await cleanup();
}