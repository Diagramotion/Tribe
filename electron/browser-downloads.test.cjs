const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { moveManagedDownloadToRepository, safeFilename } = require("./browser-downloads.cjs");

const temporaryRoots = [];

async function temporaryDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tribe-browser-downloads-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setupDownload() {
  const root = await temporaryDirectory();
  const managedRoot = path.join(root, "managed");
  const repositoryPath = path.join(root, "project");
  await fs.mkdir(managedRoot);
  await fs.mkdir(path.join(repositoryPath, ".git"), { recursive: true });
  const sourcePath = path.join(managedRoot, "report.csv");
  await fs.writeFile(sourcePath, "id,name\n1,Tribe\n");
  return { managedRoot, repositoryPath, sourcePath };
}

test("moves a managed download into a Git repository and returns only its filename", async () => {
  const input = await setupDownload();

  const result = await moveManagedDownloadToRepository({ ...input, filename: "report.csv" });

  assert.deepEqual(result, { filename: "report.csv" });
  assert.equal(await fs.readFile(path.join(input.repositoryPath, result.filename), "utf8"), "id,name\n1,Tribe\n");
  await assert.rejects(fs.stat(input.sourcePath), { code: "ENOENT" });
});

test("preserves existing repository files by choosing a unique filename", async () => {
  const input = await setupDownload();
  await fs.writeFile(path.join(input.repositoryPath, "report.csv"), "existing");

  const result = await moveManagedDownloadToRepository({ ...input, filename: "report.csv" });

  assert.equal(result.filename, "report (1).csv");
  assert.equal(await fs.readFile(path.join(input.repositoryPath, "report.csv"), "utf8"), "existing");
  assert.equal(await fs.readFile(path.join(input.repositoryPath, result.filename), "utf8"), "id,name\n1,Tribe\n");
});

test("rejects sources outside Tribe's managed download directory", async () => {
  const input = await setupDownload();
  const outsidePath = path.join(path.dirname(input.managedRoot), "outside.txt");
  await fs.writeFile(outsidePath, "keep");

  await assert.rejects(
    moveManagedDownloadToRepository({ ...input, sourcePath: outsidePath, filename: "outside.txt" }),
    /Only downloads managed by Tribe/,
  );
  assert.equal(await fs.readFile(outsidePath, "utf8"), "keep");
});

test("rejects destinations that are not Git repositories", async () => {
  const input = await setupDownload();
  const destination = path.join(path.dirname(input.repositoryPath), "not-a-repository");
  await fs.mkdir(destination);

  await assert.rejects(
    moveManagedDownloadToRepository({ ...input, repositoryPath: destination, filename: "report.csv" }),
    /Choose an existing Git repository/,
  );
  assert.equal(await fs.readFile(input.sourcePath, "utf8"), "id,name\n1,Tribe\n");
});

test("reduces user-visible filenames to a single safe path component", () => {
  assert.equal(safeFilename("../nested\\report\n.csv"), "report_.csv");
});
