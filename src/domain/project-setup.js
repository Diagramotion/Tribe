export function repositoryNameSuggestion(value) {
  const clean = value.trim().split(/[?#]/, 1)[0].replace(/\.git$/i, "").replace(/[/:]+$/, "");
  return clean.split(/[/:]/).filter(Boolean).at(-1) ?? "";
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
