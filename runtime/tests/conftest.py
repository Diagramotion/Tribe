"""Keep the runtime test suite isolated from credentials in the host keychain."""

import os
from tempfile import TemporaryDirectory


os.environ["PYTHON_KEYRING_BACKEND"] = "keyring.backends.null.Keyring"
_runtime_data_directory = TemporaryDirectory(prefix="tribe-pytest-data-")
os.environ["TRIBE_DATA_DIR"] = _runtime_data_directory.name
