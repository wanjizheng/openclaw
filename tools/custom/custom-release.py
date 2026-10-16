#!/usr/bin/env python3
"""Isolated fork preparation and explicit transactional deployment."""

from __future__ import annotations
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

OFFICIAL = "https://github.com/openclaw/openclaw.git"
SCHEMA = "openclaw.custom-release.v2"
ARTIFACT_PACKAGES = {"core": "openclaw", "voice": "@openclaw/voice-call", "discord": "@openclaw/discord"}
PLUGIN_IDS = {"voice": "voice-call", "discord": "discord"}

class ReleaseError(RuntimeError):
    pass

def run(args, cwd=None, env=None, capture=False):
    if env is None and os.environ.get("OPENCLAW_CUSTOM_NODE"):
        node = shutil.which(os.environ["OPENCLAW_CUSTOM_NODE"]) or os.environ["OPENCLAW_CUSTOM_NODE"]
        env = {**os.environ, "PATH": str(Path(node).parent) + os.pathsep + os.environ["PATH"]}
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        # Do not echo private CLI configuration into review logs.
        raise ReleaseError(f"{Path(str(args[0])).name} failed (exit {result.returncode})")
    return result.stdout.strip() if capture else ""

def git(repo, *args):
    return run(["git", "-C", repo, *args], capture=True)

def digest(path):
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + f".tmp-{uuid.uuid4().hex}")
    with open(temporary, "x", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)

def read_json(path):
    return json.loads(Path(path).read_text())

@contextlib.contextmanager
def operation_lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, "a+") as lock:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ReleaseError("Another operation owns this release transaction.") from error
        yield

def source_inventory(repo):
    entries = {}
    names = git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")
    for name in sorted(set(names)):
        if not name:
            continue
        source = repo / name
        if source.is_symlink():
            entries[name] = {"symlink": os.readlink(source)}
        elif source.is_file():
            entries[name] = {"sha256": digest(source), "mode": source.stat().st_mode & 0o777}
        elif not source.exists():
            entries[name] = {"deleted": True}
        else:
            raise ReleaseError(f"Unsupported source entry: {name}")
    serialized = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return entries, hashlib.sha256(serialized).hexdigest()

def tar_inventory(archive):
    files = {}
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] != "package" or ".." in parts or Path(member.name).is_absolute():
                raise ReleaseError("Unsafe npm archive member.")
            if member.issym() or member.islnk():
                raise ReleaseError("Npm archive links are not accepted.")
            if member.isfile():
                if "/".join(parts[1:]) in files:
                    raise ReleaseError("Duplicate npm archive member.")
                files["/".join(parts[1:])] = hashlib.sha256(handle.extractfile(member).read()).hexdigest()
    return files

def tar_json(archive, name):
    with tarfile.open(archive, "r:gz") as handle:
        member = handle.getmember("package/" + name)
        if not member.isfile():
            raise ReleaseError(f"Expected package file {name}")
        return json.load(handle.extractfile(member))

def registry_release(version, out):
    locator = version or "latest"
    if not re.fullmatch(r"(latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+)?)", locator):
        raise ReleaseError("Only exact stable versions or latest are supported.")
    with urllib.request.urlopen("https://registry.npmjs.org/openclaw/" + locator, timeout=60) as response:
        metadata = json.load(response)
    exact = metadata["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+)?", exact):
        raise ReleaseError("Registry target is a prerelease.")
    distribution = metadata["dist"]
    archive = out / f"official-openclaw-{exact}.tgz"
    with urllib.request.urlopen(distribution["tarball"], timeout=120) as response:
        with open(archive, "wb") as handle:
            shutil.copyfileobj(response, handle)
    integrity = distribution.get("integrity", "")
    actual = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if integrity != "sha512-" + actual:
        raise ReleaseError("Registry tarball integrity mismatch.")
    package, build = tar_json(archive, "package.json"), tar_json(archive, "dist/build-info.json")
    commit = build.get("commit")
    if package["version"] != exact or build.get("version") != exact or not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ReleaseError("Npm package version/source identity is incomplete.")
    receipt = {"version": exact, "commit": commit, "npmIntegrity": integrity,
               "npmTarballSha256": digest(archive), "gitHead": metadata.get("gitHead")}
    if receipt["gitHead"] and receipt["gitHead"] != commit:
        raise ReleaseError("Npm gitHead differs from packaged build-info.")
    write_json(out / f"official-{exact}.json", receipt)
    return receipt

def safe_target(value):
    path = Path(value).expanduser()
    if not path.is_absolute() or ".." in path.parts or path == Path.home() or len(path.parts) < 3:
        raise ReleaseError(f"Unsafe snapshot target: {value}")
    return path.parent.resolve() / path.name

