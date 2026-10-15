#!/usr/bin/env python3
"""Private synthetic regression fixtures; never calls real systemd or live CLI."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("custom_release", Path(__file__).with_name("custom-release.py"))
OWNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNER)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="openclaw-custom-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def repo(self):
        repo = self.root / "repo"
        repo.mkdir()
        OWNER.run(["git", "init", "-q", str(repo)])
        OWNER.git(repo, "config", "user.name", "Synthetic Regression")
        OWNER.git(repo, "config", "user.email", "regression@example.invalid")
        return repo

    def commit(self, repo, message):
        OWNER.git(repo, "add", ".")
        OWNER.git(repo, "commit", "-qm", message)
        return OWNER.git(repo, "rev-parse", "HEAD")

    def archive(self, name, files):
        target = self.root / name
        with tarfile.open(target, "w:gz") as archive:
            for name, data in files.items():
                raw = data.encode()
                entry = tarfile.TarInfo("package/" + name)
                entry.size = len(raw)
                archive.addfile(entry, io.BytesIO(raw))
        return target

    def plan(self):
        prefix, state = self.root / "prefix", self.root / "state"
        install = prefix / "lib/node_modules/openclaw"
        install.mkdir(parents=True)
        state.mkdir()
        (prefix / "bin").mkdir()
        (install / "node_modules").mkdir()
        (install / "node_modules/dependency").write_text("old dependency")
        (install / "openclaw.mjs").write_text("old runtime")
        (state / "openclaw.json").write_text('{"kept":"original"}')
        (state / "agent.sqlite").write_text("old database")
        (state / "agent.sqlite-wal").write_text("old WAL")
        binary = prefix / "bin/openclaw"
        binary.symlink_to("../lib/node_modules/openclaw/openclaw.mjs")
        units = self.root / "units"
        units.mkdir()
        (units / "gateway.service").write_text("old unit")
        unrelated = prefix / "unrelated-package"
        unrelated.write_text("untouched")
        return {"prefix": str(prefix), "stateDir": str(state),
                "configPath": str(state / "openclaw.json"), "nodeExecutable": "/fixture/node",
                "pluginProjectsDir": str(state / "npm/projects"),
                "services": ["gateway.service", "node.service"],
                "systemdPaths": [str(units)], "binPaths": [str(binary)],
                "externalPaths": [], "externalPathsReviewed": True}

    def test_node_engine_rejects_25_and_uses_candidate_bounds(self):
        engine = ">=24.16.0 <25 || >=26.1.0"
        for value in ("v24.16.0", "v24.18.0", "v26.1.0"):
            self.assertTrue(OWNER.node_satisfies(value, engine))
        for value in ("v24.15.9", "v25.9.0", "v26.0.0"):
            self.assertFalse(OWNER.node_satisfies(value, engine))

    def test_numeric_revision_uses_core_tag_and_exact_npm_commit(self):
        commands = []
        def execute(args, **_options):
            commands.append(args)
            return "remote-head" if args[:2] == ["git", "ls-remote"] else ""
        with patch.object(OWNER, "run", side_effect=execute), patch.object(OWNER, "git", return_value="a" * 40):
            OWNER.verify_official_git(self.root, {"version": "2026.7.1-2", "commit": "b" * 40})
        flattened = [str(value) for command in commands for value in command]
        self.assertIn("refs/tags/v2026.7.1:refs/custom-release/tags/v2026.7.1", flattened)
        self.assertIn("b" * 40, flattened)
        self.assertFalse(any("v2026.7.1-2" in value for value in flattened))

    def test_diff_uses_previous_exact_source_without_old_official_files(self):
        repo = self.repo()
        (repo / "common").write_text("base")
        origin = self.commit(repo, "base")
        (repo / "old-official").write_text("old release only")
        old = self.commit(repo, "old official")
        (repo / "tools/custom").mkdir(parents=True)
        OWNER.write_json(repo / "tools/custom/upstream-base.json", {"version": "2026.7.1-2", "commit": old})
        (repo / "custom").write_text("user intent")
        custom = self.commit(repo, "custom")
        OWNER.git(repo, "branch", "-m", "custom-main")
        OWNER.git(repo, "checkout", "-qb", "official-new", origin)
        (repo / "new-official").write_text("new release only")
        target = self.commit(repo, "new official")
        OWNER.git(repo, "checkout", "-q", "custom-main")
        real_run = OWNER.run
        commands = []
        def execute(args, **options):
            commands.append(args)
            if args[0] == "fixture-pnpm":
                return ""
            return real_run(args, **options)
        def release(version, _out):
            return {"version": version, "commit": old if version == "2026.7.1-2" else target,
                    "npmIntegrity": "synthetic"}
        with patch.object(OWNER, "registry_release", side_effect=release), \
             patch.object(OWNER, "verify_official_git"), \
             patch.object(OWNER, "bootstrap_toolchain", return_value=("node", "fixture-pnpm")), \
             patch.object(OWNER, "check_toolchain"), patch.object(OWNER, "stage"), \
             patch.object(OWNER, "run", side_effect=execute):
            OWNER.prepare_build(argparse.Namespace(repo=str(repo), source_branch="custom-main",
                version="2026.10.3", out=str(self.root / "candidate")))
        candidate = self.root / "candidate/source"
        self.assertEqual((candidate / "custom").read_text(), "user intent")
        self.assertTrue((candidate / "new-official").exists())
        self.assertFalse((candidate / "old-official").exists())
        self.assertEqual(OWNER.git(repo, "rev-parse", "HEAD"), custom)
        self.assertEqual(OWNER.git(repo, "branch", "--show-current"), "custom-main")
        self.assertEqual(OWNER.git(repo, "status", "--porcelain"), "")
        self.assertEqual(OWNER.git(candidate, "rev-parse", "HEAD"), target)
        self.assertTrue((self.root / "candidate/review-pending.json").exists())
        self.assertFalse(any("push" in [str(value) for value in command] for command in commands))
        integration = OWNER.read_json(self.root / "candidate/integration.json")
        self.assertNotIn("old-official", integration["paths"])

    def test_changed_package_hash_refuses_before_deployment(self):
        artifacts = {}
        for role, name in (("core", "openclaw"), ("voice", "@openclaw/voice-call"), ("discord", "@openclaw/discord")):
            files = {"package.json": json.dumps({"name": name, "version": "2026.10.3"})}
            if role == "core":
                files["dist/build-info.json"] = json.dumps({"version": "2026.10.3", "commit": "a" * 40})
            archive = self.archive(role + ".tgz", files)
            artifacts[role] = {"file": archive.name, "sha256": OWNER.digest(archive),
                "name": name, "version": "2026.10.3", "files": OWNER.tar_inventory(archive)}
        receipt = self.root / "release.json"
        OWNER.write_json(receipt, {"schema": OWNER.SCHEMA, "head": "a" * 40,
                                  "version": "2026.10.3", "artifacts": artifacts})
        self.assertEqual(OWNER.verify(receipt)["version"], "2026.10.3")
        with open(self.root / "voice.tgz", "ab") as handle:
            handle.write(b"changed")
        with self.assertRaisesRegex(OWNER.ReleaseError, "hash"):
            OWNER.verify(receipt)

    def test_full_checkpoint_restores_dependencies_database_wal_and_metadata_only(self):
        plan = self.plan()
        transaction = self.root / "transaction"
        transaction.mkdir()
        checkpoint = OWNER.save_checkpoint(plan, transaction)
        install = Path(plan["prefix"]) / "lib/node_modules/openclaw"
        (install / "node_modules/dependency").write_text("new dependency")
        (Path(plan["stateDir"]) / "agent.sqlite").write_text("new database")
        (Path(plan["stateDir"]) / "agent.sqlite-wal").unlink()
        (Path(plan["prefix"]) / "unrelated-package").write_text("later unrelated work")
        OWNER.restore_checkpoint(transaction)
        self.assertEqual((install / "node_modules/dependency").read_text(), "old dependency")
        self.assertEqual((Path(plan["stateDir"]) / "agent.sqlite").read_text(), "old database")
        self.assertEqual((Path(plan["stateDir"]) / "agent.sqlite-wal").read_text(), "old WAL")
        self.assertEqual((Path(plan["prefix"]) / "unrelated-package").read_text(), "later unrelated work")
        self.assertTrue(Path(plan["binPaths"][0]).is_symlink())
        self.assertTrue(all(Path(item["path"]) != Path(plan["prefix"]) for item in checkpoint["targets"]))

    def test_checkpoint_tampering_refuses_before_any_restore(self):
        plan = self.plan()
        transaction = self.root / "transaction"
        transaction.mkdir()
        checkpoint = OWNER.save_checkpoint(plan, transaction)
        archive = transaction / next(item["archive"] for item in checkpoint["targets"] if item["exists"])
        with open(archive, "ab") as handle:
            handle.write(b"tampered")
        active = Path(plan["stateDir"]) / "agent.sqlite"
        active.write_text("current")
        with self.assertRaisesRegex(OWNER.ReleaseError, "archive changed"):
            OWNER.restore_checkpoint(transaction)
        self.assertEqual(active.read_text(), "current")

    def test_escaping_dependency_requires_reviewed_external_scope(self):
        plan = self.plan()
        link = Path(plan["prefix"]) / "lib/node_modules/openclaw/node_modules/escape"
        outside = self.root / "external-dependency"
        outside.mkdir()
        link.symlink_to(outside)
        with self.assertRaisesRegex(OWNER.ReleaseError, "escapes"):
            OWNER.snapshot_targets(plan)
        plan["externalPaths"].append(str(outside))
        self.assertIn(outside, OWNER.snapshot_targets(plan))

    def test_service_repair_is_external_for_plugin_and_doctor(self):
        plan = self.plan()
        with patch.object(OWNER, "run", return_value="") as execute:
            OWNER.cli(plan, "plugins", "install", "npm-pack:/fixture.tgz")
            OWNER.cli(plan, "doctor", "--fix", "--non-interactive")
        for invocation in execute.call_args_list:
            self.assertEqual(invocation.kwargs["env"]["OPENCLAW_SERVICE_REPAIR_POLICY"], "external")
            self.assertEqual(invocation.kwargs["env"]["OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE"], "1")

    def test_readiness_has_bounded_timeout_with_injected_clock(self):
        now = [0]
        def wait(seconds):
            now[0] += seconds
        with patch.object(OWNER, "validate_runtime", side_effect=OWNER.ReleaseError("unready")):
            with self.assertRaisesRegex(OWNER.ReleaseError, "timed out after 120s"):
                OWNER.await_runtime({"readinessTimeoutSeconds": 120}, {},
                                    clock=lambda: now[0], wait=wait)
        self.assertEqual(now[0], 120)

    def test_deploy_failure_rolls_back_before_restart(self):
        plan = self.plan()
        plan_path = self.root / "plan.json"
        OWNER.write_json(plan_path, plan)
        receipt_path = self.root / "release.json"
        receipt_path.write_text("{}")
        self.archive("core.tgz", {"package.json": json.dumps({
            "name": "openclaw", "version": "2026.10.3", "engines": {"node": ">=24.16.0 <25 || >=26.1.0"}})})
        events = []
        real_run = OWNER.run
        install = Path(plan["prefix"]) / "lib/node_modules/openclaw"
        def execute(args, **options):
            if args[0] == "/fixture/node":
                return "v24.18.0"
            if str(args[0]).endswith("/npm") or args[0] == "npm":
                if args[1:] == ["--version"]:
                    return "11.16.0"
                self.assertIn("--ignore-scripts=false", args)
                events.append("install")
                (install / "node_modules/dependency").write_text("bad new dependency")
                (Path(plan["stateDir"]) / "agent.sqlite").write_text("migrated DB")
                raise OWNER.ReleaseError("synthetic install failure")
            return real_run(args, **options)
        def control(action, _services):
            events.append(action)
            if action == "start":
                self.assertEqual((install / "node_modules/dependency").read_text(), "old dependency")
                self.assertEqual((Path(plan["stateDir"]) / "agent.sqlite").read_text(), "old database")
        def cli(_plan, *args, **_options):
            return "2026.7.1-2" if args == ("--version",) else '{"ok":true}'
        receipt = {"artifacts": {"core": {"file": "core.tgz"}, "voice": {"file": "voice.tgz"}}}
        with patch.object(OWNER, "verify", return_value=receipt), patch.object(OWNER, "service", side_effect=control), \
             patch.object(OWNER, "assert_services_stopped"), patch.object(OWNER, "cli", side_effect=cli), \
             patch.object(OWNER, "run", side_effect=execute), \
             patch.object(OWNER.subprocess, "run", wraps=subprocess.run) as subprocess_run:
            # Only systemctl state probes are replaced; real tar fixtures still execute.
            original = subprocess_run._mock_wraps
            def process(args, **options):
                if args[0] == "systemctl":
                    return subprocess.CompletedProcess(args, 0, stdout="active", stderr="")
                return original(args, **options)
            subprocess_run.side_effect = process
            with self.assertRaisesRegex(OWNER.ReleaseError, "synthetic"):
                OWNER.deploy(argparse.Namespace(receipt=str(receipt_path), plan=str(plan_path),
                    transaction=str(self.root / "deployment"), execute_deployment=True))
        self.assertEqual(events, ["stop", "install", "stop", "daemon-reload", "start", "is-active"])
        self.assertEqual(OWNER.read_json(self.root / "deployment/transaction.json")["stage"], "rolled-back")
        self.assertTrue((self.root / "deployment/checkpoint.json").exists())

    def test_wrong_core_runtime_bytes_rejected_even_with_matching_commit_version(self):
        plan = self.plan()
        installed = Path(plan["prefix"]) / "lib/node_modules/openclaw"
        OWNER.write_json(installed / "package.json", {"name": "openclaw", "version": "2026.10.3"})
        OWNER.write_json(installed / "dist/build-info.json", {"version": "2026.10.3", "commit": "a" * 40})
        (installed / "dist/runtime.js").write_text("official runtime that lost customizations")
        receipt = {"version": "2026.10.3", "head": "a" * 40,
                   "artifacts": {"core": {"files": {"dist/runtime.js": "0" * 64}}}}
        with self.assertRaisesRegex(OWNER.ReleaseError, "Installed core runtime file changed"):
            OWNER.validate_runtime(plan, receipt)

    def test_deploy_selects_supported_npm_11_and_rejects_silent_npm_12_scripts(self):
        plan = self.plan()
        plan["npmExecutable"] = "/fixture/npm11"
        with patch.object(OWNER, "run", return_value="11.16.0") as execute:
            installer, environment = OWNER.deployment_npm(plan)
        self.assertEqual(installer, "/fixture/npm11")
        self.assertEqual(execute.call_args_list[0].args[0], ["/fixture/npm11", "--version"])
        self.assertTrue(environment["PATH"].startswith("/fixture:"))
        with patch.object(OWNER, "run", return_value="12.1.0"):
            with self.assertRaisesRegex(OWNER.ReleaseError, "requires npm 11"):
                OWNER.deployment_npm(plan)

    def test_loaded_managed_voice_accepts_rotated_generation_project(self):
        plan = self.plan()
        project = Path(plan["pluginProjectsDir"]) / "openclaw-voice-call-d0fedeaf18__openclaw-generation__g-823d9ee57700c545"
        root = project / "node_modules/@openclaw/voice-call"
        root.mkdir(parents=True)
        self.assertEqual(OWNER.resolve_loaded_voice_root(plan, {
            "rootDir": str(root), "source": str(root / "dist/index.js"),
        }), root.resolve())

    def test_loaded_voice_outside_reviewed_projects_or_with_shadow_entry_refuses(self):
        plan = self.plan()
        outside = self.root / "extensions/voice-call"
        outside.mkdir(parents=True)
        with self.assertRaisesRegex(OWNER.ReleaseError, "outside reviewed"):
            OWNER.resolve_loaded_voice_root(plan, {"rootDir": str(outside), "source": str(outside / "index.ts")})
        root = Path(plan["pluginProjectsDir"]) / "openclaw-voice-call-d0/node_modules/@openclaw/voice-call"
        root.mkdir(parents=True)
        with self.assertRaisesRegex(OWNER.ReleaseError, "shadows"):
            OWNER.resolve_loaded_voice_root(plan, {
                "rootDir": str(root), "source": str(outside / "index.ts"),
            })


    def test_legacy_two_role_receipt_is_rejected_before_mutation(self):
        artifacts = {}
        for role, name in (("core", "openclaw"), ("voice", "@openclaw/voice-call")):
            files = {"package.json": json.dumps({"name": name, "version": "2026.10.3"})}
            if role == "core":
                files["dist/build-info.json"] = json.dumps({"commit": "a" * 40})
            archive = self.archive(role + ".tgz", files)
            artifacts[role] = {"file": archive.name, "sha256": OWNER.digest(archive),
                               "files": OWNER.tar_inventory(archive), "name": name, "version": "2026.10.3"}
        receipt = self.root / "legacy.json"
        OWNER.write_json(receipt, {"schema": "openclaw.custom-release.v1", "head": "a" * 40,
                                  "version": "2026.10.3", "artifacts": artifacts})
        with self.assertRaisesRegex(OWNER.ReleaseError, "three|v2"):
            OWNER.verify(receipt)
        with patch.object(OWNER, "deployment_npm", side_effect=AssertionError("installer preflight reached")):
            with self.assertRaisesRegex(OWNER.ReleaseError, "three|v2"):
                OWNER.deploy(argparse.Namespace(receipt=str(receipt), plan=str(self.root / "missing-plan.json"),
                    transaction=str(self.root / "should-not-exist"), execute_deployment=True))
        self.assertFalse((self.root / "should-not-exist").exists())

    def test_discord_dependency_escape_and_missing_projects_scope_are_rejected(self):
        plan = self.plan()
        projects = Path(plan["pluginProjectsDir"])
        root = projects / "discord-generation/node_modules/@openclaw/discord/node_modules"
        root.mkdir(parents=True)
        external = self.root / "external-discord-dependency"
        external.mkdir()
        (root / "escaped").symlink_to(external)
        with self.assertRaisesRegex(OWNER.ReleaseError, "escapes"):
            OWNER.snapshot_targets(plan)
        plan["externalPaths"].append(str(external))
        OWNER.snapshot_targets(plan)
        plan["pluginProjectsDir"] = str(self.root / "unreviewed-projects")
        with self.assertRaisesRegex(OWNER.ReleaseError, "projects.*outside"):
            OWNER.snapshot_targets(plan)

    def test_checkpoint_restores_both_plugin_generations_and_removes_new_generation(self):
        plan = self.plan()
        projects = Path(plan["pluginProjectsDir"])
        paths = [projects / role / "node_modules/@openclaw" / package / "dist/index.js"
                 for role, package in (("old-voice", "voice-call"), ("old-discord", "discord"))]
        for path in paths:
            path.parent.mkdir(parents=True)
            path.write_text("old custom " + path.parts[-3])
        before = [path.read_text() for path in paths]
        transaction = self.root / "plugin-checkpoint"
        transaction.mkdir()
        OWNER.save_checkpoint(plan, transaction)
        for path in paths:
            path.write_text("new official bytes")
        new = projects / "new-discord-generation"
        new.mkdir()
        OWNER.restore_checkpoint(transaction)
        self.assertEqual([path.read_text() for path in paths], before)
        self.assertFalse(new.exists())


    def runtime_fixture(self):
        plan = self.plan()
        version, head = "2026.10.3", "a" * 40
        core = Path(plan["prefix"]) / "lib/node_modules/openclaw"
        OWNER.write_json(core / "package.json", {"name": "openclaw", "version": version})
        OWNER.write_json(core / "dist/build-info.json", {"version": version, "commit": head})
        receipt = {"version": version, "head": head, "artifacts": {"core": {"files": {
            "openclaw.mjs": OWNER.digest(core / "openclaw.mjs"),
            "dist/build-info.json": OWNER.digest(core / "dist/build-info.json")}}}}
        records = []
        for role, package in (("voice", "voice-call"), ("discord", "discord")):
            root = Path(plan["pluginProjectsDir"]) / (role + "-generation") / "node_modules/@openclaw" / package
            OWNER.write_json(root / "package.json", {"name": "@openclaw/" + package, "version": version})
            (root / "dist").mkdir()
            (root / "dist/index.js").write_text("custom " + role)
            receipt["artifacts"][role] = {"files": {
                "package.json": OWNER.digest(root / "package.json"),
                "dist/index.js": OWNER.digest(root / "dist/index.js")}}
            records.append({"id": package, "status": "loaded", "rootDir": str(root),
                            "source": str(root / "dist/index.js"), "version": version, "origin": "global", "enabled": True})
        return plan, receipt, records

    def projected_gateway_records(self, records):
        # Actual plugins.list RPC projection has no rootDir/source/package path.
        return [{"id": r["id"], "name": r["id"], "packageName": "@openclaw/" + r["id"],
                 "version": r["version"], "origin": r["origin"], "installed": True,
                 "enabled": r["enabled"], "state": "enabled", "runtime": {"state": "active"}}
                for r in records]

    def runtime_cli(self, records, gateway_records=None):
        def query(_plan, *args, **_options):
            if args == ("--version",):
                return "OpenClaw 2026.10.3"
            if args[:2] == ("config", "validate"):
                return '{"valid":true}'
            if args[:2] == ("plugins", "list"):
                return json.dumps({"plugins": records})
            if args[:3] == ("gateway", "call", "plugins.list"):
                return json.dumps({"plugins": self.projected_gateway_records(records) if gateway_records is None else gateway_records})
            if args[:1] == ("status",):
                return '{"gateway":{"self":{"version":"2026.10.3"}}}'
            if args[:3] == ("gateway", "call", "health"):
                return '{"ok":true}'
            raise AssertionError(args)
        return query

    def test_both_plugins_require_exact_members_and_active_registry(self):
        plan, receipt, records = self.runtime_fixture()
        with patch.object(OWNER, "cli", side_effect=self.runtime_cli(records)), patch.object(OWNER, "service"):
            OWNER.validate_runtime(plan, receipt)
            discord = Path(records[1]["rootDir"]) / "dist/index.js"
            discord.write_text("same-version official package without guard")
            with self.assertRaisesRegex(OWNER.ReleaseError, "Installed discord file changed"):
                OWNER.validate_runtime(plan, receipt)
            discord.write_text("custom discord")
        gateway = self.projected_gateway_records(records)
        gateway[1]["runtime"]["state"] = "unloaded"
        with patch.object(OWNER, "cli", side_effect=self.runtime_cli(records, gateway)), patch.object(OWNER, "service"):
            with self.assertRaisesRegex(OWNER.ReleaseError, "activate.*discord"):
                OWNER.validate_runtime(plan, receipt)

    def test_real_projected_gateway_records_without_paths_validate(self):
        plan, receipt, records = self.runtime_fixture()
        gateway = self.projected_gateway_records(records)
        self.assertTrue(all("rootDir" not in r and "source" not in r for r in gateway))
        self.assertTrue(all("packageName" not in r for r in records))
        with patch.object(OWNER, "cli", side_effect=self.runtime_cli(records, gateway)), patch.object(OWNER, "service"):
            OWNER.validate_runtime(plan, receipt)

    def test_gateway_metadata_mismatches_refused_for_each_plugin(self):
        plan, receipt, records = self.runtime_fixture()
        for index in range(2):
            for field, wrong in (("id", "other"), ("packageName", "@openclaw/other"), ("version", "2026.7.1"),
                                 ("origin", "bundled"), ("installed", False), ("enabled", False)):
                with self.subTest(plugin=records[index]["id"], field=field):
                    gateway = self.projected_gateway_records(records)
                    gateway[index][field] = wrong
                    with patch.object(OWNER, "cli", side_effect=self.runtime_cli(records, gateway)), patch.object(OWNER, "service"):
                        with self.assertRaisesRegex(OWNER.ReleaseError, "Gateway.*metadata|activate"):
                            OWNER.validate_runtime(plan, receipt)

    def test_cli_shadow_entry_and_plugin_member_symlink_refused(self):
        plan, receipt, records = self.runtime_fixture()
        root = Path(records[1]["rootDir"])
        outside = self.root / "unreviewed-entry.js"
        outside.write_text("unreviewed")
        records[1]["source"] = str(outside)
        with patch.object(OWNER, "cli", side_effect=self.runtime_cli(records)), patch.object(OWNER, "service"):
            with self.assertRaisesRegex(OWNER.ReleaseError, "shadows"):
                OWNER.validate_runtime(plan, receipt)
        records[1]["source"] = str(root / "dist/index.js")
        member = root / "dist/index.js"
        other = root / "index-copy.js"
        other.write_text(member.read_text())
        member.unlink()
        member.symlink_to(other)
        with self.assertRaisesRegex(OWNER.ReleaseError, "escapes physical|absent from the reviewed artifact"):
            OWNER.validate_plugin_files(plan, records[1], "discord", receipt)

    def test_swapped_three_role_package_identity_rejected(self):
        artifacts = {}
        for role, name in (("core", "openclaw"), ("voice", "@openclaw/discord"), ("discord", "@openclaw/voice-call")):
            files = {"package.json": json.dumps({"name": name, "version": "2026.10.3"})}
            if role == "core":
                files["dist/build-info.json"] = json.dumps({"commit": "a" * 40})
            archive = self.archive(role + ".tgz", files)
            artifacts[role] = {"name": name, "version": "2026.10.3", "file": archive.name,
                               "sha256": OWNER.digest(archive), "files": OWNER.tar_inventory(archive)}
        path = self.root / "release.json"
        OWNER.write_json(path, {"schema": OWNER.SCHEMA, "head": "a" * 40, "version": "2026.10.3", "artifacts": artifacts})
        with self.assertRaisesRegex(OWNER.ReleaseError, "identity mismatch"):
            OWNER.verify(path)

    def test_stage_invokes_canonical_build_and_pack_for_both_plugins(self):
        repo = self.repo()
        OWNER.write_json(repo / "package.json", {"version": "2026.10.3"})
        OWNER.write_json(repo / "tools/custom/upstream-base.json", {"version": "2026.10.3"})
        head = self.commit(repo, "synthetic")
        OWNER.git(repo, "branch", "-m", "upgrade/test")
        (repo / "node_modules").mkdir()
        (repo / ".git/info/exclude").write_text("node_modules/\ndist/\n")
        OWNER.write_json(repo / "dist/build-info.json", {"version": "2026.10.3", "commit": head})
        out = self.root / "stage"
        commands = []
        def execute(args, **_options):
            commands.append([str(arg) for arg in args])
            role = None
            if "scripts/package-openclaw-for-docker.mjs" in args:
                role = "core"
            if "scripts/lib/plugin-npm-package-manifest.mjs" in args:
                role = "voice" if "extensions/voice-call" in args else "discord"
            if role:
                files = {"package.json": json.dumps({"name": {"core": "openclaw", "voice": "@openclaw/voice-call", "discord": "@openclaw/discord"}[role], "version": "2026.10.3"})}
                if role == "core":
                    files["dist/build-info.json"] = json.dumps({"commit": head})
                self.archive(role + ".tgz", files).replace(out / (role + ".tgz"))
            return ""
        with patch.object(OWNER, "bootstrap_toolchain", return_value=("fixture-node", "fixture-pnpm")), \
             patch.object(OWNER, "check_toolchain"), patch.object(OWNER, "run", side_effect=execute), \
             patch.object(OWNER, "git", side_effect=lambda repo, *args: subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()):
            OWNER.stage(argparse.Namespace(repo=str(repo), out=str(out), allow_dirty_review=True, skip_build=False))
        receipt = OWNER.verify(out / "release.json", check_source=True)
        self.assertEqual(set(receipt["artifacts"]), {"core", "voice", "discord"})
        self.assertIn(["fixture-pnpm", "build"], commands)
        self.assertIn(["fixture-pnpm", "ui:build"], commands)
        for plugin in ("extensions/voice-call", "extensions/discord"):
            self.assertIn(["fixture-node", "scripts/lib/plugin-npm-runtime-build.mjs", plugin], commands)
            self.assertIn(["fixture-node", "scripts/lib/plugin-npm-package-manifest.mjs", "--run", plugin,
                           "--", "npm", "pack", "--pack-destination", str(out)], commands)


    def test_native_discord_install_mismatch_rolls_back_both_plugins_before_restart(self):
        plan, receipt, records = self.runtime_fixture()
        for role in ("core", "voice", "discord"):
            receipt["artifacts"][role]["file"] = role + ".tgz"
        self.archive("core.tgz", {"package.json": json.dumps({"engines": {"node": ">=24.16.0 <25"}})})
        receipt_path, plan_path = self.root / "release.json", self.root / "plan.json"
        OWNER.write_json(receipt_path, receipt)
        OWNER.write_json(plan_path, plan)
        events = []
        query = self.runtime_cli(records)
        discord_file = Path(records[1]["rootDir"]) / "dist/index.js"
        def cli(_plan, *args, **options):
            if args[:2] == ("plugins", "install"):
                events.append(args[2])
                self.assertTrue(all(flag in args for flag in ("--force", "--no-enable", "--accept-capabilities")))
                if args[2].endswith("discord.tgz"):
                    discord_file.write_text("official bytes lost custom UDP guard")
                return ""
            if args[:1] == ("doctor",):
                self.fail("Doctor ran before Discord native identity validation")
            return query(_plan, *args, **options)
        original_run = OWNER.run
        def execute(args, **options):
            if args == ["/fixture/node", "--version"]:
                return "v24.18.0"
            if args[0] == "npm" or str(args[0]).endswith("/npm"):
                return "11.16.0" if args[1:] == ["--version"] else ""
            return original_run(args, **options)
        original_process = subprocess.run
        def process(args, **options):
            if args[0] == "systemctl":
                return subprocess.CompletedProcess(args, 0, stdout="active", stderr="")
            return original_process(args, **options)
        def service(action, _services):
            if action == "start":
                self.assertEqual(discord_file.read_text(), "custom discord")
                self.assertEqual((Path(records[0]["rootDir"]) / "dist/index.js").read_text(), "custom voice")
            events.append(action)
        with patch.object(OWNER, "verify", return_value=receipt), patch.object(OWNER, "cli", side_effect=cli), \
             patch.object(OWNER, "run", side_effect=execute), patch.object(OWNER, "service", side_effect=service), \
             patch.object(OWNER, "assert_services_stopped"), patch.object(OWNER.subprocess, "run", side_effect=process):
            with self.assertRaisesRegex(OWNER.ReleaseError, "Installed discord file changed"):
                OWNER.deploy(argparse.Namespace(receipt=str(receipt_path), plan=str(plan_path),
                    transaction=str(self.root / "native-deployment"), execute_deployment=True))
        self.assertEqual(events[:3], ["stop", "npm-pack:" + str(self.root / "voice.tgz"),
                                    "npm-pack:" + str(self.root / "discord.tgz")])
        self.assertEqual(OWNER.read_json(self.root / "native-deployment/transaction.json")["stage"], "rolled-back")

    def test_deploy_is_never_implicit(self):
        with self.assertRaisesRegex(OWNER.ReleaseError, "explicit"):
            OWNER.deploy(argparse.Namespace(execute_deployment=False))

if __name__ == "__main__":
    unittest.main()
