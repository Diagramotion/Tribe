from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tribe_runtime.store import MissionStore


class ExperimentRunStoreTests(unittest.TestCase):
    def test_records_metrics_and_links_only_registered_project_data(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-experiment-store-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            (repository / "data").mkdir()
            (repository / "data" / "train.csv").write_text("x,y\n1,2\n", encoding="utf-8")
            (repository / "model.bin").write_bytes(b"weights")
            store = MissionStore(root / "tribe.sqlite3")
            project, mission = store.create_project(
                str(repository), "ML project", "Track training", "Compare model metrics"
            )
            store.set_project_datasets(project["id"], ["data/train.csv"])

            recorded = store.record_experiment_run(
                mission["id"], "builder", "baseline", {"accuracy": 0.91, "loss": 0.12},
                parameters={"seed": 7, "optimizer": "adam"},
                dataset_paths=["data/train.csv"], model_path="model.bin", notes="First run",
            )
            runs = store.project_experiment_runs(project["id"])

            self.assertEqual(recorded["experiment_name"], "baseline")
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["metrics"], {"accuracy": 0.91, "loss": 0.12})
            self.assertEqual(runs[0]["parameters"], {"seed": 7, "optimizer": "adam"})
            self.assertEqual(runs[0]["dataset_paths"], ["data/train.csv"])
            self.assertEqual(runs[0]["model_path"], "model.bin")
            self.assertEqual(runs[0]["model_file_size_bytes"], len(b"weights"))
            self.assertEqual(runs[0]["model_sha256"], hashlib.sha256(b"weights").hexdigest())
            self.assertEqual(runs[0]["model_fingerprint_status"], "captured")
            self.assertEqual(runs[0]["mission_title"], "Track training")

            artifacts = store.project_model_artifacts(project["id"])
            self.assertEqual(len(artifacts), 1)
            self.assertEqual(artifacts[0]["model_path"], "model.bin")
            self.assertEqual(artifacts[0]["run_count"], 1)
            self.assertEqual(artifacts[0]["latest_metrics"], {"accuracy": 0.91, "loss": 0.12})

    def test_model_library_versions_changed_content_without_copying_model_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-model-artifacts-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            model = repository / "model.bin"
            model.write_bytes(b"first weights")
            store = MissionStore(root / "tribe.sqlite3")
            project, mission = store.create_project(
                str(repository), "ML project", "Train model", "Track model lineage"
            )
            store.record_experiment_run(
                mission["id"], "builder", "baseline", {"accuracy": 0.8}, model_path="model.bin",
            )
            model.write_bytes(b"second weights")
            store.record_experiment_run(
                mission["id"], "builder", "candidate", {"accuracy": 0.9}, model_path="model.bin",
            )

            artifacts = store.project_model_artifacts(project["id"])

            self.assertEqual(len(artifacts), 2)
            self.assertEqual({item["model_sha256"] for item in artifacts}, {
                hashlib.sha256(b"first weights").hexdigest(),
                hashlib.sha256(b"second weights").hexdigest(),
            })
            self.assertEqual({item["run_count"] for item in artifacts}, {1})
            self.assertEqual({item["latest_metrics"]["accuracy"] for item in artifacts}, {0.8, 0.9})

    def test_existing_experiment_runs_migrate_as_unfingerprinted_model_references(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-model-migration-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            (repository / "model.bin").write_bytes(b"legacy weights")
            database = root / "tribe.sqlite3"
            store = MissionStore(database)
            project, mission = store.create_project(
                str(repository), "ML project", "Train model", "Preserve legacy records"
            )
            store.record_experiment_run(
                mission["id"], "builder", "legacy", {"accuracy": 0.8}, model_path="model.bin",
            )
            with sqlite3.connect(database) as db:
                for column in ("model_fingerprint_status", "model_sha256", "model_file_size_bytes"):
                    db.execute(f"ALTER TABLE experiment_runs DROP COLUMN {column}")
                db.execute("PRAGMA user_version = 46")

            migrated = MissionStore(database)
            run = migrated.project_experiment_runs(project["id"])[0]
            artifact = migrated.project_model_artifacts(project["id"])[0]

            self.assertEqual(run["model_path"], "model.bin")
            self.assertIsNone(run["model_sha256"])
            self.assertEqual(run["model_fingerprint_status"], "unavailable")
            self.assertEqual(artifact["model_fingerprint_status"], "unavailable")
            self.assertEqual(artifact["run_count"], 1)

    def test_rejects_unregistered_datasets_nonfinite_metrics_and_escaping_model_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="tribe-experiment-validation-") as directory:
            root = Path(directory)
            repository = root / "project"
            repository.mkdir()
            (repository / "train.csv").write_text("x,y\n1,2\n", encoding="utf-8")
            store = MissionStore(root / "tribe.sqlite3")
            project, mission = store.create_project(
                str(repository), "ML project", "Track training", "Compare model metrics"
            )

            with self.assertRaisesRegex(ValueError, "experiment_dataset_not_registered"):
                store.record_experiment_run(
                    mission["id"], "builder", "baseline", {"accuracy": 0.9},
                    dataset_paths=["train.csv"],
                )
            with self.assertRaisesRegex(ValueError, "experiment_metrics_invalid"):
                store.record_experiment_run(
                    mission["id"], "builder", "baseline", {"accuracy": float("nan")},
                )
            with self.assertRaisesRegex(ValueError, "experiment_model_path_invalid"):
                store.record_experiment_run(
                    mission["id"], "builder", "baseline", {"accuracy": 0.9},
                    model_path="../outside.bin",
                )
            self.assertEqual(store.project_experiment_runs(project["id"]), [])