def snapshot_targets(plan):
    if not plan.get("systemdPaths") or not plan.get("binPaths"):
        raise ReleaseError("Explicit systemd unit and binary metadata paths are required.")
    install_root = safe_target(plan["prefix"]) / "lib/node_modules/openclaw"
    values = [str(install_root), plan["stateDir"], *plan.get("externalPaths", []),
              *plan["systemdPaths"], *plan["binPaths"]]
    if plan.get("externalPathsReviewed") is not True:
        raise ReleaseError("Review all external includes, workspaces, databases and plugin paths first.")
    paths = sorted(set(safe_target(value) for value in values), key=lambda p: len(p.parts))
    out = []
    for path in paths:
        if not any(parent == path or parent in path.parents for parent in out):
            out.append(path)
    projects = safe_target(plan["pluginProjectsDir"])
    if Path(plan["pluginProjectsDir"]) != projects.resolve() or projects.is_symlink():
        raise ReleaseError("Managed plugin projects must have a physical reviewed root.")
    if not any(root == projects or root in projects.parents for root in out):
        raise ReleaseError("Managed plugin projects directory is outside checkpoint scope.")
    # Capture the entire projects tree, including rotated and retired generations.
    # Every existing dependency link must remain inside the reviewed recovery scope.
    if install_root.is_symlink():
        raise ReleaseError("Core install root must be a physical directory.")
    for dependency_root in (install_root, projects):
        for directory, directories, files in os.walk(dependency_root, followlinks=False):
            for name in directories + files:
                entry = Path(directory) / name
                if entry.is_symlink():
                    resolved = entry.resolve()
                    if not any(root == resolved or root in resolved.parents for root in out):
                        raise ReleaseError("An installed dependency link escapes the reviewed checkpoint scope.")
    return out

def save_checkpoint(plan, transaction):
    targets = []
    for index, path in enumerate(snapshot_targets(plan)):
        archive = transaction / f"snapshot-{index}.tar"
        exists = path.exists() or path.is_symlink()
        record = {"path": str(path), "parent": str(path.parent.resolve()), "exists": exists}
        if exists:
            run(["tar", "--acls", "--xattrs", "--numeric-owner", "-cpf", archive,
                 "-C", path.parent, path.name])
            os.chmod(archive, 0o600)
            record.update(archive=archive.name, sha256=digest(archive))
        targets.append(record)
    checkpoint = {"schema": SCHEMA, "plan": plan, "targets": targets}
    write_json(transaction / "checkpoint.json", checkpoint)
    return checkpoint

def restore_checkpoint(transaction):
    checkpoint = read_json(transaction / "checkpoint.json")
    # Verify all archives before the first filesystem restore.
    for target in checkpoint["targets"]:
        path = safe_target(target["path"])
        if str(path.parent.resolve()) != target["parent"]:
            raise ReleaseError("Snapshot parent changed; retain checkpoint for manual recovery.")
        if target["exists"]:
            archive_name = target["archive"]
            if Path(archive_name).name != archive_name or digest(transaction / archive_name) != target["sha256"]:
                raise ReleaseError("Snapshot archive changed; retain checkpoint for manual recovery.")
            with tarfile.open(transaction / archive_name, "r:") as archive:
                for member in archive.getmembers():
                    parts = Path(member.name).parts
                    if not parts or parts[0] != path.name or ".." in parts or Path(member.name).is_absolute():
                        raise ReleaseError("Snapshot member escapes its captured root.")
                    if member.islnk():
                        links = Path(member.linkname).parts
                        if not links or links[0] != path.name or ".." in links:
                            raise ReleaseError("Snapshot hardlink escapes its captured root.")
    for target in checkpoint["targets"]:
        path = safe_target(target["path"])
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
        if target["exists"]:
            run(["tar", "--acls", "--xattrs", "--numeric-owner", "-xpf",
                 transaction / target["archive"], "-C", path.parent])
            run(["tar", "--compare", "--file", transaction / target["archive"], "--directory", path.parent])
    return checkpoint["plan"]

def service(action, services):
    run(["systemctl", "--user", action, *services])

