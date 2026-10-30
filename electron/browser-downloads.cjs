const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeFilename(value) {
  const name = path.basename(String(value ?? "").replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return name && name !== "." && name !== ".." ? name : "download";
}

async function uniqueDestination(root, filename, fileSystem = fs) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let suffix = 0;
  while (true) {
    const candidateName = suffix === 0 ? filename : `${stem} (${suffix})${extension}`;
    const candidate = path.join(root, candidateName);
    try {
      await fileSystem.lstat(candidate);
      suffix += 1;
    } catch (error) {
      if (error.code === "ENOENT") return { candidate, candidateName };
      throw error;
    }
  }
}

async function moveManagedDownloadToRepository({ managedRoot, sourcePath, filename, repositoryPath }, fileSystem = fs) {
  if (![managedRoot, sourcePath, repositoryPath].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("Choose a valid download and repository.");
  }

  const downloadRoot = await fileSystem.realpath(path.resolve(managedRoot));
  const source = await fileSystem.realpath(path.resolve(sourcePath));
  if (!isInside(downloadRoot, source)) throw new Error("Only downloads managed by Tribe can be moved.");
  const sourceInfo = await fileSystem.stat(source);
  if (!sourceInfo.isFile()) throw new Error("The download is no longer available.");

  const repositoryRoot = await fileSystem.realpath(path.resolve(repositoryPath));
  const repositoryInfo = await fileSystem.stat(repositoryRoot);
  if (!repositoryInfo.isDirectory()) throw new Error("Choose an existing Git repository.");
  try {
    await fileSystem.lstat(path.join(repositoryRoot, ".git"));
  } catch {
    throw new Error("Choose an existing Git repository.");
  }

  const filenameToMove = safeFilename(filename);
  const { candidate, candidateName } = await uniqueDestination(repositoryRoot, filenameToMove, fileSystem);
  await fileSystem.copyFile(source, candidate, constants.COPYFILE_EXCL);
  try {
    await fileSystem.unlink(source);
  } catch (error) {
    await fileSystem.unlink(candidate).catch(() => {});
    throw error;
  }

  return { filename: candidateName };
}

module.exports = { moveManagedDownloadToRepository, safeFilename };
