import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// Where the running copy of Omnicord lives, and moving it somewhere that
// lasts.
//
// `npx @orygn/omnicord init` runs the wizard out of npm's npx cache, a
// folder npm treats as disposable: `npm cache npx rm` empties it, and so
// does deleting the npm cache folder or a disk cleanup tool. The wizard
// used to register that path with the AI client as-is, so the client
// worked until the folder went away and then failed on every start with
// "Cannot find module", which desktop clients show as "Server
// disconnected". It also froze the client on whatever version npx had
// fetched, because nothing ever updates that folder.
//
// The wizard now copies the package out of the cache before registering
// it, and the server warns at startup when a client still points into the
// cache. `npm cache clean --force` is not one of the causes: it removes
// only npm's _cacache folder and leaves _npx alone.

// True when the path is inside npm's npx cache. Splits on both separators
// so a Windows path is recognized wherever the check runs, and matches the
// whole folder name so a directory merely containing "_npx" does not count.
export function inNpxCache(path: string): boolean {
  return path.split(/[\\/]/).includes("_npx");
}

// npm exec, which is what npx runs, marks every process it starts with
// npm_command=exec. A client configured with `npx -y @orygn/omnicord`
// therefore runs from the cache legitimately: npx reinstalls there on
// demand. Only a config naming the cached file directly is fragile.
export function launchedByNpx(env: NodeJS.ProcessEnv): boolean {
  return env.npm_command === "exec";
}

// The warning for a client that points straight at a file in the npx
// cache, or undefined when there is nothing to warn about.
export function npxCacheWarning(
  packageRoot: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (!inNpxCache(packageRoot) || launchedByNpx(env)) return undefined;
  return (
    `Omnicord is running from npm's npx cache (${packageRoot}), which npm ` +
    "does not keep. When that folder is cleared, your AI client will fail " +
    'to start Omnicord and show "Server disconnected". Run ' +
    "`npx @orygn/omnicord@latest init` and choose to re-register, which " +
    "moves Omnicord to a permanent folder."
  );
}

// The node_modules folder a package was installed into: the nearest
// ancestor with that name, or undefined for a source checkout.
export function installedNodeModules(packageRoot: string): string | undefined {
  let dir = packageRoot;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    if (basename(parent) === "node_modules") return parent;
    dir = parent;
  }
}

export interface StableCopy {
  // The dist/index.js inside the copy, which is what a client should run.
  entry: string;
  // False when this version was already in place and nothing was copied.
  copied: boolean;
}

// Copies the installed package to <home>/app/<version> and returns the
// entry file inside the copy. The whole node_modules tree comes along, not
// the package alone, because npm installs dependencies beside the package
// rather than inside it. A version already in place is reused, and each
// version gets its own folder so a client still pointing at an older one
// keeps working. The copy is made under a temporary name and renamed into
// place, so an interrupted run never leaves a half-copied folder that
// looks finished.
export function copyToStableHome(
  packageRoot: string,
  home: string,
  version: string
): StableCopy {
  const nodeModules = installedNodeModules(packageRoot);
  if (!nodeModules) {
    throw new Error(`${packageRoot} is not inside a node_modules folder.`);
  }
  const packagePath = relative(nodeModules, packageRoot);
  const target = join(home, "app", version);
  const entryIn = (root: string) =>
    join(root, "node_modules", packagePath, "dist", "index.js");

  if (existsSync(entryIn(target))) {
    return { entry: entryIn(target), copied: false };
  }

  const staging = `${target}.partial-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    cpSync(nodeModules, join(staging, "node_modules"), {
      recursive: true,
      // Real files, never links back into the cache being left behind.
      dereference: true,
      // .bin holds launcher shims that point into the cache; running node
      // on the entry file never uses them.
      filter: (src) => basename(src) !== ".bin",
    });
    if (!existsSync(entryIn(staging))) {
      throw new Error("the copy has no dist/index.js");
    }
    // Only an incomplete leftover can be here, since a complete one
    // returned above.
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    // A second wizard run finishing first is success, not failure.
    if (existsSync(entryIn(target))) {
      return { entry: entryIn(target), copied: false };
    }
    throw err;
  }
  return { entry: entryIn(target), copied: true };
}