def assert_services_stopped(services):
    for name in services:
        result = subprocess.run(["systemctl", "--user", "is-active", name],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.stdout.strip() not in ("inactive", "failed"):
            raise ReleaseError("A managed service has not fully stopped.")

def cli(plan, *args, capture=False):
    entry = Path(plan["prefix"]) / "lib/node_modules/openclaw/openclaw.mjs"
    env = {**os.environ, "OPENCLAW_STATE_DIR": plan["stateDir"], "OPENCLAW_CONFIG_PATH": plan["configPath"],
           "OPENCLAW_UPDATE_IN_PROGRESS": "1",
           "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE": "1",
           "OPENCLAW_SERVICE_REPAIR_POLICY": "external",
           "PATH": str(Path(plan["nodeExecutable"]).parent) + os.pathsep
                   + str(Path(plan.get("npmExecutable", "npm")).parent) + os.pathsep + os.environ["PATH"]}
    return run([plan["nodeExecutable"], str(entry), *args], env=env, capture=capture)

def find_plugin(value, plugin_id):
    if isinstance(value, dict):
        if value.get("id") == plugin_id:
            return value
        for child in value.values():
            result = find_plugin(child, plugin_id)
            if result:
                return result
    if isinstance(value, list):
        for child in value:
            result = find_plugin(child, plugin_id)
            if result:
                return result
    return None

def find_voice_plugin(value):
    return find_plugin(value, "voice-call")

def resolve_loaded_plugin_root(plan, plugin, role):
    projects = Path(plan["pluginProjectsDir"]).resolve()
    unresolved = Path(plugin["rootDir"])
    loaded = unresolved.resolve()
    try:
        relative = loaded.relative_to(projects)
    except ValueError as error:
        raise ReleaseError(f"Loaded {role} rootDir is outside reviewed managed npm projects.") from error
    package_parts = tuple(ARTIFACT_PACKAGES[role].split("/"))
    if len(relative.parts) != 4 or relative.parts[-3:] != ("node_modules", *package_parts):
        raise ReleaseError(f"Loaded {role} rootDir has an unexpected managed package layout.")
    if unresolved != loaded or any(parent.is_symlink() for parent in unresolved.parents if parent != projects):
        raise ReleaseError(f"Loaded {role} rootDir traverses a symlink.")
    if not plugin.get("source"):
        raise ReleaseError(f"Loaded {role} source identity is unavailable.")
    source = Path(plugin["source"]).resolve()
    if source != loaded and loaded not in source.parents:
        raise ReleaseError(f"Loaded {role} entry shadows the managed custom installation.")
    return loaded

def resolve_loaded_voice_root(plan, voice):
    return resolve_loaded_plugin_root(plan, voice, "voice")

def validate_plugin_files(plan, record, role, receipt):
    root = resolve_loaded_plugin_root(plan, record, role)
    source = str(Path(record["source"]).resolve().relative_to(root))
    if source not in receipt["artifacts"][role]["files"]:
        raise ReleaseError(f"Loaded {role} entry is absent from the reviewed artifact.")
    for relative, expected in receipt["artifacts"][role]["files"].items():
        member = root / relative
        if member.is_symlink() or not member.is_file() or member.resolve() != member:
            raise ReleaseError(f"Installed {role} member escapes physical package: {relative}")
        if relative == "package.json":
            # npm may normalize metadata; runtime members remain byte-for-byte.
            manifest = read_json(member)
            if manifest.get("name") != ARTIFACT_PACKAGES[role] or manifest.get("version") != receipt["version"]:
                raise ReleaseError(f"Installed {role} package identity mismatch.")
        elif digest(member) != expected:
            raise ReleaseError(f"Installed {role} file changed: {relative}")
    return root

def validate_runtime(plan, receipt):
    installed = Path(plan["prefix"]) / "lib/node_modules/openclaw"
    if read_json(installed / "package.json")["version"] != receipt["version"]:
        raise ReleaseError("Installed core version mismatch.")
    for relative, expected in receipt["artifacts"]["core"]["files"].items():
        if relative == "openclaw.mjs" or relative.startswith("dist/"):
            artifact = installed / relative
            if artifact.is_symlink() or digest(artifact) != expected:
                raise ReleaseError(f"Installed core runtime file changed: {relative}")
    build = read_json(installed / "dist/build-info.json")
    if build.get("version") != receipt["version"] or build.get("commit") != receipt["head"]:
        raise ReleaseError("Installed core build identity mismatch.")
    if receipt["version"] not in cli(plan, "--version", capture=True).split():
        raise ReleaseError("CLI version mismatch.")
    validation = json.loads(cli(plan, "config", "validate", "--json", capture=True))
    if validation.get("valid") is not True:
        raise ReleaseError("Candidate configuration failed validation.")
    catalog = json.loads(cli(plan, "plugins", "list", "--json", capture=True))
    cli_metadata = {}
    for role, plugin_id in PLUGIN_IDS.items():
        record = find_plugin(catalog, plugin_id)
        if not record or record.get("status") != "loaded" or not record.get("rootDir"):
            raise ReleaseError(f"Loaded custom {role} source identity is unavailable.")
        validate_plugin_files(plan, record, role, receipt)
        if (record.get("version") != receipt["version"] or record.get("enabled") is not True
                or not isinstance(record.get("origin"), str) or not record["origin"]):
            raise ReleaseError(f"CLI {role} metadata differs from the reviewed installation.")
        cli_metadata[role] = record
    service("is-active", plan["services"])
    catalog = json.loads(cli(plan, "gateway", "call", "plugins.list", "--json", capture=True))
    for role, plugin_id in PLUGIN_IDS.items():
        record = find_plugin(catalog, plugin_id)
        if not record or record.get("runtime", {}).get("state") != "active":
            raise ReleaseError(f"Gateway did not activate the custom {role} plugin.")
        # RPC exposes catalog metadata + active-registry state, not source paths.
        # Physical root/source and complete member identity remain CLI checks.
        cli_record = cli_metadata[role]
        if (record.get("packageName") != ARTIFACT_PACKAGES[role]
                or record.get("version") != cli_record["version"]
                or record.get("origin") != cli_record["origin"]
                or record.get("installed") is not True or record.get("enabled") is not True):
            raise ReleaseError(f"Gateway {role} metadata differs from the reviewed CLI installation.")
    status = json.loads(cli(plan, "status", "--json", capture=True))
    health = json.loads(cli(plan, "gateway", "call", "health", "--json", capture=True))
    if health.get("ok") is not True:
        raise ReleaseError("Gateway RPC health failed.")
    version = ((status.get("gateway") or {}).get("self") or {}).get("version")
    if version != receipt["version"]:
        raise ReleaseError("Running Gateway version absent or differs from receipt.")

def await_runtime(plan, receipt, *, clock=time.monotonic, wait=time.sleep):
    # Slow hosts can need several minutes for admission and plugin workers.
    budget = max(120, min(1800, int(plan.get("readinessTimeoutSeconds", 600))))
    deadline = clock() + budget
    last = None
    while True:
        try:
            validate_runtime(plan, receipt)
            return
        except (ReleaseError, OSError, ValueError, KeyError) as error:
            last = error
        if clock() >= deadline:
            raise ReleaseError(f"Runtime readiness timed out after {budget}s: {last}")
        wait(min(5, max(0, deadline - clock())))

def update_journal(transaction, journal, stage, **extra):
    journal.update(stage=stage, **extra)
    write_json(transaction / "transaction.json", journal)

def rollback(transaction, journal):
    plan = journal["plan"]
    service("stop", plan["services"])
    assert_services_stopped(plan["services"])
    update_journal(transaction, journal, "rolling-back")
    if digest(transaction / "checkpoint.json") != journal["checkpointSha256"]:
        raise ReleaseError("Checkpoint manifest changed; retain recovery evidence.")
    restore_checkpoint(transaction)
    service("daemon-reload", [])
    if journal["previouslyActive"]:
        service("start", journal["previouslyActive"])
        service("is-active", journal["previouslyActive"])
        if cli(plan, "--version", capture=True) != journal["oldVersion"]:
            raise ReleaseError("Restored CLI identity differs from checkpoint.")
        if json.loads(cli(plan, "gateway", "call", "health", "--json", capture=True)).get("ok") is not True:
            raise ReleaseError("Restored Gateway RPC health failed.")
    update_journal(transaction, journal, "rolled-back")

def deployment_npm(plan):
    # npm 12 silently blocks lifecycle scripts by default. Select the supported
    # npm 11 installer explicitly; never globally enable scripts or use a wildcard.
    executable = plan.get("npmExecutable", os.environ.get("OPENCLAW_CUSTOM_NPM", "npm"))
    executable = shutil.which(executable) or executable
    env = {**os.environ, "PATH": str(Path(plan["nodeExecutable"]).parent) + os.pathsep
           + str(Path(executable).parent) + os.pathsep + os.environ["PATH"]}
    version = run([executable, "--version"], env=env, capture=True)
    if not re.fullmatch(r"11\.[0-9]+\.[0-9]+", version):
        raise ReleaseError("Deployment requires npm 11.x so core/native lifecycle scripts execute; set npmExecutable to a reviewed npm 11 installer.")
    # Child lifecycle scripts and managed plugin installation also spawn npm.
    if run(["npm", "--version"], env=env, capture=True) != version:
        raise ReleaseError("Selected npm 11 is shadowed in the runtime PATH; use a matching Node/npm bin layout.")
    return executable, env

def deploy(args):
    if not args.execute_deployment:
        raise ReleaseError("Deployment requires explicit --execute-deployment.")
    receipt_path, plan_path = Path(args.receipt).resolve(), Path(args.plan).resolve()
    receipt = verify(receipt_path, check_source=True)
    plan = read_json(plan_path)
    if len(plan.get("services", [])) != 2 or any(
        not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", name) for name in plan["services"]
    ):
        raise ReleaseError("Declare both Gateway and node service names.")
    npm, install_environment = deployment_npm(plan)
    plan["npmExecutable"] = npm
    targets = snapshot_targets(plan)
    core_archive = receipt_path.parent / receipt["artifacts"]["core"]["file"]
    candidate_engine = tar_json(core_archive, "package.json")["engines"]["node"]
    if not node_satisfies(run([plan["nodeExecutable"], "--version"], capture=True), candidate_engine):
        raise ReleaseError("Deployment Node does not satisfy the packaged candidate engines.")
    expected_bin = safe_target(plan["prefix"]) / "bin/openclaw"
    if not any(target == expected_bin or target in expected_bin.parents for target in targets):
        raise ReleaseError("The npm CLI binary link is outside checkpoint scope.")
    config = safe_target(plan["configPath"])
    if not any(target == config or target in config.parents for target in targets):
        raise ReleaseError("Config path is outside checkpoint scope.")
    for field in ("prefix", "stateDir"):
        path = Path(plan[field])
        if path.is_symlink() or not path.is_dir():
            raise ReleaseError(f"{field} must be an existing physical directory.")
    transaction = Path(args.transaction).resolve()
    if any(target == transaction or target in transaction.parents for target in targets):
        raise ReleaseError("Keep checkpoint outside snapshotted paths.")
    transaction.mkdir(parents=True, exist_ok=False, mode=0o700)
    with operation_lock(transaction.parent / "deployment.lock"):
        active = []
        for name in plan["services"]:
            if subprocess.run(["systemctl", "--user", "is-active", "--quiet", name]).returncode == 0:
                active.append(name)
        old_version = cli(plan, "--version", capture=True)
        journal = {"schema": SCHEMA, "receipt": str(receipt_path), "receiptSha256": digest(receipt_path),
                   "oldVersion": old_version,
                   "plan": plan, "previouslyActive": active}
        update_journal(transaction, journal, "stopping")
        checkpoint_ready = False
        try:
            service("stop", plan["services"])
            assert_services_stopped(plan["services"])
            save_checkpoint(plan, transaction)
            checkpoint_ready = True
            update_journal(transaction, journal, "checkpoint-ready",
                           checkpointSha256=digest(transaction / "checkpoint.json"))
            verify(receipt_path, check_source=True)
            archive = receipt_path.parent / receipt["artifacts"]["core"]["file"]
            run([npm, "install", "--global", "--prefix", plan["prefix"], "--no-audit", "--no-fund", "--ignore-scripts=false", str(archive)], env=install_environment)
            update_journal(transaction, journal, "core-installed")
            for role in PLUGIN_IDS:
                plugin = receipt_path.parent / receipt["artifacts"][role]["file"]
                cli(plan, "plugins", "install", "npm-pack:" + str(plugin), "--force", "--no-enable", "--accept-capabilities")
                # Check the native install result before doctor or service start.
                catalog = json.loads(cli(plan, "plugins", "list", "--json", capture=True))
                record = find_plugin(catalog, PLUGIN_IDS[role])
                if not record or record.get("status") != "loaded":
                    raise ReleaseError(f"Native installation did not load custom {role}.")
                validate_plugin_files(plan, record, role, receipt)
                update_journal(transaction, journal, role + "-installed")
            assert_services_stopped(plan["services"])
            cli(plan, "doctor", "--fix", "--non-interactive")
            assert_services_stopped(plan["services"])
            cli(plan, "config", "validate", "--json", capture=True)
            service("daemon-reload", [])
            service("start", plan["services"])
            update_journal(transaction, journal, "validating")
            await_runtime(plan, receipt)
            update_journal(transaction, journal, "verified")
            print(json.dumps({"transaction": str(transaction), "status": "verified"}))
        except BaseException:
            if checkpoint_ready:
                try:
                    rollback(transaction, journal)
                except BaseException:
                    update_journal(transaction, journal, "rollback-failed")
                    raise ReleaseError(f"Rollback failed; preserve private checkpoint {transaction}.")
            else:
                if active:
                    service("start", active)
                update_journal(transaction, journal, "failed-before-install")
            raise

def recover(args):
    if not args.execute_deployment:
        raise ReleaseError("Recovery requires explicit --execute-deployment.")
    transaction = Path(args.transaction).resolve()
    with operation_lock(transaction.parent / "deployment.lock"):
        journal = read_json(transaction / "transaction.json")
        if journal["stage"] in ("verified", "rolled-back", "failed-before-install"):
            print(json.dumps({"stage": journal["stage"], "action": "none"}))
            return
        if not journal.get("checkpointSha256"):
            if journal["stage"] != "stopping":
                raise ReleaseError("Incomplete checkpoint; manual recovery inspection required.")
            if journal["previouslyActive"]:
                service("start", journal["previouslyActive"])
                service("is-active", journal["previouslyActive"])
            update_journal(transaction, journal, "failed-before-install")
            return
        try:
            rollback(transaction, journal)
        except BaseException:
            update_journal(transaction, journal, "rollback-failed")
            raise ReleaseError(f"Recovery failed; retain checkpoint {transaction}.")

def publish(args):
    # Never an automatic deploy tail, and never updates custom-main.
    journal = read_json(Path(args.transaction).resolve() / "transaction.json")
    if journal.get("stage") != "verified" or digest(journal["receipt"]) != journal["receiptSha256"]:
        raise ReleaseError("Publication requires an unchanged verified deployment receipt.")
    receipt = verify(journal["receipt"], check_source=True)
    if receipt["dirtyReview"]:
        raise ReleaseError("Commit reviewed candidate and rebuild before publication.")
    if not args.branch.startswith("releasecandidate/"):
        raise ReleaseError("Publication accepts an explicitly named releasecandidate/ branch only.")
    validate_runtime(journal["plan"], receipt)
    run(["git", "-C", receipt["source"], "push", args.remote, f"{receipt['head']}:refs/heads/{args.branch}"])

def main(argv=None):
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt("Release operation interrupted.")
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare-build")
    prepare.add_argument("--repo", required=True)
    prepare.add_argument("--source-branch", default="custom-main")
    prepare.add_argument("--version", default="latest")
    prepare.add_argument("--out", required=True)
    package = sub.add_parser("stage")
    package.add_argument("--repo", required=True)
    package.add_argument("--out", required=True)
    package.add_argument("--allow-dirty-review", action="store_true")
    package.add_argument("--skip-build", action="store_true")
    package.add_argument("--build-receipt")
    check = sub.add_parser("verify")
    check.add_argument("--receipt", required=True)
    check.add_argument("--check-source", action="store_true")
    deployment = sub.add_parser("deploy")
    deployment.add_argument("--receipt", required=True)
    deployment.add_argument("--plan", required=True)
    deployment.add_argument("--transaction", required=True)
    deployment.add_argument("--execute-deployment", action="store_true")
    recovery = sub.add_parser("recover")
    recovery.add_argument("--transaction", required=True)
    recovery.add_argument("--execute-deployment", action="store_true")
    publication = sub.add_parser("publish")
    publication.add_argument("--transaction", required=True)
    publication.add_argument("--remote", default="origin")
    publication.add_argument("--branch", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare-build":
            prepare_build(args)
        elif args.command == "stage":
            stage(args)
        elif args.command == "verify":
            receipt = verify(args.receipt, args.check_source)
            print(json.dumps({"version": receipt["version"], "sourceHash": receipt["sourceHash"], "status": "verified"}))
        elif args.command == "deploy":
            deploy(args)
        elif args.command == "recover":
            recover(args)
        elif args.command == "publish":
            publish(args)
    except (ReleaseError, OSError, subprocess.SubprocessError, ValueError, KeyError, KeyboardInterrupt) as error:
        print(f"custom-release: {error}", file=sys.stderr)
        return 1
    return 0


def verify_official_git(repo, release):
    version, commit = release["version"], release["commit"]
    core = re.sub(r"-[0-9]+$", "", version)
    anchor = f"refs/custom-release/tags/v{core}"
    run(["git", "-C", repo, "fetch", "--no-tags", OFFICIAL,
         commit, f"refs/tags/v{core}:{anchor}"])
    tag = git(repo, "rev-parse", anchor + "^{commit}")
    if core == version and tag != commit:
        raise ReleaseError("Stable tag differs from exact npm source.")
    if core != version:
        run(["git", "-C", repo, "merge-base", "--is-ancestor", tag, commit])
    remote_ref = f"refs/heads/release/{core}"
    if run(["git", "ls-remote", "--heads", OFFICIAL, remote_ref], capture=True):
        local_ref = f"refs/custom-release/releases/{core}"
        run(["git", "-C", repo, "fetch", "--no-tags", OFFICIAL, remote_ref + ":" + local_ref])
        run(["git", "-C", repo, "merge-base", "--is-ancestor", commit, local_ref])
    return {"tag": "v" + core, "tagCommit": tag, "releaseRef": remote_ref}

def node_satisfies(version, engine):
    # Bootstrap before dependency installation. Unsupported future grammar refuses;
    # the installed candidate semver owner is still authoritative after install.
    actual = tuple(int(part) for part in version.lstrip("v").split(".")[:3])
    for alternative in engine.split("||"):
        tokens = re.findall(r"(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})", alternative)
        remainder = re.sub(r"(>=|<=|>|<|=)?\s*\d+(?:\.\d+){0,2}", "", alternative).strip()
        if not tokens or remainder:
            raise ReleaseError("Unsupported Node engine expression; select a candidate-compatible runtime explicitly.")
        matches = True
        for comparator, value in tokens:
            parts = tuple(int(part) for part in value.split("."))
            expected = parts + (0,) * (3 - len(parts))
            accepted = {"": actual == expected, "=": actual == expected,
                        ">=": actual >= expected, "<=": actual <= expected,
                        ">": actual > expected, "<": actual < expected}[comparator]
            matches = matches and accepted
        if matches:
            return True
    return False

def bootstrap_toolchain(repo):
    package = read_json(repo / "package.json")
    node = os.environ.get("OPENCLAW_CUSTOM_NODE", "node")
    pnpm = os.environ.get("OPENCLAW_CUSTOM_PNPM", "pnpm")
    if not node_satisfies(run([node, "--version"], capture=True), package["engines"]["node"]):
        raise ReleaseError("Node does not satisfy the candidate engines; Node 25 is not a fallback.")
    if package["packageManager"].split("+", 1)[0] != "pnpm@" + run([pnpm, "--version"], capture=True):
        raise ReleaseError("pnpm does not match the candidate packageManager pin.")
    return node, pnpm

def check_toolchain(repo):
    package = read_json(repo / "package.json")
    node = os.environ.get("OPENCLAW_CUSTOM_NODE", "node")
    pnpm = os.environ.get("OPENCLAW_CUSTOM_PNPM", "pnpm")
    run([node, "--input-type=module", "-e",
         "import semver from 'semver'; if (!semver.satisfies(process.version, process.argv[1])) process.exit(2);",
         package["engines"]["node"]], cwd=repo)
    pin = package["packageManager"].split("+", 1)[0]
    if pin != "pnpm@" + run([pnpm, "--version"], cwd=repo, capture=True):
        raise ReleaseError(f"Use candidate packageManager pin {pin}.")
    return node, pnpm

def prepare_build(args):
    repo = Path(args.repo).resolve()
    if git(repo, "branch", "--show-current") != args.source_branch:
        raise ReleaseError("Source is not on the explicitly selected customization branch.")
    if git(repo, "status", "--porcelain"):
        raise ReleaseError("Source must be clean; stage --allow-dirty-review is for isolated review builds.")
    source_head = git(repo, "rev-parse", "HEAD")
    base = read_json(repo / "tools/custom/upstream-base.json")
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    candidate = out / "source"
    run(["git", "clone", "--shared", "--no-checkout", str(repo), str(candidate)])
    previous = registry_release(base["version"], out)
    if previous["commit"] != base["commit"]:
        raise ReleaseError("Previous official source receipt differs from its exact npm release.")
    verify_official_git(candidate, previous)
    target = registry_release(args.version, out)
    verify_official_git(candidate, target)
    branch = f"releasecandidate/v{target['version']}-{uuid.uuid4().hex[:8]}"
    run(["git", "-C", candidate, "checkout", "-b", branch, target["commit"]])
    patch = out / "customization.patch"
    with open(patch, "wb") as handle:
        subprocess.run(["git", "-C", repo, "diff", "--binary", "--full-index", base["commit"], source_head],
                       stdout=handle, check=True)
    write_json(out / "integration.json", {
        "previous": previous, "target": target, "sourceHead": source_head,
        "sourceBranch": args.source_branch, "candidateBranch": branch,
        "paths": git(repo, "diff", "--name-only", base["commit"], source_head).splitlines(),
    })
    if patch.stat().st_size:
        result = subprocess.run(["git", "-C", candidate, "apply", "--3way", "--index", str(patch)])
        if result.returncode:
            write_json(out / "conflicts.json", {
                "paths": git(candidate, "diff", "--name-only", "--diff-filter=U").splitlines(),
                "candidate": str(candidate), "sourceHead": source_head,
            })
            raise ReleaseError(f"Semantic migration required; conflict candidate retained at {out}.")
    write_json(candidate / "tools/custom/upstream-base.json", {
        "version": target["version"], "commit": target["commit"], "npmIntegrity": target["npmIntegrity"],
    })
    run(["git", "-C", candidate, "add", "tools/custom/upstream-base.json"])
    if git(repo, "rev-parse", "HEAD") != source_head or git(repo, "status", "--porcelain"):
        raise ReleaseError("Source changed during preparation.")
    # Clean text application is not semantic review and never authorizes a commit.
    # Preserve the staged candidate for human/independent review before building.
    write_json(out / "review-pending.json", {
        "status": "semantic-review-required", "candidate": str(candidate),
        "candidateBranch": branch, "officialHead": target["commit"],
        "sourceHead": source_head, "paths": git(candidate, "diff", "--cached", "--name-only").splitlines(),
    })
    print(json.dumps({"status": "semantic-review-required", "candidate": str(candidate)}))

def stage(args):
    repo, out = Path(args.repo).resolve(), Path(args.out).resolve()
    branch = git(repo, "branch", "--show-current")
    if not (branch.startswith("releasecandidate/") or (args.allow_dirty_review and branch.startswith("upgrade/"))):
        raise ReleaseError("Packaging requires an isolated releasecandidate/ branch.")
    dirty = bool(git(repo, "status", "--porcelain"))
    if dirty and not args.allow_dirty_review:
        raise ReleaseError("Dirty review tree requires --allow-dirty-review.")
    if out == repo or repo in out.parents:
        raise ReleaseError("Keep packages outside the source checkout.")
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    node, pnpm = bootstrap_toolchain(repo)
    if not (repo / "node_modules").exists():
        run([pnpm, "install", "--frozen-lockfile"], cwd=repo)
    check_toolchain(repo)
    inventory, source_hash = source_inventory(repo)
    head = git(repo, "rev-parse", "HEAD")
    base = read_json(repo / "tools/custom/upstream-base.json")
    if read_json(repo / "package.json")["version"] != base["version"]:
        raise ReleaseError("Core manifest and official baseline versions differ.")
    if args.skip_build:
        build_receipt = read_json(args.build_receipt) if args.build_receipt else {}
        if build_receipt.get("head") != head or build_receipt.get("sourceHash") != source_hash:
            raise ReleaseError("Skipping build requires a fresh receipt for this exact source generation.")
    else:
        run([pnpm, "build"], cwd=repo)
        run([pnpm, "ui:build"], cwd=repo)
        write_json(out / "build-source.json", {"head": head, "sourceHash": source_hash})
    build_info = read_json(repo / "dist/build-info.json")
    if build_info.get("version") != base["version"] or build_info.get("commit") != head:
        raise ReleaseError("Build-info does not match candidate HEAD/version.")
    run([node, "scripts/package-openclaw-for-docker.mjs", "--output-dir", str(out), "--skip-build"], cwd=repo)
    for plugin_id in PLUGIN_IDS.values():
        plugin_path = "extensions/" + plugin_id
        run([node, "scripts/lib/plugin-npm-runtime-build.mjs", plugin_path], cwd=repo)
        run([node, "scripts/lib/plugin-npm-package-manifest.mjs", "--run", plugin_path,
             "--", "npm", "pack", "--pack-destination", str(out)], cwd=repo)
    artifacts = {}
    for archive in sorted(out.glob("*.tgz")):
        package = tar_json(archive, "package.json")
        if package["name"] not in ARTIFACT_PACKAGES.values():
            continue
        role = next(role for role, name in ARTIFACT_PACKAGES.items() if name == package["name"])
        if role in artifacts or package["version"] != base["version"]:
            raise ReleaseError("Duplicate or wrong-version package.")
        artifacts[role] = {"file": archive.name, "sha256": digest(archive),
                           "name": package["name"], "version": package["version"],
                           "files": tar_inventory(archive)}
    if set(artifacts) != set(ARTIFACT_PACKAGES):
        raise ReleaseError("Core, independent custom voice and Discord packages are all required.")
    if source_inventory(repo)[1] != source_hash or git(repo, "rev-parse", "HEAD") != head:
        raise ReleaseError("Source changed during packaging; rebuild a fresh generation.")
    write_json(out / "release.json", {
        "schema": SCHEMA, "version": base["version"], "officialBaseline": base,
        "head": head, "branch": branch, "source": str(repo), "sourceHash": source_hash,
        "dirtyReview": dirty, "sourceFiles": inventory, "artifacts": artifacts,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    print(json.dumps({"receipt": str(out / "release.json"), "sourceHash": source_hash}))

def verify(receipt_path, check_source=False):
    receipt_path = Path(receipt_path).resolve()
    receipt = read_json(receipt_path)
    if receipt.get("schema") != SCHEMA or set(receipt.get("artifacts", {})) != set(ARTIFACT_PACKAGES):
        raise ReleaseError("Require v2 three-role custom release receipt; rebuild legacy two-role packages.")
    for role, artifact in receipt["artifacts"].items():
        name = artifact["file"]
        if Path(name).name != name or (receipt_path.parent / name).is_symlink():
            raise ReleaseError("Artifact must be a regular file beside receipt.")
        archive = receipt_path.parent / name
        if digest(archive) != artifact["sha256"] or tar_inventory(archive) != artifact["files"]:
            raise ReleaseError(f"{role} package hash/inventory mismatch.")
        package = tar_json(archive, "package.json")
        if (package["name"] != ARTIFACT_PACKAGES[role] or artifact["name"] != ARTIFACT_PACKAGES[role]
                or package["version"] != receipt["version"] or artifact.get("version") != receipt["version"]):
            raise ReleaseError(f"{role} package identity mismatch.")
        if role == "core" and tar_json(archive, "dist/build-info.json").get("commit") != receipt["head"]:
            raise ReleaseError("Core source commit differs from receipt.")
    if check_source:
        source = Path(receipt["source"])
        if git(source, "rev-parse", "HEAD") != receipt["head"] or source_inventory(source)[1] != receipt["sourceHash"]:
            raise ReleaseError("Candidate source changed after packaging.")
    return receipt

if __name__ == "__main__":
    sys.exit(main())
