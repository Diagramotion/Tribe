export function repositoryNameSuggestion(value) {
  const clean = value.trim().split(/[?#]/, 1)[0].replace(/\.git$/i, "").replace(/[/:]+$/, "");
  return clean.split(/[/:]/).filter(Boolean).at(-1) ?? "";
}

export function isSupportedGitRemote(value) {
  const remote = value.trim();
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(remote)) return true;
  try {
    const parsed = new URL(remote);
    if (!parsed.hostname || !parsed.pathname || parsed.password) return false;
    if (parsed.protocol === "https:") return !parsed.username;
    return parsed.protocol === "ssh:"
      && ["", "git"].includes(parsed.username)
      && /^\/[A-Za-z0-9._~%/-]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function projectSetupError(error) {
  const messages = {
    repository_url_invalid: "Enter a valid HTTPS or SSH Git repository address.",
    clone_destination_already_exists: "A folder with this project name already exists there.",
    clone_destination_must_be_a_directory: "Choose a folder where Tribe can save the repository.",
    project_name_invalid: "Use a project name without path separators.",
    project_for_repository_already_exists: "This repository is already in your projects.",
    project_path_must_be_a_git_repository: "Choose a folder that contains a Git repository.",
    repository_path_must_be_a_directory: "Choose an existing folder.",
  };
  if (messages[error.message]) return messages[error.message];
  if (error.message?.includes("No such file or directory")) return "That folder could not be found. Choose another.";
  return error.message || "The project could not be added.";
}
